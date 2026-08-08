import { getJSON } from '../lib/http.js';

/**
 * Arbres de Paris : 219 418 sujets géolocalisés, avec hauteur totale et
 * circonférence du tronc mesurées par la Direction des Espaces Verts.
 *
 * Source : Ville de Paris, jeu de données « les-arbres », licence ODbL.
 * https://opendata.paris.fr/explore/dataset/les-arbres/
 */
const ODS_URL =
  'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/les-arbres/exports/json';

/** Genres à feuillage persistant : ils ombragent toute l'année. */
const EVERGREEN = new Set([
  'Pinus', 'Cedrus', 'Picea', 'Abies', 'Taxus', 'Cupressus', 'Cupressocyparis',
  'Chamaecyparis', 'Thuja', 'Sequoia', 'Sequoiadendron', 'Ilex', 'Juniperus',
  'Cryptomeria', 'Araucaria', 'Quercus ilex', 'Photinia', 'Laurus', 'Eriobotrya',
]);

export async function fetchTrees(bbox) {
  const [west, south, east, north] = bbox;
  const data = await getJSON(
    ODS_URL,
    {
      where: `in_bbox(geo_point_2d, ${south}, ${west}, ${north}, ${east}) and typeemplacement = "Arbre"`,
      select: 'geo_point_2d,hauteurenm,circonferenceencm,stadedeveloppement,genre,espece,domanialite',
      limit: '-1',
    },
    { label: 'Arbres de Paris' },
  );

  const rows = Array.isArray(data) ? data : (data.results ?? []);
  return rows.filter((t) => t.geo_point_2d && Number(t.hauteurenm) > 0);
}

/**
 * Géométrie d'un houppier à partir des attributs disponibles.
 *
 * Le jeu de données ne donne ni le rayon ni le volume du houppier : on les
 * dérive du diamètre du tronc via une relation allométrique usuelle, recalée
 * sur la hauteur pour éviter les valeurs aberrantes (saisies à 0, arbres
 * fraîchement plantés annotés « Adulte », etc.).
 */
export function crownGeometry(tree) {
  let height = Number(tree.hauteurenm);
  // Quelques saisies sont manifestement fausses (arbres de 100 m avenue Foch).
  if (!Number.isFinite(height) || height <= 0) return null;
  height = Math.min(height, 45);

  const circumference = Number(tree.circonferenceencm);
  let radius;
  if (Number.isFinite(circumference) && circumference > 5) {
    const dbh = circumference / Math.PI; // diamètre à hauteur de poitrine, en cm
    radius = 0.6 + 0.11 * dbh;
  } else {
    radius = { 'Jeune (arbre)': 1.5, 'Jeune (arbre)Adulte': 2.5, Adulte: 4, Mature: 5.5 }[
      tree.stadedeveloppement
    ] ?? 3;
  }

  radius = Math.max(1, Math.min(radius, 9, height * 0.5));

  // Les arbres d'alignement sont élagués haut pour laisser passer les bus ;
  // ceux des parcs gardent des branches basses.
  const baseRatio = tree.domanialite === 'Alignement' ? 0.42 : 0.28;

  return { height, radius, base: height * baseRatio };
}

export function isEvergreen(tree) {
  const genus = String(tree.genre ?? '').trim();
  if (EVERGREEN.has(genus)) return true;
  // Le chêne vert est un Quercus persistant, contrairement aux autres chênes.
  return genus === 'Quercus' && String(tree.espece ?? '').includes('ilex');
}
