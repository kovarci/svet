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

const ALWAYS_LIVE = ['api.open-meteo.com', 'nominatim.openstreetmap.org', 'data.geopf.fr'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['./', './index.html'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

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

async function cacheFirst(request, cacheName, limit = 0) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const response = await fetch(request);
    // On ne met en cache que les réponses complètes : une réponse partielle
    // (206) ou opaque resservie plus tard donnerait une carte tronquée.
    if (response.ok && response.status === 200) {
      cache.put(request, response.clone());
      if (limit) trim(cache, limit);
    }
    return response;
  } catch (error) {
    const fallback = await cache.match(request, { ignoreSearch: true });
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
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit);
  return hit ?? network;
}

/** Éviction en file : les entrées les plus anciennes partent d'abord. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}
