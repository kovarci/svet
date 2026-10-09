/**
 * Position et éclairement de la Lune.
 *
 * Formules de basse précision de l'Astronomical Almanac (série tronquée de
 * Meeus) : une fraction de degré sur la position, ce qui suffit à dire si la
 * Lune est levée, de quelle phase, et à quel ordre de grandeur de lux.
 *
 * **Ce module ne touche pas à l'indice.** Une pleine lune haute donne environ
 * 0,25 lx au sol ; un seul lampadaire de voirie en donne plusieurs à son pied,
 * et son voile d'éblouissement domine tout ce que la Lune pourrait ajouter.
 * L'éclairement lunaire sert à l'affichage — savoir si la nuit est noire ou
 * claire — et à nulle autre chose.
 */
import { airMass } from './sun.js';

const D2R = Math.PI / 180;
const EARTH_RADIUS_KM = 6378.14;
const ASTRONOMICAL_UNIT_KM = 149597870.7;

/** Coefficient d'extinction visuel (Krisciunas & Schaefer 1991), par masse d'air. */
const EXTINCTION = 0.21;

/**
 * @param {Date} date
 * @param {number} lat latitude, en degrés
 * @param {number} lon longitude, en degrés (est positif)
 * @returns {{altitude: number, azimuth: number, phaseAngle: number,
 *   fraction: number, distanceKm: number}} angles en radians ; `azimuth` depuis
 *   le nord, sens horaire ; `phaseAngle` 0 à la pleine lune, π à la nouvelle ;
 *   `fraction` du disque éclairé, de 0 à 1.
 */
export function moonPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const sin = (deg) => Math.sin(deg * D2R);
  const cos = (deg) => Math.cos(deg * D2R);

  const lambda =
    218.32 +
    481267.881 * T +
    6.29 * sin(135.0 + 477198.87 * T) -
    1.27 * sin(259.3 - 413335.36 * T) +
    0.66 * sin(235.7 + 890534.22 * T) +
    0.21 * sin(269.9 + 954397.74 * T) -
    0.19 * sin(357.5 + 35999.05 * T) -
    0.11 * sin(186.5 + 966404.03 * T);
  const beta =
    5.13 * sin(93.3 + 483202.02 * T) +
    0.28 * sin(228.2 + 960400.89 * T) -
    0.28 * sin(318.3 + 6003.15 * T) -
    0.17 * sin(217.6 - 407332.21 * T);
  const parallax =
    0.9508 +
    0.0518 * cos(135.0 + 477198.87 * T) +
    0.0095 * cos(259.3 - 413335.36 * T) +
    0.0078 * cos(235.7 + 890534.22 * T) +
    0.0028 * cos(269.9 + 954397.74 * T);
  const distanceKm = EARTH_RADIUS_KM / Math.sin(parallax * D2R);

  // Écliptique → équatorial
  const eps = (23.439 - 0.013 * T) * D2R;
  const l = cos(beta) * cos(lambda);
  const m = cos(beta) * sin(lambda) * Math.cos(eps) - sin(beta) * Math.sin(eps);
  const n = cos(beta) * sin(lambda) * Math.sin(eps) + sin(beta) * Math.cos(eps);
  const ra = Math.atan2(m, l);
  const dec = Math.asin(n);

  // Horizontal
  const d = jd - 2451545.0;
  const gmstHours = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmstHours * 15 + lon) * D2R - ra;
  const latR = lat * D2R;
  const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
  const geocentric = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  // La Lune est assez proche pour que la parallaxe compte (jusqu'à 1°).
  const altitude = geocentric - parallax * D2R * Math.cos(geocentric);
  const azimuth =
    (Math.atan2(
      -Math.sin(ha) * Math.cos(dec),
      Math.sin(dec) * Math.cos(latR) - Math.cos(dec) * Math.sin(latR) * Math.cos(ha),
    ) +
      2 * Math.PI) %
    (2 * Math.PI);

  // Phase : angle Soleil–Lune–Terre, depuis l'élongation géocentrique.
  const g = 357.528 + 0.9856003 * (jd - 2451545.0);
  const sunLongitude = 280.46 + 0.9856474 * (jd - 2451545.0) + 1.915 * sin(g) + 0.02 * sin(2 * g);
  const elongation = Math.acos(cos(beta) * cos(lambda - sunLongitude));
  const phaseAngle = Math.atan2(
    ASTRONOMICAL_UNIT_KM * Math.sin(elongation),
    distanceKm - ASTRONOMICAL_UNIT_KM * Math.cos(elongation),
  );
  // atan2 renvoie l'angle Soleil–Lune–Terre côté Lune : 0 en pleine lune.
  const fraction = (1 + Math.cos(phaseAngle)) / 2;

  return { altitude, azimuth, phaseAngle, fraction, distanceKm };
}

/**
 * Éclairement au sol par la Lune, en lux.
 *
 * Magnitude visuelle en fonction de l'angle de phase (Krisciunas & Schaefer),
 * convertie en lux hors atmosphère, puis éteinte par la masse d'air. Donne 0,3
 * lx hors atmosphère à la pleine lune moyenne, 0,25 lx au sol quand elle est
 * haute. Ni nuages ni lumière du ciel : c'est l'éclairement direct.
 *
 * @param {{altitude: number, phaseAngle: number, distanceKm?: number}} moon
 */
export function moonIlluminance({ altitude, phaseAngle, distanceKm = 384400 }) {
  if (!(altitude > 0)) return 0;
  const alpha = Math.abs((phaseAngle * 180) / Math.PI);
  // Au-delà de 150° le croissant est trop fin pour la formule : on tient pour nul.
  if (alpha >= 150) return 0;
  const magnitude = -12.73 + 0.026 * alpha + 4e-9 * alpha ** 4;
  const outside = 2.54e-6 * 10 ** (-0.4 * magnitude) * (384400 / distanceKm) ** 2;
  return outside * 10 ** (-0.4 * EXTINCTION * airMass((altitude * 180) / Math.PI));
}
