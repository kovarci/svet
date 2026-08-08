/**
 * Recalcule toutes les zones pour aujourd'hui.
 *
 * ── Pourquoi c'est nécessaire ──────────────────────────────────────────────
 * La position du soleil est une formule, calculée à la minute affichée : elle
 * est toujours juste. Mais la **transmission solaire** — ce qui traverse
 * réellement jusqu'au trottoir — est précalculée par lancer de rayons, à la
 * date du calcul. Le 31 juillet elle est exacte ; le 15 octobre le soleil est
 * vingt degrés plus bas et les séries l'ignorent. L'application affiche bien un
 * bandeau, mais elle affiche quand même : sans recalcul, elle se périme en
 * silence, et pour ce public une ombre annoncée qui n'existe pas est une
 * mauvaise surprise en pleine rue.
 *
 * ── Pourquoi une reconstruction complète ───────────────────────────────────
 * On aurait pu ne refaire que l'étape solaire et reprendre au cache le modèle
 * de surface et le facteur de vue du ciel, qui ne dépendent pas de la date. Le
 * chronométrage dit que ça n'en vaut pas la peine : la simulation solaire ne
 * pèse qu'un quart du temps, et une zone entière se reconstruit en quelques
 * minutes. Un cache intermédiaire coûterait plus en complexité — et en risque
 * d'incohérence entre une géométrie d'hier et un soleil d'aujourd'hui — qu'il
 * ne ferait gagner.
 *
 * ── Comportement ───────────────────────────────────────────────────────────
 * Chaque zone tourne dans son propre processus : une zone qui échoue n'emporte
 * pas les autres, et la mémoire est rendue entre deux. Le code de sortie est
 * non nul si au moins une zone a échoué, pour qu'un planificateur puisse
 * alerter au lieu de laisser passer.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '../web/public/data/zones.json');

/** Les grandes zones demandent plus de tas que le défaut de Node. */
const HEAP_MB = { paris: 8192 };
const DEFAULT_HEAP_MB = 4096;

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let zones;
try {
  zones = JSON.parse(readFileSync(INDEX, 'utf8')).map((z) => z.key);
} catch {
  console.error(
    `\n  ${INDEX} est introuvable ou illisible.\n` +
      `  Calculez au moins une zone avant de programmer le rafraîchissement.\n`,
  );
  process.exit(1);
}
if (only.length > 0) zones = zones.filter((z) => only.includes(z));

if (zones.length === 0) {
  console.error('\n  Aucune zone à rafraîchir.\n');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
console.log(`\n▌ Rafraîchissement SVET — ${today}`);
console.log(`  ${zones.length} zone(s) : ${zones.join(', ')}\n`);

const results = [];
for (const zone of zones) {
  const started = Date.now();
  process.stdout.write(`  ${zone.padEnd(8)} …`);
  const code = await run(zone);
  const seconds = (Date.now() - started) / 1000;
  results.push({ zone, code, seconds });
  process.stdout.write(
    `\r  ${zone.padEnd(8)} ${code === 0 ? '✓' : '✗ échec'}  ${formatDuration(seconds)}\n`,
  );
}

const failed = results.filter((r) => r.code !== 0);
const total = results.reduce((sum, r) => sum + r.seconds, 0);
console.log(`\n  ${results.length - failed.length}/${results.length} zones · ${formatDuration(total)}`);
if (failed.length > 0) {
  console.error(`  Échecs : ${failed.map((f) => f.zone).join(', ')}`);
  console.error('  Relancez la zone seule pour voir le détail :');
  console.error(`    node pipeline/src/build.js --zone=${failed[0].zone} --date=today\n`);
  process.exit(1);
}
console.log('  Toutes les zones sont à jour.\n');

function run(zone) {
  const heap = HEAP_MB[zone] ?? DEFAULT_HEAP_MB;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${heap}`, path.join(HERE, 'src/build.js'), `--zone=${zone}`, '--date=today'],
      // La sortie détaillée du build irait noyer le journal du planificateur ;
      // on ne garde que les erreurs, et le résumé par zone ci-dessus.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(Math.round(seconds % 60)).padStart(2, '0')} s`;
}
