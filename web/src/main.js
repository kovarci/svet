import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { createShadowLayer } from './shadows.js';
import { CLEAR_SKY, fetchForecast, skyLabel } from './weather.js';
import {
  prepareGraph,
  findRoute,
  nearestNode,
  summarize,
  transitions,
  SearchAborted,
} from './routing.js';
import { ensureNotFallbackPage, loadZoneData } from './binary.js';
import { createRegionData, loadRegionIndex } from './cells.js';
import {
  indexStreetNames,
  mergeSuggestions,
  searchAddresses,
  searchLocal,
  searchRemote,
} from './geocode.js';
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
  OFF_ROUTE_METERS,
  advanceProgress,
  bearingBetween,
  buildInstructions,
  describeManoeuvre,
  nextManoeuvre,
  snapToRoute,
} from './navigation.js';
import {
  components,
  discomfortIndex,
  localUV,
  levelLabel,
  skyConditions,
  uvLabel,
  wetnessFromRain,
} from '@svet/pipeline/model';
import { applyRefraction, localToUTC, sunPosition, DEG } from '@svet/pipeline/sun';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/** Fond minimal si le fond de carte distant est injoignable — l'appli reste utilisable. */
const FALLBACK_BASEMAP = {
  version: 8,
  sources: {},
  layers: [{ id: 'fond', type: 'background', paint: { 'background-color': '#0b0f16' } }],
};

const PARIS_LAT = 48.8566;
const PARIS_LON = 2.3522;

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
const MODES = {
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

const UV_LEGEND = [
  { value: 0, color: '#1a2b4a', label: 'Faible' },
  { value: 3, color: '#4aa3a2', label: 'Modéré' },
  { value: 6, color: '#d9a441', label: 'Fort' },
  { value: 8, color: '#e8663d', label: 'Très fort' },
  { value: 11, color: '#f7e463', label: 'Extrême' },
];

const dom = Object.fromEntries(
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

const state = {
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

/**
 * Réglages retenus d'une visite à l'autre.
 *
 * Tout passe par ce guichet, et tout y est enveloppé d'un `try`. Ce n'est pas
 * de la prudence de principe : en navigation privée Safari, et sous une
 * politique qui bloque les cookies du site, la simple lecture de
 * `localStorage` lève une `SecurityError`. Elle survenait au démarrage, faisait
 * échouer l'initialisation entière, et l'application affichait « lancez d'abord
 * le calcul » — un conseil parfaitement inutile pour quelqu'un dont les données
 * étaient là.
 *
 * Ce qu'on retient est ce qui relève de la personne plutôt que du moment : la
 * pénombre dont elle a besoin, sa zone, sa façon de lire la carte. Pas l'heure
 * ni le trajet, qui appartiennent à la fois où on les a choisis.
 */
const PREFS_KEY = 'svet.prefs';

const prefs = {
  read() {
    try {
      const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
      // Reprise de l'ancien réglage isolé, écrit par les versions précédentes.
      if (stored.dim === undefined) {
        const legacy = Number(localStorage.getItem('svet.dim'));
        if (Number.isFinite(legacy) && legacy > 0) stored.dim = legacy;
      }
      return stored;
    } catch {
      return {};
    }
  },
  write(patch) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs.read(), ...patch }));
    } catch {
      // Navigation privée, quota plein, stockage refusé : le réglage ne
      // survivra pas à cette visite. C'est tout ce qu'on perd.
    }
  },
};

let map;
let shadows;
const voice = createVoice();

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

function motionDuration(milliseconds) {
  return reducedMotion.matches ? 0 : milliseconds;
}

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

  map = new maplibregl.Map({
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
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  shadows = createShadowLayer(map, document.getElementById('shadows'), buildingsForShadows);

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
  dom.loading.classList.remove('is-hidden');
  dom.loading.classList.remove('is-error');
  dom.loading.textContent = 'Chargement des données…';

  const entry = state.zones.find((z) => z.key === key);
  if (entry?.kind === 'region') return loadRegion(entry);

  // L'horodatage du calcul en paramètre d'URL : c'est lui qui fait qu'une
  // reconstruction du pipeline invalide le cache hors ligne, plutôt que de
  // rester invisible derrière des fichiers de même nom.
  const stamp = state.zones.find((z) => z.key === key)?.stamp ?? '';
  const version = stamp ? `?v=${stamp}` : '';
  lastProgress = -1;
  const token = ++loadToken;
  const [meta, data] = await Promise.all([
    loadJSON(`data/${key}.meta.json${version}`),
    loadZoneData(`data/${key}.data.bin${version}`, (received, total) =>
      reportProgress(token, received, total),
    ),
  ]);
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
async function loadRegion(entry) {
  const version = entry.stamp ? `?v=${entry.stamp}` : '';
  const index = await loadRegionIndex(`data/${entry.region}/index.json${version}`);

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
  map.getSource('route')?.setData(emptyCollection());
  map.getSource('markers')?.setData(emptyCollection());
  map.getSource('me')?.setData(emptyCollection());
  if (!location.hash) map.fitBounds(index.bbox, { padding: 40, duration: 0 });

  dom.loading.textContent = 'Chargement des relevés du secteur…';
  await ensureVisibleCells();

  applyTime();
  dom.loading.classList.add('is-hidden');
  loadForecast(index);
}

/**
 * Graphe d'itinéraire des cellules chargées, construit à la demande.
 *
 * Une zone a le sien une fois pour toutes. Une région le refait dès que le jeu
 * de cellules change — d'où la construction paresseuse : traverser la carte en
 * chargeant six cellules le reconstruirait six fois si on le faisait à chaque
 * arrivée, pour un graphe dont personne n'a encore eu besoin.
 */
function currentGraph() {
  if (state.graph) return state.graph;
  if (!state.region) return null;
  const merged = state.region.mergedGraph();
  if (!merged) return null;
  state.graph = prepareGraph({ ...state.data, graph: merged });
  return state.graph;
}

function currentStreets() {
  if (state.streets) return state.streets;
  const graph = currentGraph();
  if (!graph) return [];
  state.streets = indexStreetNames(state.data, graph);
  return state.streets;
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
    const today = new Date().toISOString().slice(0, 10);
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

  const today = new Date().toISOString().slice(0, 10);
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
 * Relevés d'un trottoir : les vues binaires, plus les attributs du tronçon.
 *
 * Rien n'est copié — `sun`, `flicker` et `horizon` sont des fenêtres sur le
 * tampon reçu. Sur Paris entier, les matérialiser en objets ferait quarante
 * millions d'allocations.
 */
function sideOf(id, right) {
  const segment = state.data.segmentAt(id);
  const series = state.data.sideAt(id, right);
  // En région, la géométrie arrive en tuiles et les relevés par cellules : une
  // rue peut être dessinée avant que son binaire soit là. On rend `null` plutôt
  // qu'un relevé à zéro, qui se lirait « aucune gêne » — le mensonge exact
  // qu'il ne faut pas faire à quelqu'un qui choisit son trajet.
  if (!segment || !series) return null;
  return {
    ...series,
    side: right ? segment.rSide : segment.lSide,
    svf: right ? segment.rSvf : segment.lSvf,
    canopy: right ? segment.rCanopy : segment.lCanopy,
    veil: right ? segment.rVeil : segment.lVeil,
    work: right ? segment.rWork : segment.lWork,
  };
}

/**
 * Toutes les couches que `addLayers` crée.
 *
 * La liste doit rester exhaustive : basculer entre tuiles et zone entière les
 * recrée, et MapLibre signale une erreur pour chaque couche déjà présente. Les
 * couches d'itinéraire et de position n'ont pourtant rien à voir avec le mode
 * de chargement — mais leur ordre, lui, en dépend : elles doivent repasser
 * au-dessus des volumes bâtis.
 */
const NETWORK_LAYERS = [
  'buildings-3d',
  'network-overview',
  'network-left',
  'network-right',
  'network-selected',
  'route-halo',
  'route-line',
  'me-accuracy',
  'me',
  'markers',
];

function removeNetworkLayers() {
  for (const id of NETWORK_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('network')) map.removeSource('network');
  if (map.getSource('buildings')) map.removeSource('buildings');
}

/** Où trouver les emprises bâties, selon le mode de chargement. */
function buildingSource() {
  return state.tiled
    ? { source: 'network', sourceLayer: 'bati' }
    : { source: 'buildings', sourceLayer: undefined };
}

/**
 * Emprises à donner à la couche d'ombres.
 *
 * En mode tuilé on interroge la carte : la couche `bati` voyage avec le réseau,
 * donc ses tuiles sont chargées de toute façon. En mode « tout chargé » on
 * passe le GeoJSON directement — MapLibre ne garde les entités interrogeables
 * d'une source que si une couche la dessine, et nos volumes sont masqués tant
 * que la carte est à plat.
 */
function buildingsForShadows() {
  return state.tiled ? { source: 'network', sourceLayer: 'bati' } : { features: state.buildings };
}

/**
 * Gabarit d'URL de la pyramide courante, version comprise.
 *
 * Absolu : MapLibre l'exige, et le pré-chargement hors ligne doit demander
 * exactement les mêmes URLs que la carte, sans quoi il remplirait le cache de
 * clés que personne ne relira jamais.
 */
function tileTemplate() {
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  // Une région n'a pas de version « tout chargé » : c'est précisément ce qu'on
  // ne peut pas faire à cette taille. Sa pyramide est commune à ses cellules.
  const path = state.region
    ? `data/${state.meta.region}/tuiles/{z}/{x}/{y}.pbf`
    : `data/${state.zoneKey}/{z}/{x}/{y}.pbf`;
  return `${base}${path}${state.version}`;
}

async function addLayers() {
  const { minZoom, maxZoom, bounds } = state.meta.tiles ?? { minZoom: 11, maxZoom: 16 };

  if (state.tiled || state.region) {
    state.buildings = null;
    map.addSource('network', {
      type: 'vector',
      tiles: [tileTemplate()],
      minzoom: minZoom,
      maxzoom: maxZoom,
      // L'emprise de la zone. Sans elle, dès qu'on longe le bord, MapLibre
      // réclame des tuiles qui n'ont jamais été calculées ; un serveur
      // d'application à page unique répond `index.html` avec un code 200, et le
      // décodeur protobuf s'étrangle sur du HTML.
      ...(bounds ? { bounds } : {}),
      // Sans cela, `feature-state` ne saurait pas à quoi rattacher ses valeurs :
      // les tuiles vectorielles n'ont pas d'identifiant d'entité par défaut.
      promoteId: { reseau: 'id' },
    });
    // Sous le zoom minimal des tuiles, une source vectorielle ne demande plus
    // rien et la carte se vide. On empêche simplement d'y descendre.
    map.setMinZoom(minZoom);
  } else {
    const [geometry, buildings] = await Promise.all([
      loadJSON(`data/${state.zoneKey}.geometry.json${state.version}`),
      loadJSON(`data/${state.zoneKey}.buildings.json${state.version}`),
    ]);
    map.addSource('network', { type: 'geojson', data: geometry, promoteId: 'id' });
    map.addSource('buildings', { type: 'geojson', data: buildings });
    state.buildings = buildings.features;
    map.setMinZoom(0);
  }

  if (!map.getSource('route')) {
    map.addSource('route', { type: 'geojson', data: emptyCollection() });
    map.addSource('markers', { type: 'geojson', data: emptyCollection() });
    map.addSource('me', { type: 'geojson', data: emptyCollection() });
  }

  for (const side of ['left', 'right']) {
    map.addLayer({
      id: `network-${side}`,
      type: 'line',
      source: 'network',
      ...(state.tiled ? { 'source-layer': 'reseau' } : {}),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colorExpression(side === 'left' ? 'l' : 'r'),
        'line-width': widthExpression(0),
        'line-offset': offsetExpression(side),
      },
    });
  }

  // Aperçu à faible zoom : un réseau neutre, sans prétendre à une lecture.
  map.addLayer({
    id: 'network-overview',
    type: 'line',
    source: 'network',
    ...(state.tiled ? { 'source-layer': 'reseau' } : {}),
    maxzoom: READABLE_ZOOM + 0.5,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#3d5570',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 13.5, 1.6],
      'line-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        READABLE_ZOOM,
        0.9,
        READABLE_ZOOM + 0.5,
        0,
      ],
    },
  });

  map.addLayer({
    id: 'network-selected',
    type: 'line',
    source: 'network',
    ...(state.tiled ? { 'source-layer': 'reseau' } : {}),
    filter: ['==', ['get', 'id'], -1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': widthExpression(5), 'line-opacity': 0.75 },
  });

  // Volumes bâtis, après les rues : c'est l'ordre des couches qui décide de
  // l'occultation. Placés avant, les immeubles laissaient passer les tracés de
  // rue par-dessus leurs toits — une rue derrière un immeuble restait visible.
  const { source: batiSource, sourceLayer: batiLayer } = buildingSource();
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: batiSource,
    ...(batiLayer ? { 'source-layer': batiLayer } : {}),
    minzoom: 14,
    layout: { visibility: state.pitched ? 'visible' : 'none' },
    paint: {
      'fill-extrusion-color': [
        // Une teinte qui monte avec la hauteur : sans elle, une ville de gris
        // uniforme ne laisse rien deviner du relief bâti.
        //
        // Volontairement sombre. En vue inclinée le bâti couvre presque tout
        // l'écran ; une ville en gris clair ferait de l'application une source
        // de lumière, ce qu'on demande précisément à ce public d'éviter. Le
        // relief vient du contraste entre les faces, pas de la clarté générale.
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'h'], 12],
        6,
        '#242b36',
        20,
        '#333d4c',
        45,
        '#4a566b',
      ],
      'fill-extrusion-height': ['coalesce', ['get', 'h'], 12],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.95,
    },
  });

  map.addLayer({
    id: 'route-halo',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#05070c', 'line-width': widthExpression(9), 'line-opacity': 0.85 },
  });

  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#e9edf5', 'line-width': widthExpression(4), 'line-opacity': 0.95 },
  });

  // Position réelle : un halo de précision, puis le point lui-même.
  map.addLayer({
    id: 'me-accuracy',
    type: 'circle',
    source: 'me',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 8, 19, 26],
      'circle-color': '#4aa3a2',
      'circle-opacity': 0.16,
    },
  });

  map.addLayer({
    id: 'me',
    type: 'circle',
    source: 'me',
    paint: {
      'circle-radius': 7,
      'circle-color': '#4aa3a2',
      'circle-stroke-color': '#e9edf5',
      'circle-stroke-width': 2.5,
    },
  });

  map.addLayer({
    id: 'markers',
    type: 'circle',
    source: 'markers',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'kind'], 'from', '#4aa3a2', '#e8663d'],
      'circle-stroke-color': '#0b0f16',
      'circle-stroke-width': 2.5,
    },
  });

  map.on('click', (event) => {
    if (state.picking) {
      setPlace(state.picking, {
        label: `${event.lngLat.lat.toFixed(5)}, ${event.lngLat.lng.toFixed(5)}`,
        lon: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
      stopPicking();
      return;
    }
    const hit = segmentNear(event.point);
    if (hit) selectSegment(hit);
  });

  // L'anneau désigne une direction à l'écran : il doit suivre la rotation.
  map.on('rotate', () => {
    if (state.lastContext) renderSunRing(state.lastContext);
  });

  map.on('mousemove', (event) => {
    if (state.picking) return;
    map.getCanvas().style.cursor = segmentNear(event.point) ? 'pointer' : '';
  });

  // De nouvelles tuiles arrivent sans état d'entité : il faut les peindre. On
  // attend `idle` plutôt que `move`, sans quoi on repeindrait à chaque image
  // pendant un déplacement.
  // Repeindre à l'arrêt seulement laissait des tronçons gris pendant un
  // déplacement : les tuiles arrivent en cours de route, et une entité sans
  // état prend la couleur du zéro. On peint donc aussi à chaque tuile reçue.
  map.on('sourcedata', (event) => {
    if (event.sourceId !== 'network' || !event.isSourceLoaded) return;
    if (state.lastContext) paintVisible(state.lastContext);
    shadows.refresh();
  });

  map.on('idle', () => {
    if (state.lastContext) paintVisible(state.lastContext);
    shadows.refresh();
  });

  // En région, les relevés arrivent par cellules : la carte peut afficher des
  // rues avant qu'on sache quoi que ce soit d'elles. On demande donc les
  // cellules du champ à chaque arrêt du déplacement — jamais pendant, où le
  // moindre chargement ferait saccader la carte.
  map.on('moveend', () => {
    ensureVisibleCells();
  });
}

/**
 * Charge les relevés des cellules visibles.
 *
 * Bornée au zoom lisible : au-dessus de la région entière, on verrait vingt
 * cellules d'un coup, soit deux cents mégaoctets, pour une échelle où aucune
 * couleur de trottoir n'est distinguable. L'aperçu régional suffit.
 */
function ensureVisibleCells() {
  if (!state.region || map.getZoom() < READABLE_ZOOM - 1) return Promise.resolve();
  const bounds = map.getBounds();
  return state.region
    .ensure({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    })
    .catch((error) => console.warn('Cellules indisponibles :', error.message));
}

function widthExpression(extra) {
  return [
    'interpolate',
    ['exponential', 1.6],
    ['zoom'],
    12,
    0.8 + extra * 0.2,
    15,
    2 + extra * 0.4,
    17,
    4.5 + extra * 0.8,
    19,
    9 + extra * 1.4,
  ];
}

/**
 * Déport du tracé, en pixels, pour dessiner les deux trottoirs de part et
 * d'autre de l'axe. Un mètre vaut 2^zoom / 102 900 pixels à la latitude de
 * Paris ; en dessous du zoom 15 le déport passe sous le pixel et les deux
 * traits se confondent, ce qui est exactement le comportement voulu.
 */
function offsetExpression(side) {
  if (state.sideMode !== 'both') return 0;
  const sign = side === 'left' ? -1 : 1;
  const property = side === 'left' ? 'lOff' : 'rOff';
  const perMeter = (zoom) => (sign * Math.pow(2, zoom)) / 102900;
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    13,
    ['*', ['get', property], perMeter(13)],
    19,
    ['*', ['get', property], perMeter(19)],
  ];
}

function colorExpression(key) {
  const stops = (
    state.mode === 'uv'
      ? UV_LEGEND.map((s) => ({ ...s, value: (s.value / 11) * 100 }))
      : state.meta.scale
  ).flatMap((s) => [s.value, s.color]);
  return ['interpolate', ['linear'], ['coalesce', ['feature-state', key], 0], ...stops];
}

// -------------------------------------------------- temps continu et calcul

/**
 * Position du soleil à l'instant exact demandé.
 *
 * Le pipeline échantillonne toutes les demi-heures, mais rien n'oblige
 * l'affichage à s'y tenir : la position du soleil est une formule, pas une
 * donnée. Le voile de lumière tourne donc de façon parfaitement continue,
 * sans les à-coups qu'on voyait en sautant de 10 h 30 à 11 h.
 */
function sunAt(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes - hour * 60;
  const instant = localToUTC(state.meta.date, hour, minute);
  const raw = sunPosition(instant, PARIS_LAT, PARIS_LON);
  return { altitude: applyRefraction(raw.altitude), azimuth: raw.azimuth };
}

/** Position dans la série précalculée, et poids d'interpolation entre deux pas. */
function seriesCursor(minutes) {
  const times = state.meta.times;
  const first = times[0].minutes;
  const stepMinutes = times[1].minutes - first;
  const raw = (minutes - first) / stepMinutes;
  const i = Math.max(0, Math.min(times.length - 1, Math.floor(raw)));
  const j = Math.min(times.length - 1, i + 1);
  return { i, j, t: Math.max(0, Math.min(1, raw - i)) };
}

/**
 * Transmission et scintillement à un instant quelconque, interpolés entre les
 * deux pas de temps qui l'encadrent.
 */
function sampleSide(entry, cursor) {
  const { i, j, t } = cursor;
  return {
    transmission: (entry.sun[i] + (entry.sun[j] - entry.sun[i]) * t) / 100,
    flicker: (entry.flicker[i] + (entry.flicker[j] - entry.flicker[i]) * t) / 100,
  };
}

/**
 * Prévision du jour sélectionné, ou `null` s'il n'y en a pas.
 *
 * Seule la **météo** change d'un jour à l'autre : les séries d'ombrage restent
 * celles de la date du calcul. Sur trois jours la dérive solaire vaut moins de
 * 3 % de longueur d'ombre, sous l'incertitude sur la hauteur des bâtiments —
 * c'est ce qui borne l'horizon proposé.
 */
function forecastSeries() {
  if (state.skyMode !== 'forecast' || !state.forecast) return null;
  return state.forecast.series[state.day] ?? state.forecast.series[state.forecast.dates[0]] ?? null;
}

function weatherAt(minutes) {
  const series = forecastSeries();
  if (!series) return CLEAR_SKY;
  const { i, j, t } = seriesCursor(minutes);
  const a = series[i] ?? CLEAR_SKY;
  const b = series[j] ?? a;
  const mix = (x, y) => x + (y - x) * t;

  return {
    cloud: mix(a.cloud, b.cloud),
    uv: mix(a.uv, b.uv),
    rain: mix(a.rain ?? 0, b.rain ?? 0),
    // Les flux modélisés doivent traverser cette interpolation comme le reste :
    // les oublier ici ferait silencieusement retomber tout le modèle sur la
    // déduction par nébulosité, celle qui se trompe de 27 klx.
    irradiance: a.irradiance
      ? {
          beam: mix(a.irradiance.beam, b.irradiance?.beam ?? a.irradiance.beam),
          diffuse: mix(a.irradiance.diffuse, b.irradiance?.diffuse ?? a.irradiance.diffuse),
        }
      : null,
    source: 'météo',
  };
}

/**
 * Contexte de calcul pour un instant : tout ce qui ne dépend pas du lieu.
 *
 * Mémorisé à la minute près, et ce n'est pas une micro-optimisation : le calcul
 * d'itinéraire évalue des dizaines de milliers d'arêtes, et la conversion en
 * heure locale passe par `Intl.DateTimeFormat`, qui coûte des microsecondes.
 * Sans ce cache, une recherche prendrait plusieurs secondes.
 */
const contextCache = new Map();

function contextAt(minutes) {
  const key = Math.round(minutes);
  const cached = contextCache.get(key);
  if (cached) return cached;

  const sun = sunAt(key);
  const weather = weatherAt(key);
  const context = {
    minutes: key,
    sun,
    weather,
    // L'azimut construit la distribution de luminance du ciel : sans lui, le
    // modèle retombe sur un ciel uniforme. Elle est bâtie une fois par minute,
    // ici, et non une fois par trottoir — c'est ce qui la rend gratuite.
    // Le dernier argument doit suivre le nombre de secteurs du profil d'horizon
    // stocké : un décalage ferait retomber le modèle sur un ciel isotrope, sans
    // erreur ni message.
    sky: skyConditions(
      sun.altitude,
      weather.cloud,
      weather.irradiance,
      sun.azimuth,
      state.meta.horizonBins ?? 16,
    ),
  };
  contextCache.set(key, context);
  return context;
}

/** À appeler dès qu'un ingrédient du contexte change : date, météo, zone. */
function invalidateContexts() {
  contextCache.clear();
}

function evaluateSide(entry, context, heading) {
  const cursor = seriesCursor(context.minutes);
  const { transmission, flicker } = sampleSide(entry, cursor);
  const svf = entry.svf / 100;
  const c = components({
    transmission,
    svf,
    altitude: context.sun.altitude,
    azimuth: context.sun.azimuth,
    heading,
    horizon: entry.horizon,
    flicker,
    albedo: state.meta.albedo,
    // Absent des jeux calculés avant l'ajout du terme de sol : le modèle
    // retombe alors sur sa valeur par défaut, sans recalcul nécessaire.
    groundAlbedo: state.meta.groundAlbedo,
    // Chaussée mouillée : elle renvoie le soleil bas en miroir.
    wet: wetnessFromRain(context.weather.rain),
    luxReference: state.meta.luxReference,
    veil: entry.veil,
    sky: context.sky,
  });
  return {
    ...c,
    transmission,
    svf,
    index: discomfortIndex(c, state.meta.weights),
    // Le partage direct/diffus de l'UV dépend de la hauteur du soleil et de la
    // couverture : à 10° de hauteur, l'essentiel de l'UV est déjà diffusé, et un
    // immeuble n'en protège presque plus.
    uv: localUV(
      context.weather.uv ?? uvFallback(context.sun.altitude),
      transmission,
      svf,
      context.sun.altitude * DEG,
      context.sky.directShare,
    ),
    side: entry.side,
    canopy: entry.canopy,
    // Part du trottoir barrée par un chantier. Elle ne rentre pas dans
    // l'indice — un trottoir barré n'est pas plus lumineux, il est
    // impraticable — mais elle pèse sur l'itinéraire et s'affiche au clic.
    work: entry.work ?? 0,
  };
}

/** Valeur cartographiée pour un trottoir, selon le mode de lecture. */
function displayValue(evaluated) {
  switch (state.mode) {
    case 'sun':
      return evaluated.sun * 100;
    case 'svf':
      return evaluated.svf * 100;
    case 'glare':
      return evaluated.glare * 100;
    case 'flicker':
      return evaluated.flicker * 100;
    case 'reverb':
      return evaluated.reverb * 100;
    // L'éblouissement des lampadaires se lit à toute heure, indépendamment de
    // la part qu'il occupe dans l'indice : c'est une propriété du lieu, et on
    // veut pouvoir la consulter en plein jour pour préparer un trajet du soir.
    case 'night':
      return evaluated.night * 100;
    case 'uv':
      return evaluated.uv;
    default:
      return evaluated.index;
  }
}

/**
 * Indice UV approché quand aucune prévision n'est disponible : il suit de près
 * le sinus de la hauteur du soleil, avec un maximum d'environ 8 à Paris en été.
 */
function uvFallback(altitude) {
  if (altitude <= 0) return 0;
  return 8.5 * Math.pow(Math.sin(altitude), 1.4);
}

function applyTime() {
  const context = contextAt(state.minutes);
  const altitudeDeg = context.sun.altitude * DEG;
  const night = altitudeDeg <= 0;

  dom.clock.textContent = formatClock(state.minutes);
  dom.sunInfo.textContent = night
    ? 'nuit — soleil sous l’horizon'
    : `soleil ${altitudeDeg.toFixed(0)}° · azimut ${(context.sun.azimuth * DEG).toFixed(0)}°`;
  dom.skyInfo.textContent =
    context.weather === CLEAR_SKY
      ? 'ciel clair (référence)'
      : `${skyLabel(context.weather.cloud)} · UV ${(context.weather.uv ?? 0).toFixed(1)}` +
        // On distingue les flux réellement modélisés d'une déduction : sous un
        // ciel annoncé couvert, il reste souvent beaucoup de soleil direct.
        (context.sky.measured
          ? ` · ${(context.sky.directNormal / 1000).toFixed(0)} klx directs (mesuré)`
          : '');

  paintVisible(context, true);

  // L'atténuation nocturne ne prend que deux valeurs, jour et nuit, mais le
  // curseur horaire appelle cette fonction à chaque minute. Réécrire une
  // propriété de peinture invalide le style et fait réévaluer les tuiles ; on
  // ne touche donc à la couche que lorsque la valeur change vraiment.
  //
  // Le gain n'a pas pu être chiffré : l'onglet piloté rend une image toutes les
  // quatre secondes même au repos, ce qui noie toute mesure par image. Le
  // travail synchrone, lui, reste sous les 20 ms dans les deux cas.
  const dim = night && state.mode !== 'svf' ? 0.4 : 1;
  if (dim !== state.dim) {
    state.dim = dim;
    for (const layer of ['network-left', 'network-right']) {
      map.setPaintProperty(layer, 'line-opacity', [
        'interpolate',
        ['linear'],
        ['zoom'],
        READABLE_ZOOM,
        0,
        READABLE_ZOOM + 0.5,
        dim,
      ]);
    }
  }

  shadows.setSun({ ...context.sun, cloud: context.weather.cloud });
  state.lastContext = context;
  renderSunRing(context);
  applySunLight(context);

  renderLegend();
  if (state.selected) renderPanel(state.selected);
}

/**
 * Halo périphérique indiquant d'où vient le soleil, relativement à la carte.
 *
 * L'information manquait : on voyait bien les rues éclairées, sans savoir de
 * quel côté lever les yeux. Soleil à l'ouest, bord gauche brillant.
 *
 * La couleur suit la hauteur du soleil — orange rasant à l'horizon, blanc franc
 * au zénith — parce que c'est justement un soleil bas qui arrive dans l'axe du
 * regard et qui gêne le plus.
 */
function renderSunRing(context) {
  const style = dom.sunRing.style;
  const altitudeDeg = context.sun.altitude * DEG;

  if (altitudeDeg <= 0) {
    style.setProperty('--sun-strength', '0');
    return;
  }

  // L'anneau tourne avec la carte : c'est une direction à l'écran, pas au sol.
  const angle = (context.sun.azimuth * DEG - map.getBearing() + 360) % 360;
  const warmth = Math.max(0, Math.min(1, altitudeDeg / 45));
  const red = 255;
  const green = Math.round(138 + 112 * warmth);
  const blue = Math.round(43 + 197 * warmth);

  // Bien visible dès que le soleil se lève : c'est au ras de l'horizon qu'il
  // gêne le plus. Les nuages le diluent — sous une couche épaisse, la lumière
  // n'a plus vraiment de direction — mais sans le faire disparaître : par ciel
  // couvert on veut encore savoir où il est.
  const strength = Math.min(1, altitudeDeg / 3) * (1 - 0.55 * (context.weather.cloud ?? 0));

  style.setProperty('--sun-angle', `${angle.toFixed(1)}deg`);
  style.setProperty('--sun-core', `rgba(${red}, ${green}, ${blue}, 1)`);
  style.setProperty('--sun-mid', `rgba(${red}, ${green}, ${blue}, 0.5)`);
  style.setProperty('--sun-far', `rgba(${red}, ${green}, ${blue}, 0.14)`);
  style.setProperty('--sun-strength', strength.toFixed(3));
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
  const today = new Date().toISOString().slice(0, 10);
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

/**
 * Bascule en vue inclinée.
 *
 * La nappe de lumière est retirée tant que la carte est penchée : sa
 * transformation Mercator → écran est affine, ce qui n'est exact qu'à plat. Les
 * volumes prennent le relais, éclairés depuis la position réelle du soleil.
 */
function setPitched(pitched) {
  state.pitched = pitched;
  dom.pitchToggle.classList.toggle('is-on', pitched);
  dom.pitchToggle.setAttribute('aria-pressed', String(pitched));

  map.setMaxPitch(pitched ? 68 : 0);
  map.easeTo({ pitch: pitched ? 55 : 0, duration: motionDuration(700) });
  if (map.getLayer('buildings-3d')) {
    map.setLayoutProperty('buildings-3d', 'visibility', pitched ? 'visible' : 'none');
  }
  shadows.setEnabled(!pitched && dom.shadowToggle.classList.contains('is-on'));
  dom.shadowToggle.disabled = pitched;
  // En repassant au relief, l'éclairage doit être réappliqué même si le soleil
  // n'a pas bougé : MapLibre l'a peut-être perdu entre-temps.
  lastLight = null;
  if (state.lastContext) applySunLight(state.lastContext);
}

/**
 * Oriente l'éclairage des volumes sur le soleil réel.
 *
 * MapLibre attend l'azimut en degrés depuis le nord, sens horaire, et l'angle
 * polaire depuis la verticale : c'est exactement ce que donne la position
 * solaire, au complément près. Les façades s'éclairent donc du bon côté, et
 * l'ombre propre des volumes tourne avec l'heure.
 */
/**
 * Dernier éclairage appliqué, arrondi au degré. Voir `applySunLight`.
 * @type {string|null}
 */
let lastLight = null;

function applySunLight(context) {
  if (!state.pitched) return;
  const altitude = context.sun.altitude * DEG;
  const azimuth = context.sun.azimuth * DEG;

  // Changer l'éclairage fait recalculer l'ombrage de **tous** les volumes
  // affichés — 7 400 à l'écran en vue inclinée. Mesuré : 109 à 174 ms par cran
  // du curseur horaire en relief, contre 13 à 33 ms à plat. C'est un blocage
  // visible, et sur un téléphone il serait bien pire.
  //
  // Or le soleil se déplace d'un quart de degré par minute : entre deux crans,
  // l'ombrage des façades ne change d'aucun pixel. On arrondit donc au degré et
  // on ne réécrit que si la position a réellement bougé — soit une fois toutes
  // les quatre minutes de curseur au lieu de chaque minute.
  const signature = `${Math.round(azimuth)}:${Math.round(altitude)}`;
  if (signature === lastLight) return;
  lastLight = signature;

  map.setLight({
    anchor: 'map',
    position: [1.15, azimuth, Math.max(5, 90 - altitude)],
    color: altitude > 0 ? '#fff3dd' : '#8fa0c0',
    // L'intensité creuse l'écart entre la façade au soleil et celle à l'ombre :
    // c'est ce contraste qui donne le relief, plus que la clarté d'ensemble.
    // Au-delà, les toits virent au blanc et la vue devient éblouissante.
    intensity: altitude > 0 ? 0.45 : 0.15,
  });
}

function refreshLayers() {
  for (const side of ['left', 'right']) {
    map.setPaintProperty(`network-${side}`, 'line-offset', offsetExpression(side));
    map.setPaintProperty(
      `network-${side}`,
      'line-color',
      colorExpression(side === 'left' ? 'l' : 'r'),
    );
  }
  applyTime();
}

// --------------------------------------------------------------- itinéraire

/**
 * État d'un tronçon à un instant : c'est ce que le calcul d'itinéraire
 * interroge, des milliers de fois par recherche.
 *
 * On retient le trottoir le moins exposé — un piéton choisit son côté.
 */
function evaluateSegment(id, minutes, heading) {
  const context = contextAt(minutes);
  const segment = state.data.segmentAt(id);
  const leftSide = sideOf(id, false);
  const rightSide = sideOf(id, true);
  // Le graphe ne contient que des arêtes de cellules chargées : ce cas ne
  // devrait pas se produire. S'il se produit — cellule libérée en cours de
  // recherche — on rend un coût neutre, qui laisse le tronçon franchissable au
  // temps de marche seul. Le bloquer inventerait un obstacle ; le dire abrité
  // inventerait un abri.
  if (!segment || !leftSide || !rightSide) {
    return { index: 50, sun: 0, side: null, work: 0, twoSided: false, name: null };
  }
  const left = evaluateSide(leftSide, context, heading);
  const right = evaluateSide(rightSide, context, heading);
  // Le choix du côté tient compte du chantier avant l'exposition : un trottoir
  // barré n'est pas une gêne lumineuse, c'est un trottoir où l'on ne passe pas.
  // On ajoute donc l'emprise à l'indice pour comparer les deux côtés, mais on
  // rend l'indice réel — sans quoi la carte annoncerait de la lumière là où il
  // n'y a qu'une palissade.
  const penalised = (side) => side.index + side.work;
  const best = penalised(left) <= penalised(right) ? left : right;
  return {
    index: best.index,
    sun: best.sun * 100,
    side: best.side,
    work: best.work,
    twoSided: segment.twoSided,
    name: segment.name,
  };
}

/**
 * Sous ce zoom, la couleur par tronçon n'est plus lisible — les traits se
 * chevauchent — et la repeindre coûterait une demi-seconde à chaque cran du
 * curseur horaire. On affiche alors un réseau neutre, et on annonce qu'il faut
 * zoomer plutôt que de faire croire à une lecture.
 */
const READABLE_ZOOM = 13;

/**
 * Recolore les seuls tronçons affichés.
 *
 * C'est le gain de fond du passage aux tuiles : le coût cesse de dépendre de la
 * taille de la ville. Repeindre les 48 000 tronçons d'une zone prenait vingt
 * millisecondes ; sur Paris entier il y en aurait 414 000, et le curseur
 * horaire deviendrait poussif. À l'écran, il n'y en a jamais que quelques
 * milliers.
 */
/**
 * @param {boolean} [nearFieldOnly] borne la requête au bas de l'écran.
 *
 * En vue inclinée, `queryRenderedFeatures` couvre tout le sol jusqu'à
 * l'horizon : 4 669 tronçons au lieu de 2 000, et **60 ms rien que pour la
 * requête**. Or au-delà du milieu de l'écran la perspective écrase les rues à
 * quelques pixels — leur couleur n'y est plus lisible, exactement l'argument
 * qui fait exister `READABLE_ZOOM`.
 *
 * Pendant qu'on fait glisser le curseur horaire on ne repeint donc que le champ
 * proche. Le fond reste à sa couleur du dernier arrêt, ce qui est invisible à
 * cette échelle, et un repeignage complet a lieu dès que la carte se pose.
 */
function paintVisible(context, nearFieldOnly = false) {
  if (!state.data || !map.getLayer('network-left')) return;
  if (map.getZoom() < READABLE_ZOOM) return;
  const scale = 100 / MODES[state.mode].max;

  let query = { layers: ['network-left'] };
  if (nearFieldOnly && state.pitched) {
    const { clientWidth: width, clientHeight: height } = map.getContainer();
    query = [
      [0, height * 0.35],
      [width, height],
    ];
  }
  const features = map.queryRenderedFeatures(
    Array.isArray(query) ? query : undefined,
    Array.isArray(query) ? { layers: ['network-left'] } : query,
  );
  const seen = new Set();

  for (const feature of features) {
    const id = feature.id ?? feature.properties.id;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);

    const left = sideOf(id, false);
    const right = sideOf(id, true);
    // Relevés pas encore arrivés : on laisse le tronçon sans état. La couche le
    // dessine alors en gris « non renseigné », et il se colorera à la
    // prochaine passe, quand sa cellule sera là.
    if (!left || !right) continue;

    let l = displayValue(evaluateSide(left, context)) * scale;
    let r = displayValue(evaluateSide(right, context)) * scale;
    if (state.sideMode === 'best') l = r = Math.min(l, r);
    else if (state.sideMode === 'worst') l = r = Math.max(l, r);

    // Une valeur qui n'a pas bougé d'un point ne change aucune couleur : la
    // rampe ne distingue pas mieux que l'unité sur cent. Or `setFeatureState`
    // n'est pas gratuit — MapLibre marque la tuile et réémet ses attributs de
    // peinture. Avancer le curseur d'une minute ne déplace la plupart des
    // tronçons d'aucun point visible ; on ne réécrit donc que ce qui change.
    //
    // La comparaison se fait sur l'état que **MapLibre** porte, jamais sur un
    // cache tenu à côté : un double se désynchronise au premier remplacement de
    // source ou à la première tuile rechargée, et laisse des tronçons gris sans
    // que rien ne le signale. Ici, une entité sans état est toujours repeinte.
    const current = feature.state;
    if (
      current &&
      Math.round(current.l) === Math.round(l) &&
      Math.round(current.r) === Math.round(r)
    ) {
      continue;
    }

    map.setFeatureState(
      state.tiled ? { source: 'network', sourceLayer: 'reseau', id } : { source: 'network', id },
      { l, r },
    );
  }
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
      <div class="route-stat" style="color:${colorFor(route.index)}">
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
                    <strong style="color:${colorFor(jump.after)}">${jump.after}</strong>.
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
          : `Attendre ne change presque rien sur les trois prochaines heures :
             l’écart reste sous ${Math.max(1, gain)} point.`
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
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
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
  const { text, arrow, side } = describeManoeuvre(instruction);

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

  voice.announce(instruction, remaining, phraseFor(instruction, remaining, { text, side }));
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

function haversineMeters(lon1, lat1, lon2, lat2) {
  const midLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  return Math.hypot((lon2 - lon1) * 111320 * Math.cos(midLat), (lat2 - lat1) * 111132);
}

function formatMeters(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 5) * 5} m`;
}

// --------------------------------------------------------------- recherche

function setPlace(target, place) {
  state.places[target] = place;
  dom[target].value = place.label;
  hideSuggestions(target);
  renderMarkers();
}

function renderMarkers() {
  const features = [];
  for (const kind of ['from', 'to']) {
    const place = state.places[kind];
    if (place) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
        properties: { kind },
      });
    }
  }
  map.getSource('markers').setData({ type: 'FeatureCollection', features });
}

/**
 * Interroge la Base Adresse Nationale, une fois la frappe reposée.
 *
 * Trois précautions, et chacune répond à un défaut précis :
 *
 *  - **Anti-rebond de 250 ms.** Sans lui, « rue de rivoli » part quatorze fois,
 *    une par lettre, pour une seule réponse utile.
 *  - **Abandon de la requête précédente.** Les réponses ne reviennent pas dans
 *    l'ordre où on les demande : une requête lente sur « rue » écraserait la
 *    liste de « rue de Rivoli », tapé depuis.
 *  - **Vérification que le champ n'a pas changé** avant d'afficher. L'abandon
 *    couvre le réseau, pas le cas où la réponse arrive juste après une frappe.
 *
 * Un échec ne dit rien à l'écran : les rues du réseau sont déjà affichées, et
 * l'application reste utilisable hors ligne — c'est même tout l'intérêt de les
 * chercher d'abord localement.
 */
const addressSearch = { timer: null, controller: null };

function askAddresses(target, query, local) {
  clearTimeout(addressSearch.timer);
  addressSearch.controller?.abort();
  if (query.trim().length < 3) return;

  addressSearch.timer = setTimeout(async () => {
    addressSearch.controller = new AbortController();
    try {
      const remote = await searchAddresses(query, {
        center: state.meta.center,
        bbox: state.meta.bbox,
        signal: addressSearch.controller.signal,
      });
      if (dom[target].value !== query) return;
      showSuggestions(target, mergeSuggestions(local, remote));
    } catch (error) {
      if (error.name !== 'AbortError') console.warn('Adresses indisponibles :', error.message);
    }
  }, 250);
}

function showSuggestions(target, items) {
  const list = dom[`${target}Suggestions`];
  if (items.length === 0) {
    hideSuggestions(target);
    return;
  }

  list.innerHTML = items
    .map(
      (item, i) =>
        `<li id="${target}-option-${i}" role="option" aria-selected="false" data-index="${i}">
           <span>${escapeHtml(item.label)}</span><em>${escapeHtml(item.source)}</em>
         </li>`,
    )
    .join('');
  list.hidden = false;
  list.dataset.items = JSON.stringify(items);
  dom[target].setAttribute('aria-expanded', 'true');
  setActiveOption(target, -1);
}

function hideSuggestions(target) {
  const list = dom[`${target}Suggestions`];
  list.hidden = true;
  list.dataset.active = '-1';
  dom[target].setAttribute('aria-expanded', 'false');
  dom[target].removeAttribute('aria-activedescendant');
}

/**
 * Désigne l'option parcourue au clavier.
 *
 * Le focus ne bouge pas : il reste dans le champ, et `aria-activedescendant`
 * indique laquelle des options est visée. C'est tout l'intérêt du motif — on
 * continue de taper pendant qu'on parcourt la liste, ce qu'un focus déplacé
 * d'option en option interdirait.
 *
 * @param {number} index rang de l'option, ou −1 pour n'en viser aucune.
 */
function setActiveOption(target, index) {
  const list = dom[`${target}Suggestions`];
  const options = [...list.children];
  list.dataset.active = String(index);

  options.forEach((option, i) => {
    const active = i === index;
    option.setAttribute('aria-selected', String(active));
    option.classList.toggle('is-active', active);
    if (active) option.scrollIntoView({ block: 'nearest' });
  });

  if (index < 0) dom[target].removeAttribute('aria-activedescendant');
  else dom[target].setAttribute('aria-activedescendant', options[index].id);
}

/** Déplace la visée d'un cran, en bouclant aux deux bouts. */
function moveActiveOption(target, delta) {
  const list = dom[`${target}Suggestions`];
  const count = list.children.length;
  if (list.hidden || count === 0) return;

  const current = Number(list.dataset.active ?? -1);
  // Depuis « aucune », la flèche du bas prend la première et celle du haut la
  // dernière : c'est ce qu'on attend en ouvrant une liste par le bas ou par le haut.
  const next = current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count;
  setActiveOption(target, next);
}

function startPicking(target) {
  state.picking = target;
  map.getCanvas().style.cursor = 'crosshair';
  dom.routeResult.innerHTML = `<p class="muted">Cliquez sur la carte pour placer
    ${target === 'from' ? 'le départ' : "l'arrivée"}.</p>`;
}

function stopPicking() {
  state.picking = null;
  map.getCanvas().style.cursor = '';
  dom.routeResult.innerHTML = '';
}

/**
 * Renseigne un champ de l'itinéraire avec la position réelle.
 *
 * Le guidage pas à pas existait déjà, mais il fallait d'abord saisir son propre
 * point de départ — au clavier, ou en le pointant sur la carte, ce qui suppose
 * de savoir déjà où l'on est. Pour quelqu'un qui sort de chez lui et cherche à
 * rentrer à l'ombre, c'était l'étape qui manquait.
 */
function useMyPosition(target) {
  if (state.picking) stopPicking();
  const button = document.querySelector(`.locate[data-target="${target}"]`);

  if (!navigator.geolocation || !window.isSecureContext) {
    dom.routeResult.innerHTML = `<p class="warn">${
      navigator.geolocation
        ? 'La géolocalisation exige une connexion sécurisée (HTTPS ou localhost).'
        : 'Ce navigateur ne donne pas la position.'
    }</p>`;
    return;
  }

  button.classList.add('is-busy');
  dom.routeResult.innerHTML = `<p class="muted">Recherche de votre position…</p>`;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      button.classList.remove('is-busy');
      const { longitude, latitude, accuracy } = position.coords;
      setPlace(target, { label: 'Ma position', lon: longitude, lat: latitude });

      // Hors de l'emprise calculée, le dire tout de suite : le calcul
      // échouerait de toute façon, mais dix secondes plus tard et sans expliquer
      // que c'est la zone affichée qui est en cause, pas le trajet demandé.
      const [west, south, east, north] = state.meta.bbox;
      if (longitude < west || longitude > east || latitude < south || latitude > north) {
        dom.routeResult.innerHTML = `<p class="warn">
          Vous êtes hors de la zone « ${escapeHtml(state.meta.label)} ».
          Choisissez une zone qui vous contient.</p>`;
        return;
      }

      dom.routeResult.innerHTML =
        accuracy > 60
          ? `<p class="muted">Position connue à ± ${Math.round(accuracy)} m seulement —
             vérifiez le point sur la carte.</p>`
          : '';
      map.easeTo({
        center: [longitude, latitude],
        zoom: Math.max(map.getZoom(), 16),
        duration: motionDuration(600),
      });
    },
    (error) => {
      button.classList.remove('is-busy');
      dom.routeResult.innerHTML = `<p class="warn">${geolocationMessage(error)}</p>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

/** Cause d'un échec de géolocalisation, dite en clair. */
function geolocationMessage(error) {
  const reasons = {
    1: 'Autorisation refusée. Activez la localisation pour ce site.',
    2: 'Position indisponible.',
    3: 'La position met trop de temps à arriver.',
  };
  const reason = reasons[error?.code] ?? 'Position indisponible.';
  return window.isSecureContext
    ? reason
    : `${reason} La géolocalisation exige une connexion sécurisée (HTTPS ou localhost).`;
}

// --------------------------------------------------------------- affichage

function renderLegend() {
  dom.modeNote.textContent = MODES[state.mode].note;
  const stops = state.mode === 'uv' ? UV_LEGEND : state.meta.scale;
  dom.legend.innerHTML = stops
    .map(
      (stop, i) => `
        <div class="step">
          <div class="swatch" style="background:linear-gradient(90deg,${stop.color},${
            stops[i + 1]?.color ?? stop.color
          })"></div>
          <div class="label">${stop.label}</div>
        </div>`,
    )
    .join('');
}

function selectSegment(feature) {
  state.selected = feature.properties;
  map.setFilter('network-selected', ['==', ['get', 'id'], feature.properties.id]);
  dom.panel.hidden = false;
  renderPanel(state.selected);
}

function renderPanel(props) {
  const segment = state.data.segmentAt(props.id);
  const leftSide = sideOf(props.id, false);
  const rightSide = sideOf(props.id, true);
  // Cliquer sur une rue dont les relevés ne sont pas encore là est parfaitement
  // ordinaire en région : le trait vient d'une tuile, le relevé d'une cellule,
  // et les deux ne voyagent pas ensemble. On le dit, et la cellule arrive.
  if (!segment || !leftSide || !rightSide) {
    dom.panelTitle.textContent = 'Relevés en cours de chargement';
    dom.panelSub.textContent = 'ce secteur arrive';
    dom.panelScore.innerHTML = '<span class="value muted">—</span>';
    dom.panelAdvice.innerHTML =
      '<span class="muted">Le détail s’affichera dès que les relevés du secteur seront là.</span>';
    dom.panelChart.innerHTML = '';
    // Le clic est aussi une demande : on va chercher la cellule, et le panneau
    // se remplira à la prochaine peinture.
    ensureVisibleCells().then(() => {
      if (state.selected?.id === props.id) renderPanel(props);
    });
    return;
  }
  const context = contextAt(state.minutes);
  const l = evaluateSide(leftSide, context);
  const r = evaluateSide(rightSide, context);
  const twoSided = segment.twoSided;

  const best = l.index <= r.index ? l : r;
  const worst = l.index <= r.index ? r : l;
  const shown = state.sideMode === 'worst' ? worst : best;

  dom.panelTitle.textContent = segment.name ?? labelForHighway(segment.hw, segment.crossing);
  dom.panelSub.textContent = [
    segment.name ? labelForHighway(segment.hw, segment.crossing) : 'voie sans nom',
    segment.width ? `${segment.width} m de large` : null,
    formatClock(state.minutes),
  ]
    .filter(Boolean)
    .join(' · ');

  dom.panelScore.innerHTML = `
    <span class="value" style="color:${colorFor(shown.index)}">${shown.index}</span>
    <span class="level">${levelLabel(shown.index)}</span>`;

  const gap = worst.index - best.index;
  dom.panelAdvice.innerHTML = !twoSided
    ? `<span class="muted">Cheminement piéton : un seul relevé, pas de côté à choisir.</span>`
    : gap < 8
      ? `<span class="muted">Les deux trottoirs se valent (écart de ${gap} point${gap > 1 ? 's' : ''}).</span>`
      : `Marchez côté <strong>${best.side}</strong> — ${best.index} contre ${worst.index}
         côté ${worst.side}, soit <strong>${gap} points</strong> de moins.`;

  dom.panelChart.innerHTML = sparkline(props.id);

  const pct = (value) => `${Math.round(value * 100)} %`;
  // Les luminances se lisent par ordre de grandeur, pas à l'unité : sous mille,
  // la centaine suffit ; au-delà, le millier.
  const cdm2 = (value) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)} kcd/m²` : `${Math.round(value / 10) * 10} cd/m²`;
  const rows = twoSided
    ? [
        ['', `côté ${l.side}`, `côté ${r.side}`],
        ['Indice', l.index, r.index],
        ['Soleil direct', pct(l.sun), pct(r.sun)],
        ['Éblouissement de face', pct(l.glare), pct(r.glare)],
        ['Scintillement', pct(l.flicker), pct(r.flicker)],
        ['Réverbération', pct(l.reverb), pct(r.reverb)],
        ['Murs éclairés', pct(l.sunlitWalls), pct(r.sunlitWalls)],
        ['Luminance façades', cdm2(l.wallLuminance), cdm2(r.wallLuminance)],
        ['Luminance du sol', cdm2(l.groundLuminance), cdm2(r.groundLuminance)],
        ['Ouverture au ciel', pct(l.svf), pct(r.svf)],
        ['Couvert arboré', `${l.canopy} %`, `${r.canopy} %`],
        ['Éclairement', `${(l.lux / 1000).toFixed(0)} klx`, `${(r.lux / 1000).toFixed(0)} klx`],
        [
          'Équivalent mélanopique',
          `${(l.melanopicLux / 1000).toFixed(0)} klx`,
          `${(r.melanopicLux / 1000).toFixed(0)} klx`,
        ],
        ['Indice UV', l.uv.toFixed(1), r.uv.toFixed(1)],
      ]
    : [
        ['Soleil direct', pct(l.sun)],
        ['Éblouissement de face', pct(l.glare)],
        ['Scintillement', pct(l.flicker)],
        ['Réverbération', pct(l.reverb)],
        ['Murs éclairés', pct(l.sunlitWalls)],
        ['Luminance façades', cdm2(l.wallLuminance)],
        ['Luminance du sol', cdm2(l.groundLuminance)],
        ['Ouverture au ciel', pct(l.svf)],
        ['Couvert arboré', `${l.canopy} %`],
        ['Éclairement', `${(l.lux / 1000).toFixed(0)} klx`],
        ['Équivalent mélanopique', `${(l.melanopicLux / 1000).toFixed(0)} klx`],
        ['Indice UV', `${l.uv.toFixed(1)} — ${uvLabel(l.uv)}`],
      ];

  dom.panelStats.className = twoSided ? 'two-sided' : '';
  dom.panelStats.innerHTML = rows
    .map(
      ([label, ...values]) =>
        `<div class="row"><span class="key">${label}</span>${values
          .map((v) => `<span class="val">${v}</span>`)
          .join('')}</div>`,
    )
    .join('');
}

/** Courbe de l'indice sur la journée, un trait par trottoir. */
function sparkline(id) {
  const width = 280;
  const height = 74;
  const pad = 4;
  const times = state.meta.times;

  const seriesFor = (entry) =>
    times.map((step) => evaluateSide(entry, contextAt(step.minutes)).index);

  const l = seriesFor(sideOf(id, false));
  const r = seriesFor(sideOf(id, true));

  const toPoints = (values) =>
    values
      .map((value, i) => {
        const x = pad + (i / (values.length - 1)) * (width - pad * 2);
        const y = height - pad - (value / 100) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const first = times[0].minutes;
  const span = times[times.length - 1].minutes - first;
  const cursorX = pad + ((state.minutes - first) / span) * (width - pad * 2);

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="Évolution de l'indice sur la journée, pour chaque trottoir">
      <polyline points="${toPoints(l)}" fill="none" stroke="#4aa3a2" stroke-width="1.8" />
      <polyline points="${toPoints(r)}" fill="none" stroke="#d9a441" stroke-width="1.8" />
      <line x1="${cursorX.toFixed(1)}" y1="${pad}" x2="${cursorX.toFixed(1)}" y2="${height - pad}"
            stroke="#d7dbe3" stroke-width="1" stroke-dasharray="2 3" opacity="0.7" />
    </svg>
    <p class="chart-key">
      <span style="color:#4aa3a2">— côté ${state.data.segmentAt(id).lSide}</span>
      <span style="color:#d9a441">— côté ${state.data.segmentAt(id).rSide}</span>
    </p>`;
}

function colorFor(value) {
  let result = state.meta.scale[0].color;
  for (const stop of state.meta.scale) {
    if (value >= stop.value) result = stop.color;
  }
  return result;
}

function labelForHighway(highway, crossing) {
  if (crossing) return 'traversée piétonne';
  return (
    {
      footway: 'trottoir / cheminement',
      pedestrian: 'voie piétonne',
      path: 'sentier',
      steps: 'escalier',
      living_street: 'zone de rencontre',
      residential: 'rue',
      service: 'voie de desserte',
      cycleway: 'piste cyclable',
      tertiary: 'rue',
      secondary: 'avenue',
      primary: 'grand axe',
    }[highway] ?? 'voie'
  );
}

/**
 * Tronçon le plus proche d'un point de l'écran.
 *
 * Un clic pile sur le trait est illusoire : les deux trottoirs sont déportés de
 * part et d'autre de l'axe, si bien que viser le milieu de la rue ne touche
 * rien. On élargit donc la zone de recherche par paliers, ce qui revient à
 * retenir le tracé le plus proche du curseur.
 */
function segmentNear(point) {
  const layers = ['network-left', 'network-right'];
  for (const radius of [3, 9, 18]) {
    const hits = map.queryRenderedFeatures(
      [
        [point.x - radius, point.y - radius],
        [point.x + radius, point.y + radius],
      ],
      { layers },
    );
    if (hits.length > 0) return hits[0];
  }
  return null;
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
    setRoutePanel(true);
    computeRoute().catch(fail);
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

  for (const target of ['from', 'to']) {
    const input = dom[target];

    // Les rues du réseau s'affichent à la frappe, sans attendre ; les adresses
    // arrivent après, et complètent la liste sans la remplacer.
    input.addEventListener('input', () => {
      const local = searchLocal(currentStreets(), input.value);
      showSuggestions(target, local);
      askAddresses(target, input.value, local);
    });

    input.addEventListener('keydown', async (event) => {
      const list = dom[`${target}Suggestions`];

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Sans quoi la flèche irait déplacer le curseur dans le texte.
        event.preventDefault();
        moveActiveOption(target, event.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (event.key === 'Escape') {
        // Échap referme d'abord la liste, et rien d'autre : on ne veut pas
        // qu'une frappe de trop referme le panneau entier.
        if (list.hidden) return;
        event.stopPropagation();
        hideSuggestions(target);
        return;
      }

      if (event.key !== 'Enter') return;
      event.preventDefault();

      // Une option visée au clavier l'emporte sur tout : c'est celle qu'on voit
      // en surbrillance, et la valider doit donner exactement ce qu'on lit.
      const active = Number(list.dataset.active ?? -1);
      if (!list.hidden && active >= 0) {
        setPlace(target, JSON.parse(list.dataset.items ?? '[]')[active]);
        return;
      }

      // À défaut d'une option visée, la première de la liste affichée : c'est
      // ce qu'on lit, et valider doit donner ce qu'on lit. La liste peut déjà
      // contenir des adresses, arrivées après la frappe.
      const shown = JSON.parse(list.dataset.items ?? '[]');
      if (!list.hidden && shown.length > 0) {
        setPlace(target, shown[0]);
        return;
      }

      const local = searchLocal(currentStreets(), input.value);
      if (local.length > 0) {
        setPlace(target, local[0]);
        return;
      }

      // Ni rue du réseau, ni adresse : ce qu'on cherche est un lieu — une gare,
      // un musée, un square. Nominatim les connaît, et on ne le dérange qu'ici,
      // sur une validation explicite, jamais à chaque frappe.
      try {
        const addresses = await searchAddresses(input.value, {
          center: state.meta.center,
          bbox: state.meta.bbox,
        });
        if (addresses.length > 0) {
          setPlace(target, addresses[0]);
          return;
        }
        const remote = await searchRemote(input.value, state.meta.bbox);
        if (remote.length > 0) setPlace(target, remote[0]);
        else showSuggestions(target, []);
      } catch (error) {
        console.warn('Recherche indisponible :', error.message);
      }
    });

    dom[`${target}Suggestions`].addEventListener('click', (event) => {
      const option = event.target.closest('li');
      if (!option) return;
      const items = JSON.parse(dom[`${target}Suggestions`].dataset.items ?? '[]');
      setPlace(target, items[Number(option.dataset.index)]);
    });
  }

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

function closeDetailPanel() {
  // La carte reprend le focus : c'est d'elle qu'on vient, et les raccourcis
  // horaires y répondent.
  if (dom.panel.contains(document.activeElement)) map.getCanvas().focus();
  dom.panel.hidden = true;
  state.selected = null;
  map.setFilter('network-selected', ['==', ['get', 'id'], -1]);
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

function formatClock(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Écrit un texte, et rien du tout s'il n'a pas changé.
 *
 * Ce n'est pas une économie de rendu : une zone vivante annonce sur **mutation
 * du DOM**, pas sur changement de valeur. Réécrire la même consigne à chaque
 * point GPS la faisait donc relire à chaque seconde, alors que rien ne s'était
 * passé — le bandeau de guidage devenait inutilisable au lecteur d'écran.
 * Scoper `aria-live` était nécessaire, mais pas suffisant.
 */
function setText(element, text) {
  const value = String(text ?? '');
  if (element.textContent === value) return;
  element.textContent = value;
}

/** Même chose pour un fragment balisé — voir `setText`. */
function setHTML(element, html) {
  if (element.innerHTML === html) return;
  element.innerHTML = html;
}

function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function loadJSON(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} introuvable (HTTP ${response.status}).`);
  ensureNotFallbackPage(response, path);
  return response.json();
}

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

/**
 * Écran d'échec.
 *
 * Le conseil « lancez d'abord le calcul » était donné pour n'importe quelle
 * panne — y compris pour un stockage local refusé ou une coupure de réseau,
 * c'est-à-dire précisément les cas où les données étaient là et où il envoyait
 * chercher au mauvais endroit. On ne le donne donc que lorsque ce sont bien les
 * fichiers de zone qui manquent, et on dit la vraie cause dans les autres cas.
 */
function fail(error) {
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
