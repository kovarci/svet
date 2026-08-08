import { loadZoneData } from './binary.js';

/**
 * Chargement d'une région par cellules.
 *
 * ── Le problème ────────────────────────────────────────────────────────────
 * Une zone tient dans un fichier : l'application le télécharge en entier, pose
 * ses vues typées dessus, et tout est là. Paris intra-muros pèse 54 Mo — déjà
 * une minute de réseau mobile. L'Île-de-France en pèserait plus de mille.
 *
 * ── Ce qui rend le découpage possible ──────────────────────────────────────
 * Un identifiant de tronçon porte le rang de sa cellule dans ses bits de poids
 * fort. Retrouver le fichier qui décrit un tronçon est donc un décalage, pas
 * une recherche : `id >>> 20` donne la cellule, `id & 0xFFFFF` le rang dans son
 * binaire. Aucune table à charger, aucun index à tenir à jour.
 *
 * ── Ce que cet objet imite ─────────────────────────────────────────────────
 * Il expose exactement l'interface d'une zone décodée — `segmentAt`, `sideAt`,
 * `timeSteps`, `graph`. Tout le reste de l'application continue donc de
 * fonctionner sans savoir qu'elle regarde une région. La seule différence qu'il
 * faut assumer côté appelant : **`segmentAt` peut rendre `null`** quand la
 * cellule n'est pas encore chargée. C'était impossible avec une zone, et c'est
 * la contrepartie de ne plus tout télécharger.
 */

/** Nombre de cellules gardées en mémoire. */
const KEEP = 12;

export async function loadRegionIndex(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url} introuvable (HTTP ${response.status}).`);
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`${url} introuvable : le serveur a répondu la page d’accueil.`);
  }
  return response.json();
}

/**
 * @param {object} index contenu de `index.json`
 * @param {object} options
 * @param {string} options.baseUrl préfixe des fichiers de cellule
 * @param {() => void} [options.onCellsChanged] appelé quand le jeu chargé change
 * @param {(url: string) => Promise<object>} [options.load] lecteur d'un binaire
 *   de cellule. Injectable pour une seule raison : la couture des graphes et la
 *   libération des cellules sont la partie subtile de ce fichier, et les
 *   éprouver ne doit demander ni réseau ni fichier de plusieurs mégaoctets.
 */
export function createRegionData(index, { baseUrl, onCellsChanged, load = loadZoneData }) {
  const bits = index.segmentBits;
  const localMask = (1 << bits) - 1;

  /** Cellules déclarées par l'index, retrouvées par leur rang. */
  const declared = new Map();
  for (const cell of index.cells) declared.set(cell.idBase >>> bits, cell);

  /** Cellules chargées : rang -> { cell, data, usedAt }. */
  const loaded = new Map();
  /** Chargements en cours, pour ne pas demander deux fois le même fichier. */
  const pending = new Map();
  let clock = 0;

  const cellOf = (id) => {
    const entry = loaded.get(id >>> bits);
    if (entry) entry.usedAt = ++clock;
    return entry;
  };

  /**
   * Cellules dont l'emprise recoupe une fenêtre géographique.
   * @param {{west:number,south:number,east:number,north:number}} bounds
   */
  const cellsIn = (bounds) =>
    index.cells.filter(
      (cell) =>
        cell.bbox[0] <= bounds.east &&
        cell.bbox[2] >= bounds.west &&
        cell.bbox[1] <= bounds.north &&
        cell.bbox[3] >= bounds.south,
    );

  async function loadCell(cell) {
    const rank = cell.idBase >>> bits;
    if (loaded.has(rank)) return loaded.get(rank);
    if (pending.has(rank)) return pending.get(rank);

    const version = cell.stamp ? `?v=${cell.stamp}` : '';
    const promise = load(`${baseUrl}${cell.key}.data.bin${version}`)
      .then((data) => {
        const entry = { cell, data, usedAt: ++clock };
        loaded.set(rank, entry);
        pending.delete(rank);
        evict();
        return entry;
      })
      .catch((error) => {
        pending.delete(rank);
        throw error;
      });

    pending.set(rank, promise);
    return promise;
  }

  /**
   * Libère les cellules les moins récemment consultées.
   *
   * Une cellule dense pèse seize mégaoctets en mémoire. Traverser la région
   * d'ouest en est en chargerait vingt-quatre sans jamais rien rendre — et le
   * navigateur finirait par tuer l'onglet, sans rien dire d'autre qu'un écran
   * blanc.
   */
  function evict() {
    if (loaded.size <= KEEP) return;
    const ranked = [...loaded.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [rank] of ranked.slice(0, loaded.size - KEEP)) loaded.delete(rank);
  }

  /**
   * Charge les cellules d'une fenêtre, et signale quand le jeu a changé.
   * @returns {Promise<{added: number, failed: string[]}>}
   */
  async function ensure(bounds) {
    const wanted = cellsIn(bounds).filter((cell) => !loaded.has(cell.idBase >>> bits));
    if (wanted.length === 0) return { added: 0, failed: [] };

    const failed = [];
    let added = 0;
    await Promise.all(
      wanted.map((cell) =>
        loadCell(cell)
          .then(() => {
            added++;
          })
          .catch((error) => {
            console.warn(`Cellule ${cell.key} indisponible :`, error.message);
            failed.push(cell.key);
          }),
      ),
    );
    if (added > 0) onCellsChanged?.();
    return { added, failed };
  }

  return {
    kind: 'region',
    index,
    timeSteps: index.times.length,
    horizonBins: index.horizonBins,
    /** Total régional : c'est un ordre de grandeur, pas ce qui est en mémoire. */
    segmentCount: index.counts.segments,

    cellsIn,
    ensure,
    /** Cellules effectivement en mémoire — l'affichage ne peut parler que d'elles. */
    loadedCells: () => [...loaded.values()].map((entry) => entry.cell),
    isLoaded: (id) => loaded.has(id >>> bits),
    declares: (id) => declared.has(id >>> bits),

    /**
     * Recoud les graphes des cellules chargées en un seul.
     *
     * Un itinéraire traverse les cellules sans les voir : il faut donc un
     * graphe qui les enjambe. La couture ne demande aucune donnée
     * supplémentaire, parce que le pipeline indexe déjà ses nœuds sur les
     * coordonnées arrondies au micro-degré — dix centimètres. Deux cellules
     * voisines qui décrivent le même carrefour en donnent, par construction, la
     * même clé : il suffit de les reconnaître.
     *
     * Le découpage tombe rarement sur un carrefour ; il coupe une rue en plein
     * milieu. Mais un tronçon appartient tout entier à la cellule où commence
     * son tracé, et le tronçon suivant reprend au sommet où le précédent
     * s'arrête — c'est ce sommet partagé qui fait la soudure.
     */
    mergedGraph() {
      const parts = [...loaded.values()];
      if (parts.length === 0) return null;

      const nodeIndex = new Map();
      const nodeLon = [];
      const nodeLat = [];
      let edgeCount = 0;
      for (const { data } of parts) edgeCount += data.graph.edgeCount;

      const edgeA = new Uint32Array(edgeCount);
      const edgeB = new Uint32Array(edgeCount);
      const edgeSegment = new Uint32Array(edgeCount);
      const edgeLength = new Float32Array(edgeCount);

      let at = 0;
      for (const { cell, data } of parts) {
        const graph = data.graph;
        const remap = new Uint32Array(graph.size);
        for (let i = 0; i < graph.size; i++) {
          const key = `${Math.round(graph.nodeLon[i] * 1e6)},${Math.round(graph.nodeLat[i] * 1e6)}`;
          let node = nodeIndex.get(key);
          if (node === undefined) {
            node = nodeLon.length;
            nodeIndex.set(key, node);
            nodeLon.push(graph.nodeLon[i]);
            nodeLat.push(graph.nodeLat[i]);
          }
          remap[i] = node;
        }
        for (let i = 0; i < graph.edgeCount; i++) {
          edgeA[at] = remap[graph.edgeA[i]];
          edgeB[at] = remap[graph.edgeB[i]];
          // Le graphe d'une cellule numérote ses tronçons localement ; le reste
          // de l'application les connaît par leur numéro régional.
          edgeSegment[at] = cell.idBase + graph.edgeSegment[i];
          edgeLength[at] = graph.edgeLength[i];
          at++;
        }
      }

      return {
        size: nodeLon.length,
        edgeCount,
        nodeLon: Float64Array.from(nodeLon),
        nodeLat: Float64Array.from(nodeLat),
        edgeA,
        edgeB,
        edgeSegment,
        edgeLength,
      };
    },

    segmentAt(id) {
      const entry = cellOf(id);
      if (!entry) return null;
      const segment = entry.data.segmentAt(id & localMask);
      // L'identifiant rendu doit être celui du monde extérieur : c'est lui que
      // l'application repasse à `sideAt`, à `setFeatureState` et aux tuiles.
      return segment && { ...segment, id };
    },

    sideAt(id, right) {
      const entry = cellOf(id);
      return entry ? entry.data.sideAt(id & localMask, right) : null;
    },
  };
}
