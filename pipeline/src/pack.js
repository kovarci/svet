import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { CARDINALS, HIGHWAYS } from './model.js';
import { tileOf } from './lib/tiles.js';

/**
 * Mise en forme des sorties pour le web : tuiles vectorielles et fichier binaire.
 *
 * ── Pourquoi ───────────────────────────────────────────────────────────────
 * Le GeoJSON d'une zone atteignait 39 Mo, et Paris entier en demanderait 418.
 * Or la répartition surprend : **12 % seulement de géométrie**, 53 % de séries
 * horaires et 23 % d'attributs. Tuiler la géométrie sans toucher au reste
 * n'aurait donc gagné qu'un huitième.
 *
 * On sépare donc en deux, selon ce dont l'application a besoin :
 *
 *  - **La géométrie part en tuiles vectorielles.** Le navigateur ne télécharge
 *    que ce qu'il affiche, et la taille de la ville cesse d'entrer en ligne de
 *    compte.
 *  - **Tout le reste part dans un binaire à enregistrements de taille fixe.**
 *    Une valeur d'exposition tient dans un octet ; en JSON elle en coûte trois
 *    ou quatre, plus les crochets et les virgules. Et surtout, un fichier
 *    binaire se lit par vues sur un tampon — aucun analyseur à faire tourner
 *    sur des dizaines de mégaoctets.
 *
 * Le graphe d'itinéraire voyage dans le même binaire : il ne peut pas être
 * tuilé, puisqu'un chemin traverse par définition ce qui n'est pas affiché.
 */

const MAGIC = 0x54455653; // « SVET » en petit-boutiste
/**
 * 2 : éblouissement nocturne, en-tête de tronçon porté à 20 octets.
 * 3 : emprises de chantier sur trottoir, en-tête porté à 22.
 * 4 : un seul jeu de séries par tronçon ; le second côté part en bloc annexe.
 */
const FORMAT_VERSION = 4;
const HEADER_BYTES = 32;
/**
 * En-tête d'un tronçon, en octets.
 *
 * Passé de 16 à 20 avec l'éblouissement nocturne : deux entiers de 16 bits, un
 * par trottoir. Un octet aurait mal suffi — les valeurs utiles s'étalent de
 * 0,02 à plus de 10 cd/m², et c'est le bas de la plage qui distingue une
 * ruelle sombre d'une rue résidentielle.
 */
const SEGMENT_PREFIX = 22;

/**
 * Plage de zooms des tuiles.
 *
 * Le plancher n'est pas cosmétique : sous le zoom minimal, une source
 * vectorielle ne demande plus rien et la carte devient **vide**. Onze suffit à
 * embrasser Paris d'un coup d'œil.
 */
const MIN_ZOOM = 11;
const MAX_ZOOM = 16;

/**
 * Écrit la pyramide de tuiles vectorielles.
 *
 * @param {string} dir dossier de la pyramide
 * @param {object} options
 * @param {boolean} [options.clear] vider la pyramide d'abord. Vrai pour une
 *   zone, qui possède la sienne ; **faux** pour une cellule de région, dont la
 *   pyramide est partagée avec trois cent quarante-deux voisines. Le découpage
 *   étant calé sur la grille z12, aucune tuile n'appartient à deux cellules :
 *   elles peuvent écrire côte à côte sans se relire.
 * @param {number} [options.minZoom] plancher de la pyramide. Une cellule ne
 *   descend pas sous le zoom de son propre découpage — plus bas, une tuile
 *   couvrirait plusieurs cellules, et la dernière écrite effacerait les autres.
 * @returns {Promise<{tiles: number, bytes: number}>}
 */
export async function writeTiles(dir, network, buildings, bbox, { clear = true, minZoom } = {}) {
  if (clear) await rm(dir, { recursive: true, force: true });
  const floorZoom = minZoom ?? MIN_ZOOM;

  // La géométrie seule, plus le strict nécessaire au rendu et au clic. Tout ce
  // qui varie dans le temps vit dans le binaire.
  const reseau = {
    type: 'FeatureCollection',
    features: network.features.map((feature) => ({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        id: feature.properties.id,
        lOff: feature.properties.lOff,
        rOff: feature.properties.rOff,
      },
    })),
  };

  const options = {
    maxZoom: MAX_ZOOM,
    indexMaxZoom: MAX_ZOOM,
    tolerance: 3,
    extent: 4096,
    buffer: 64,
    generateId: false,
  };
  const layers = {
    reseau: geojsonvt(reseau, options),
    // Le bâti sert aux ombres portées, dessinées dans le navigateur. Une marge
    // plus large que pour le réseau : un immeuble hors écran projette son ombre
    // dans le champ.
    bati: geojsonvt(buildings, { ...options, buffer: 256, tolerance: 2 }),
  };

  const [west, south, east, north] = bbox;
  let tiles = 0;
  let bytes = 0;

  for (let z = floorZoom; z <= MAX_ZOOM; z++) {
    // On ne balaie que les tuiles qui recoupent l'emprise : parcourir 2^z × 2^z
    // cases prendrait des heures au zoom 16.
    const [x0, y0] = tileOf(west, north, z);
    const [x1, y1] = tileOf(east, south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const parts = {};
        for (const [name, index] of Object.entries(layers)) {
          const tile = index.getTile(z, x, y);
          if (tile && tile.features.length > 0) parts[name] = tile;
        }
        // Une tuile vide s'écrit quand même, à zéro octet.
        //
        // Sans elle, le serveur répond à la requête comme il répond à n'importe
        // quel fichier absent — et un serveur de développement, ou un
        // hébergement configuré pour une application à page unique, renvoie
        // alors `index.html` avec un code 200. MapLibre reçoit du HTML là où il
        // attend un protobuf : « Unimplemented type: 4 », et la tuile est
        // perdue. Un fichier vide est une tuile vectorielle valide.
        const buffer =
          Object.keys(parts).length === 0
            ? Buffer.alloc(0)
            : Buffer.from(vtpbf.fromGeojsonVt(parts, { version: 2 }));
        const file = path.join(dir, String(z), String(x), `${y}.pbf`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, buffer);
        tiles++;
        bytes += buffer.length;
      }
    }
  }

  // L'emprise voyage avec la pyramide : déclarée à la source, elle empêche
  // MapLibre de réclamer des tuiles hors zone, qui n'existeront jamais.
  return { tiles, bytes, minZoom: floorZoom, maxZoom: MAX_ZOOM, bounds: bbox };
}

/**
 * Écrit le fichier binaire : attributs, séries horaires, profils d'horizon et
 * graphe d'itinéraire.
 *
 * Enregistrements de taille fixe, donc accès direct par identifiant : l'octet
 * d'un tronçon se calcule, il ne se cherche pas.
 */
export async function writeData(outDir, zoneKey, { segments, timeSteps, horizonBins, graph }) {
  const names = [];
  const nameIndex = new Map();
  const indexOfName = (name) => {
    if (!name) return 0xffff;
    if (!nameIndex.has(name)) {
      nameIndex.set(name, names.length);
      names.push(name);
    }
    return nameIndex.get(name);
  };

  // Un champ mal nommé s'encoderait en zéro sans rien dire. On vérifie donc que
  // les grandeurs qui ne peuvent pas être nulles ne le sont pas.
  const suspect = segments.find((segment) => !(segment.length > 0));
  if (suspect) {
    throw new Error(
      `Tronçon sans longueur à l'encodage (${suspect.name ?? 'sans nom'}) — ` +
        'un champ a probablement changé de nom entre le calcul et l’empaquetage.',
    );
  }

  /**
   * Un seul jeu de séries par tronçon, et un second **seulement** quand les
   * deux trottoirs diffèrent.
   *
   * Mesuré sur Paris : 91,9 % des tronçons n'ont qu'un côté — cheminements
   * piétons, trottoirs cartographiés, traversées — et pour tous, les deux
   * séries stockées étaient rigoureusement identiques. Soit 17,7 Mo écrits
   * deux fois, un tiers du fichier.
   *
   * On garde l'accès direct par identifiant, qui est la raison d'être du
   * format : le bloc principal reste à pas fixe, et les seconds côtés vivent
   * dans un bloc annexe, précédé de la liste triée des identifiants concernés.
   * Renuméroter les tronçons aurait aussi marché, mais aurait touché les
   * tuiles et le graphe — beaucoup de surface pour le même gain.
   */
  const SIDE_BYTES = 2 * timeSteps + horizonBins;
  const stride = SEGMENT_PREFIX + SIDE_BYTES;
  const twoSided = [];
  for (let i = 0; i < segments.length; i++) if (!segments[i].shared) twoSided.push(i);

  const nameBytes = [];
  for (const segment of segments) indexOfName(segment.name);
  for (const name of names) nameBytes.push(Buffer.from(name, 'utf8'));

  const namesLength = names.reduce((sum, _, i) => sum + 2 + nameBytes[i].length, 0);
  const total =
    HEADER_BYTES +
    segments.length * stride +
    twoSided.length * 4 +
    twoSided.length * SIDE_BYTES +
    graph.nodeCount * 8 +
    graph.edgeCount * 16 +
    namesLength;

  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt8(FORMAT_VERSION, 4);
  buffer.writeUInt8(timeSteps, 5);
  buffer.writeUInt8(horizonBins, 6);
  buffer.writeUInt32LE(segments.length, 8);
  buffer.writeUInt32LE(graph.nodeCount, 12);
  buffer.writeUInt32LE(graph.edgeCount, 16);
  buffer.writeUInt32LE(names.length, 20);
  buffer.writeUInt32LE(twoSided.length, 28);

  let offset = HEADER_BYTES;
  for (const segment of segments) {
    const base = offset;
    buffer.writeUInt16LE(indexOfName(segment.name), base);
    buffer.writeUInt8(Math.max(0, HIGHWAYS.indexOf(segment.highway)), base + 2);
    buffer.writeUInt8(
      (segment.crossing ? 1 : 0) |
        (segment.covered ? 2 : 0) |
        (segment.shared ? 0 : 4) |
        // Bit 8 : le jeu d'éclairage couvre ce tronçon. Sans lui, « aucun
        // lampadaire » et « on ne sait pas » seraient indiscernables — et
        // promettre l'obscurité hors commune serait la mauvaise erreur.
        (segment.lit ? 8 : 0),
      base + 3,
    );
    buffer.writeUInt16LE(clamp(Math.round(segment.length * 10), 0, 65535), base + 4);
    buffer.writeUInt8(segment.width === null ? 255 : clamp(Math.round(segment.width * 2), 0, 254), base + 6);
    buffer.writeUInt8(clamp(Math.round(segment.lOff * 10), 0, 255), base + 7);
    buffer.writeUInt8(clamp(Math.round(segment.rOff * 10), 0, 255), base + 8);
    buffer.writeUInt8(CARDINALS.indexOf(segment.lSide) & 7, base + 9);
    buffer.writeUInt8(CARDINALS.indexOf(segment.rSide) & 7, base + 10);
    buffer.writeUInt8(clamp(segment.lSvf, 0, 255), base + 11);
    buffer.writeUInt8(clamp(segment.rSvf, 0, 255), base + 12);
    buffer.writeUInt8(clamp(segment.lCanopy, 0, 255), base + 13);
    buffer.writeUInt8(clamp(segment.rCanopy, 0, 255), base + 14);
    // Luminance de voile nocturne, en centièmes de cd/m².
    buffer.writeUInt16LE(clamp(segment.lVeil ?? 0, 0, 65535), base + 16);
    buffer.writeUInt16LE(clamp(segment.rVeil ?? 0, 0, 65535), base + 18);
    // Part du trottoir barrée par un chantier, en pourcentage.
    buffer.writeUInt8(clamp(segment.lWork ?? 0, 0, 100), base + 20);
    buffer.writeUInt8(clamp(segment.rWork ?? 0, 0, 100), base + 21);

    writeSide(buffer, base + SEGMENT_PREFIX, segment.lSun, segment.lFlick, segment.lHor);
    offset += stride;
  }

  // Bloc annexe : la liste triée des tronçons à deux trottoirs, puis leur côté
  // droit. La liste permet une recherche dichotomique à la lecture — pas de
  // table de correspondance à construire, et rien à charger en mémoire.
  for (const id of twoSided) {
    buffer.writeUInt32LE(id, offset);
    offset += 4;
  }
  for (const id of twoSided) {
    const segment = segments[id];
    writeSide(buffer, offset, segment.rSun, segment.rFlick, segment.rHor);
    offset += SIDE_BYTES;
  }

  function writeSide(target, at, sun, flicker, horizon) {
    let cursor = at;
    for (let i = 0; i < timeSteps; i++) target.writeUInt8(clamp(sun[i], 0, 255), cursor++);
    for (let i = 0; i < timeSteps; i++) target.writeUInt8(clamp(flicker[i], 0, 255), cursor++);
    for (let i = 0; i < horizonBins; i++) target.writeUInt8(clamp(horizon[i], 0, 255), cursor++);
  }

  for (let i = 0; i < graph.nodeCount; i++) {
    buffer.writeFloatLE(graph.nodeLon[i], offset);
    buffer.writeFloatLE(graph.nodeLat[i], offset + 4);
    offset += 8;
  }

  for (let i = 0; i < graph.edgeCount; i++) {
    buffer.writeUInt32LE(graph.edgeA[i], offset);
    buffer.writeUInt32LE(graph.edgeB[i], offset + 4);
    buffer.writeUInt32LE(graph.edgeSegment[i], offset + 8);
    buffer.writeFloatLE(graph.edgeLength[i], offset + 12);
    offset += 16;
  }

  buffer.writeUInt32LE(offset, 24); // début de la table des noms
  for (const bytes of nameBytes) {
    buffer.writeUInt16LE(bytes.length, offset);
    bytes.copy(buffer, offset + 2);
    offset += 2 + bytes.length;
  }

  await writeFile(path.join(outDir, `${zoneKey}.data.bin`), buffer);
  return { bytes: buffer.length, stride, names: names.length };
}

/**
 * Construit le graphe piéton dans le pipeline.
 *
 * Il y était construit dans le navigateur, à partir du GeoJSON complet. Avec
 * une géométrie tuilée, ce n'est plus possible : un itinéraire traverse par
 * définition ce qui n'est pas à l'écran.
 *
 * Un nœud par **sommet** de tracé, et non par extrémité de tronçon : les
 * tronçons sont découpés tous les 30 m, mais un carrefour tombe presque
 * toujours au milieu d'un tracé.
 */
export function buildGraph(segments) {
  const nodeIndex = new Map();
  const nodeLon = [];
  const nodeLat = [];
  const edgeA = [];
  const edgeB = [];
  const edgeSegment = [];
  const edgeLength = [];

  const nodeAt = (lon, lat) => {
    const key = `${Math.round(lon * 1e6)},${Math.round(lat * 1e6)}`;
    let id = nodeIndex.get(key);
    if (id === undefined) {
      id = nodeLon.length;
      nodeIndex.set(key, id);
      nodeLon.push(lon);
      nodeLat.push(lat);
    }
    return id;
  };

  segments.forEach((segment, position) => {
    const coords = segment.coords;
    for (let i = 1; i < coords.length; i++) {
      const a = nodeAt(coords[i - 1][0], coords[i - 1][1]);
      const b = nodeAt(coords[i][0], coords[i][1]);
      if (a === b) continue;
      edgeA.push(a);
      edgeB.push(b);
      edgeSegment.push(position);
      edgeLength.push(flatDistance(coords[i - 1], coords[i]));
    }
  });

  return {
    nodeCount: nodeLon.length,
    edgeCount: edgeA.length,
    nodeLon: Float64Array.from(nodeLon),
    nodeLat: Float64Array.from(nodeLat),
    edgeA: Uint32Array.from(edgeA),
    edgeB: Uint32Array.from(edgeB),
    edgeSegment: Uint32Array.from(edgeSegment),
    edgeLength: Float32Array.from(edgeLength),
  };
}

function flatDistance([lon1, lat1], [lon2, lat2]) {
  const midLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  return Math.hypot((lon2 - lon1) * 111320 * Math.cos(midLat), (lat2 - lat1) * 111132);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value ?? 0)));
}
