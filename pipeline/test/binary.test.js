/**
 * Aller-retour du format binaire : ce qu'on écrit est-il ce qu'on relit ?
 *
 * C'est le test qui manquait. Le format a changé quatre fois en une session, et
 * chaque changement décalait l'en-tête d'un tronçon. Un décalage d'un octet ne
 * plante pas : il décale toutes les séries et l'application affiche des
 * couleurs plausibles et fausses. C'est le pire mode de défaillance possible
 * pour une application dont le seul produit est un chiffre.
 *
 * On fabrique donc une zone minuscule, on l'écrit, on la relit, et on compare
 * champ par champ. Aucun réseau, aucune donnée ouverte : le test tourne partout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeData } from '../src/pack.js';
import { decodeZoneData } from '../../web/src/binary.js';
import { CARDINALS, HIGHWAYS } from '../src/model.js';

const TIME_STEPS = 5;
const HORIZON_BINS = 4;

/** Une zone jouet : deux tronçons à un côté, un à deux côtés. */
function fixture() {
  const series = (seed) => Array.from({ length: TIME_STEPS }, (_, i) => (seed * 7 + i * 13) % 256);
  const profile = (seed) =>
    Array.from({ length: HORIZON_BINS }, (_, i) => (seed * 5 + i * 11) % 90);

  const make = (id, shared) => ({
    name: id === 1 ? null : `Rue numéro ${id}`,
    highway: HIGHWAYS[id % HIGHWAYS.length],
    crossing: id === 2,
    covered: id === 1,
    shared,
    length: 12.3 + id,
    width: id === 0 ? null : 4 + id,
    lOff: 5.2,
    rOff: 4.8,
    lSide: CARDINALS[id % 8],
    rSide: CARDINALS[(id + 4) % 8],
    lSvf: 30 + id,
    rSvf: 60 + id,
    lCanopy: 10 + id,
    rCanopy: 20 + id,
    lVeil: 123 + id,
    rVeil: 456 + id,
    lit: id !== 1,
    lWork: id * 10,
    rWork: id * 3,
    lSun: series(id),
    rSun: shared ? series(id) : series(id + 40),
    lFlick: series(id + 80),
    rFlick: shared ? series(id + 80) : series(id + 120),
    lHor: profile(id),
    rHor: shared ? profile(id) : profile(id + 3),
  });

  return [make(0, true), make(1, false), make(2, true)];
}

const graph = {
  nodeCount: 3,
  edgeCount: 2,
  nodeLon: Float32Array.from([2.35, 2.36, 2.37]),
  nodeLat: Float32Array.from([48.85, 48.86, 48.87]),
  edgeA: Uint32Array.from([0, 1]),
  edgeB: Uint32Array.from([1, 2]),
  edgeSegment: Uint32Array.from([0, 2]),
  edgeLength: Float32Array.from([41.5, 77.25]),
};

async function roundTrip() {
  const dir = await mkdtemp(path.join(tmpdir(), 'svet-test-'));
  try {
    const segments = fixture();
    await writeData(dir, 'zone', {
      segments,
      timeSteps: TIME_STEPS,
      horizonBins: HORIZON_BINS,
      graph,
    });
    const file = await readFile(path.join(dir, 'zone.data.bin'));
    const decoded = decodeZoneData(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
    return { segments, decoded };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('les attributs d’un tronçon survivent à l’aller-retour', async () => {
  const { segments, decoded } = await roundTrip();
  assert.equal(decoded.segmentCount, segments.length);

  for (let id = 0; id < segments.length; id++) {
    const source = segments[id];
    const read = decoded.segmentAt(id);

    assert.equal(read.name, source.name, `nom du tronçon ${id}`);
    assert.equal(read.hw, source.highway, `type de voie ${id}`);
    assert.equal(read.crossing, source.crossing, `traversée ${id}`);
    assert.equal(read.covered, source.covered, `couvert ${id}`);
    assert.equal(read.twoSided, !source.shared, `deux trottoirs ${id}`);
    assert.equal(read.lit, source.lit, `éclairage renseigné ${id}`);
    assert.ok(Math.abs(read.len - source.length) < 0.1, `longueur ${id}`);
    assert.equal(read.width, source.width, `largeur ${id}`);
    assert.equal(read.lSide, source.lSide, `côté gauche ${id}`);
    assert.equal(read.rSide, source.rSide, `côté droit ${id}`);
    assert.equal(read.lSvf, source.lSvf, `ouverture gauche ${id}`);
    assert.equal(read.rSvf, source.rSvf, `ouverture droite ${id}`);
    assert.equal(read.lCanopy, source.lCanopy, `couvert arboré gauche ${id}`);
    assert.equal(read.rCanopy, source.rCanopy, `couvert arboré droit ${id}`);
    assert.ok(Math.abs(read.lVeil * 100 - source.lVeil) < 1, `voile gauche ${id}`);
    assert.ok(Math.abs(read.rVeil * 100 - source.rVeil) < 1, `voile droit ${id}`);
    assert.equal(read.lWork, source.lWork, `chantier gauche ${id}`);
    assert.equal(read.rWork, source.rWork, `chantier droit ${id}`);
  }
});

test('les séries survivent, et les deux côtés ne sont pas confondus', async () => {
  const { segments, decoded } = await roundTrip();

  for (let id = 0; id < segments.length; id++) {
    const source = segments[id];
    const left = decoded.sideAt(id, false);
    const right = decoded.sideAt(id, true);

    assert.deepEqual([...left.sun], source.lSun, `série soleil gauche ${id}`);
    assert.deepEqual([...left.flicker], source.lFlick, `scintillement gauche ${id}`);
    assert.deepEqual([...left.horizon], source.lHor, `horizon gauche ${id}`);

    // C'est ici que se joue le bloc annexe : sur un tronçon à deux trottoirs,
    // le côté droit vit ailleurs dans le fichier et doit être retrouvé.
    assert.deepEqual([...right.sun], source.rSun, `série soleil droite ${id}`);
    assert.deepEqual([...right.flicker], source.rFlick, `scintillement droit ${id}`);
    assert.deepEqual([...right.horizon], source.rHor, `horizon droit ${id}`);
  }

  // Le tronçon 1 est le seul à deux trottoirs : ses deux séries doivent différer.
  const l = decoded.sideAt(1, false);
  const r = decoded.sideAt(1, true);
  assert.notDeepEqual([...l.sun], [...r.sun], 'les deux côtés doivent rester distincts');
});

test('le graphe survit à l’aller-retour', async () => {
  const { decoded } = await roundTrip();
  const g = decoded.graph;
  assert.equal(g.size, graph.nodeCount);
  assert.equal(g.edgeCount, graph.edgeCount);
  assert.deepEqual([...g.edgeA], [...graph.edgeA]);
  assert.deepEqual([...g.edgeB], [...graph.edgeB]);
  assert.deepEqual([...g.edgeSegment], [...graph.edgeSegment]);
  for (let i = 0; i < graph.edgeCount; i++) {
    assert.ok(Math.abs(g.edgeLength[i] - graph.edgeLength[i]) < 0.01, `longueur d'arête ${i}`);
    // Les coordonnées passent par des flottants 32 bits : ~1 m près à Paris.
    assert.ok(Math.abs(g.nodeLon[i] - graph.nodeLon[i]) < 1e-5, `longitude du nœud ${i}`);
    assert.ok(Math.abs(g.nodeLat[i] - graph.nodeLat[i]) < 1e-5, `latitude du nœud ${i}`);
  }
});

test('un fichier d’un autre format est refusé, pas mal interprété', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'svet-test-'));
  try {
    await writeData(dir, 'zone', {
      segments: fixture(),
      timeSteps: TIME_STEPS,
      horizonBins: HORIZON_BINS,
      graph,
    });
    const file = await readFile(path.join(dir, 'zone.data.bin'));
    const copy = Uint8Array.from(file);
    copy[4] = 99; // version inventée
    assert.throws(
      () => decodeZoneData(copy.buffer),
      /Format de zone 99/,
      'un format inconnu doit être refusé net',
    );

    const broken = Uint8Array.from(file);
    broken[0] = 0; // signature abîmée
    assert.throws(() => decodeZoneData(broken.buffer), /signature/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
