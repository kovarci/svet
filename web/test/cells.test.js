/**
 * Le chargement d'une région par cellules.
 *
 * Deux mécanismes s'y jouent, et tous deux échouent en silence :
 *
 *  - **La couture des graphes.** Deux cellules voisines décrivent le même
 *    carrefour ; si l'on ne reconnaît pas qu'il s'agit du même nœud, le graphe
 *    régional se retrouve coupé net à chaque bord de cellule et l'application
 *    répond « ces deux points ne sont pas reliés » au milieu d'une avenue.
 *  - **La libération des cellules.** Une cellule dense pèse seize mégaoctets.
 *    En garder trop tue l'onglet sans message ; en garder trop peu fait
 *    retélécharger sans fin. Le compte se vérifie ici, pas en traversant l'Île-
 *    de-France à la main.
 *
 * Les cellules sont fausses : le lecteur de binaire est injecté, et rend des
 * objets minuscules qui ont la forme de ce que `decodeZoneData` produit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegionData } from '../src/cells.js';

const BITS = 20;

/**
 * Une région de quatre cellules en bande, chacune avec deux nœuds et une arête.
 *
 * Le second nœud d'une cellule a exactement les coordonnées du premier de la
 * suivante : c'est la soudure que le pipeline garantit en indexant ses nœuds au
 * micro-degré.
 */
function region(cellCount = 4) {
  const cells = Array.from({ length: cellCount }, (_, i) => ({
    key: `12-${2064 + i}-1405`,
    idBase: (i + 1) * 2 ** BITS,
    bbox: [2.0 + i * 0.1, 48.8, 2.0 + (i + 1) * 0.1, 48.9],
    segments: 1000,
    stamp: '20260807123055',
  }));

  return {
    index: {
      region: 'test',
      segmentBits: BITS,
      cells,
      times: [{ minutes: 600 }],
      horizonBins: 16,
      counts: { segments: cellCount * 1000 },
    },
    cells,
  };
}

/** Un binaire de cellule, en tout point conforme à ce qu'attend l'appelant. */
function fakeCell(i) {
  return {
    timeSteps: 1,
    horizonBins: 16,
    segmentCount: 2,
    names: [],
    segmentAt: (local) => ({ id: local, name: `Voie ${i}-${local}`, twoSided: true, len: 100 }),
    sideAt: (local, right) => ({ sun: Uint8Array.of(right ? 90 : 10), local }),
    graph: {
      size: 2,
      edgeCount: 1,
      nodeLon: Float64Array.of(2.0 + i * 0.1, 2.0 + (i + 1) * 0.1),
      nodeLat: Float64Array.of(48.85, 48.85),
      edgeA: Uint32Array.of(0),
      edgeB: Uint32Array.of(1),
      edgeSegment: Uint32Array.of(0),
      edgeLength: Float32Array.of(100),
    },
  };
}

function loaderFor(cells, log = []) {
  return (url) => {
    const rank = cells.findIndex((cell) => url.includes(cell.key));
    log.push(cells[rank].key);
    return Promise.resolve(fakeCell(rank));
  };
}

const makeData = (source, options = {}) =>
  createRegionData(source.index, { baseUrl: 'data/test/cellules/', ...options });

test('seules les cellules qui recoupent la fenêtre sont retenues', () => {
  const source = region();
  const data = makeData(source, { load: loaderFor(source.cells) });
  const found = data.cellsIn({ west: 2.05, east: 2.15, south: 48.85, north: 48.86 });
  assert.deepEqual(
    found.map((cell) => cell.key),
    [source.cells[0].key, source.cells[1].key],
  );
});

test('une cellule n’est demandée qu’une fois, même sur deux appels concurrents', async () => {
  const source = region();
  const log = [];
  const data = makeData(source, { load: loaderFor(source.cells, log) });
  const bounds = { west: 2.05, east: 2.06, south: 48.85, north: 48.86 };

  await Promise.all([data.ensure(bounds), data.ensure(bounds)]);
  await data.ensure(bounds);
  assert.equal(log.length, 1);
});

test('un identifiant régional retrouve sa cellule et son rang local', async () => {
  const source = region();
  const data = makeData(source, { load: loaderFor(source.cells) });
  await data.ensure({ west: 2.15, east: 2.16, south: 48.85, north: 48.86 });

  const id = source.cells[1].idBase + 7;
  const segment = data.segmentAt(id);
  // Le nom vient du rang local, l'identifiant rendu est celui du monde extérieur.
  assert.equal(segment.name, 'Voie 1-7');
  assert.equal(segment.id, id);
  assert.equal(data.sideAt(id, true).local, 7);
});

test('un tronçon d’une cellule absente rend null, jamais un relevé à zéro', () => {
  const source = region();
  const data = makeData(source, { load: loaderFor(source.cells) });
  // C'est la contrepartie du chargement par cellules, et le mensonge à ne pas
  // faire : un zéro se lirait « aucune gêne ».
  assert.equal(data.segmentAt(source.cells[2].idBase + 3), null);
  assert.equal(data.sideAt(source.cells[2].idBase + 3, false), null);
  assert.equal(data.declares(source.cells[2].idBase + 3), true);
});

test('les graphes des cellules voisines se recousent sur leur nœud commun', async () => {
  const source = region();
  const data = makeData(source, { load: loaderFor(source.cells) });
  await data.ensure({ west: 2.0, east: 2.25, south: 48.8, north: 48.9 });

  const merged = data.mergedGraph();
  assert.equal(merged.edgeCount, 3);
  // Quatre nœuds et non six : deux soudures ont fusionné deux paires.
  assert.equal(merged.size, 4);
  // Les arêtes se suivent : la fin de l'une est le début de la suivante.
  assert.equal(merged.edgeB[0], merged.edgeA[1]);
  assert.equal(merged.edgeB[1], merged.edgeA[2]);
});

test('le graphe recousu numérote les tronçons à l’échelle de la région', async () => {
  const source = region();
  const data = makeData(source, { load: loaderFor(source.cells) });
  await data.ensure({ west: 2.0, east: 2.25, south: 48.8, north: 48.9 });

  const merged = data.mergedGraph();
  // Chaque cellule numérote ses tronçons à partir de zéro ; sans le décalage,
  // les trois arêtes désigneraient toutes le tronçon 0 de la première.
  assert.deepEqual(
    [...merged.edgeSegment],
    source.cells.slice(0, 3).map((cell) => cell.idBase),
  );
});

test('au-delà de douze cellules, les plus anciennes sont libérées', async () => {
  const source = region(20);
  const data = makeData(source, { load: loaderFor(source.cells) });
  await data.ensure({ west: 2.0, east: 4.0, south: 48.8, north: 48.9 });

  assert.equal(data.loadedCells().length, 12);
  // Les huit premières ont été rendues ; les dernières demandées restent.
  assert.equal(data.isLoaded(source.cells[19].idBase), true);
  assert.equal(data.isLoaded(source.cells[0].idBase), false);
});

test('une cellule indisponible est signalée sans faire tomber les autres', async () => {
  const source = region();
  const data = makeData(source, {
    load: (url) =>
      url.includes(source.cells[1].key)
        ? Promise.reject(new Error('HTTP 500'))
        : Promise.resolve(fakeCell(0)),
  });

  const { added, failed } = await data.ensure({ west: 2.0, east: 2.25, south: 48.8, north: 48.9 });
  assert.equal(failed.length, 1);
  assert.equal(failed[0], source.cells[1].key);
  assert.ok(added >= 2, 'les cellules saines doivent être chargées quand même');
});

test('l’arrivée de nouvelles cellules est signalée une fois par lot', async () => {
  const source = region();
  let calls = 0;
  const data = makeData(source, {
    load: loaderFor(source.cells),
    onCellsChanged: () => calls++,
  });

  await data.ensure({ west: 2.0, east: 2.25, south: 48.8, north: 48.9 });
  assert.equal(calls, 1);
  // Rien de neuf : rien à repeindre.
  await data.ensure({ west: 2.0, east: 2.25, south: 48.8, north: 48.9 });
  assert.equal(calls, 1);
});
