import { getJSON } from '../lib/http.js';

/**
 * Emprises bâties, depuis deux sources selon l'étendue traitée.
 *
 * ── APUR, pour Paris ───────────────────────────────────────────────────────
 * Couche EMPRISE_BATIE_PARIS, 128 175 emprises, licence ODbL. Les hauteurs
 * (h_moy, h_med, h_max) sont issues d'une restitution photogrammétrique : ce
 * sont de vraies mesures, pas des estimations à partir du nombre d'étages.
 * C'est la source sur laquelle les ombres du projet ont été validées.
 * https://opendata.apur.org/datasets/emprise-batie-paris
 *
 * ── BD TOPO®, hors Paris ───────────────────────────────────────────────────
 * L'APUR s'arrête au périphérique : au-delà, elle ne renvoie rien. La BD TOPO
 * de l'IGN couvre le pays entier, et porte elle aussi une hauteur mesurée.
 *
 * Comparées sur l'Île de la Cité, les deux se valent pour ce qu'on leur
 * demande : 2 161 emprises APUR pour 48,6 ha contre 1 659 emprises BD TOPO
 * pour 51,1 ha — la BD TOPO découpe moins finement mais couvre un peu plus de
 * sol — et des hauteurs médianes à deux décimètres près (17,7 m contre 17,9 m),
 * renseignées sur 94 % des emprises.
 *
 * Ce recouvrement compte, parce qu'en mode LiDAR ces emprises ne servent pas à
 * porter l'ombre : le relevé s'en charge. Elles servent de **masque** — dire où
 * ce qui dépasse est un mur plutôt qu'un feuillage. C'est la surface couverte
 * qui décide, pas la finesse du découpage ni la hauteur.
 */
const APUR_URL =
  'https://carto2.apur.org/apur/rest/services/OPENDATA/EMPRISE_BATIE_PARIS/MapServer/0/query';
const PAGE_SIZE = 3000;

/** WFS de la Géoplateforme : couverture nationale, pagination par STARTINDEX. */
const WFS_URL = 'https://data.geopf.fr/wfs/ows';
const WFS_PAGE_SIZE = 5000;

/**
 * @param {[number,number,number,number]} bbox
 * @param {'apur'|'bdtopo'} [source] `apur` par défaut — c'est la source validée.
 */
export async function fetchBuildings(bbox, source = 'apur') {
  return source === 'bdtopo' ? fetchFromBDTopo(bbox) : fetchFromApur(bbox);
}

async function fetchFromApur(bbox) {
  const features = [];
  let offset = 0;
  const seen = new Set();

  for (let page = 0; page < 200; page++) {
    const data = await getJSON(
      APUR_URL,
      {
        geometry: bbox.join(','),
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        outSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OBJECTID,h_moy,h_med,h_max,b_igh',
        orderByFields: 'OBJECTID',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE_SIZE),
        f: 'geojson',
      },
      { label: `APUR bâti (offset ${offset})` },
    );

    const batch = data.features ?? [];
    if (batch.length === 0) break;

    // Garde-fou : si la pagination n'est pas honorée, on s'arrête plutôt que
    // de boucler indéfiniment sur la même page.
    const firstId = batch[0].properties?.OBJECTID;
    if (seen.has(firstId)) break;
    seen.add(firstId);

    features.push(...batch);
    process.stdout.write(`\r  bâtiments : ${features.length}`);

    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  process.stdout.write('\n');
  return features;
}

/**
 * BD TOPO® — couche `batiment`, servie en GeoJSON par le WFS de l'IGN.
 *
 * Deux pièges que la pagination naïve ne voit pas :
 *
 *  - **L'ordre des axes.** En WFS 2.0 avec `urn:ogc:def:crs:EPSG::4326`, la
 *    bbox se donne en latitude d'abord. Donnée dans l'ordre longitude/latitude,
 *    la requête aboutit — et renvoie zéro entité, ce qui ressemble en tout
 *    point à « pas de bâtiment ici ».
 *  - **Les constructions légères.** Vérandas, abris de jardin, serres. Elles
 *    sont dans la couche avec `construction_legere=true` et sans hauteur ; les
 *    garder ferait passer pour du bâti des cellules de MNS où le LiDAR ne voit
 *    qu'une tôle basse.
 */
async function fetchFromBDTopo(bbox) {
  const [west, south, east, north] = bbox;
  const features = [];

  for (let page = 0; page < 200; page++) {
    const data = await getJSON(
      WFS_URL,
      {
        SERVICE: 'WFS',
        VERSION: '2.0.0',
        REQUEST: 'GetFeature',
        TYPENAMES: 'BDTOPO_V3:batiment',
        SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
        BBOX: `${south},${west},${north},${east}`,
        COUNT: String(WFS_PAGE_SIZE),
        STARTINDEX: String(page * WFS_PAGE_SIZE),
        OUTPUTFORMAT: 'application/json',
      },
      { label: `BD TOPO bâti (page ${page + 1})` },
    );

    const batch = data.features ?? [];
    for (const feature of batch) {
      if (feature.properties?.construction_legere === true) continue;
      features.push(feature);
    }
    process.stdout.write(`\r  bâtiments : ${features.length}`);
    if (batch.length < WFS_PAGE_SIZE) break;
  }

  process.stdout.write('\n');
  return features;
}

/**
 * Hauteur retenue pour le lancer d'ombre.
 *
 * On prend la hauteur moyenne de l'emprise plutôt que la hauteur maximale :
 * h_max inclut cheminées, antennes et souches, qui ne portent pas vraiment
 * d'ombre au sol. h_moy représente mieux la masse du toit.
 *
 * `hauteur` est le champ de la BD TOPO ; il vient en dernier pour que les
 * mesures de l'APUR gardent la main là où les deux sources se recouvrent.
 */
export function buildingHeight(properties, fallback) {
  const candidates = [properties?.h_moy, properties?.h_med, properties?.h_max, properties?.hauteur];
  for (const value of candidates) {
    if (typeof value === 'number' && value > 1 && value < 400) return value;
  }
  return fallback;
}
