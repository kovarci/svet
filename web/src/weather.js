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
    hourly:
      'cloud_cover,uv_index,direct_normal_irradiance,diffuse_radiation,precipitation',
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
  const diffuse = data?.hourly?.diffuse_radiation;
  const rain = data?.hourly?.precipitation;
  if (!hours?.length || !clouds?.length) return null;

  // Open-Meteo ne couvre qu'une fenêtre autour d'aujourd'hui. Hors de cette
  // fenêtre il renvoie des valeurs vides plutôt qu'une erreur.
  if (clouds.every((value) => value === null)) return null;

  const measured = beam?.some((value) => value !== null) && diffuse?.some((value) => value !== null);

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
    });
  });

  const dates = [...byDate.keys()].sort();
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
      irradiance: before.beam === null ? null : { beam: mix('beam'), diffuse: mix('diffuse') },
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
    irradiance: entry.beam === null ? null : { beam: entry.beam, diffuse: entry.diffuse },
    rain: entry.rain ?? 0,
    source: 'météo',
  };
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
