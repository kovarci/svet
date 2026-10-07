import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';

// MapLibre 6 déduit l'adresse de son worker de la sienne propre. Passé par
// Vite, il n'a plus d'adresse propre — il est fondu dans notre paquet — et
// cherche son worker à côté d'un fichier qui ne l'a pas : aucune tuile ne se
// charge, en développement comme en production, et les tests n'en voient rien
// puisqu'ils ne lancent pas de carte. On donne donc l'adresse du worker tel
// que Vite l'a construit.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

import { createShadowLayer } from './shadows.js';
import { fetchForecast } from './weather.js';
import {
  prepareGraph,
  findRoute,
  nearestNode,
  summarize,
  transitions,
  SearchAborted,
} from './routing.js';
import { loadZoneData } from './binary.js';
import { createRegionData, loadRegionIndex } from './cells.js';
import { indexStreetNames } from './geocode.js';
import { readRoute, writeRoute } from './link.js';
import {
  MAX_PREFETCH_TILES,
  buildPlan,
  cellBytes,
  formatBytes,
  prefetch,
  tilesInBounds,
} from './offline.js';
import { createVoice, phraseFor } from './speech.js';
import {
  emptyCollection,
  escapeHtml,
  formatClock,
  formatMeters,
  haversineMeters,
  setHTML,
  setText,
} from './format.js';
import { prefs } from './prefs.js';
import {
  MODES,
  currentGraph,
  dom,
  evaluateSegment,
  fail,
  invalidateContexts,
  loadJSON,
  map,
  motionDuration,
  setMap,
  setShadows,
  shadows,
  state,
} from './app.js';
import {
  bindPlaceFields,
  geolocationMessage,
  setPlace,
  startPicking,
  stopPicking,
  useMyPosition,
} from './search.js';
import {
  addLayers,
  applyTime,
  buildingsForShadows,
  ensureVisibleCells,
  paintVisible,
  refreshLayers,
  removeNetworkLayers,
  setPitched,
  tileTemplate,
} from './layers.js';
import { closeDetailPanel, colorFor, textColorFor } from './panel.js';
import {
  OFF_ROUTE_METERS,
  advanceProgress,
  bearingBetween,
  buildInstructions,
  describeManoeuvre,
  nextManoeuvre,
  snapToRoute,
} from './navigation.js';
import { components, discomfortIndex, levelLabel, skyConditions } from '@svet/pipeline/model';
import { localDate, localMinutes } from '@svet/pipeline/sun';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/** Fond minimal si le fond de carte distant est injoignable — l'appli reste utilisable. */
const FALLBACK_BASEMAP = {
  version: 8,
  sources: {},
  layers: [{ id: 'fond', type: 'background', paint: { 'background-color': '#0b0f16' } }],
};

const voice = createVoice();

/**
 * Verrou d'écran : empêche le téléphone de se verrouiller pendant le guidage.
 *
 * C'était le plus gros écart entre ce que l'application promet et ce qu'elle
 * fait dehors. Un guidage piéton se consulte par coups d'œil, pas en continu :
 * au bout de trente secondes sans toucher l'écran, le téléphone se verrouille,
 * la page passe en arrière-plan, et l'annonce suivante tombe dans le vide.
 *
 * Trois points de détail qui décident si ça marche vraiment :
 *
 *  - Le verrou est **perdu à chaque passage en arrière-plan**, sans erreur ni
 *    message — c'est le comportement normal. Il faut donc le redemander au
 *    retour, sans quoi il ne tient que jusqu'au premier appel reçu.
 *  - Il ne s'obtient que sur un document **visible** et en contexte sécurisé.
 *    Le démarrage du guidage étant un clic, la première demande passe ; les
 *    suivantes sont gardées par `document.hidden`.
 *  - Un refus n'est pas une panne. Batterie faible, économiseur d'énergie,
 *    navigateur sans l'API : le guidage fonctionne quand même, il faut
 *    seulement rallumer l'écran. On le note dans la console, sans rien dire à
 *    l'écran — ce serait un avertissement de plus sur le seul bandeau qu'on lit
 *    en marchant.
 */
const screenLock = {
  sentinel: null,

  async acquire() {
    if (!('wakeLock' in navigator) || document.hidden || this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      // Le relâchement peut venir du système ; on tient l'état à jour pour que
      // le retour au premier plan sache qu'il faut redemander.
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
    } catch (error) {
      console.warn('Écran maintenu allumé : impossible —', error.message);
    }
  },

  release() {
    this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  },
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.nav) screenLock.acquire();
});

start().catch(fail);

async function start() {
  // C'est ce fichier qui porte l'horodatage des calculs, et donc qui version
  // tout le reste : servi depuis un cache, il figerait les données de zone à
  // jamais et un recalcul du pipeline resterait invisible. `cache: no-cache` ne
  // suffit pas — un service worker peut répondre avant. On rend donc l'URL
  // elle-même unique, ce que rien ne peut mettre en cache par erreur ; le
  // service worker sait retrouver la dernière copie connue hors ligne, en
  // ignorant la requête.
  state.zones = await loadJSON(`data/zones.json?t=${Date.now()}`, { cache: 'no-cache' });
  if (state.zones.length === 0) throw new Error('Aucune zone calculée.');

  dom.zone.innerHTML = state.zones
    .map((z) => `<option value="${z.key}">${z.label}</option>`)
    .join('');

  // Un lien partagé désigne une zone précise et doit primer ; sinon on rouvre
  // celle de la dernière visite, faute de quoi il faudrait la rechoisir chaque
  // fois. La plus grande reste le dernier recours.
  const saved = prefs.read();
  const requested = new URLSearchParams(location.search).get('zone');
  const zone =
    state.zones.find((z) => z.key === requested) ??
    state.zones.find((z) => z.key === saved.zone) ??
    state.zones[state.zones.length - 1];
  dom.zone.value = zone.key;
  applySavedReading(saved);

  setMap(
    new maplibregl.Map({
      container: 'map',
      style: await loadBasemapStyle(),
      center: zone.center,
      zoom: 15.2,
      // Relevé à la demande par le bouton 3D. À plat par défaut : la nappe de
      // lumière suppose une carte non inclinée, sa transformation étant affine.
      maxPitch: 0,
      // Position dans l'URL : un lien vers une rue précise reste partageable.
      hash: true,
      attributionControl: { compact: true },
    }),
  );
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  setShadows(createShadowLayer(map, document.getElementById('shadows'), buildingsForShadows));

  // Aide au débogage : inspecter la carte et les relevés depuis la console.
  // Absent des builds de production.
  if (import.meta.env.DEV) {
    window.svet = { map, state, shadows, model: { components, discomfortIndex, skyConditions } };
  }

  // L'interface se monte avant l'attente, et non après : rien en elle ne dépend
  // du fond de carte, et le voile de chargement couvre l'écran tant que la carte
  // n'est pas prête — aucune de ces commandes n'est atteignable entre-temps.
  bindControls();
  trackChromeSize();

  // On n'attend pas les données à cet instant, mais le style du fond. Le dire :
  // c'est l'étape qui peut durer, et un message faux sur une attente longue est
  // ce qui fait croire à une panne.
  dom.loading.textContent = 'Préparation de la carte…';
  await whenStyleReady(map);

  await loadZone(zone.key);
  dom.loading.classList.add('is-hidden');
  registerServiceWorker();

  // L'itinéraire du lien vient après les données : il lui faut le graphe. Un
  // échec ici — deux points hors zone, réseau coupé — ne doit pas emporter le
  // démarrage : la carte, elle, est déjà là et parfaitement utilisable.
  await restoreRouteFromUrl().catch((error) => {
    console.warn('Itinéraire du lien non rétabli :', error.message);
  });
}

/**
 * Rétablit la façon de lire la carte choisie la fois précédente.
 *
 * Chaque valeur est confrontée à la liste des options réelles avant d'être
 * posée : un réglage écrit par une version antérieure, dont le mode a disparu
 * depuis, laisserait sinon le sélecteur vide et la carte grise.
 */
function applySavedReading(saved) {
  if (saved.mode && MODES[saved.mode]) {
    state.mode = saved.mode;
    dom.mode.value = saved.mode;
  }
  if (['both', 'best', 'worst'].includes(saved.side)) {
    state.sideMode = saved.side;
    dom.side.value = saved.side;
  }
  if (['forecast', 'clear'].includes(saved.sky)) {
    state.skyMode = saved.sky;
    dom.sky.value = saved.sky;
  }
}

/**
 * Tient à jour la hauteur réelle des deux barres, dans deux variables CSS.
 *
 * Les panneaux se calaient sur `62px` écrits en dur. Or la barre du haut fait
 * 108 px dès que la fenêtre force ses commandes sur deux lignes, et le panneau
 * d'itinéraire s'ouvrait alors dessous, inatteignable. Plutôt que de deviner,
 * on mesure : un `ResizeObserver` suffit, et il couvre aussi le passage de la
 * frise horaire au bandeau de guidage, qui n'ont pas la même hauteur.
 */
function trackChromeSize() {
  const root = document.documentElement.style;
  const update = () => {
    root.setProperty('--topbar-h', `${Math.round(dom.topbar.offsetHeight)}px`);
    // L'une des deux est toujours masquée, donc de hauteur nulle.
    const bottom = Math.max(dom.timebar.offsetHeight, dom.nav.offsetHeight);
    root.setProperty('--timebar-h', `${Math.round(bottom)}px`);
  };

  update();
  const observer = new ResizeObserver(update);
  for (const element of [dom.topbar, dom.timebar, dom.nav]) observer.observe(element);
}

/**
 * Enregistre le service worker qui rend l'application utilisable hors réseau.
 *
 * Volontairement après le premier affichage : l'enregistrement déclenche la
 * mise en cache de la coquille, et rien ne justifie de retarder la carte pour
 * ça. Comme la géolocalisation, il exige un contexte sécurisé — `localhost` en
 * développement, HTTPS ailleurs.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.warn('Mode hors ligne indisponible :', error.message);
  });
}

// --------------------------------------------------------------- chargement

async function loadZone(key) {
  // Numéroté dès l'entrée : un chargement que l'on a dépassé en changeant de
  // zone s'arrête à son prochain réveil. Sans cela, Paris — trente-quatre
  // mégaoctets — finissait d'arriver après la zone choisie ensuite, et
  // s'installait à sa place sous un sélecteur qui affichait l'autre.
  const token = ++loadToken;
  dom.loading.classList.remove('is-hidden');
  dom.loading.classList.remove('is-error');
  dom.loading.textContent = 'Chargement des données…';

  const entry = state.zones.find((z) => z.key === key);
  if (entry?.kind === 'region') return loadRegion(entry, token);

  // L'horodatage du calcul en paramètre d'URL : c'est lui qui fait qu'une
  // reconstruction du pipeline invalide le cache hors ligne, plutôt que de
  // rester invisible derrière des fichiers de même nom.
  const stamp = state.zones.find((z) => z.key === key)?.stamp ?? '';
  const version = stamp ? `?v=${stamp}` : '';
  lastProgress = -1;
  const [meta, data] = await Promise.all([
    loadJSON(`data/${key}.meta.json${version}`),
    loadZoneData(`data/${key}.data.bin${version}`, (received, total) =>
      reportProgress(token, received, total),
    ),
  ]);
  if (token !== loadToken) return;
  state.zoneKey = key;
  state.version = version;

  state.meta = meta;
  state.region = null;
  dom.tilesToggle.hidden = false;
  state.selected = null;
  state.route = null;
  state.places = { from: null, to: null };
  dom.panel.hidden = true;
  dom.routeResult.innerHTML = '';
  dom.from.value = '';
  dom.to.value = '';

  invalidateContexts();
  renderDatasetDate(meta);
  state.data = data;
  state.graph = prepareGraph(data);
  state.streets = indexStreetNames(data, state.graph);

  // Midi solaire par défaut : le moment le plus discriminant de la journée.
  const noon = meta.times.reduce(
    (best, t, i, all) => (t.altitude > all[best].altitude ? i : best),
    0,
  );
  state.minutes = meta.times[noon].minutes;

  dom.time.min = String(meta.times[0].minutes);
  dom.time.max = String(meta.times[meta.times.length - 1].minutes);
  dom.time.step = '1';
  dom.time.value = String(state.minutes);

  // Chaque zone a sa propre pyramide de tuiles : on remplace la source, ce qui
  // purge du même coup les états d'entités de la précédente.
  if (map.getSource('network')) removeNetworkLayers();
  await addLayers();
  if (token !== loadToken) return;
  map.getSource('route')?.setData(emptyCollection());
  map.getSource('markers')?.setData(emptyCollection());
  map.getSource('me')?.setData(emptyCollection());
  // Une position dans l'URL prime sur le cadrage par défaut.
  if (!location.hash) map.fitBounds(meta.bbox, { padding: 40, duration: 0 });

  applyTime();
  dom.loading.classList.add('is-hidden');

  // La prévision arrive après coup : la carte est déjà utilisable en ciel clair.
  loadForecast(meta);
}

/**
 * Ouvre une région : l'index d'abord, les relevés cellule par cellule ensuite.
 *
 * La différence de fond avec une zone tient en une phrase : **il n'y a pas de
 * moment où tout est chargé**. L'index pèse quelques dizaines de kilo-octets et
 * suffit à dresser la carte ; les relevés d'un trottoir n'arrivent que si l'on
 * s'en approche. C'est ce qui rend douze mille kilomètres carrés tenables là où
 * un fichier unique en pèserait un gigaoctet.
 *
 * En contrepartie, tout ce qui interroge un tronçon doit accepter de n'obtenir
 * rien — et le dire, plutôt que d'afficher la couleur du zéro, qui voudrait
 * dire « aucune gêne ».
 */
async function loadRegion(entry, token) {
  const version = entry.stamp ? `?v=${entry.stamp}` : '';
  const index = await loadRegionIndex(`data/${entry.region}/index.json${version}`);
  if (token !== loadToken) return;

  state.zoneKey = entry.key;
  state.version = version;
  state.meta = index;
  state.selected = null;
  state.route = null;
  state.places = { from: null, to: null };
  dom.panel.hidden = true;
  dom.routeResult.innerHTML = '';
  dom.from.value = '';
  dom.to.value = '';

  invalidateContexts();
  renderDatasetDate(index);

  state.region = createRegionData(index, {
    baseUrl: `data/${entry.region}/cellules/`,
    onCellsChanged: () => {
      // Le graphe et l'index des rues portent sur ce qui est chargé : les
      // reconstruire à chaque cellule reçue coûterait cher pour rien, alors
      // qu'aucun itinéraire n'est en cours. On les invalide, ils se referont
      // quand on les demandera.
      state.graph = null;
      state.streets = null;
      if (state.lastContext) paintVisible(state.lastContext);
    },
  });
  state.data = state.region;
  state.graph = null;
  state.streets = null;
  state.tiled = true;
  dom.tilesToggle.hidden = true;

  const noon = index.times.reduce(
    (best, t, i, all) => (t.altitude > all[best].altitude ? i : best),
    0,
  );
  state.minutes = index.times[noon].minutes;
  dom.time.min = String(index.times[0].minutes);
  dom.time.max = String(index.times[index.times.length - 1].minutes);
  dom.time.step = '1';
  dom.time.value = String(state.minutes);

  if (map.getSource('network')) removeNetworkLayers();
  await addLayers();
  if (token !== loadToken) return;
  map.getSource('route')?.setData(emptyCollection());
  map.getSource('markers')?.setData(emptyCollection());
  map.getSource('me')?.setData(emptyCollection());
  if (!location.hash) map.fitBounds(index.bbox, { padding: 40, duration: 0 });

  dom.loading.textContent = 'Chargement des relevés du secteur…';
  await ensureVisibleCells();
  if (token !== loadToken) return;

  applyTime();
  dom.loading.classList.add('is-hidden');
  loadForecast(index);
}

/**
 * Avancement du téléchargement de la zone.
 *
 * Paris pèse 34 Mo. Sur un réseau mobile, c'est une minute pendant laquelle
 * « Chargement des données… » ne bouge pas d'un pixel — et rien ne distingue
 * une attente longue d'une application en panne. Le pourcentage tranche.
 *
 * Réécrit au point de pourcentage près : le corps arrive par tranches de
 * quelques dizaines de kilo-octets, ce qui ferait cinq cents réécritures de
 * texte pour Paris, sans qu'aucune se voie.
 */
let lastProgress = -1;

/**
 * Numéro du chargement en cours.
 *
 * Les deux fichiers d'une zone sont demandés en parallèle, et le binaire
 * continue d'arriver quand les métadonnées ont déjà échoué : son avancement
 * recouvrait alors le message d'erreur que `fail` venait d'écrire, laissant
 * « Chargement… 100 % » sur un écran d'échec. Un changement de zone en cours de
 * route produit le même recouvrement, à l'envers.
 */
let loadToken = 0;

function reportProgress(token, received, total) {
  if (token !== loadToken || dom.loading.classList.contains('is-error')) return;
  const megabytes = received / 1048576;
  const percent = total ? Math.floor((received / total) * 100) : -1;
  if (percent === lastProgress) return;
  lastProgress = percent;

  dom.loading.textContent =
    percent >= 0
      ? `Chargement des données… ${percent} %`
      : `Chargement des données… ${megabytes.toFixed(1)} Mo`;
}

async function loadForecast(meta) {
  dom.skyInfo.textContent = 'météo…';
  try {
    // La prévision part d'aujourd'hui, jamais de la date du calcul : celle-ci
    // peut dater de la veille, et proposer par défaut la météo d'hier n'a aucun
    // sens pour quelqu'un qui prépare une sortie. La géométrie des ombres, elle,
    // reste celle du calcul — c'est ce qui borne l'horizon à trois jours.
    const today = localDate();
    state.forecast = await fetchForecast({
      center: meta.center,
      date: meta.date > today ? meta.date : today,
      times: meta.times,
    });
  } catch (error) {
    console.warn('Prévision indisponible :', error.message);
    state.forecast = null;
  }
  if (!state.forecast) {
    dom.sky.value = 'clear';
    state.skyMode = 'clear';
  }
  renderDayChoices();
  invalidateContexts();
  if (state.meta === meta) applyTime();
}

/**
 * Peuple le choix du jour, et l'efface s'il n'y a rien à choisir.
 *
 * Le libellé dit « aujourd'hui / demain / après-demain » plutôt qu'une date :
 * c'est ainsi qu'on prépare une sortie, et ça évite d'avoir à comparer la date
 * du calcul à celle du jour.
 */
function renderDayChoices() {
  const dates = state.forecast?.dates ?? [];
  dom.dayField.hidden = dates.length < 2;
  if (dates.length < 2) {
    state.day = dates[0] ?? null;
    return;
  }

  const today = localDate();
  const label = (iso) => {
    const days = Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
    if (days === 0) return "aujourd'hui";
    if (days === 1) return 'demain';
    if (days === 2) return 'après-demain';
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
    });
  };

  dom.day.innerHTML = dates.map((d) => `<option value="${d}">${label(d)}</option>`).join('');
  state.day = dates[0];
  dom.day.value = state.day;
}

/**
 * Rappelle à quelle date correspond la géométrie solaire précalculée.
 *
 * La météo est bien celle du jour, mais la course du soleil est figée à la date
 * du calcul. Le taire donnerait une fausse impression de temps réel.
 */
function renderDatasetDate(meta) {
  const formatted = new Date(`${meta.date}T12:00:00`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const today = localDate();
  const days = Math.round((Date.parse(today) - Date.parse(meta.date)) / 86400000);

  // « Paris » était écrit en dur : c'était vrai tant que toutes les zones
  // étaient parisiennes. Une carte qui va de Mantes à Provins ne peut pas
  // s'annoncer parisienne — et la mention sert justement à dire de quel
  // territoire vient la course du soleil affichée.
  //
  // On lit les métadonnées reçues, et non `state.region` : cette fonction est
  // appelée avant que l'état de la région soit posé, si bien que le test aurait
  // toujours répondu « Paris ».
  dom.datasetDate.textContent = `${formatted} · ${meta.kind === 'region' ? meta.label : 'Paris'}`;
  // Sept jours d'écart déplacent le soleil d'environ trois degrés à midi : en
  // deçà, l'ombre annoncée reste crédible ; au-delà, il faut le dire.
  dom.datasetDate.classList.toggle('is-stale', Math.abs(days) > 7);
  dom.datasetDate.title =
    days === 0
      ? "Course du soleil calculée pour aujourd'hui."
      : `Course du soleil calculée pour le ${formatted}, soit ${Math.abs(days)} jour(s) ` +
        `${days > 0 ? 'avant' : 'après'} aujourd'hui. Relancez « npm run data:refresh » ` +
        `pour remettre toutes les zones à jour.`;
}

// --------------------------------------------------------------- itinéraire

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

async function computeRoute() {
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

// ------------------------------------------------------------------ guidage

/**
 * Guidage pas à pas, position réelle à l'appui.
 *
 * Deux partis pris qui distinguent ce guidage d'un GPS ordinaire :
 *
 *  - **L'heure passe en temps réel.** Pendant qu'on marche, le soleil tourne
 *    vraiment ; garder le curseur horaire figé sur une heure choisie donnerait
 *    des ombres fausses au fil du trajet.
 *  - **Chaque consigne porte le trottoir**, et un changement de côté devient
 *    une consigne de traversée — sinon « marchez côté nord » resterait un
 *    conseil qu'on ne saurait pas appliquer.
 */
function startNavigation() {
  if (!state.route) return;
  if (!navigator.geolocation) {
    dom.routeResult.insertAdjacentHTML(
      'beforeend',
      `<p class="warn">Ce navigateur ne donne pas la position.</p>`,
    );
    return;
  }

  state.nav = {
    instructions: buildInstructions(state.route),
    // Les passages ombre → plein soleil sont repérés une fois, au départ : ils
    // dépendent de l'heure de passage prévue, et la recalculer à chaque pas
    // ferait varier l'avertissement sous les pieds de celui qui marche.
    transitions: transitions(state.route),
    warnedTransitions: new Set(),
    hint: null,
    following: true,
    offRoute: false,
    watchId: null,
    lastFix: null,
  };

  dom.nav.hidden = false;
  dom.timebar.hidden = true;
  dom.route.hidden = true;
  dom.routeToggle.classList.remove('is-on');
  dom.routeToggle.setAttribute('aria-pressed', 'false');
  // Le bouton qui a lancé le guidage vient de disparaître avec son panneau : le
  // focus doit suivre le bandeau qui le remplace, sans quoi il retombe sur le
  // corps du document au moment précis où l'on se met à marcher.
  dom.nav.focus();
  dom.navFollow.classList.add('is-on');
  dom.navInstruction.textContent = 'Recherche de votre position…';
  dom.navDistance.textContent = '';

  // L'horloge suit désormais le temps réel, et non plus le curseur.
  followRealClock();

  // Demandé ici, sur le clic : le document est visible et actif, seul moment où
  // le verrou s'obtient.
  screenLock.acquire();
  rememberRouteInUrl();

  // Le clic qui démarre le guidage est le geste utilisateur dont iOS et Chrome
  // mobile ont besoin pour autoriser la synthèse vocale. On le consomme ici.
  voice.reset();
  voice.unlock();
  dom.navVoice.hidden = !voice.supported;
  const first = state.nav.instructions[0];
  if (first) {
    const legs = state.route.steps.length;
    voice.speak(
      `Itinéraire de ${Math.round(state.route.meters)} mètres, ` +
        `environ ${Math.round(state.route.seconds / 60)} minutes. ` +
        (legs ? 'Départ.' : ''),
    );
  }

  state.nav.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 15000,
  });
}

function stopNavigation() {
  if (!state.nav) return;
  if (state.nav.watchId !== null) navigator.geolocation.clearWatch(state.nav.watchId);
  voice.speak('', { interrupt: true });
  clearInterval(state.nav.clockTimer);
  screenLock.release();
  state.nav = null;
  rememberRouteInUrl();

  if (dom.nav.contains(document.activeElement)) dom.routeToggle.focus();
  dom.nav.hidden = true;
  dom.nav.classList.remove('is-off-route');
  dom.timebar.hidden = false;
  map.getSource('me').setData(emptyCollection());
  map.easeTo({ bearing: 0, duration: motionDuration(300) });
}

/** Aligne l'heure simulée sur l'heure réelle, et la maintient. */
function followRealClock() {
  const sync = () => {
    if (!state.nav) return;
    // L'heure de Paris, pas celle du téléphone : la simulation est en heure de
    // Paris, et un téléphone resté à l'heure d'un autre fuseau guiderait avec
    // les ombres d'une autre heure.
    const minutes = localMinutes();
    const min = Number(dom.time.min);
    const max = Number(dom.time.max);
    state.minutes = Math.max(min, Math.min(max, minutes));
    dom.time.value = String(Math.round(state.minutes));
    applyTime();
  };
  sync();
  state.nav.clockTimer = setInterval(sync, 30000);
}

function onPosition(position) {
  if (!state.nav || !state.route) return;
  const { longitude, latitude, heading, accuracy } = position.coords;

  const fix = snapToRoute(state.route, longitude, latitude, state.nav.hint);
  state.nav.hint = fix.index;
  state.nav.offRoute = fix.offset > OFF_ROUTE_METERS;

  // Progression forcée monotone — la règle et son pourquoi sont dans
  // `advanceProgress`, où elles s'éprouvent sans capteur.
  state.nav.progress = advanceProgress(state.nav.progress, fix.distanceAlong);
  fix.distanceAlong = state.nav.progress;

  // Le cap du GPS n'existe qu'en mouvement ; à l'arrêt on garde le précédent,
  // sinon la carte pivoterait au hasard.
  let bearing = Number.isFinite(heading) ? heading : state.nav.lastBearing;
  if (!Number.isFinite(bearing) && state.nav.lastFix) {
    bearing = bearingBetween(state.nav.lastFix, [longitude, latitude]);
  }
  if (Number.isFinite(bearing)) state.nav.lastBearing = bearing;
  state.nav.lastFix = [longitude, latitude];

  map.getSource('me').setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: { accuracy },
      },
    ],
  });

  if (state.nav.following) {
    const target = state.nav.offRoute ? [longitude, latitude] : fix.snapped;
    const centre = map.getCenter();
    const jump = haversineMeters(centre.lng, centre.lat, target[0], target[1]) > 150;
    const camera = {
      center: target,
      zoom: Math.max(map.getZoom(), 17.5),
      bearing: Number.isFinite(bearing) ? bearing : map.getBearing(),
    };
    // Une animation plus longue que l'intervalle entre deux positions serait
    // interrompue à chaque fois : la caméra n'en jouerait qu'un fragment et
    // resterait indéfiniment en retard. 400 ms passent sous la seconde d'un
    // GPS ordinaire. Au-delà de 150 m — première acquisition, retour après une
    // perte de signal — on saute plutôt que de traverser Paris en glissant.
    if (jump) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: motionDuration(400) });
  }

  renderNavigation(fix, accuracy);
}

function onPositionError(error) {
  if (!state.nav) return;
  dom.navInstruction.textContent = geolocationMessage(error);
  dom.navSide.textContent = '';
}

function renderNavigation(fix, accuracy) {
  const { instructions } = state.nav;
  const { instruction, remaining } = nextManoeuvre(instructions, fix.distanceAlong);
  const { text, arrow, side } = describeManoeuvre(instruction, remaining);

  dom.nav.classList.toggle('is-off-route', state.nav.offRoute);
  if (!state.nav.offRoute) state.nav.warnedOffRoute = false;

  if (state.nav.offRoute) {
    if (!state.nav.warnedOffRoute) {
      state.nav.warnedOffRoute = true;
      voice.speak('Vous vous êtes écarté du trajet.', { interrupt: true });
      voice.vibrate([120, 80, 120, 80, 120]);
    }
    setText(dom.navArrow, '⟳');
    setText(dom.navInstruction, 'Vous vous êtes écarté du trajet');
    // L'écart se réécrit à chaque mesure : arrondi aux cinq mètres, il cesse de
    // faire clignoter le bouton de recalcul sous le doigt qui le vise.
    setHTML(
      dom.navSide,
      `À ${Math.round(fix.offset / 5) * 5} m de l'itinéraire.
      <button id="nav-recompute" class="link">Recalculer depuis ici</button>`,
    );
    setText(dom.navDistance, '');
    return;
  }

  setText(dom.navArrow, arrow);
  setText(dom.navInstruction, text);
  setText(dom.navSide, side ? `Trottoir ${side}` : '');

  voice.announce(instruction, remaining, phraseFor(instruction, remaining));
  setText(dom.navDistance, remaining < 15 ? 'maintenant' : formatMeters(remaining));
  warnTransition(fix.distanceAlong);

  const left = Math.max(0, state.route.meters - fix.distanceAlong);
  const minutes = Math.round(left / (state.meta.walkingSpeed ?? 1.35) / 60);
  setText(
    dom.navRemaining,
    `${formatMeters(left)} · ${minutes} min` +
      (accuracy > 25 ? ` · position à ± ${Math.round(accuracy)} m` : ''),
  );

  // Exposition à l'endroit précis où l'on se trouve, et non moyenne du trajet.
  const step = state.route.steps[Math.min(fix.index, state.route.steps.length - 1)];
  if (step) {
    const now = evaluateSegment(step.segment, state.minutes);
    setHTML(
      dom.navExposure,
      `<span style="color:${colorFor(now.index)}">●</span> indice ${now.index} — ${levelLabel(now.index)}`,
    );
  }
}

/**
 * Prévient d'un passage brutal à l'ombre → plein soleil, une trentaine de
 * mètres avant.
 *
 * Trente mètres, c'est une vingtaine de secondes de marche : de quoi sortir des
 * lunettes ou baisser les yeux, ce qui est tout ce qu'on peut faire. Prévenir
 * plus tôt reviendrait à annoncer quelque chose qu'on ne voit pas encore ;
 * prévenir au moment même ne servirait à rien.
 *
 * L'avertissement vibre aussi : c'est le seul canal qui passe quand on marche
 * avec le téléphone en poche et le son coupé.
 */
function warnTransition(distanceAlong) {
  const nav = state.nav;
  if (!nav?.transitions) return;

  for (const jump of nav.transitions) {
    const remaining = jump.distance - distanceAlong;
    if (remaining < 0 || remaining > 30) continue;
    if (nav.warnedTransitions.has(jump.distance)) continue;
    nav.warnedTransitions.add(jump.distance);
    voice.speak(`Attention, passage au soleil dans ${Math.round(remaining / 5) * 5} mètres.`);
    voice.vibrate([200, 100, 200]);
    return;
  }
}

// ------------------------------------------------------------------ hors ligne

/**
 * Ce qu'il faudrait télécharger pour tenir hors ligne sur le secteur affiché.
 *
 * Les zooms retenus vont de celui de l'écran au plus fin de la pyramide : on
 * prépare ce qu'on regarde et ce qu'on regardera de plus près, pas la vue
 * d'ensemble qu'on vient de quitter. Zoomer avant de préparer réduit donc à la
 * fois l'emprise et le volume, ce qui est le réglage naturel.
 */
function offlinePlan() {
  const view = map.getBounds();
  const bounds = {
    west: view.getWest(),
    south: view.getSouth(),
    east: view.getEast(),
    north: view.getNorth(),
  };
  const { minZoom, maxZoom } = state.meta.tiles ?? { minZoom: 11, maxZoom: 16 };
  const from = Math.max(minZoom, Math.min(maxZoom, Math.floor(map.getZoom())));
  const tiles = tilesInBounds(bounds, { minZoom: from, maxZoom });

  const absolute = (url) => new URL(url, location.href).toString();
  const data = state.region
    ? state.region.cellsIn(bounds).map((cell) => ({
        url: absolute(
          `data/${state.meta.region}/cellules/${cell.key}.data.bin${cell.stamp ? `?v=${cell.stamp}` : ''}`,
        ),
        bytes: cellBytes(cell),
      }))
    : [
        { url: absolute(`data/${state.zoneKey}.meta.json${state.version}`), bytes: 4000 },
        {
          url: absolute(`data/${state.zoneKey}.data.bin${state.version}`),
          bytes: (state.data?.segmentCount ?? 0) * 192,
        },
      ];

  return { ...buildPlan({ tileUrl: tileTemplate(), tiles, data }), cells: data.length, from };
}

function setOfflinePanel(open) {
  if (!open && dom.offline.contains(document.activeElement)) dom.offlineToggle.focus();
  // Les deux panneaux occupent la même place à l'écran ; ouvrir l'un ferme donc
  // l'autre, plutôt que de les empiler.
  if (open && !dom.route.hidden) setRoutePanel(false);
  dom.offline.hidden = !open;
  dom.offlineToggle.classList.toggle('is-on', open);
  dom.offlineToggle.setAttribute('aria-expanded', String(open));
  if (!open) return;

  dom.offlineResult.innerHTML = '';
  const plan = offlinePlan();
  const tooMuch = plan.tiles > MAX_PREFETCH_TILES;
  dom.offlineGo.disabled = tooMuch;
  dom.offlineEstimate.innerHTML = tooMuch
    ? `<p class="warn">Le secteur affiché demande ${plan.tiles.toLocaleString('fr-FR')} tuiles —
       bien plus qu'un quartier. Zoomez sur ce que vous allez vraiment parcourir.</p>`
    : `<p class="offline-size"><strong>${formatBytes(plan.bytes)}</strong>
       <span class="muted">· ${
         state.region
           ? `${plan.cells} secteur${plan.cells > 1 ? 's' : ''} de relevés`
           : 'relevés de la zone'
       } et ${plan.tiles.toLocaleString('fr-FR')} tuiles, du zoom ${plan.from} au plus fin</span></p>`;
}

async function runOffline() {
  // Le plan est refait au moment du clic, et non repris de l'ouverture du
  // panneau : la carte a pu bouger derrière, et c'est bien ce qu'on voit
  // maintenant qu'on veut emporter. Mais alors le garde-fou de volume, posé à
  // l'ouverture, ne vaut plus rien — il faut le reposer ici, sinon un
  // dézoomage entre les deux gestes lance le téléchargement de la région.
  const plan = offlinePlan();
  if (plan.tiles > MAX_PREFETCH_TILES) {
    setOfflinePanel(true);
    return;
  }

  dom.offlineGo.disabled = true;
  dom.offlineResult.innerHTML = `<p class="muted">Téléchargement… 0 %</p>`;

  try {
    const { failed } = await prefetch(plan.urls, (done, total) => {
      dom.offlineResult.innerHTML = `<p class="muted">Téléchargement…
        ${Math.floor((done / total) * 100)} %</p>`;
    });
    dom.offlineResult.innerHTML =
      failed > 0
        ? `<p class="warn">Secteur préparé, mais ${failed} fichier(s) manquent —
           relancez pour les rattraper.</p>`
        : `<p class="offline-done">Secteur disponible hors ligne.</p>`;
  } catch (error) {
    dom.offlineResult.innerHTML = `<p class="warn">${escapeHtml(error.message)}</p>`;
  } finally {
    dom.offlineGo.disabled = false;
  }
}

// ----------------------------------------------------------- lien partageable

/**
 * Inscrit l'itinéraire courant dans l'URL.
 *
 * `replaceState` et non `pushState` : chaque déplacement du curseur de priorité
 * relance le calcul, et empiler une entrée d'historique par cran ferait qu'il
 * faudrait appuyer trente fois sur « retour » pour sortir de la page.
 */
function rememberRouteInUrl() {
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
async function restoreRouteFromUrl() {
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

// ---------------------------------------------------------------- contrôles

function bindControls() {
  dom.time.addEventListener('input', () => {
    state.minutes = Number(dom.time.value);
    applyTime();
  });

  dom.mode.addEventListener('change', () => {
    state.mode = dom.mode.value;
    prefs.write({ mode: state.mode });
    refreshLayers();
  });

  dom.side.addEventListener('change', () => {
    state.sideMode = dom.side.value;
    prefs.write({ side: state.sideMode });
    refreshLayers();
  });

  dom.sky.addEventListener('change', () => {
    state.skyMode = dom.sky.value;
    prefs.write({ sky: state.skyMode });
    invalidateContexts();
    applyTime();
  });

  dom.zone.addEventListener('change', () => {
    stopPlaying();
    prefs.write({ zone: dom.zone.value });
    const url = new URL(writeRoute(location.href, {}));
    url.searchParams.set('zone', dom.zone.value);
    url.hash = '';
    // L'itinéraire est effacé du lien en même temps qu'il l'est de l'écran :
    // départ et arrivée appartenaient à l'autre zone, et un rechargement les
    // aurait ressuscités hors de leur emprise.
    history.replaceState(null, '', url);
    loadZone(dom.zone.value).catch(fail);
  });

  bindSettingsSheet();

  dom.shadowToggle.addEventListener('click', () => {
    const on = dom.shadowToggle.classList.toggle('is-on');
    dom.shadowToggle.setAttribute('aria-pressed', String(on));
    shadows.setEnabled(on);
  });

  dom.routeToggle.addEventListener('click', () => setRoutePanel(dom.route.hidden));
  dom.routeClose.addEventListener('click', () => setRoutePanel(false));

  dom.offlineToggle.addEventListener('click', () => setOfflinePanel(dom.offline.hidden));
  dom.offlineClose.addEventListener('click', () => setOfflinePanel(false));
  dom.offlineGo.addEventListener('click', () => runOffline());

  dom.play.addEventListener('click', () => (state.playing ? stopPlaying() : startPlaying()));

  dom.panelClose.addEventListener('click', closeDetailPanel);

  dom.tilesToggle.addEventListener('click', async () => {
    // « Tout chargé » n'a pas de sens sur une région : il n'existe aucun
    // fichier qui la contienne entière, et c'est tout l'objet du découpage.
    if (state.region) return;
    state.tiled = !state.tiled;
    dom.tilesToggle.classList.toggle('is-on', state.tiled);
    dom.tilesToggle.setAttribute('aria-pressed', String(state.tiled));
    dom.tilesToggle.textContent = state.tiled ? 'Tuiles' : 'Tout chargé';
    dom.loading.classList.remove('is-hidden');
    dom.loading.textContent = state.tiled ? 'Passage en tuiles…' : 'Chargement de la zone entière…';
    removeNetworkLayers();
    await addLayers();
    applyTime();
    shadows.refresh();
    dom.loading.classList.add('is-hidden');
  });

  dom.pitchToggle.addEventListener('click', () => setPitched(!state.pitched));

  dom.day.addEventListener('change', () => {
    state.day = dom.day.value;
    invalidateContexts();
    applyTime();
  });

  // Pénombre. Le réglage survit au rechargement : quelqu'un qui a besoin d'un
  // écran sombre en a besoin à chaque ouverture, pas une fois.
  const applyDim = (value) => {
    document.documentElement.style.setProperty('--dim', String(value / 100));
    prefs.write({ dim: value });
  };
  const savedDim = Number(prefs.read().dim ?? 0);
  if (Number.isFinite(savedDim) && savedDim > 0) {
    dom.dim.value = String(savedDim);
    document.documentElement.style.setProperty('--dim', String(savedDim / 100));
  }
  dom.dim.addEventListener('input', () => applyDim(Number(dom.dim.value)));

  dom.routeGo.addEventListener('click', () => computeRoute().catch(fail));
  dom.navStop.addEventListener('click', stopNavigation);
  dom.navVoice.addEventListener('click', () => {
    const on = !voice.enabled;
    voice.setEnabled(on);
    dom.navVoice.classList.toggle('is-on', on);
    dom.navVoice.setAttribute('aria-pressed', String(on));
    dom.navVoice.textContent = on ? '🔊' : '🔇';
  });
  // Le bouton « Recalculer depuis ici » naît et meurt avec le message d'écart.
  // On écoute donc son parent, une fois pour toutes : accroché au bouton à
  // chaque rendu, l'écouteur se serait empilé dès lors qu'on cesse de réécrire
  // un fragment inchangé — et un clic aurait lancé dix calculs.
  dom.navSide.addEventListener('click', (event) => {
    if (!event.target.closest('#nav-recompute') || !state.nav?.lastFix) return;
    setPlace('from', {
      label: 'Ma position',
      lon: state.nav.lastFix[0],
      lat: state.nav.lastFix[1],
    });
    stopNavigation();
    // Le guidage reprend de lui-même sur le nouveau trajet : celui qui a
    // demandé le recalcul est en train de marcher, et chercher « Démarrer le
    // guidage » dans un panneau, en plein soleil, est exactement ce qu'on veut
    // lui éviter. Le panneau ne s'ouvre que si le calcul échoue, pour dire
    // pourquoi — et l'ancien trajet, resté dans l'état, n'est pas relancé.
    const previous = state.route;
    computeRoute()
      .then(() => {
        if (state.route && state.route !== previous) startNavigation();
        else setRoutePanel(true);
      })
      .catch(fail);
  });

  dom.navFollow.addEventListener('click', () => {
    if (!state.nav) return;
    state.nav.following = !state.nav.following;
    dom.navFollow.classList.toggle('is-on', state.nav.following);
    dom.navFollow.setAttribute('aria-pressed', String(state.nav.following));
  });
  // Toucher la carte pendant le guidage rend la main : on ne se bat pas
  // avec une caméra qui recentre pendant qu'on essaie de regarder ailleurs.
  map.on('dragstart', () => {
    if (!state.nav?.following) return;
    state.nav.following = false;
    dom.navFollow.classList.remove('is-on');
    dom.navFollow.setAttribute('aria-pressed', 'false');
  });
  dom.alpha.addEventListener('change', () => {
    if (state.route) computeRoute().catch(fail);
  });

  bindPlaceFields();

  for (const button of document.querySelectorAll('.pick')) {
    button.addEventListener('click', () => startPicking(button.dataset.target));
  }

  for (const button of document.querySelectorAll('.locate')) {
    button.addEventListener('click', () => useMyPosition(button.dataset.target));
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeTopmost();
      return;
    }

    // Le test portait sur `document.body`, si bien que les raccourcis
    // s'éteignaient au premier clic sur la carte — celle-ci prend le focus, et
    // c'est justement à ce moment qu'on veut faire défiler l'heure. On n'écarte
    // donc que ce qui attend vraiment ces touches : un champ où l'espace
    // s'écrit, un menu que les flèches déroulent, un bouton que l'espace active.
    if (event.target.closest?.('input, select, textarea, button, [contenteditable]')) return;

    if (event.key === 'ArrowRight') nudge(5);
    else if (event.key === 'ArrowLeft') nudge(-5);
    else if (event.key === ' ') {
      event.preventDefault();
      state.playing ? stopPlaying() : startPlaying();
    }
  });
}

/**
 * Échap referme une seule chose : la plus passagère de celles qui sont ouvertes.
 *
 * L'ordre compte. Enchaîner les fermetures ferait disparaître d'un coup le
 * pointage en cours et le panneau qui l'a demandé, alors qu'on voulait
 * seulement renoncer au pointage. Les listes de suggestions se ferment plus tôt
 * encore, dans le champ lui-même, qui retient la touche.
 */
function closeTopmost() {
  if (state.picking) stopPicking();
  else if (dom.topbar.classList.contains('is-open')) setSettingsOpen(false);
  else if (!dom.offline.hidden) setOfflinePanel(false);
  else if (!dom.route.hidden) setRoutePanel(false);
  else if (!dom.panel.hidden) closeDetailPanel();
}

/**
 * Ouvre ou referme le panneau d'itinéraire, focus compris.
 *
 * Le focus doit quitter le panneau **avant** qu'il ne soit masqué : autrement il
 * retombe sur le corps du document, et l'on repart de zéro dans l'ordre de
 * tabulation — au lieu de retrouver le bouton d'où l'on venait.
 */
function setRoutePanel(open) {
  if (!open && dom.route.contains(document.activeElement)) dom.routeToggle.focus();
  if (open && !dom.offline.hidden) setOfflinePanel(false);

  dom.route.hidden = !open;
  dom.routeToggle.classList.toggle('is-on', open);
  dom.routeToggle.setAttribute('aria-pressed', String(open));

  if (open) dom.from.focus();
  else stopPicking();
}

/**
 * Repli des réglages, sur les écrans où la barre ne les contient pas.
 *
 * Le bouton n'apparaît qu'en dessous de 620 px — c'est la feuille de style qui
 * en décide — mais son comportement est branché partout : au-dessus, il est
 * simplement hors d'atteinte, et les réglages restent dépliés en permanence.
 */
function setSettingsOpen(open) {
  dom.topbar.classList.toggle('is-open', open);
  dom.settingsToggle.classList.toggle('is-on', open);
  dom.settingsToggle.setAttribute('aria-expanded', String(open));
  // Comme pour les panneaux : on ne referme pas sur un focus resté dedans.
  if (!open && dom.controls.contains(document.activeElement)) dom.settingsToggle.focus();
}

function bindSettingsSheet() {
  dom.settingsToggle.addEventListener('click', () =>
    setSettingsOpen(!dom.topbar.classList.contains('is-open')),
  );

  // Un geste ailleurs referme. Sur téléphone le panneau couvre la carte, et le
  // premier réflexe pour s'en débarrasser est de toucher à côté, pas de revenir
  // viser le bouton.
  document.addEventListener('pointerdown', (event) => {
    if (!dom.topbar.classList.contains('is-open')) return;
    if (dom.topbar.contains(event.target)) return;
    setSettingsOpen(false);
  });
}

function nudge(deltaMinutes) {
  const min = Number(dom.time.min);
  const max = Number(dom.time.max);
  state.minutes = Math.max(min, Math.min(max, state.minutes + deltaMinutes));
  dom.time.value = String(state.minutes);
  applyTime();
}

/**
 * Animation continue : le temps avance à chaque image, proportionnellement au
 * temps réel écoulé. On ne saute plus de pas de temps en pas de temps.
 */
function startPlaying() {
  dom.play.textContent = '❚❚';
  const min = Number(dom.time.min);
  const max = Number(dom.time.max);
  const simulatedMinutesPerSecond = 60;
  let last = performance.now();

  const tick = (now) => {
    if (!state.playing) return;
    const advance = ((now - last) / 1000) * simulatedMinutesPerSecond;
    last = now;
    state.minutes += advance;
    if (state.minutes > max) state.minutes = min;
    dom.time.value = String(Math.round(state.minutes));
    applyTime();
    state.playing = requestAnimationFrame(tick);
  };
  state.playing = requestAnimationFrame(tick);
}

function stopPlaying() {
  if (state.playing) cancelAnimationFrame(state.playing);
  state.playing = null;
  dom.play.textContent = '▶';
}

// ------------------------------------------------------------------- outils

/**
 * Récupère le fond de carte nous-mêmes plutôt que de laisser MapLibre le faire.
 *
 * Deux raisons : on maîtrise le délai d'attente, et surtout on peut retomber
 * sur un fond neutre si le CDN est injoignable. Le fond n'est qu'un décor —
 * l'application doit rester utilisable sans lui.
 */
async function loadBasemapStyle() {
  try {
    const response = await fetch(BASEMAP, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn('Fond de carte indisponible, affichage sur fond neutre :', error.message);
    return FALLBACK_BASEMAP;
  }
}

/**
 * Attend que le style soit exploitable, c'est-à-dire que ses couches existent.
 *
 * Surtout pas `isStyleLoaded()` : il n'est vrai qu'une fois toutes les *sources*
 * chargées, ce qui survient après le dernier `styledata`. Le tester dans le
 * gestionnaire d'événement rate donc systématiquement le front, et l'attente ne
 * se termine jamais. `load`, lui, exige une frame peinte : dans un onglet en
 * arrière-plan requestAnimationFrame est gelé et l'attente ne finit pas non plus.
 */
function whenStyleReady(map) {
  if (styleUsable(map)) return Promise.resolve();
  return new Promise((resolve) => {
    // Le gel des frames en arrière-plan ne touche pas que `load` : MapLibre
    // applique aussi la feuille de style dans une frame d'animation, si bien que
    // `styledata` lui-même n'arrive jamais tant que l'onglet n'est pas affiché.
    // Rien n'est cassé et tout reprendra — mais laisser un message de chargement
    // immobile revient à annoncer une panne. On nomme donc l'attente réelle.
    const notice = setTimeout(() => {
      if (document.hidden) dom.loading.textContent = 'En attente de l’affichage de l’onglet…';
    }, 4000);

    const check = () => {
      if (!styleUsable(map)) return;
      map.off('styledata', check);
      clearTimeout(notice);
      resolve();
    };
    map.on('styledata', check);
  });
}

function styleUsable(map) {
  try {
    return (map.getStyle()?.layers?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
