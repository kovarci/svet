import { getJSON } from '../lib/http.js';

/**
 * Zones de végétation de la BD TOPO®, en remplacement du fichier des arbres
 * hors de Paris.
 *
 * ── Ce qu'on perd, ce qu'on garde ──────────────────────────────────────────
 * Le fichier des arbres de la Ville de Paris est un recensement **individuel** :
 * 219 418 sujets, chacun avec sa hauteur mesurée, sa circonférence et son
 * essence. Rien d'équivalent n'existe à l'échelle régionale. La BD TOPO ne
 * donne que des **surfaces** : un bois, une haie, une forêt de conifères.
 *
 * C'est une perte considérable dans l'absolu, et presque indolore ici — parce
 * que ce n'est pas le recensement qui dessine les houppiers. En mode LiDAR,
 * la forme vient du relevé, et les arbres ne servent qu'à **une** chose :
 * repérer les persistants, qui ombragent aussi en janvier. Pour ça, une surface
 * étiquetée « forêt fermée de conifères » fait le même travail qu'une liste de
 * sujets, sur une emprise où le feuillage est de toute façon homogène.
 *
 * Là où ça coûte vraiment, c'est en mode vectoriel — le repli des cellules sans
 * LiDAR — puisqu'il faut alors inventer une hauteur de couvert par nature.
 * Elles sont ci-dessous, et ce sont des ordres de grandeur, pas des mesures.
 */
const WFS_URL = 'https://data.geopf.fr/wfs/ows';
const PAGE_SIZE = 5000;

/**
 * Hauteur de couvert présumée, en mètres, par nature.
 *
 * La BD TOPO ne porte aucune hauteur sur cette couche. Ces valeurs sont des
 * ordres de grandeur usuels pour le Bassin parisien : une futaie de chênes
 * adulte tourne autour de vingt mètres, une haie bocagère autour de trois.
 */
const HEIGHT = {
  'Forêt fermée de feuillus': 20,
  'Forêt fermée de conifères': 22,
  'Forêt fermée mixte': 21,
  'Forêt ouverte': 12,
  Peupleraie: 20,
  Bois: 15,
  'Zone arborée': 12,
  Haie: 3,
  Verger: 4,
  Vigne: 1.6,
  'Lande ligneuse': 1.5,
};
const DEFAULT_HEIGHT = 12;

/** Natures dont le feuillage tient toute l'année. */
const EVERGREEN = new Set(['Forêt fermée de conifères']);
/** Natures à feuillage mêlé : ni tout persistant, ni tout caduc. */
const MIXED = new Set(['Forêt fermée mixte']);

/**
 * @param {[number,number,number,number]} bbox
 * @returns {Promise<Array<{geometry: object, nature: string}>>}
 */
export async function fetchVegetation(bbox) {
  const [west, south, east, north] = bbox;
  const zones = [];

  for (let page = 0; page < 100; page++) {
    const data = await getJSON(
      WFS_URL,
      {
        SERVICE: 'WFS',
        VERSION: '2.0.0',
        REQUEST: 'GetFeature',
        TYPENAMES: 'BDTOPO_V3:zone_de_vegetation',
        SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
        // Latitude d'abord : c'est l'ordre imposé par `urn:ogc:def:crs:EPSG::4326`.
        BBOX: `${south},${west},${north},${east}`,
        COUNT: String(PAGE_SIZE),
        STARTINDEX: String(page * PAGE_SIZE),
        OUTPUTFORMAT: 'application/json',
      },
      { label: `BD TOPO végétation (page ${page + 1})` },
    );

    const batch = data.features ?? [];
    for (const feature of batch) {
      if (!feature.geometry) continue;
      zones.push({ geometry: feature.geometry, nature: feature.properties?.nature ?? null });
    }
    if (batch.length < PAGE_SIZE) break;
  }

  return zones;
}

export function canopyHeight(nature) {
  return HEIGHT[nature] ?? DEFAULT_HEIGHT;
}

/**
 * Coefficient d'extinction du couvert (Beer-Lambert), en m⁻¹.
 *
 * Une forêt mixte prend la moyenne des deux : c'est faux pour chaque arbre pris
 * séparément, et juste pour la parcelle, qui est l'unité dont on dispose.
 */
export function canopyExtinction(nature, leafOn, canopy) {
  if (EVERGREEN.has(nature)) return canopy.kConifer;
  const deciduous = leafOn ? canopy.kLeafOn : canopy.kLeafOff;
  if (MIXED.has(nature)) return (canopy.kConifer + deciduous) / 2;
  return deciduous;
}

export function isEvergreenZone(nature) {
  return EVERGREEN.has(nature) || MIXED.has(nature);
}
