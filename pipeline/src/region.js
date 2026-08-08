import { getJSON } from './lib/http.js';
import { tileBbox, tileOf } from './lib/tiles.js';

/**
 * Découpage d'une région en cellules de calcul.
 *
 * ── Pourquoi découper ──────────────────────────────────────────────────────
 * Une zone se calcule d'un bloc : un modèle de surface en mémoire, un jeu de
 * points, un binaire. Paris intra-muros, c'est 105 km², 26 millions de cellules
 * de MNS et 54 Mo de sortie. L'Île-de-France fait 12 000 km² — cent quinze fois
 * plus. Le MNS seul dépasserait les trois milliards de cellules, et le binaire
 * le gigaoctet. Il n'y a pas de réglage qui rende ça tenable d'un bloc : il faut
 * découper.
 *
 * ── Pourquoi sur la grille de tuiles ───────────────────────────────────────
 * Le découpage aurait pu être arbitraire — une grille en degrés, un carroyage
 * Lambert. Le caler sur la grille Web Mercator au zoom 12 achète une propriété
 * qui simplifie tout l'aval : **chaque tuile appartient à exactement une
 * cellule**. Toutes les cellules peuvent donc écrire dans la même pyramide sans
 * se marcher dessus, et sans passe de fusion des tuiles de bordure — laquelle
 * aurait demandé de relire et recoudre des protobufs déjà écrits.
 *
 * Une cellule z12 fait environ 6,4 × 6,6 km sous nos latitudes, soit ~42 km² :
 * les deux cinquièmes de Paris intra-muros, une taille où le calcul tient en
 * une minute et le binaire en quelques mégaoctets.
 *
 * ── Ce que le découpage ne casse pas ───────────────────────────────────────
 * Les ombres traversent les bords : chaque cellule télécharge son bâti avec la
 * marge de 450 m habituelle, comme le faisait une zone. Un immeuble de la
 * cellule voisine porte donc bien son ombre. Le graphe piéton, lui, se recoud à
 * l'affichage : ses nœuds sont déjà indexés sur les coordonnées arrondies au
 * micro-degré, si bien que deux cellules qui se touchent nomment leur nœud
 * commun de la même façon.
 */

/** Zoom de la grille sur laquelle les cellules sont calées. */
export const CELL_ZOOM = 12;

/**
 * Bits réservés au numéro de tronçon dans un identifiant global.
 *
 * Les tuiles d'une région forment une seule pyramide, et MapLibre y rattache
 * l'état d'affichage par identifiant : deux cellules qui numéroteraient toutes
 * deux leurs tronçons à partir de zéro se voleraient mutuellement leurs
 * couleurs. On préfixe donc l'identifiant par le rang de la cellule.
 *
 * Vingt bits, soit 1 048 576 tronçons par cellule — Paris intra-muros entier en
 * compte 220 815, et une cellule fait les deux cinquièmes de Paris. Les onze
 * bits restants portent 2 048 cellules, pour 343 en Île-de-France.
 *
 * Le binaire, lui, reste indexé localement : le navigateur retrouve le rang de
 * la cellule et le numéro du tronçon par un décalage, sans table à charger.
 */
export const SEGMENT_BITS = 20;
export const MAX_SEGMENTS_PER_CELL = 1 << SEGMENT_BITS;

/**
 * Origine de la grille de cellules d'une région.
 *
 * Calculée depuis l'emprise englobante et non depuis la liste des cellules : le
 * rang d'une cellule ne doit dépendre ni du contour administratif, ni de l'ordre
 * de parcours. Sinon une mise à jour de la BD TOPO renumérotant une cellule
 * invaliderait tous les identifiants déjà écrits dans les tuiles.
 */
export function gridOrigin(region) {
  const [west, south, east, north] = region.bbox;
  const [xMin, yMin] = tileOf(west, north, CELL_ZOOM);
  const [xMax, yMax] = tileOf(east, south, CELL_ZOOM);
  return { xMin, yMin, cols: xMax - xMin + 1, rows: yMax - yMin + 1 };
}

/** Rang d'une cellule dans sa région — le préfixe de ses identifiants. */
export function cellOrdinal(origin, x, y) {
  return (x - origin.xMin) * origin.rows + (y - origin.yMin);
}

/** Premier identifiant de tronçon attribué à une cellule. */
export function cellIdBase(origin, x, y) {
  return cellOrdinal(origin, x, y) * MAX_SEGMENTS_PER_CELL;
}

export const REGIONS = {
  idf: {
    label: 'Île-de-France',
    /** Code INSEE de la région dans la BD TOPO — sert à récupérer son contour. */
    insee: '11',
    /** Emprise englobante, resserrée ensuite sur le contour réel. */
    bbox: [1.4461, 48.12, 3.559, 49.2415],
    /** Maille du modèle de surface, en mètres. Celle de Paris intra-muros. */
    res: 2.0,
  },
};

export function resolveRegion(name) {
  const region = REGIONS[name];
  if (!region) {
    throw new Error(
      `Région inconnue : "${name}". Régions disponibles : ${Object.keys(REGIONS).join(', ')}`,
    );
  }
  return { key: name, ...region };
}

/**
 * Contour administratif de la région, en anneaux [lon, lat][].
 *
 * Sans lui, le carroyage de l'emprise englobante compterait 460 cellules quand
 * la région n'en occupe que les deux tiers : on calculerait la Picardie et la
 * Beauce pour rien, soit des heures de lancer de rayons sur des champs.
 */
export async function fetchBoundary(region) {
  const data = await getJSON(
    'https://data.geopf.fr/wfs/ows',
    {
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      REQUEST: 'GetFeature',
      TYPENAMES: 'BDTOPO_V3:region',
      SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
      CQL_FILTER: `code_insee='${region.insee}'`,
      OUTPUTFORMAT: 'application/json',
    },
    { cacheKey: `contour-region-${region.insee}`, label: `Contour ${region.label} (BD TOPO)` },
  );

  const rings = [];
  for (const feature of data.features ?? []) {
    for (const ring of outerRings(feature.geometry)) {
      // La BD TOPO sert des coordonnées à trois composantes ; la troisième est
      // une altitude dont on n'a que faire ici.
      rings.push(ring.map(([lon, lat]) => [lon, lat]));
    }
  }
  if (rings.length === 0) {
    throw new Error(`Contour introuvable pour la région ${region.insee}.`);
  }
  return rings;
}

/**
 * Cellules qui recoupent réellement le territoire.
 *
 * @param {object} region
 * @param {Array<Array<[number, number]>>} rings contour de la région
 * @returns {Array<{key: string, x: number, y: number, z: number, bbox: number[], center: [number, number]}>}
 */
export function cellsOf(region, rings) {
  const z = CELL_ZOOM;
  const [west, south, east, north] = region.bbox;
  const [x0, y0] = tileOf(west, north, z);
  const [x1, y1] = tileOf(east, south, z);

  const cells = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const bbox = tileBbox(x, y, z);
      if (!touchesRings(bbox, rings)) continue;
      cells.push({
        key: cellKey(x, y, z),
        x,
        y,
        z,
        bbox,
        center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      });
    }
  }
  return cells;
}

/** Nom de cellule, tel qu'il apparaît dans les fichiers et l'index. */
export function cellKey(x, y, z = CELL_ZOOM) {
  return `${z}-${x}-${y}`;
}

export function parseCellKey(key) {
  const [z, x, y] = key.split('-').map(Number);
  if (![z, x, y].every(Number.isInteger)) throw new Error(`Clé de cellule invalide : "${key}".`);
  return { z, x, y, bbox: tileBbox(x, y, z) };
}

// ---------------------------------------------------------------------------

/**
 * L'emprise recoupe-t-elle le contour ?
 *
 * Trois cas à couvrir, et se contenter du premier laisserait des trous : une
 * cellule peut n'entamer le territoire que par un coin (aucun sommet du contour
 * à l'intérieur, aucun coin de cellule dans le contour, mais une frontière qui
 * la traverse). On teste donc aussi l'intersection des segments.
 */
function touchesRings(bbox, rings) {
  const [west, south, east, north] = bbox;
  const corners = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];

  for (const ring of rings) {
    if (!ringBboxOverlaps(ring, bbox)) continue;

    // Un sommet du contour tombe dans la cellule.
    for (const [lon, lat] of ring) {
      if (lon >= west && lon <= east && lat >= south && lat <= north) return true;
    }
    // Un coin de la cellule tombe dans le contour.
    for (const corner of corners) {
      if (pointInRing(corner, ring)) return true;
    }
    // La frontière traverse la cellule de part en part.
    for (let i = 1; i < ring.length; i++) {
      for (let c = 0; c < 4; c++) {
        if (segmentsCross(ring[i - 1], ring[i], corners[c], corners[(c + 1) % 4])) return true;
      }
    }
  }
  return false;
}

function ringBboxOverlaps(ring, [west, south, east, north]) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return !(maxLon < west || minLon > east || maxLat < south || minLat > north);
}

function pointInRing([lon, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a, b, c, d) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function cross(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]].filter(Boolean);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((polygon) => polygon[0]).filter(Boolean);
  }
  return [];
}
