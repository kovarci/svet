/**
 * La Lune, contre des phases publiées.
 *
 * Les instants viennent des éphémérides usuelles (USNO / IMCCE, UTC) : on ne
 * demande pas la minute, on demande que la phase tombe au bon quart de lunaison
 * à quelques degrés près, et que la hauteur suive le Soleil comme il se doit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { moonPosition, moonIlluminance } from '../src/lib/moon.js';
import { sunPosition, DEG } from '../src/lib/sun.js';

const PARIS = [48.8566, 2.3522];

test('pleine lune du 25 janvier 2024 : phase ≈ 0°, Lune opposée au Soleil', () => {
  const t = new Date('2024-01-25T17:54:00Z');
  const moon = moonPosition(t, ...PARIS);
  // La pleine lune se définit en longitude écliptique ; la latitude de la Lune (jusqu'à
  // 5°) laisse un angle de phase réel de quelques degrés.
  assert.ok(moon.phaseAngle * DEG < 6, `angle de phase ${(moon.phaseAngle * DEG).toFixed(1)}°`);
  assert.ok(moon.fraction > 0.99);
  const sun = sunPosition(t, ...PARIS);
  // Points opposés : hauteurs de signe contraire, à la latitude écliptique près (≤ 5°).
  assert.ok(Math.abs(moon.altitude * DEG + sun.altitude * DEG) < 7);
});

test('nouvelle lune du 11 janvier 2024 : phase ≈ 180°, éclairement quasi nul', () => {
  const t = new Date('2024-01-11T11:57:00Z');
  const moon = moonPosition(t, ...PARIS);
  assert.ok(moon.phaseAngle * DEG > 175, `angle de phase ${(moon.phaseAngle * DEG).toFixed(1)}°`);
  assert.ok(moon.fraction < 0.005);
  assert.equal(moonIlluminance(moon), 0); // sous l'horizon ou face éteinte : jamais négatif
});

test('premier quartier du 18 janvier 2024 : phase ≈ 90°', () => {
  const moon = moonPosition(new Date('2024-01-18T03:53:00Z'), ...PARIS);
  assert.ok(Math.abs(moon.phaseAngle * DEG - 90) < 4);
  assert.ok(Math.abs(moon.fraction - 0.5) < 0.04);
});

test('la distance reste dans la plage orbitale (356 000–407 000 km)', () => {
  for (let d = 0; d < 60; d += 3) {
    const moon = moonPosition(new Date(Date.UTC(2024, 0, 1 + d, 22)), ...PARIS);
    assert.ok(moon.distanceKm > 354000 && moon.distanceKm < 408000, moon.distanceKm);
  }
});

test('pleine lune haute : de l’ordre du quart de lux, pas plus', () => {
  // 2023-12-27 : pleine lune d’hiver, haute dans le ciel de Paris.
  const moon = moonPosition(new Date('2023-12-27T00:33:00Z'), ...PARIS);
  assert.ok(moon.altitude * DEG > 50);
  const lux = moonIlluminance(moon);
  assert.ok(lux > 0.15 && lux < 0.35, `${lux.toFixed(3)} lx`);
});

test('l’éclairement croît avec la hauteur, et décroît avec la phase', () => {
  const base = { altitude: 40 / DEG, phaseAngle: 10 / DEG, distanceKm: 384400 };
  assert.ok(moonIlluminance({ ...base, altitude: 60 / DEG }) > moonIlluminance(base));
  assert.ok(moonIlluminance({ ...base, phaseAngle: 60 / DEG }) < moonIlluminance(base));
  assert.equal(moonIlluminance({ ...base, altitude: -2 / DEG }), 0);
});
