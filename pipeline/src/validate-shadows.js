import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from './config.js';
import { createProjection, padBbox } from './lib/geo.js';
import { localToUTC, sunPosition, applyRefraction, DEG } from './lib/sun.js';
import { fetchBuildings } from './fetch/buildings.js';
import { fetchTrees } from './fetch/trees.js';
import { fetchOrtho, fetchFlightDates, writePNG } from './fetch/ortho.js';
import { buildDSM } from './dsm.js';
import { sunTransmission } from './shadow.js';

/**
 * Validation du modèle d'ombres contre les photographies aériennes de l'IGN.
 *
 * ── Le problème ────────────────────────────────────────────────────────────
 * Le graphe de mosaïquage de la BD ORTHO donne la **date** du vol, jamais
 * l'**heure**. On ne peut donc pas simplement calculer la position du soleil et
 * comparer.
 *
 * ── Le retournement ────────────────────────────────────────────────────────
 * On en fait un test plus fort : au lieu de connaître l'heure, on la
 * *cherche*. On balaie toutes les heures de la journée, on calcule les ombres
 * pour chacune, et on retient celle qui explique le mieux l'image.
 *
 * Ce que ça vaut : il n'y a qu'**un seul paramètre libre**, l'heure, pour
 * rendre compte simultanément des ombres de centaines de bâtiments de hauteurs
 * différentes. Si les hauteurs du modèle étaient fausses, aucune heure ne les
 * alignerait toutes à la fois — l'accord resterait médiocre et le maximum
 * s'étalerait. Un pic net et haut valide d'un coup les hauteurs APUR, le
 * relief, la projection et l'astronomie.
 *
 * ── Ce qu'on compare ───────────────────────────────────────────────────────
 * Uniquement les pixels de **sol dégagé** : ni toiture, ni feuillage. Deux
 * raisons. D'abord l'orthorectification s'appuie sur un modèle de terrain, pas
 * de surface : les toits sont déportés radialement, alors que les ombres au sol
 * sont, elles, correctement positionnées. Ensuite un feuillage est sombre qu'il
 * soit à l'ombre ou non, et fausserait la mesure.
 *
 * On corrèle la transmission calculée à la luminance observée, sans seuil ni
 * d'un côté ni de l'autre : un seuil serait un paramètre arbitraire de plus.
 *
 * Usage :
 *   node src/validate-shadows.js
 *   node src/validate-shadows.js --bbox=2.333,48.860,2.340,48.8635
 *   node src/validate-shadows.js --date=2024-08-27
 */

const OUT_DIR = path.resolve(fileURLToPath(new URL('../validation', import.meta.url)));

/**
 * Cour Carrée et Cour Napoléon du Louvre.
 *
 * Un bon site de validation demande de vastes surfaces dégagées bordées de
 * bâtiments hauts : l'ombre y a un bord franc, dont la position est très
 * sensible à la hauteur du soleil. Les cours du Louvre cochent tout, et la
 * Seine reste hors emprise — une rivière est sombre sans être à l'ombre.
 */
const DEFAULT_BBOX = [2.333, 48.86, 2.34, 48.8635];

/** Résolution de comparaison, en mètres par pixel. */
const DEFAULT_RES = 0.6;

/** Maille du modèle numérique de surface pour la validation. */
const DSM_RES = 0.75;

const SHADOW_MARGIN_M = 450;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bbox = args.bbox ?? DEFAULT_BBOX;
  const res = args.res ?? DEFAULT_RES;

  console.log('\n▌ Validation des ombres contre la BD ORTHO de l’IGN');
  console.log(`  emprise ${bbox.map((v) => v.toFixed(4)).join(', ')}\n`);

  // ------------------------------------------------------- dates candidates
  console.log('1/4  Dates de prise de vue');
  let flights = [];
  try {
    flights = await fetchFlightDates(bbox);
  } catch (error) {
    console.log(`     ⚠ graphe de mosaïquage indisponible (${error.message})`);
  }
  if (args.date) flights = [{ date: args.date, source: 'imposée en ligne de commande' }];
  if (flights.length === 0) {
    throw new Error('Aucune date de vol connue pour cette emprise. Précisez --date=AAAA-MM-JJ.');
  }
  for (const flight of flights) {
    console.log(
      `     ${flight.date}${flight.resolution ? ` · ${flight.resolution} m` : ''}` +
        `${flight.source ? ` · ${flight.source}` : ''}`,
    );
  }

  // ------------------------------------------------------------------ image
  console.log('\n2/4  Image aérienne');
  const ortho = await fetchOrtho(bbox, res);
  console.log(`     ${ortho.width} × ${ortho.height} pixels`);

  // -------------------------------------------------------------------- MNS
  console.log('\n3/4  Modèle numérique de surface');
  const dataBbox = padBbox(bbox, SHADOW_MARGIN_M);
  const projection = createProjection(dataBbox);
  const buildings = await fetchBuildings(dataBbox);
  const trees = await fetchTrees(dataBbox);

  // Le feuillage dépend de la saison, donc de la date du vol.
  const { grid, stats } = await buildDSM({
    projection,
    res: DSM_RES,
    bbox: dataBbox,
    buildings,
    trees,
    config: { ...CONFIG, surfaceModel: args.model ?? CONFIG.surfaceModel },
    date: flights[0].date,
  });
  console.log(
    `     géométrie ${stats.model === 'lidar' ? 'LiDAR HD' : 'vectorielle'} · ${buildings.length} bâtiments · ${trees.length} arbres`,
  );
  console.log(
    `     grille ${grid.width} × ${grid.height} · point le plus haut ${stats.maxHeight.toFixed(0)} m`,
  );

  // Chaque pixel de l'image, ramené sur la grille ; on ne garde que le sol nu.
  const samples = collectOpenGround(ortho, projection, grid);
  const openShare = ((100 * samples.count) / (ortho.width * ortho.height)).toFixed(0);
  console.log(`     ${samples.count} pixels de sol dégagé (${openShare} % de l’image)`);
  if (samples.count < 5000) {
    throw new Error('Trop peu de sol dégagé dans cette emprise pour conclure quoi que ce soit.');
  }

  // ------------------------------------------------------------- ajustement
  console.log('\n4/4  Recherche de l’heure qui explique les ombres');
  let best = null;
  for (const flight of flights) {
    const coarse = sweep(grid, samples, flight.date, 6 * 60, 21 * 60, 10, 4);
    const refined = sweep(
      grid,
      samples,
      flight.date,
      coarse.minutes - 15,
      coarse.minutes + 15,
      2,
      1,
    );
    const winner = refined.r > coarse.r ? refined : coarse;
    console.log(
      `     ${flight.date} → ${formatClock(winner.minutes)} · corrélation ${winner.r.toFixed(3)}` +
        ` · ${Math.round(winner.shadowShare * 100)} % à l’ombre`,
    );
    if (!best || winner.r > best.r) best = { ...winner, date: flight.date };
  }

  report(grid, samples, best);
  if (!args.brief) {
    profile(grid, samples, best);
    await heightSweep({
      projection,
      dataBbox,
      buildings,
      trees,
      ortho,
      best,
      bbox,
      model: stats.model,
    });
    await writeComparison(ortho, samples, grid, best, bbox);
  }

  // Résultat lisible par machine, pour la campagne multi-sites. Sur une seule
  // ligne et préfixé, pour être retrouvé sans analyser tout le journal.
  const scored = machineScore(grid, samples, best, ortho, res);
  console.log(
    `RESULTAT ${JSON.stringify({
      bbox,
      date: best.date,
      minutes: best.minutes,
      r: Number(best.r.toFixed(3)),
      shadowShare: Number(best.shadowShare.toFixed(3)),
      pixels: samples.count,
      model: stats.model,
      ...scored,
    })}`,
  );
}

/** Accord pixel et intersection sur union, à l'heure retenue. */
function machineScore(grid, samples, best, ortho, res) {
  const { agreement, iou, sunMean, shadowMean } =
    report(grid, samples, best, { quiet: true }) ?? {};

  // Dispersion de la luminance **à l'intérieur** de chaque classe. C'est elle
  // qui dit si un site est jugeable : sur du gravier mêlé de pelouse et de
  // pierre, deux pixels au même éclairement diffèrent déjà beaucoup, et aucun
  // seuil ne peut séparer proprement l'ombre du reste. Un contraste faible
  // devant la dispersion signale un problème de **surface**, pas de géométrie.
  const field = transmissionField(grid, samples, best.altitude, best.azimuth);
  let sunVar = 0;
  let sunN = 0;
  let shadowVar = 0;
  let shadowN = 0;
  for (let i = 0; i < samples.count; i++) {
    if (field[i] > 0.5) {
      sunVar += (samples.luminance[i] - sunMean) ** 2;
      sunN++;
    } else {
      shadowVar += (samples.luminance[i] - shadowMean) ** 2;
      shadowN++;
    }
  }
  const spread = Math.sqrt((sunVar + shadowVar) / Math.max(1, sunN + shadowN - 2));

  const best2 = bestPossibleSplit(samples);
  const sharp = sharpness(grid, samples, best);
  const edges = edgeAccuracy(ortho, samples, grid, best, res);
  // Témoin : la même mesure avec un soleil faux. Dans une image chargée de
  // bords, un bord calculé peut tomber près d un bord observé par hasard.
  // Si le témoin fait aussi bien, la mesure ne mesure rien.
  const decoy = sharp.shiftedSun
    ? edgeAccuracy(ortho, samples, grid, { ...best, ...sharp.shiftedSun }, res)
    : null;

  return {
    agreement: agreement === undefined ? null : Number(agreement.toFixed(3)),
    iou: iou === undefined ? null : Number(iou.toFixed(3)),
    contrast: Number((sunMean - shadowMean).toFixed(1)),
    spread: Number(spread.toFixed(1)),
    // Rapport signal/bruit obtenu **par le modèle**.
    separability: Number(((sunMean - shadowMean) / Math.max(1, spread)).toFixed(2)),
    // Et le même rapport pour la meilleure séparation possible de l'image, tous
    // modèles confondus. C'est lui qui dit si le site est jugeable.
    ceiling: Number(best2.separability.toFixed(2)),
    // Ce que devient la corrélation quand on décale l'heure de deux heures.
    // Un modèle qui décrirait des surfaces resterait au même niveau.
    rShifted: Number(sharp.shifted.toFixed(3)),
    /** Part de la corrélation perdue en décalant l'heure. */
    collapse: Number(sharp.collapse.toFixed(2)),
    overlap: Number(sharp.overlap.toFixed(3)),
    normalised: Number(sharp.normalised.toFixed(2)),
    edgeMedian: edges ? Number(edges.median.toFixed(2)) : null,
    edgeP90: edges ? Number(edges.p90.toFixed(2)) : null,
    within2m: edges ? Number(edges.within2m.toFixed(3)) : null,
    decoyMedian: decoy ? Number(decoy.median.toFixed(2)) : null,
    // Part du plafond que le modèle atteint. Proche de 1 : le modèle fait aussi
    // bien qu'on peut faire ici, et ce qui manque tient au site.
    reach: Number(
      ((sunMean - shadowMean) / Math.max(1, spread) / Math.max(0.01, best2.separability)).toFixed(
        2,
      ),
    ),
  };
}

/**
 * L'accord tient-il à l'heure, ou à la surface ?
 *
 * C'est la question que ni la séparabilité ni le plafond d'Otsu ne tranchaient.
 * Elle a pourtant une réponse simple : **on décale l'heure**. L'albédo des
 * surfaces ne bouge pas quand le soleil bouge. Un modèle qui décrirait du
 * gravier clair et de la pelouse sombre donnerait la même corrélation à 10 h et
 * à 16 h ; un modèle qui décrit des ombres s'effondre dès qu'on le décale.
 *
 * On retient le meilleur des deux décalages de ±2 h — le plus défavorable au
 * verdict, donc le plus honnête : si même le meilleur s'effondre, c'est net.
 */
function sharpness(grid, samples, best) {
  const reference = transmissionField(grid, samples, best.altitude, best.azimuth);

  let shifted = -1;
  let overlap = 1;
  /** Le soleil décalé retenu, pour servir de témoin à la mesure des bords. */
  let shiftedSun = null;
  for (const offset of [-120, 120]) {
    const minutes = best.minutes + offset;
    const hour = Math.floor(minutes / 60);
    const raw = sunPosition(localToUTC(best.date, hour, minutes - hour * 60), 48.8566, 2.3522);
    const altitude = applyRefraction(raw.altitude);
    if (altitude <= 0.05) continue;
    const r = score(grid, samples, altitude, raw.azimuth, 4).r;
    if (r <= shifted) continue;
    shifted = r;
    shiftedSun = { altitude, azimuth: raw.azimuth };

    // **Le contrôle qui manquait.** Décaler de deux heures ne déplace pas
    // l'ombre autant qu'on l'imagine : celle d'un gros bâtiment à midi et à
    // quatorze heures se recouvre largement. Si le champ du modèle n'a lui-même
    // presque pas changé, une corrélation qui survit ne prouve rien du tout.
    // On mesure donc de combien le modèle a bougé, pour rapporter l'un à l'autre.
    const other = transmissionField(grid, samples, altitude, raw.azimuth);
    let same = 0;
    for (let i = 0; i < samples.count; i++) {
      if (reference[i] > 0.5 === other[i] > 0.5) same++;
    }
    overlap = same / Math.max(1, samples.count);
  }
  if (shifted < 0) shifted = 0;

  const collapse = 1 - shifted / Math.max(1e-6, best.r);
  return {
    shifted,
    collapse,
    overlap,
    shiftedSun,
    // Effondrement rapporté à ce que le décalage pouvait produire. Si le champ
    // est identique à 90 %, seuls 10 % des pixels pouvaient changer d'avis :
    // exiger un effondrement de 50 % n'aurait aucun sens.
    normalised: collapse / Math.max(0.01, 1 - overlap),
  };
}

/**
 * De combien de mètres les bords d'ombre calculés tombent-ils à côté ?
 *
 * Une corrélation ne dit pas *où* le modèle se trompe, ni de combien. Elle mêle
 * dans un seul chiffre la justesse géométrique et le bruit de la photographie —
 * c'est pourquoi les sites ouverts paraissaient mauvais alors qu'ils étaient
 * seulement bruités.
 *
 * On mesure donc autre chose, et en mètres : la distance entre le **bord** de
 * l'ombre calculée et le bord de l'ombre observée. Un bord est un lieu, pas une
 * moyenne — il se compare directement, et le résultat se lit sans convention.
 *
 * La transformée de distance est un chamfer 3-4 en deux passes : approximation
 * de la distance euclidienne à 2 % près, pour un coût linéaire.
 */
function edgeAccuracy(ortho, samples, grid, best, metresPerPixel) {
  const { width, height } = ortho;
  const size = width * height;

  // 0 : hors sol dégagé · 1 : au soleil · 2 : à l'ombre, selon le modèle.
  const modelled = new Uint8Array(size);
  const observed = new Uint8Array(size);
  const field = transmissionField(grid, samples, best.altitude, best.azimuth);

  let sunSum = 0;
  let sunN = 0;
  let shadowSum = 0;
  let shadowN = 0;
  for (let i = 0; i < samples.count; i++) {
    if (field[i] > 0.5) {
      sunSum += samples.luminance[i];
      sunN++;
    } else {
      shadowSum += samples.luminance[i];
      shadowN++;
    }
  }
  const threshold = (sunSum / Math.max(1, sunN) + shadowSum / Math.max(1, shadowN)) / 2;

  for (let i = 0; i < samples.count; i++) {
    const p = samples.pixel[i];
    modelled[p] = field[i] > 0.5 ? 1 : 2;
    observed[p] = samples.luminance[i] >= threshold ? 1 : 2;
  }

  /** Pixels où la classe change entre deux voisins tous deux renseignés. */
  const edgesOf = (mask) => {
    const out = new Uint8Array(size);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const p = row * width + col;
        if (mask[p] === 0) continue;
        const right = col + 1 < width ? mask[p + 1] : 0;
        const down = row + 1 < height ? mask[p + width] : 0;
        if ((right && right !== mask[p]) || (down && down !== mask[p])) out[p] = 1;
      }
    }
    return out;
  };

  const modelEdges = edgesOf(modelled);
  const observedEdges = edgesOf(observed);

  // Transformée de distance depuis les bords observés, en unités de tiers de
  // pixel pour garder des entiers.
  const INF = 1 << 28;
  const distance = new Int32Array(size).fill(INF);
  for (let p = 0; p < size; p++) if (observedEdges[p]) distance[p] = 0;

  const relax = (p, q, cost) => {
    const candidate = distance[q] + cost;
    if (candidate < distance[p]) distance[p] = candidate;
  };
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const p = row * width + col;
      if (col > 0) relax(p, p - 1, 3);
      if (row > 0) relax(p, p - width, 3);
      if (row > 0 && col > 0) relax(p, p - width - 1, 4);
      if (row > 0 && col + 1 < width) relax(p, p - width + 1, 4);
    }
  }
  for (let row = height - 1; row >= 0; row--) {
    for (let col = width - 1; col >= 0; col--) {
      const p = row * width + col;
      if (col + 1 < width) relax(p, p + 1, 3);
      if (row + 1 < height) relax(p, p + width, 3);
      if (row + 1 < height && col + 1 < width) relax(p, p + width + 1, 4);
      if (row + 1 < height && col > 0) relax(p, p + width - 1, 4);
    }
  }

  const errors = [];
  for (let p = 0; p < size; p++) {
    if (!modelEdges[p] || distance[p] >= INF) continue;
    errors.push((distance[p] / 3) * metresPerPixel);
  }
  if (errors.length < 50) return null;

  errors.sort((a, b) => a - b);
  const at = (q) => errors[Math.floor((errors.length - 1) * q)];
  return {
    edges: errors.length,
    median: at(0.5),
    p90: at(0.9),
    // Part des bords calculés qui tombent à moins de deux mètres du bord
    // observé — l'ordre de grandeur d'un pas, et de l'incertitude sur la
    // hauteur d'un immeuble haussmannien.
    within2m: errors.filter((e) => e <= 2).length / errors.length,
  };
}

/**
 * Meilleure séparation en deux classes que l'image autorise, sans rien savoir.
 *
 * Le diagnostic précédent était **circulaire** : la séparabilité se mesurait
 * sur les classes du modèle, donc un modèle faux mélangeait les classes et
 * faisait chuter la séparabilité — ce qui l'aurait innocenté. On calcule donc
 * le plafond indépendamment, par la méthode d'Otsu : le seuil qui maximise la
 * variance entre classes de l'histogramme des luminances.
 *
 * Si ce plafond est bas, l'image elle-même n'a pas deux populations distinctes,
 * et **aucun** modèle ne pourrait mieux faire. Si le plafond est haut mais que
 * le modèle reste loin derrière, alors c'est bien le modèle qui se trompe.
 */
function bestPossibleSplit(samples) {
  const histogram = new Float64Array(256);
  for (let i = 0; i < samples.count; i++) {
    histogram[Math.max(0, Math.min(255, Math.round(samples.luminance[i])))]++;
  }

  let total = 0;
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    total += histogram[v];
    sum += v * histogram[v];
  }

  let bestVariance = -1;
  let threshold = 128;
  let belowCount = 0;
  let belowSum = 0;
  for (let v = 0; v < 256; v++) {
    belowCount += histogram[v];
    belowSum += v * histogram[v];
    const aboveCount = total - belowCount;
    if (belowCount === 0 || aboveCount === 0) continue;
    const meanBelow = belowSum / belowCount;
    const meanAbove = (sum - belowSum) / aboveCount;
    const between = belowCount * aboveCount * (meanAbove - meanBelow) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      threshold = v;
    }
  }

  // Contraste et dispersion intra-classe du meilleur découpage.
  let darkSum = 0;
  let darkN = 0;
  let lightSum = 0;
  let lightN = 0;
  for (let i = 0; i < samples.count; i++) {
    if (samples.luminance[i] < threshold) {
      darkSum += samples.luminance[i];
      darkN++;
    } else {
      lightSum += samples.luminance[i];
      lightN++;
    }
  }
  const darkMean = darkSum / Math.max(1, darkN);
  const lightMean = lightSum / Math.max(1, lightN);

  let variance = 0;
  for (let i = 0; i < samples.count; i++) {
    const mean = samples.luminance[i] < threshold ? darkMean : lightMean;
    variance += (samples.luminance[i] - mean) ** 2;
  }
  const spread = Math.sqrt(variance / Math.max(1, samples.count - 2));

  return { threshold, separability: (lightMean - darkMean) / Math.max(1, spread) };
}

/**
 * Profil de l'accord autour de l'heure retenue.
 *
 * C'est la partie qui donne son poids au résultat. Une corrélation de 0,66 ne
 * prouve rien toute seule : encore faut-il qu'elle s'effondre dès qu'on
 * s'écarte de l'heure trouvée. Si le modèle collait à n'importe quelle heure,
 * c'est qu'il ne décrirait rien.
 */
function profile(grid, samples, best) {
  console.log('\n  Sensibilité à l’heure — l’accord doit s’effondrer de part et d’autre :');
  console.log('    écart      heure    corrélation');
  for (const offset of [-180, -120, -60, -30, -10, 0, 10, 30, 60, 120, 180]) {
    const minutes = best.minutes + offset;
    const hour = Math.floor(minutes / 60);
    const raw = sunPosition(localToUTC(best.date, hour, minutes - hour * 60), 48.8566, 2.3522);
    const altitude = applyRefraction(raw.altitude);
    if (altitude <= 0.05) continue;
    const { r } = score(grid, samples, altitude, raw.azimuth, 4);
    const bar = '█'.repeat(Math.max(0, Math.round(r * 40)));
    console.log(
      `    ${(offset > 0 ? '+' : '') + offset} min`.padEnd(13) +
        `${formatClock(minutes)}   ${r.toFixed(3)}  ${bar}`,
    );
  }
}

/**
 * Le modèle prend la hauteur *moyenne* d'une emprise comme hauteur d'ombre.
 * Est-ce le bon choix ? Paris est une ville de toits mansardés : le faîtage est
 * plus haut que la moyenne, la gouttière plus basse. On rejoue l'ajustement en
 * multipliant toutes les hauteurs, et on regarde quel facteur explique le mieux
 * les ombres réelles. Un optimum à 1,0 valide `h_moy` ; ailleurs, il dit dans
 * quel sens corriger.
 */
async function heightSweep({ projection, dataBbox, buildings, trees, ortho, best, bbox, model }) {
  console.log('\n  Calage de la hauteur d’ombre — quel facteur sur les hauteurs APUR ?');
  console.log('    facteur   corrélation');

  const results = [];
  for (const scale of [0.8, 0.9, 1.0, 1.1, 1.2, 1.35]) {
    const { grid } = await buildDSM({
      projection,
      res: DSM_RES,
      bbox: dataBbox,
      buildings,
      trees,
      config: { ...CONFIG, surfaceModel: model, buildingHeightScale: scale },
      date: best.date,
    });
    const samples = collectOpenGround(ortho, projection, grid);
    const { r } = score(grid, samples, best.altitude, best.azimuth, 3);
    results.push({ scale, r });
    const bar = '█'.repeat(Math.max(0, Math.round(r * 40)));
    console.log(`    × ${scale.toFixed(2)}     ${r.toFixed(3)}  ${bar}`);
  }

  const winner = results.reduce((a, b) => (b.r > a.r ? b : a));
  const reference = results.find((r) => r.scale === 1);

  // Un optimum n'en est un que s'il dépasse nettement le facteur 1. Sur le
  // LiDAR, 1,00 et 1,10 se tiennent à 0,001 près : annoncer « les ombres
  // correspondent à 1,1 fois la hauteur » reviendrait à lire du bruit.
  const significant = winner.scale !== 1 && winner.r - reference.r > 0.005;
  console.log(
    significant
      ? `    → les ombres réelles correspondent à ${winner.scale.toFixed(2)} fois la hauteur du modèle.`
      : '    → les hauteurs du modèle sont les bonnes (l’optimum est plat autour de 1,00).',
  );
  void bbox;
}

// ---------------------------------------------------------------------------

/**
 * Associe chaque pixel de l'image à une cellule du MNS, en ne retenant que le
 * sol dégagé — ni bâti, ni houppier.
 */
function collectOpenGround(ortho, projection, grid) {
  const [west, south, east, north] = ortho.bbox;
  const pixel = [];
  const groundZ = [];
  const metricX = [];
  const metricY = [];
  const luminance = [];
  let builtPixels = 0;
  let canopyPixels = 0;

  for (let row = 0; row < ortho.height; row++) {
    // L'image est orientée nord en haut : la ligne 0 est la latitude maximale.
    const lat = north - ((row + 0.5) / ortho.height) * (north - south);
    for (let col = 0; col < ortho.width; col++) {
      const lon = west + ((col + 0.5) / ortho.width) * (east - west);
      const [x, y] = projection.forward(lon, lat);
      const idx = grid.index(x, y);
      if (idx < 0) continue;

      const ground = grid.ground[idx];
      if (grid.surface[idx] - ground > 0.5) {
        builtPixels++;
        continue; // bâti
      }
      if (grid.canopyTop[idx] - ground > 0.5) {
        canopyPixels++;
        continue; // feuillage
      }

      pixel.push(row * ortho.width + col);
      groundZ.push(ground);
      metricX.push(x);
      metricY.push(y);
      luminance.push(ortho.luminance[row * ortho.width + col]);
    }
  }

  return {
    count: pixel.length,
    builtShare: builtPixels / (ortho.width * ortho.height),
    canopyShare: canopyPixels / (ortho.width * ortho.height),
    pixel: Int32Array.from(pixel),
    x: Float64Array.from(metricX),
    y: Float64Array.from(metricY),
    z: Float64Array.from(groundZ),
    luminance: Float32Array.from(luminance),
  };
}

/**
 * Balaie une plage horaire et retient l'heure la mieux corrélée à l'image.
 *
 * @param {number} stride n'échantillonner qu'un pixel sur `stride` — le
 *   balayage grossier n'a pas besoin de tous les points.
 */
function sweep(grid, samples, date, fromMinutes, toMinutes, stepMinutes, stride) {
  let best = { minutes: fromMinutes, r: -Infinity, shadowShare: 0, altitude: 0, azimuth: 0 };

  for (let minutes = fromMinutes; minutes <= toMinutes; minutes += stepMinutes) {
    const hour = Math.floor(minutes / 60);
    const raw = sunPosition(localToUTC(date, hour, minutes - hour * 60), 48.8566, 2.3522);
    const altitude = applyRefraction(raw.altitude);
    if (altitude <= 0.05) continue;

    const scored = score(grid, samples, altitude, raw.azimuth, stride);
    if (scored.r > best.r) {
      best = { minutes, altitude, azimuth: raw.azimuth, ...scored };
    }
  }
  return best;
}

/**
 * Corrélation de Pearson entre la transmission calculée et la luminance
 * observée, sur les pixels de sol dégagé.
 *
 * Aucun seuil n'est appliqué : ni sur l'image, ni sur le modèle. Un seuil
 * serait un paramètre libre supplémentaire, et l'intérêt de la démarche tient
 * justement à n'en avoir qu'un seul.
 */
function score(grid, samples, altitude, azimuth, stride) {
  const maxDistance = Math.min(600, grid.maxHeight / Math.max(Math.tan(altitude), 0.02));
  let n = 0;
  let sumT = 0;
  let sumL = 0;
  let sumTT = 0;
  let sumLL = 0;
  let sumTL = 0;
  let shadowed = 0;

  for (let i = 0; i < samples.count; i += stride) {
    const t = sunTransmission(
      grid,
      samples.x[i],
      samples.y[i],
      samples.z[i] + 0.05,
      azimuth,
      altitude,
      maxDistance,
    ).transmission;
    const l = samples.luminance[i];

    n++;
    sumT += t;
    sumL += l;
    sumTT += t * t;
    sumLL += l * l;
    sumTL += t * l;
    if (t < 0.5) shadowed++;
  }

  const covariance = sumTL / n - (sumT / n) * (sumL / n);
  const varianceT = sumTT / n - (sumT / n) ** 2;
  const varianceL = sumLL / n - (sumL / n) ** 2;
  const denominator = Math.sqrt(Math.max(varianceT, 0) * Math.max(varianceL, 0));

  return {
    r: denominator > 1e-9 ? covariance / denominator : 0,
    shadowShare: shadowed / n,
  };
}

/** Transmission de chaque pixel de sol dégagé, pour une position du soleil. */
function transmissionField(grid, samples, altitude, azimuth) {
  const maxDistance = Math.min(600, grid.maxHeight / Math.max(Math.tan(altitude), 0.02));
  const field = new Float32Array(samples.count);
  for (let i = 0; i < samples.count; i++) {
    field[i] = sunTransmission(
      grid,
      samples.x[i],
      samples.y[i],
      samples.z[i] + 0.05,
      azimuth,
      altitude,
      maxDistance,
    ).transmission;
  }
  return field;
}

function report(grid, samples, best, { quiet = false } = {}) {
  const field = transmissionField(grid, samples, best.altitude, best.azimuth);

  // Séparation des luminances : à quel point l'ombre calculée tombe-t-elle sur
  // des pixels effectivement plus sombres ?
  let sunSum = 0;
  let sunN = 0;
  let shadowSum = 0;
  let shadowN = 0;
  for (let i = 0; i < samples.count; i++) {
    if (field[i] > 0.5) {
      sunSum += samples.luminance[i];
      sunN++;
    } else {
      shadowSum += samples.luminance[i];
      shadowN++;
    }
  }
  const sunMean = sunSum / Math.max(sunN, 1);
  const shadowMean = shadowSum / Math.max(shadowN, 1);

  // Accord binaire, en coupant l'image à mi-chemin entre les deux moyennes.
  const threshold = (sunMean + shadowMean) / 2;
  let intersection = 0;
  let union = 0;
  let agree = 0;
  for (let i = 0; i < samples.count; i++) {
    const modelled = field[i] < 0.5;
    const observed = samples.luminance[i] < threshold;
    if (modelled && observed) intersection++;
    if (modelled || observed) union++;
    if (modelled === observed) agree++;
  }

  const agreement = agree / samples.count;
  const iou = intersection / Math.max(union, 1);
  // Appelé pour ses chiffres et non pour son journal : la campagne multi-sites
  // veut les valeurs, pas l'encadré.
  if (quiet) return { agreement, iou, sunMean, shadowMean };

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  Vol du ${best.date}`);
  console.log(`  Heure retrouvée          ${formatClock(best.minutes)} (heure locale)`);
  console.log(
    `  Soleil correspondant     ${(best.altitude * DEG).toFixed(1)}° de hauteur, ` +
      `azimut ${(best.azimuth * DEG).toFixed(0)}°`,
  );
  console.log(`  Corrélation              ${best.r.toFixed(3)}`);
  console.log(`  Accord pixel à pixel     ${((100 * agree) / samples.count).toFixed(1)} %`);
  console.log(
    `  Recouvrement des ombres  ${((100 * intersection) / Math.max(union, 1)).toFixed(1)} % (IoU)`,
  );
  console.log(
    `  Luminance moyenne        ${sunMean.toFixed(0)} au soleil contre ` +
      `${shadowMean.toFixed(0)} à l’ombre (écart ${(sunMean - shadowMean).toFixed(0)})`,
  );
  console.log(`  Part calculée à l’ombre  ${(best.shadowShare * 100).toFixed(0)} %`);
  console.log('─────────────────────────────────────────────────────────────');

  judgeSite(samples, best, sunMean - shadowMean);
}

/**
 * Tous les sites ne se valent pas pour juger le modèle.
 *
 * Un bon site offre de vastes surfaces minérales dégagées bordées de bâtiments
 * hauts : le contraste soleil/ombre y est franc et le bord de l'ombre net. Un
 * quartier planté d'arbres ou fait de rues étroites est un mauvais juge, pour
 * deux raisons qui n'ont rien à voir avec la qualité du modèle : un feuillage
 * est sombre qu'il soit éclairé ou non, et l'orthorectification s'appuie sur un
 * modèle de terrain, si bien que les façades penchent dans les rues étroites et
 * les assombrissent artificiellement.
 *
 * Sans ce garde-fou, on prendrait un mauvais site pour un mauvais modèle.
 */
function judgeSite(samples, best, contrast) {
  const reasons = [];
  if (contrast < 55) reasons.push(`contraste faible (${contrast.toFixed(0)} niveaux de gris)`);
  if (best.shadowShare < 0.12)
    reasons.push(`trop peu d’ombre (${Math.round(best.shadowShare * 100)} %)`);
  if (best.shadowShare > 0.6)
    reasons.push(`presque tout à l’ombre (${Math.round(best.shadowShare * 100)} %)`);
  if (samples.canopyShare > 0.2) {
    reasons.push(
      `couvert arboré envahissant (${Math.round(samples.canopyShare * 100)} % de l’image)`,
    );
  }

  if (reasons.length === 0) {
    console.log('  Site favorable : le chiffre ci-dessus juge bien le modèle.');
  } else {
    console.log(`  ⚠ Site peu favorable — ${reasons.join(', ')}.`);
    console.log('    Un accord médiocre ici en dit plus long sur le site que sur le modèle.');
    console.log('    Préférez de vastes cours ou esplanades minérales bordées d’immeubles hauts.');
  }
}

/**
 * Trois panneaux côte à côte : l'image aérienne, l'ombre observée, l'ombre
 * calculée. Un chiffre d'accord ne dit pas *où* le modèle se trompe ; une image
 * le montre en une seconde.
 */
async function writeComparison(ortho, samples, grid, best, bbox) {
  const field = transmissionField(grid, samples, best.altitude, best.azimuth);
  const { width, height } = ortho;
  const wide = width * 3;
  const rgb = new Uint8Array(wide * height * 3);

  // Fond : bâti et végétation, en bleu nuit, sur les panneaux 2 et 3.
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const source = (row * width + col) * 3;
      for (const panel of [0, 1, 2]) {
        const target = (row * wide + panel * width + col) * 3;
        if (panel === 0) {
          rgb[target] = ortho.rgb[source];
          rgb[target + 1] = ortho.rgb[source + 1];
          rgb[target + 2] = ortho.rgb[source + 2];
        } else {
          rgb[target] = 12;
          rgb[target + 1] = 18;
          rgb[target + 2] = 32;
        }
      }
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < samples.count; i++) {
    if (samples.luminance[i] < min) min = samples.luminance[i];
    if (samples.luminance[i] > max) max = samples.luminance[i];
  }
  const span = Math.max(max - min, 1);

  for (let i = 0; i < samples.count; i++) {
    const pixel = samples.pixel[i];
    const row = Math.floor(pixel / width);
    const col = pixel - row * width;

    // Panneau 2 : la luminance observée, étirée sur toute la dynamique.
    const observed = Math.round(((samples.luminance[i] - min) / span) * 255);
    const p2 = (row * wide + width + col) * 3;
    rgb[p2] = observed;
    rgb[p2 + 1] = observed;
    rgb[p2 + 2] = observed;

    // Panneau 3 : la transmission calculée, même échelle de gris.
    const modelled = Math.round(field[i] * 255);
    const p3 = (row * wide + 2 * width + col) * 3;
    rgb[p3] = modelled;
    rgb[p3 + 1] = modelled;
    rgb[p3 + 2] = modelled;
  }

  const name = `ombres-${best.date}-${formatClock(best.minutes).replace(':', 'h')}.png`;
  const file = path.join(OUT_DIR, name);
  await writePNG(file, wide, height, rgb);
  console.log(`\n  Comparaison écrite : ${file}`);
  console.log(
    '  À gauche l’image aérienne, au centre l’ombre observée, à droite l’ombre calculée.',
  );
  console.log(`  Emprise ${bbox.map((v) => v.toFixed(4)).join(', ')}\n`);
}

function formatClock(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  return `${String(h).padStart(2, '0')}:${String(total - h * 60).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--bbox=')) out.bbox = arg.slice(7).split(',').map(Number);
    else if (arg.startsWith('--res=')) out.res = Number(arg.slice(6));
    else if (arg.startsWith('--date=')) out.date = arg.slice(7);
    else if (arg.startsWith('--model=')) out.model = arg.slice(8);
    // Campagne multi-sites : on ne veut que le chiffre, ni profil de
    // sensibilité, ni balayage des hauteurs, ni image de comparaison.
    else if (arg === '--brief') out.brief = true;
  }
  return out;
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
