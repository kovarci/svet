import {
  createGrid,
  fillGround,
  fillMask,
  fillPolygon,
  fillCanopy,
  dilateMask,
  stampCrown,
} from './lib/raster.js';
import { buildingHeight } from './fetch/buildings.js';
import { crownGeometry, isEvergreen } from './fetch/trees.js';
import { canopyExtinction, canopyHeight, isEvergreenZone } from './fetch/vegetation.js';
import { fetchFloatRaster, sampleRaster, sampleValid, LAYERS } from './fetch/raster.js';

/**
 * En deçà de cette part de pixels mesurés, on ne parle plus de trous à combler :
 * le LiDAR n'a pas volé ici, et c'est le modèle vectoriel qui prend la main.
 */
const MIN_LIDAR_COVERAGE = 0.02;

/**
 * Assemble le modèle numérique de surface.
 *
 * Deux façons de le construire, selon `config.surfaceModel` :
 *
 *  - **`lidar`** — la géométrie vient du LiDAR HD de l'IGN. Toitures réelles
 *    avec leurs mansardes, houppiers réels, murs, kiosques : tout ce qui est
 *    physiquement là. C'est le mode par défaut.
 *  - **`vector`** — emprises bâties extrudées à plat et arbres modélisés en
 *    dômes. Moins fidèle, mais ne dépend que de données vectorielles légères,
 *    et sert de repli là où le LiDAR n'a pas volé.
 *
 * Dans les deux cas, les altitudes manipulées sont **absolues** : un rayon
 * rasant bute sur une colline comme il bute sur un immeuble, sans traitement
 * particulier.
 */
export function buildDSM(options) {
  return options.config.surfaceModel === 'vector' ? buildFromVectors(options) : buildFromLidar(options);
}

/**
 * Construction depuis le LiDAR HD.
 *
 * Le nuage de points donne la forme, mais **pas la nature** des obstacles : le
 * MNS ne dit pas si ce qui dépasse est un mur ou un feuillage. Or toute
 * l'application repose sur cette distinction — l'ombre d'un immeuble est nette
 * et stable, celle d'un arbre est tamisée et clignotante.
 *
 * On croise donc trois sources : le LiDAR pour la géométrie, les emprises APUR
 * pour dire où est le bâti, le fichier des arbres pour caractériser le feuillage
 * (persistant ou caduc). Là où un obstacle dépasse hors de toute emprise bâtie,
 * on le tient pour de la végétation — c'est le pari le plus sûr : rendre un mur
 * translucide fait *surestimer* l'exposition, alors que rendre un arbre opaque
 * ferait croire à un abri qui n'existe pas.
 *
 * ── Les trous ──────────────────────────────────────────────────────────────
 * À l'échelle de l'Île-de-France, le relevé n'est plus une donnée acquise : il
 * s'arrête à l'ouest du Hurepoix et laisse une bande vide vers Coulommiers. Le
 * service ne dit pas non pour autant — il répond une dalle pleine de −9999.
 *
 * On ne bascule donc pas d'un modèle à l'autre par emprise entière, mais
 * **cellule de grille par cellule de grille** : là où le LiDAR a mesuré, il
 * fait foi ; là où il n'a rien, on retombe sur le bâti extrudé et les zones de
 * végétation. Un basculement en bloc aurait produit une couture visible au bord
 * des dalles de livraison — deux rues voisines décrites par deux modèles
 * différents, avec des indices qui ne se comparent plus.
 */
async function buildFromLidar({ projection, res, bbox, buildings, trees, vegetation = [], config, date }) {
  // Sondage préalable, à 64 pixels de côté.
  //
  // Le service ne dit jamais « je n'ai pas volé ici » : il répond une dalle
  // pleine et régulière, remplie de −9999. Sur une cellule de région, ça fait
  // cent dix mégaoctets téléchargés en une minute quarante pour découvrir qu'il
  // n'y avait rien — et deux cent quarante cellules d'Île-de-France sont dans
  // ce cas. Seize kilo-octets suffisent à poser la question.
  const probe = await fetchFloatRaster({
    layer: LAYERS.lidarHeight,
    bbox,
    targetRes: Math.max(res, widthOf(bbox) / 64),
    label: 'LiDAR HD — sondage',
  });
  if (probe && probe.coverage < MIN_LIDAR_COVERAGE) {
    process.stdout.write('  ⚠ LiDAR non livré sur cette emprise — modèle vectoriel\n');
    return buildFromVectors({ projection, res, bbox, buildings, trees, vegetation, config, date });
  }

  const surface = await fetchFloatRaster({
    layer: LAYERS.lidarSurface,
    bbox,
    targetRes: res,
    label: 'LiDAR HD — surface',
  });
  const above = await fetchFloatRaster({
    layer: LAYERS.lidarHeight,
    bbox,
    targetRes: res,
    label: 'LiDAR HD — hauteurs',
  });

  if (!surface || !above) {
    process.stdout.write('  ⚠ LiDAR indisponible sur cette emprise — repli sur le modèle vectoriel\n');
    return buildFromVectors({ projection, res, bbox, buildings, trees, vegetation, config, date });
  }

  const coverage = Math.min(surface.coverage, above.coverage);
  if (coverage < MIN_LIDAR_COVERAGE) {
    process.stdout.write(
      `  ⚠ LiDAR non livré sur cette emprise (${(coverage * 100).toFixed(1)} % mesuré)` +
        ' — modèle vectoriel\n',
    );
    return buildFromVectors({ projection, res, bbox, buildings, trees, vegetation, config, date });
  }

  // Le terrain nu du LiDAR s'arrête où s'arrête le LiDAR. Dans les trous, le
  // RGE ALTI prend le relais : maille de 8 m plutôt que métrique, mais une
  // couverture nationale sans faille.
  const relief =
    coverage < 0.999
      ? await fetchFloatRaster({
          layer: LAYERS.terrain,
          bbox,
          targetRes: config.terrainResolution,
          label: 'RGE ALTI (comblement)',
        })
      : null;

  const grid = createGrid(projection, res);
  const heightScale = config.buildingHeightScale ?? 1;
  const leafOn = isLeafOn(date, config.canopy);
  /** 1 là où le relevé a mesuré : c'est ce masque qui départage les deux modèles. */
  const measured = new Uint8Array(grid.width * grid.height);

  // Terrain nu : le MNS moins la hauteur au-dessus du sol. C'est le MNT LiDAR,
  // plus fin que le RGE ALTI à 8 m qu'on utilisait jusqu'ici.
  fillGround(grid, (x, y) => {
    const [lon, lat] = projection.inverse(x, y);
    if (sampleValid(surface, lon, lat) && sampleValid(above, lon, lat)) {
      const idx = grid.index(x, y);
      if (idx >= 0) measured[idx] = 1;
      return sampleRaster(surface, lon, lat) - Math.max(0, sampleRaster(above, lon, lat));
    }
    return sampleRaster(relief, lon, lat);
  });
  const groundRange = extent(grid.ground);

  // Où est le bâti ? Les emprises bâties, élargies de la marge de corniche.
  const builtMask = dilateMask(
    grid,
    maskOf(grid, buildings, projection),
    config.roofOverhang ?? 2,
  );

  let builtCells = 0;
  let canopyCells = 0;
  const defaultK = leafOn ? config.canopy.kLeafOn : config.canopy.kLeafOff;

  for (let row = 0; row < grid.height; row++) {
    const y = (row + 0.5) * res;
    for (let col = 0; col < grid.width; col++) {
      const idx = row * grid.width + col;
      if (!measured[idx]) continue; // comblé plus bas par le modèle vectoriel
      const [lon, lat] = projection.inverse((col + 0.5) * res, y);
      const height = Math.max(0, sampleRaster(above, lon, lat)) * heightScale;
      if (height < 0.5) continue; // sol nu

      const top = grid.ground[idx] + height;
      if (builtMask[idx]) {
        grid.surface[idx] = top;
        builtCells++;
      } else {
        grid.canopyTop[idx] = top;
        // Le LiDAR donne le sommet du houppier, jamais le bas des branches.
        // 0,35 de la hauteur correspond à un arbre de rue courant, élagué haut.
        grid.canopyBase[idx] = grid.ground[idx] + height * 0.35;
        grid.canopyK[idx] = defaultK;
        canopyCells++;
      }
      if (top > grid.maxHeight) grid.maxHeight = top;
    }
  }

  // Comblement des trous : mêmes gestes que le modèle vectoriel, restreints aux
  // cellules que le relevé n'a pas vues.
  if (coverage < 0.999) {
    stampVectors(grid, { projection, buildings, vegetation, config, leafOn, gapsOnly: measured });
  }

  // Les arbres recensés ne servent plus à dessiner la forme — le LiDAR le fait
  // mieux — mais à corriger l'atténuation là où l'essence est connue : un
  // persistant ombrage aussi en janvier.
  let evergreens = 0;
  for (const tree of trees) {
    if (!isEvergreen(tree)) continue;
    const crown = crownGeometry(tree);
    if (!crown) continue;
    const [x, y] = projection.forward(tree.geo_point_2d.lon, tree.geo_point_2d.lat);
    paintCanopyK(grid, x, y, crown.radius, config.canopy.kConifer);
    evergreens++;
  }
  // Hors de Paris, l'essence ne se sait plus arbre par arbre mais parcelle par
  // parcelle. C'est assez pour ce qu'on en fait : une forêt de conifères est
  // sombre en janvier, et c'est tout ce que le modèle a besoin de savoir.
  evergreens += paintEvergreenZones(grid, vegetation, projection, config);

  return {
    grid,
    stats: {
      model: coverage < 0.999 ? 'lidar+vecteur' : 'lidar',
      lidarCoverage: coverage,
      buildings: buildings.length,
      trees: trees.length,
      leafOn,
      maxHeight: grid.maxHeight,
      terrain: groundRange,
      builtShare: builtCells / (grid.width * grid.height),
      canopyShare: canopyCells / (grid.width * grid.height),
      evergreens,
    },
  };
}

/** Construction vectorielle : emprises extrudées, houppiers en dôme, bois en dalles. */
async function buildFromVectors({ projection, res, bbox, terrain, buildings, trees, vegetation = [], config, date }) {
  const relief =
    terrain ??
    (await fetchFloatRaster({
      layer: LAYERS.terrain,
      bbox,
      targetRes: config.terrainResolution,
      label: 'RGE ALTI',
    }));

  const grid = createGrid(projection, res);
  fillGround(grid, (x, y) => {
    const [lon, lat] = projection.inverse(x, y);
    return sampleRaster(relief, lon, lat);
  });
  const groundRange = extent(grid.ground);

  const leafOn = isLeafOn(date, config.canopy);
  const stamped = stampVectors(grid, { projection, buildings, trees, vegetation, config, leafOn });

  return {
    grid,
    stats: {
      model: 'vector',
      lidarCoverage: 0,
      buildings: buildings.length,
      trees: stamped.trees,
      zones: stamped.zones,
      leafOn,
      maxHeight: grid.maxHeight,
      terrain: relief ? groundRange : null,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Pose la géométrie vectorielle sur la grille : bâti extrudé, houppiers,
 * couvert forestier.
 *
 * Extrait de `buildFromVectors` pour servir deux fois — comme modèle à part
 * entière, et comme bouche-trou du LiDAR, où `gapsOnly` limite l'écriture aux
 * cellules non mesurées. C'est le même geste dans les deux cas ; le dupliquer
 * aurait garanti que les deux versions divergent à la première correction.
 */
function stampVectors(grid, { projection, buildings, trees = [], vegetation = [], config, leafOn, gapsOnly }) {
  const heightScale = config.buildingHeightScale ?? 1;
  for (const feature of buildings) {
    const height = buildingHeight(feature.properties, config.defaultBuildingHeight) * heightScale;
    for (const polygonRings of toMetricRings(feature.geometry, projection)) {
      fillPolygon(grid, polygonRings, height, gapsOnly);
    }
  }

  // Les parcelles d'abord, les sujets ensuite : un arbre recensé décrit mieux
  // son houppier qu'une dalle de bois, et doit donc pouvoir l'emporter.
  let zones = 0;
  for (const zone of vegetation) {
    const top = canopyHeight(zone.nature);
    const k = canopyExtinction(zone.nature, leafOn, config.canopy);
    for (const rings of toMetricRings(zone.geometry, projection)) {
      // Les branches basses d'un peuplement forestier descendent plus bas que
      // celles d'un arbre de rue, qu'on élague pour laisser passer les bus.
      fillCanopy(grid, rings, top, top * 0.2, k, gapsOnly);
    }
    zones++;
  }

  let treeCount = 0;
  for (const tree of trees) {
    const crown = crownGeometry(tree);
    if (!crown) continue;
    const [x, y] = projection.forward(tree.geo_point_2d.lon, tree.geo_point_2d.lat);
    const k = isEvergreen(tree)
      ? config.canopy.kConifer
      : leafOn
        ? config.canopy.kLeafOn
        : config.canopy.kLeafOff;
    stampCrown(grid, x, y, crown.radius, crown.height, crown.base, k);
    treeCount++;
  }

  return { trees: treeCount, zones };
}

/**
 * Corrige le coefficient d'extinction sur les parcelles à feuillage persistant,
 * sans toucher à la forme relevée par le LiDAR.
 *
 * @returns {number} nombre de parcelles reprises
 */
function paintEvergreenZones(grid, vegetation, projection, config) {
  const zones = vegetation.filter((zone) => isEvergreenZone(zone.nature));
  if (zones.length === 0) return 0;

  // Un masque par coefficient, et non par parcelle : hors saison de feuillage
  // `canopyExtinction` ne rend que deux valeurs — le conifère pur et le mélange.
  // Repasser la grille entière après chaque bois aurait coûté des milliards
  // d'opérations pour un résultat identique.
  const byK = new Map();
  for (const zone of zones) {
    const k = canopyExtinction(zone.nature, false, config.canopy);
    let mask = byK.get(k);
    if (!mask) {
      mask = new Uint8Array(grid.width * grid.height);
      byK.set(k, mask);
    }
    for (const rings of toMetricRings(zone.geometry, projection)) fillMask(grid, mask, rings);
  }

  // Du plus faible au plus fort : une parcelle mixte au bord d'une sapinière ne
  // doit pas la faire redescendre.
  for (const k of [...byK.keys()].sort((a, b) => a - b)) {
    const mask = byK.get(k);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && grid.canopyTop[i] > 0) grid.canopyK[i] = k;
    }
  }
  return zones.length;
}

function maskOf(grid, buildings, projection) {
  const mask = new Uint8Array(grid.width * grid.height);
  for (const feature of buildings) {
    for (const rings of toMetricRings(feature.geometry, projection)) {
      fillMask(grid, mask, rings);
    }
  }
  return mask;
}

/** Repeint le coefficient d'extinction dans un disque, sans toucher à la forme. */
function paintCanopyK(grid, cx, cy, radius, k) {
  const { res, width, height, canopyK, canopyTop } = grid;
  const colStart = Math.max(0, Math.floor((cx - radius) / res));
  const colEnd = Math.min(width - 1, Math.ceil((cx + radius) / res));
  const rowStart = Math.max(0, Math.floor((cy - radius) / res));
  const rowEnd = Math.min(height - 1, Math.ceil((cy + radius) / res));
  const r2 = radius * radius;

  for (let row = rowStart; row <= rowEnd; row++) {
    const dy = (row + 0.5) * res - cy;
    for (let col = colStart; col <= colEnd; col++) {
      const dx = (col + 0.5) * res - cx;
      if (dx * dx + dy * dy > r2) continue;
      const idx = row * width + col;
      if (canopyTop[idx] > 0) canopyK[idx] = k;
    }
  }
}

/** GeoJSON Polygon/MultiPolygon -> liste de polygones, chacun en anneaux métriques. */
function toMetricRings(geometry, projection) {
  if (!geometry) return [];
  const polygons =
    geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : [];

  return polygons.map((rings) =>
    rings.map((ring) => ring.map(([lon, lat]) => projection.forward(lon, lat))),
  );
}

/**
 * Intervalle d'altitude, aux centiles 1 et 99 plutôt qu'aux extrêmes.
 *
 * Sur trois millions et demi de cellules, le minimum brut est toujours une
 * poignée de points aberrants — une tranchée de métro, un dessous de pont, un
 * écho sous la ligne d'eau. Annoncer « terrain de 13 à 49 m » sur la foi de
 * cent treize cellules donnerait une fausse idée du relief, alors que le
 * centile 1 tombe pile au niveau de la Seine.
 *
 * On échantillonne au lieu de tout trier : c'est une ligne de journal, pas une
 * statistique de précision.
 */
function extent(array) {
  const stride = Math.max(1, Math.floor(array.length / 20000));
  const sample = [];
  for (let i = 0; i < array.length; i += stride) sample.push(array[i]);
  sample.sort((a, b) => a - b);
  return {
    min: sample[Math.floor(sample.length * 0.01)],
    max: sample[Math.floor(sample.length * 0.99)],
  };
}

/** Largeur d'une emprise, en mètres. */
function widthOf([west, south, east, north]) {
  return (east - west) * 111320 * Math.cos((((south + north) / 2) * Math.PI) / 180);
}

/** Le feuillage parisien est en place de mi-avril à début novembre. */
function isLeafOn(date, canopyConfig) {
  const md = date.slice(5, 10);
  return md >= canopyConfig.leafOnStart && md <= canopyConfig.leafOnEnd;
}
