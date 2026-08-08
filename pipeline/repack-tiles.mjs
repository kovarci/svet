/**
 * Réécrit la pyramide de tuiles d'une zone déjà calculée.
 *
 * Le modèle solaire ne change pas — seule la mise en forme change. Repasser par
 * `npm run data` recalculerait des heures de lancers de rayons pour un résultat
 * identique ; la géométrie tuilée se reconstruit à l'identique depuis
 * `<zone>.geometry.json` et `<zone>.buildings.json`, qui sortent des mêmes
 * objets que ceux passés à `writeTiles`.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTiles } from './src/pack.js';

const OUT_DIR = path.resolve(fileURLToPath(new URL('../web/public/data', import.meta.url)));

const zones = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => f.replace('.meta.json', ''));

const index = JSON.parse(readFileSync(path.join(OUT_DIR, 'zones.json'), 'utf8'));

for (const key of zones) {
  const metaPath = path.join(OUT_DIR, `${key}.meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const network = JSON.parse(readFileSync(path.join(OUT_DIR, `${key}.geometry.json`), 'utf8'));
  const buildings = JSON.parse(readFileSync(path.join(OUT_DIR, `${key}.buildings.json`), 'utf8'));

  const before = meta.tiles?.count ?? 0;
  const tiles = await writeTiles(path.join(OUT_DIR, key), network, buildings, meta.bbox);

  meta.tiles = {
    minZoom: tiles.minZoom,
    maxZoom: tiles.maxZoom,
    count: tiles.tiles,
    bounds: tiles.bounds,
  };
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  meta.generatedAt = new Date().toISOString();
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  const entry = index.find((z) => z.key === key);
  if (entry) entry.stamp = stamp;

  console.log(
    `  ${key.padEnd(8)} ${String(before).padStart(4)} → ${String(tiles.tiles).padStart(4)} tuiles` +
      `  ${(tiles.bytes / 1e6).toFixed(1)} Mo`,
  );
}

writeFileSync(path.join(OUT_DIR, 'zones.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(
  '\n  zones.json réhorodaté — les anciennes tuiles ne seront plus servies par le cache.\n',
);
