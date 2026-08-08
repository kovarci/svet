import { getJSON } from '../lib/http.js';

/**
 * Chantiers en cours à Paris, et l'emprise qu'ils prennent au piéton.
 *
 * Source : Ville de Paris, jeu « chantiers-a-paris », licence ODbL.
 * https://opendata.paris.fr/explore/dataset/chantiers-a-paris/
 *
 * ── Ce que ce jeu ne permet pas ────────────────────────────────────────────
 * Il était tentant d'y voir les échafaudages, qui font beaucoup d'ombre à
 * Paris. Le jeu n'en dit rien : ni hauteur, ni bâchage, ni même le mot. 63 %
 * des chantiers sont bien des « travaux sur bâtiment », mais en déduire une
 * ombre demanderait d'inventer une hauteur pour chacun.
 *
 * Et l'effet serait ambigu jusque dans son signe : un échafaudage bâché forme
 * un tunnel couvert, ce qui est **favorable** à ce public, tandis qu'une simple
 * structure ouverte ne change presque rien. Modéliser une ombre ici reviendrait
 * à deviner, dans une direction inconnue.
 *
 * ── Ce qu'il permet, et qui compte autant ──────────────────────────────────
 * L'emprise au sol, et surtout `localisation_detail` : **2 950 chantiers sur
 * 4 445 occupent un trottoir**. Conseiller « marchez côté sud » quand ce
 * trottoir est barré ne renvoie pas seulement à un détour — ça pousse sur la
 * chaussée, au soleil et dans la circulation. Pour quelqu'un que la lumière
 * fait souffrir, c'est le pire endroit où l'envoyer.
 *
 * ── Fraîcheur ──────────────────────────────────────────────────────────────
 * Le jeu décrit l'état du jour : les chantiers ouvrent et ferment. Un calcul
 * d'il y a un mois barre des trottoirs rouverts et ignore les nouveaux. C'est
 * la première grandeur du projet qui périme vraiment vite — et la meilleure
 * raison du rafraîchissement quotidien (`npm run data:refresh`).
 */
const ODS_URL =
  'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/chantiers-a-paris/exports/json';

/**
 * Récupère les chantiers actifs à la date donnée.
 * @param {[number,number,number,number]} bbox
 * @param {string} date au format ISO court
 */
export async function fetchWorksites(bbox, date) {
  const [west, south, east, north] = bbox;
  const rows = await getJSON(
    ODS_URL,
    {
      where:
        `in_bbox(geo_point_2d, ${south}, ${west}, ${north}, ${east})` +
        ` and date_debut <= date'${date}' and date_fin >= date'${date}'`,
      select: 'geo_shape,localisation_detail,chantier_categorie,surface',
      limit: '-1',
    },
    {
      label: 'Chantiers à Paris',
      cacheKey: `chantiers-${date}-${bbox.map((v) => v.toFixed(3)).join('_')}`,
    },
  );

  const list = Array.isArray(rows) ? rows : (rows.results ?? []);
  const sites = [];

  for (const row of list) {
    // Seuls les chantiers qui mordent sur le cheminement piéton nous concernent.
    // Une emprise en chaussée gêne la circulation, pas la marche.
    const where = [].concat(row.localisation_detail ?? []);
    if (!where.includes('EMPRISE_TROTTOIR')) continue;

    for (const ring of ringsOf(row.geo_shape)) {
      if (ring.length >= 4) sites.push({ ring, category: row.chantier_categorie ?? null });
    }
  }
  return sites;
}

/** Anneaux extérieurs d'un `geo_shape`, quel que soit son emballage. */
function ringsOf(shape) {
  const geometry = shape?.geometry ?? shape;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]].filter(Boolean);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((polygon) => polygon[0]).filter(Boolean);
  }
  return [];
}
