/**
 * Préparer un secteur pour le hors-ligne.
 *
 * ── Ce qui manquait ────────────────────────────────────────────────────────
 * Le service worker met en cache ce qu'on lui a **déjà demandé**. C'est ce
 * qu'il faut pour qu'une coupure de réseau en pleine marche ne casse rien —
 * mais ça ne permet pas de *préparer* une sortie. Pour être sûr d'avoir un
 * quartier hors ligne, il fallait l'avoir parcouru à l'écran, tuile par tuile,
 * avant de partir. Autant dire que personne ne le faisait.
 *
 * Le mode « Tout chargé » couvrait le cas d'une zone. Il n'existe pas en
 * région — c'est précisément ce qu'on ne peut pas faire à cette taille — et
 * c'est pourtant là que le besoin est le plus fort : hors de Paris, le réseau
 * mobile est moins bon, et les cellules pèsent seize mégaoctets.
 *
 * ── Qui télécharge ─────────────────────────────────────────────────────────
 * Le service worker, et non la page. Deux raisons : il est le seul à connaître
 * le nom de ses caches — les dupliquer ici ferait qu'un changement de version
 * remplirait silencieusement un cache que plus personne ne lit — et il continue
 * son travail si l'onglet passe en arrière-plan.
 *
 * ── Ce qui reste ici ───────────────────────────────────────────────────────
 * Le calcul de ce qu'il faut : quelles tuiles couvrent l'écran, quelles
 * cellules le recoupent, et combien tout cela pèse. Ce sont des fonctions
 * pures, éprouvables sans navigateur.
 */

/**
 * Taille moyenne d'une tuile vectorielle, mesurée sur la pyramide
 * d'Île-de-France : 4,0 ko au zoom 15, 0,9 ko au zoom 16. On retient la valeur
 * haute — mieux vaut annoncer un peu trop que promettre trop peu.
 */
const TILE_BYTES = 4000;

/**
 * Octets par tronçon dans un binaire de cellule.
 *
 * C'est le chiffre dont `pipeline/build-region.mjs` se sert pour annoncer le
 * poids d'une région ; le reprendre ici garde les deux estimations d'accord.
 */
const SEGMENT_BYTES = 192;

/** Au-delà, on refuse : ce n'est plus un secteur, c'est la région. */
export const MAX_PREFETCH_TILES = 4000;

/**
 * Tuiles couvrant une emprise, du zoom le plus large au plus fin.
 *
 * @param {{west:number,south:number,east:number,north:number}} bounds
 * @param {{minZoom:number, maxZoom:number}} range
 * @returns {{z:number,x:number,y:number}[]}
 */
export function tilesInBounds(bounds, { minZoom, maxZoom }) {
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const scale = 2 ** z;
    const x0 = Math.floor(lonToX(bounds.west) * scale);
    const x1 = Math.floor(lonToX(bounds.east) * scale);
    // L'axe des tuiles descend vers le sud : le nord donne le plus petit rang.
    const y0 = Math.floor(latToY(bounds.north) * scale);
    const y1 = Math.floor(latToY(bounds.south) * scale);
    for (let x = Math.max(0, x0); x <= Math.min(scale - 1, x1); x++) {
      for (let y = Math.max(0, y0); y <= Math.min(scale - 1, y1); y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

function lonToX(lon) {
  return (lon + 180) / 360;
}

function latToY(lat) {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const radians = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

/**
 * Ce qu'il faut télécharger pour tenir hors ligne sur une emprise.
 *
 * @param {object} plan
 * @param {string} plan.tileUrl gabarit `{z}/{x}/{y}`, version comprise
 * @param {{z,x,y}[]} plan.tiles
 * @param {{url:string, bytes:number}[]} [plan.data] binaires de zone ou de cellules
 * @returns {{urls: string[], tiles: number, bytes: number}}
 */
export function buildPlan({ tileUrl, tiles, data = [] }) {
  const urls = [
    ...data.map((entry) => entry.url),
    ...tiles.map((tile) =>
      tileUrl.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y),
    ),
  ];
  const bytes = data.reduce((sum, entry) => sum + entry.bytes, 0) + tiles.length * TILE_BYTES;
  return { urls, tiles: tiles.length, bytes };
}

/** Poids estimé d'une cellule régionale, d'après son nombre de tronçons. */
export function cellBytes(cell) {
  return (cell.segments ?? 0) * SEGMENT_BYTES;
}

/** « 66 Mo », « 940 ko » — un ordre de grandeur, pas une comptabilité. */
export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} Go`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} Mo`;
  return `${Math.round(bytes / 1e3)} ko`;
}

/**
 * Confie la liste au service worker et suit son avancement.
 *
 * Sans service worker actif — contexte non sécurisé, premier chargement, refus
 * du navigateur — il n'y a pas de mode hors ligne du tout : remplir un cache
 * que personne ne relira serait pire qu'inutile, on le dit et on s'arrête.
 *
 * @param {string[]} urls
 * @param {(done: number, total: number) => void} onProgress
 * @returns {Promise<{done:number, failed:number}>}
 */
export function prefetch(urls, onProgress) {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) {
    return Promise.reject(
      new Error('Le mode hors ligne n’est pas actif (il demande une connexion sécurisée).'),
    );
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.done, message.total);
        return;
      }
      channel.port1.close();
      if (message.type === 'done') resolve({ done: message.done, failed: message.failed });
      else reject(new Error(message.error ?? 'Téléchargement interrompu.'));
    };
    worker.postMessage({ type: 'svet-prefetch', urls }, [channel.port2]);
  });
}
