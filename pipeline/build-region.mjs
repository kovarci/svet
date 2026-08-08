import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

import { CONFIG } from './src/config.js';
import { CACHE_DIR } from './src/lib/http.js';
import {
  CELL_ZOOM,
  SEGMENT_BITS,
  cellIdBase,
  cellsOf,
  fetchBoundary,
  gridOrigin,
  resolveRegion,
} from './src/region.js';
import { tileOf } from './src/lib/tiles.js';

/**
 * Construction d'une région entière, cellule par cellule.
 *
 * ── Pourquoi un processus par cellule ──────────────────────────────────────
 * Une cellule d'Île-de-France, c'est une grille de treize millions et demi de
 * cases et deux rasters LiDAR de la même taille : entre un et deux gigaoctets
 * de tas au plus fort du calcul. Node ne rend pas cette mémoire au système, il
 * la garde pour le prochain tour. Trois cent quarante-trois cellules dans un
 * seul processus finiraient donc par fragmenter le tas jusqu'à l'échec — après
 * plusieurs heures de calcul, ce qui est le plus mauvais moment pour échouer.
 *
 * Un processus par cellule rend la mémoire à chaque fois, et il isole les
 * pannes : une commune dont le WFS bégaie ne fait pas tomber la région.
 *
 * ── Pourquoi un manifeste ──────────────────────────────────────────────────
 * La construction complète se compte en heures. Elle sera interrompue — coupure
 * réseau, machine en veille, quota d'un service atteint. Le manifeste note ce
 * qui est fait ; relancer reprend là où on s'était arrêté au lieu de tout
 * refaire.
 */

const OUT_ROOT = path.resolve(fileURLToPath(new URL('../web/public/data', import.meta.url)));
const BUILD_SCRIPT = fileURLToPath(new URL('./src/build.js', import.meta.url));

/**
 * Zooms de l'aperçu régional.
 *
 * Ils s'arrêtent juste sous le découpage : au zoom 12 et au-delà, chaque tuile
 * appartient à une cellule qui l'a déjà écrite. En dessous, une tuile couvre
 * plusieurs cellules — aucune ne peut l'écrire seule, d'où cette passe finale.
 *
 * Le plancher à 8 laisse voir la région entière et ses marges. Plus bas, on
 * cartographierait la France pour montrer l'Île-de-France.
 */
const OVERVIEW_MIN_ZOOM = 8;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = resolveRegion(args.region ?? 'idf');
  const date = args.date ?? CONFIG.date;
  const outDir = path.join(OUT_ROOT, region.key);
  const cellDir = path.join(outDir, 'cellules');
  await mkdir(cellDir, { recursive: true });

  console.log(`\n▌ SVET — ${region.label}, construction régionale`);
  console.log(`  date ${date} · maille ${region.res} m · découpage au zoom ${CELL_ZOOM}`);

  const rings = await fetchBoundary(region);
  const origin = gridOrigin(region);
  const cells = cellsOf(region, rings);

  // `--only` restreint **ce qu'on calcule**, jamais ce qu'on publie. Confondre
  // les deux faisait qu'un recalcul d'une seule cellule réécrivait l'index avec
  // cette seule cellule : tout le reste de la région, pourtant intact sur le
  // disque, disparaissait de l'application.
  const wanted = args.only ? new Set(args.only.split(',')) : null;
  const selected = wanted ? cells.filter((cell) => wanted.has(cell.key)) : cells;
  console.log(
    `  ${cells.length} cellules dans la région` +
      `${wanted ? ` · ${selected.length} demandées` : ''}\n`,
  );

  const manifestPath = path.join(outDir, 'manifeste.json');
  const manifest = args.force ? {} : await readManifest(manifestPath);

  // Le manifeste n'est pas la vérité : les fichiers le sont. Une cellule
  // calculée à la main, ou un manifeste perdu, ne doivent pas condamner des
  // heures de calcul à être refaites. On adopte donc ce qui est déjà sur le
  // disque et qui porte la bonne date.
  const adopted = await adoptExisting(cellDir, cells, manifest, date);
  if (adopted > 0) console.log(`  ${adopted} cellules déjà présentes sur le disque, reprises\n`);

  if (!args.indexOnly) {
    const pending = selected.filter((cell) => {
      const done = manifest[cell.key];
      return !(done?.status === 'ok' && done.date === date);
    });
    console.log(
      `  ${selected.length - pending.length} déjà à jour · ${pending.length} à calculer` +
        `${args.limit ? ` (limité à ${args.limit})` : ''}\n`,
    );

    const queue = args.limit ? pending.slice(0, args.limit) : pending;
    await runQueue(queue, args.jobs, async (cell, position) => {
      const label = `[${position}/${queue.length}] ${cell.key}`;
      const started = Date.now();
      const result = await runCell(cell, region, date, args);
      const seconds = (Date.now() - started) / 1000;

      manifest[cell.key] = {
        ...result,
        date,
        seconds: Math.round(seconds),
        at: new Date().toISOString(),
      };
      await writeManifest(manifestPath, manifest);

      const mark = result.status === 'ok' ? '✓' : '✗';
      const detail =
        result.status === 'ok'
          ? `${String(result.segments).padStart(6)} tronçons · ${result.surfaceModel}`
          : result.error;
      console.log(`  ${mark} ${label.padEnd(24)} ${formatDuration(seconds).padStart(10)}  ${detail}`);

      const freed = await pruneRasterCache(args.cacheBudget);
      if (freed > 0) console.log(`    cache rasters : ${(freed / 1e9).toFixed(1)} Go libérés`);
    });
  }

  // ------------------------------------------------------------ assemblage
  // Y compris après `--index-only`, qui ne passe pas par la boucle de calcul :
  // ce qu'on vient d'adopter depuis le disque doit être noté, sinon le
  // manifeste reste absent et le prochain lancement refait le tour des
  // métadonnées pour retrouver ce qu'il savait déjà.
  await writeManifest(manifestPath, manifest);

  const ok = cells.filter((cell) => manifest[cell.key]?.status === 'ok');
  const failed = cells.filter((cell) => manifest[cell.key]?.status === 'échec');
  // Une cellule ni faite ni échouée n'a simplement pas été lancée — c'est le
  // cas courant avec `--only` ou `--limit`, et il ne faut pas le confondre avec
  // une région terminée : le compte doit dire ce qui manque.
  const untouched = cells.length - ok.length - failed.length;
  console.log(
    `\n  ${ok.length} cellules calculées · ${failed.length} en échec` +
      `${untouched > 0 ? ` · ${untouched} non lancées` : ''}`,
  );

  if (ok.length === 0) {
    console.error('\n✗ Aucune cellule calculée : rien à assembler.\n');
    process.exit(1);
  }

  console.log('\n▌ Aperçu régional');
  const overview = await writeOverview(outDir, cellDir, ok, region);
  console.log(`  ${overview.tiles} tuiles de zoom ${OVERVIEW_MIN_ZOOM} à ${CELL_ZOOM - 1}` +
    ` (${(overview.bytes / 1e6).toFixed(1)} Mo)`);

  console.log('\n▌ Index régional');
  const index = await writeIndex(outDir, cellDir, region, origin, ok, manifest, date);
  console.log(`  ${index.cells} cellules · ${index.segments.toLocaleString('fr-FR')} tronçons`);
  console.log(`  ${(index.bytes / 1e6).toFixed(0)} Mo de binaires`);

  if (failed.length > 0) {
    console.error(`\n⚠ ${failed.length} cellules en échec :`);
    for (const cell of failed.slice(0, 10)) {
      console.error(`    ${cell.key} — ${manifest[cell.key].error}`);
    }
    console.error('  Relancez la commande : seules celles-ci seront reprises.\n');
    process.exit(1);
  }
  if (untouched > 0) {
    console.log(
      `\n✓ ${ok.length} cellules servies sur ${cells.length}.` +
        ` Relancez sans --only ni --limit pour les ${untouched} restantes.\n`,
    );
  } else {
    console.log('\n✓ Région complète.\n');
  }
}

// ---------------------------------------------------------------------------

/**
 * Calcule une cellule dans un processus fils.
 *
 * La sortie n'est pas retransmise telle quelle : trois cent quarante-trois
 * cellules qui déroulent chacune soixante-neuf pas de temps feraient
 * vingt-cinq mille lignes de journal. On ne garde que la fin, et seulement en
 * cas d'échec — c'est là qu'elle sert.
 */
function runCell(cell, region, date, args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${args.memory}`,
        BUILD_SCRIPT,
        `--cell=${cell.key}`,
        `--region=${region.key}`,
        `--date=${date}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    child.on('error', (error) => resolve({ status: 'échec', error: error.message }));
    child.on('close', async (code) => {
      if (code !== 0) {
        const reason = tail.match(/✗ (.+)/)?.[1] ?? `code de sortie ${code}`;
        resolve({ status: 'échec', error: reason.trim().slice(0, 200) });
        return;
      }
      try {
        const meta = JSON.parse(
          await readFile(path.join(OUT_ROOT, region.key, 'cellules', `${cell.key}.meta.json`), 'utf8'),
        );
        resolve({
          status: 'ok',
          segments: meta.segmentCount,
          nodes: meta.nodeCount,
          surfaceModel: meta.surfaceModel,
          lidarCoverage: meta.lidarCoverage,
          stamp: meta.generatedAt.replace(/\D/g, '').slice(0, 14),
        });
      } catch (error) {
        resolve({ status: 'échec', error: `métadonnées illisibles (${error.message})` });
      }
    });
  });
}

/**
 * Borne le cache des rasters LiDAR.
 *
 * Une cellule couverte télécharge deux grilles de treize millions de flottants,
 * soit environ 110 Mo de dalles BIL qu'on garde pour ne pas les redemander. Sur
 * les deux cents cellules couvertes d'Île-de-France, ça fait vingt-deux
 * gigaoctets — de quoi remplir un disque en cours de route, plusieurs heures
 * après le début, et perdre ce qui restait à faire.
 *
 * Or ce cache ne sert à rien entre cellules : chacune demande sa propre emprise,
 * personne ne relit celle du voisin. Il n'est utile qu'au **redémarrage** d'une
 * cellule qui a échoué en cours de calcul. On garde donc de quoi couvrir les
 * dernières, et on jette le reste par ancienneté.
 *
 * Les autres entrées du cache — bâti, réseau, végétation — ne sont pas touchées :
 * elles pèsent mille fois moins et se paient en secondes de service tiers.
 *
 * @returns {Promise<number>} octets libérés
 */
async function pruneRasterCache(budget) {
  let files;
  try {
    files = (await readdir(CACHE_DIR)).filter((name) => name.startsWith('raster-'));
  } catch {
    return 0;
  }

  const entries = [];
  let total = 0;
  for (const name of files) {
    const file = path.join(CACHE_DIR, name);
    try {
      const info = await stat(file);
      entries.push({ file, size: info.size, at: info.mtimeMs });
      total += info.size;
    } catch {
      // Fichier disparu entre-temps : rien à compter.
    }
  }
  if (total <= budget) return 0;

  entries.sort((a, b) => a.at - b.at);
  let freed = 0;
  for (const entry of entries) {
    if (total - freed <= budget) break;
    try {
      await unlink(entry.file);
      freed += entry.size;
    } catch {
      // Verrouillé par un calcul voisin : on le reprendra au tour suivant.
    }
  }
  return freed;
}

/** Exécute la file avec au plus `jobs` calculs simultanés. */
async function runQueue(items, jobs, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const position = next++;
      await worker(items[position], position + 1);
    }
  });
  await Promise.all(runners);
}

/**
 * Tuiles des zooms où une tuile déborde de sa cellule.
 *
 * On relit les aperçus plutôt que les géométries complètes : à ces échelles, le
 * réseau capillaire ne se voit pas, et le charger entier demanderait plusieurs
 * gigaoctets de JSON pour un résultat identique au pixel près.
 */
async function writeOverview(outDir, cellDir, cells, region) {
  const features = [];
  for (const cell of cells) {
    try {
      const part = JSON.parse(await readFile(path.join(cellDir, `${cell.key}.apercu.json`), 'utf8'));
      features.push(...part.features);
    } catch {
      // Une cellule sans aperçu est une cellule sans voie structurante : rien
      // à dire à l'échelle régionale.
    }
  }
  console.log(`  ${features.length.toLocaleString('fr-FR')} tronçons structurants`);

  const index = geojsonvt(
    { type: 'FeatureCollection', features },
    { maxZoom: CELL_ZOOM - 1, indexMaxZoom: CELL_ZOOM - 1, tolerance: 5, extent: 4096, buffer: 64 },
  );

  const tilesDir = path.join(outDir, 'tuiles');
  const [west, south, east, north] = region.bbox;
  let tiles = 0;
  let bytes = 0;

  for (let z = OVERVIEW_MIN_ZOOM; z < CELL_ZOOM; z++) {
    const [x0, y0] = tileOf(west, north, z);
    const [x1, y1] = tileOf(east, south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const tile = index.getTile(z, x, y);
        const buffer =
          tile && tile.features.length > 0
            ? Buffer.from(vtpbf.fromGeojsonVt({ reseau: tile }, { version: 2 }))
            : Buffer.alloc(0);
        const file = path.join(tilesDir, String(z), String(x), `${y}.pbf`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, buffer);
        tiles++;
        bytes += buffer.length;
      }
    }
  }
  return { tiles, bytes };
}

/**
 * Index régional : ce que l'application lit en premier.
 *
 * Les réglages communs (barème, pondérations, pas de temps) viennent d'une
 * cellule de référence, celle qui contient le centre de la région. Ils sont
 * identiques d'une cellule à l'autre, à une exception près qu'il faut nommer :
 * **la position du soleil**. Chaque cellule a calculé ses ombres avec le soleil
 * vu de chez elle — c'est le calcul coûteux, et il est juste. Ce que l'index
 * publie, ce sont les angles vus du centre de la région : ils servent à
 * l'affichage (l'heure, la hauteur annoncée, l'éblouissement dans l'axe du
 * regard), et l'écart d'un bout à l'autre de l'Île-de-France y reste sous deux
 * degrés d'azimut.
 */
async function writeIndex(outDir, cellDir, region, origin, cells, manifest, date) {
  const centre = [(region.bbox[0] + region.bbox[2]) / 2, (region.bbox[1] + region.bbox[3]) / 2];
  const [cx, cy] = tileOf(centre[0], centre[1], CELL_ZOOM);
  const reference =
    cells.find((cell) => cell.x === cx && cell.y === cy) ??
    // Le centre géométrique de l'emprise peut tomber hors du territoire ; on
    // prend alors la cellule calculée la plus proche.
    cells.reduce((best, cell) =>
      Math.hypot(cell.x - cx, cell.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? cell : best,
    );
  const meta = JSON.parse(await readFile(path.join(cellDir, `${reference.key}.meta.json`), 'utf8'));

  let segments = 0;
  let bytes = 0;
  const entries = [];
  for (const cell of cells) {
    const record = manifest[cell.key];
    segments += record.segments ?? 0;
    entries.push({
      key: cell.key,
      x: cell.x,
      y: cell.y,
      bbox: cell.bbox.map((v) => Number(v.toFixed(6))),
      idBase: cellIdBase(origin, cell.x, cell.y),
      segments: record.segments,
      surfaceModel: record.surfaceModel,
      stamp: record.stamp,
    });
  }
  bytes = entries.reduce((sum, entry) => sum + (entry.segments ?? 0) * 192, 0);

  const index = {
    region: region.key,
    label: region.label,
    kind: 'region',
    bbox: region.bbox,
    center: centre,
    date,
    resolution: region.res,
    cellZoom: CELL_ZOOM,
    segmentBits: SEGMENT_BITS,
    gridOrigin: origin,
    tiles: { minZoom: OVERVIEW_MIN_ZOOM, maxZoom: 16, bounds: region.bbox },
    // Réglages partagés, repris tels quels par l'affichage.
    weights: meta.weights,
    albedo: meta.albedo,
    groundAlbedo: meta.groundAlbedo,
    luxReference: meta.luxReference,
    horizonBins: meta.horizonBins,
    walkingSpeed: meta.walkingSpeed,
    crossingPenalty: meta.crossingPenalty,
    scale: meta.scale,
    times: meta.times,
    leafOn: meta.leafOn,
    sources: meta.sources,
    counts: { cells: entries.length, segments },
    generatedAt: new Date().toISOString(),
  };
  index.stamp = index.generatedAt.replace(/\D/g, '').slice(0, 14);
  index.cells = entries;

  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index));
  await registerInZoneIndex(region, index);
  return { cells: entries.length, segments, bytes };
}

/**
 * Inscrit la région au menu de l'application.
 *
 * Elle y prend place à côté des zones, avec `kind: 'region'` pour seule
 * différence — c'est ce champ qui fait basculer le chargement du fichier unique
 * vers les cellules. Les zones nommées restent : elles chargent d'un bloc, ce
 * qui est encore ce qu'il y a de plus rapide quand on ne quitte pas Paris.
 */
async function registerInZoneIndex(region, index) {
  const file = path.join(OUT_ROOT, 'zones.json');
  let zones = [];
  try {
    zones = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Aucune zone calculée : la région ouvrira le bal.
  }
  zones = zones.filter((zone) => zone.key !== region.key);
  zones.push({
    key: region.key,
    kind: 'region',
    region: region.key,
    label: index.label,
    bbox: index.bbox,
    center: index.center,
    date: index.date,
    stamp: index.stamp,
  });
  zones.sort((a, b) => a.key.localeCompare(b.key));
  await writeFile(file, JSON.stringify(zones, null, 2));
}

// ---------------------------------------------------------------------------

/**
 * Complète le manifeste à partir des métadonnées déjà écrites.
 * @returns {Promise<number>} nombre de cellules adoptées
 */
async function adoptExisting(cellDir, cells, manifest, date) {
  let adopted = 0;
  for (const cell of cells) {
    if (manifest[cell.key]?.status === 'ok' && manifest[cell.key].date === date) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(cellDir, `${cell.key}.meta.json`), 'utf8'));
      if (meta.date !== date) continue;
      manifest[cell.key] = {
        status: 'ok',
        segments: meta.segmentCount,
        nodes: meta.nodeCount,
        surfaceModel: meta.surfaceModel,
        lidarCoverage: meta.lidarCoverage,
        stamp: meta.generatedAt.replace(/\D/g, '').slice(0, 14),
        date,
        at: meta.generatedAt,
      };
      adopted++;
    } catch {
      // Pas de métadonnées : la cellule reste à calculer.
    }
  }
  return adopted;
}

async function readManifest(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeManifest(file, manifest) {
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

/**
 * Arrondir les secondes **avant** de les décomposer, et non après.
 *
 * L'inverse produisait « 11 min 60 s » : 719,7 s donne onze minutes de quotient,
 * et un reste de 59,7 qui s'arrondit à soixante.
 */
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
}

function parseArgs(argv) {
  const out = { jobs: 2, memory: 8192, cacheBudget: 3e9 };
  for (const arg of argv) {
    if (arg === '--force') out.force = true;
    else if (arg === '--index-only') out.indexOnly = true;
    else if (arg.startsWith('--region=')) out.region = arg.slice(9);
    else if (arg.startsWith('--only=')) out.only = arg.slice(7);
    else if (arg.startsWith('--jobs=')) out.jobs = Math.max(1, Number(arg.slice(7)));
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice(8));
    else if (arg.startsWith('--memory=')) out.memory = Number(arg.slice(9));
    else if (arg.startsWith('--cache-go=')) out.cacheBudget = Number(arg.slice(11)) * 1e9;
    else if (arg.startsWith('--date=')) {
      const value = arg.slice(7);
      out.date = value === 'today' ? new Date().toISOString().slice(0, 10) : value;
    }
  }
  return out;
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
