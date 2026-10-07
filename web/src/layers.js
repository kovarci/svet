/**
 * La carte peinte : sources, couches, et la couleur de chaque trottoir.
 *
 * Ce module crée les couches du réseau, du bâti, de l'itinéraire et de la
 * position, et tient leurs expressions de style. Il repeint les trottoirs
 * affichés quand l'heure ou la lecture changent (`applyTime`, `paintVisible`,
 * `refreshLayers`) — par leur `feature-state`, sans toucher à la géométrie —,
 * oriente la lumière des volumes et le halo solaire, et bascule entre la vue à
 * plat, où la nappe d'ombres s'affiche, et la vue inclinée, où le bâti prend le
 * relais.
 */
import {
  MODES,
  UV_LEGEND,
  contextAt,
  displayValue,
  dom,
  evaluateSide,
  loadJSON,
  map,
  motionDuration,
  shadows,
  sideOf,
  state,
} from './app.js';
import { emptyCollection, formatClock } from './format.js';
import { renderLegend, renderPanel, selectSegment } from './panel.js';
import { setPlace, stopPicking } from './search.js';
import { CLEAR_SKY, skyLabel } from './weather.js';
import { DEG } from '@svet/pipeline/sun';

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

export function removeNetworkLayers() {
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
export function buildingsForShadows() {
  return state.tiled ? { source: 'network', sourceLayer: 'bati' } : { features: state.buildings };
}

/**
 * Gabarit d'URL de la pyramide courante, version comprise.
 *
 * Absolu : MapLibre l'exige, et le pré-chargement hors ligne doit demander
 * exactement les mêmes URLs que la carte, sans quoi il remplirait le cache de
 * clés que personne ne relira jamais.
 */
export function tileTemplate() {
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  // Une région n'a pas de version « tout chargé » : c'est précisément ce qu'on
  // ne peut pas faire à cette taille. Sa pyramide est commune à ses cellules.
  const path = state.region
    ? `data/${state.meta.region}/tuiles/{z}/{x}/{y}.pbf`
    : `data/${state.zoneKey}/{z}/{x}/{y}.pbf`;
  return `${base}${path}${state.version}`;
}

export async function addLayers() {
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

/**
 * Charge les relevés des cellules visibles.
 *
 * Bornée au zoom lisible : au-dessus de la région entière, on verrait vingt
 * cellules d'un coup, soit deux cents mégaoctets, pour une échelle où aucune
 * couleur de trottoir n'est distinguable. L'aperçu régional suffit.
 */
export function ensureVisibleCells() {
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

export function applyTime() {
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
 * Bascule en vue inclinée.
 *
 * La nappe de lumière est retirée tant que la carte est penchée : sa
 * transformation Mercator → écran est affine, ce qui n'est exact qu'à plat. Les
 * volumes prennent le relais, éclairés depuis la position réelle du soleil.
 */
export function setPitched(pitched) {
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

export function refreshLayers() {
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
export function paintVisible(context, nearFieldOnly = false) {
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
