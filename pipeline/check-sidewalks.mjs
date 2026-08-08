/**
 * Le défaut que ce chantier visait est-il corrigé ?
 *
 * Le reproche exact : « l'app peut te dire côté sud puis côté nord sans jamais
 * te faire traverser ». On le mesure directement — on rejoue un itinéraire et
 * on compte les changements de côté qui ne passent pas par une traversée.
 *
 * On vérifie aussi ce que la refonte met en danger : la connexité. Effacer les
 * axes dont les deux trottoirs sont cartographiés ne vaut que si le réseau
 * restant tient d'un seul tenant.
 */
import { readFileSync } from 'node:fs';
import { decodeZoneData } from '../web/src/binary.js';
import { prepareGraph, findRoute, nearestNode, summarize } from '../web/src/routing.js';
import { components, discomfortIndex, skyConditions } from './src/model.js';
import { applyRefraction, localToUTC, sunPosition } from './src/lib/sun.js';

const zone = process.argv[2] ?? 'centre';
const DATA = new URL(`../web/public/data/`, import.meta.url);
const meta = JSON.parse(readFileSync(new URL(`${zone}.meta.json`, DATA), 'utf8'));
const buffer = readFileSync(new URL(`${zone}.data.bin`, DATA));
const data = decodeZoneData(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);

console.log(`\n▌ ${meta.label}`);
console.log(`  ${data.segmentCount} tronçons · ${meta.nodeCount} nœuds · ${meta.edgeCount} arêtes`);

const graph = prepareGraph(data);

// ---- connexité -------------------------------------------------------------
const sizes = new Map();
for (let n = 0; n < graph.size; n++) {
  const c = graph.component[n];
  sizes.set(c, (sizes.get(c) ?? 0) + 1);
}
const biggest = Math.max(...sizes.values());
console.log(
  `  composantes : ${sizes.size} · la plus grande ${biggest} nœuds ` +
    `(${((100 * biggest) / graph.size).toFixed(1)} %)\n`,
);

// ---- contexte solaire ------------------------------------------------------
const cache = new Map();
function contextAt(minutes) {
  const key = Math.round(minutes);
  if (cache.has(key)) return cache.get(key);
  const h = Math.floor(key / 60);
  const raw = sunPosition(localToUTC(meta.date, h, key - h * 60), 48.8566, 2.3522);
  const sun = { altitude: applyRefraction(raw.altitude), azimuth: raw.azimuth };
  const value = { minutes: key, sun, sky: skyConditions(sun.altitude, 0) };
  cache.set(key, value);
  return value;
}

function cursor(minutes) {
  const t0 = meta.times[0].minutes;
  const step = meta.times[1].minutes - t0;
  const raw = (minutes - t0) / step;
  const i = Math.max(0, Math.min(meta.times.length - 1, Math.floor(raw)));
  return { i, j: Math.min(meta.times.length - 1, i + 1), t: Math.max(0, Math.min(1, raw - i)) };
}

function evalSide(view, ctx) {
  const { i, j, t } = cursor(ctx.minutes);
  const c = components({
    transmission: (view.sun[i] + (view.sun[j] - view.sun[i]) * t) / 100,
    svf: view.svf / 100,
    altitude: ctx.sun.altitude,
    flicker: (view.flicker[i] + (view.flicker[j] - view.flicker[i]) * t) / 100,
    albedo: meta.albedo,
    luxReference: meta.luxReference,
    sky: ctx.sky,
  });
  return { index: discomfortIndex(c, meta.weights), sun: c.sun * 100, side: view.side };
}

/** Comme `sideOf` dans l'application : les séries plus les attributs du tronçon. */
function sideOf(id, right) {
  const segment = data.segmentAt(id);
  const series = data.sideAt(id, right);
  return {
    ...series,
    side: right ? segment.rSide : segment.lSide,
    svf: right ? segment.rSvf : segment.lSvf,
    canopy: right ? segment.rCanopy : segment.lCanopy,
  };
}

const evaluate = (position, minutes) => {
  const ctx = contextAt(minutes);
  const l = evalSide(sideOf(position, false), ctx);
  const r = evalSide(sideOf(position, true), ctx);
  const best = l.index <= r.index ? l : r;
  return { index: best.index, sun: best.sun, side: best.side, twoSided: l.side !== r.side };
};

// ---- itinéraire ------------------------------------------------------------
const from = { label: 'Gare Saint-Lazare', lon: 2.3250674, lat: 48.8770414 };
const to = { label: 'Musée du Louvre', lon: 2.3380277, lat: 48.8611473 };
const start = nearestNode(graph, from.lon, from.lat);
const goal = nearestNode(graph, to.lon, to.lat);
console.log(
  `  départ → nœud ${start.node} à ${Math.round(start.distance)} m (composante ${graph.component[start.node]})`,
);
console.log(
  `  arrivée → nœud ${goal.node} à ${Math.round(goal.distance)} m (composante ${graph.component[goal.node]})`,
);
if (start.node < 0 || goal.node < 0) {
  console.log('  Aucun nœud proche — arrêt.');
  process.exit(1);
}

const route = findRoute(graph, start.node, goal.node, {
  alpha: 1.5,
  speed: meta.walkingSpeed,
  crossingPenalty: meta.crossingPenalty,
  departureMinutes: 14 * 60,
  evaluate,
});
if (!route) {
  console.log('  Aucun chemin trouvé — arrêt.');
  process.exit(1);
}

const legs = summarize(route);
console.log(
  `  ${from.label} → ${to.label} : ${Math.round(route.seconds / 60)} min · ` +
    `${(route.meters / 1000).toFixed(2)} km · indice ${Math.round(route.index)} · ` +
    `${Math.round(route.sun)} % au soleil\n`,
);

// ---- LE contrôle : changer de côté sans traverser ---------------------------
let changes = 0;
let illegal = 0;
const examples = [];
let previous = null;
for (const leg of legs) {
  if (leg.crossing) {
    previous = null; // une traversée autorise le changement
    continue;
  }
  if (!leg.side) continue;
  if (previous && leg.side !== previous.side) {
    changes++;
    illegal++;
    if (examples.length < 6) examples.push(`${previous.name ?? '—'} (${previous.side}) → ${leg.name ?? '—'} (${leg.side})`);
  } else if (previous && leg.side === previous.side) {
    // rien
  }
  previous = leg;
}

console.log('  Changements de trottoir sans traversée');
console.log(`    ${illegal} sur ${legs.length} étapes`);
for (const e of examples) console.log(`      ${e}`);

// ---- part du trajet sur un trottoir cartographié ---------------------------
let named = 0;
let unnamed = 0;
for (const leg of legs) (leg.name ? named++ : unnamed++);
console.log(`\n  Étapes nommées : ${named} · sans nom : ${unnamed}\n`);
void changes;
