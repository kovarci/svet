/**
 * Quels jours de prévision une zone peut honorer.
 *
 * La prévision arrive pour le jour prévu ; le soleil et les ombres sont ceux du
 * jour du calcul. Les marier à la même heure n'est honnête que si le soleil y
 * est au même endroit. La panne qu'on fixe ici était muette : une zone du
 * 31 juillet consultée le 9 octobre recevait à 19 h 30 un rayonnement mesuré
 * après le coucher, sous un soleil de juillet encore à 18°, et la carte tombait
 * à zéro sans que rien ne le signale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DRIFT_TOLERANCE, fetchForecast, forecastDays } from '../src/weather.js';

const CENTER = [2.3522, 48.8566];
// Les pas de temps d'une zone : de 5 h à 22 h, tous les quarts d'heure.
const TIMES = Array.from({ length: 69 }, (_, i) => ({ minutes: 300 + 15 * i }));

const days = (zoneDate, today) => forecastDays({ zoneDate, today, times: TIMES, center: CENTER });

test('la tolérance reste sous l’incertitude sur la hauteur des bâtiments', () => {
  // Longueur d'ombre L = H / tan h, donc dL/L = 2·dh / sin 2h. Au midi
  // d'équinoxe (41,1°), un mètre d'incertitude sur un immeuble de vingt : 5 %.
  const h = (41.1 * Math.PI) / 180;
  const error = (2 * ((DRIFT_TOLERANCE * Math.PI) / 180)) / Math.sin(2 * h);
  assert.ok(error < 0.05, `${(error * 100).toFixed(1)} % de longueur d'ombre`);
});

test('une zone de juillet consultée en octobre n’applique aucune prévision', () => {
  const found = days('2026-07-31', '2026-10-09');
  assert.deepEqual(
    found.map((d) => d.date),
    ['2026-10-09', '2026-10-10', '2026-10-11'],
  );
  assert.ok(
    found.every((d) => !d.usable),
    'aucun jour ne doit passer',
  );
  // 19 h 30 : 18° en juillet, couché en octobre. L'écart doit le refléter.
  assert.ok(found[0].drift > 20, `écart de ${found[0].drift.toFixed(1)}°`);
});

test('une zone du jour garde ses trois jours, même à l’équinoxe', () => {
  // L'équinoxe est le pire cas : le soleil y bouge de 0,4° par jour.
  const found = days('2026-09-22', '2026-09-22');
  assert.ok(
    found.every((d) => d.usable),
    found.map((d) => `${d.date} ${d.drift.toFixed(2)}°`).join(', '),
  );
  assert.equal(found[0].drift, 0);
});

test('un rafraîchissement nocturne manqué ne coûte aucun jour', () => {
  // Calculée la veille : la prévision court d'un à trois jours après le calcul.
  const found = days('2026-03-19', '2026-03-20');
  assert.ok(
    found.every((d) => d.usable),
    found.map((d) => `${d.date} ${d.drift.toFixed(2)}°`).join(', '),
  );
});

test('le changement d’heure coupe la prévision, quel que soit le nombre de jours', () => {
  // Nuit du 24 au 25 octobre 2026 : un jour d'écart seulement, mais tout le
  // soleil décalé d'une heure à l'horloge. Un compte de jours l'aurait accepté.
  const found = days('2026-10-24', '2026-10-24');
  assert.deepEqual(
    found.map((d) => d.usable),
    [true, false, false],
  );
  assert.ok(found[1].drift > 8, `écart de ${found[1].drift.toFixed(1)}°`);
});

test('au solstice, une zone de dix jours reste valable', () => {
  // Le soleil y marque une pause : refuser au bout de trois jours serait
  // contredire la mesure, pas la prudence.
  const found = days('2026-06-15', '2026-06-25');
  assert.ok(
    found.every((d) => d.usable),
    found.map((d) => `${d.date} ${d.drift.toFixed(2)}°`).join(', '),
  );
});

test('une zone calculée pour une date à venir part de sa propre date', () => {
  const found = days('2026-08-02', '2026-07-31');
  assert.equal(found[0].date, '2026-08-02');
  assert.equal(found[0].drift, 0);
});

// ──────────────────────────────────────────────────────── la requête ─────

/** Réponse Open-Meteo minimale : quelques heures par jour demandé. */
function openMeteoPayload(dates) {
  const time = dates.flatMap((d) => ['10:00', '11:00', '12:00'].map((h) => `${d}T${h}`));
  const constant = (value) => time.map(() => value);
  return {
    hourly: {
      time,
      cloud_cover: constant(50),
      uv_index: constant(3),
      direct_normal_irradiance: constant(400),
      diffuse_radiation: constant(150),
      precipitation: constant(0),
      dew_point_2m: constant(12),
    },
  };
}

test('aucune requête quand aucun jour n’est retenu', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    throw new Error('ne devrait pas être appelé');
  });
  const result = await fetchForecast({ center: CENTER, dates: [], times: TIMES });
  assert.equal(result, null);
  assert.equal(calls.length, 0, 'la position ne part pas pour rien');
});

test('un jour écarté au milieu de la plage ne revient pas par la bande', async (t) => {
  let requested;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested = new URL(url);
    // Open-Meteo renvoie toute la plage, jour écarté compris.
    return {
      ok: true,
      json: async () => openMeteoPayload(['2026-10-09', '2026-10-10', '2026-10-11']),
    };
  });
  const result = await fetchForecast({
    center: CENTER,
    dates: ['2026-10-09', '2026-10-11'],
    times: TIMES,
  });
  assert.equal(requested.searchParams.get('start_date'), '2026-10-09');
  assert.equal(requested.searchParams.get('end_date'), '2026-10-11');
  assert.deepEqual(result.dates, ['2026-10-09', '2026-10-11']);
  assert.equal(result.series['2026-10-10'], undefined);
  assert.equal(result.series['2026-10-09'].length, TIMES.length);
});
