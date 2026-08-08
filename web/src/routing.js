/**
 * Calcul d'itinéraire piéton pondéré par l'exposition à la lumière.
 *
 * Le graphe se construit dans le navigateur, à partir du réseau déjà chargé.
 * C'est indispensable : le coût d'un tronçon dépend de l'heure, de la météo et
 * du curseur « rapide ↔ abrité ». Précalculer des itinéraires côté pipeline
 * n'aurait aucun sens, il faudrait les refaire à chaque réglage.
 *
 * Le coût est un **temps**, pas une distance :
 *
 *     coût = durée × (1 + α × indice/100)
 *
 * Raisonner en secondes rend la pénalité de traversée commensurable au reste
 * (attendre 25 s à un feu, c'est 34 m de marche) et permet d'annoncer le
 * compromis en minutes, ce qui parle à l'utilisateur.
 *
 * L'itinéraire est **dépendant du temps** : la durée écoulée depuis le départ
 * est connue à chaque nœud, et l'indice d'un tronçon est évalué à l'heure où
 * l'on y passera vraiment. Sur une heure de marche le soleil tourne de 15° —
 * assez pour retourner l'ombre d'une rue.
 */

/**
 * Prépare le graphe reçu du pipeline.
 *
 * Il y était construit dans le navigateur, à partir du GeoJSON complet. Avec
 * une géométrie tuilée ce n'est plus possible : un itinéraire traverse par
 * définition ce qui n'est pas à l'écran. Le pipeline le calcule donc et
 * l'expédie en tableaux typés ; il ne reste qu'à bâtir l'adjacence.
 *
 * L'adjacence est stockée à plat, en deux tableaux — les débuts de plage et les
 * arêtes bout à bout. Un tableau de tableaux ferait, sur Paris, un million de
 * petits objets à créer puis à ramasser.
 */
export function prepareGraph(data) {
  const { graph } = data;
  const { size, edgeCount, edgeA, edgeB, edgeSegment, edgeLength } = graph;

  const degree = new Uint32Array(size + 1);
  for (let i = 0; i < edgeCount; i++) {
    degree[edgeA[i]]++;
    degree[edgeB[i]]++;
  }
  const adjStart = new Uint32Array(size + 1);
  for (let i = 0; i < size; i++) adjStart[i + 1] = adjStart[i] + degree[i];

  const cursor = adjStart.slice(0, size);
  const adjEdges = new Uint32Array(edgeCount * 2);
  for (let i = 0; i < edgeCount; i++) {
    adjEdges[cursor[edgeA[i]]++] = i;
    adjEdges[cursor[edgeB[i]]++] = i;
  }

  // Traversées et pénalité réparties, précalculées : les relire depuis les
  // attributs à chaque relâchement d'arête créerait un objet par itération.
  const crossing = new Uint8Array(edgeCount);
  const penaltyShare = new Float32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const segment = data.segmentAt(edgeSegment[i]);
    if (!segment.crossing) continue;
    crossing[i] = 1;
    penaltyShare[i] = segment.len > 0 ? edgeLength[i] / segment.len : 0;
  }

  const prepared = { ...graph, adjStart, adjEdges, crossing, penaltyShare, edgeSegment, edgeLength };
  labelComponents(prepared);
  return prepared;
}

/**
 * Étiquette les composantes connexes et retient la plus grande.
 *
 * Un réseau piéton réel n'est jamais d'un seul tenant : couloirs de gare
 * cartographiés sans accès, cours d'immeuble, allées de square fermées, îlots
 * que l'emprise de calcul a coupés de leur voisinage. Accrocher un départ au
 * nœud géométriquement le plus proche, sans regarder s'il mène quelque part,
 * revient à échouer sur des adresses parfaitement ordinaires — une gare, par
 * exemple.
 */
function labelComponents(graph) {
  const { size, adjStart, adjEdges, edgeA, edgeB } = graph;
  const component = new Int32Array(size).fill(-1);
  let best = -1;
  let bestSize = 0;

  for (let seed = 0; seed < size; seed++) {
    if (component[seed] !== -1) continue;
    const stack = [seed];
    component[seed] = seed;
    let count = 1;

    while (stack.length > 0) {
      const u = stack.pop();
      for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
        const e = adjEdges[k];
        const v = edgeA[e] === u ? edgeB[e] : edgeA[e];
        if (component[v] !== -1) continue;
        component[v] = seed;
        count++;
        stack.push(v);
      }
    }

    if (count > bestSize) {
      bestSize = count;
      best = seed;
    }
  }

  graph.component = component;
  graph.mainComponent = best;
  graph.mainComponentSize = bestSize;

  // Taille de chaque composante, et non plus seulement de la plus grande.
  //
  // Se limiter à la plus grande a longtemps suffi : sur une zone d'un seul
  // tenant, tout ce qui compte y est. Une région tuilée casse l'hypothèse — les
  // cellules chargées ne se touchent pas forcément, et la plus grande
  // composante est alors simplement celle de la ville la plus dense. Un départ
  // à Provins se voyait rattaché au nœud parisien le plus proche, à
  // soixante-dix-huit kilomètres, et l'application répondait « choisissez un
  // lieu dans la zone » au beau milieu de la zone.
  const sizes = new Map();
  for (let i = 0; i < size; i++) sizes.set(component[i], (sizes.get(component[i]) ?? 0) + 1);
  graph.componentSize = sizes;
}

/**
 * Nœud le plus proche d'un point.
 *
 * Le filtre par taille de composante remplace l'ancien « uniquement la plus
 * grande », dont il garde l'intention : ne pas accrocher un départ à une allée
 * de square fermée ou à un couloir de gare sans accès, d'où l'on ne peut aller
 * nulle part. Deux cents nœuds, c'est déjà un vrai réseau — quelques kilomètres
 * de rues — et non un cul-de-sac cartographique.
 */
export function nearestNode(graph, lon, lat, { minComponentSize = 200 } = {}) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < graph.size; i++) {
    if ((graph.componentSize?.get(graph.component[i]) ?? 0) < minComponentSize) continue;
    const d = flatDistance(graph.nodeLon[i], graph.nodeLat[i], lon, lat);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return { node: best, distance: bestDistance, component: best >= 0 ? graph.component[best] : -1 };
}

/**
 * Itinéraire au moindre coût, par A*.
 *
 * @param {object} graph
 * @param {number} start nœud de départ
 * @param {number} goal nœud d'arrivée
 * @param {object} options
 * @param {number} options.alpha 0 = le plus rapide, 3 = très évitant
 * @param {number} options.speed vitesse de marche, en m/s
 * @param {number} options.crossingPenalty secondes perdues à une traversée
 * @param {number} options.departureMinutes heure de départ, en minutes locales
 * @param {(position: number, minutes: number) => {index: number, side: string, sun: number}}
 *        options.evaluate état d'un tronçon à un instant donné
 * @returns {null | {edges: object[], seconds: number, meters: number, index: number}}
 */
export function findRoute(graph, start, goal, options) {
  const { alpha, speed, crossingPenalty, departureMinutes, evaluate } = options;
  const size = graph.size;

  const cost = new Float64Array(size).fill(Infinity);
  const clock = new Float64Array(size);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  const goalLon = graph.nodeLon[goal];
  const goalLat = graph.nodeLat[goal];
  // Minorant admissible : aucun tronçon ne peut coûter moins que sa durée, et
  // aucune durée ne peut être plus courte que la distance à vol d'oiseau.
  const heuristic = (node) =>
    flatDistance(graph.nodeLon[node], graph.nodeLat[node], goalLon, goalLat) / speed;

  cost[start] = 0;
  clock[start] = departureMinutes;

  const open = new MinHeap();
  open.push(start, heuristic(start));

  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) break;
    if (closed[current]) continue;
    closed[current] = 1;

    for (let k = graph.adjStart[current]; k < graph.adjStart[current + 1]; k++) {
      const edgeId = graph.adjEdges[k];
      const next = graph.edgeA[edgeId] === current ? graph.edgeB[edgeId] : graph.edgeA[edgeId];
      if (closed[next]) continue;

      const seconds =
        graph.edgeLength[edgeId] / speed + graph.penaltyShare[edgeId] * crossingPenalty;
      // On évalue l'exposition au milieu du tronçon, à l'heure où l'on y sera,
      // et dans le sens où on le parcourt : marcher face à un soleil rasant
      // n'a rien à voir avec le parcourir en sens inverse.
      const midpoint = clock[current] + seconds / 120;
      const { index, work } = evaluate(
        graph.edgeSegment[edgeId],
        midpoint,
        headingOf(graph, current, next),
      );
      // Un trottoir barré par un chantier ne se refuse pas — il faut parfois
      // le longer, et le jeu de la Ville donne l'emprise, pas la fermeture
      // réelle. On le rend cher : à emprise totale, le tronçon compte comme
      // trois fois sa durée, ce qui suffit à préférer l'autre trottoir dès
      // qu'il existe, sans jamais rendre le trajet impossible.
      const detour = 1 + 2 * ((work ?? 0) / 100);
      const candidate = cost[current] + seconds * detour * (1 + alpha * (index / 100));

      if (candidate < cost[next]) {
        cost[next] = candidate;
        clock[next] = clock[current] + seconds / 60;
        cameFrom[next] = edgeId;
        open.push(next, candidate + heuristic(next));
      }
    }
  }

  if (cameFrom[goal] === -1 && start !== goal) return null;
  return describe(graph, cameFrom, start, goal, options);
}

/** Remonte le chemin et calcule ce qui sera montré à l'utilisateur. */
function describe(graph, cameFrom, start, goal, options) {
  const { speed, crossingPenalty, departureMinutes, evaluate } = options;

  const path = [];
  let node = goal;
  while (node !== start) {
    const edgeId = cameFrom[node];
    if (edgeId === -1) return null;
    const from = graph.edgeA[edgeId] === node ? graph.edgeB[edgeId] : graph.edgeA[edgeId];
    path.push({ edgeId, from, to: node });
    node = from;
  }
  path.reverse();

  let seconds = 0;
  let meters = 0;
  let weightedIndex = 0;
  let weightedSun = 0;
  const steps = [];

  for (const hop of path) {
    const length = graph.edgeLength[hop.edgeId];
    const hopSeconds = length / speed + graph.penaltyShare[hop.edgeId] * crossingPenalty;
    const minutes = departureMinutes + (seconds + hopSeconds / 2) / 60;
    const segment = graph.edgeSegment[hop.edgeId];
    const state = evaluate(segment, minutes, headingOf(graph, hop.from, hop.to));

    seconds += hopSeconds;
    meters += length;
    weightedIndex += state.index * length;
    weightedSun += state.sun * length;

    hop.length = length;
    hop.segment = segment;
    hop.crossing = graph.crossing[hop.edgeId] === 1;
    hop.name = state.name ?? null;
    hop.state = state;
    steps.push(hop);
  }

  // Tracé exact du chemin suivi : la suite des nœuds traversés. Redessiner les
  // tronçons entiers reviendrait à afficher des bouts de rue non empruntés,
  // puisqu'un tronçon de 30 m peut n'être parcouru qu'en partie.
  const coordinates = [[graph.nodeLon[start], graph.nodeLat[start]]];
  for (const hop of steps) coordinates.push([graph.nodeLon[hop.to], graph.nodeLat[hop.to]]);

  return {
    steps,
    coordinates,
    seconds,
    meters,
    index: meters > 0 ? weightedIndex / meters : 0,
    sun: meters > 0 ? weightedSun / meters : 0,
    arrivalMinutes: departureMinutes + seconds / 60,
  };
}

/**
 * Regroupe les tronçons consécutifs portant le même nom, pour une feuille de
 * route lisible : « Rue de Rivoli, 320 m, côté nord » plutôt que douze lignes.
 */
export function summarize(route) {
  const legs = [];
  for (const step of route.steps) {
    const name = step.name ?? (step.crossing ? 'Traversée' : 'Cheminement');
    // Le côté ne compte dans le regroupement que là où il existe vraiment. Sur
    // un cheminement piéton, l'étiquette cardinale décrit l'orientation du
    // tracé : la faire entrer dans la clé couperait la marche en confettis à
    // chaque virage.
    const side = step.state.twoSided ? step.state.side : null;
    const last = legs[legs.length - 1];

    if (last && last.name === name && last.side === side && last.crossing === step.crossing) {
      last.meters += step.length;
      last.index = (last.index * last.count + step.state.index) / (last.count + 1);
      last.count++;
    } else {
      legs.push({
        name,
        side,
        twoSided: step.state.twoSided,
        crossing: step.crossing,
        meters: step.length,
        index: step.state.index,
        count: 1,
      });
    }
  }
  // On masque les micro-tronçons, qui ne sont que du bruit de découpage OSM.
  return legs.filter((leg) => leg.meters >= 12 || leg.crossing);
}

/** Cap de marche, en radians depuis le nord, en allant de `from` vers `to`. */
function headingOf(graph, from, to) {
  const midLat = ((graph.nodeLat[from] + graph.nodeLat[to]) / 2) * (Math.PI / 180);
  const east = (graph.nodeLon[to] - graph.nodeLon[from]) * Math.cos(midLat);
  const north = graph.nodeLat[to] - graph.nodeLat[from];
  return Math.atan2(east, north);
}

/**
 * Distance approchée en mètres, dans le plan tangent local.
 * Sur quelques kilomètres l'écart avec la formule de haversine est négligeable,
 * et cette version-ci s'exécute des dizaines de fois plus vite.
 */
function flatDistance(lon1, lat1, lon2, lat2) {
  const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = (lon2 - lon1) * 111320 * Math.cos(midLat);
  const dy = (lat2 - lat1) * 111132;
  return Math.hypot(dx, dy);
}

/** Tas binaire minimal — suffisant, et sans dépendance. */
class MinHeap {
  constructor() {
    this.items = [];
    this.priorities = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, priority) {
    this.items.push(item);
    this.priorities.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastPriority = this.priorities.pop();
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) {
          smallest = left;
        }
        if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  swap(i, j) {
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    [this.priorities[i], this.priorities[j]] = [this.priorities[j], this.priorities[i]];
  }
}
