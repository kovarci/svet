/**
 * Le profil d'horizon qu'écrit le pipeline.
 *
 * Chaque secteur du profil doit avoir été visé par au moins un rayon. La zone
 * « centre » lançait 24 rayons pour 32 secteurs : les secteurs 3, 7, 11, 15, 19,
 * 23, 27 et 31 ne recevaient rien et restaient à zéro — c'est-à-dire « aucun
 * obstacle, ciel ouvert ». Aucune erreur, aucun avertissement : dans une rue
 * étroite, le facteur de vue du ciel lu dans le profil était surestimé de 76 %
 * en moyenne, et de 130 % dans les rues les plus profondes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, resolveZone } from '../src/config.js';
import { skyViewFactor } from '../src/shadow.js';

/** Une grille jouet : un mur continu de 20 m à 10 m au nord du point d'observation. */
function grid({ wallHeight = 20 } = {}) {
  const size = 81;
  const res = 1;
  const surface = new Float32Array(size * size);
  // Anneau de murs à 10 m tout autour : le profil doit être uniforme.
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const d = Math.hypot(col - 40, row - 40);
      if (d >= 10 && d < 12) surface[row * size + col] = wallHeight;
    }
  }
  return {
    res,
    surface,
    canopyTop: new Float32Array(size * size),
    canopyK: null,
    index(x, y) {
      const col = Math.round(x + 40);
      const row = Math.round(y + 40);
      return col < 0 || row < 0 || col >= size || row >= size ? -1 : row * size + col;
    },
  };
}

test('un profil de 32 secteurs ne s’écrit pas avec 24 rayons', () => {
  assert.throws(
    () => skyViewFactor(grid(), 0, 0, 1.6, 24, 40, 32),
    /secteur/i,
    'une configuration qui laisse des secteurs vides doit être refusée, pas écrite',
  );
});

test('avec un rayon par secteur, chaque secteur reçoit l’élévation du mur', () => {
  const { horizon } = skyViewFactor(grid(), 0, 0, 1.6, 32, 40, 32);
  assert.equal(horizon.length, 32);
  // Mur de 20 m vu de 1,6 m à 10 m : atan((20 − 1,6)/10) ≈ 61,5°, partout.
  for (let s = 0; s < 32; s++) {
    assert.ok(Math.abs(horizon[s] - 61.5) < 3, `secteur ${s} : ${horizon[s].toFixed(1)}°`);
  }
});

test('toutes les zones déclarées lancent assez de rayons pour leurs secteurs', () => {
  // Le garde-fou ne vaut que si la configuration livrée le respecte : la zone
  // « centre » le violait. Toute zone, et tout défaut, doit tenir.
  for (const key of ['centre', 'paris', 'test']) {
    // Les réglages propres à une zone sont rangés sous `overrides`.
    const azimuths = resolveZone(key).overrides.svfAzimuths ?? CONFIG.svfAzimuths;
    assert.ok(
      azimuths >= CONFIG.horizonBins && azimuths % CONFIG.horizonBins === 0,
      `zone ${key} : ${azimuths} rayons pour ${CONFIG.horizonBins} secteurs`,
    );
  }
});
