/**
 * Point d'entrée de l'interface : le démarrage, le chargement d'une zone ou
 * d'une région, et le câblage des commandes.
 *
 * Le reste vit dans des modules qui partagent l'état par `app.js` :
 *
 *  - `layers.js` — sources, couches, peinture des trottoirs, lumière, bâti ;
 *  - `panel.js` — panneau de détail, légende, couleurs de l'échelle ;
 *  - `search.js` — départ et arrivée : recherche, pointage, position réelle ;
 *  - `route.js` — itinéraire, « quand partir ? », lien partageable ;
 *  - `guidance.js` — guidage pas à pas, voix, verrou d'écran ;
 *  - `offline-ui.js` — panneau hors ligne.
 *
 * Ici reste ce qui ordonne les autres : l'enchaînement du démarrage, le jeton
 * qui écarte un chargement dépassé (`loadToken`), et `bindControls`, où chaque
 * commande est reliée à son effet. Aucun module n'importe celui-ci.
 */
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
import { prepareGraph } from './routing.js';
import { loadZoneData } from './binary.js';
import { createRegionData, loadRegionIndex } from './cells.js';
import { indexStreetNames } from './geocode.js';
import { writeRoute } from './link.js';
import { emptyCollection } from './format.js';
import { prefs } from './prefs.js';
import {
  MODES,
  dom,
  fail,
  invalidateContexts,
  loadJSON,
  map,
  setMap,
  setShadows,
  shadows,
  state,
} from './app.js';
import { bindPlaceFields, setPlace, startPicking, stopPicking, useMyPosition } from './search.js';
import {
  addLayers,
  applyTime,
  buildingsForShadows,
  ensureVisibleCells,
  paintVisible,
  refreshLayers,
  removeNetworkLayers,
  setPitched,
} from './layers.js';
import { closeDetailPanel } from './panel.js';
import { startNavigation, stopNavigation, voice } from './guidance.js';
import { computeRoute, restoreRouteFromUrl, setRoutePanel } from './route.js';
import { runOffline, setOfflinePanel } from './offline-ui.js';
import { components, discomfortIndex, skyConditions } from '@svet/pipeline/model';
import { localDate } from '@svet/pipeline/sun';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/** Fond minimal si le fond de carte distant est injoignable — l'appli reste utilisable. */
const FALLBACK_BASEMAP = {
  version: 8,
  sources: {},
  layers: [{ id: 'fond', type: 'background', paint: { 'background-color': '#0b0f16' } }],
};

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
