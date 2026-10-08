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

import {
  applyRefraction,
  clearSkyIrradiance,
  dayOfYear,
  localToUTC,
  sunPosition,
} from '@svet/pipeline/sun';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** Ciel de référence quand aucune prévision n'est disponible. */
export const CLEAR_SKY = { cloud: 0, uv: null, irradiance: null, source: 'clair' };

/**
 * Récupère la prévision horaire et la rééchantillonne sur les pas de temps de
 * la simulation.
 *
 * @param {object} p
 * @param {[number, number]} p.center [lon, lat]
 * @param {string} p.date au format AAAA-MM-JJ
 * @param {{minutes: number}[]} p.times pas de temps de la simulation
 * @returns {Promise<{cloud: number, uv: number}[] | null>} un point par pas de
 *   temps, ou `null` si la prévision n'est pas disponible pour cette date.
 */
/**
 * Horizon de prévision, en jours à partir de la date du calcul.
 *
 * Trois, et pas sept. La météo, elle, irait plus loin — mais les séries
 * d'ombrage sont figées à la date du calcul, et c'est **elles** qui bornent
 * l'honnêteté du résultat. Sur trois jours le soleil dérive d'au plus 1,2° à
 * midi, soit moins de 3 % d'erreur sur la longueur d'ombre, en dessous de
 * l'incertitude sur la hauteur des bâtiments. Au-delà, on annoncerait une
 * géométrie qu'on n'a pas calculée.
 */
export const FORECAST_DAYS = 3;

const addDays = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * @returns {{dates: string[], series: Record<string, object[]>}|null}
 *   une série par pas de temps et par jour.
 */
export async function fetchForecast({ center, date, times, days = FORECAST_DAYS }) {
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
    // `direct_radiation`, le faisceau sur un plan horizontal, sert à bâtir
    // l'indice de ciel clair : sa moyenne horaire se compare sans ambiguïté à
    // celle du ciel clair, là où le faisceau normal change de signification avec
    // la hauteur du soleil.
    hourly:
      'cloud_cover,uv_index,direct_normal_irradiance,direct_radiation,diffuse_radiation,precipitation,dew_point_2m',
    timezone: 'Europe/Paris',
    start_date: date,
    end_date: addDays(date, Math.max(1, days) - 1),
  });

  const response = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Open-Meteo a répondu ${response.status}`);

  const data = await response.json();
  const hours = data?.hourly?.time;
  const clouds = data?.hourly?.cloud_cover;
  const uv = data?.hourly?.uv_index;
  const beam = data?.hourly?.direct_normal_irradiance;
  const beamHorizontal = data?.hourly?.direct_radiation;
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
      beamHorizontal: measured ? (beamHorizontal?.[i] ?? null) : null,
      diffuse: measured ? (diffuse[i] ?? 0) : null,
      rain: rain?.[i] ?? 0,
      dewPoint: dew?.[i] ?? null,
    });
  });

  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return null;

  const series = {};
  for (const day of dates) {
    const entries = byDate.get(day);
    if (measured) addClearSkyIndex(entries, day, lat, lon);
    series[day] = times.map((step) => interpolate(entries, step.minutes, { day, lat, lon }));
  }
  return { dates, series };
}

/**
 * Rayonnement du ciel clair à une minute du jour, en W/m², au point donné.
 *
 * ESRA en watts, le soleil à la hauteur **apparente** — la même que celle du
 * reste du modèle. Nul sous l'horizon.
 */
export function clearSkyAt(day, minutes, lat, lon) {
  const raw = sunPosition(localToUTC(day, 0, minutes), lat, lon);
  const altitude = applyRefraction(raw.altitude);
  if (altitude <= 0) return { altitude, beamNormal: 0, beamHorizontal: 0, diffuse: 0 };
  const sky = clearSkyIrradiance(altitude, undefined, dayOfYear(day));
  return {
    altitude,
    beamNormal: sky.directNormal,
    beamHorizontal: sky.directNormal * Math.sin(altitude),
    diffuse: sky.diffuseHorizontal,
  };
}

/** Sous-pas, en minutes, de la moyenne du ciel clair sur l'heure écoulée. */
const SUB_STEPS = Array.from({ length: 12 }, (_, k) => -55 + 5 * k);

/**
 * Indice de ciel clair de chaque heure : le rapport de la moyenne prévue à la
 * moyenne du ciel clair **sur la même heure écoulée**.
 *
 * Open-Meteo publie, à l'étiquette 08:00, la moyenne de 07:00 à 08:00. La traiter
 * comme une valeur instantanée à 08:00 décalait tout d'une demi-heure : un
 * faisceau trop faible au lever et — pire — encore présent après le coucher, aux
 * heures où le soleil rasant éblouit le plus. L'indice, lui, varie lentement et
 * s'interpole sans artefact ; Open-Meteo interpole d'ailleurs lui-même ainsi.
 *
 * Quand le ciel clair a une moyenne presque nulle — l'heure du lever ou du
 * coucher —, l'indice est un 0/0 : on ne le fabrique pas, on reporte celui de
 * l'heure voisine, d'abord en avant puis en arrière.
 */
function addClearSkyIndex(entries, day, lat, lon) {
  for (const entry of entries) {
    let beamNormal = 0;
    let beamHorizontal = 0;
    let diffuse = 0;
    for (const offset of SUB_STEPS) {
      const clear = clearSkyAt(day, entry.minutes + offset, lat, lon);
      beamNormal += clear.beamNormal / SUB_STEPS.length;
      beamHorizontal += clear.beamHorizontal / SUB_STEPS.length;
      diffuse += clear.diffuse / SUB_STEPS.length;
    }
    // Faute du flux horizontal, le faisceau normal fait l'affaire, un peu moins
    // bien aux heures rasantes.
    const useHorizontal = Number.isFinite(entry.beamHorizontal);
    const reference = useHorizontal ? beamHorizontal : beamNormal;
    const measuredBeam = useHorizontal ? entry.beamHorizontal : entry.beam;
    entry.kb = reference > 1 ? measuredBeam / reference : null;
    entry.kd = diffuse > 1 ? entry.diffuse / diffuse : null;
  }
  for (const key of ['kb', 'kd']) {
    for (let i = 1; i < entries.length; i++) entries[i][key] ??= entries[i - 1][key];
    for (let i = entries.length - 2; i >= 0; i--) entries[i][key] ??= entries[i + 1][key];
    // Jamais de ciel clair de la journée (nuit polaire) : rien à rapporter.
    for (const entry of entries) entry[key] ??= 0;
  }
}

/**
 * L'indice de ciel clair à une minute, interpolé entre des nœuds datés au
 * **milieu** de l'heure qu'ils moyennent, et prolongé au-delà des extrémités.
 */
function clearSkyIndexAt(entries, minutes, key) {
  const node = (entry) => entry.minutes - 30;
  if (minutes <= node(entries[0])) return entries[0][key];
  const last = entries[entries.length - 1];
  if (minutes >= node(last)) return last[key];
  for (let i = 1; i < entries.length; i++) {
    if (node(entries[i]) < minutes) continue;
    const [before, after] = [entries[i - 1], entries[i]];
    const t = (minutes - node(before)) / (node(after) - node(before));
    return before[key] + (after[key] - before[key]) * t;
  }
  return last[key];
}

/**
 * Météo à une minute du jour, à partir des heures qui l'encadrent.
 *
 * La nébulosité, l'UV, la pluie et le point de rosée s'interpolent entre les
 * étiquettes d'heure. Les flux de rayonnement, eux, passent par l'indice de ciel
 * clair — voir `addClearSkyIndex` — et sont reconstruits en watts à la minute.
 */
function interpolate(series, minutes, site) {
  const base = (before, after, t) => ({
    cloud: before.cloud + (after.cloud - before.cloud) * t,
    uv: before.uv + (after.uv - before.uv) * t,
    rain: before.rain + (after.rain - before.rain) * t,
    dewPoint:
      before.dewPoint === null || after.dewPoint === null
        ? null
        : before.dewPoint + (after.dewPoint - before.dewPoint) * t,
    source: 'météo',
  });

  const irradiance = () => {
    if (series[0].beam === null) return null;
    const clear = clearSkyAt(site.day, minutes, site.lat, site.lon);
    return {
      beam: clearSkyIndexAt(series, minutes, 'kb') * clear.beamNormal,
      diffuse: clearSkyIndexAt(series, minutes, 'kd') * clear.diffuse,
    };
  };

  if (minutes <= series[0].minutes) {
    return { ...base(series[0], series[0], 0), irradiance: irradiance() };
  }
  const last = series[series.length - 1];
  if (minutes >= last.minutes) return { ...base(last, last, 0), irradiance: irradiance() };

  for (let i = 1; i < series.length; i++) {
    if (series[i].minutes < minutes) continue;
    const before = series[i - 1];
    const after = series[i];
    const t = (minutes - before.minutes) / (after.minutes - before.minutes);
    return { ...base(before, after, t), irradiance: irradiance() };
  }
  return { ...base(last, last, 0), irradiance: irradiance() };
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
