/**
 * Ombres portées des bâtiments, dessinées en direct sur un canevas superposé.
 *
 * On peint la *lumière*, pas l'ombre : le canevas est rempli d'un voile chaud
 * dont on découpe les ombres. Assombrir un fond de carte déjà très sombre ne se
 * voyait pas ; éclairer ce qui est au soleil se lit immédiatement, et colle au
 * propos de l'application — montrer où la lumière tombe.
 *
 * Deux points de performance, sans lesquels la carte se fige dès qu'on la
 * déplace (mesuré à 1,4 s par image sur le Marais, 34 000 bâtiments) :
 *
 *  1. Les contours sont convertis une fois pour toutes en coordonnées de
 *     Mercator. À chaque image on ne fait plus qu'une transformation affine à
 *     six coefficients — plus aucun appel à `map.project()`, qui allouait un
 *     objet par sommet.
 *  2. Un seul `fill()` par bâtiment au lieu d'un par arête. Les sous-chemins
 *     sont tous réorientés dans le même sens : sans cela, la règle du
 *     « non-zéro » percerait des trous là où deux d'entre eux se recouvrent.
 *
 * Cette couche est purement visuelle. L'indice, lui, vient du pipeline, qui
 * tient compte des arbres et du facteur de vue du ciel — pas seulement du bâti.
 */

const MIN_ZOOM = 13.5;
const SUN_COLOR = '#ffd88a';

/** En dessous, un bâtiment ne couvre plus assez de pixels pour se voir. */
const MIN_SCREEN_AREA = 8;

/**
 * Plafond du nombre de bâtiments dessinés en une image.
 *
 * Chaque bâtiment coûte un `fill()` sur un chemin d'une soixantaine de
 * segments. Sur un grand écran dézoomé, la boucle en trouve plusieurs milliers,
 * et le fil principal ne suit plus — c'est ce qui saccade sur un téléphone.
 *
 * Au-delà du plafond on relève le seuil de taille au lieu de couper au hasard :
 * on perd les plus petits, dont l'ombre était de toute façon à la limite du
 * visible, et on garde ceux qui portent le dessin.
 */
const MAX_DRAWN = 1800;

export function createShadowLayer(map, canvas, describeBuildings) {
  const ctx = canvas.getContext('2d');
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');

  let buildings = [];
  let sun = null;
  let enabled = true;
  let queued = false;
  let drawnLast = 0;
  /** Tampon réutilisé pour les sommets projetés : on n'alloue rien par image. */
  let scratch = new Float64Array(512);

  /**
   * Reprend les emprises depuis les tuiles chargées.
   *
   * Elles venaient d'un GeoJSON complet — 15 Mo pour la zone centre. Elles
   * arrivent désormais dans la couche `bati` des tuiles vectorielles, dont la
   * marge est volontairement large : un immeuble hors écran projette son ombre
   * dans le champ.
   *
   * On ne rappelle cette fonction qu'à l'arrivée de nouvelles tuiles, jamais
   * par image : convertir les contours en coordonnées de Mercator coûte, et
   * c'est précisément ce précalcul qui rend le rendu tenable.
   */
  function refresh() {
    const descriptor = describeBuildings();
    if (!descriptor) return;

    let features;
    if (descriptor.features) {
      features = descriptor.features;
    } else {
      if (!map.getSource(descriptor.source)) return;
      try {
        features = map.querySourceFeatures(descriptor.source, {
          sourceLayer: descriptor.sourceLayer,
        });
      } catch {
        return; // source encore en cours de remplacement
      }
    }

    buildings = [];
    const seen = new Set();
    for (const feature of features) {
      const ring = outerRing(feature.geometry);
      if (!ring || ring.length < 3) continue;

      // Une même emprise apparaît dans plusieurs tuiles à cause de la marge :
      // sans dédoublonnage, on la dessinerait autant de fois.
      const key = `${ring[0][0].toFixed(6)},${ring[0][1].toFixed(6)},${ring.length}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const count = ring.length;
      const merc = new Float64Array(count * 2);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < count; i++) {
        const x = mercatorX(ring[i][0]);
        const y = mercatorY(ring[i][1]);
        merc[i * 2] = x;
        merc[i * 2 + 1] = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      if (count * 2 > scratch.length) scratch = new Float64Array(count * 2);
      buildings.push({ merc, count, height: feature.properties.h ?? 12, minX, minY, maxX, maxY });
    }
    schedule();
  }

  /**
   * @param {{altitude: number, azimuth: number, cloud: number}} next
   *   `cloud` estompe le voile : sous un ciel couvert il n'y a plus d'ombre
   *   portée, seulement une lumière diffuse et uniforme.
   */
  function setSun(next) {
    sun = next;
    schedule();
  }

  function setEnabled(value) {
    enabled = value;
    schedule();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  }

  function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = map.getContainer().clientWidth;
    const height = map.getContainer().clientHeight;

    for (const c of [canvas, offscreen]) {
      if (c.width !== width * dpr || c.height !== height * dpr) {
        c.width = width * dpr;
        c.height = height * dpr;
      }
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Le contenu qu'on suivait vient d'être effacé : la transformation qui le
    // suivait n'a plus d'objet. On la retire ici plutôt qu'à la fin, pour que
    // tous les chemins de sortie de `render` la nettoient — y compris ceux qui
    // renoncent à dessiner, la nuit ou sous un ciel couvert.
    clearTransform();

    if (!enabled || !sun || sun.altitude <= 0.02) return;
    if (map.getZoom() < MIN_ZOOM || buildings.length === 0) return;

    // Le voile s'efface avec les nuages et avec un soleil rasant : à 3° de
    // hauteur, l'ombre est partout et le dessiner n'apprend plus rien.
    const cloud = sun.cloud ?? 0;
    const strength = 0.3 * Math.pow(1 - cloud, 2.5) * Math.min(1, Math.sin(sun.altitude) * 6);
    if (strength < 0.02) return;

    const view = affineFromMap(map);
    // Longueur d'ombre par mètre de hauteur, et direction : à l'opposé du
    // soleil. C'est ici que se joue la différence entre midi et 19 h — à 59°
    // l'ombre fait 0,6 fois la hauteur, à 23° elle en fait 2,4 fois.
    const perMeter = 1 / Math.tan(sun.altitude);
    const shadowAzimuth = sun.azimuth + Math.PI;
    const metersToScreen = screenBasis(map);
    const shadowX =
      (Math.sin(shadowAzimuth) * metersToScreen.east[0] +
        Math.cos(shadowAzimuth) * metersToScreen.north[0]) *
      perMeter;
    const shadowY =
      (Math.sin(shadowAzimuth) * metersToScreen.east[1] +
        Math.cos(shadowAzimuth) * metersToScreen.north[1]) *
      perMeter;

    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.clearRect(0, 0, width, height);
    offCtx.fillStyle = SUN_COLOR;
    offCtx.fillRect(0, 0, width, height);

    // Tout ce qui suit retire de la lumière au lieu d'en ajouter. Deux ombres
    // qui se recouvrent donnent donc le même résultat qu'une seule.
    offCtx.globalCompositeOperation = 'destination-out';
    offCtx.fillStyle = '#000';

    // Emprise visible, en Mercator, élargie de la portée des ombres.
    const shadowReach = Math.hypot(shadowX, shadowY) * 60; // 60 m, immeuble haut
    const pad = shadowReach / view.scale;
    const bounds = map.getBounds();
    const west = mercatorX(bounds.getWest()) - pad;
    const east = mercatorX(bounds.getEast()) + pad;
    const north = mercatorY(bounds.getNorth()) - pad;
    const south = mercatorY(bounds.getSouth()) + pad;

    // Premier passage : combien de bâtiments le cadre contient-il, et à partir
    // de quelle taille faut-il couper pour rester sous le plafond ? On ne trie
    // pas — trier plusieurs milliers d'entrées par image coûterait autant que ce
    // qu'on cherche à économiser. On compte par classes de taille, ce qui donne
    // le seuil en une passe.
    // Classes fines : le seuil ne peut pas être plus précis que la largeur
    // d'une classe, et le dépassement du plafond vaut au plus le contenu de
    // celle où l'on s'arrête. Avec quatre classes par octave — un facteur 1,19
    // en surface — le dépassement reste marginal ; à une classe et demie par
    // octave, il atteignait 60 %.
    const PER_OCTAVE = 4;
    const BUCKETS = 64;
    const histogram = new Uint32Array(BUCKETS);
    let candidates = 0;
    const bucketOf = (area) =>
      Math.min(BUCKETS - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, area)) * PER_OCTAVE)));

    for (const building of buildings) {
      if (building.maxX < west || building.minX > east) continue;
      if (building.maxY < north || building.minY > south) continue;
      const area =
        (building.maxX - building.minX) * view.scale * ((building.maxY - building.minY) * view.scale);
      if (area < MIN_SCREEN_AREA) continue;
      candidates++;
      histogram[bucketOf(area)]++;
    }

    let areaFloor = MIN_SCREEN_AREA;
    if (candidates > MAX_DRAWN) {
      let kept = 0;
      for (let b = BUCKETS - 1; b >= 0; b--) {
        kept += histogram[b];
        if (kept >= MAX_DRAWN) {
          areaFloor = Math.pow(2, b / PER_OCTAVE);
          break;
        }
      }
    }

    let drawn = 0;
    for (const building of buildings) {
      if (building.maxX < west || building.minX > east) continue;
      if (building.maxY < north || building.minY > south) continue;

      // Trop petit à l'écran pour se distinguer : on passe.
      const screenWidth = (building.maxX - building.minX) * view.scale;
      const screenHeight = (building.maxY - building.minY) * view.scale;
      if (screenWidth * screenHeight < areaFloor) continue;

      const { merc, count } = building;
      for (let i = 0; i < count; i++) {
        const mx = merc[i * 2];
        const my = merc[i * 2 + 1];
        scratch[i * 2] = view.a * mx + view.c * my + view.e;
        scratch[i * 2 + 1] = view.b * mx + view.d * my + view.f;
      }

      const dx = shadowX * building.height;
      const dy = shadowY * building.height;

      offCtx.beginPath();
      // Empreinte au sol, empreinte translatée, puis les quadrilatères reliant
      // chaque arête à sa translatée : leur union est l'ombre.
      //
      // Les deux sources n'enroulent pas leurs anneaux dans le même sens — les
      // tuiles vectorielles imposent le sens horaire à l'écran, le GeoJSON du
      // pipeline le sens inverse. On les ramène donc tous à une orientation
      // unique, positive, dont dépend la suite.
      const clockwise = signedArea(scratch, count) < 0;
      traceRing(offCtx, scratch, count, 0, 0, clockwise);
      traceRing(offCtx, scratch, count, dx, dy, clockwise);

      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const x1 = scratch[i * 2];
        const y1 = scratch[i * 2 + 1];
        const x2 = scratch[j * 2];
        const y2 = scratch[j * 2 + 1];
        // Sens du quadrilatère : il doit suivre celui des anneaux, sinon la
        // règle du non-zéro le soustrairait au lieu de l'ajouter. Les anneaux
        // sortent toujours positifs de `traceRing` : la comparaison ne dépend
        // donc que du produit vectoriel, jamais du sens d'origine.
        const forward = (x2 - x1) * dy - (y2 - y1) * dx > 0;
        offCtx.moveTo(x1, y1);
        if (forward) {
          offCtx.lineTo(x2, y2);
          offCtx.lineTo(x2 + dx, y2 + dy);
          offCtx.lineTo(x1 + dx, y1 + dy);
        } else {
          offCtx.lineTo(x1 + dx, y1 + dy);
          offCtx.lineTo(x2 + dx, y2 + dy);
          offCtx.lineTo(x2, y2);
        }
        offCtx.closePath();
      }
      offCtx.fill();
      drawn++;
    }

    ctx.globalAlpha = strength;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offscreen, 0, 0);
    ctx.globalAlpha = 1;
    drawnLast = drawn;

    // On note la vue de ce rendu : c'est elle qui sert de repère à la
    // transformation pendant le déplacement suivant.
    anchor = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing() };
    return drawn;
  }

  /**
   * Pendant le déplacement, on **transforme** au lieu de redessiner.
   *
   * Le rendu complet coûte, pour ~2 500 bâtiments de 11 sommets, près de
   * 175 000 opérations de tracé et autant d'appels à `fill()` qu'il y a de
   * bâtiments. C'est tenable une fois ; c'est intenable soixante fois par
   * seconde, et sur un téléphone c'est ce qui fait saccader la carte.
   *
   * On garde donc l'image du dernier rendu et on lui applique une
   * transformation CSS — translation, rotation, échelle — calculée depuis le
   * déplacement de la carte. Le compositeur s'en charge sur le processeur
   * graphique, sans toucher au fil principal. L'ombre est alors légèrement
   * étirée pendant le geste, et redevient exacte dès qu'on relâche.
   *
   * C'est le compromis habituel des couches raster superposées, et il est
   * honnête ici : personne ne lit une ombre au mètre près en train de faire
   * glisser la carte.
   */
  let anchor = null;

  function clearTransform() {
    if (!canvas.style.transform) return;
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
  }

  function follow() {
    if (!anchor) return;
    const { clientWidth: width, clientHeight: height } = map.getContainer();
    const point = map.project(anchor.center);
    const scale = Math.pow(2, map.getZoom() - anchor.zoom);
    const rotation = map.getBearing() - anchor.bearing;

    // Le rendu a placé le centre d'alors au centre du conteneur : on ramène ce
    // point là où il se trouve maintenant, puis on tourne et on met à l'échelle
    // autour de lui.
    canvas.style.transformOrigin = `${width / 2}px ${height / 2}px`;
    canvas.style.transform =
      `translate(${point.x - width / 2}px, ${point.y - height / 2}px)` +
      ` rotate(${rotation}deg) scale(${scale})`;
  }

  // On ne retire pas la transformation ici : elle doit tenir jusqu'à ce que le
  // nouveau rendu soit prêt, sans quoi l'ombre sauterait à sa place d'avant le
  // temps d'une image. C'est `render` qui la remet à zéro, une fois l'image
  // refaite.
  const settle = () => schedule();

  map.on('move', follow);
  map.on('moveend', settle);
  map.on('resize', settle);

  return {
    refresh,
    setSun,
    setEnabled,
    render: schedule,
    /** Diagnostic : ce que la couche a réellement en mémoire. */
    get count() {
      return buildings.length;
    },
    /** Diagnostic : bâtiments effectivement dessinés à la dernière image. */
    get drawn() {
      return drawnLast;
    },
    /** Diagnostic : soleil dont la couche se sert réellement. */
    get sun() {
      return sun;
    },
  };
}

function traceRing(ctx, points, count, dx, dy, reverse) {
  if (reverse) {
    ctx.moveTo(points[(count - 1) * 2] + dx, points[(count - 1) * 2 + 1] + dy);
    for (let i = count - 2; i >= 0; i--) ctx.lineTo(points[i * 2] + dx, points[i * 2 + 1] + dy);
  } else {
    ctx.moveTo(points[0] + dx, points[1] + dy);
    for (let i = 1; i < count; i++) ctx.lineTo(points[i * 2] + dx, points[i * 2 + 1] + dy);
  }
  ctx.closePath();
}

function signedArea(points, count) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return sum / 2;
}

function outerRing(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return geometry.coordinates[0];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates[0]?.[0];
  return null;
}

const mercatorX = (lon) => (lon + 180) / 360;

const mercatorY = (lat) =>
  (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

const latFromMercator = (y) =>
  ((2 * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - Math.PI / 2) * 180) / Math.PI;

const lonFromMercator = (x) => x * 360 - 180;

/**
 * Transformation affine Mercator → écran, déduite de trois projections.
 *
 * Elle est exacte tant que la carte n'est pas inclinée, ce que l'application
 * garantit (`maxPitch: 0`). Elle absorbe en revanche zoom et rotation.
 */
function affineFromMap(map) {
  const center = map.getCenter();
  const x0 = mercatorX(center.lng);
  const y0 = mercatorY(center.lat);
  const step = 0.0005;

  const origin = map.project(center);
  const alongX = map.project([lonFromMercator(x0 + step), center.lat]);
  const alongY = map.project([center.lng, latFromMercator(y0 + step)]);

  const a = (alongX.x - origin.x) / step;
  const b = (alongX.y - origin.y) / step;
  const c = (alongY.x - origin.x) / step;
  const d = (alongY.y - origin.y) / step;

  return {
    a,
    b,
    c,
    d,
    e: origin.x - a * x0 - c * y0,
    f: origin.y - b * x0 - d * y0,
    /** Pixels par unité de Mercator, pour estimer une taille à l'écran. */
    scale: Math.hypot(a, b),
  };
}

/** Vecteurs écran, en pixels, pour un mètre vers l'est et un mètre vers le nord. */
function screenBasis(map) {
  const center = map.getCenter();
  const metersPerDegLat = 111132;
  const metersPerDegLon = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const span = 200; // on mesure sur 200 m pour limiter l'erreur d'arrondi

  const origin = map.project(center);
  const eastPoint = map.project([center.lng + span / metersPerDegLon, center.lat]);
  const northPoint = map.project([center.lng, center.lat + span / metersPerDegLat]);

  return {
    east: [(eastPoint.x - origin.x) / span, (eastPoint.y - origin.y) / span],
    north: [(northPoint.x - origin.x) / span, (northPoint.y - origin.y) / span],
  };
}
