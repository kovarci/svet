/**
 * Le calcul de ce qu'il faut télécharger pour tenir hors ligne.
 *
 * Une erreur ici ne se voit qu'au pire moment : on croit avoir préparé un
 * quartier, on part, le réseau tombe, et il manque justement les tuiles du zoom
 * auquel on marche. On fixe donc le pavage — c'est de l'arithmétique, elle doit
 * être juste — et surtout le garde-fou de volume, qui est la seule chose entre
 * l'utilisateur et un téléchargement de plusieurs gigaoctets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan, cellBytes, formatBytes, tilesInBounds } from '../src/offline.js';

const PARIS = { west: 2.32, south: 48.85, east: 2.36, north: 48.87 };

test('un seul zoom donne un pavé rectangulaire', () => {
  const tiles = tilesInBounds(PARIS, { minZoom: 14, maxZoom: 14 });
  const xs = new Set(tiles.map((t) => t.x));
  const ys = new Set(tiles.map((t) => t.y));
  assert.equal(tiles.length, xs.size * ys.size);
  assert.ok(tiles.every((t) => t.z === 14));
});

test('le pavage suit le découpage standard des tuiles', () => {
  // Paris, zoom 12 : la tuile 2074/1409 est celle du centre. Si ce chiffre
  // change, c'est le calcul qui a bougé, pas la ville.
  const tiles = tilesInBounds(
    { west: 2.35, south: 48.855, east: 2.351, north: 48.856 },
    { minZoom: 12, maxZoom: 12 },
  );
  assert.deepEqual(tiles, [{ z: 12, x: 2074, y: 1409 }]);
});

test('chaque zoom supplémentaire quadruple la surface pavée', () => {
  const one = tilesInBounds(PARIS, { minZoom: 15, maxZoom: 15 }).length;
  const two = tilesInBounds(PARIS, { minZoom: 15, maxZoom: 16 }).length;
  // À un rang de bordure près, la couche suivante en compte quatre fois plus.
  assert.ok(two > one * 4, `${two} tuiles pour deux zooms, contre ${one} pour un`);
});

test('l’axe des tuiles descend vers le sud', () => {
  // Une inversion ici passerait inaperçue sur une emprise carrée, et
  // téléchargerait le quartier d'à côté sur une emprise allongée.
  const [nord] = tilesInBounds(
    { west: 2.35, south: 48.86, east: 2.351, north: 48.861 },
    { minZoom: 14, maxZoom: 14 },
  );
  const [sud] = tilesInBounds(
    { west: 2.35, south: 48.84, east: 2.351, north: 48.841 },
    { minZoom: 14, maxZoom: 14 },
  );
  assert.ok(nord.y < sud.y);
});

test('le plan mêle relevés et tuiles, et annonce un poids', () => {
  const plan = buildPlan({
    tileUrl: 'https://exemple.fr/data/idf/tuiles/{z}/{x}/{y}.pbf?v=1',
    tiles: [
      { z: 14, x: 8298, y: 5636 },
      { z: 14, x: 8299, y: 5636 },
    ],
    data: [{ url: 'https://exemple.fr/data/idf/cellules/12-2074-1409.data.bin', bytes: 16e6 }],
  });

  assert.equal(plan.urls.length, 3);
  // Les relevés d'abord : ce sont eux qui rendent la carte lisible, et une
  // préparation interrompue doit laisser quelque chose d'utilisable.
  assert.match(plan.urls[0], /cellules/);
  assert.equal(plan.urls[1], 'https://exemple.fr/data/idf/tuiles/14/8298/5636.pbf?v=1');
  assert.ok(plan.bytes > 16e6);
  assert.equal(plan.tiles, 2);
});

test('le poids d’une cellule suit son nombre de tronçons', () => {
  assert.equal(cellBytes({ segments: 1000 }), 192000);
  // Une cellule vide est déclarée par l'index mais n'a rien à télécharger.
  assert.equal(cellBytes({}), 0);
});

test('les tailles s’annoncent en ordre de grandeur', () => {
  assert.equal(formatBytes(940), '1 ko');
  assert.equal(formatBytes(66e6), '66 Mo');
  assert.equal(formatBytes(2.7e9), '2.7 Go');
});
