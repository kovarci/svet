/**
 * Service worker : rendre l'application utilisable sans réseau.
 *
 * Ce n'est pas un raffinement. On s'en sert **en marchant** : couloir de
 * correspondance, rue mal couverte, forfait épuisé, téléphone en économie de
 * données. Un guidage qui s'arrête parce que le réseau tombe ne sert à rien.
 *
 * Trois régimes, selon ce que coûte une donnée périmée :
 *
 *  - **Données de zone** (`/data/…`) : cache d'abord. Elles sont volumineuses,
 *    et ne changent qu'au recalcul du pipeline.
 *  - **Coquille et fond de carte** : cache d'abord, mais rafraîchis en fond.
 *    L'application s'ouvre instantanément, la version suivante sera à jour.
 *  - **Météo, géocodage** : réseau uniquement. Une prévision d'hier serait pire
 *    qu'une absence de prévision — l'application sait retomber sur le ciel
 *    clair, elle ne saurait pas deviner qu'on lui ment.
 */

const VERSION = 'svet-v3';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const TILES = `${VERSION}-tiles`;

/** Au-delà, on oublie les plus anciennes tuiles de fond de carte. */
const MAX_TILES = 1200;

const ALWAYS_LIVE = [
  'api.open-meteo.com',
  'nominatim.openstreetmap.org',
  'api-adresse.data.gouv.fr',
  'data.geopf.fr',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then(async (cache) => {
        await cache.addAll(['./', './index.html']);
        await precache(cache);
      })
      .then(() => self.skipWaiting()),
  );
});

/**
 * Garde tout le code de l'application dès la première visite.
 *
 * La page d'accueil seule ne suffit pas : le script, la feuille de style et le
 * worker de la carte n'entraient au cache qu'à la visite suivante, en passant
 * par le service worker. Préparer un secteur puis partir aussitôt laissait,
 * hors réseau, une coquille vide. La construction publie donc `precache.json`,
 * la liste exacte de ses fichiers ; le serveur de développement n'en a pas, et
 * l'installation s'en passe.
 *
 * Les noms portent une empreinte du contenu : ceux d'une version précédente ne
 * seront plus jamais demandés. On les retire, sans quoi chaque mise en ligne
 * ajouterait un mégaoctet que rien ne supprimerait.
 */
async function precache(cache) {
  let files;
  try {
    const response = await fetch('./precache.json', { cache: 'no-cache' });
    if (!response.ok) return;
    files = await response.json();
  } catch {
    return;
  }
  await Promise.all(files.map((file) => cache.add(file).catch(() => {})));

  const wanted = new Set(files.map((file) => new URL(file, self.location.href).href));
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.includes('/assets/') && !wanted.has(request.url)) {
      await cache.delete(request);
    }
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => (key.startsWith(VERSION) ? keepLatest(key) : caches.delete(key))),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Ne garde, de chaque fichier, que la copie la plus récente.
 *
 * Les versions précédentes de ce service worker gardaient toutes les copies :
 * une par recalcul du pipeline, soit plusieurs mégaoctets par jour et par zone
 * consultée. Changer le nom des caches les aurait purgées d'un coup — avec les
 * secteurs préparés pour le hors-ligne, sans prévenir personne. On trie donc
 * plutôt qu'on ne vide : `keys()` rend les entrées dans l'ordre où elles ont
 * été rangées, la dernière de chaque chemin est la bonne.
 */
async function keepLatest(cacheName) {
  const cache = await caches.open(cacheName);
  const latest = new Map();
  const stale = [];
  for (const request of await cache.keys()) {
    const path = pathOf(request);
    if (latest.has(path)) stale.push(latest.get(path));
    latest.set(path, request);
  }
  await Promise.all(stale.map((request) => cache.delete(request)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (ALWAYS_LIVE.includes(url.hostname)) return; // on laisse passer, sans cache

  // L'index des zones porte l'horodatage des calculs : le servir depuis le
  // cache figerait tout le reste, puisque c'est lui qui version les URLs.
  if (url.origin === self.location.origin && url.pathname.endsWith('zones.json')) {
    event.respondWith(networkFirst(request, DATA));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.includes('/data/')) {
    event.respondWith(cacheFirst(request, DATA));
    return;
  }

  if (url.hostname.endsWith('cartocdn.com') || url.hostname.endsWith('openstreetmap.org')) {
    event.respondWith(cacheFirst(request, TILES, MAX_TILES));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL));
  }
});

/**
 * Pré-chargement d'un secteur, demandé par la page.
 *
 * C'est le service worker qui télécharge, et non la page : lui seul connaît le
 * nom de ses caches — que la page devrait dupliquer, donc désynchroniser à la
 * première montée de version — et il survit au passage de l'onglet en
 * arrière-plan, ce qui arrive à tous les coups quand on lance un
 * téléchargement de soixante mégaoctets et qu'on repose son téléphone.
 *
 * Six requêtes de front : au-delà, on sature le lien sans rien gagner, et sur
 * un réseau mobile on fait surtout monter le taux d'échec. En dessous, un
 * secteur de quatre cellules prend une éternité.
 */
self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type !== 'svet-prefetch') return;
  const port = event.ports[0];
  if (!port) return;
  event.waitUntil(prefetch(message.urls ?? [], port));
});

async function prefetch(urls, port) {
  const cache = await caches.open(DATA);
  let done = 0;
  let failed = 0;

  const worker = async (queue) => {
    for (const url of queue) {
      try {
        // On ne redemande pas ce qui est déjà là : préparer deux fois le même
        // secteur doit être instantané, pas coûter un second téléchargement.
        const hit = await cache.match(url, { ignoreVary: true });
        if (!hit) {
          const response = await fetch(url);
          // Un 404 est une réponse normale ici : la pyramide a de vrais trous,
          // et une tuile absente n'est pas un échec de préparation.
          if (response.ok) await putLatest(cache, url, response.clone());
          else if (response.status !== 404) failed++;
        }
      } catch {
        failed++;
      }
      done++;
      if (done % 10 === 0 || done === urls.length) {
        port.postMessage({ type: 'progress', done, total: urls.length });
      }
    }
  };

  const lanes = Array.from({ length: 6 }, (_, lane) => urls.filter((_, i) => i % 6 === lane));
  try {
    await Promise.all(lanes.map(worker));
    port.postMessage({ type: 'done', done, failed });
  } catch (error) {
    port.postMessage({ type: 'error', error: error.message });
  }
}

async function cacheFirst(request, cacheName, limit = 0) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;

  try {
    const response = await fetch(request);
    // On ne met en cache que les réponses complètes : une réponse partielle
    // (206) ou opaque resservie plus tard donnerait une carte tronquée.
    if (response.ok && response.status === 200) {
      putLatest(cache, request, response.clone()).then(() => limit && trim(cache, limit));
    }
    return response;
  } catch (error) {
    const fallback = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (fallback) return fallback;
    throw error;
  }
}

/**
 * Réseau d'abord, cache en secours : pour ce qui doit rester frais.
 *
 * Le repli ignore la chaîne de requête. L'index des zones est demandé avec un
 * paramètre unique, pour qu'aucun cache ne puisse y répondre ; sans
 * `ignoreSearch`, la copie gardée pour le mode hors ligne ne serait jamais
 * retrouvée.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) putLatest(cache, request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    throw error;
  }
}

/**
 * Cache d'abord, rafraîchi en fond : pour la coquille de l'application.
 *
 * Le repli hors ligne ignore la chaîne de requête. L'adresse de la page porte
 * la zone et l'itinéraire (`?de=…&a=…&nav=1`), et une adresse jamais servie
 * telle quelle n'était trouvée nulle part : un onglet rechargé hors réseau —
 * ce que fait un navigateur mobile avec un onglet mis en veille, en pleine
 * marche — n'affichait plus que la page d'erreur du navigateur. La coquille est
 * la même quels que soient les paramètres ; c'est le script qui les lit.
 */
/*
 * `ignoreVary` partout : un serveur qui répond `Vary: Origin` — c'est le cas du
 * serveur d'aperçu de Vite, et de nombreux hébergements — rend introuvable une
 * réponse gardée sans en-tête `Origin` quand la page la redemande avec, ce que
 * fait tout script chargé en `crossorigin`. Le code préchargé était bien dans
 * le cache, et le service worker ne le trouvait pas. Les fichiers servis ici
 * portent une version ou une empreinte dans leur adresse : deux réponses pour
 * la même adresse sont la même.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) putLatest(cache, request, response.clone());
      return response;
    })
    .catch(
      async () => hit ?? (await cache.match(request, { ignoreSearch: true, ignoreVary: true })),
    );
  return hit ?? network;
}

/**
 * Range une réponse à la place de toutes les autres copies du même fichier.
 *
 * Les données portent leur version dans la requête (`?v=…`, `?t=…`) : chaque
 * recalcul du pipeline produit donc une adresse neuve. Rangées côte à côte,
 * les copies s'accumulaient sans fin, et le repli hors ligne — qui ignore la
 * requête — rendait la **plus ancienne**.
 */
async function putLatest(cache, request, response) {
  const copies = await cache.keys(request, { ignoreSearch: true });
  const url = typeof request === 'string' ? new URL(request, self.location.href).href : request.url;
  await Promise.all(copies.filter((old) => old.url !== url).map((old) => cache.delete(old)));
  await cache.put(request, response);
}

function pathOf(request) {
  const url = new URL(request.url);
  return url.origin + url.pathname;
}

/** Éviction en file : les entrées les plus anciennes partent d'abord. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}
