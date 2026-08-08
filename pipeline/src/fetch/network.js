import { postForm } from '../lib/http.js';

/**
 * Réseau piéton depuis OpenStreetMap (via Overpass).
 *
 * On récupère tout ce qu'un piéton peut emprunter : trottoirs, allées, places,
 * escaliers, mais aussi les rues ordinaires (à Paris le trottoir est rarement
 * cartographié séparément, la voie porte donc le cheminement).
 */
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const WALKABLE =
  '^(footway|path|pedestrian|steps|living_street|residential|unclassified|service|' +
  'tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|cycleway|track|road)$';

/**
 * @param {[number,number,number,number]} bbox
 * @param {[number,number,number,number]} [lampBbox] emprise des lampadaires, un
 *   peu plus large : un luminaire hors emprise éclaire le trottoir du bord.
 *   Absente, aucun lampadaire n'est demandé.
 */
export async function fetchNetwork(bbox, lampBbox) {
  const [west, south, east, north] = bbox;
  // Les lampadaires voyagent dans la **même** requête que les voies.
  //
  // Overpass limite le débit par adresse, et la construction régionale fait
  // déjà trois cent quarante-trois requêtes. En doubler le nombre pour un jeu
  // de points qu'on veut sur exactement la même emprise revenait à se faire
  // refuser une requête sur deux — et un échec d'éclairage y ressemble à une
  // rue non éclairée.
  const lamps = lampBbox
    ? `node["highway"="street_lamp"](${lampBbox[1]},${lampBbox[0]},${lampBbox[3]},${lampBbox[2]});`
    : '';
  const query = `
    [out:json][timeout:180];
    (
      way["highway"~"${WALKABLE}"]["area"!~"yes"](${south},${west},${north},${east});
      ${lamps}
    );
    out geom tags;
  `;

  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const data = await postForm(
        endpoint,
        { data: query },
        {
          cacheKey: `osm${lampBbox ? '-lamps' : ''}-${bbox.map((v) => v.toFixed(4)).join('_')}`,
          label: `Overpass (${new URL(endpoint).host})`,
        },
      );
      if (Array.isArray(data.elements)) return data.elements;
      lastError = new Error(`Réponse Overpass inattendue depuis ${endpoint}`);
    } catch (err) {
      lastError = err;
      process.stdout.write(
        `  ⚠ ${new URL(endpoint).host} indisponible, on bascule sur un miroir\n`,
      );
    }
  }
  throw lastError;
}

/** Voies interdites ou impraticables à pied. */
export function isWalkable(tags = {}) {
  if (tags.foot === 'no' || tags.access === 'private' || tags.access === 'no') return false;
  if (tags.highway === 'service' && tags.service === 'parking_aisle') return false;
  // Les tunnels routiers sont exclus, mais pas les passages couverts piétons —
  // ce sont justement les itinéraires les plus intéressants ici.
  const pedestrian = ['footway', 'path', 'pedestrian', 'steps'].includes(tags.highway);
  if (tags.tunnel === 'yes' && !pedestrian) return false;
  return true;
}

/**
 * Une voie couverte (passage, galerie, sous-porche) est structurellement
 * sombre : on la marque plutôt que de l'exclure, elle peut être précieuse.
 */
export function isCovered(tags = {}) {
  return coverKind(tags) !== 0;
}

/**
 * Degré de couverture : 0 à ciel ouvert, 1 sous un toit ouvert aux extrémités,
 * 2 franchement enfermé.
 *
 * La distinction n'est pas cosmétique. Mesuré sur Paris, les 6 785 tronçons
 * couverts se répartissent en 3 127 tunnels, 2 536 intérieurs et 1 110 passages
 * — et le modèle numérique de surface **n'a pas vu le toit d'un sur deux** :
 * la moitié ressortait avec une ouverture au ciel supérieure à 40 %. Or ce sont
 * exactement les itinéraires qu'on veut recommander à ce public. Les
 * sous-évaluer est l'erreur la plus coûteuse du modèle.
 *
 * Un passage couvert garde de la lumière par ses deux bouts et ses verrières —
 * la galerie Vivienne n'est pas un tunnel. Un couloir de gare, si.
 */
export function coverKind(tags = {}) {
  // Ne pas se limiter à `tunnel=yes` : OpenStreetMap décrit un passage sous
  // immeuble par `tunnel=building_passage`, qui couvre à lui seul 1 210 voies
  // parisiennes — dont le passage Choiseul. S'en tenir à `yes` les manquait
  // toutes, et c'est précisément ce qu'on veut recommander.
  const tunnel = String(tags.tunnel ?? '');
  const covered = String(tags.covered ?? '');

  if (tunnel === 'yes' || tunnel === 'covered' || tunnel === 'passage') return 2;
  if (tags.indoor === 'yes') return 2;

  // Passage sous immeuble, arcade, colonnade : entièrement sous toit, mais
  // courts et ouverts aux deux bouts. Ce n'est pas un souterrain.
  if (tunnel === 'building_passage') return 1;
  if (covered && covered !== 'no') return 1;
  return 0;
}

/**
 * Traversée piétonne : passage clouté, îlot, traversée de tramway.
 *
 * C'est la pièce qui manquait pour que « marchez côté nord » veuille dire
 * quelque chose : sans traversée, un itinéraire ne peut pas changer de
 * trottoir. Là où OpenStreetMap cartographie une traversée, elle devient une
 * arête du graphe comme une autre — avec une pénalité, parce qu'attendre au
 * feu puis traverser coûte du temps.
 */
export function isCrossing(tags = {}) {
  return tags.footway === 'crossing' || tags.highway === 'crossing' || tags.crossing != null;
}
