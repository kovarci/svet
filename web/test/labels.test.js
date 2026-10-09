/**
 * Ce que dit un lecteur d'écran d'un curseur. Sans `aria-valuetext`, il lit la
 * valeur brute : « 510 » pour 8 h 30, « 15 » pour un compromis. Un curseur dont
 * on ne sait pas lire la valeur ne se règle pas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { alphaLabel, spokenClock } from '../src/labels.js';

test("l'heure se dit comme on la dit, pas comme un nombre de minutes", () => {
  assert.equal(spokenClock(510), '8 h 30');
  assert.equal(spokenClock(0), 'minuit');
  assert.equal(spokenClock(720), 'midi');
  assert.equal(spokenClock(605), '10 h 05');
  assert.equal(spokenClock(60), '1 h 00');
});

test("l'heure arrondie ne déborde jamais sur 24 h", () => {
  assert.equal(spokenClock(1439.6), 'minuit');
});

test('le compromis se nomme aux deux bouts et se chiffre entre les deux', () => {
  assert.match(alphaLabel(0), /plus rapide/);
  assert.match(alphaLabel(60), /moins de lumière/);
  const middle = alphaLabel(30);
  assert.doesNotMatch(middle, /plus rapide$/);
  assert.match(middle, /30/);
});

test('un compromis plus élevé ne se lit jamais comme un compromis plus bas', () => {
  const seen = new Set();
  for (let v = 0; v <= 60; v += 10) seen.add(alphaLabel(v));
  assert.equal(seen.size, 7);
});
