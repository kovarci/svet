/**
 * Aller-retour des tuiles vectorielles : ce que `writeTiles` écrit, MapLibre
 * le relit-il ?
 *
 * Même argument que pour le binaire. Une tuile mal formée ne plante pas
 * toujours : un identifiant perdu et `feature-state` ne colore plus rien — les
 * rues restent du gris du zéro, ce qui se lit « pas de données » et non
 * « défaut ». Un décalage de trottoir perdu et les deux côtés se superposent.
 *
 * On relit avec le décodeur de MapLibre lui-même (`@mapbox/vector-tile`), et
 * non avec celui qui a servi à écrire : c'est l'accord entre les deux qui
 * compte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { writeTiles } from '../src/pack.js';
import { tileOf } from '../src/lib/tiles.js';

const line = (id, coordinates, extra = {}) => ({
  type: 'Feature',
  properties: { id, lOff: 4 + id, rOff: 6 - id, ...extra },
  geometry: { type: 'LineString', coordinates },
});

/**
 * Trois tronçons autour du Louvre, coudés pour que le sommet du milieu
 * survive à la simplification, et un immeuble. Le premier porte des champs
 * que les tuiles ne doivent pas transporter : ils vivent dans le binaire.
 */
const network = {
  type: 'FeatureCollection',
  features: [
    line(
      0,
      [
        [2.3352, 48.8604],
        [2.3368, 48.8611],
        [2.3384, 48.8606],
      ],
      { name: 'Rue de Rivoli', lSun: [1, 2, 3] },
    ),
    line(1, [
      [2.3384, 48.8606],
      [2.3391, 48.8597],
      [2.3402, 48.8592],
    ]),
    line(2, [
      [2.3352, 48.8604],
      [2.3358, 48.8593],
      [2.3371, 48.8588],
    ]),
  ],
};

const buildings = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { h: 24 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [2.336, 48.8598],
            [2.3372, 48.8598],
            [2.3372, 48.8604],
            [2.336, 48.8604],
            [2.336, 48.8598],
          ],
        ],
      },
    },
  ],
};

const bbox = [2.334, 48.858, 2.341, 48.862];

/** Écrit la pyramide, relit chaque tuile non vide d'un zoom donné. */
async function pyramid(z) {
  const dir = await mkdtemp(path.join(tmpdir(), 'svet-tuiles-'));
  try {
    const written = await writeTiles(dir, network, buildings, bbox);
    const [x0, y0] = tileOf(bbox[0], bbox[3], z);
    const [x1, y1] = tileOf(bbox[2], bbox[1], z);
    const tiles = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const buffer = await readFile(path.join(dir, String(z), String(x), `${y}.pbf`));
        tiles.push({ x, y, bytes: buffer.length, tile: new VectorTile(new PbfReader(buffer)) });
      }
    }
    const files = {};
    for (const level of await readdir(dir)) {
      let count = 0;
      for (const column of await readdir(path.join(dir, level))) {
        count += (await readdir(path.join(dir, level, column))).length;
      }
      files[level] = count;
    }
    return { written, tiles, files };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Toutes les entités d'une couche, en coordonnées géographiques. */
function features(tiles, z, layer) {
  return tiles.flatMap(({ x, y, tile }) => {
    const source = tile.layers[layer];
    if (!source) return [];
    return Array.from({ length: source.length }, (_, i) => source.feature(i).toGeoJSON(x, y, z));
  });
}

test('chaque tronçon se relit au zoom maximal, avec ses décalages et rien d’autre', async () => {
  const { tiles } = await pyramid(16);
  const read = features(tiles, 16, 'reseau');

  for (const expected of network.features) {
    const { id, lOff, rOff } = expected.properties;
    const pieces = read.filter((f) => f.properties.id === id);
    assert.ok(pieces.length > 0, `tronçon ${id} absent des tuiles`);
    for (const piece of pieces) assert.deepEqual({ ...piece.properties }, { id, lOff, rOff });
  }
});

test('la géométrie retombe à sa place', async () => {
  const { tiles } = await pyramid(16);
  const read = features(tiles, 16, 'reseau');

  // Au zoom 16, un pas de grille de tuile vaut une dizaine de centimètres : un
  // mètre de marge ne laisse passer qu'une erreur de calcul, pas une tuile
  // décalée.
  const METER = 1e-5;
  for (const expected of network.features) {
    const decoded = read
      .filter((f) => f.properties.id === expected.properties.id)
      .flatMap((f) =>
        f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat(),
      );
    for (const [lon, lat] of expected.geometry.coordinates) {
      const near = decoded.some(
        ([dlon, dlat]) => Math.abs(dlon - lon) < METER && Math.abs(dlat - lat) < METER,
      );
      assert.ok(near, `sommet ${lon}, ${lat} du tronçon ${expected.properties.id} perdu`);
    }
  }
});

test('le bâti garde sa hauteur, toute la pyramide est écrite', async () => {
  const { written, tiles, files } = await pyramid(16);

  const bati = features(tiles, 16, 'bati');
  assert.ok(bati.length > 0, 'immeuble absent des tuiles');
  for (const building of bati) assert.equal(building.properties.h, 24);

  // Une case sans données s'écrit quand même, à zéro octet : absente, un
  // serveur d'application à page unique répondrait `index.html` à sa place.
  assert.ok(tiles.some((t) => t.bytes === 0));
  assert.deepEqual(
    Object.keys(files)
      .map(Number)
      .sort((a, b) => a - b),
    [11, 12, 13, 14, 15, 16],
  );
  assert.equal(
    Object.values(files).reduce((a, b) => a + b, 0),
    written.tiles,
  );
});
