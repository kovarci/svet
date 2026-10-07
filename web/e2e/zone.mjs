/**
 * Zones synthétiques pour les tests de bout en bout.
 *
 * Une grille de rues autour du Louvre, écrite par les **vrais** écrivains du
 * pipeline — `writeTiles`, `writeData`, `buildGraph` — et non par une copie de
 * leur format : un test qui fabriquerait ses fichiers à la main validerait sa
 * propre idée du format, pas celle que l'application lit.
 *
 * Seize carrefours de côté, soit 256 nœuds : `nearestNode` écarte les réseaux de
 * moins de deux cents nœuds, et une grille plus petite ne s'accrocherait à rien.
 * Les expositions sont tranchées — rues paires au soleil, impaires à l'ombre —
 * pour que l'itinéraire abrité et l'itinéraire rapide divergent.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildGraph, writeData, writeTiles } from '../../pipeline/src/pack.js';
import { CONFIG } from '../../pipeline/src/config.js';
import { SCALE } from '../../pipeline/src/model.js';
import {
  applyRefraction,
  localDate,
  localToUTC,
  sunPosition,
  DEG,
} from '../../pipeline/src/lib/sun.js';

export const ORIGIN = [2.3376, 48.8606];
export const SIDE = 16;

const EAST_WEST = [
  'Quai du Louvre',
  'Rue de Rivoli',
  'Rue Saint-Honoré',
  'Rue du Louvre',
  'Rue Berger',
  'Rue des Halles',
  'Rue de la Ferronnerie',
  'Rue Rambuteau',
  'Rue Montorgueil',
  'Rue Étienne-Marcel',
  'Rue Tiquetonne',
  'Rue Greneta',
  'Rue du Caire',
  'Rue de Cléry',
  'Rue Réaumur',
  'Rue du Sentier',
];
const NORTH_SOUTH = [
  'Rue de l’Arbre-Sec',
  'Rue des Bourdonnais',
  'Rue du Pont-Neuf',
  'Rue Sauval',
  'Rue Vauvilliers',
  'Rue du Roule',
  'Rue des Prouvaires',
  'Rue de Viarmes',
  'Rue Coquillière',
  'Rue du Jour',
  'Rue Mandar',
  'Rue Saint-Denis',
  'Rue Quincampoix',
  'Rue Beaubourg',
  'Rue du Temple',
  'Rue Vieille-du-Temple',
];

/**
 * Écrit une zone dans `dataDir` et l'ajoute à `zones.json`.
 *
 * @param {string} dataDir dossier `data/` servi par l'application
 * @param {object} [options]
 * @param {string} [options.key]
 * @param {string} [options.label]
 * @param {boolean} [options.flat] exposition constante dans la journée
 */
export async function writeZone(
  dataDir,
  { key = 'synthese', label = 'Synthèse — Louvre', flat = false } = {},
) {
  const [lon0, lat0] = ORIGIN;
  const dLon = 100 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const dLat = 100 / 111132;
  const date = localDate();
  const bins = CONFIG.horizonBins;

  const times = [];
  for (let m = CONFIG.hourStart * 60; m <= CONFIG.hourEnd * 60; m += CONFIG.stepMinutes) {
    const h = Math.floor(m / 60);
    const raw = sunPosition(localToUTC(date, h, m % 60), lat0, lon0);
    times.push({
      minutes: m,
      label: `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
      altitude: Number((applyRefraction(raw.altitude) * DEG).toFixed(2)),
      azimuth: Number((raw.azimuth * DEG).toFixed(1)),
    });
  }

  const series = (sunny, phase) =>
    times.map((t) =>
      flat
        ? Math.round(sunny / 3)
        : t.altitude <= 0
          ? 0
          : Math.round(sunny * Math.max(0, Math.sin(((t.minutes - 300 + phase) / 1020) * Math.PI))),
    );
  const horizon = (open) =>
    Array.from({ length: bins }, (_, k) => (open ? 10 + (k % 4) * 3 : 45 + (k % 5) * 4));

  const at = (i, j) => [lon0 + (j - SIDE / 2) * dLon, lat0 + (i - SIDE / 2) * dLat];
  const segments = [];
  const features = [];
  const add = (coords, name, sunnyLeft, sunnyRight, open) => {
    const id = segments.length;
    segments.push({
      coords,
      record: {
        name,
        highway: 'residential',
        crossing: false,
        covered: false,
        shared: false,
        length: 100,
        width: 12,
        lOff: 5,
        rOff: 5,
        lSide: 'nord',
        rSide: 'sud',
        lSvf: open ? 60 : 25,
        rSvf: open ? 55 : 22,
        lVeil: 40,
        rVeil: 60,
        lit: true,
        lWork: 0,
        rWork: 0,
        lCanopy: open ? 0 : 30,
        rCanopy: open ? 5 : 40,
        lSun: series(sunnyLeft, 0),
        rSun: series(sunnyRight, 60),
        lFlick: series(open ? 5 : 20, 0),
        rFlick: series(open ? 5 : 25, 0),
        lHor: horizon(open),
        rHor: horizon(open),
      },
    });
    features.push({
      type: 'Feature',
      properties: { id, lOff: 5, rOff: 5 },
      geometry: { type: 'LineString', coordinates: coords },
    });
  };

  for (let i = 0; i < SIDE; i++) {
    for (let j = 0; j < SIDE - 1; j++) {
      const open = i % 2 === 0;
      add([at(i, j), at(i, j + 1)], EAST_WEST[i], open ? 95 : 20, open ? 70 : 10, open);
    }
  }
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE - 1; i++) {
      const open = j % 3 === 0;
      add([at(i, j), at(i + 1, j)], NORTH_SOUTH[j], open ? 85 : 15, open ? 80 : 12, open);
    }
  }

  const buildings = { type: 'FeatureCollection', features: [] };
  for (let i = 0; i < SIDE - 1; i++) {
    for (let j = 0; j < SIDE - 1; j++) {
      const [x0, y0] = at(i, j);
      const m = 0.18;
      const ring = [
        [x0 + dLon * m, y0 + dLat * m],
        [x0 + dLon * (1 - m), y0 + dLat * m],
        [x0 + dLon * (1 - m), y0 + dLat * (1 - m)],
        [x0 + dLon * m, y0 + dLat * (1 - m)],
        [x0 + dLon * m, y0 + dLat * m],
      ];
      buildings.features.push({
        type: 'Feature',
        properties: { h: 12 + ((i * 7 + j * 5) % 20) },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }

  const [west, south] = at(-0.5, -0.5);
  const [east, north] = at(SIDE - 0.5, SIDE - 0.5);
  const bbox = [west, south, east, north].map((v) => Number(v.toFixed(6)));
  const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

  await mkdir(dataDir, { recursive: true });
  const tiles = await writeTiles(
    path.join(dataDir, key),
    { type: 'FeatureCollection', features },
    buildings,
    bbox,
  );
  const graph = buildGraph(segments);
  await writeData(dataDir, key, {
    segments: segments.map((s) => s.record),
    timeSteps: times.length,
    horizonBins: bins,
    graph,
  });

  const generatedAt = new Date().toISOString();
  const meta = {
    zone: key,
    kind: 'zone',
    label,
    bbox,
    center,
    date,
    resolution: 1,
    surfaceModel: 'synthétique',
    lidarCoverage: null,
    tiles: {
      minZoom: tiles.minZoom,
      maxZoom: tiles.maxZoom,
      count: tiles.tiles,
      bounds: tiles.bounds,
    },
    segmentCount: segments.length,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    weights: CONFIG.weights,
    albedo: CONFIG.albedo,
    groundAlbedo: CONFIG.groundAlbedo,
    luxReference: CONFIG.luxReference,
    horizonBins: bins,
    walkingSpeed: CONFIG.walkingSpeed,
    crossingPenalty: CONFIG.crossingPenalty,
    scale: SCALE,
    times,
    counts: {},
    sources: [],
    generatedAt,
  };
  await writeFile(path.join(dataDir, `${key}.meta.json`), JSON.stringify(meta));

  let zones = [];
  try {
    zones = JSON.parse(await readFile(path.join(dataDir, 'zones.json'), 'utf8'));
  } catch {
    // première zone
  }
  zones = zones.filter((z) => z.key !== key);
  zones.push({
    key,
    label,
    bbox,
    center,
    date,
    stamp: generatedAt.replace(/\D/g, '').slice(0, 14),
  });
  await writeFile(path.join(dataDir, 'zones.json'), JSON.stringify(zones));
  return { key, bbox, center, segments: segments.length, nodes: graph.nodeCount };
}
