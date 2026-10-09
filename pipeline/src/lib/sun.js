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
 * Un formateur par fuseau, construit une fois. Le construire coûte 75 µs, s'en
 * servir dix fois moins : comparer deux courses solaires en demande des
 * centaines, et la construction faisait presque tout le temps — 38 ms par
 * comparaison, 3 ms une fois le formateur gardé.
 */
const zoneFormatters = new Map();

function zoneFormatter(timeZone) {
  let dtf = zoneFormatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, dtf);
  }
  return dtf;
}

/**
 * Décalage horaire d'un fuseau à une date donnée, en minutes.
 * Utilise l'ICU de Node/du navigateur — gère l'heure d'été sans table codée en dur.
 */
export function timeZoneOffsetMinutes(date, timeZone = 'Europe/Paris') {
  const dtf = zoneFormatter(timeZone);
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

/**
 * Plus grand écart de hauteur du soleil entre deux dates, **aux mêmes heures
 * légales**, en degrés.
 *
 * C'est la grandeur qui dit si des ombres calculées pour un jour valent pour un
 * autre : elles sont figées à l'heure de l'horloge, et c'est à l'heure de
 * l'horloge qu'arrive la prévision. Compter des jours n'y suffit pas — la
 * déclinaison bouge vingt fois plus vite à l'équinoxe qu'au solstice, et le
 * changement d'heure décale d'un coup tout le soleil d'une heure, ce qu'aucun
 * compte de jours ne voit.
 *
 * Sous l'horizon il n'y a pas de soleil, à −5° comme à −20° : les hauteurs sont
 * comptées à partir de zéro, faute de quoi la nuit dominerait l'écart.
 *
 * @param {string} dateA au format AAAA-MM-JJ
 * @param {string} dateB au format AAAA-MM-JJ
 * @param {number[]} minutes heures légales comparées, en minutes depuis minuit
 * @param {number} lat latitude en degrés
 * @param {number} lon longitude en degrés (est positif)
 */
export function sunPathDrift(dateA, dateB, minutes, lat, lon, timeZone = 'Europe/Paris') {
  const altitude = (date, m) => {
    const hour = Math.floor(m / 60);
    const instant = localToUTC(date, hour, m - hour * 60, timeZone);
    return Math.max(0, applyRefraction(sunPosition(instant, lat, lon).altitude));
  };
  let drift = 0;
  for (const m of minutes) {
    drift = Math.max(drift, Math.abs(altitude(dateA, m) - altitude(dateB, m)));
  }
  return drift * R2D;
}

/**
 * Constante solaire, en W/m² (Kopp & Lean, *Geophysical Research Letters* 38,
 * 2011). Le point de départ de l'extinction, et non un paramètre à ajuster.
 */
export const SOLAR_CONSTANT = 1361;

/**
 * La constante de 1 367 W/m² avec laquelle Perez a ajusté ses modèles. On la
 * garde pour calculer la luminosité Δ : ses coefficients ont été estimés avec
 * elle, et l'en changer déplacerait les catégories.
 */
const PEREZ_SOLAR_CONSTANT = 1367;

/** Altitude de Paris, pour la masse d'air absolue du modèle d'Ineichen. */
const SITE_ALTITUDE = 35;

/** Eau précipitable par défaut, en cm — celle que retient `gendaylit`. */
export const DEFAULT_PRECIPITABLE_WATER = 2;

/**
 * Trouble de Linke par défaut : atmosphère urbaine de plaine.
 *
 * Il mesure combien d'atmosphères de Rayleigh pures il faudrait pour produire
 * l'extinction observée — aérosols et vapeur d'eau compris. Paris tourne autour
 * de 3 l'hiver et 4,5 l'été ; 4 est la valeur moyenne. C'est *le* paramètre qui
 * distingue un ciel clair parisien d'un ciel clair d'altitude, et il était
 * jusqu'ici enfoui dans un coefficient d'extinction unique.
 */
export const DEFAULT_LINKE_TURBIDITY = 4;

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

/** Masse d'air absolue : la relative, ramenée à la pression du site. */
function absoluteAirMass(altitudeDeg) {
  const pressureRatio = Math.exp(-SITE_ALTITUDE / 8434.5);
  return airMass(altitudeDeg) * pressureRatio;
}

/**
 * Rayonnement par ciel clair, modèle d'Ineichen & Perez (*Solar Energy* 73,
 * 2002), en W/m².
 *
 * Il remplace une extinction ESRA pour le faisceau et, pour le diffus, une forme
 * empirique « 400 + 13 500·sin(h)^0,6 » qui n'avait pas de source. Ineichen-Perez
 * est le modèle de référence de pvlib, et son trouble de Linke est défini
 * indépendamment de la masse d'air — ce qui permet de le relire dans un faisceau
 * mesuré à n'importe quelle heure.
 *
 * Portage de `pvlib.clearsky.ineichen`, sans le terme d'« amélioration de
 * Perez » qui n'y est pas activé par défaut.
 *
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} [turbidity] trouble de Linke
 * @param {number} [extraterrestrial] éclairement extraterrestre normal, en W/m²
 * @returns {{ghi: number, dni: number, dhi: number}}
 */
export function clearSkyIrradiance(
  altitude,
  turbidity = DEFAULT_LINKE_TURBIDITY,
  extraterrestrial = SOLAR_CONSTANT,
) {
  if (altitude <= 0) return { ghi: 0, dni: 0, dhi: 0 };
  const cosZenith = Math.max(0, Math.sin(altitude));
  const am = absoluteAirMass(altitude * R2D);
  const tl = turbidity;
  const fh1 = Math.exp(-SITE_ALTITUDE / 8000);
  const fh2 = Math.exp(-SITE_ALTITUDE / 1250);
  const cg1 = 5.09e-5 * SITE_ALTITUDE + 0.868;
  const cg2 = 3.92e-5 * SITE_ALTITUDE + 0.0387;

  const ghi =
    cg1 * extraterrestrial * cosZenith * Math.max(0, Math.exp(-cg2 * am * (fh1 + fh2 * (tl - 1))));
  const b = 0.664 + 0.163 / fh1;
  const bnci = extraterrestrial * Math.max(0, b * Math.exp(-0.09 * am * (tl - 1)));
  const bnci2 =
    ghi *
    Math.min(
      Math.max((1 - (0.1 - 0.2 * Math.exp(-tl)) / (0.1 + 0.882 / fh1)) / cosZenith, 0),
      1e20,
    );
  const dni = Math.min(bnci, bnci2);
  return { ghi, dni, dhi: ghi - dni * cosZenith };
}

/**
 * Trouble de Linke relu dans un faisceau direct mesuré.
 *
 * L'inverse exact du faisceau d'Ineichen-Perez. Le trouble descend vers 2,5 par
 * air froid et sec, dépasse 5,5 en épisode de pollution ou de canicule —
 * c'est-à-dire les jours qui comptent le plus pour ce public.
 *
 * À n'employer que par ciel clair : un nuage devant le disque éteint le
 * faisceau sans rien dire de l'atmosphère, et la lecture donnerait un trouble
 * absurde. L'appelant ne s'en sert qu'au-delà de la catégorie 6 de Perez.
 *
 * @param {number} dni éclairement direct normal mesuré, en W/m²
 * @param {number} altitude hauteur du soleil, en radians
 */
export function linkeFromBeam(dni, altitude) {
  if (!(dni > 0) || altitude <= 0) return DEFAULT_LINKE_TURBIDITY;
  const am = absoluteAirMass(altitude * R2D);
  const b = 0.664 + 0.163 / Math.exp(-SITE_ALTITUDE / 8000);
  const turbidity = 1 - Math.log(dni / (b * SOLAR_CONSTANT)) / (0.09 * am);
  // Hors de cette plage, ce n'est plus une atmosphère : c'est un nuage devant le
  // disque, ou une mesure aberrante. On ne prétend pas la traduire.
  return Math.max(1.5, Math.min(8, turbidity));
}

/**
 * Partage du global en direct et diffus, modèle d'Erbs, Klein & Duffie (*Solar
 * Energy* 28, 1982).
 *
 * Ne sert qu'hors ligne, quand on n'a que la nébulosité. On posait jusqu'ici un
 * faisceau en (1 − N)^1,5, exposant sans source. Erbs relie la fraction diffuse
 * à l'indice de clarté k_t = G / (G₀ cos Z), par une régression sur des années
 * de mesures ; c'est le partage employé par `pvlib.irradiance.erbs`.
 *
 * @param {number} ghi éclairement global horizontal, en W/m²
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} [extraterrestrial] éclairement extraterrestre normal, en W/m²
 */
export function erbsSplit(ghi, altitude, extraterrestrial = SOLAR_CONSTANT) {
  const cosZenith = Math.sin(altitude);
  if (!(ghi > 0) || altitude <= 3 * D2R) return { dni: 0, dhi: Math.max(0, ghi || 0) };
  const kt = Math.min(1, ghi / (extraterrestrial * Math.max(cosZenith, 0.065)));
  let fraction;
  if (kt <= 0.22) fraction = 1 - 0.09 * kt;
  else if (kt <= 0.8)
    fraction = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  else fraction = 0.165;
  const dhi = fraction * ghi;
  return { dni: Math.max(0, (ghi - dhi) / cosZenith), dhi };
}

/**
 * Indices de ciel de Perez : clarté ε et luminosité Δ, depuis des **flux
 * énergétiques**.
 *
 * Ils se calculaient sur des lux, chacun converti avec sa propre efficacité :
 * 105 lm/W pour le faisceau, 120 pour le ciel. Le rapport des deux — donc ε —
 * s'en trouvait déplacé, et Δ, normalisé par un extraterrestre en lux, l'était
 * de 20 %. Perez les définit sur les irradiances, et ses coefficients ont été
 * ajustés ainsi : c'est donc ainsi qu'on les calcule, exactement comme
 * `gendaylit` (Radiance).
 *
 * @param {number} dni éclairement direct normal, en W/m²
 * @param {number} dhi éclairement diffus horizontal, en W/m²
 * @param {number} altitude hauteur du soleil, en radians
 */
export function perezSkyIndices(dni, dhi, altitude) {
  const zenith = Math.max(0, Math.PI / 2 - altitude);
  const z3 = 1.041 * zenith ** 3;
  const diffuse = Math.max(0.1, dhi);
  const epsilon = ((diffuse + Math.max(0, dni)) / diffuse + z3) / (1 + z3);

  // Masse d'air de Kasten (1966), celle de `gendaylit`.
  const zenithDeg = Math.min(90, zenith * R2D);
  const m = 1 / (Math.cos(zenithDeg * D2R) + 0.15 * Math.pow(93.885 - zenithDeg, -1.253));
  const brightness = (diffuse * m) / PEREZ_SOLAR_CONSTANT;

  return { epsilon: Math.min(epsilon, 12), brightness };
}

/**
 * Bornes des huit catégories de clarté de Perez.
 *
 * De 1 (couvert) à 8 (ciel bleu franc). C'est la classification employée par
 * toute la littérature d'éclairage naturel.
 */
export const PEREZ_BINS = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];

/** Rang de la catégorie de Perez, de 0 à 7. */
export function perezCategory(epsilon) {
  let category = 0;
  while (category < PEREZ_BINS.length && epsilon >= PEREZ_BINS[category]) category++;
  return category;
}

/**
 * Coefficients des efficacités lumineuses de Perez et al. (*Solar Energy* 44,
 * 1990), par catégorie de clarté : a, b, c, d.
 *
 * Recopiés de `gendaylit` (Radiance), qui les emploie pour convertir des flux en
 * lux depuis trente ans.
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
 * Efficacités lumineuses du faisceau et du ciel, en lm/W, modèle de Perez (1990).
 *
 * Elles valaient 105 et 120 lm/W en toute circonstance (Littlefair, ciel
 * dégagé). Or l'efficacité du faisceau chute au soleil rasant — le spectre
 * rougit, l'œil y est moins sensible — et celle du ciel dépend de ce qui le
 * compose : un couvert épais, un voile laiteux, un ciel bleu franc. Perez
 * ajuste les deux sur des mesures simultanées en watts et en lux, selon la
 * clarté, la luminosité, la hauteur du soleil et l'eau précipitable.
 *
 * @param {number} epsilon clarté de Perez
 * @param {number} brightness luminosité de Perez
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} [water] eau précipitable, en cm
 */
export function perezEfficacy(epsilon, brightness, altitude, water = DEFAULT_PRECIPITABLE_WATER) {
  const category = perezCategory(epsilon);
  const zenith = Math.max(0, Math.PI / 2 - altitude);
  const delta = Math.max(0.01, brightness);
  const [ba, bb, bc, bd] = BEAM_EFFICACY[category];
  const [da, db, dc, dd] = DIFFUSE_EFFICACY[category];
  return {
    beam: Math.max(0, ba + bb * water + bc * Math.exp(5.73 * zenith - 5) + bd * delta),
    diffuse: Math.max(0, da + db * water + dc * Math.cos(zenith) + dd * Math.log(delta)),
  };
}

/**
 * Eau précipitable déduite du point de rosée, en cm — la relation retenue par
 * Perez et al. (1990) : W = exp(0,07·T_d − 0,075).
 *
 * @param {number} dewPoint point de rosée à 2 m, en °C
 */
export function precipitableWater(dewPoint) {
  if (!Number.isFinite(dewPoint)) return DEFAULT_PRECIPITABLE_WATER;
  return Math.max(0.1, Math.min(6, Math.exp(0.07 * dewPoint - 0.075)));
}

/**
 * Éclairement par ciel clair, en lux : Ineichen-Perez converti par les
 * efficacités de Perez.
 *
 * @param {number} altitude hauteur du soleil en radians
 * @param {number} [turbidity] trouble de Linke
 * @returns {{directNormal: number, diffuseHorizontal: number}} en lux
 */
export function clearSkyIlluminance(altitude, turbidity = DEFAULT_LINKE_TURBIDITY) {
  const { dni, dhi } = clearSkyIrradiance(altitude, turbidity);
  if (!(dni > 0) && !(dhi > 0)) return { directNormal: 0, diffuseHorizontal: 0 };
  const { epsilon, brightness } = perezSkyIndices(dni, dhi, altitude);
  const efficacy = perezEfficacy(epsilon, brightness, altitude);
  return { directNormal: dni * efficacy.beam, diffuseHorizontal: dhi * efficacy.diffuse };
}

export const DEG = R2D;
export const RAD = D2R;
