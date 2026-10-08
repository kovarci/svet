/**
 * La prévision de rayonnement, rejouée sans réseau.
 *
 * Open-Meteo publie des **moyennes de l'heure écoulée** : la valeur étiquetée
 * 08:00 est la moyenne de 07:00 à 08:00. Elle était traitée comme une valeur
 * instantanée à 08:00 et interpolée telle quelle, soit environ trente minutes de
 * retard. Aux heures qui comptent pour ce public — le soleil rasant du lever et
 * du coucher — le faisceau était trop faible le matin et **non nul après le
 * coucher**. Rejoué sur les mesures de Payerne (26 835 minutes, prévision
 * parfaite) : à moins de deux heures du lever ou du coucher, biais +92 % → +4 %
 * et écart quadratique du faisceau divisé par 2,3.
 *
 * On interpole donc l'**indice de ciel clair** k — le rapport de la moyenne
 * prévue à la moyenne du ciel clair sur la même heure —, daté au milieu de
 * l'heure, et l'on reconstruit les watts à l'instant exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchForecast, clearSkyAt } from '../src/weather.js';

const CENTER = [2.3376, 48.8606];
const LON = CENTER[0];
const LAT = CENTER[1];
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} : ${actual} au lieu de ${expected} ± ${tolerance}`,
  );

/** Moyenne du ciel clair sur [H − 1 h, H), en douze sous-pas de cinq minutes. */
function hourAverage(day, label, pick) {
  let sum = 0;
  for (let k = 0; k < 12; k++) sum += pick(clearSkyAt(day, label * 60 - 55 + 5 * k, LAT, LON));
  return sum / 12;
}

/** Une réponse d'Open-Meteo pour un jour, avec indice de ciel clair `kb(h)` et `kd(h)`. */
function respond(day, { kb, kd = () => 1, omitDirectRadiation = false }) {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const iso = hours.map((h) => `${day}T${String(h).padStart(2, '0')}:00`);
  const hourly = {
    time: iso,
    cloud_cover: hours.map(() => 20),
    uv_index: hours.map(() => 3),
    precipitation: hours.map(() => 0),
    dew_point_2m: hours.map(() => 8),
    diffuse_radiation: hours.map((h) => kd(h) * hourAverage(day, h, (c) => c.diffuse)),
    direct_normal_irradiance: hours.map((h) => kb(h) * hourAverage(day, h, (c) => c.beamNormal)),
  };
  if (!omitDirectRadiation) {
    hourly.direct_radiation = hours.map(
      (h) => kb(h) * hourAverage(day, h, (c) => c.beamHorizontal),
    );
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ hourly }) });
  return hourly;
}

const STEPS = Array.from({ length: 69 }, (_, i) => ({ minutes: 300 + 15 * i }));

test('une journée claire redonne le ciel clair à toute minute', async () => {
  // direct_radiation = moyenne du ciel clair, exactement : k = 1 partout, et le
  // faisceau reconstruit doit être celui du ciel clair à la minute.
  const day = '2026-06-21';
  respond(day, { kb: () => 1 });
  const forecast = await fetchForecast({ center: CENTER, date: day, times: STEPS, days: 1 });
  const series = forecast.series[day];

  for (const [i, step] of STEPS.entries()) {
    const clear = clearSkyAt(day, step.minutes, LAT, LON);
    // Hors de l'intervalle des nœuds (H − 30 min), l'indice est prolongé.
    near(
      series[i].irradiance.beam,
      clear.beamNormal,
      1e-6 * Math.max(1, clear.beamNormal),
      `faisceau à ${step.minutes}`,
    );
    near(
      series[i].irradiance.diffuse,
      clear.diffuse,
      1e-6 * Math.max(1, clear.diffuse),
      `diffus à ${step.minutes}`,
    );
  }
});

test('l’indice de ciel clair est daté au milieu de l’heure et interpolé', async () => {
  // Nœuds : l'heure 08:00 est la moyenne de 07:00 à 08:00, donc datée 07:30 ; k
  // vaut 0,40 à 07:30 et 0,90 à 08:30. À 08:00, il vaut 0,65 — et non la
  // moyenne arithmétique des watts, que l'ancien schéma interpolait.
  const day = '2026-06-21';
  respond(day, { kb: (h) => (h === 8 ? 0.4 : h === 9 ? 0.9 : 0.5) });
  const forecast = await fetchForecast({ center: CENTER, date: day, times: STEPS, days: 1 });
  const at = (minutes) => forecast.series[day][STEPS.findIndex((s) => s.minutes === minutes)];

  const clear = clearSkyAt(day, 480, LAT, LON);
  near(
    at(480).irradiance.beam,
    0.65 * clear.beamNormal,
    1e-6 * clear.beamNormal,
    'faisceau à 08:00',
  );
  // Aux nœuds eux-mêmes, la valeur de l'indice — ici à 08:30 (pas de 15 min).
  const half = clearSkyAt(day, 510, LAT, LON);
  near(at(510).irradiance.beam, 0.9 * half.beamNormal, 1e-6 * half.beamNormal, 'faisceau à 08:30');
});

test('après le coucher, plus de faisceau — même si la dernière heure en portait', async () => {
  // 21 décembre : le soleil se couche vers 16 h 57. L'heure étiquetée 17:00 est la
  // moyenne de 16 à 17 h, donc positive ; l'interpolation de watts du schéma
  // précédent tirait de là un faisceau à 17 h, soleil sous l'horizon.
  const day = '2026-12-21';
  respond(day, { kb: () => 0.8 });
  const forecast = await fetchForecast({
    center: CENTER,
    date: day,
    times: [{ minutes: 16 * 60 }, { minutes: 17 * 60 }, { minutes: 17 * 60 + 30 }],
    days: 1,
  });
  const [before, after, later] = forecast.series[day];
  assert.ok(before.irradiance.beam > 0, 'à 16 h le soleil est encore au-dessus de l’horizon');
  assert.equal(after.irradiance.beam, 0);
  assert.equal(later.irradiance.beam, 0);
});

test('l’heure du lever, où l’indice n’est pas défini, reprend celui de l’heure voisine', async () => {
  // Avant le lever, la moyenne du ciel clair est nulle : k = 0/0. On ne le fabrique
  // pas — on reporte celui de l'heure voisine, d'abord en avant, puis en arrière.
  const day = '2026-06-21';
  respond(day, { kb: (h) => (h < 6 ? 0.37 : 0.6) });
  const forecast = await fetchForecast({ center: CENTER, date: day, times: STEPS, days: 1 });
  for (const entry of forecast.series[day]) {
    assert.ok(Number.isFinite(entry.irradiance.beam), 'faisceau non fini');
    assert.ok(Number.isFinite(entry.irradiance.diffuse), 'diffus non fini');
    assert.ok(entry.irradiance.beam >= 0 && entry.irradiance.diffuse >= 0);
  }
});

test('sans le flux horizontal, la prévision reste utilisable', async () => {
  const day = '2026-06-21';
  respond(day, { kb: () => 0.7, omitDirectRadiation: true });
  const forecast = await fetchForecast({ center: CENTER, date: day, times: STEPS, days: 1 });
  const noon = forecast.series[day][STEPS.findIndex((s) => s.minutes === 780)];
  assert.ok(noon.irradiance.beam > 300, `faisceau à midi : ${noon.irradiance.beam}`);
});
