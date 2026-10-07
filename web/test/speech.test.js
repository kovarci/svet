/**
 * Le guidage écouté, téléphone en poche.
 *
 * C'est le mode d'usage que l'application défend — ne pas fixer un écran en
 * plein soleil — et c'est aussi celui où un défaut passe le plus longtemps
 * inaperçu : une annonce qui ne vient pas ne fait aucun bruit. On marche, on
 * attend le « tournez à droite », et l'on découvre le virage manqué cinquante
 * mètres plus loin.
 *
 * La synthèse vocale et la vibration sont remplacées par des enregistreurs :
 * on rejoue une approche mètre par mètre et l'on compte ce qui a été dit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeManoeuvre } from '../src/navigation.js';
import { createVoice, phraseFor } from '../src/speech.js';

/** Une voix branchée sur des enregistreurs plutôt que sur le haut-parleur. */
function recordingVoice() {
  const said = [];
  const vibrations = [];
  let cancels = 0;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [],
      addEventListener() {},
      cancel: () => cancels++,
      speak: (utterance) => said.push({ text: utterance.text, afterCancel: cancels }),
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { vibrate: (pattern) => vibrations.push(pattern) },
    configurable: true,
  });
  return { voice: createVoice(), said, vibrations };
}

const turn = { index: 3, type: 'left', name: 'Rue Vieille du Temple', side: 'nord' };

/** Approche du virage, mètre par mètre, comme un GPS qui se rafraîchit. */
function approach(voice, from, to = 0) {
  for (let remaining = from; remaining >= to; remaining--) {
    voice.announce(turn, remaining, phraseFor(turn, remaining));
  }
}

test('chaque palier se dit une fois, du plus loin au plus près', () => {
  const { voice, said, vibrations } = recordingVoice();
  approach(voice, 250);

  assert.deepEqual(
    said.map((s) => s.text),
    [
      'Dans 200 mètres, tournez à gauche, Rue Vieille du Temple, trottoir nord.',
      'Dans 60 mètres, tournez à gauche, Rue Vieille du Temple, trottoir nord.',
      'Tournez à gauche, Rue Vieille du Temple, trottoir nord.',
    ],
  );
  // La dernière annonce coupe ce qui serait encore en train d'être dit, et
  // vibre deux fois : c'est maintenant qu'il faut tourner.
  assert.equal(said[2].afterCancel, 1);
  assert.deepEqual(vibrations, [60, 60, [90, 60, 90]]);
});

test('arriver directement près du virage donne l’annonce du virage, pas celle de loin', () => {
  // Première position reçue à quinze mètres : sortie d'un métro, GPS qui
  // s'accroche tard. Les paliers lointains sont dépassés, il ne reste qu'à
  // dire de tourner.
  const { voice, said, vibrations } = recordingVoice();
  approach(voice, 15);

  assert.deepEqual(
    said.map((s) => s.text),
    ['Tournez à gauche, Rue Vieille du Temple, trottoir nord.'],
  );
  assert.deepEqual(vibrations, [[90, 60, 90]]);
});

test('la phrase ne dépend que de l’instruction', () => {
  // Le libellé parlé se recompose à partir de l'instruction : demander à
  // l'appelant de le fournir, c'est lui laisser l'occasion d'en oublier une
  // partie — et la phrase devient « undefined », ou lève une exception qui
  // interrompt tout le guidage.
  assert.equal(
    phraseFor({ type: 'crossing', name: 'Rue de Rivoli', side: null }, 45),
    'Dans 50 mètres, traversez vers Rue de Rivoli.',
  );
  assert.equal(
    phraseFor({ type: 'straight', name: null, side: null }, 120),
    'Dans 100 mètres, continuez.',
  );
  assert.equal(phraseFor({ type: 'depart', name: 'Rue X', side: 'sud' }, 0), 'Départ.');
  assert.equal(phraseFor({ type: 'arrive', name: null, side: null }, 3), 'Vous êtes arrivé.');

  for (const type of ['straight', 'slight_left', 'right', 'sharp_right', 'crossing']) {
    for (const remaining of [5, 40, 400, 1500]) {
      const phrase = phraseFor({ type, name: 'Rue X', side: 'est' }, remaining);
      assert.doesNotMatch(phrase, /undefined|null/);
      assert.ok(phrase.includes(describeManoeuvre({ type }).label.slice(1)));
    }
  }
});
