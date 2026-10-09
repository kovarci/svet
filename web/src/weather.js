/**
 * Prévisions de nébulosité et d'indice UV.
 *
 * Source : [Open-Meteo](https://open-meteo.com) — gratuit, sans compte ni clé,
 * libre d'usage non commercial. Les données viennent de modèles météo
 * nationaux, dont AROME de Météo-France sur la France.
 *
 * Ces valeurs ne sont volontairement *pas* intégrées au calcul du pipeline.
 * L'indice précalculé décrit la géométrie de la ville par ciel clair — une
 * référence stable et comparable. La météo s'applique par-dessus, à
 * l'affichage : la prévision change plusieurs fois par jour, il serait absurde
 * de relancer une simulation à chaque fois.
 */

import { sunPathDrift } from '@svet/pipeline/sun';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** Ciel de référence quand aucune prévision n'est disponible. */
export const CLEAR_SKY = { cloud: 0, uv: null, irradiance: null, source: 'clair' };

/**
 * Jours de prévision demandés : aujourd'hui, demain, après-demain.
 *
 * Trois, et pas sept : c'est l'horizon où l'on prépare une sortie, et le seul
 * que la dérive solaire laisse entier en toute saison (voir `DRIFT_TOLERANCE`).
 * Ce n'est qu'une borne haute — chaque jour doit encore passer `forecastDays`.
 */
export const FORECAST_DAYS = 3;

/**
 * Écart de course solaire au-delà duquel la prévision d'un jour n'est plus
 * appliquée aux ombres d'un autre, en degrés de hauteur.
 *
 * La prévision arrive heure par heure pour le jour prévu ; le soleil et les
 * ombres, eux, sont ceux du jour du calcul. Les combiner à la même heure n'a de
 * sens que si le soleil y est au même endroit. Sinon on pose les flux d'un jour
 * sur le soleil d'un autre : une zone calculée le 31 juillet, consultée le
 * 9 octobre, recevait à 19 h 30 un rayonnement mesuré après le coucher — 0 W/m²
 * de direct — sous un soleil de juillet encore à 18°, et la carte tombait à zéro.
 *
 * 1,4° de hauteur, c'est moins de 5 % de longueur d'ombre au midi d'équinoxe
 * (41°) : l'incertitude d'un mètre du modèle de surface sur un immeuble de vingt.
 * Cela laisse au moins trois jours en toute saison, deux semaines et plus aux solstices
 * — y compris pour une zone qui a manqué un rafraîchissement nocturne, à 1,2° —
 * et zéro de part et d'autre d'un changement d'heure, où l'écart dépasse 8°.
 */
export const DRIFT_TOLERANCE = 1.4;

const addDays = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Jours de prévision proposables, et leur écart à la course du soleil du calcul.
 *
 * Ils partent d'aujourd'hui, jamais de la date du calcul : celle-ci peut dater
 * de la veille, et proposer la météo d'hier n'a aucun sens pour quelqu'un qui
 * prépare une sortie. Une zone calculée pour une date à venir part, elle, de sa
 * propre date.
 *
 * Au-delà de la tolérance, le jour est écarté plutôt que corrigé. On aurait pu
 * transporter un rapport — le global prévu sur le global par ciel clair du jour
 * prévu, appliqué au ciel clair du jour calculé —, mais aux heures où l'un des
 * deux soleils est couché, le rapport n'existe pas : il faudrait inventer l'effet
 * des nuages sur un soleil que la prévision n'a pas vu. Et ce qui resterait ne
 * serait la météo d'aucun des deux jours.
 *
 * @param {object} p
 * @param {string} p.zoneDate date du calcul des ombres, AAAA-MM-JJ
 * @param {string} p.today date du jour, AAAA-MM-JJ
 * @param {{minutes: number}[]} p.times pas de temps de la simulation
 * @param {[number, number]} p.center [lon, lat]
 * @param {number} [p.days]
 * @returns {{date: string, drift: number, usable: boolean}[]} dans l'ordre,
 *   `drift` en degrés.
 */
export function forecastDays({ zoneDate, today, times, center, days = FORECAST_DAYS }) {
  const [lon, lat] = center;
  const start = zoneDate > today ? zoneDate : today;
  const minutes = times.map((step) => step.minutes);
  return Array.from({ length: Math.max(1, days) }, (_, i) => {
    const date = addDays(start, i);
    const drift = sunPathDrift(zoneDate, date, minutes, lat, lon);
    return { date, drift, usable: drift <= DRIFT_TOLERANCE };
  });
}

/**
 * Récupère la prévision horaire des jours demandés et la rééchantillonne sur
 * les pas de temps de la simulation.
 *
 * @param {object} p
 * @param {[number, number]} p.center [lon, lat]
 * @param {string[]} p.dates jours voulus, AAAA-MM-JJ, dans l'ordre — en pratique
 *   ceux que `forecastDays` a retenus
 * @param {{minutes: number}[]} p.times pas de temps de la simulation
 * @returns {Promise<{dates: string[], series: Record<string, object[]>}|null>}
 *   une série par jour, un point par pas de temps ; `null` si la prévision
 *   n'est pas disponible pour ces dates.
 */
export async function fetchForecast({ center, dates: wanted, times }) {
  if (!wanted?.length) return null;
  const [lon, lat] = center;
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    // `direct_normal_irradiance` et `diffuse_radiation` sont des sorties
    // directes du modèle météo, en W/m². Elles remplacent avantageusement la
    // nébulosité : « 100 % de couverture » est une moyenne horaire sur une
    // maille, qui ne dit pas si le disque solaire est masqué à cet instant.
    // Mesuré sur une journée parisienne, en déduire le faisceau direct depuis
    // la seule nébulosité donnait 27 klx d'erreur absolue moyenne, toujours
    // dans le sens de la sous-estimation — le pire sens pour ce public.
    // Les précipitations servent à mouiller la chaussée : une chaussée humide
    // réfléchit le soleil bas en miroir, ce qui est l'une des situations les
    // plus pénibles pour ce public et que le modèle ignorait entièrement.
    // Le point de rosée donne l'eau précipitable, dont dépendent l'efficacité
    // lumineuse de Perez et le spectre du ciel.
    hourly:
      'cloud_cover,uv_index,direct_normal_irradiance,diffuse_radiation,precipitation,dew_point_2m',
    timezone: 'Europe/Paris',
    start_date: wanted[0],
    end_date: wanted[wanted.length - 1],
  });

  const response = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Open-Meteo a répondu ${response.status}`);

  const data = await response.json();
  const hours = data?.hourly?.time;
  const clouds = data?.hourly?.cloud_cover;
  const uv = data?.hourly?.uv_index;
  const beam = data?.hourly?.direct_normal_irradiance;
  const diffuse = data?.hourly?.diffuse_radiation;
  const rain = data?.hourly?.precipitation;
  const dew = data?.hourly?.dew_point_2m;
  if (!hours?.length || !clouds?.length) return null;

  // Open-Meteo ne couvre qu'une fenêtre autour d'aujourd'hui. Hors de cette
  // fenêtre il renvoie des valeurs vides plutôt qu'une erreur.
  if (clouds.every((value) => value === null)) return null;

  const measured =
    beam?.some((value) => value !== null) && diffuse?.some((value) => value !== null);

  // Les heures arrivent à plat, tous jours confondus : on les regroupe par
  // date avant d'interpoler, sans quoi 23 h de lundi et 0 h de mardi seraient
  // vus comme deux points consécutifs de la même journée.
  const byDate = new Map();
  hours.forEach((iso, i) => {
    if (clouds[i] === null || clouds[i] === undefined) return;
    const day = iso.slice(0, 10);
    const [h, m] = iso.slice(11).split(':').map(Number);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push({
      minutes: h * 60 + m,
      cloud: (clouds[i] ?? 0) / 100,
      uv: uv?.[i] ?? 0,
      beam: measured ? (beam[i] ?? 0) : null,
      diffuse: measured ? (diffuse[i] ?? 0) : null,
      rain: rain?.[i] ?? 0,
      dewPoint: dew?.[i] ?? null,
    });
  });

  // On ne garde que les jours demandés : une plage peut en enjamber un qui a
  // été écarté, et il ne doit pas revenir par la bande.
  const dates = [...byDate.keys()].filter((day) => wanted.includes(day)).sort();
  if (dates.length === 0) return null;

  const series = {};
  for (const day of dates) {
    series[day] = times.map((step) => interpolate(byDate.get(day), step.minutes));
  }
  return { dates, series };
}

/** Interpolation linéaire entre les deux heures qui encadrent le pas de temps. */
function interpolate(series, minutes) {
  if (minutes <= series[0].minutes) return pick(series[0]);
  const last = series[series.length - 1];
  if (minutes >= last.minutes) return pick(last);

  for (let i = 1; i < series.length; i++) {
    if (series[i].minutes < minutes) continue;
    const before = series[i - 1];
    const after = series[i];
    const t = (minutes - before.minutes) / (after.minutes - before.minutes);
    const mix = (key) =>
      before[key] === null ? null : before[key] + (after[key] - before[key]) * t;

    return {
      cloud: before.cloud + (after.cloud - before.cloud) * t,
      uv: before.uv + (after.uv - before.uv) * t,
      irradiance:
        before.beam === null
          ? null
          : { beam: mix('beam'), diffuse: mix('diffuse'), dewPoint: dewBetween(before, after, t) },
      rain: before.rain + (after.rain - before.rain) * t,
      source: 'météo',
    };
  }
  return pick(last);
}

function pick(entry) {
  return {
    cloud: entry.cloud,
    uv: entry.uv,
    irradiance:
      entry.beam === null
        ? null
        : { beam: entry.beam, diffuse: entry.diffuse, dewPoint: entry.dewPoint ?? null },
    rain: entry.rain ?? 0,
    source: 'météo',
  };
}

/** Point de rosée interpolé, ou `null` s'il manque d'un côté. */
function dewBetween(before, after, t) {
  if (!Number.isFinite(before.dewPoint) || !Number.isFinite(after.dewPoint)) return null;
  return before.dewPoint + (after.dewPoint - before.dewPoint) * t;
}

/** Description courte d'un ciel, à partir de sa nébulosité. */
export function skyLabel(cloud) {
  const percent = Math.round(cloud * 100);
  if (percent < 12) return `ciel dégagé (${percent} %)`;
  if (percent < 40) return `peu nuageux (${percent} %)`;
  if (percent < 70) return `nuageux (${percent} %)`;
  if (percent < 90) return `très nuageux (${percent} %)`;
  return `couvert (${percent} %)`;
}
