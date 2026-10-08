/**
 * Les profils de sensibilité, et ce qu'ils ne doivent pas faire.
 *
 * Un profil change ce qu'on appelle « gênant » pour une personne. Les erreurs
 * qui comptent ici ne plantent rien :
 *
 *  - un profil neutre qui déplace l'indice d'un point, et la carte de tout le
 *    monde dérive sans que personne ne sache pourquoi ;
 *  - une « sensibilité » qui, appliquée dans les saturations, comprime le
 *    contraste et fait préférer le quai ensoleillé à l'ombre (mesuré :
 *    formulation naïve, recherche du dossier profils) ;
 *  - une donnée de santé lue de travers dans le stockage local — texte, NaN,
 *    identifiant inconnu — qui fait échouer le démarrage de l'application.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../../pipeline/src/config.js';
import { discomfortIndex } from '../../pipeline/src/model.js';
import {
  BOUNDS,
  NEUTRAL,
  PENALTY,
  PRESETS,
  combine,
  personalIndex,
  personalWeights,
  resolve,
  tolerance,
} from '../src/profile.js';
import { findRoute, prepareGraph } from '../src/routing.js';

const W = CONFIG.weights;

/** Une scène : composantes déjà saturées, comme `components()` les rend. */
const scene = (overrides = {}) => ({
  sun: 0.8,
  sky: 0.6,
  bright: 0.7,
  reverb: 0.4,
  glare: 0.3,
  flicker: 0.2,
  night: 0.5,
  nightShare: 0,
  ...overrides,
});

const SCENES = [
  scene(),
  scene({ sun: 0, sky: 0.2, bright: 0.1, reverb: 0.1, glare: 0, flicker: 0 }),
  scene({ nightShare: 0.5 }),
  scene({ nightShare: 1, night: 0.9 }),
  scene({ sun: 1, sky: 1, bright: 1, reverb: 1, glare: 1, flicker: 1 }),
];

test('le profil neutre redonne exactement l’indice actuel', () => {
  for (const c of SCENES) {
    assert.equal(personalIndex(c, W, NEUTRAL, 5), discomfortIndex(c, W));
  }
  // L'UV, même fort, n'entre pas dans l'indice tant que son poids est nul.
  assert.equal(personalIndex(SCENES[0], W, NEUTRAL, 11), discomfortIndex(SCENES[0], W));
});

test('les poids personnels restent de somme 1 et suivent l’importance', () => {
  const profile = combine(['migraine']);
  const w = personalWeights(W, profile);
  const sum = w.directSun + w.skyView + w.brightness + w.reverb + w.glare + w.flicker + w.uv;
  assert.ok(Math.abs(sum - 1) < 1e-12, `somme ${sum}`);
  // Le scintillement pèse 1,8 fois plus que le soleil, relativement au défaut.
  const ratio = w.flicker / w.directSun / (W.flicker / W.directSun);
  assert.ok(Math.abs(ratio - profile.mu.flicker / profile.mu.sun) < 1e-9);
});

test('l’importance d’une composante ne joue qu’à travers ce qu’elle mesure', () => {
  // Une rue où seul le scintillement est élevé : un profil qui le surveille la
  // juge plus gênante, un profil qui l'ignore l'oublie.
  const flickering = scene({ sun: 0, sky: 0, bright: 0, reverb: 0, glare: 0, flicker: 1 });
  const base = personalIndex(flickering, W, NEUTRAL, 0);
  const watchful = personalIndex(flickering, W, combine(['scintillement']), 0);
  assert.ok(watchful > base, `${watchful} > ${base}`);
  const ignoring = personalIndex(flickering, W, resolve({ mu: { flicker: 0 } }), 0);
  assert.equal(ignoring, 0);
});

test('la sensibilité ne change pas l’indice : elle ne règle que la tolérance', () => {
  // Formulation retenue : l'indice garde son échelle, la sensibilité agit sur le
  // coût d'itinéraire. Appliquée à l'indice, elle écraserait les contrastes.
  for (const c of SCENES) {
    const touchy = resolve({ sensitivity: 0.1 });
    assert.equal(personalIndex(c, W, touchy, 4), personalIndex(c, W, NEUTRAL, 4));
  }
  assert.equal(tolerance(NEUTRAL), 100);
  assert.ok(tolerance(resolve({ sensitivity: 0.5 })) < tolerance(NEUTRAL));
  assert.ok(tolerance(resolve({ sensitivity: 0.1 })) < tolerance(resolve({ sensitivity: 0.5 })));
});

test('la nuit se renforce sans dépasser 1, et ne bouge pas au facteur 1', () => {
  const night = scene({ nightShare: 1, night: 0.4 });
  assert.equal(personalIndex(night, W, NEUTRAL, 0), 40);
  const albinism = combine(['albinisme']);
  const raised = personalIndex(night, W, albinism, 0);
  assert.ok(raised > 40 && raised <= 100, `${raised}`);
  assert.equal(personalIndex(scene({ nightShare: 1, night: 1 }), W, albinism, 0), 100);
});

test('l’UV n’entre dans l’indice que pour un profil qui le demande', () => {
  const c = scene();
  const skin = combine(['peau-uv']);
  assert.ok(skin.uv > 0);
  const noUV = personalIndex(c, W, skin, 0);
  const strongUV = personalIndex(c, W, skin, 8);
  const veryStrong = personalIndex(c, W, skin, 11);
  assert.ok(strongUV > noUV, `${strongUV} > ${noUV}`);
  // Saturé à l'indice 8 (« très fort », OMS) : au-delà, plus rien ne s'ajoute.
  assert.equal(veryStrong, strongUV);
});

test('combiner prend le pire de chaque grandeur, jamais la moyenne', () => {
  const a = combine(['migraine']);
  const b = combine(['scintillement']);
  const both = combine(['migraine', 'scintillement']);
  for (const key of Object.keys(both.mu)) {
    assert.equal(both.mu[key], Math.max(a.mu[key], b.mu[key]), key);
  }
  assert.equal(both.s, Math.min(a.s, b.s));
  assert.equal(combine([]).s, 1);
  assert.deepEqual(combine([]).mu, NEUTRAL.mu);
});

test('« en crise aujourd’hui » ne vaut que pour le jour où on l’a déclaré', () => {
  const stored = { presets: ['migraine'], crisisDay: '2026-06-21' };
  const today = resolve(stored, '2026-06-21');
  const tomorrow = resolve(stored, '2026-06-22');
  assert.equal(today.s, 0.25);
  assert.equal(tomorrow.s, 0.5);
  assert.ok(today.mu.flicker > tomorrow.mu.flicker);
});

test('un stockage illisible ou hostile donne le profil neutre, sans exception', () => {
  const hostile = [
    null,
    undefined,
    'texte',
    42,
    [],
    { presets: 'migraine' },
    { presets: ['inconnu', 7, null] },
    { mu: { sun: 'beaucoup', glare: NaN, flicker: Infinity } },
    { sensitivity: -3 },
    { sensitivity: 'x' },
  ];
  for (const stored of hostile) {
    const profile = resolve(stored, '2026-06-21');
    assert.deepEqual(profile.mu, NEUTRAL.mu, JSON.stringify(stored));
    assert.equal(profile.s, 1, JSON.stringify(stored));
  }
});

test('les bornes de prudence tiennent, quoi qu’on stocke', () => {
  const extreme = resolve({
    mu: { sun: 99, sky: -4, flicker: 3.5 },
    sensitivity: 0.001,
    uv: 7,
    diffusion: 400,
  });
  assert.equal(extreme.mu.sun, BOUNDS.mu[1]);
  assert.equal(extreme.mu.sky, BOUNDS.mu[0]);
  assert.equal(extreme.mu.flicker, BOUNDS.mu[1]);
  assert.equal(extreme.s, BOUNDS.s[0]);
  assert.equal(extreme.uv, BOUNDS.uv[1]);
  assert.equal(extreme.f, BOUNDS.f[1]);
  // Pas de « moins sensible que la normale » : aucune donnée ne l'étaye.
  assert.equal(resolve({ sensitivity: 5 }).s, 1);
  assert.equal(resolve({ diffusion: 0.2 }).f, 1);
});

test('les préréglages restent dans les bornes et disent leur niveau de preuve', () => {
  assert.ok(PRESETS.length >= 10);
  const ids = new Set();
  for (const preset of PRESETS) {
    assert.ok(!ids.has(preset.id), `identifiant en double : ${preset.id}`);
    ids.add(preset.id);
    assert.ok(['solide', 'modérée', 'faible', 'avis d’experts'].includes(preset.evidence));
    assert.ok(preset.label.length > 0 && preset.hint.length > 0);
    // Libellés par expérience vécue ; aucune promesse médicale ni de sécurité.
    assert.doesNotMatch(
      `${preset.label} ${preset.hint}`,
      /épilepsi|diagnosti|guér|soign|trait(e|ement)\b|sûr|sans risque/i,
    );
    const p = combine([preset.id]);
    for (const value of Object.values(p.mu)) {
      assert.ok(value >= BOUNDS.mu[0] && value <= BOUNDS.mu[1]);
    }
    assert.ok(p.s >= BOUNDS.s[0] && p.s <= 1);
    assert.ok(p.uv >= BOUNDS.uv[0] && p.uv <= BOUNDS.uv[1]);
    assert.ok(p.f >= BOUNDS.f[0] && p.f <= BOUNDS.f[1]);
  }
});

// ------------------------------------------------------------- itinéraire

function twoWays() {
  const segments = [0, 1, 2, 3].map((id) => ({ id, crossing: false, twoSided: true }));
  const nodes = [
    [2.35, 48.85],
    [2.3501, 48.8501],
    [2.3502, 48.8499],
    [2.3505, 48.85],
  ];
  const edges = [
    [0, 1, 0, 100],
    [0, 2, 0, 100],
    [1, 3, 1, 100],
    [2, 3, 2, 130],
  ];
  return prepareGraph({
    segmentAt: (id) => segments[id],
    graph: {
      size: nodes.length,
      edgeCount: edges.length,
      nodeLon: Float64Array.from(nodes.map((n) => n[0])),
      nodeLat: Float64Array.from(nodes.map((n) => n[1])),
      edgeA: Uint32Array.from(edges.map((e) => e[0])),
      edgeB: Uint32Array.from(edges.map((e) => e[1])),
      edgeSegment: Uint32Array.from(edges.map((e) => e[2])),
      edgeLength: Float32Array.from(edges.map((e) => e[3])),
    },
  });
}

const ROUTE = {
  alpha: 0.4,
  speed: 1.35,
  crossingPenalty: 25,
  departureMinutes: 600,
  blocking: true,
  // Passage nord : 200 m dont 100 m à l'indice 60 ; passage sud : 230 m dont 130 m à l'indice 10.
  evaluate: (id) => ({ index: { 1: 60, 2: 10 }[id] ?? 0, sun: 0, work: 0 }),
};

test('sans tolérance personnelle, le coût d’itinéraire est celui d’avant', async () => {
  const graph = twoWays();
  const before = await findRoute(graph, 0, 3, ROUTE);
  const neutral = await findRoute(graph, 0, 3, {
    ...ROUTE,
    tolerance: tolerance(NEUTRAL),
    penalty: PENALTY,
  });
  assert.equal(Math.round(before.meters), 200);
  assert.equal(Math.round(neutral.meters), 200);
});

test('au-delà de la tolérance, un profil sensible accepte un détour', async () => {
  const graph = twoWays();
  const touchy = resolve({ sensitivity: 0.25 });
  assert.ok(tolerance(touchy) < 60, `tolérance ${tolerance(touchy)}`);
  const route = await findRoute(graph, 0, 3, {
    ...ROUTE,
    tolerance: tolerance(touchy),
    penalty: PENALTY,
  });
  assert.equal(Math.round(route.meters), 230);
});

test('une priorité nulle reste « le plus rapide », profil ou non', async () => {
  const graph = twoWays();
  const route = await findRoute(graph, 0, 3, {
    ...ROUTE,
    alpha: 0,
    tolerance: 10,
    penalty: PENALTY,
  });
  assert.equal(Math.round(route.meters), 200);
});
