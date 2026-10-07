/**
 * Le guidage pas à pas, une fois l'itinéraire calculé.
 *
 * Ce module suit la position réelle, la recale sur le tracé, fait avancer
 * l'heure de la carte avec l'heure réelle, et dit la consigne suivante — à
 * l'écran, à voix haute, au vibreur. Il garde aussi l'écran allumé tant que le
 * guidage dure.
 *
 * Les règles qui s'éprouvent sans capteur — recalage, progression, consignes —
 * vivent dans `navigation.js` ; ici, on les branche sur le GPS, la carte et le
 * DOM.
 */
import { dom, evaluateSegment, map, motionDuration, state } from './app.js';
import { emptyCollection, formatMeters, haversineMeters, setHTML, setText } from './format.js';
import { applyTime } from './layers.js';
import {
  OFF_ROUTE_METERS,
  advanceProgress,
  bearingBetween,
  buildInstructions,
  describeManoeuvre,
  nextManoeuvre,
  snapToRoute,
} from './navigation.js';
import { colorFor } from './panel.js';
import { rememberRouteInUrl } from './route.js';
import { transitions } from './routing.js';
import { geolocationMessage } from './search.js';
import { createVoice, phraseFor } from './speech.js';
import { levelLabel } from '@svet/pipeline/model';
import { localMinutes } from '@svet/pipeline/sun';

export const voice = createVoice();

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
export function startNavigation() {
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

export function stopNavigation() {
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
