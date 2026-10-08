/**
 * Position du soleil et modèle d'éclairement par ciel clair.
 *
 * Algorithme des coordonnées solaires de basse précision de l'Astronomical
 * Almanac : erreur < 0,01° sur la période 1950-2050, très largement suffisant
 * face à l'incertitude de notre modèle numérique de surface (± 1 m).
 *
 * Aucune donnée externe, aucun appareil de mesure : tout est astronomique.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * @param {Date} date instant (UTC en interne, comme tout objet Date)
 * @param {number} lat latitude en degrés
 * @param {number} lon longitude en degrés (est positif)
 * @returns {{altitude: number, azimuth: number}} en radians.
 *   `azimuth` est compté depuis le Nord, dans le sens horaire (Est = +90°).
 */
export function sunPosition(date, lat, lon) {
  // Jours juliens depuis J2000.0
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;

  const L = (280.46 + 0.9856474 * n) * D2R; // longitude moyenne
  const g = (357.528 + 0.9856003 * n) * D2R; // anomalie moyenne
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R; // longitude écliptique
  const eps = (23.439 - 0.0000004 * n) * D2R; // obliquité

  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

  // Temps sidéral local
  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;
  const lstDeg = gmstHours * 15 + lon;
  const ha = lstDeg * D2R - ra; // angle horaire

  const latR = lat * D2R;
  const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

  const azimuth = Math.atan2(
    -Math.sin(ha) * Math.cos(dec),
    Math.sin(dec) * Math.cos(latR) - Math.cos(dec) * Math.sin(latR) * Math.cos(ha),
  );

  return { altitude, azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI) };
}

/**
 * Réfraction atmosphérique près de l'horizon (formule de Sæmundsson).
 * Le soleil paraît plus haut qu'il ne l'est réellement : le lever/coucher est
 * décalé d'environ 4 minutes, ce qui compte pour les heures dorées.
 * @param {number} altitude altitude géométrique en radians
 * @returns {number} altitude apparente en radians
 */
export function applyRefraction(altitude) {
  const h = altitude * R2D;
  if (h < -1) return altitude;
  const r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D2R) / 60; // en degrés
  return (h + r) * D2R;
}

/**
 * Décalage horaire d'un fuseau à une date donnée, en minutes.
 * Utilise l'ICU de Node/du navigateur — gère l'heure d'été sans table codée en dur.
 */
export function timeZoneOffsetMinutes(date, timeZone = 'Europe/Paris') {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - date.getTime()) / 60000;
}

/**
 * Date civile d'un instant dans le fuseau donné, au format AAAA-MM-JJ.
 *
 * `toISOString().slice(0, 10)` donne la date **universelle** : de minuit à une
 * ou deux heures du matin à Paris, c'est encore la veille.
 */
export function localDate(date = new Date(), timeZone = 'Europe/Paris') {
  return shifted(date, timeZone).toISOString().slice(0, 10);
}

/** Heure civile d'un instant dans le fuseau donné, en minutes depuis minuit. */
export function localMinutes(date = new Date(), timeZone = 'Europe/Paris') {
  const local = shifted(date, timeZone);
  return local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
}

/** L'instant décalé de l'écart du fuseau : ses champs UTC sont l'heure locale. */
function shifted(date, timeZone) {
  // Arrondi : `timeZoneOffsetMinutes` ignore les millisecondes de l'instant.
  return new Date(date.getTime() + Math.round(timeZoneOffsetMinutes(date, timeZone)) * 60000);
}

/**
 * Convertit une heure locale (« 2026-07-31 », 14, 30) en instant UTC.
 * Résout l'offset par itération : nécessaire car l'offset dépend de l'instant.
 */
export function localToUTC(isoDate, hour, minute, timeZone = 'Europe/Paris') {
  const [y, m, d] = isoDate.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const offset = timeZoneOffsetMinutes(new Date(guess), timeZone);
    guess = Date.UTC(y, m - 1, d, hour, minute, 0) - offset * 60000;
  }
  return new Date(guess);
}

/** Jour de l'année d'une date civile « AAAA-MM-JJ », 1 au 1er janvier. */
export function dayOfYear(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

/** Constante solaire, en W/m² (Kopp & Lean, 2011). */
const SOLAR_CONSTANT = 1361;

/**
 * Facteur d'excentricité de l'orbite terrestre : le Soleil est 3,3 % plus
 * proche début janvier que début juillet, soit 6,7 % d'éclairement en plus.
 * Il manquait entièrement.
 *
 * @param {number} dayOfYear jour de l'année, 1 à 366
 */
export function eccentricity(dayOfYear) {
  return 1 + 0.03344 * Math.cos((2 * Math.PI * dayOfYear) / 365.25 - 0.048869);
}

/**
 * Trouble de Linke mensuel au point de Paris, janvier à décembre.
 *
 * Climatologie de Remund et al. (2003), distribuée par SoDa et lue au point
 * 48,8566 N 2,3522 E. Le modèle prenait 4 toute l'année, « 3 l'hiver et 4,5
 * l'été » — ce que la climatologie ne dit pas : la moyenne est de 3,2, et l'été
 * n'est pas le plus trouble. La table est irrégulière d'un mois à l'autre ; elle
 * n'a pas pu être confrontée à des mesures parisiennes. Sur les jours clairs de
 * Payerne en juin 2016, le trouble réel était plus faible que la climatologie
 * du lieu : en mode prévision, c'est le faisceau prévu qui fait foi.
 */
const PARIS_LINKE = [2.65, 3.65, 3.25, 2.6, 3.7, 3.1, 3.25, 3.5, 3.15, 3.3, 3.7, 2.75];
const MID_MONTH = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

/** Moyenne annuelle de la table : le trouble quand on ne connaît pas la date. */
export const DEFAULT_LINKE_TURBIDITY = 3.22;

/** Trouble de Linke de Paris au jour donné, interpolé entre les milieux de mois. */
export function linkeTurbidity(dayOfYear) {
  const day = ((dayOfYear - 1) % 365) + 1;
  for (let i = 0; i < 12; i++) {
    const [d0, d1] = [MID_MONTH[i], i < 11 ? MID_MONTH[i + 1] : MID_MONTH[0] + 365];
    const t = day < MID_MONTH[0] ? day + 365 : day;
    if (t >= d0 && t <= d1) {
      return PARIS_LINKE[i] + ((t - d0) / (d1 - d0)) * (PARIS_LINKE[(i + 1) % 12] - PARIS_LINKE[i]);
    }
  }
  return DEFAULT_LINKE_TURBIDITY;
}

/**
 * Masse d'air relative, formule de Kasten & Young (1989).
 *
 * Le modèle utilisait `1 / sin h`, qui n'est valable que loin de l'horizon : à
 * 1° de hauteur il annonce 57 masses d'air là où la sphéricité de l'atmosphère
 * en donne 27. L'ancien code bornait le résultat à 20 — ce qui plafonne l'erreur
 * sans la corriger, et fait disparaître le soleil rasant deux fois trop vite.
 *
 * Or le soleil rasant est exactement ce qui compte ici : c'est lui qui arrive
 * dans l'axe du regard, et c'est le terme d'éblouissement qui le pèse.
 *
 * @param {number} altitudeDeg hauteur apparente du soleil, en degrés
 */
export function airMass(altitudeDeg) {
  const h = Math.max(altitudeDeg, -0.5);
  return 1 / (Math.sin(h * D2R) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

/**
 * Épaisseur optique de Rayleigh pour une masse d'air donnée (Kasten, 1996).
 *
 * Elle dépend de la masse d'air elle-même : les couches basses, plus denses,
 * pèsent davantage dans les trajets rasants.
 */
function rayleighThickness(m) {
  if (m > 20) return 1 / (10.4 + 0.718 * m);
  const inverse =
    6.6296 + 1.7513 * m - 0.1202 * m * m + 0.0065 * m * m * m - 0.00013 * m * m * m * m;
  return inverse > 0 ? 1 / inverse : 0.1;
}

/**
 * Rayonnement par ciel clair, en W/m² — modèle ESRA (Rigollier, Bauer & Wald,
 * *Solar Energy* 68, 2000).
 *
 * Faisceau : extinction de Linke, B = I₀·ε₀·exp(−0,8662·T_L·m·δ_R(m)), la masse
 * d'air corrigée de l'altitude du site. Diffus : transmission au zénith et
 * fonction angulaire d'ESRA, qui ne demandent que le trouble et la hauteur du
 * soleil.
 *
 * L'ancien code appliquait cette extinction — établie pour l'énergie solaire
 * totale — directement à une constante solaire *lumineuse* de 133 300 lux, ce
 * qui revient à supposer une efficacité constante du faisceau à toute hauteur ;
 * et son diffus était une formule maison, au motif faux qu'ESRA demanderait
 * l'eau précipitable. On calcule désormais en watts, et l'on convertit ensuite
 * par les efficacités de Perez (`luminousEfficacy`).
 *
 * @param {number} altitude hauteur apparente du soleil, en radians
 * @param {number} [turbidity] trouble de Linke
 * @param {number} [dayOfYear]
 * @param {number} [elevation] altitude du site, en mètres
 * @returns {{directNormal: number, diffuseHorizontal: number}} en W/m²
 */
export function clearSkyIrradiance(altitude, turbidity, dayOfYear = 172, elevation = 35) {
  if (altitude <= 0) return { directNormal: 0, diffuseHorizontal: 0 };
  const tl = turbidity ?? linkeTurbidity(dayOfYear);
  const i0 = SOLAR_CONSTANT * eccentricity(dayOfYear);
  const m = Math.exp(-elevation / 8434.5) * airMass(altitude * R2D);
  const directNormal = i0 * Math.exp(-0.8662 * tl * m * rayleighThickness(m));

  const trd = -0.015843 + 0.030543 * tl + 0.0003797 * tl * tl;
  let a0 = 0.26463 - 0.061581 * tl + 0.0031408 * tl * tl;
  if (a0 * trd < 0.0022) a0 = 0.0022 / trd;
  const a1 = 2.0402 + 0.018945 * tl - 0.011161 * tl * tl;
  const a2 = -1.3025 + 0.039231 * tl + 0.0085079 * tl * tl;
  const sinH = Math.sin(altitude);
  const diffuseHorizontal = i0 * trd * Math.max(0, a0 + a1 * sinH + a2 * sinH * sinH);

  return { directNormal, diffuseHorizontal };
}

/**
 * Eau précipitable estimée du point de rosée, en cm (Perez et al. 1990) :
 * W = exp(0,07·T_d − 0,075), bornée à [0,2 ; 5].
 */
export function precipitableWater(dewPoint) {
  if (!Number.isFinite(dewPoint)) return 2;
  return Math.max(0.2, Math.min(5, Math.exp(0.07 * dewPoint - 0.075)));
}

/**
 * Coefficients (a, b, c, d) des efficacités lumineuses de Perez et al. (1990,
 * *Solar Energy* 44(5), tableau 4), par catégorie de clarté 1 à 8 — tels que
 * les emploie EnergyPlus.
 */
const BEAM_EFFICACY = [
  [57.2, -4.55, -2.98, 117.12],
  [98.99, -3.46, -1.21, 12.38],
  [109.83, -4.9, -1.71, -8.81],
  [110.34, -5.84, -1.99, -4.56],
  [106.36, -3.97, -1.75, -6.16],
  [107.19, -1.25, -1.51, -26.73],
  [105.75, 0.77, -1.26, -34.44],
  [101.18, 1.58, -1.1, -8.29],
];
const DIFFUSE_EFFICACY = [
  [97.24, -0.46, 12.0, -8.91],
  [107.22, 1.15, 0.59, -3.95],
  [104.97, 2.96, -5.53, -8.77],
  [102.39, 5.59, -13.95, -13.9],
  [100.71, 5.94, -22.75, -23.74],
  [106.42, 3.83, -36.15, -28.83],
  [141.88, 1.9, -53.24, -14.03],
  [152.23, 0.35, -45.27, -7.98],
];

/**
 * Efficacités lumineuses du faisceau et du diffus, en lm/W (Perez et al. 1990).
 *
 * Le faisceau rasant traverse beaucoup d'atmosphère, qui lui retire surtout le
 * bleu et le vert : à 5° de hauteur il n'éclaire plus qu'environ 50 lm/W,
 * contre 103 haut dans le ciel. Les 105 lm/W constants employés jusqu'ici
 * surestimaient donc le faisceau de 140 % entre 2 et 5°, et de 40 à 90 % entre
 * 5 et 15° — le régime même de l'éblouissement rasant. Le diffus de ciel clair,
 * bleu, monte à 130-160 lm/W, et non 120.
 *
 * @param {number} directNormal faisceau, W/m²
 * @param {number} diffuseHorizontal diffus horizontal, W/m²
 * @param {number} altitude hauteur apparente du soleil, en radians
 * @param {number} [dayOfYear]
 * @param {number} [water] eau précipitable, en cm
 * @returns {{beam: number, diffuse: number, epsilon: number, brightness: number, category: number}}
 */
export function luminousEfficacy(
  directNormal,
  diffuseHorizontal,
  altitude,
  dayOfYear = 172,
  water = 2,
) {
  const zenith = Math.max(0, Math.PI / 2 - altitude);
  const { epsilon, brightness } = perezSkyIndices(
    directNormal,
    diffuseHorizontal,
    altitude,
    dayOfYear,
  );
  let category = 1;
  for (const bound of PEREZ_BINS) if (epsilon > bound) category++;
  const [ab, bb, cb, db] = BEAM_EFFICACY[category - 1];
  const [ad, bd, cd, dd] = DIFFUSE_EFFICACY[category - 1];
  const beam = Math.max(0, ab + bb * water + cb * Math.exp(5.73 * zenith - 5) + db * brightness);
  const diffuse = Math.max(
    0,
    ad + bd * water + cd * Math.cos(zenith) + dd * Math.log(Math.max(brightness, 1e-4)),
  );
  return { beam, diffuse, epsilon, brightness, category };
}

/**
 * Éclairement solaire par ciel clair, en lux : ESRA en watts, converti par les
 * efficacités de Perez.
 *
 * @param {number} altitude hauteur apparente du soleil, en radians
 * @param {object} [options]
 * @param {number} [options.turbidity] trouble de Linke (par défaut, celui de
 *   Paris au jour donné)
 * @param {number} [options.dayOfYear] 172 — le solstice d'été — à défaut
 * @param {number} [options.precipitableWater] en cm, 2 à défaut
 * @returns {{directNormal: number, diffuseHorizontal: number}} en lux
 */
export function clearSkyIlluminance(
  altitude,
  { turbidity, dayOfYear = 172, precipitableWater: water = 2 } = {},
) {
  const sky = clearSkyIrradiance(altitude, turbidity, dayOfYear);
  if (sky.directNormal <= 0) return { directNormal: 0, diffuseHorizontal: 0 };
  const k = luminousEfficacy(sky.directNormal, sky.diffuseHorizontal, altitude, dayOfYear, water);
  return {
    directNormal: sky.directNormal * k.beam,
    diffuseHorizontal: sky.diffuseHorizontal * k.diffuse,
  };
}

/**
 * Indices de ciel de Perez : clarté ε et luminosité Δ.
 *
 * ε est la grandeur normalisée pour classer un ciel : elle compare le **global
 * au diffus**, en corrigeant de la hauteur du soleil. Un ciel couvert donne
 * ε ≈ 1, un ciel bleu franc dépasse 6. Δ dit à quel point le ciel diffus est
 * lumineux pour la masse d'air traversée — un couvert clair et un couvert
 * d'orage ont le même ε.
 *
 * Perez et al., *Solar Energy* 44 (1990). En **W/m²**, l'unité de leur
 * définition : calculés jusqu'ici sur des lux convertis avec deux efficacités
 * différentes, ils sous-estimaient ε de 5 à 12 % et faussaient le type de ciel.
 *
 * @param {number} directNormal faisceau, en W/m²
 * @param {number} diffuseHorizontal diffus horizontal, en W/m²
 * @param {number} altitude hauteur apparente du soleil, en radians
 * @param {number} [dayOfYear]
 */
export function perezSkyIndices(directNormal, diffuseHorizontal, altitude, dayOfYear = 172) {
  const zenith = Math.max(0, Math.PI / 2 - altitude);
  const z3 = 1.041 * zenith * zenith * zenith;
  const diffuse = Math.max(0.1, diffuseHorizontal);
  const epsilon = ((diffuse + Math.max(0, directNormal)) / diffuse + z3) / (1 + z3);
  const m = altitude > 0 ? airMass(altitude * R2D) : 40;
  const brightness = (diffuse * m) / (SOLAR_CONSTANT * eccentricity(dayOfYear));
  return { epsilon, brightness };
}

/**
 * Bornes des huit catégories de clarté de Perez.
 *
 * De 1 (couvert) à 8 (ciel bleu franc). C'est la classification employée par
 * toute la littérature d'éclairage naturel ; on s'en sert pour choisir le type
 * de ciel CIE au lieu d'un seuil inventé.
 */
export const PEREZ_BINS = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];

export const DEG = R2D;
export const RAD = D2R;
