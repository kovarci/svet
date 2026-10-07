/**
 * Le service worker, rejoué sans navigateur.
 *
 * Le mode hors ligne ne sert qu'au moment où le réseau manque — dans un
 * couloir de métro, forfait épuisé — c'est-à-dire précisément quand on ne peut
 * plus rien corriger. Un défaut ici ne se voit pas en développement : la page
 * s'ouvre, le réseau répond, tout va bien.
 *
 * On charge le vrai `public/sw.js` dans un bac à sable, avec un stockage de
 * cache en mémoire et un `fetch` qu'on coupe à volonté.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'http://localhost';
const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const SHELL_HTML = '<!doctype html><div id="map"></div>';

/** Un `Cache` réduit à ce que le service worker utilise. */
class MemoryCache {
  entries = [];

  /** @param {(request: string) => Promise<Response>} [fetcher] pour `addAll` */
  constructor(fetcher) {
    this.fetcher = fetcher;
  }

  static key(request) {
    return new URL(typeof request === 'string' ? request : request.url, ORIGIN);
  }

  find(request, { ignoreSearch = false } = {}) {
    const wanted = MemoryCache.key(request);
    return this.entries.filter(({ url }) =>
      ignoreSearch
        ? url.origin === wanted.origin && url.pathname === wanted.pathname
        : url.href === wanted.href,
    );
  }

  async match(request, options) {
    return this.find(request, options)[0]?.response.clone();
  }

  async addAll(requests) {
    for (const request of requests) {
      await this.put(request, await this.fetcher(MemoryCache.key(request).href));
    }
  }

  async put(request, response) {
    const url = MemoryCache.key(request);
    this.entries = this.entries.filter((entry) => entry.url.href !== url.href);
    this.entries.push({ url, response: response.clone() });
  }

  async keys(request, options) {
    const found = request ? this.find(request, options) : this.entries;
    return found.map(({ url }) => new Request(url.href));
  }

  async delete(request) {
    const before = this.entries.length;
    const url = MemoryCache.key(request);
    this.entries = this.entries.filter((entry) => entry.url.href !== url.href);
    return this.entries.length < before;
  }

  paths() {
    return this.entries.map(({ url }) => url.pathname + url.search);
  }
}

/** Le service worker chargé, avec ses caches et un réseau qu'on coupe. */
function boot() {
  const stores = new Map();
  const network = {
    online: true,
    files: new Map([
      ['/', SHELL_HTML],
      ['/index.html', SHELL_HTML],
    ]),
  };
  const handlers = {};

  const sandbox = {
    self: {
      location: new URL(`${ORIGIN}/sw.js`),
      addEventListener: (type, handler) => (handlers[type] = handler),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new MemoryCache(sandbox.fetch));
        return stores.get(name);
      },
      async keys() {
        return [...stores.keys()];
      },
      async delete(name) {
        return stores.delete(name);
      },
    },
    async fetch(request) {
      if (!network.online) throw new TypeError('Failed to fetch');
      const url = MemoryCache.key(request);
      const body = network.files.get(url.pathname);
      return body === undefined
        ? new Response('absent', { status: 404 })
        : new Response(body, { status: 200 });
    },
    URL,
    Request,
    Response,
    Promise,
    console,
  };
  vm.runInNewContext(SOURCE, sandbox);

  const dispatch = async (type, extra = {}) => {
    let pending = Promise.resolve();
    let answer = null;
    const event = {
      ...extra,
      waitUntil: (promise) => (pending = promise),
      respondWith: (promise) => (answer = { promise }),
    };
    handlers[type](event);
    await pending;
    return answer;
  };

  const request = async (path) => {
    const answer = await dispatch('fetch', { request: new Request(`${ORIGIN}${path}`) });
    // Sans `respondWith`, la requête part au réseau comme si de rien n'était.
    // Avec, une réponse vide vaut une erreur réseau : c'est ce que fait le
    // navigateur, qui affiche alors sa page d'erreur.
    if (!answer) return sandbox.fetch(`${ORIGIN}${path}`);
    const response = (await answer.promise) ?? Response.error();
    // La mise en cache se fait en fond, après la réponse : on la laisse finir.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return response;
  };

  const cache = (suffix) =>
    [...stores.entries()].find(([name]) => name.endsWith(`-${suffix}`))?.[1] ?? new MemoryCache();

  return { dispatch, request, network, cache, stores };
}

test('hors ligne, une adresse avec paramètres ouvre quand même l’application', async () => {
  // C'est le cas que l'application défend ailleurs : le navigateur mobile
  // recharge l'onglet mis en veille, en pleine marche. L'adresse porte alors
  // l'itinéraire — et si le réseau manque à ce moment-là, la page ne s'ouvrait
  // plus du tout.
  const sw = boot();
  await sw.dispatch('install');
  await sw.dispatch('activate');
  sw.network.online = false;

  for (const path of ['/', '/?zone=marais', '/?de=2.35,48.85|A&a=2.36,48.86|B&p=30&nav=1']) {
    const response = await sw.request(path);
    assert.ok(response?.ok, `${path} ne s’ouvre pas hors ligne`);
    assert.equal(await response.text(), SHELL_HTML);
  }
});

test('une nouvelle version d’un fichier de données remplace l’ancienne', async () => {
  // Chaque recalcul change le paramètre de version. Sans remplacement, chaque
  // rafraîchissement quotidien ajoutait une copie de plusieurs mégaoctets que
  // rien ne supprimait jamais.
  const sw = boot();
  await sw.dispatch('activate');
  sw.network.files.set('/data/marais.data.bin', 'version A');
  await sw.request('/data/marais.data.bin?v=A');
  sw.network.files.set('/data/marais.data.bin', 'version B');
  await sw.request('/data/marais.data.bin?v=B');

  assert.deepEqual(sw.cache('data').paths(), ['/data/marais.data.bin?v=B']);
});

test('hors ligne, c’est la dernière version connue qui sert', async () => {
  const sw = boot();
  await sw.dispatch('activate');
  for (const version of ['A', 'B']) {
    sw.network.files.set('/data/marais.data.bin', `version ${version}`);
    await sw.request(`/data/marais.data.bin?v=${version}`);
    sw.network.files.set('/data/zones.json', `index ${version}`);
    await sw.request(`/data/zones.json?t=${version}`);
  }

  sw.network.online = false;
  assert.equal(await (await sw.request('/data/marais.data.bin?v=C')).text(), 'version B');
  assert.equal(await (await sw.request('/data/zones.json?t=C')).text(), 'index B');
  assert.deepEqual(sw.cache('data').paths(), ['/data/marais.data.bin?v=B', '/data/zones.json?t=B']);
});

test('l’activation fait le ménage des copies laissées par les versions précédentes', async () => {
  // Les installations existantes ont déjà accumulé des copies. Les supprimer
  // en bloc — en changeant le nom des caches — effacerait aussi les secteurs
  // préparés pour le hors-ligne, sans prévenir. On ne garde que la plus
  // récente de chaque fichier.
  const sw = boot();
  const name = [...SOURCE.matchAll(/const VERSION = '([^']+)'/g)][0][1];
  const store = new MemoryCache();
  sw.stores.set(`${name}-data`, store);
  for (const [path, body] of [
    ['/data/zones.json?t=1', 'index 1'],
    ['/data/marais.data.bin?v=A', 'A'],
    ['/data/zones.json?t=2', 'index 2'],
    ['/data/marais.data.bin?v=B', 'B'],
    ['/data/marais/16/1/2.pbf?v=A', 'tuile'],
  ]) {
    await store.put(`${ORIGIN}${path}`, new Response(body));
  }

  await sw.dispatch('activate');
  assert.deepEqual(store.paths(), [
    '/data/zones.json?t=2',
    '/data/marais.data.bin?v=B',
    '/data/marais/16/1/2.pbf?v=A',
  ]);
});
