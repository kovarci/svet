/**
 * Qu'est-ce qui pèse dans le fichier binaire d'une zone ?
 *
 * Le graphe d'itinéraire est le suspect désigné : c'est lui qu'on ne peut pas
 * tuiler, puisqu'un chemin traverse par définition ce qui n'est pas affiché.
 * Mais avant de le découper en niveaux — un vrai chantier — il faut savoir
 * quelle part il représente réellement.
 */
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const zone = process.argv[2] ?? 'paris';
const url = new URL(`../web/public/data/${zone}.data.bin`, import.meta.url);
const buffer = readFileSync(url);
const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const timeSteps = view.getUint8(5);
const horizonBins = view.getUint8(6);
const segmentCount = view.getUint32(8, true);
const nodeCount = view.getUint32(12, true);
const edgeCount = view.getUint32(16, true);
const namesOffset = view.getUint32(24, true);

const PREFIX = 22;
const twoSidedCount = view.getUint32(28, true);
const sideBytes = 2 * timeSteps + horizonBins;
const stride = PREFIX + sideBytes;

const parts = [
  ['en-tête de tronçon', segmentCount * PREFIX],
  ['séries (soleil + scintillement)', segmentCount * 2 * timeSteps + twoSidedCount * 2 * timeSteps],
  ['profils d’horizon', segmentCount * horizonBins + twoSidedCount * horizonBins],
  ['index des seconds trottoirs', twoSidedCount * 4],
  ['nœuds du graphe', nodeCount * 8],
  ['arêtes du graphe', edgeCount * 16],
  ['table des noms', buffer.length - namesOffset],
];
const total = buffer.length;

console.log(`\n▌ ${zone}.data.bin — ${(total / 1e6).toFixed(1)} Mo`);
console.log(`  ${segmentCount} tronçons · ${stride} octets chacun · ${timeSteps} pas · ${horizonBins} secteurs\n`);
for (const [label, bytes] of parts.sort((a, b) => b[1] - a[1])) {
  const share = (100 * bytes) / total;
  console.log(
    `  ${label.padEnd(44)} ${(bytes / 1e6).toFixed(1).padStart(6)} Mo  ${share.toFixed(1).padStart(5)} %` +
      `  ${'█'.repeat(Math.round(share / 2))}`,
  );
}

// ---- 1. les séries des tronçons à un seul côté sont-elles dupliquées ? -----
let shared = 0;
let identical = 0;
const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
for (let id = 0; id < segmentCount; id++) {
  const base = 32 + id * stride;
  const twoSided = (bytes[base + 3] & 4) !== 0;
  if (twoSided) continue;
  shared++;
  // Côté gauche et côté droit de la série « soleil ».
  let same = true;
  for (let i = 0; i < timeSteps; i++) {
    if (bytes[base + PREFIX + i] !== bytes[base + PREFIX + timeSteps + i]) {
      same = false;
      break;
    }
  }
  if (same) identical++;
}
console.log(
  `\n  Tronçons à un seul côté : ${shared} / ${segmentCount} (${((100 * shared) / segmentCount).toFixed(1)} %)`,
);
console.log(
  `  dont les deux séries sont identiques : ${identical} (${((100 * identical) / Math.max(1, shared)).toFixed(1)} %)`,
);
const wasted = identical * (2 * timeSteps + horizonBins);
console.log(
  `  → ${(wasted / 1e6).toFixed(1)} Mo écrits deux fois, soit ${((100 * wasted) / total).toFixed(1)} % du fichier`,
);

// ---- 2. que donnerait une compression de transport ? ----------------------
console.log('\n  Compression au transport (ce qu’un hébergeur fait tout seul) :');
for (const [label, fn] of [
  ['gzip', () => gzipSync(buffer, { level: 6 })],
  ['brotli (rapide)', () => brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })],
]) {
  const t0 = performance.now();
  const out = fn();
  console.log(
    `    ${label.padEnd(18)} ${(out.length / 1e6).toFixed(1).padStart(6)} Mo` +
      `  ×${(total / out.length).toFixed(2)}   ${Math.round(performance.now() - t0)} ms`,
  );
}

void writeFileSync;
void statSync;
void unlinkSync;
console.log();
