/**
 * Ce que l'appariement trottoir ↔ rue donne réellement sur Paris.
 *
 * Trois questions, dans l'ordre où elles décident de la conception :
 *  1. Combien d'axes sont doublés, et de quel côté ? (traitement mixte ou non)
 *  2. Le signe gauche/droite est-il juste ? (contrôle par inversion)
 *  3. Combien de trottoirs retrouvent le nom de leur rue ? (guidage)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjection } from './src/lib/geo.js';
import {
  buildEdgeIndex,
  coverageAlong,
  parentStreet,
  sampleWithHeading,
  isMappedSidewalk,
  isStreetAxis,
} from './src/sidewalks.js';

const CACHE = path.resolve(fileURLToPath(new URL('./cache', import.meta.url)));
const BBOX = [2.224, 48.815, 2.47, 48.903];
const STEP = 10;
const REVERSE = process.argv.includes('--reverse');

const file = readdirSync(CACHE).find((f) => f.startsWith('osm-2.2240_48.8150'));
if (!file) {
  console.log('  Réponse Overpass de Paris absente du cache.');
  process.exit(0);
}
const ways = JSON.parse(readFileSync(path.join(CACHE, file), 'utf8')).elements.filter(
  (e) => e.type === 'way' && e.geometry?.length >= 2,
);

const projection = createProjection(BBOX);
const project = (geometry) => geometry.map((n) => projection.forward(n.lon, n.lat));

const sidewalkIndex = buildEdgeIndex(ways, projection, isMappedSidewalk);
const streetIndex = buildEdgeIndex(ways, projection, isStreetAxis, (w) => ({
  name: w.tags?.name ?? null,
  highway: w.tags?.highway ?? null,
}));
console.log(
  `\n▌ ${sidewalkIndex.count} arêtes de trottoir · ${streetIndex.count} arêtes de rue indexées\n`,
);

// ---- 1 & 2. couverture par côté -------------------------------------------
const tally = { deux: 0, gauche: 0, droite: 0, aucun: 0 };
const km = { deux: 0, gauche: 0, droite: 0, aucun: 0 };
const declared = { accord: 0, desaccord: 0, muet: 0 };
let streets = 0;

for (const way of ways) {
  const tags = way.tags ?? {};
  if (!isStreetAxis(tags)) continue;
  streets++;

  const geometry = REVERSE ? [...way.geometry].reverse() : way.geometry;
  const samples = sampleWithHeading(project(geometry), STEP);
  const { left, right } = coverageAlong(sidewalkIndex, samples);

  const key = left && right ? 'deux' : left ? 'gauche' : right ? 'droite' : 'aucun';
  tally[key]++;
  km[key] += (samples.length * STEP) / 1000;

  const says = tags.sidewalk ?? (tags['sidewalk:both'] ? 'both' : null);
  if (says === 'both') (left && right ? declared.accord++ : declared.desaccord++);
  else if (says === 'no' || says === 'none') (!left && !right ? declared.accord++ : declared.desaccord++);
  else declared.muet++;
}

console.log(`  ${streets} axes examinés${REVERSE ? ' (sens inversé)' : ''}\n`);
console.log('  Côtés doublés d’un trottoir cartographié');
for (const [k, label] of [
  ['deux', 'des deux côtés'],
  ['gauche', 'à gauche seulement'],
  ['droite', 'à droite seulement'],
  ['aucun', 'aucun côté'],
]) {
  console.log(
    `    ${label.padEnd(20)} ${String(tally[k]).padStart(6)}  ${((100 * tally[k]) / streets).toFixed(1).padStart(5)} %   ${km[k].toFixed(0).padStart(5)} km`,
  );
}

const juges = declared.accord + declared.desaccord;
console.log('\n  Confrontation à l’attribut « sidewalk » porté par la rue');
console.log(
  `    accord : ${declared.accord} / ${juges}  (${((100 * declared.accord) / Math.max(1, juges)).toFixed(1)} %)`,
);

// ---- 3. le trottoir retrouve-t-il sa rue ? --------------------------------
let sidewalks = 0;
let ownName = 0;
let adopted = 0;
let orphan = 0;
const shares = [];

for (const way of ways) {
  const tags = way.tags ?? {};
  if (!isMappedSidewalk(tags)) continue;
  sidewalks++;
  if (tags.name) {
    ownName++;
    continue;
  }
  const samples = sampleWithHeading(project(way.geometry), STEP);
  const parent = parentStreet(streetIndex, samples);
  if (parent?.name) {
    adopted++;
    shares.push(parent.share);
  } else orphan++;
}

shares.sort((a, b) => a - b);
console.log('\n  Nom des trottoirs');
console.log(`    ${sidewalks} trottoirs cartographiés`);
console.log(`    nom propre  : ${ownName}  (${((100 * ownName) / sidewalks).toFixed(1)} %)`);
console.log(
  `    nom hérité  : ${adopted}  (${((100 * adopted) / sidewalks).toFixed(1)} %)` +
    `   part de points concordants — médiane ${(shares[Math.floor(shares.length / 2)] ?? 0).toFixed(2)}`,
);
console.log(`    sans nom    : ${orphan}  (${((100 * orphan) / sidewalks).toFixed(1)} %)\n`);
