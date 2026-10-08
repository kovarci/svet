/**
 * Le stockage local du profil de sensibilité.
 *
 * C'est une donnée de santé : elle doit survivre à un rechargement, s'effacer en
 * un geste, et — surtout — ne jamais faire échouer le démarrage quand le
 * stockage est refusé (navigation privée Safari, cookies bloqués).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { profileStore } from '../src/prefs.js';

function withStorage(storage, run) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    return run();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

const memory = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    keys: () => [...map.keys()],
  };
};

test('le profil fait l’aller-retour, et s’efface en un geste', () => {
  const storage = memory();
  withStorage(storage, () => {
    assert.deepEqual(profileStore.read(), {});
    assert.equal(profileStore.write({ presets: ['migraine'] }), true);
    assert.deepEqual(profileStore.read(), { presets: ['migraine'] });
    assert.equal(profileStore.clear(), true);
    assert.deepEqual(profileStore.read(), {});
    assert.deepEqual(storage.keys(), []);
  });
});

test('il vit dans sa propre clé, hors des réglages d’affichage', () => {
  const storage = memory();
  withStorage(storage, () => {
    profileStore.write({ presets: ['cones'] });
    assert.deepEqual(storage.keys(), ['svet.profile']);
  });
});

test('un stockage refusé ne lève jamais : le profil est neutre et l’écriture le dit', () => {
  const refusing = {
    getItem() {
      throw new DOMException('refusé', 'SecurityError');
    },
    setItem() {
      throw new DOMException('quota', 'QuotaExceededError');
    },
    removeItem() {
      throw new DOMException('refusé', 'SecurityError');
    },
  };
  withStorage(refusing, () => {
    assert.deepEqual(profileStore.read(), {});
    assert.equal(profileStore.write({ presets: ['migraine'] }), false);
    assert.equal(profileStore.clear(), false);
  });
});

test('un contenu qui n’est pas un objet est écarté', () => {
  for (const raw of ['not json', '42', '"texte"', '[1,2]', 'null']) {
    const storage = { getItem: () => raw, setItem() {}, removeItem() {} };
    withStorage(storage, () => assert.deepEqual(profileStore.read(), {}, raw));
  }
});
