import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import { CACHE_DIR } from '../lib/http.js';

/**
 * Photographies aériennes orthorectifiées de l'IGN (BD ORTHO®), et leurs dates
 * de prise de vue.
 *
 * Elles servent à *valider* le modèle : les ombres y sont visibles, et la
 * géométrie du soleil qui les a produites est calculable. C'est la seule
 * confrontation au réel possible sans sortir avec un appareil de mesure.
 *
 * https://geoservices.ign.fr/bdortho — licence ouverte Etalab.
 */
const WMS = 'https://data.geopf.fr/wms-r/wms';
const WFS = 'https://data.geopf.fr/wfs/ows';
const ORTHO_LAYER = 'ORTHOIMAGERY.ORTHOPHOTOS';
const MOSAIC_GRAPH = 'ORTHOIMAGERY.ORTHOPHOTOS.GRAPHE-MOSAIQUAGE:graphe_bdortho';

/**
 * Dates de vol couvrant une emprise, les plus probables d'abord.
 *
 * Le graphe de mosaïquage donne la date du vol, **jamais l'heure** — d'où toute
 * la démarche de `validate-shadows.js`, qui retrouve l'heure à partir des
 * ombres au lieu de la lire quelque part.
 *
 * @returns {Promise<{date: string, resolution: number, source: string}[]>}
 */
export async function fetchFlightDates(bbox) {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: MOSAIC_GRAPH,
    COUNT: '30',
    // Forme URN : l'ordre des axes y est latitude puis longitude, comme le
    // veut la norme. La forme courte « EPSG:4326 » n'est pas honorée ici.
    BBOX: `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`,
    OUTPUTFORMAT: 'application/json',
  });

  const response = await fetch(`${WFS}?${params}`, {
    headers: { 'User-Agent': 'svet/0.1 (validation ombres)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`WFS a répondu ${response.status}`);

  const data = await response.json();
  const seen = new Map();
  for (const feature of data.features ?? []) {
    const properties = feature.properties ?? {};
    const date = String(properties.date_vol ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // Un même vol revient sur plusieurs dalles ; on ne le garde qu'une fois.
    if (!seen.has(date)) {
      seen.set(date, {
        date,
        resolution: properties.res ? properties.res / 100 : null,
        source: `BD ORTHO ${properties.pva ?? ''}`.trim(),
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Image orthorectifiée d'une emprise, décodée en luminance.
 *
 * @param {[number, number, number, number]} bbox [ouest, sud, est, nord]
 * @param {number} targetRes résolution visée, en mètres par pixel
 * @returns {Promise<{width: number, height: number, luminance: Float32Array,
 *   rgb: Uint8Array, bbox: number[]}>}
 */
export async function fetchOrtho(bbox, targetRes = 1, maxSide = 2000) {
  const [west, south, east, north] = bbox;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const widthM = (east - west) * 111320 * Math.cos(midLat);
  const heightM = (north - south) * 111132;

  const width = Math.min(maxSide, Math.max(2, Math.round(widthM / targetRes)));
  const height = Math.min(maxSide, Math.max(2, Math.round(heightM / targetRes)));

  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: ORTHO_LAYER,
    STYLES: '',
    // WMS 1.3.0 en EPSG:4326 : latitude d'abord.
    CRS: 'EPSG:4326',
    BBOX: `${south},${west},${north},${east}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
  });

  const url = `${WMS}?${params}`;
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `ortho-${key}.png`);

  let buffer;
  try {
    buffer = await readFile(cacheFile);
  } catch {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'svet/0.1 (validation ombres)' },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`WMS ortho a répondu ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, buffer);
  }

  const image = PNG.sync.read(buffer);
  const pixels = image.width * image.height;
  const luminance = new Float32Array(pixels);
  const rgb = new Uint8Array(pixels * 3);

  for (let i = 0; i < pixels; i++) {
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    // Luminance relative (Rec. 709) : c'est la clarté perçue, celle qui
    // distingue une zone d'ombre d'une zone éclairée.
    luminance[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  return { width: image.width, height: image.height, luminance, rgb, bbox };
}

/** Écrit une image RGB brute en PNG. */
export async function writePNG(filePath, width, height, rgb) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[i * 3];
    png.data[i * 4 + 1] = rgb[i * 3 + 1];
    png.data[i * 4 + 2] = rgb[i * 3 + 2];
    png.data[i * 4 + 3] = 255;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, PNG.sync.write(png));
}
