/**
 * Les trottoirs sans éclairage sont-ils réels, ou la donnée manque-t-elle ?
 *
 * Un quart des relevés parisiens ressort à zéro. Deux explications possibles et
 * très différentes : soit ce sont des lieux réellement non éclairés — bois,
 * berges, emprises ferroviaires, cours intérieures — soit la récupération est
 * tronquée et l'application annoncerait « pas de lampadaire » là où il y en a.
 * La seconde serait grave : promettre l'obscurité et livrer un boulevard.
 */
import { readFileSync } from 'node:fs';
import { decodeZoneData } from '../web/src/binary.js';

const zone = process.argv[2] ?? 'paris';
const buffer = readFileSync(new URL(`../web/public/data/${zone}.data.bin`, import.meta.url));
const data = decodeZoneData(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);

const unknown = new Map();
const dark = new Map();
let counts = { known: 0, unknown: 0, darkButKnown: 0 };

for (let id = 0; id < data.segmentCount; id++) {
  const s = data.segmentAt(id);
  const key = s.name ?? `— sans nom (${s.hw}) —`;
  if (!s.lit) {
    counts.unknown++;
    unknown.set(key, (unknown.get(key) ?? 0) + 1);
    continue;
  }
  counts.known++;
  if (s.lVeil <= 0.01 && s.rVeil <= 0.01) {
    counts.darkButKnown++;
    dark.set(key, (dark.get(key) ?? 0) + 1);
  }
}

const total = counts.known + counts.unknown;
console.log(`\n▌ ${zone} — ${total} tronçons`);
console.log(
  `  éclairage renseigné : ${counts.known} (${((100 * counts.known) / total).toFixed(1)} %) · ` +
    `hors jeu de données : ${counts.unknown} (${((100 * counts.unknown) / total).toFixed(1)} %)`,
);
console.log(
  `  renseignés et réellement sans lampadaire à 80 m : ${counts.darkButKnown} ` +
    `(${((100 * counts.darkButKnown) / Math.max(1, counts.known)).toFixed(1)} % des renseignés)\n`,
);

console.log('  Hors jeu de données — les dix voies les plus citées (attendu : communes limitrophes) :');
for (const [name, n] of [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${String(n).padStart(5)}  ${name}`);
}
console.log('\n  Renseignés mais sans lampadaire — les dix premières (attendu : bois, berges, voies ferrées) :');
for (const [name, n] of [...dark].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${String(n).padStart(5)}  ${name}`);
}

// Répartition par type de voie : un chemin de bois n'a pas le même statut
// qu'un boulevard.
const byClass = new Map();
for (let id = 0; id < data.segmentCount; id++) {
  const s = data.segmentAt(id);
  const isDark = s.lVeil <= 0.01 && s.rVeil <= 0.01;
  const entry = byClass.get(s.hw) ?? { dark: 0, total: 0 };
  entry.total++;
  if (isDark) entry.dark++;
  byClass.set(s.hw, entry);
}
console.log('\n  Part non éclairée par type de voie :');
for (const [hw, e] of [...byClass].sort((a, b) => b[1].total - a[1].total)) {
  console.log(
    `    ${String(hw).padEnd(14)} ${String(e.dark).padStart(6)} / ${String(e.total).padStart(6)}` +
      `  ${((100 * e.dark) / e.total).toFixed(1).padStart(5)} %`,
  );
}
console.log();
