/**
 * Un chiffre de l'indice qu'on peut lire.
 *
 * L'indice s'écrivait dans la couleur de l'échelle. Or le bas de l'échelle —
 * « abrité », c'est-à-dire précisément les bons trajets — est un bleu nuit
 * posé sur un fond nuit : 1,25:1 de contraste, autant dire invisible. Le
 * meilleur résultat qu'on puisse annoncer était celui qu'on ne voyait pas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SCALE } from '../../pipeline/src/model.js';
import { contrastRatio, legibleOn } from '../src/contrast.js';

/** Fond des panneaux (`--surface` de la feuille de style). */
const SURFACE = '#131924';

test('le contraste se calcule comme le définit le WCAG', () => {
  assert.equal(contrastRatio('#ffffff', '#000000').toFixed(1), '21.0');
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
  assert.equal(contrastRatio('#000000', '#000000'), 1);
});

test('chaque couleur de l’échelle devient lisible sur un panneau', () => {
  // Le défaut, tel qu'il était.
  assert.ok(contrastRatio(SCALE[0].color, SURFACE) < 1.5);

  for (const { color, label } of SCALE) {
    const text = legibleOn(color, SURFACE);
    assert.ok(contrastRatio(text, SURFACE) >= 4.5, `${label} : ${text} reste illisible`);
  }
});

test('une couleur déjà lisible n’est pas touchée, une autre garde sa teinte', () => {
  // Le jaune « plein soleil » passe tel quel : l'éclaircir ne servirait à rien.
  assert.equal(legibleOn('#f7e463', SURFACE), '#f7e463');

  // Le bleu « abrité » s'éclaircit, mais reste un bleu : la couleur porte
  // encore la catégorie.
  const text = legibleOn('#1a2b4a', SURFACE);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));
  assert.ok(b > g && g > r, `${text} n’est plus un bleu`);
});
