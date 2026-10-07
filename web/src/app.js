/**
 * L'état partagé de l'interface : ce que tous les modules lisent.
 *
 * `main.js` tenait tout dans une seule portée — l'état, les éléments du DOM, la
 * carte — et chaque fonction s'y servait directement. Découpée en modules,
 * l'application a besoin d'un endroit d'où chacun tire la même chose : c'est
 * celui-ci. Il ne dépend d'aucun autre module de l'interface, si bien qu'on
 * peut l'importer de partout sans former de boucle, et que tout ce qu'il
 * déclare est prêt avant que le moindre gestionnaire ne s'exécute.
 *
 * On y trouve les modes de lecture, les éléments du DOM, l'état, l'évaluateur
 * branché sur cet état, la carte et la nappe d'ombres une fois créées, et les
 * quelques outils que plusieurs modules partagent : le graphe et l'index des
 * rues à la demande, la durée des animations, le chargement d'un JSON, l'écran
 * d'échec.
 */
import { ensureNotFallbackPage } from './binary.js';
import { createEvaluator } from './evaluation.js';
import { escapeHtml } from './format.js';
import { indexStreetNames } from './geocode.js';
import { prepareGraph } from './routing.js';

/**
 * Modes de lecture. `max` fixe la valeur qui sature l'échelle de couleur : 11
 * pour l'UV, seuil « extrême » de l'OMS, 100 pour tout le reste.
 *
 * `note` dit en une phrase ce que la couleur mesure. Le menu n'offrait que huit
 * intitulés — « Réverbération », « Scintillement » — sans que rien dans
 * l'interface n'explique de quoi il s'agit : tout était dans le README, c'est-à-
 * dire nulle part pour qui ouvre la carte. Chaque phrase suit le modèle de
 * `pipeline/src/model.js`, dont elle ne fait que rapporter le terme.
 */
export const MODES = {
  index: {
    label: 'Indice global',
    max: 100,
    note: 'Les six composantes réunies et pondérées ; la nuit, l’éclairage public prend le relais.',
  },
  sun: {
    label: 'Soleil direct',
    max: 100,
    note: 'Faisceau direct atteignant le trottoir : nul à l’ombre d’un immeuble, réduit sous les arbres.',
  },
  svf: {
    label: 'Ouverture au ciel',
    max: 100,
    note: 'Portion de ciel visible depuis le trottoir : une rue étroite en montre peu, un quai beaucoup.',
  },
  glare: {
    label: 'Éblouissement',
    max: 100,
    // La convention doit être dite. L'éblouissement dépend du cap de marche —
    // marcher face à un soleil rasant n'a rien à voir avec le parcourir en sens
    // inverse — et une carte ne connaît pas le sens dans lequel on prendra la
    // rue. Elle affiche donc le pire cas, soleil de face, là où le calcul
    // d'itinéraire évalue chaque tronçon dans le sens réellement parcouru. Sans
    // cette phrase, la même rue portait deux chiffres différents selon
    // l'endroit où on la lisait, sans que rien ne l'explique.
    note: 'Soleil assez bas pour arriver dans l’axe du regard, compté de face — l’itinéraire, lui, tient compte de votre sens de marche.',
  },
  flicker: {
    label: 'Scintillement',
    max: 100,
    note: 'Alternance rapide d’ombre et de lumière sous le feuillage ; nulle par ciel couvert.',
  },
  reverb: {
    label: 'Réverbération',
    max: 100,
    note: 'Lumière renvoyée dans les yeux par les façades d’en face et par le sol de la rue.',
  },
  night: {
    label: 'Éclairage nocturne',
    max: 100,
    note: 'Éblouissement des lampadaires, pondéré par la couleur des lampes : le bleu pèse le plus.',
  },
  uv: {
    label: 'Indice UV',
    max: 11,
    note: 'Indice UV au niveau du trottoir : l’ombre en coupe bien moins que la lumière visible.',
  },
};

export const UV_LEGEND = [
  { value: 0, color: '#1a2b4a', label: 'Faible' },
  { value: 3, color: '#4aa3a2', label: 'Modéré' },
  { value: 6, color: '#d9a441', label: 'Fort' },
  { value: 8, color: '#e8663d', label: 'Très fort' },
  { value: 11, color: '#f7e463', label: 'Extrême' },
];

export const dom = Object.fromEntries(
  [
    'loading',
    'zone',
    'mode',
    'side',
    'sky',
    'shadow-toggle',
    'route-toggle',
    'time',
    'clock',
    'sun-info',
    'sky-info',
    'play',
    'legend',
    'panel',
    'panel-close',
    'panel-title',
    'panel-sub',
    'panel-score',
    'panel-advice',
    'panel-chart',
    'panel-stats',
    'route',
    'route-close',
    'from',
    'to',
    'from-suggestions',
    'to-suggestions',
    'alpha',
    'route-go',
    'route-result',
    'sun-ring',
    'dataset-date',
    'pitch-toggle',
    'tiles-toggle',
    'nav',
    'nav-arrow',
    'nav-instruction',
    'nav-side',
    'nav-distance',
    'nav-remaining',
    'nav-exposure',
    'nav-follow',
    'nav-voice',
    'nav-stop',
    'timebar',
    'dim',
    'day',
    'day-field',
    'topbar',
    'controls',
    'settings-toggle',
    'mode-note',
    'offline-toggle',
    'offline',
    'offline-close',
    'offline-estimate',
    'offline-go',
    'offline-result',
  ].map((id) => [id.replace(/-(.)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]),
);

export const state = {
  zones: [],
  meta: null,
  /**
   * Relevés bruts du pipeline, hors des propriétés MapLibre.
   *
   * Deux raisons. D'abord, recolorer via une propriété « data-driven »
   * forcerait MapLibre à re-découper toute la source à chaque cran du curseur ;
   * `feature-state` ne touche pas à la géométrie. Ensuite, l'indice se
   * recompose à l'affichage, avec la météo du moment — il n'a rien à faire
   * figé dans les données.
   */
  /** Vues binaires sur le fichier de zone : attributs, séries, horizon. */
  data: null,
  /**
   * En région, le chargeur par cellules — `state.data` en est alors une façade.
   * Nul sur une zone, qui tient dans un seul fichier.
   */
  region: null,
  /**
   * Nuls tant qu'on ne les a pas demandés : en région, ils dépendent des
   * cellules chargées et se refont à chaque changement. Passer par
   * `currentGraph()` et `currentStreets()`, jamais par le champ.
   */
  graph: null,
  streets: null,
  forecast: null,
  /** Heure affichée, en minutes depuis minuit — continue, pas un indice de pas. */
  minutes: 780,
  mode: 'index',
  sideMode: 'both',
  skyMode: 'forecast',
  selected: null,
  playing: null,
  lastContext: null,
  places: { from: null, to: null },
  picking: null,
  route: null,
  /** Options et extrémités de la dernière recherche — voir `exploreDepartures`. */
  routeOptions: null,
  routeEnds: null,
  nav: null,
  /** Géométrie servie en tuiles, ou chargée d'un bloc. */
  tiled: true,
  pitched: false,
  /** Dernière atténuation appliquée aux trottoirs — voir `applyTime`. */
  dim: null,
  /** Jour de prévision affiché, au format ISO court. */
  day: null,
};

export const {
  sideOf,
  contextAt,
  invalidateContexts,
  evaluateSide,
  displayValue,
  evaluateSegment,
} = createEvaluator({
  getMeta: () => state.meta,
  getData: () => state.data,
  getForecast: () => state.forecast,
  getSkyMode: () => state.skyMode,
  getDay: () => state.day,
  getMode: () => state.mode,
});

/**
 * La carte et la nappe d'ombres, une fois créées par `start`.
 *
 * Exportées en liaisons vives : un module qui lit `map` dans une fonction voit
 * celle que le démarrage a posée, sans qu'il faille la lui passer en paramètre
 * ni l'envelopper dans un objet. Un module ne pouvant réaffecter ce qu'il
 * importe, la pose passe par les deux fonctions qui suivent.
 */
export let map;
export let shadows;

export function setMap(value) {
  map = value;
}

export function setShadows(value) {
  shadows = value;
}

/**
 * Graphe d'itinéraire des cellules chargées, construit à la demande.
 *
 * Une zone a le sien une fois pour toutes. Une région le refait dès que le jeu
 * de cellules change — d'où la construction paresseuse : traverser la carte en
 * chargeant six cellules le reconstruirait six fois si on le faisait à chaque
 * arrivée, pour un graphe dont personne n'a encore eu besoin.
 */
export function currentGraph() {
  if (state.graph) return state.graph;
  if (!state.region) return null;
  const merged = state.region.mergedGraph();
  if (!merged) return null;
  state.graph = prepareGraph({ ...state.data, graph: merged });
  return state.graph;
}

export function currentStreets() {
  if (state.streets) return state.streets;
  const graph = currentGraph();
  if (!graph) return [];
  state.streets = indexStreetNames(state.data, graph);
  return state.streets;
}

/**
 * Animations de caméra, ou pas.
 *
 * La feuille de style respecte déjà `prefers-reduced-motion`, mais elle ne peut
 * rien sur MapLibre : les déplacements de caméra sont pilotés en JavaScript, et
 * c'est justement le mouvement le plus présent de l'application — pendant le
 * guidage, la carte glisse à chaque point GPS, soit une fois par seconde,
 * pendant toute la marche. Chez un public migraineux, c'est exactement ce qu'on
 * désactive.
 *
 * On ne supprime donc pas le recentrage, qui porte une information, mais sa
 * durée : la caméra saute au lieu de glisser.
 */
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? { matches: false };

export function motionDuration(milliseconds) {
  return reducedMotion.matches ? 0 : milliseconds;
}

export async function loadJSON(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} introuvable (HTTP ${response.status}).`);
  ensureNotFallbackPage(response, path);
  return response.json();
}

/**
 * Écran d'échec.
 *
 * Le conseil « lancez d'abord le calcul » était donné pour n'importe quelle
 * panne — y compris pour un stockage local refusé ou une coupure de réseau,
 * c'est-à-dire précisément les cas où les données étaient là et où il envoyait
 * chercher au mauvais endroit. On ne le donne donc que lorsque ce sont bien les
 * fichiers de zone qui manquent, et on dit la vraie cause dans les autres cas.
 */
export function fail(error) {
  console.error(error);
  dom.loading.classList.remove('is-hidden');
  dom.loading.classList.add('is-error');

  const missingData = /introuvable|Aucune zone calculée|signature|Format de zone/i.test(
    error.message,
  );
  const advice = missingData
    ? 'Calculez d’abord une zone : <code>npm run data</code>'
    : navigator.onLine
      ? 'Rien ne manque a priori du côté des données. Réessayez.'
      : 'Vous semblez hors connexion.';

  dom.loading.innerHTML = `
    <div class="error-box">
      <p>${escapeHtml(error.message)}</p>
      <p class="muted">${advice}</p>
      <button id="retry" class="ghost" type="button">Réessayer</button>
    </div>`;
  document.getElementById('retry').addEventListener('click', () => location.reload());
}
