/**
 * Appariement géométrique des trottoirs cartographiés et des axes de rue.
 *
 * ── Le problème ────────────────────────────────────────────────────────────
 * OpenStreetMap décrit les trottoirs parisiens de deux façons, mélangées :
 *
 *  - **Géométrie propre** : `highway=footway` + `footway=sidewalk`, une ligne
 *    qui longe la rue. 2 737 km à Paris, davantage que les 2 470 km d'axes —
 *    ce qui est normal, un trottoir de chaque côté.
 *  - **Simple mention** : `sidewalk=both|left|right` posé sur la rue. Aucune
 *    géométrie, seulement une existence.
 *
 * Tant que le pipeline traitait les deux comme des tronçons ordinaires, une rue
 * dont les trottoirs sont cartographiés produisait **trois** chemins parallèles :
 * les deux vrais trottoirs, plus l'axe et ses deux trottoirs déduits. Le
 * calculateur pouvait donc « rester du bon côté » en marchant sur la chaussée.
 *
 * ── Deux appariements, pas un ──────────────────────────────────────────────
 * Mesuré sur Paris entier (`survey-sidewalks.mjs`) :
 *
 *  - 42,3 % des axes sont doublés **des deux côtés** (1 387 km), 19,8 % d'un
 *    seul, 37,8 % d'aucun. Un graphe purement trottoir serait donc troué sur
 *    plus du tiers de la ville : il faut un traitement mixte, côté par côté.
 *  - **0,6 % des trottoirs portent un nom.** Faire du trottoir l'arête sans
 *    rien d'autre ferait dire au guidage « cheminement » là où il disait « rue
 *    de Rivoli ». Le trottoir doit donc hériter du nom de son axe.
 *
 * D'où deux interrogations symétriques sur le même index : de l'axe vers ses
 * côtés couverts, et du trottoir vers sa rue mère.
 *
 * ── Pourquoi géométrique ───────────────────────────────────────────────────
 * OSM ne relie pas un trottoir à sa rue par une relation. On cherche donc, le
 * long de la ligne, une voisine assez proche **et assez parallèle** pour être
 * la bonne. Le filtre de parallélisme n'est pas décoratif : sans lui, chaque
 * passage clouté ferait croire à un trottoir des deux côtés à la fois.
 */

/** Distance maximale entre un axe et son trottoir, en mètres. */
const MAX_DISTANCE = 14;

/** Un trottoir longe sa rue : au-delà de ~35° d'écart, ce n'en est pas un. */
const MIN_PARALLEL = 0.82;

/** En deçà de cette part de points appariés, le côté est considéré nu. */
const MIN_SHARE = 0.55;

/** Maille de l'index spatial, en mètres. */
const CELL_M = 35;

/** Une voie qui est un trottoir cartographié, avec sa propre géométrie. */
export function isMappedSidewalk(tags = {}) {
  return tags.highway === 'footway' && tags.footway === 'sidewalk';
}

/** Les classes de voirie susceptibles de porter des trottoirs. */
const STREET_CLASSES = new Set([
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'residential',
  'unclassified',
  'living_street',
  'road',
]);

export function isStreetAxis(tags = {}) {
  return STREET_CLASSES.has(tags.highway);
}

/**
 * Ce que la rue **déclare** porter, faute de géométrie.
 *
 * 11 683 rues parisiennes portent `sidewalk=both|left|right|no|separate` sans
 * qu'aucun trottoir ne soit dessiné. C'est moins riche qu'une géométrie — on ne
 * sait ni où ni comment — mais ça suffit à ne pas **inventer** un trottoir du
 * côté où la rue dit qu'il n'y en a pas, ce que faisait le calcul jusqu'ici.
 *
 * `separate` mérite un sort particulier : la rue affirme que ses trottoirs sont
 * cartographiés à part. Si l'appariement géométrique ne les a pas trouvés,
 * c'est qu'ils manquent ou qu'ils sont trop loin — on la croit quand même, et
 * on ne double pas.
 *
 * @returns {{left: boolean, right: boolean, separate: boolean}|null} côtés
 *   déclarés **absents**, ou `null` si la rue ne dit rien.
 */
export function declaredAbsent(tags = {}) {
  const raw = String(tags.sidewalk ?? '').trim().toLowerCase();
  const prefixed = (side) => {
    const value = String(tags[`sidewalk:${side}`] ?? '').trim().toLowerCase();
    return value === 'no' || value === 'none';
  };

  if (raw === 'separate') return { left: true, right: true, separate: true };
  if (raw === 'no' || raw === 'none') return { left: false, right: false, separate: false };
  if (raw === 'both') return { left: false, right: false, separate: false };
  if (raw === 'left') return { left: false, right: true, separate: false };
  if (raw === 'right') return { left: true, right: false, separate: false };

  const left = prefixed('left');
  const right = prefixed('right');
  if (left || right) return { left, right, separate: false };
  return null;
}

/**
 * Indexe des voies en arêtes, pour interrogation par proximité.
 *
 * On stocke des **arêtes** et non des sommets : un trottoir droit de 80 m n'a
 * que deux points, et chercher le sommet le plus proche le manquerait presque
 * partout. La distance se mesure donc au segment.
 *
 * @param {(tags: object) => boolean} keep filtre sur les étiquettes
 * @param {(way: object) => object} [payload] ce que l'arête retient de sa voie
 */
export function buildEdgeIndex(ways, projection, keep, payload = () => null) {
  const cells = new Map();
  let count = 0;

  for (const way of ways) {
    if (!keep(way.tags ?? {})) continue;
    const geometry = way.geometry;
    if (!geometry || geometry.length < 2) continue;

    const carried = payload(way);

    for (let i = 1; i < geometry.length; i++) {
      const [ax, ay] = projection.forward(geometry[i - 1].lon, geometry[i - 1].lat);
      const [bx, by] = projection.forward(geometry[i].lon, geometry[i].lat);
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length < 0.5) continue;

      const edge = { ax, ay, dx, dy, length, ux: dx / length, uy: dy / length, carried };
      count++;

      // Une arête est déposée dans toutes les mailles qu'elle traverse : sans
      // cela, une arête longue ne serait trouvée qu'à ses extrémités.
      const steps = Math.max(1, Math.ceil(length / (CELL_M - 10)));
      for (let s = 0; s <= steps; s++) {
        const key = cellKey(ax + (dx * s) / steps, ay + (dy * s) / steps);
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, (bucket = []));
        if (bucket[bucket.length - 1] !== edge) bucket.push(edge);
      }
    }
  }

  return { cells, count };
}

/**
 * De quel côté de cet axe trouve-t-on un trottoir cartographié ?
 *
 * @param {{x:number,y:number,dx:number,dy:number}[]} samples points le long de
 *   l'axe, avec la direction locale de la voie.
 */
export function coverageAlong(index, samples) {
  const empty = { left: false, right: false, leftShare: 0, rightShare: 0 };
  if (index.count === 0 || samples.length === 0) return empty;

  let leftHits = 0;
  let rightHits = 0;

  for (const sample of samples) {
    const heading = Math.hypot(sample.dx, sample.dy);
    if (heading < 1e-9) continue;
    const ux = sample.dx / heading;
    const uy = sample.dy / heading;

    let bestLeft = Infinity;
    let bestRight = Infinity;

    for (const edge of nearbyEdges(index, sample.x, sample.y)) {
      if (Math.abs(edge.ux * ux + edge.uy * uy) < MIN_PARALLEL) continue;
      const { distance, px, py } = pointToEdge(sample.x, sample.y, edge);
      if (distance > MAX_DISTANCE) continue;

      // Produit vectoriel : positif à gauche du sens de la voie. Le sens d'une
      // voie OSM est arbitraire, mais il est le même pour les deux côtés — ce
      // qui suffit, puisqu'on ne s'en sert qu'à les distinguer l'un de l'autre.
      const side = ux * (py - sample.y) - uy * (px - sample.x);
      if (side > 0) bestLeft = Math.min(bestLeft, distance);
      else bestRight = Math.min(bestRight, distance);
    }

    if (bestLeft <= MAX_DISTANCE) leftHits++;
    if (bestRight <= MAX_DISTANCE) rightHits++;
  }

  const leftShare = leftHits / samples.length;
  const rightShare = rightHits / samples.length;
  return { left: leftShare >= MIN_SHARE, right: rightShare >= MIN_SHARE, leftShare, rightShare };
}

/**
 * À quelle rue appartient ce trottoir ?
 *
 * On vote sur les points échantillonnés plutôt que de prendre la plus proche en
 * un seul endroit : un trottoir passe souvent devant un croisement, où l'axe le
 * plus proche est momentanément la rue perpendiculaire.
 *
 * @returns {{name: string|null, highway: string|null, share: number}|null}
 */
export function parentStreet(index, samples) {
  if (index.count === 0 || samples.length === 0) return null;

  const votes = new Map();
  let voted = 0;

  for (const sample of samples) {
    const heading = Math.hypot(sample.dx, sample.dy);
    if (heading < 1e-9) continue;
    const ux = sample.dx / heading;
    const uy = sample.dy / heading;

    let best = null;
    let bestDistance = MAX_DISTANCE;

    for (const edge of nearbyEdges(index, sample.x, sample.y)) {
      if (!edge.carried) continue;
      if (Math.abs(edge.ux * ux + edge.uy * uy) < MIN_PARALLEL) continue;
      const { distance } = pointToEdge(sample.x, sample.y, edge);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = edge.carried;
      }
    }

    if (!best) continue;
    voted++;
    const key = `${best.name ?? ''} ${best.highway ?? ''}`;
    const entry = votes.get(key);
    if (entry) entry.n++;
    else votes.set(key, { n: 1, value: best });
  }

  if (voted === 0) return null;
  let winner = null;
  for (const entry of votes.values()) if (!winner || entry.n > winner.n) winner = entry;
  return { ...winner.value, share: winner.n / samples.length };
}

/**
 * Échantillonne une polyligne projetée, en portant la direction locale.
 *
 * @param {[number, number][]} points coordonnées projetées, en mètres
 * @param {number} step pas d'échantillonnage, en mètres
 */
export function sampleWithHeading(points, step) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const steps = Math.max(1, Math.round(length / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: ax + dx * t, y: ay + dy * t, dx, dy });
    }
  }
  if (points.length >= 2) {
    const [ax, ay] = points.at(-2);
    const [bx, by] = points.at(-1);
    out.push({ x: bx, y: by, dx: bx - ax, dy: by - ay });
  }
  return out;
}

/** Les arêtes des neuf mailles autour d'un point. */
function* nearbyEdges(index, x, y) {
  const seen = new Set();
  const cx = Math.round(x / CELL_M);
  const cy = Math.round(y / CELL_M);
  for (let ix = -1; ix <= 1; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      const bucket = index.cells.get(`${cx + ix},${cy + iy}`);
      if (!bucket) continue;
      for (const edge of bucket) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        yield edge;
      }
    }
  }
}

/** Distance d'un point au segment, et le point projeté. */
function pointToEdge(x, y, edge) {
  const t = Math.max(
    0,
    Math.min(1, ((x - edge.ax) * edge.dx + (y - edge.ay) * edge.dy) / (edge.length * edge.length)),
  );
  const px = edge.ax + edge.dx * t;
  const py = edge.ay + edge.dy * t;
  return { distance: Math.hypot(x - px, y - py), px, py };
}

function cellKey(x, y) {
  return `${Math.round(x / CELL_M)},${Math.round(y / CELL_M)}`;
}
