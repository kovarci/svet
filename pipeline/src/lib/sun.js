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

  const L = (280.460 + 0.9856474 * n) * D2R; // longitude moyenne
  const g = (357.528 + 0.9856003 * n) * D2R; // anomalie moyenne
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R; // longitude écliptique
  const eps = (23.439 - 0.0000004 * n) * D2R; // obliquité

  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

  // Temps sidéral local
  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;
  const lstDeg = gmstHours * 15 + lon;
  const ha = (lstDeg * D2R) - ra; // angle horaire

  const latR = lat * D2R;
  const sinAlt =
    Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
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
 * Éclairement extraterrestre normal, en lux.
 *
 * Constante solaire (1 361 W/m²) convertie par l'efficacité lumineuse du
 * rayonnement solaire hors atmosphère, environ 98 lm/W. C'est le point de départ
 * physique de l'extinction, et non un paramètre à ajuster.
 */
const EXTRATERRESTRIAL_LUX = 133300;

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
 * Éclairement solaire par ciel clair, sans nuage.
 *
 * Le faisceau direct suit l'extinction de type ESRA :
 *
 *     E = E₀ · exp(−0,8662 · T_L · m · δ_R(m))
 *
 * avec T_L le trouble de Linke, m la masse d'air et δ_R l'épaisseur optique de
 * Rayleigh. À midi au solstice parisien, elle donne 85 000 lux d'éclairement
 * direct normal — soit environ 810 W/m², ce que mesurent les stations par beau
 * temps. L'ancienne exponentielle en donnait 100 000, une quinzaine de pour cent
 * de trop.
 *
 * Le diffus reste une forme empirique : le modèle ESRA complet demanderait la
 * hauteur d'eau précipitable, que l'on n'a pas hors ligne. Il n'en dépend pas
 * moins du trouble — une atmosphère chargée diffuse davantage, et c'est
 * précisément ce qui rend un ciel clair parisien plus laiteux qu'un ciel de
 * montagne.
 *
 * @param {number} altitude hauteur du soleil en radians
 * @param {number} [turbidity] trouble de Linke
 * @returns {{directNormal: number, diffuseHorizontal: number}} en lux
 */
export function clearSkyIlluminance(altitude, turbidity = DEFAULT_LINKE_TURBIDITY) {
  if (altitude <= 0) {
    return { directNormal: 0, diffuseHorizontal: 0 };
  }
  const sinH = Math.max(Math.sin(altitude), 0.01);
  const m = airMass(altitude * R2D);
  const directNormal = EXTRATERRESTRIAL_LUX * Math.exp(-0.8662 * turbidity * m * rayleighThickness(m));

  // Ce que le faisceau perd en traversant l'atmosphère, le ciel en rediffuse une
  // part. Le coefficient reste calé sur les mesures usuelles — 14 000 lux
  // environ par ciel clair d'été, soleil haut — mais suit désormais le trouble.
  const turbidityFactor = 0.55 + 0.45 * (turbidity / DEFAULT_LINKE_TURBIDITY);
  const diffuseHorizontal = (400 + 13500 * Math.pow(sinH, 0.6)) * turbidityFactor;

  return { directNormal, diffuseHorizontal };
}

/**
 * Trouble de Linke déduit d'un éclairement direct mesuré.
 *
 * L'inverse exact de l'extinction ESRA. Le trouble était figé à 4 : il descend
 * vers 2,5 par air froid et sec, dépasse 5,5 en épisode de pollution ou de
 * canicule — c'est-à-dire les jours qui comptent le plus pour ce public. Or
 * quand le modèle météo fournit le faisceau, l'atmosphère du jour est déjà
 * décrite dans ce chiffre : il suffit de la lire à l'envers.
 *
 * Sert à caler le mode « ciel clair » sur l'atmosphère réelle du jour plutôt que
 * sur une moyenne annuelle.
 *
 * @param {number} directNormalLux éclairement direct normal mesuré, en lux
 * @param {number} altitude hauteur du soleil, en radians
 */
export function linkeFromBeam(directNormalLux, altitude) {
  if (!(directNormalLux > 0) || altitude <= 0) return DEFAULT_LINKE_TURBIDITY;
  const m = airMass(altitude * R2D);
  const depth = 0.8662 * m * rayleighThickness(m);
  if (depth <= 0) return DEFAULT_LINKE_TURBIDITY;
  const turbidity = -Math.log(directNormalLux / EXTRATERRESTRIAL_LUX) / depth;
  // Hors de cette plage, ce n'est plus une atmosphère : c'est un nuage devant le
  // disque, ou une mesure aberrante. On ne prétend pas la traduire.
  return Math.max(1.5, Math.min(8, turbidity));
}

/**
 * Indices de ciel de Perez : clarté ε et luminosité Δ.
 *
 * ε est la grandeur normalisée pour classer un ciel, et elle vaut bien mieux que
 * la part directionnelle qu'on utilisait : elle compare le **global au diffus**,
 * en corrigeant de la hauteur du soleil. Un ciel couvert donne ε ≈ 1, un ciel
 * bleu franc dépasse 6. Δ dit à quel point le ciel diffus est lumineux pour la
 * masse d'air traversée — un couvert clair et un couvert d'orage ont le même ε.
 *
 * Perez et al., *Solar Energy* 44 (1990). Les deux se calculent depuis ce que le
 * modèle météo donne déjà, sans rien mesurer de plus.
 *
 * @param {number} directNormal éclairement direct normal, en lux
 * @param {number} diffuseHorizontal éclairement diffus horizontal, en lux
 * @param {number} altitude hauteur du soleil, en radians
 */
export function perezSkyIndices(directNormal, diffuseHorizontal, altitude) {
  const zenith = Math.max(0, Math.PI / 2 - altitude);
  const kappa = 1.041;
  const z3 = kappa * zenith * zenith * zenith;

  const diffuse = Math.max(1, diffuseHorizontal);
  const clearness = (diffuse + Math.max(0, directNormal)) / diffuse;
  const epsilon = (clearness + z3) / (1 + z3);

  const m = altitude > 0 ? airMass(altitude * R2D) : 40;
  const brightness = (diffuse * m) / EXTRATERRESTRIAL_LUX;

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
