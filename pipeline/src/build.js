import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, resolveZone } from './config.js';
import {
  resolveRegion,
  parseCellKey,
  gridOrigin,
  cellIdBase,
  MAX_SEGMENTS_PER_CELL,
} from './region.js';
import { createProjection, padBbox } from './lib/geo.js';
import { localToUTC, sunPosition, applyRefraction, DEG } from './lib/sun.js';
import { fetchBuildings, buildingHeight } from './fetch/buildings.js';
import { fetchVegetation } from './fetch/vegetation.js';
import { fetchTrees } from './fetch/trees.js';
import {
  fetchLighting,
  lampsFromOSM,
  lightingIsMapped,
  MIN_LAMPS_PER_KM,
} from './fetch/lighting.js';
import { indexLamps, veilAt, coveredAt } from './night.js';
import { fetchWorksites } from './fetch/worksites.js';
import { indexWorksites, blockedAt } from './worksites.js';
import { fetchNetwork, isWalkable, isCovered, isCrossing, coverKind } from './fetch/network.js';
import {
  buildEdgeIndex,
  coverageAlong,
  parentStreet,
  isMappedSidewalk,
  isStreetAxis,
  declaredAbsent,
} from './sidewalks.js';
import { buildDSM } from './dsm.js';
import { sunTransmission, skyViewFactor, distanceToFacade } from './shadow.js';
import { flickerFactor, cardinalLabel, SCALE } from './model.js';
import { buildGraph, writeTiles, writeData } from './pack.js';

const OUT_DIR = path.resolve(fileURLToPath(new URL('../../web/public/data', import.meta.url)));

/** Marge autour de l'emprise : un immeuble de 40 m porte ~450 m d'ombre au solstice d'hiver. */
const SHADOW_MARGIN_M = 450;

/**
 * Longueur en deçà de laquelle un tronçon n'est pas représentable.
 *
 * Un décimètre : c'est le pas de quantification de la longueur, dans le GeoJSON
 * comme dans le binaire. Le filtre de `buildSegments` et le garde-fou
 * `assertComplete` partagent cette constante à dessein — s'ils divergeaient, le
 * premier laisserait passer ce que le second refuse, et la cellule échouerait
 * après un quart d'heure de lancer de rayons.
 */
const MIN_SEGMENT_LENGTH_M = 0.1;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const zone = resolveTarget({ ...CONFIG, ...args }, args);
  // Une zone peut relâcher certains réglages ; la ligne de commande prime.
  const config = { ...CONFIG, ...zone.overrides, ...args, idBase: zone.idBase };

  console.log(`\n▌ SVET — ${zone.label}`);
  console.log(
    `  emprise ${zone.bbox.map((v) => v.toFixed(4)).join(', ')} · maille ${zone.res} m · ${config.date}\n`,
  );

  // Chronométrage par étape. Sans lui, on ne sait pas ce qu'on paie : c'est ce
  // qui décide de ce qu'une reconstruction quotidienne doit refaire et de ce
  // qu'elle peut reprendre au cache.
  const timings = [];
  let lastMark = performance.now();
  const mark = (label) => {
    const now = performance.now();
    timings.push({ label, seconds: (now - lastMark) / 1000 });
    lastMark = now;
  };

  // ---------------------------------------------------------------- données
  const dataBbox = padBbox(zone.bbox, SHADOW_MARGIN_M);

  console.log('1/5  Téléchargement des données ouvertes');
  const buildings = await fetchBuildings(dataBbox, config.buildingSource);
  console.log(
    `     ${buildings.length} emprises bâties (${config.buildingSource === 'bdtopo' ? 'BD TOPO' : 'APUR'})`,
  );

  // Le recensement des arbres s'arrête au périphérique. Il reste interrogé
  // partout : une cellule à cheval sur le boulevard des Maréchaux en profite
  // pour sa moitié parisienne, et il rend simplement une liste vide ailleurs.
  const trees = await fetchTrees(dataBbox);
  console.log(`     ${trees.length} arbres (Ville de Paris)`);

  // Hors de Paris, l'essence ne se connaît plus qu'à la parcelle.
  let vegetation = [];
  if (config.vegetation) {
    vegetation = await fetchVegetation(dataBbox);
    console.log(`     ${vegetation.length} zones de végétation (BD TOPO)`);
  }

  // L'éclairage public ne porte pas d'ombre : inutile d'aller le chercher dans
  // la marge de 450 m réservée aux bâtiments. Un luminaire ne compte que s'il
  // est à moins de 80 m du trottoir.
  const lampBbox = padBbox(zone.bbox, 120);
  const elements = await fetchNetwork(zone.bbox, config.osmLighting ? lampBbox : undefined);
  const ways = elements.filter((element) => element.type === 'way');
  console.log(`     ${ways.length} voies (OpenStreetMap)`);

  let lamps = [];
  try {
    lamps = await fetchLighting(lampBbox);
    if (lamps.length > 0) console.log(`     ${lamps.length} points lumineux (Ville de Paris)`);
  } catch (error) {
    console.log(`     ⚠ éclairage public indisponible (${error.message})`);
  }

  // Hors de Paris, le jeu de la Ville ne rend rien. On se rabat sur les
  // lampadaires d'OpenStreetMap — mais seulement là où leur densité montre que
  // le secteur a vraiment été relevé. Ailleurs, l'application dira « non
  // renseigné », ce qu'elle sait faire, plutôt que d'inventer l'obscurité.
  if (lamps.length === 0 && config.osmLighting) {
    const osm = lampsFromOSM(elements);
    const kilometres = walkableKilometres(ways) || 1;
    if (lightingIsMapped(osm.length, kilometres)) {
      lamps = osm;
      console.log(
        `     ${lamps.length} points lumineux (OpenStreetMap, ` +
          `${(osm.length / kilometres).toFixed(0)} au km)`,
      );
    } else {
      console.log(
        `     éclairage non renseigné : ${osm.length} lampadaires OSM pour ` +
          `${kilometres.toFixed(0)} km de voies (${(osm.length / kilometres).toFixed(0)} au km, ` +
          `seuil ${MIN_LAMPS_PER_KM})`,
      );
    }
  }

  // Les chantiers ne portent pas d'ombre dans ce modèle — le jeu ne donne
  // aucune hauteur — mais ils barrent des trottoirs, et envoyer quelqu'un sur
  // une chaussée ensoleillée est pire qu'un détour.
  let worksites = [];
  try {
    worksites = await fetchWorksites(zone.bbox, config.date);
    console.log(`     ${worksites.length} emprises de chantier sur trottoir (Ville de Paris)`);
  } catch (error) {
    console.log(
      `     ⚠ chantiers indisponibles (${error.message}) — les trottoirs seront tous réputés libres`,
    );
  }

  mark('téléchargement');

  if (config.fetchOnly) {
    console.log('\n✓ Données en cache. Relancez sans --fetch-only pour calculer.\n');
    return;
  }

  // ------------------------------------------------------------------- MNS
  console.log('\n2/5  Construction du modèle numérique de surface');
  const projection = createProjection(dataBbox);
  const { grid, stats } = await buildDSM({
    projection,
    res: zone.res,
    bbox: dataBbox,
    buildings,
    trees,
    vegetation,
    config,
    date: config.date,
  });
  // Trois modes, et non deux : dire « vectorielle » d'une cellule comblée à la
  // marge revient à jeter le relevé qu'on vient de payer.
  const geometryLabel = {
    lidar: 'LiDAR HD',
    'lidar+vecteur': `LiDAR HD sur ${((stats.lidarCoverage ?? 0) * 100).toFixed(0)} %, vectorielle ailleurs`,
    vector: 'vectorielle',
  }[stats.model];
  console.log(
    `     grille ${grid.width} × ${grid.height} (${((grid.width * grid.height) / 1e6).toFixed(1)} M cellules)` +
      ` · géométrie ${geometryLabel}`,
  );
  if (stats.model.startsWith('lidar')) {
    console.log(
      `     ${(stats.builtShare * 100).toFixed(0)} % de bâti · ${(stats.canopyShare * 100).toFixed(0)} %` +
        ` de végétation · ${stats.evergreens} persistants identifiés`,
    );
  }
  if (stats.terrain) {
    console.log(
      `     terrain de ${stats.terrain.min.toFixed(0)} à ${stats.terrain.max.toFixed(0)} m d'altitude`,
    );
  }
  console.log(
    `     point le plus haut : ${stats.maxHeight.toFixed(1)} m · feuillage ${stats.leafOn ? 'en place' : 'absent'}`,
  );
  mark('modèle de surface');

  // -------------------------------------------------------- réseau piéton
  console.log('\n3/5  Découpage du réseau piéton');
  const { segments, points, sidewalks, cover } = buildSegments(
    ways,
    projection,
    zone.bbox,
    config,
    grid,
  );
  const twoSided = segments.filter((s) => !s.shared).length;
  const crossings = segments.filter((s) => s.crossing).length;
  const measured = segments.filter((s) => s.measuredWidth !== null).length;
  console.log(
    `     ${segments.length} tronçons · ${twoSided} à deux trottoirs · ${crossings} traversées`,
  );
  console.log(`     largeur mesurée sur ${measured} tronçons · ${points.x.length} points`);
  console.log(
    `     trottoirs cartographiés : ${sidewalks.axeSupprime} axes effacés (deux côtés réels), ` +
      `${sidewalks.cotéSupprime} réduits à un côté`,
  );
  console.log(
    `     noms hérités par les trottoirs : ${sidewalks.nomHerite} · restés sans nom : ${sidewalks.sansNom}`,
  );
  console.log(
    `     côtés déclarés absents par la rue (sans géométrie) : ${sidewalks.cotéDeclareAbsent}` +
      ` · dont « separate » : ${sidewalks.axeDeclareSepare}`,
  );
  mark('réseau piéton');

  // ------------------------------------------------------------------ SVF
  console.log('\n4/5  Facteur de vue du ciel');
  const svf = new Float32Array(points.x.length);
  const canopyCover = new Float32Array(points.x.length);
  // Profil d'horizon bâti : la hauteur des murs dans chaque secteur. Il est
  // statique, alors que la réverbération qu'il permet de calculer dépend de
  // l'heure — c'est ce découplage qui rend le calcul tenable, plutôt qu'un
  // lancer de rayons vers chaque façade à chaque pas de temps.
  const bins = config.horizonBins;
  const horizons = new Float32Array(points.x.length * bins);

  // L'éblouissement nocturne est statique lui aussi — les lampadaires ne
  // bougent pas. On le calcule dans la même boucle, tant qu'on tient déjà les
  // points d'échantillonnage.
  const lampIndex = indexLamps(lamps, projection);
  const veil = new Float32Array(points.x.length);
  /** 1 là où le jeu d'éclairage a quelque chose à dire. */
  const litKnown = new Uint8Array(points.x.length);
  /** 1 là où une emprise de chantier barre le trottoir. */
  const workIndex = indexWorksites(worksites, projection);
  const blocked = new Uint8Array(points.x.length);

  for (let i = 0; i < points.x.length; i++) {
    const result = skyViewFactor(
      grid,
      points.x[i],
      points.y[i],
      points.z[i],
      config.svfAzimuths,
      config.svfRadius,
      bins,
    );
    svf[i] = result.svf;
    canopyCover[i] = result.canopyCover;
    horizons.set(result.horizon, i * bins);
    // Sous un toit que le relevé n'a pas vu, on ne le croit pas.
    const cap = config.coverCap[cover[i]];
    if (cap) svf[i] = Math.min(svf[i], cap.svf);
    if (lampIndex.count > 0 && coveredAt(lampIndex, points.x[i], points.y[i])) {
      litKnown[i] = 1;
      veil[i] = veilAt(lampIndex, points.x[i], points.y[i], config.eyeHeight);
    }
    if (blockedAt(workIndex, points.x[i], points.y[i])) blocked[i] = 1;
    if (i % 25000 === 0) process.stdout.write(`\r     ${i} / ${points.x.length}`);
  }
  process.stdout.write(`\r     ${points.x.length} / ${points.x.length}\n`);

  if (lampIndex.count > 0) {
    const known = veil.filter((_, i) => litKnown[i]).sort();
    const q = (p) => known[Math.floor((known.length - 1) * p)].toFixed(2);
    const share = (100 * known.length) / veil.length;
    console.log(
      `     éblouissement nocturne : médiane ${q(0.5)} cd/m² · ` +
        `p10 ${q(0.1)} · p90 ${q(0.9)} · max ${q(1)}`,
    );
    console.log(
      `     couverture du jeu d'éclairage : ${share.toFixed(1)} % des points` +
        `${share < 99 ? ' (le reste est hors commune — signalé « non renseigné »)' : ''}`,
    );
  }
  if (workIndex.count > 0) {
    const hit = blocked.reduce((n, v) => n + v, 0);
    console.log(
      `     trottoirs barrés par un chantier : ${hit} points sur ${blocked.length}` +
        ` (${((100 * hit) / blocked.length).toFixed(1)} %)`,
    );
  }
  mark('facteur de vue du ciel');

  // ------------------------------------------------------------ simulation
  console.log('\n5/5  Simulation solaire');
  const times = buildTimeSteps(config);
  const nPoints = points.x.length;
  const transmission = new Float32Array(nPoints);
  // 1 là où l'ombre vient du feuillage plutôt que d'un mur. Le lancer de rayons
  // distinguait déjà les deux ; on jetait l'information à la sortie, alors que
  // c'est elle qui sépare une ombre qui scintille d'une ombre qui ne scintille pas.
  const underCanopy = new Uint8Array(nPoints);

  // Le soleil se calculait à Notre-Dame, quelle que soit l'emprise. Sur Paris
  // intra-muros, l'écart d'azimut d'un bout à l'autre est négligeable. Sur
  // l'Île-de-France, il ne l'est plus : deux degrés de longitude font huit
  // minutes de décalage horaire vrai, soit deux degrés d'azimut au lever — de
  // quoi mettre au soleil une rue que le modèle dit à l'ombre, à Provins comme
  // à Mantes. On prend donc le centre de ce qu'on calcule.
  const [siteLon, siteLat] = [(zone.bbox[0] + zone.bbox[2]) / 2, (zone.bbox[1] + zone.bbox[3]) / 2];

  for (const step of times) {
    const raw = sunPosition(step.utc, siteLat, siteLon);
    step.altitude = applyRefraction(raw.altitude);
    step.azimuth = raw.azimuth;
    step.altitudeDeg = Number((step.altitude * DEG).toFixed(2));
    step.azimuthDeg = Number((step.azimuth * DEG).toFixed(1));

    if (step.altitude > 0) {
      const maxDistance = Math.min(
        config.maxRayDistance,
        (grid.maxHeight - points.z[0]) / Math.max(Math.tan(step.altitude), 0.01),
      );
      for (let i = 0; i < nPoints; i++) {
        const hit = points.indoors[i]
          ? { transmission: 0, blocker: 'surface' }
          : sunTransmission(
              grid,
              points.x[i],
              points.y[i],
              points.z[i],
              step.azimuth,
              step.altitude,
              maxDistance,
            );
        const cap = config.coverCap[cover[i]];
        transmission[i] = cap ? Math.min(hit.transmission, cap.transmission) : hit.transmission;
        underCanopy[i] = hit.blocker === 'canopy' ? 1 : 0;
      }
    } else {
      transmission.fill(0);
      underCanopy.fill(0);
    }

    accumulate(segments, transmission, underCanopy, config);
    process.stdout.write(
      `\r     ${step.label} · soleil ${String(Math.round(step.altitudeDeg)).padStart(3)}° azimut ${String(Math.round(step.azimuthDeg)).padStart(3)}°`,
    );
  }
  process.stdout.write('\n');
  mark('simulation solaire');

  // ---------------------------------------------------------------- sortie
  await mkdir(zone.dataDir, { recursive: true });

  if (segments.length >= MAX_SEGMENTS_PER_CELL) {
    throw new Error(
      `${segments.length} tronçons : la plage d'identifiants d'une cellule ` +
        `(${MAX_SEGMENTS_PER_CELL}) est dépassée, les numéros déborderaient sur la cellule voisine.`,
    );
  }

  const network = toGeoJSON(segments, svf, canopyCover, horizons, bins, veil, litKnown, blocked);
  assertComplete(network, times.length);
  const footprints = toBuildingGeoJSON(buildings, zone.bbox, config);

  // La géométrie part en tuiles, tout le reste dans un binaire à
  // enregistrements de taille fixe. Voir `pack.js` pour le pourquoi.
  const graph = buildGraph(segments);
  const tiles = await writeTiles(zone.tilesDir, network, footprints, zone.bbox, {
    clear: zone.clearTiles,
    minZoom: config.minTileZoom,
  });

  // Géométrie complète, sans aucune série : elle sert de repli quand on coupe
  // les tuiles. Quatre mégaoctets là où le GeoJSON d'origine en faisait 39,
  // puisque tout ce qui varie dans le temps vit désormais dans le binaire.
  const geometry = {
    type: 'FeatureCollection',
    features: network.features.map((feature) => ({
      type: 'Feature',
      id: feature.properties.id,
      geometry: feature.geometry,
      properties: {
        id: feature.properties.id,
        lOff: feature.properties.lOff,
        rOff: feature.properties.rOff,
      },
    })),
  };
  await writeFile(path.join(zone.dataDir, `${zone.key}.geometry.json`), JSON.stringify(geometry));

  // Squelette pour les zooms régionaux. Sous le zoom 12, une tuile couvre
  // plusieurs cellules : aucune ne peut l'écrire seule, et c'est le pilote qui
  // assemble ces morceaux une fois toutes les cellules faites. Chacune prépare
  // donc sa part, réduite aux voies structurantes — à cette échelle, tracer les
  // deux trottoirs de chaque impasse pèse cent fois le trait qu'on en voit.
  if (zone.kind === 'cell') {
    await writeFile(
      path.join(zone.dataDir, `${zone.key}.apercu.json`),
      JSON.stringify(toOverviewGeoJSON(network)),
    );
  }
  await writeFile(
    path.join(zone.dataDir, `${zone.key}.buildings.json`),
    JSON.stringify(footprints),
  );
  // Enregistrements construits explicitement, et non par recopie des propriétés
  // GeoJSON : les noms diffèrent des deux côtés (`len`/`length`, `hw`/`highway`)
  // et un champ oublié se serait encodé en zéro sans rien signaler.
  const packed = await writeData(zone.dataDir, zone.key, {
    segments: network.features.map((feature, i) => {
      const p = feature.properties;
      return {
        name: p.name,
        highway: p.hw,
        crossing: p.crossing === 1,
        covered: p.covered === 1,
        shared: segments[i].shared,
        length: p.len,
        width: p.width,
        lOff: p.lOff,
        rOff: p.rOff,
        lSide: p.lSide,
        rSide: p.rSide,
        lSvf: p.lSvf,
        rSvf: p.rSvf,
        lVeil: p.lVeil,
        rVeil: p.rVeil,
        lit: p.lit === 1,
        lWork: p.lWork,
        rWork: p.rWork,
        lCanopy: p.lCanopy,
        rCanopy: p.rCanopy,
        lSun: p.lSun,
        rSun: p.rSun,
        lFlick: p.lFlick,
        rFlick: p.rFlick,
        lHor: p.lHor,
        rHor: p.rHor,
      };
    }),
    timeSteps: times.length,
    horizonBins: bins,
    graph,
  });
  console.log(
    `
     ${tiles.tiles} tuiles (${(tiles.bytes / 1e6).toFixed(1)} Mo) · ` +
      `binaire ${(packed.bytes / 1e6).toFixed(1)} Mo · ${packed.stride} octets par tronçon`,
  );
  console.log(`     graphe : ${graph.nodeCount} nœuds · ${graph.edgeCount} arêtes`);

  const meta = {
    zone: zone.key,
    kind: zone.kind,
    ...(zone.kind === 'cell' ? { region: zone.region, cell: zone.cell, idBase: zone.idBase } : {}),
    label: zone.label,
    bbox: zone.bbox,
    center: [siteLon, siteLat],
    date: config.date,
    resolution: zone.res,
    surfaceModel: stats.model,
    lidarCoverage: stats.lidarCoverage ?? null,
    tiles: {
      minZoom: tiles.minZoom,
      maxZoom: tiles.maxZoom,
      count: tiles.tiles,
      bounds: tiles.bounds,
    },
    segmentCount: network.features.length,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    leafOn: stats.leafOn,
    terrain: stats.terrain,
    // Le web recompose l'indice à l'affichage : il lui faut les réglages.
    weights: config.weights,
    albedo: config.albedo,
    groundAlbedo: config.groundAlbedo,
    luxReference: config.luxReference,
    horizonBins: config.horizonBins,
    walkingSpeed: config.walkingSpeed,
    crossingPenalty: config.crossingPenalty,
    scale: SCALE,
    times: times.map((t) => ({
      label: t.label,
      minutes: t.minutes,
      altitude: t.altitudeDeg,
      azimuth: t.azimuthDeg,
    })),
    counts: {
      buildings: buildings.length,
      trees: trees.length,
      segments: segments.length,
      twoSided,
      crossings,
      measuredWidth: measured,
      samples: points.x.length,
    },
    sources: [
      { name: 'Emprises bâties et hauteurs', org: 'APUR', licence: 'ODbL' },
      { name: 'Arbres', org: 'Ville de Paris', licence: 'ODbL' },
      { name: 'Éclairage public', org: 'Ville de Paris', licence: 'ODbL' },
      { name: 'Réseau viaire et traversées', org: 'OpenStreetMap', licence: 'ODbL' },
      { name: 'Relief et surfaces (LiDAR HD, RGE ALTI)', org: 'IGN', licence: 'Licence ouverte' },
    ],
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(zone.dataDir, `${zone.key}.meta.json`), JSON.stringify(meta, null, 2));
  // L'index des zones est le menu de l'application. Une cellule n'y a pas sa
  // place — trois cent quarante-trois entrées ne sont pas un menu — et c'est le
  // pilote régional qui assemble le sien, une fois toutes les cellules faites.
  if (zone.kind === 'zone') await updateZoneIndex(zone, meta);

  mark('empaquetage');

  console.log(`\n✓ Écrit dans ${zone.dataDir}`);
  console.log(
    `  ${zone.key}.data.bin · ${zone.key}.geometry.json · ${zone.key}.buildings.json · ${zone.key}.meta.json`,
  );

  const total = timings.reduce((sum, t) => sum + t.seconds, 0);
  console.log(`\n  Temps par étape (${formatDuration(total)} au total)`);
  for (const { label, seconds } of timings) {
    const share = (100 * seconds) / total;
    console.log(
      `    ${label.padEnd(24)} ${formatDuration(seconds).padStart(9)}  ${share.toFixed(0).padStart(3)} %` +
        `  ${'█'.repeat(Math.max(0, Math.round(share / 3)))}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------

/**
 * Ce qu'on calcule : une zone nommée, ou une cellule d'une région.
 *
 * Les deux suivent exactement le même pipeline — mêmes lancers de rayons, même
 * format de sortie. Ce qui les distingue tient en quatre points : d'où vient
 * l'emprise, où atterrissent les fichiers, à partir de quel numéro les tronçons
 * sont comptés, et quelles sources de bâti et de végétation sont interrogées.
 *
 * Les zones gardent l'APUR et le fichier des arbres de Paris — c'est sur eux
 * que les ombres du projet ont été validées, et rien ne justifie de rejouer
 * cette validation pour un changement de découpage.
 */
function resolveTarget(settings, args) {
  if (!args.cell) {
    const zone = resolveZone(settings.zone);
    return {
      ...zone,
      kind: 'zone',
      idBase: 0,
      dataDir: OUT_DIR,
      tilesDir: path.join(OUT_DIR, zone.key),
      // Une zone possède sa pyramide : la reconstruire, c'est la remplacer.
      clearTiles: true,
    };
  }

  const region = resolveRegion(args.region ?? 'idf');
  const { x, y, z, bbox } = parseCellKey(args.cell);
  const origin = gridOrigin(region);

  return {
    kind: 'cell',
    key: args.cell,
    region: region.key,
    label: `${region.label} — cellule ${args.cell}`,
    bbox,
    res: region.res,
    cell: { x, y, z },
    idBase: cellIdBase(origin, x, y),
    dataDir: path.join(OUT_DIR, region.key, 'cellules'),
    // Toutes les cellules écrivent dans la même pyramide. C'est sans risque
    // parce que le découpage est calé sur la grille z12 : une tuile de zoom 12
    // ou plus appartient à une cellule et une seule. Effacer le dossier
    // reviendrait donc à effacer le travail des voisines.
    tilesDir: path.join(OUT_DIR, region.key, 'tuiles'),
    clearTiles: false,
    overrides: {
      buildingSource: 'bdtopo',
      vegetation: true,
      osmLighting: true,
      // Le zoom 12 est le plancher de la pyramide régionale : en dessous, c'est
      // l'aperçu construit par le pilote qui prend le relais.
      minTileZoom: z,
    },
  };
}

/**
 * Longueur cumulée des voies praticables, en kilomètres.
 *
 * Sert de dénominateur au test de densité d'éclairage. Approximation plane, à
 * la latitude moyenne de chaque segment : on compare un ordre de grandeur à un
 * seuil, pas des mesures cadastrales.
 */
function walkableKilometres(ways) {
  let metres = 0;
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2 || !isWalkable(way.tags)) continue;
    for (let i = 1; i < way.geometry.length; i++) {
      const a = way.geometry[i - 1];
      const b = way.geometry[i];
      const midLat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
      metres += Math.hypot((b.lon - a.lon) * 111320 * Math.cos(midLat), (b.lat - a.lat) * 111132);
    }
  }
  return metres / 1000;
}

/**
 * Arrondir les secondes **avant** de les décomposer, et non après : 719,7 s
 * donne onze minutes de quotient et un reste de 59,7, qui s'arrondissait à
 * soixante — d'où des « 11 min 60 s » dans le journal.
 */
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Découpe les voies en tronçons courts et sème des points d'échantillonnage
 * de part et d'autre de l'axe, un jeu par trottoir.
 */
function buildSegments(ways, projection, bbox, config, grid) {
  const segments = [];
  // Les tronçons d'une cellule sont numérotés dans une plage qui lui est
  // réservée : les tuiles de toute la région partagent un espace
  // d'identifiants, et deux cellules qui repartiraient de zéro se
  // disputeraient les mêmes numéros à l'affichage.
  const idBase = config.idBase ?? 0;
  const xs = [];
  const ys = [];
  const zs = [];
  const indoors = [];
  const eye = config.eyeHeight;

  // Là où OpenStreetMap dessine les trottoirs, ils font foi : l'axe de rue ne
  // doit alors plus porter de trottoir déduit, sans quoi le calculateur voit
  // trois chemins parallèles là où il y en a deux et peut « rester du bon
  // côté » en marchant sur la chaussée. Voir `sidewalks.js` pour les mesures.
  const sidewalkIndex = buildEdgeIndex(ways, projection, isMappedSidewalk);
  const streetIndex = buildEdgeIndex(ways, projection, isStreetAxis, (w) => ({
    name: w.tags?.name ?? null,
    highway: w.tags?.highway ?? null,
  }));
  const tally = {
    axeSupprime: 0,
    cotéSupprime: 0,
    nomHerite: 0,
    sansNom: 0,
    cotéDeclareAbsent: 0,
    axeDeclareSepare: 0,
  };

  const pushSide = (samples, sign, offsets) => {
    const first = xs.length;
    let offsetSum = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const d = offsets[i] * sign;
      const x = s.x - s.dy * d;
      const y = s.y + s.dx * d;
      const cell = grid.index(x, y);
      xs.push(x);
      ys.push(y);
      zs.push(cell >= 0 ? grid.ground[cell] + eye : eye);
      // Un point resté dans le bâti malgré le recalage ne verrait jamais le
      // ciel : on le neutralise plutôt que de le compter comme « nuit ».
      indoors.push(cell >= 0 && grid.surface[cell] > grid.ground[cell] + eye ? 1 : 0);
      offsetSum += offsets[i];
    }
    return { first, count: samples.length, offset: offsetSum / samples.length };
  };

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    if (!isWalkable(way.tags)) continue;

    const nominal = nominalOffset(way.tags, config);
    const coords = way.geometry.map((n) => [n.lon, n.lat]);
    const isAxis = isStreetAxis(way.tags);
    const declared = isAxis ? declaredAbsent(way.tags) : null;
    if (declared && (declared.left || declared.right)) tally.cotéDeclareAbsent++;

    // Un trottoir cartographié n'a presque jamais de nom — 0,6 % à Paris. Sans
    // le nom de sa rue, le guidage dirait « cheminement » là où il disait
    // « rue de Rivoli ». On le lui donne, par le même appariement géométrique.
    let name = way.tags?.name ?? null;
    if (!name && isMappedSidewalk(way.tags)) {
      const parent = parentStreet(streetIndex, sampleAlong(coords, projection, config.sampleStep));
      if (parent?.name) {
        name = parent.name;
        tally.nomHerite++;
      } else tally.sansNom++;
    }

    for (const piece of splitLine(coords, projection, config.segmentLength)) {
      if (!intersectsBbox(piece, bbox)) continue;

      // Tracés dégénérés : sommets OpenStreetMap quasiment confondus.
      //
      // `splitLine` en fait un morceau de quelques centimètres, qui traverse
      // tout le pipeline sans broncher jusqu'au garde-fou d'écriture — lequel
      // refuse alors la **cellule entière** pour un chemin d'exploitation mal
      // saisi. Vu sur 12-2068-1412, et il y a des `track` dans toute la grande
      // couronne : ce n'est pas un cas isolé.
      //
      // Le seuil est celui du format, pas une valeur choisie au jugé : la
      // longueur est stockée en décimètres, ici comme dans le binaire. En
      // dessous, le tronçon s'écrit « 0,0 m » — invalide pour le garde-fou,
      // et diviseur nul pour la pénalité de traversée du calculateur.
      // Au-dessus, tout est gardé : un passage de deux mètres relie vraiment
      // deux endroits.
      const pieceLength = polylineLength(piece, projection);
      if (pieceLength < MIN_SEGMENT_LENGTH_M) continue;

      const samples = sampleAlong(piece, projection, config.sampleStep);
      if (samples.length === 0) continue;

      // Couverture réelle de ce morceau d'axe, côté par côté. Mesuré sur Paris :
      // 41 % des axes sont doublés des deux côtés, 20 % d'un seul, 38 % d'aucun.
      // Un graphe purement trottoir serait donc troué sur plus du tiers de la
      // ville — d'où ce traitement côté par côté plutôt qu'un basculement net.
      const cover = isAxis ? coverageAlong(sidewalkIndex, samples) : { left: false, right: false };

      // Là où rien n'est dessiné, la rue peut quand même dire ce qu'elle porte.
      // 11 683 rues parisiennes le déclarent — assez pour ne pas inventer un
      // trottoir du côté où elles disent qu'il n'y en a pas.
      if (isAxis && declared) {
        if (declared.left) cover.left = true;
        if (declared.right) cover.right = true;
      }

      // Les deux trottoirs existent pour de vrai : l'axe n'a plus rien à dire.
      if (cover.left && cover.right) {
        tally.axeSupprime++;
        if (declared?.separate) tally.axeDeclareSepare++;
        continue;
      }

      let sumDx = 0;
      let sumDy = 0;
      for (const s of samples) {
        sumDx += s.dx;
        sumDy += s.dy;
      }

      // Un seul côté est cartographié : l'axe ne garde que l'autre. Le tronçon
      // devient donc « à un côté », exactement comme un cheminement piéton —
      // ce qui est la vérité du terrain : de ce côté-ci il n'y a qu'un trottoir
      // à décrire, l'autre a sa propre géométrie.
      const halved = cover.left || cover.right;
      const shared = nominal === 0 || halved;
      const { left, right, width } =
        nominal === 0
          ? { left: samples.map(() => 0), right: samples.map(() => 0), width: null }
          : measureSidewalks(grid, samples, nominal, config);
      if (halved) tally.cotéSupprime++;

      const makeSide = (range, east, north) => ({
        ...range,
        label: cardinalLabel(east, north),
        sun: [],
        flicker: [],
      });

      // Sur un cheminement piéton, il n'y a pas de chaussée à traverser : les
      // deux côtés se confondent et partagent un seul relevé. On le dit
      // explicitement plutôt que de compter sur l'identité des objets — la
      // moindre copie romprait le lien sans prévenir.
      //
      // `cover.left` veut dire « le vrai trottoir de gauche existe ailleurs » :
      // c'est donc celui de droite que l'axe doit porter, et inversement.
      const keepRight = cover.left;
      const onlySide = keepRight
        ? makeSide(pushSide(samples, -1, right), sumDy, -sumDx)
        : makeSide(pushSide(samples, 1, left), -sumDy, sumDx);

      const leftSide = shared ? onlySide : makeSide(pushSide(samples, 1, left), -sumDy, sumDx);
      const rightSide = shared ? onlySide : makeSide(pushSide(samples, -1, right), sumDy, -sumDx);

      segments.push({
        id: idBase + segments.length,
        name,
        highway: way.tags?.highway ?? null,
        covered: isCovered(way.tags),
        cover: coverKind(way.tags),
        crossing: isCrossing(way.tags),
        length: pieceLength,
        measuredWidth: width,
        shared,
        coords: piece,
        left: leftSide,
        right: rightSide,
      });
    }
  }

  // Degré de couverture, reporté de chaque tronçon sur ses points. Il faut
  // attendre la fin de la boucle : les plages de points ne sont connues
  // qu'une fois les deux trottoirs semés.
  const cover = new Uint8Array(xs.length);
  for (const segment of segments) {
    if (!segment.cover) continue;
    for (const side of segment.left === segment.right
      ? [segment.left]
      : [segment.left, segment.right]) {
      cover.fill(segment.cover, side.first, side.first + side.count);
    }
  }

  return {
    segments,
    sidewalks: tally,
    cover,
    points: {
      x: Float64Array.from(xs),
      y: Float64Array.from(ys),
      z: Float64Array.from(zs),
      indoors: Uint8Array.from(indoors),
    },
  };
}

/**
 * Position des deux trottoirs, mesurée sur le modèle de surface.
 *
 * On part de l'axe et on avance perpendiculairement jusqu'à buter sur une
 * façade, de chaque côté. Le piéton est ensuite placé 2 m en retrait de cette
 * façade — c'est le milieu d'un trottoir parisien courant.
 *
 * C'est nettement mieux que la table par type de voie, qui reste le repli
 * quand aucune façade n'est trouvée : sur un quai, une place ou un pont, il n'y
 * a rien à mesurer.
 */
function measureSidewalks(grid, samples, nominal, config) {
  const reach = config.facadeSearch;
  const lefts = [];
  const rights = [];

  for (const s of samples) {
    const cell = grid.index(s.x, s.y);
    const groundZ = cell >= 0 ? grid.ground[cell] : 0;
    lefts.push(distanceToFacade(grid, s.x, s.y, groundZ, -s.dy, s.dx, reach));
    rights.push(distanceToFacade(grid, s.x, s.y, groundZ, s.dy, -s.dx, reach));
  }

  // Médiane et non moyenne : une rue transversale ou un porche ouvre une brèche
  // dans l'alignement, et le rayon file alors jusqu'à un immeuble lointain. La
  // médiane ignore ces quelques valeurs aberrantes.
  const dLeft = median(lefts);
  const dRight = median(rights);
  const offsetLeft = sidewalkPosition(dLeft, reach, nominal);
  const offsetRight = sidewalkPosition(dRight, reach, nominal);
  const measurable = dLeft < reach && dRight < reach;

  return {
    left: samples.map(() => offsetLeft),
    right: samples.map(() => offsetRight),
    width: measurable ? Math.round((dLeft + dRight) * 10) / 10 : null,
  };
}

/**
 * Position du piéton à partir de la distance à la façade.
 *
 * Le trottoir est contre la façade : on s'en écarte de 2 m, ce qui correspond
 * au milieu d'un trottoir parisien courant.
 *
 * La mesure ne l'emporte que si elle reste plausible au regard du type de voie.
 * Trop loin, c'est le signe qu'il n'y a pas d'alignement bâti de ce côté — un
 * quai, une place, un square — et la valeur nominale reste le meilleur pari.
 */
function sidewalkPosition(distance, reach, nominal) {
  if (distance >= reach) return nominal;
  const measured = distance - 2;
  if (measured < nominal * 0.25 || measured > nominal * 2.5) return nominal;
  return Math.max(0.5, Math.min(measured, 20));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Demi-largeur présumée d'après le type de voie, ou d'après le tag `width`. */
function nominalOffset(tags = {}, config) {
  const table = config.sidewalkOffset;
  const base = table[tags.highway] ?? table._default;
  if (base === 0) return 0;

  const width = Number.parseFloat(tags.width);
  if (Number.isFinite(width) && width > 2 && width < 60) {
    return Math.min(width / 2, 14);
  }
  return base;
}

function splitLine(coords, projection, targetLength) {
  const pieces = [];
  let current = [coords[0]];
  let accumulated = 0;

  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = projection.forward(coords[i - 1][0], coords[i - 1][1]);
    const [x2, y2] = projection.forward(coords[i][0], coords[i][1]);
    accumulated += Math.hypot(x2 - x1, y2 - y1);
    current.push(coords[i]);

    if (accumulated >= targetLength && i < coords.length - 1) {
      pieces.push(current);
      current = [coords[i]];
      accumulated = 0;
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function polylineLength(coords, projection) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = projection.forward(coords[i - 1][0], coords[i - 1][1]);
    const [x2, y2] = projection.forward(coords[i][0], coords[i][1]);
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

/**
 * Points le long d'une polyligne, avec la direction unitaire locale — c'est
 * elle qui permet de déporter perpendiculairement, y compris dans les courbes.
 */
function sampleAlong(coords, projection, step) {
  const metric = coords.map(([lon, lat]) => projection.forward(lon, lat));
  const samples = [];
  let next = step / 2; // on décale le premier point, pour ne pas tomber sur un sommet
  let travelled = 0;

  for (let i = 1; i < metric.length; i++) {
    const [x1, y1] = metric[i - 1];
    const [x2, y2] = metric[i];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length === 0) continue;

    const dx = (x2 - x1) / length;
    const dy = (y2 - y1) / length;

    while (next <= travelled + length) {
      const t = (next - travelled) / length;
      samples.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, dx, dy });
      next += step;
    }
    travelled += length;
  }

  // Tronçon plus court que le pas d'échantillonnage : on garde son milieu.
  if (samples.length === 0 && metric.length >= 2) {
    const [x1, y1] = metric[0];
    const [x2, y2] = metric[metric.length - 1];
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    samples.push({
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      dx: (x2 - x1) / length,
      dy: (y2 - y1) / length,
    });
  }
  return samples;
}

/**
 * Relève, pour ce pas de temps, les seules grandeurs qui dépendent de la
 * géométrie : transmission moyenne et scintillement, trottoir par trottoir.
 * L'éclairement, l'éblouissement et l'indice sont recomposés à l'affichage.
 */
function accumulate(segments, transmission, underCanopy, config) {
  for (const segment of segments) {
    // Relever deux fois un côté partagé dupliquerait chaque valeur de la série.
    const sides = segment.shared ? [segment.left] : [segment.left, segment.right];

    for (const side of sides) {
      const series = new Array(side.count);
      const canopy = new Uint8Array(side.count);
      let sum = 0;
      for (let i = 0; i < side.count; i++) {
        const value = transmission[side.first + i];
        series[i] = value;
        canopy[i] = underCanopy[side.first + i];
        sum += value;
      }
      side.sun.push(Math.round((sum / side.count) * 100));
      side.flicker.push(Math.round(flickerFactor(series, config.sampleStep, canopy) * 100));
    }
  }
}

function toGeoJSON(segments, svf, canopyCover, horizons, bins, veil, litKnown, blocked) {
  const meanOver = (side, array) => {
    let sum = 0;
    for (let i = 0; i < side.count; i++) sum += array[side.first + i];
    return Math.round((sum / side.count) * 100);
  };

  /**
   * Luminance de voile moyenne du trottoir, en centièmes de cd/m².
   *
   * Un octet suffirait mal : les valeurs utiles s'étalent de 0,02 à plus de 5,
   * et c'est le bas de la plage qui distingue une ruelle sombre d'une rue
   * résidentielle. On garde donc deux chiffres après la virgule, plafonnés à
   * 6,55 cd/m² — bien au-delà de la saturation du modèle.
   */
  const veilOver = (side) => {
    let sum = 0;
    for (let i = 0; i < side.count; i++) sum += veil[side.first + i];
    return Math.min(65535, Math.round((sum / side.count) * 100));
  };

  /** Part du trottoir barrée par un chantier, en pourcentage. */
  const blockedOver = (side) => {
    let sum = 0;
    for (let i = 0; i < side.count; i++) sum += blocked[side.first + i];
    return Math.round((100 * sum) / side.count);
  };

  /** Le tronçon est-il dans l'emprise du jeu d'éclairage ? */
  const lightingKnown = (segment) => {
    const { left, right } = segment;
    let known = 0;
    let seen = 0;
    for (const side of left === right ? [left] : [left, right]) {
      for (let i = 0; i < side.count; i++) {
        seen++;
        known += litKnown[side.first + i];
      }
    }
    return seen > 0 && known * 2 >= seen ? 1 : 0;
  };

  /** Profil d'horizon moyen du trottoir, en degrés entiers par secteur. */
  const horizonOf = (side) => {
    const profile = new Array(bins).fill(0);
    for (let i = 0; i < side.count; i++) {
      const base = (side.first + i) * bins;
      for (let b = 0; b < bins; b++) profile[b] += horizons[base + b];
    }
    return profile.map((v) => Math.round(v / side.count));
  };

  return {
    type: 'FeatureCollection',
    features: segments.map((segment) => {
      const { left, right, shared } = segment;
      return {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: segment.coords.map(([lon, lat]) => [round6(lon), round6(lat)]),
        },
        properties: {
          id: segment.id,
          name: segment.name,
          hw: segment.highway,
          covered: segment.covered ? 1 : 0,
          crossing: segment.crossing ? 1 : 0,
          len: Math.round(segment.length * 10) / 10,
          width: segment.measuredWidth,
          // Déport réel de chaque trottoir : il sert au tracé, et il diffère
          // d'un côté à l'autre quand la rue n'est pas symétrique.
          lOff: shared ? 0 : Math.round(left.offset * 10) / 10,
          rOff: shared ? 0 : Math.round(right.offset * 10) / 10,
          lSide: left.label,
          rSide: shared ? left.label : right.label,
          lSvf: meanOver(left, svf),
          rSvf: meanOver(right, svf),
          lCanopy: meanOver(left, canopyCover),
          rCanopy: meanOver(right, canopyCover),
          lVeil: veilOver(left),
          rVeil: veilOver(right),
          lit: lightingKnown(segment),
          lWork: blockedOver(left),
          rWork: blockedOver(right),
          lHor: horizonOf(left),
          rHor: shared ? horizonOf(left) : horizonOf(right),
          lSun: left.sun,
          rSun: shared ? left.sun : right.sun,
          lFlick: left.flicker,
          rFlick: shared ? left.flicker : right.flicker,
        },
      };
    }),
  };
}

/**
 * Garde-fou avant écriture : chaque tronçon doit porter une série complète pour
 * ses deux côtés.
 *
 * Une série vide ne fait pas planter le pipeline — elle ressort en NaN dans
 * l'interface, longtemps après, et seulement sur certains types de voies. Mieux
 * vaut échouer ici, bruyamment.
 */
function assertComplete(network, expectedLength) {
  for (const feature of network.features) {
    const p = feature.properties;
    for (const key of ['lSun', 'rSun', 'lFlick', 'rFlick']) {
      if (!Array.isArray(p[key]) || p[key].length !== expectedLength) {
        throw new Error(
          `Tronçon ${p.id} (${p.hw}) : ${key} fait ${p[key]?.length ?? 'aucune'} valeur ` +
            `au lieu de ${expectedLength}.`,
        );
      }
    }
    if (!(p.len > 0)) {
      throw new Error(
        `Tronçon ${p.id} (${p.hw}) : longueur invalide (${p.len}) — ` +
          `un tracé sous ${MIN_SEGMENT_LENGTH_M} m aurait dû être écarté au découpage.`,
      );
    }
  }
}

/**
 * Voies structurantes seules, en géométrie arrondie au mètre.
 *
 * Ce qui reste lisible quand la région tient dans l'écran : les axes. Une
 * ruelle y ferait moins d'un pixel de long, et le tuileur la garderait quand
 * même — c'est ainsi qu'une pyramide d'aperçu finit par peser plus lourd que
 * les données qu'elle résume.
 */
const OVERVIEW_HIGHWAYS = new Set([
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'pedestrian',
]);

function toOverviewGeoJSON(network) {
  const features = [];
  for (const feature of network.features) {
    if (!OVERVIEW_HIGHWAYS.has(feature.properties.hw)) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: feature.geometry.coordinates.map(([lon, lat]) => [round5(lon), round5(lat)]),
      },
      properties: { id: feature.properties.id },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Empreintes bâties allégées : géométrie arrondie, hauteur seule. */
function toBuildingGeoJSON(buildings, bbox, config) {
  const features = [];
  for (const feature of buildings) {
    if (!feature.geometry) continue;
    const height = buildingHeight(feature.properties, config.defaultBuildingHeight);
    const geometry = roundGeometry(feature.geometry);
    if (!geometry || !intersectsBboxGeometry(geometry, bbox)) continue;
    features.push({ type: 'Feature', geometry, properties: { h: Math.round(height * 10) / 10 } });
  }
  return { type: 'FeatureCollection', features };
}

function roundGeometry(geometry) {
  const mapRing = (ring) => ring.map(([lon, lat]) => [round6(lon), round6(lat)]);
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(mapRing) };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((rings) => rings.map(mapRing)),
    };
  }
  return null;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Cinq décimales : le mètre. Assez fin pour un trait d'un pixel au zoom 11. */
function round5(value) {
  return Math.round(value * 1e5) / 1e5;
}

function intersectsBbox(coords, bbox) {
  const [west, south, east, north] = bbox;
  return coords.some(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north);
}

function intersectsBboxGeometry(geometry, bbox) {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  return rings.some((ring) => intersectsBbox(ring, bbox));
}

/** Tient à jour la liste des zones calculées, pour que le web les découvre seul. */
async function updateZoneIndex(zone, meta) {
  const indexPath = path.join(OUT_DIR, 'zones.json');
  let zones = [];
  try {
    zones = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    // premier calcul
  }
  const entry = {
    key: zone.key,
    label: zone.label,
    bbox: zone.bbox,
    center: meta.center,
    date: meta.date,
    // Horodatage du calcul, repris en paramètre d'URL par le web. Sans lui, le
    // cache hors ligne resservirait indéfiniment l'ancienne version des
    // données : toute reconstruction du pipeline resterait invisible.
    stamp: meta.generatedAt.replace(/\D/g, '').slice(0, 14),
  };
  zones = zones.filter((z) => z.key !== zone.key);
  zones.push(entry);
  zones.sort((a, b) => a.key.localeCompare(b.key));
  await writeFile(indexPath, JSON.stringify(zones, null, 2));
}

function buildTimeSteps(config) {
  const steps = [];
  for (
    let minutes = config.hourStart * 60;
    minutes <= config.hourEnd * 60;
    minutes += config.stepMinutes
  ) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    steps.push({
      minutes,
      label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      utc: localToUTC(config.date, hour, minute),
    });
  }
  return steps;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === '--fetch-only') out.fetchOnly = true;
    else if (arg.startsWith('--zone=')) out.zone = arg.slice(7);
    else if (arg.startsWith('--cell=')) out.cell = arg.slice(7);
    else if (arg.startsWith('--region=')) out.region = arg.slice(9);
    else if (arg.startsWith('--date=')) {
      const value = arg.slice(7);
      // `--date=today` permet de planifier une régénération quotidienne sans
      // réécrire la date dans la commande.
      out.date = value === 'today' ? new Date().toISOString().slice(0, 10) : value;
    } else if (arg.startsWith('--step=')) out.stepMinutes = Number(arg.slice(7));
  }
  return out;
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
