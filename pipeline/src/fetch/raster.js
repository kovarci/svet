import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CACHE_DIR } from '../lib/http.js';

/**
 * Récupération de grilles de flottants depuis les services WMS de l'IGN.
 *
 * La Géoplateforme sert ces couches au format BIL 32 bits : une simple suite de
 * flottants, qu'il suffit de lire telle quelle. Ni décodage d'image, ni GDAL.
 *
 * Le service plafonne chaque requête à environ 2 000 pixels de côté, alors
 * qu'une zone comme le Marais en demande 4 600 × 3 300. On découpe donc en
 * dalles qu'on recoud, en veillant à ce que chaque sous-emprise corresponde
 * exactement à ses colonnes et lignes de pixels — un décalage d'un demi-pixel
 * décalerait toutes les ombres.
 */
const WMS = 'https://data.geopf.fr/wms-r/wms';

/** Limite prudente sous le plafond du service. */
const MAX_TILE = 1800;

/**
 * Dalles demandées de front à la Géoplateforme, par couche.
 *
 * Quatre, et non pas toutes : plusieurs cellules se construisent déjà en
 * parallèle, et le produit des deux est ce que voit le service. Quatre dalles ×
 * quatre cellules font seize requêtes simultanées — de quoi remplir le lien
 * sans se comporter en dénégation de service contre un service public gratuit.
 */
const TILE_CONCURRENCY = 4;

export const LAYERS = {
  /** Terrain nu, RGE ALTI. Couverture nationale, maille métrique. */
  terrain: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
  /** Sommet des objets, LiDAR HD : toitures réelles, houppiers, murs, kiosques. */
  lidarSurface: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  /** Hauteur au-dessus du sol, LiDAR HD. */
  lidarHeight: 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
};

/**
 * @param {object} p
 * @param {string} p.layer nom de couche WMS
 * @param {[number, number, number, number]} p.bbox [ouest, sud, est, nord]
 * @param {number} p.targetRes résolution visée, en mètres par pixel
 * @param {number} [p.maxSide] plafond de la grille assemblée
 * @param {string} [p.label] nom affiché en cas d'échec
 * @returns {Promise<{width: number, height: number, data: Float32Array, bbox: number[]} | null>}
 *   `null` si le service est injoignable ou la couche absente sur l'emprise.
 */
export async function fetchFloatRaster({ layer, bbox, targetRes, maxSide = 6000, label }) {
  const [west, south, east, north] = bbox;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const widthM = (east - west) * 111320 * Math.cos(midLat);
  const heightM = (north - south) * 111132;

  const width = Math.min(maxSide, Math.max(2, Math.round(widthM / targetRes)));
  const height = Math.min(maxSide, Math.max(2, Math.round(heightM / targetRes)));
  const data = new Float32Array(width * height);
  /**
   * 1 là où le service a livré une mesure.
   *
   * Le LiDAR HD n'a pas volé partout : sondée sur 48 points d'Île-de-France, la
   * couverture s'arrête net à l'ouest du Hurepoix et laisse une bande vide entre
   * Meaux et Coulommiers. Le service répond quand même — code 200, dalle de la
   * bonne taille — avec −9999 dans chaque pixel.
   *
   * Sans ce masque, l'absence était indiscernable d'un sol à l'altitude zéro :
   * on obtenait une plaine parfaitement plate, sans un bâtiment, et un indice
   * d'ensoleillement maximal partout. C'est le pire mode de défaillance
   * possible ici — une réponse plausible et fausse, sur les zones précisément
   * où l'on n'a rien mesuré.
   */
  const valid = new Uint8Array(width * height);

  const cols = Math.ceil(width / MAX_TILE);
  const rows = Math.ceil(height / MAX_TILE);

  const jobs = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = Math.floor((tx * width) / cols);
      const x1 = Math.floor(((tx + 1) * width) / cols);
      const y0 = Math.floor((ty * height) / rows);
      const y1 = Math.floor(((ty + 1) * height) / rows);
      if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;

      jobs.push({
        x0,
        y0,
        tileWidth: x1 - x0,
        tileHeight: y1 - y0,
        // Sous-emprise calée sur les bords de pixels, et non sur leurs centres.
        sub: [
          west + (x0 / width) * (east - west),
          north - (y1 / height) * (north - south),
          west + (x1 / width) * (east - west),
          north - (y0 / height) * (north - south),
        ],
      });
    }
  }

  const total = jobs.length;
  let done = 0;
  let failed = false;
  let next = 0;

  /**
   * Les dalles se demandaient une par une.
   *
   * Mesuré pendant la construction régionale : 0,5 % de processeur sur douze
   * cœurs, et 15,9 Mbit/s sur un lien qui en annonce 866. Ni le calcul ni la
   * bande passante ne limitaient quoi que ce soit — on passait le temps à
   * attendre, un aller-retour après l'autre. Une cellule dense demande neuf
   * dalles par couche et deux couches : dix-huit attentes en file.
   *
   * Le service rend chaque dalle en plusieurs secondes (il la calcule), et rien
   * n'oblige à les lui demander l'une après l'autre. La concurrence reste
   * modérée : c'est un service public, et plusieurs cellules tournent déjà de
   * front.
   */
  const worker = async () => {
    while (next < jobs.length && !failed) {
      const job = jobs[next++];
      const tile = await fetchTile(layer, job.sub, job.tileWidth, job.tileHeight, label);
      if (!tile) {
        failed = true;
        return;
      }
      for (let row = 0; row < job.tileHeight; row++) {
        const from = row * job.tileWidth;
        const to = (job.y0 + row) * width + job.x0;
        data.set(tile.values.subarray(from, from + job.tileWidth), to);
        valid.set(tile.valid.subarray(from, from + job.tileWidth), to);
      }
      done++;
      // Le retour chariot n'a de sens que sur un terminal : redirigé dans un
      // fichier, il empile les lignes de progression au lieu de les remplacer.
      if (total > 1 && process.stdout.isTTY) {
        process.stdout.write(`\r     ${label ?? layer} : dalle ${done}/${total}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(TILE_CONCURRENCY, jobs.length) }, worker),
  );
  if (failed) return null;
  if (total > 1 && process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(50) + '\r');

  let measured = 0;
  for (let i = 0; i < valid.length; i++) measured += valid[i];

  return { width, height, data, valid, bbox, coverage: measured / valid.length };
}

async function fetchTile(layer, bbox, width, height, label) {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    // En WMS 1.3.0 et EPSG:4326, l'ordre des axes est latitude puis longitude.
    CRS: 'EPSG:4326',
    BBOX: `${south},${west},${north},${east}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/x-bil;bits=32',
  });

  const url = `${WMS}?${params}`;
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `raster-${key}.bin`);

  let buffer;
  try {
    buffer = await readFile(cacheFile);
  } catch {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'svet/0.1 (carte lumière Paris)' },
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('bil')) throw new Error(`type inattendu « ${type} »`);
      buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, buffer);
    } catch (error) {
      process.stdout.write(`\n  ⚠ ${label ?? layer} indisponible (${error.message})\n`);
      return null;
    }
  }

  if (buffer.length < width * height * 4) {
    process.stdout.write(`\n  ⚠ ${label ?? layer} : dalle tronquée\n`);
    return null;
  }

  const values = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let i = 0; i < values.length; i++) {
    const value = buffer.readFloatLE(i * 4);
    // Le service code l'absence de donnée par une valeur très négative (−9999).
    const known = value > -1000 && value < 5000;
    values[i] = known ? value : 0;
    valid[i] = known ? 1 : 0;
  }
  return { values, valid };
}

/**
 * Valeur interpolée à une position géographique.
 * La grille WMS est orientée nord en haut, d'où l'inversion de l'axe vertical.
 */
export function sampleRaster(raster, lon, lat) {
  if (!raster) return 0;
  const [west, south, east, north] = raster.bbox;
  const { width, height, data } = raster;

  const fx = ((lon - west) / (east - west)) * (width - 1);
  const fy = ((north - lat) / (north - south)) * (height - 1);

  const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
  const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Le relevé a-t-il mesuré quelque chose ici ?
 *
 * Au plus proche voisin, et non par interpolation : à la lisière d'une dalle
 * LiDAR, une moyenne pondérée donnerait « à moitié mesuré », qui ne veut rien
 * dire. On veut une réponse franche, pour décider quel modèle appliquer.
 */
export function sampleValid(raster, lon, lat) {
  if (!raster?.valid) return false;
  const [west, south, east, north] = raster.bbox;
  const { width, height, valid } = raster;

  const x = Math.round(((lon - west) / (east - west)) * (width - 1));
  const y = Math.round(((north - lat) / (north - south)) * (height - 1));
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return valid[y * width + x] === 1;
}
