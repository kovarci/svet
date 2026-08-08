/**
 * Emprises de chantier qui barrent le trottoir.
 *
 * Comme l'éclairage et le facteur de vue du ciel, la grandeur est **statique à
 * l'échelle de la journée** : un chantier ne se déplace pas entre midi et
 * quatorze heures. On la calcule donc une fois par point d'échantillonnage.
 *
 * Le test est un point-dans-polygone ordinaire, accéléré par une grille : sans
 * elle, croiser 180 000 points avec 3 000 emprises ferait 540 millions de tests.
 */

/** Maille de l'index, en mètres. */
const CELL = 60;

/**
 * Projette et indexe les emprises.
 * @param {{ring: [number,number][], category: string|null}[]} sites
 */
export function indexWorksites(sites, projection) {
  const cells = new Map();
  const shapes = [];

  for (const site of sites) {
    const ring = site.ring.map(([lon, lat]) => projection.forward(lon, lat));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const shape = { ring, minX, minY, maxX, maxY };
    const id = shapes.push(shape) - 1;

    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const key = `${cx},${cy}`;
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, (bucket = []));
        bucket.push(id);
      }
    }
  }

  return { cells, shapes, count: shapes.length };
}

/** Ce point est-il dans une emprise de chantier ? */
export function blockedAt(index, x, y) {
  if (index.count === 0) return false;
  const bucket = index.cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
  if (!bucket) return false;

  for (const id of bucket) {
    const shape = index.shapes[id];
    if (x < shape.minX || x > shape.maxX || y < shape.minY || y > shape.maxY) continue;
    if (inRing(shape.ring, x, y)) return true;
  }
  return false;
}

/** Lancer de rayon : on compte les traversées d'arêtes vers la droite. */
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
