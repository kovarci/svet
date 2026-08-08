/**
 * Le calcul d'itinéraire, sur des graphes qu'on peut dessiner à la main.
 *
 * Ce fichier ne teste pas « est-ce que ça trouve un chemin » — ça, on le voit à
 * l'écran. Il teste ce qui **casse en silence** : un itinéraire faux ne plante
 * pas, il propose simplement un trajet un peu moins bon, et personne ne le
 * remarque jamais. Trois propriétés méritent donc d'être fixées ici :
 *
 *  1. Le poids de l'exposition fait réellement changer de chemin, dans le bon
 *     sens, et sans jamais rendre un trajet impossible.
 *  2. Le coût dépend de **l'heure de passage**, pas de l'heure de départ : c'est
 *     ce qui distingue ce calcul d'un plus-court-chemin ordinaire, et rien à
 *     l'écran ne le dit.
 *  3. Un point de départ ne s'accroche pas à un îlot isolé du réseau — le
 *     défaut qui faisait répondre « choisissez un lieu dans la zone » au beau
 *     milieu de la zone.
 *
 * Les graphes sont bâtis à la main : quatre nœuds, deux chemins, on sait ce que
 * la réponse doit être.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SearchAborted,
  findRoute,
  nearestNode,
  prepareGraph,
  summarize,
  transitions,
} from '../src/routing.js';

/**
 * Un graphe jouet.
 *
 * `nodes` sont des `[lon, lat]`, `edges` des `[a, b, segment, mètres]`.
 * `segments` décrit chaque tronçon comme le ferait le binaire de zone.
 */
function graphOf({ nodes, edges, segments }) {
  const data = {
    segmentAt: (id) => segments[id],
  };
  return prepareGraph({
    ...data,
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

/**
 * Deux chemins de 0 à 3 : par le nord (tronçon 1, court) et par le sud
 * (tronçon 2, un peu plus long). L'exposition de chacun est donnée par le test.
 */
function twoWays() {
  const segments = [
    { id: 0, crossing: false, len: 100, name: 'Départ', twoSided: true },
    { id: 1, crossing: false, len: 100, name: 'Passage nord', twoSided: true },
    { id: 2, crossing: false, len: 130, name: 'Passage sud', twoSided: true },
    { id: 3, crossing: false, len: 100, name: 'Arrivée', twoSided: true },
  ];
  return graphOf({
    nodes: [
      [2.35, 48.85],
      [2.3501, 48.8501],
      [2.3502, 48.8499],
      [2.3505, 48.85],
    ],
    edges: [
      [0, 1, 0, 100],
      [0, 2, 0, 100],
      [1, 3, 1, 100],
      [2, 3, 2, 130],
    ],
    segments,
  });
}

const OPTIONS = {
  alpha: 0,
  speed: 1.35,
  crossingPenalty: 25,
  departureMinutes: 600,
  // Sans yields : un test n'a pas d'interface à garder vivante, et rendre la
  // main y ajoute des dizaines de tours de boucle d'événements pour rien.
  blocking: true,
};

/** Chaque tronçon porte un indice fixe, donné par table. */
const evaluateWith = (byId) => (id) => ({
  index: byId[id] ?? 0,
  sun: 0,
  side: 'nord',
  work: 0,
  twoSided: true,
  name: `Tronçon ${id}`,
});

test('sans pondération, le plus court gagne', async () => {
  const graph = twoWays();
  const route = await findRoute(graph, 0, 3, {
    ...OPTIONS,
    evaluate: evaluateWith({ 1: 90, 2: 0 }),
  });
  assert.ok(route);
  assert.equal(Math.round(route.meters), 200);
});

test('la pondération fait passer par le chemin abrité, plus long', async () => {
  const graph = twoWays();
  const route = await findRoute(graph, 0, 3, {
    ...OPTIONS,
    alpha: 3,
    evaluate: evaluateWith({ 1: 90, 2: 0 }),
  });
  assert.equal(Math.round(route.meters), 230);
  // Et le trajet rendu porte bien l'indice du chemin suivi, pas celui du plus court.
  assert.ok(route.index < 50);
});

test('une exposition maximale partout ne rend jamais le trajet impossible', async () => {
  const graph = twoWays();
  const route = await findRoute(graph, 0, 3, {
    ...OPTIONS,
    alpha: 6,
    evaluate: evaluateWith({ 0: 100, 1: 100, 2: 100, 3: 100 }),
  });
  assert.ok(route, 'un itinéraire doit exister même sur un réseau entièrement exposé');
});

test("l'exposition est évaluée à l'heure de passage, pas à celle du départ", async () => {
  const graph = twoWays();
  const seen = [];
  await findRoute(graph, 0, 3, {
    ...OPTIONS,
    departureMinutes: 600,
    evaluate: (id, minutes) => {
      seen.push(minutes);
      return { index: 0, sun: 0, side: 'nord', work: 0, twoSided: true, name: null };
    },
  });
  assert.ok(seen.length > 0);
  // 100 m à 1,35 m/s font 74 s : le second tronçon est donc consulté à une
  // heure strictement postérieure au départ.
  assert.ok(Math.max(...seen) > 600, 'aucune arête évaluée après l’instant du départ');
  assert.ok(Math.max(...seen) < 604, 'l’horloge dérive : 200 m ne font pas quatre minutes');
});

test('un chantier détourne sans bloquer', async () => {
  const graph = twoWays();
  const route = await findRoute(graph, 0, 3, {
    ...OPTIONS,
    alpha: 0,
    evaluate: (id) => ({
      index: 0,
      sun: 0,
      side: 'nord',
      work: id === 1 ? 100 : 0,
      twoSided: true,
      name: null,
    }),
  });
  // Le chemin nord est plus court, mais entièrement barré : il compte triple.
  assert.equal(Math.round(route.meters), 230);
});

test('deux points sans chemin donnent null, pas une exception', async () => {
  const graph = graphOf({
    nodes: [
      [2.35, 48.85],
      [2.3501, 48.85],
      [2.36, 48.86],
    ],
    edges: [[0, 1, 0, 50]],
    segments: [{ id: 0, crossing: false, len: 50, name: null, twoSided: false }],
  });
  const route = await findRoute(graph, 0, 2, { ...OPTIONS, evaluate: evaluateWith({}) });
  assert.equal(route, null);
});

test('les composantes connexes sont comptées, et le point isolé écarté', () => {
  const graph = graphOf({
    nodes: [
      [2.35, 48.85],
      [2.3501, 48.85],
      [2.3502, 48.85],
      // Un îlot de deux nœuds, tout près du premier : c'est le piège. Une cour
      // d'immeuble, un couloir de gare sans accès — on s'y accroche, et l'on
      // n'en sort jamais.
      [2.35005, 48.85005],
      [2.35006, 48.85006],
    ],
    edges: [
      [0, 1, 0, 50],
      [1, 2, 0, 50],
      [3, 4, 0, 10],
    ],
    segments: [{ id: 0, crossing: false, len: 50, name: null, twoSided: false }],
  });

  assert.equal(graph.componentSize.size, 2);
  // Sans filtre, c'est l'îlot le plus proche qui l'emporte.
  const naive = nearestNode(graph, 2.35004, 48.850045, { minComponentSize: 0 });
  assert.ok([3, 4].includes(naive.node));
  // Avec le filtre, on retombe sur le vrai réseau, même s'il est plus loin.
  const filtered = nearestNode(graph, 2.35004, 48.850045, { minComponentSize: 3 });
  assert.ok([0, 1, 2].includes(filtered.node));
});

test('une recherche abandonnée lève SearchAborted', async () => {
  const graph = twoWays();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      findRoute(graph, 0, 3, {
        ...OPTIONS,
        blocking: false,
        signal: controller.signal,
        evaluate: evaluateWith({}),
      }),
    SearchAborted,
  );
});

// ------------------------------------------------------------- feuille de route

/** Un trajet déjà calculé, décrit par ses seuls tronçons. */
const routeOf = (steps) => ({
  steps: steps.map((step, i) => ({
    length: step.length,
    segment: i,
    crossing: Boolean(step.crossing),
    name: step.name ?? null,
    state: {
      index: step.index,
      side: step.side ?? 'nord',
      twoSided: step.twoSided ?? true,
      sun: 0,
    },
  })),
});

test('les tronçons consécutifs de même nom et même côté se regroupent', () => {
  const legs = summarize(
    routeOf([
      { length: 40, index: 10, name: 'Rue de Rivoli' },
      { length: 60, index: 20, name: 'Rue de Rivoli' },
      { length: 30, index: 30, name: 'Rue de Rivoli', side: 'sud' },
    ]),
  );
  assert.equal(legs.length, 2);
  assert.equal(legs[0].meters, 100);
  assert.equal(legs[0].index, 15);
});

test('les micro-tronçons disparaissent, les traversées restent', () => {
  const legs = summarize(
    routeOf([
      { length: 80, index: 10, name: 'Rue A' },
      { length: 6, index: 10, crossing: true, name: null },
      { length: 5, index: 10, name: 'Rue B' },
      { length: 90, index: 10, name: 'Rue C' },
    ]),
  );
  assert.deepEqual(
    legs.map((leg) => leg.name),
    ['Rue A', 'Traversée', 'Rue C'],
  );
});

// --------------------------------------------------- transitions ombre → soleil

test('un front d’ombre traversé est signalé une fois, pas six', () => {
  const shade = Array.from({ length: 6 }, () => ({ length: 20, index: 15, name: 'Rue ombrée' }));
  const sun = Array.from({ length: 6 }, () => ({ length: 20, index: 80, name: 'Quai' }));
  const found = transitions(routeOf([...shade, ...sun]));

  assert.equal(found.length, 1);
  assert.equal(found[0].before, 15);
  assert.equal(found[0].after, 80);
  assert.equal(found[0].distance, 120);
  assert.equal(found[0].name, 'Quai');
});

test('une montée progressive n’est pas une transition', () => {
  const gentle = Array.from({ length: 12 }, (_, i) => ({
    length: 20,
    index: 10 + i * 4,
    name: 'Rue en pente douce',
  }));
  assert.deepEqual(transitions(gentle.length ? routeOf(gentle) : routeOf([])), []);
});

test('le passage soleil → ombre ne se signale pas : c’est le bon sens', () => {
  const sun = Array.from({ length: 6 }, () => ({ length: 20, index: 80, name: 'Quai' }));
  const shade = Array.from({ length: 6 }, () => ({ length: 20, index: 15, name: 'Rue ombrée' }));
  assert.deepEqual(transitions(routeOf([...sun, ...shade])), []);
});

test('les tout premiers mètres ne fabriquent pas de transition', () => {
  // Cinq mètres à l'ombre puis du plein soleil : il n'y a pas d'élan derrière,
  // donc rien à annoncer — sans ce garde-fou, tout trajet commençant à l'ombre
  // s'ouvrait sur un avertissement.
  const found = transitions(
    routeOf([
      { length: 5, index: 10, name: 'Porche' },
      ...Array.from({ length: 6 }, () => ({ length: 20, index: 85, name: 'Quai' })),
    ]),
  );
  assert.deepEqual(found, []);
});
