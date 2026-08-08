import { getJSON } from '../lib/http.js';

/**
 * Éclairage public de Paris : 165 600 points lumineux géolocalisés.
 *
 * Source : Ville de Paris, jeu « eclairage-public », licence ODbL.
 * https://opendata.paris.fr/explore/dataset/eclairage-public/
 *
 * ── Pourquoi ce jeu change quelque chose ───────────────────────────────────
 * Jusqu'ici l'indice tombait à zéro au coucher du soleil. Pour qui souffre de
 * la lumière, c'est faux au point d'être trompeur : la gêne nocturne existe,
 * elle est simplement d'une autre nature. De jour c'est une nappe diffuse ; de
 * nuit ce sont des **sources ponctuelles vives dans un champ sombre**, et l'œil
 * adapté à l'obscurité y est bien plus sensible.
 *
 * Le jeu porte tout ce qu'il faut pour le modéliser sérieusement : flux
 * lumineux, puissance, hauteur de mât, et surtout **température de couleur** —
 * qui décide de l'essentiel pour ce public.
 *
 * ── Ce que la donnée dit vraiment (zone centre, 34 393 points) ─────────────
 *   flux         97,5 % renseigné, médiane 4 348 lm
 *   puissance    99,8 % renseignée, médiane 40 W
 *   couleur      97,7 % renseignée, médiane 2 800 K
 *   hauteur      **30,3 % seulement**, médiane 6 m
 *
 * La hauteur est donc le maillon faible : elle se déduit du type d'ouvrage.
 */
const ODS_URL =
  'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/eclairage-public/exports/json';

/**
 * Hauteur de feu par défaut, en mètres, selon le type d'ouvrage.
 *
 * Sept points sur dix n'ont pas de hauteur renseignée. Ces valeurs sont celles
 * du parc parisien courant — un candélabre de voirie fait 6 m, une console de
 * façade est posée vers 5 m, une borne éclaire le sol depuis moins d'un mètre.
 * L'écart compte : à 6 m un luminaire est à 15° au-dessus du regard à 20 m,
 * à 1 m il est **sous** l'horizon et n'éblouit pas.
 */
const DEFAULT_HEIGHT = {
  Candélabre: 6,
  Console: 5,
  Projecteur: 8,
  Plafond: 4,
  Suspension: 5.5,
  Applique: 3.5,
  Borne: 0.9,
  Sol: 0.15,
  Mât: 9,
};
const FALLBACK_HEIGHT = 5;

/** Flux par défaut quand il manque, déduit de la puissance. */
const LUMENS_PER_WATT = 95; // LED de voirie courante

export async function fetchLighting(bbox) {
  const [west, south, east, north] = bbox;
  const rows = await getJSON(
    ODS_URL,
    {
      where: `in_bbox(geo_point_2d, ${south}, ${west}, ${north}, ${east})`,
      select:
        'geo_point_2d,lib_ouvrag,lampe_famille,lampe_flux,lampe_puissance,' +
        'lampe_temperature_couleur,support_hauteur',
      limit: '-1',
    },
    { label: 'Éclairage public de Paris' },
  );

  const list = Array.isArray(rows) ? rows : (rows.results ?? []);
  const lamps = [];
  for (const row of list) {
    const point = row.geo_point_2d;
    const lon = point?.lon ?? point?.[1];
    const lat = point?.lat ?? point?.[0];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const flux = luminousFlux(row);
    if (flux <= 0) continue;

    lamps.push({
      lon,
      lat,
      flux,
      height: mountingHeight(row),
      cct: colourTemperature(row),
    });
  }
  return lamps;
}

/**
 * Lampadaires d'OpenStreetMap, seule source uniforme hors de Paris.
 *
 * ── Ce qu'on a cherché avant ───────────────────────────────────────────────
 * Un équivalent régional du jeu parisien. Il n'y en a pas. Le catalogue de la
 * Région Île-de-France ne publie que l'éclairage **de Paris** ; data.gouv.fr ne
 * recense, pour l'éclairage public, que des villes hors région — La Rochelle,
 * Brest, Marseille, le SIGERLy. Aucun département francilien, aucune
 * intercommunalité.
 *
 * ── Ce que vaut le relevé OSM ──────────────────────────────────────────────
 * Mesuré sur Paris intra-muros : **33 246 lampadaires** dans OpenStreetMap
 * contre 165 600 dans le jeu de la Ville, soit un cinquième. Et presque aucun
 * ne porte de flux, de hauteur ni de température de couleur.
 *
 * Les positions, elles, sont justes. C'est donc utilisable là où le relevé est
 * fait, et trompeur là où il ne l'est pas : un cinquième des lampadaires
 * donnerait une ville quatre fois trop sombre, et « rue sombre » est exactement
 * la recommandation qu'on ne veut pas fausser. D'où le garde-fou de densité
 * ci-dessous — mieux vaut ne rien dire que dire faux.
 */
export function lampsFromOSM(nodes) {
  const lamps = [];
  for (const node of nodes) {
    if (node.type !== 'node' || node.tags?.highway !== 'street_lamp') continue;
    if (!Number.isFinite(node.lon) || !Number.isFinite(node.lat)) continue;
    const tags = node.tags;
    lamps.push({
      lon: node.lon,
      lat: node.lat,
      // Valeurs par défaut, assumées comme telles : OSM ne porte ces attributs
      // que sur une poignée de luminaires. Ce sont les médianes observées sur
      // le parc parisien, qui reste la seule mesure dont on dispose.
      flux: num(tags.lamp_flux) ?? (num(tags.lamp_power) ? num(tags.lamp_power) * 95 : 4348),
      height: num(tags.height) ?? DEFAULT_HEIGHT[mountOf(tags)] ?? FALLBACK_HEIGHT,
      cct: num(tags['lamp_colour_temperature']) ?? 2800,
    });
  }
  return lamps;
}

function mountOf(tags) {
  const mount = String(tags.support ?? tags.lamp_mount ?? '').toLowerCase();
  if (mount.includes('wall') || mount.includes('bent_mast')) return 'Console';
  if (mount.includes('bollard') || mount.includes('ground')) return 'Borne';
  if (mount.includes('ceiling')) return 'Plafond';
  if (mount.includes('suspend') || mount.includes('catenary')) return 'Suspension';
  return 'Candélabre';
}

/**
 * Le relevé d'éclairage de ce secteur est-il assez complet pour être cru ?
 *
 * Paris compte 165 600 luminaires pour environ 1 700 km de voies, soit près de
 * cent au kilomètre. Un secteur qui en déclare cinq n'est pas un secteur sombre,
 * c'est un secteur que personne n'a relevé. Le seuil est placé bas — quarante au
 * kilomètre, moins de la moitié de la densité parisienne — parce qu'une commune
 * de grande couronne éclaire réellement moins qu'un boulevard haussmannien, et
 * qu'on cherche à écarter l'absence de relevé, pas la sobriété.
 *
 * En dessous, l'application affiche « non renseigné » plutôt qu'une nuit noire
 * inventée : le format le prévoit déjà, par le drapeau `lit` de chaque tronçon.
 */
export const MIN_LAMPS_PER_KM = 40;

export function lightingIsMapped(lampCount, kilometres) {
  if (kilometres <= 0) return false;
  return lampCount / kilometres >= MIN_LAMPS_PER_KM;
}

/** Tous les champs du jeu sont typés texte : il faut les convertir. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function luminousFlux(row) {
  const flux = num(row.lampe_flux);
  if (flux) return Math.min(flux, 60000); // un projecteur de monument, pas plus
  const watts = num(row.lampe_puissance);
  return watts ? Math.min(watts * LUMENS_PER_WATT, 60000) : 0;
}

function mountingHeight(row) {
  const declared = num(row.support_hauteur);
  // Quelques saisies sont aberrantes : un « mât » de 60 m n'existe pas en
  // voirie, et une hauteur de 0 ferait diverger l'inverse du carré.
  if (declared && declared >= 0.1 && declared <= 30) return declared;
  return DEFAULT_HEIGHT[String(row.lib_ouvrag ?? '').trim()] ?? FALLBACK_HEIGHT;
}

/**
 * Température de couleur, en kelvins.
 *
 * À défaut, on la déduit de la technologie. Le sodium basse pression est
 * quasi monochromatique à 589 nm — on lui donne 1 800 K, qui est la convention,
 * mais sa vraie particularité est ailleurs : il ne contient presque pas de
 * bleu, et c'est le bleu qui fait mal.
 */
function colourTemperature(row) {
  const declared = num(row.lampe_temperature_couleur);
  if (declared && declared >= 1500 && declared <= 8000) return declared;

  const family = String(row.lampe_famille ?? '').toLowerCase();
  if (family.includes('sodium basse')) return 1800;
  if (family.includes('sodium')) return 2000;
  if (family.includes('iodure') || family.includes('cosmopolis')) return 3000;
  if (family.includes('fluorescent')) return 4000;
  if (family.includes('diode')) return 3000;
  return 2800; // médiane observée sur Paris
}
