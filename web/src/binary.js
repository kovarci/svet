import { CARDINALS, HIGHWAYS } from '@svet/pipeline/model';

/**
 * Lecture du fichier binaire d'une zone.
 *
 * Le format est décrit dans `pipeline/src/pack.js`. Trois choses y voyagent :
 * les attributs de chaque tronçon, ses séries horaires, et le graphe
 * d'itinéraire.
 *
 * Aucune analyse syntaxique : on pose des vues typées sur le tampon reçu. Un
 * fichier de dix mégaoctets est exploitable dès l'octet reçu, là où le même
 * volume en JSON demandait une seconde de `JSON.parse` et trois fois plus de
 * mémoire une fois développé en objets.
 *
 * Les séries restent des `Uint8Array` — on ne les convertit jamais en tableaux
 * d'objets. Sur Paris entier, cela ferait quarante millions d'objets.
 */

const MAGIC = 0x54455653; // « SVET »
const HEADER_BYTES = 32;

/** Doit suivre `SEGMENT_PREFIX` dans `pipeline/src/pack.js`. */
const SEGMENT_PREFIX = 22;

/** Format lisible par ce décodeur. Voir `FORMAT_VERSION` dans `pack.js`. */
const SUPPORTED_FORMAT = 4;

/**
 * @param {(received: number, total: number) => void} [onProgress] appelé à
 *   chaque tranche reçue. `total` vaut 0 quand la réponse n'annonce pas sa
 *   taille — réponse compressée à la volée, ou servie par le service worker.
 *
 * On lit le corps en flux uniquement pour pouvoir rendre compte de
 * l'avancement : Paris pèse 34 Mo, et une barre figée pendant une minute de
 * réseau mobile ne se distingue pas d'une panne. Sans observateur, ou sans
 * corps lisible en flux, on revient au bloc unique — l'attente est simplement
 * muette, comme avant.
 */
export async function loadZoneData(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} introuvable (HTTP ${response.status}).`);
  ensureNotFallbackPage(response, url);
  if (!onProgress || !response.body?.getReader) {
    return decodeZoneData(await response.arrayBuffer());
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  // Recollage en un tampon d'un seul tenant : tout le décodage pose des vues
  // typées dessus, et une vue ne peut pas enjamber deux tampons.
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return decodeZoneData(bytes.buffer);
}

/**
 * Refuse la page d'accueil servie à la place d'un fichier absent.
 *
 * Un hébergeur de page unique — le serveur de développement, Netlify, Vercel —
 * répond `index.html` avec un code 200 pour tout chemin inconnu. Le décodeur de
 * tuiles vectorielles s'en méfiait déjà ; les deux autres chargements, eux,
 * échouaient sur « Unexpected token '<' » ou sur « signature inattendue » —
 * deux messages qui parlent de format là où il manque simplement un fichier.
 *
 * Le test porte sur le HTML reçu plutôt que sur le type attendu : un serveur
 * qui annonce nos `.json` en `text/plain` reste parfaitement lisible.
 */
export function ensureNotFallbackPage(response, url) {
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`${url} introuvable : le serveur a répondu la page d’accueil.`);
  }
}

export function decodeZoneData(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error('Fichier de zone illisible : signature inattendue.');
  }
  // Un décalage d'un seul octet dans l'en-tête de tronçon décalerait toutes les
  // séries sans rien casser visiblement : mieux vaut refuser net que d'afficher
  // des couleurs plausibles et fausses.
  const format = view.getUint8(4);
  if (format !== SUPPORTED_FORMAT) {
    throw new Error(
      `Format de zone ${format}, attendu ${SUPPORTED_FORMAT} — relancez « npm run data:refresh ».`,
    );
  }

  const timeSteps = view.getUint8(5);
  const horizonBins = view.getUint8(6);
  const segmentCount = view.getUint32(8, true);
  const nodeCount = view.getUint32(12, true);
  const edgeCount = view.getUint32(16, true);
  const nameCount = view.getUint32(20, true);
  const namesOffset = view.getUint32(24, true);

  const twoSidedCount = view.getUint32(28, true);
  const sideBytes = 2 * timeSteps + horizonBins;
  const stride = SEGMENT_PREFIX + sideBytes;
  const bytes = new Uint8Array(arrayBuffer);

  // Table des noms de rue, lue une fois.
  const names = new Array(nameCount);
  const decoder = new TextDecoder();
  let at = namesOffset;
  for (let i = 0; i < nameCount; i++) {
    const length = view.getUint16(at, true);
    names[i] = decoder.decode(bytes.subarray(at + 2, at + 2 + length));
    at += 2 + length;
  }

  const segmentsAt = HEADER_BYTES;
  // Bloc annexe : identifiants des tronçons à deux trottoirs, puis leur côté
  // droit. 92 % des tronçons n'en ont qu'un — y écrire deux fois la même série
  // coûtait un tiers du fichier.
  const twoSidedIdsAt = segmentsAt + segmentCount * stride;
  const rightSidesAt = twoSidedIdsAt + twoSidedCount * 4;
  const nodesAt = rightSidesAt + twoSidedCount * sideBytes;
  const edgesAt = nodesAt + nodeCount * 8;

  /**
   * Rang d'un tronçon dans le bloc annexe, ou −1 s'il n'a qu'un côté.
   *
   * Dichotomie sur la liste triée plutôt qu'une table de correspondance : on
   * évite de matérialiser 18 000 entrées en mémoire pour une recherche qui
   * coûte quinze comparaisons.
   */
  const rightRank = (id) => {
    let low = 0;
    let high = twoSidedCount - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = view.getUint32(twoSidedIdsAt + mid * 4, true);
      if (value === id) return mid;
      if (value < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  };

  // Les coordonnées des nœuds peuvent être désalignées dans le tampon ; on les
  // recopie plutôt que de risquer une vue invalide.
  const nodeLon = new Float64Array(nodeCount);
  const nodeLat = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodeLon[i] = view.getFloat32(nodesAt + i * 8, true);
    nodeLat[i] = view.getFloat32(nodesAt + i * 8 + 4, true);
  }

  const edgeA = new Uint32Array(edgeCount);
  const edgeB = new Uint32Array(edgeCount);
  const edgeSegment = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const base = edgesAt + i * 16;
    edgeA[i] = view.getUint32(base, true);
    edgeB[i] = view.getUint32(base + 4, true);
    edgeSegment[i] = view.getUint32(base + 8, true);
    edgeLength[i] = view.getFloat32(base + 12, true);
  }

  /** Attributs d'un tronçon, décodés à la demande. */
  const segmentAt = (id) => {
    const base = segmentsAt + id * stride;
    const nameIndex = view.getUint16(base, true);
    const flags = bytes[base + 3];
    const width = bytes[base + 6];
    return {
      id,
      name: nameIndex === 0xffff ? null : names[nameIndex],
      hw: HIGHWAYS[bytes[base + 2]] ?? 'footway',
      crossing: (flags & 1) !== 0,
      covered: (flags & 2) !== 0,
      twoSided: (flags & 4) !== 0,
      /** Le jeu d'éclairage public renseigne-t-il ce tronçon ? */
      lit: (flags & 8) !== 0,
      len: view.getUint16(base + 4, true) / 10,
      width: width === 255 ? null : width / 2,
      lOff: bytes[base + 7] / 10,
      rOff: bytes[base + 8] / 10,
      lSide: CARDINALS[bytes[base + 9]],
      rSide: CARDINALS[bytes[base + 10]],
      lSvf: bytes[base + 11],
      rSvf: bytes[base + 12],
      lCanopy: bytes[base + 13],
      rCanopy: bytes[base + 14],
      // Luminance de voile nocturne, stockée en centièmes de cd/m².
      lVeil: view.getUint16(base + 16, true) / 100,
      rVeil: view.getUint16(base + 18, true) / 100,
      // Part du trottoir barrée par un chantier, en pourcentage.
      lWork: bytes[base + 20],
      rWork: bytes[base + 21],
    };
  };

  /**
   * Vues sur les séries d'un côté, sans copie.
   * `sun` et `flicker` sont des `Uint8Array` de `timeSteps` valeurs.
   */
  const sideAt = (id, right) => {
    // Sur un tronçon à un seul côté, les deux trottoirs se confondent : la même
    // vue est rendue pour la gauche et pour la droite, ce qui est exactement ce
    // que le calcul a produit.
    let base = segmentsAt + id * stride + SEGMENT_PREFIX;
    if (right) {
      const rank = rightRank(id);
      if (rank >= 0) base = rightSidesAt + rank * sideBytes;
    }
    return {
      sun: bytes.subarray(base, base + timeSteps),
      flicker: bytes.subarray(base + timeSteps, base + 2 * timeSteps),
      horizon: bytes.subarray(base + 2 * timeSteps, base + 2 * timeSteps + horizonBins),
    };
  };

  return {
    timeSteps,
    horizonBins,
    segmentCount,
    names,
    segmentAt,
    sideAt,
    graph: {
      size: nodeCount,
      edgeCount,
      nodeLon,
      nodeLat,
      edgeA,
      edgeB,
      edgeSegment,
      edgeLength,
    },
  };
}
