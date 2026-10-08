/**
 * L'itinéraire : le calculer, le tracer, le raconter.
 *
 * Ce module ouvre le panneau d'itinéraire, charge en région les cellules du
 * couloir, cherche le trajet le moins exposé et le plus court qui lui sert de
 * référence, trace le premier sur la carte et en fait le récit — durée,
 * passages brutaux au soleil, tronçons. Il répond aussi à « quand partir ? »
 * en refaisant la même recherche à d'autres heures, et tient le lien
 * partageable qui rouvre l'itinéraire au rechargement.
 *
 * La recherche elle-même est dans `routing.js`, qui ne connaît ni la carte ni
 * le DOM.
 */
import * as maplibregl from 'maplibre-gl';

import { currentGraph, dom, evaluateSegment, fail, map, motionDuration, state } from './app.js';
import { escapeHtml, formatClock, formatMeters } from './format.js';
import { startNavigation } from './guidance.js';
import { applyTime } from './layers.js';
import { readRoute, writeRoute } from './link.js';
import { setOfflinePanel } from './offline-ui.js';
import { PENALTY, tolerance } from './profile.js';
import { setProfilePanel } from './profile-ui.js';
import { colorFor, textColorFor } from './panel.js';
import { findRoute, nearestNode, summarize, transitions, SearchAborted } from './routing.js';
import { setPlace, stopPicking } from './search.js';

// --------------------------------------------------------------- itinéraire

/**
 * Ouvre ou referme le panneau d'itinéraire, focus compris.
 *
 * Le focus doit quitter le panneau **avant** qu'il ne soit masqué : autrement il
 * retombe sur le corps du document, et l'on repart de zéro dans l'ordre de
 * tabulation — au lieu de retrouver le bouton d'où l'on venait.
 */
export function setRoutePanel(open) {
  if (!open && dom.route.contains(document.activeElement)) dom.routeToggle.focus();
  if (open && !dom.offline.hidden) setOfflinePanel(false);
  if (open && !dom.profile.hidden) setProfilePanel(false);

  dom.route.hidden = !open;
  dom.routeToggle.classList.toggle('is-on', open);
  dom.routeToggle.setAttribute('aria-pressed', String(open));

  if (open) dom.from.focus();
  else stopPicking();
}

/**
 * Charge les cellules du couloir départ → arrivée.
 *
 * L'emprise est celle des deux points, élargie d'un cinquième : un trajet
 * abrité fait des détours, et s'en tenir au rectangle strict couperait le
 * graphe là où l'itinéraire voulait justement passer.
 *
 * @returns {Promise<boolean>} faux si le trajet dépasse ce qu'on accepte de charger
 */
async function loadRouteCorridor(from, to) {
  const margin = Math.max(0.01, Math.abs(from.lon - to.lon) * 0.2);
  const marginLat = Math.max(0.007, Math.abs(from.lat - to.lat) * 0.2);
  const bounds = {
    west: Math.min(from.lon, to.lon) - margin,
    east: Math.max(from.lon, to.lon) + margin,
    south: Math.min(from.lat, to.lat) - marginLat,
    north: Math.max(from.lat, to.lat) + marginLat,
  };

  const needed = state.region.cellsIn(bounds);
  if (needed.length > MAX_ROUTE_CELLS) {
    dom.routeResult.innerHTML = `<p class="warn">
      Ce trajet traverse ${needed.length} secteurs de calcul — c'est trop long pour
      un itinéraire à pied. Rapprochez le départ de l'arrivée.</p>`;
    return false;
  }

  const missing = needed.filter((cell) => !state.region.isLoaded(cell.idBase));
  if (missing.length === 0) return true;

  dom.routeResult.innerHTML = `<p>Chargement de ${missing.length} secteurs…</p>`;
  const { failed } = await state.region.ensure(bounds);
  if (failed.length > 0) {
    dom.routeResult.innerHTML = `<p class="warn">
      ${failed.length} secteurs du trajet n'ont pas pu être chargés — l'itinéraire
      pourrait contourner une zone qu'il devrait traverser.</p>`;
  }
  return true;
}

/**
 * Nombre de cellules qu'un itinéraire peut demander.
 *
 * Un trajet de Mantes à Provins traverse la région de part en part : vingt-cinq
 * cellules, plusieurs centaines de mégaoctets, et un graphe de plusieurs
 * millions d'arêtes que le navigateur mettrait des minutes à assembler — pour
 * un trajet de vingt-cinq heures de marche. La limite n'est pas technique, elle
 * est de bon sens : au-delà, ce n'est plus un itinéraire piéton.
 */
const MAX_ROUTE_CELLS = 14;

/**
 * Recherche en cours, s'il y en a une.
 *
 * Le curseur de priorité relance le calcul à chaque relâchement, et rien
 * n'empêche d'en relancer un pendant qu'un autre tourne. Tant que la recherche
 * bloquait le fil, la question ne se posait pas — elle finissait avant que le
 * geste suivant soit possible. Découpée en tranches, elle peut désormais en
 * croiser une autre, et c'est la plus lente qui écrirait la dernière dans le
 * panneau : on abandonne donc la précédente.
 */
let searchController = null;

function beginSearch() {
  searchController?.abort();
  searchController = new AbortController();
  return searchController.signal;
}

export async function computeRoute() {
  const { from, to } = state.places;
  if (!from || !to) {
    dom.routeResult.innerHTML = `<p class="warn">Choisissez un départ et une arrivée.</p>`;
    return;
  }

  // En région, un itinéraire passe par des cellules que la carte n'a jamais
  // affichées. On les charge avant de chercher, sinon le graphe s'arrête au
  // bord de l'écran et le trajet est déclaré impossible.
  if (state.region && !(await loadRouteCorridor(from, to))) return;

  const graph = currentGraph();
  if (!graph) {
    dom.routeResult.innerHTML = `<p class="warn">Relevés en cours de chargement — réessayez dans un instant.</p>`;
    return;
  }

  const start = nearestNode(graph, from.lon, from.lat);
  const goal = nearestNode(graph, to.lon, to.lat);
  if (start.node < 0 || goal.node < 0) {
    dom.routeResult.innerHTML = `<p class="warn">Aucun point du réseau à proximité.</p>`;
    return;
  }
  if (start.distance > 400 || goal.distance > 400) {
    dom.routeResult.innerHTML = `<p class="warn">
      Ce point est à ${Math.round(Math.max(start.distance, goal.distance))} m du réseau calculé.
      Choisissez un lieu dans la zone.</p>`;
    return;
  }
  // Les deux points s'accrochent au réseau, mais à deux morceaux qui ne
  // communiquent pas. Le dire vaut mieux que de laisser A* fouiller tout le
  // graphe pour conclure « aucun chemin » : la cause n'est pas le trajet, c'est
  // le réseau — le plus souvent une cellule manquante entre les deux.
  if (start.component !== goal.component) {
    dom.routeResult.innerHTML = `<p class="warn">
      Ces deux points ne sont pas reliés par le réseau calculé${
        state.region ? ' — il manque probablement un secteur entre les deux' : ''
      }.</p>`;
    return;
  }

  const options = {
    alpha: Number(dom.alpha.value) / 10,
    speed: state.meta.walkingSpeed ?? 1.35,
    crossingPenalty: state.meta.crossingPenalty ?? 25,
    departureMinutes: state.minutes,
    evaluate: evaluateSegment,
    // Seuil personnel : au-delà, l'exposition coûte plus cher. Neutre = 100.
    tolerance: tolerance(state.profile),
    penalty: PENALTY,
  };

  const signal = beginSearch();
  const t0 = performance.now();
  let route;
  let fastest;
  try {
    dom.routeGo.disabled = true;
    dom.routeResult.innerHTML = `<p class="muted">Calcul de l’itinéraire…</p>`;
    route = await findRoute(graph, start.node, goal.node, { ...options, signal });
    // Le trajet le plus court sert de référence : sans lui, « 6 minutes de plus »
    // ne veut rien dire.
    fastest = await findRoute(graph, start.node, goal.node, { ...options, alpha: 0, signal });
  } catch (error) {
    // Une recherche abandonnée n'a rien à dire : une autre est déjà partie, et
    // c'est elle qui écrira dans le panneau.
    if (error instanceof SearchAborted) return;
    throw error;
  } finally {
    dom.routeGo.disabled = false;
  }
  const elapsed = Math.round(performance.now() - t0);

  if (!route) {
    dom.routeResult.innerHTML = `<p class="warn">Aucun chemin trouvé entre ces deux points.</p>`;
    return;
  }

  state.route = route;
  // Gardés pour « quand partir ? », qui refait la même recherche à d'autres
  // heures : rien d'autre ne change, et retrouver les deux nœuds coûte un
  // parcours complet du graphe.
  state.routeOptions = options;
  state.routeEnds = { start: start.node, goal: goal.node };
  drawRoute(route);
  renderRouteResult(route, fastest, elapsed);
  rememberRouteInUrl();
}

function drawRoute(route) {
  map.getSource('route').setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: route.coordinates },
        properties: {},
      },
    ],
  });

  const bounds = new maplibregl.LngLatBounds();
  for (const coord of route.coordinates) bounds.extend(coord);
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 90, duration: motionDuration(600) });
}

function renderRouteResult(route, fastest, elapsed) {
  const minutes = Math.round(route.seconds / 60);
  const fastestMinutes = fastest ? Math.round(fastest.seconds / 60) : minutes;
  const extra = minutes - fastestMinutes;
  const saved = fastest ? Math.round(fastest.index - route.index) : 0;

  const legs = summarize(route);
  const arrival = formatClock(route.arrivalMinutes);
  const jumps = transitions(route);

  dom.routeResult.innerHTML = `
    <div class="route-head">
      <div class="route-stat"><b>${minutes} min</b><span>durée</span></div>
      <div class="route-stat"><b>${(route.meters / 1000).toFixed(1)} km</b><span>distance</span></div>
      <div class="route-stat" style="color:${textColorFor(route.index)}">
        <b>${Math.round(route.index)}</b><span>indice moyen</span>
      </div>
    </div>
    <p class="route-note">
      Arrivée vers <strong>${arrival}</strong>, ${Math.round(route.sun)} % du trajet au soleil.
      ${
        extra > 0 && saved > 0
          ? `Soit <strong>${extra} min de plus</strong> que le trajet le plus court,
             pour <strong>${saved} points d'exposition en moins</strong>.`
          : extra > 0
            ? `Soit ${extra} min de plus que le trajet le plus court.`
            : saved > 0
              ? // Même durée mais moins exposé : le dire, sinon le curseur
                // « priorité » paraîtrait sans effet alors qu'il en a un.
                `Même durée que le trajet le plus court, pour
                 <strong>${saved} points d'exposition en moins</strong>.`
              : `C'est déjà le trajet le plus court.`
      }
    </p>
    ${
      jumps.length === 0
        ? ''
        : `<div class="jumps">
            <h3>${jumps.length === 1 ? 'Un passage brutal' : `${jumps.length} passages brutaux`} à l’ombre → plein soleil</h3>
            <ul>
              ${jumps
                .map(
                  (jump) => `<li>
                    <span class="jump-at">${formatMeters(jump.distance)}</span>
                    ${jump.name ? escapeHtml(jump.name) : 'sans nom'} —
                    l’indice passe de <strong>${jump.before}</strong> à
                    <strong style="color:${textColorFor(jump.after)}">${jump.after}</strong>.
                  </li>`,
                )
                .join('')}
            </ul>
            <p class="muted">L’œil n’a pas le temps de s’adapter : c’est là que ça fait
              le plus mal, même quand la moyenne du trajet reste basse.</p>
          </div>`
    }
    <ol class="legs">
      ${legs
        .map(
          (leg) => `
        <li class="${leg.crossing ? 'is-crossing' : ''}">
          <span class="leg-dot" style="background:${colorFor(leg.index)}"></span>
          <span class="leg-name">${leg.crossing ? 'Traversée' : escapeHtml(leg.name)}${
            leg.twoSided && !leg.crossing ? ` <em>côté ${leg.side}</em>` : ''
          }</span>
          <span class="leg-meters">${Math.round(leg.meters)} m</span>
        </li>`,
        )
        .join('')}
    </ol>
    <p class="muted route-timing">Calculé en ${elapsed} ms · l'exposition est évaluée à l'heure
      où vous passerez réellement, le soleil tournant de 15° par heure.</p>
    <div id="departures"></div>
    <div class="route-actions">
      <button id="route-when" class="ghost" type="button">Quand partir ?</button>
      <button id="route-navigate" class="ghost" type="button">Démarrer le guidage</button>
    </div>`;

  document.getElementById('route-navigate').addEventListener('click', startNavigation);
  document.getElementById('route-when').addEventListener('click', () => {
    exploreDepartures().catch((error) => {
      if (error instanceof SearchAborted) return;
      fail(error);
    });
  });
}

// ------------------------------------------------------------ quand partir ?

/** Pas et portée de l'exploration des heures de départ. */
const DEPARTURE_STEP = 15;
const DEPARTURE_SPAN = 180;

/**
 * Refait le même trajet à d'autres heures de départ.
 *
 * C'est la question que se pose vraiment quelqu'un de photophobe, et
 * l'application n'y répondait pas. Elle savait dire « voici le chemin le moins
 * exposé » ; elle ne savait pas dire « attendez quarante-cinq minutes et le
 * même trajet vous coûtera vingt points de moins », alors que tout était là
 * pour le calculer — le coût d'une arête dépend déjà de l'heure où l'on y
 * passe.
 *
 * On **refait la recherche** à chaque heure, plutôt que de réévaluer le tracé
 * trouvé pour l'heure courante. C'est plus cher, mais c'est la seule réponse
 * honnête : le meilleur chemin de 15 h n'est pas celui de 18 h, et se contenter
 * de rejouer le premier ferait passer pour une fatalité ce qui n'est qu'un
 * mauvais choix d'itinéraire.
 *
 * L'exploration est bornée à la plage calculée : proposer un départ à 23 h
 * quand les séries s'arrêtent au coucher du soleil donnerait une courbe plate
 * et fausse.
 */
async function exploreDepartures() {
  const { routeOptions, routeEnds } = state;
  const graph = currentGraph();
  if (!routeOptions || !routeEnds || !graph) return;

  const box = document.getElementById('departures');
  const last = Number(dom.time.max);
  const departures = [];
  for (
    let at = state.minutes;
    at <= state.minutes + DEPARTURE_SPAN && at <= last;
    at += DEPARTURE_STEP
  ) {
    departures.push(Math.round(at));
  }
  if (departures.length < 2) {
    box.innerHTML = `<p class="muted">Il ne reste pas assez de journée calculée pour
      comparer plusieurs départs.</p>`;
    return;
  }

  const signal = beginSearch();
  const results = [];
  for (const minutes of departures) {
    box.innerHTML = `<p class="muted">Comparaison des départs… ${results.length + 1}/${departures.length}</p>`;
    const route = await findRoute(graph, routeEnds.start, routeEnds.goal, {
      ...routeOptions,
      departureMinutes: minutes,
      signal,
    });
    // Un départ sans chemin ne devrait pas exister — le graphe n'a pas changé —
    // mais on préfère un trou dans la courbe à une exception en pleine boucle.
    if (route) results.push({ minutes, index: route.index, seconds: route.seconds });
  }

  renderDepartures(box, results);
}

function renderDepartures(box, results) {
  if (results.length === 0) {
    box.innerHTML = '';
    return;
  }

  const best = results.reduce((a, b) => (b.index < a.index ? b : a));
  const current = results[0];
  const peak = Math.max(...results.map((r) => r.index), 1);
  const gain = Math.round(current.index - best.index);

  box.innerHTML = `
    <div class="departures">
      <h3>Quand partir ?</h3>
      <div class="departure-bars" role="group" aria-label="Indice moyen selon l’heure de départ">
        ${results
          .map(
            (r) => `
          <button type="button" class="departure${r === best ? ' is-best' : ''}"
                  data-minutes="${r.minutes}"
                  aria-label="Départ à ${formatClock(r.minutes)}, indice ${Math.round(r.index)}"
                  title="Départ à ${formatClock(r.minutes)} — indice ${Math.round(r.index)}, ${Math.round(r.seconds / 60)} min">
            <span class="departure-bar" style="height:${Math.max(4, (r.index / peak) * 100)}%;
                  background:${colorFor(r.index)}"></span>
            <span class="departure-time">${
              // Une heure pleine sur quatre barres : treize étiquettes de cinq
              // chiffres ne tiennent pas dans la largeur du panneau, et les
              // empiler en biais les rendrait illisibles. Le survol et le
              // libellé accessible portent l'heure exacte de chaque barre.
              r.minutes % 60 === 0 ? `${Math.floor(r.minutes / 60)}h` : ''
            }</span>
          </button>`,
          )
          .join('')}
      </div>
      <p class="muted">${
        gain >= 3
          ? `En partant à <strong>${formatClock(best.minutes)}</strong> plutôt que maintenant,
             le même trajet passe de ${Math.round(current.index)} à
             <strong>${Math.round(best.index)}</strong> — ${gain} points de moins.`
          : // L'exploration s'arrête à la fin de la journée calculée : on dit
            // jusqu'où l'on a regardé, plutôt que « trois heures » en fin
            // d'après-midi. Et l'écart arrondi à 1 ou 2 n'est pas « sous 1 ».
            `Attendre jusqu’à ${formatClock(results.at(-1).minutes)} ne change presque rien :
             l’écart ${
               gain === 0
                 ? 'reste sous un point'
                 : `ne dépasse pas ${gain === 1 ? 'un point' : `${gain} points`}`
             }.`
      }</p>
    </div>`;

  box.querySelector('.departure-bars').addEventListener('click', (event) => {
    const button = event.target.closest('.departure');
    if (!button) return;
    // Adopter un départ, c'est déplacer l'heure de toute la carte : les couleurs
    // des rues doivent montrer ce qu'on vient de choisir, pas l'heure d'avant.
    state.minutes = Number(button.dataset.minutes);
    dom.time.value = String(state.minutes);
    applyTime();
    computeRoute().catch(fail);
  });
}

// ----------------------------------------------------------- lien partageable

/**
 * Inscrit l'itinéraire courant dans l'URL.
 *
 * `replaceState` et non `pushState` : chaque déplacement du curseur de priorité
 * relance le calcul, et empiler une entrée d'historique par cran ferait qu'il
 * faudrait appuyer trente fois sur « retour » pour sortir de la page.
 */
export function rememberRouteInUrl() {
  history.replaceState(
    null,
    '',
    writeRoute(location.href, {
      from: state.places.from,
      to: state.places.to,
      alpha: Number(dom.alpha.value),
      navigating: Boolean(state.nav),
    }),
  );
}

/**
 * Rouvre l'itinéraire décrit par l'URL, s'il y en a un.
 *
 * Le guidage ne redémarre pas tout seul, et ce n'est pas une prudence de
 * principe : la synthèse vocale exige un geste de l'utilisateur pour se
 * débloquer, sur iOS comme sur Chrome mobile. Un guidage repris sans clic
 * serait donc un guidage muet — la pire des reprises pour quelqu'un qui marche
 * sans regarder l'écran. On calcule l'itinéraire, on ouvre le panneau, et le
 * bouton « Démarrer le guidage » attend le doigt qui rendra la parole.
 */
export async function restoreRouteFromUrl() {
  const wanted = readRoute(location.href);
  if (!wanted.from || !wanted.to) return;

  if (wanted.alpha !== null) dom.alpha.value = String(wanted.alpha);
  setPlace('from', wanted.from);
  setPlace('to', wanted.to);
  setRoutePanel(true);
  await computeRoute();

  if (wanted.navigating && state.route) {
    dom.routeResult.insertAdjacentHTML(
      'afterbegin',
      `<p class="muted">Guidage interrompu par un rechargement — l’itinéraire est
       refait, il ne manque qu’un appui pour reprendre la parole.</p>`,
    );
  }
}
