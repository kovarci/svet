/**
 * Navigation pas à pas le long d'un itinéraire calculé.
 *
 * Rien ici ne touche au DOM ni à la carte : ce sont des fonctions pures sur des
 * coordonnées, ce qui permet de les rejouer avec des positions simulées sans
 * capteur GPS.
 *
 * Deux différences de fond avec un guidage routier ordinaire :
 *
 *  1. Une manœuvre ne dit pas seulement « tournez à droite », elle dit **sur
 *     quel trottoir marcher**. C'est tout l'objet de l'application.
 *  2. Un changement de côté recommandé devient une consigne de traversée. Sans
 *     ça, « marchez côté nord » serait un conseil qu'on ne saurait pas suivre.
 */

/** Au-delà, on considère que l'utilisateur a quitté l'itinéraire. */
export const OFF_ROUTE_METERS = 35;

/** En deçà, un changement de cap n'est pas une manœuvre mais une courbe. */
const TURN_THRESHOLD_DEG = 28;

/**
 * Découpe l'itinéraire en manœuvres.
 *
 * @param {{coordinates: number[][], steps: object[]}} route
 * @returns {{distance: number, coord: number[], type: string, name: string|null,
 *   side: string|null, crossing: boolean, index: number}[]}
 */
export function buildInstructions(route) {
  const { coordinates, steps } = route;
  if (!steps?.length) return [];

  const instructions = [];
  const smoothed = dominantSides(steps);
  let travelled = 0;
  let previous = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const from = coordinates[i];
    const to = coordinates[i + 1];
    const bearing = bearingBetween(from, to);
    const name = step.name ?? null;
    const side = smoothed[i];
    const crossing = Boolean(step.crossing);

    const turn = previous ? angleDifference(bearing, previous.bearing) : 0;
    const changedStreet = previous ? name !== previous.name : true;
    const changedSide = previous ? side !== previous.side : false;
    const startsCrossing = crossing && !(previous?.crossing ?? false);

    const worthSaying =
      i === 0 ||
      startsCrossing ||
      (changedStreet && (name || previous?.name)) ||
      Math.abs(turn) >= TURN_THRESHOLD_DEG ||
      (changedSide && side);

    if (worthSaying) {
      instructions.push({
        index: i,
        distance: travelled,
        coord: from,
        bearing,
        type: i === 0 ? 'depart' : startsCrossing ? 'crossing' : turnType(turn),
        name,
        side,
        crossing,
        index2: i,
      });
    }

    travelled += step.length;
    previous = { bearing, name, side, crossing };
  }

  instructions.push({
    index: steps.length,
    distance: travelled,
    coord: coordinates[coordinates.length - 1],
    bearing: previous?.bearing ?? 0,
    type: 'arrive',
    name: null,
    side: null,
    crossing: false,
  });

  return mergeShortSteps(instructions);
}

/**
 * Un seul trottoir par rue, et non un par tronçon.
 *
 * Le calcul d'itinéraire choisit le côté le moins exposé tronçon par tronçon,
 * ce qui produit des alternances absurdes — « Rue Auber, trottoir sud-ouest,
 * puis nord-est, puis sud-ouest » en trois cents mètres. Personne ne traverse
 * deux fois pour cinquante mètres d'ombre, et rien ne dit qu'on puisse
 * traverser là.
 *
 * On retient donc, pour chaque portion de rue parcourue d'un trait, le côté qui
 * l'emporte sur la plus grande longueur. Les traversées coupent les portions :
 * changer de côté après avoir traversé, ça, c'est applicable.
 */
function dominantSides(steps) {
  const sides = new Array(steps.length).fill(null);
  let i = 0;

  while (i < steps.length) {
    if (steps[i].crossing) {
      i++;
      continue;
    }
    const name = steps[i].name;
    const lengthBySide = new Map();
    let j = i;
    while (j < steps.length && steps[j].name === name && !steps[j].crossing) {
      const { twoSided, side } = steps[j].state;
      if (twoSided && side) {
        lengthBySide.set(side, (lengthBySide.get(side) ?? 0) + steps[j].length);
      }
      j++;
    }

    let winner = null;
    let best = -1;
    for (const [side, length] of lengthBySide) {
      if (length > best) {
        best = length;
        winner = side;
      }
    }
    for (let k = i; k < j; k++) sides[k] = winner;
    i = Math.max(j, i + 1);
  }

  return sides;
}

/**
 * Fusionne les manœuvres séparées de moins de 15 m.
 *
 * Le réseau OSM multiplie les micro-tronçons aux carrefours ; sans ce
 * nettoyage, l'application annoncerait trois virages pour une seule traversée
 * de place.
 */
function mergeShortSteps(instructions) {
  const kept = [instructions[0]];
  for (let i = 1; i < instructions.length; i++) {
    const current = instructions[i];
    const last = kept[kept.length - 1];
    if (current.type !== 'arrive' && current.distance - last.distance < 15) {
      // On garde la manœuvre la plus parlante des deux.
      if (rank(current.type) > rank(last.type))
        kept[kept.length - 1] = { ...current, distance: last.distance };
      continue;
    }
    kept.push(current);
  }
  return kept;
}

const rank = (type) =>
  ({
    depart: 5,
    arrive: 5,
    crossing: 4,
    sharp_left: 3,
    sharp_right: 3,
    left: 3,
    right: 3,
    slight_left: 2,
    slight_right: 2,
    straight: 1,
  })[type] ?? 0;

function turnType(delta) {
  const a = Math.abs(delta);
  if (a < TURN_THRESHOLD_DEG) return 'straight';
  if (a < 55) return delta > 0 ? 'slight_right' : 'slight_left';
  if (a < 135) return delta > 0 ? 'right' : 'left';
  return delta > 0 ? 'sharp_right' : 'sharp_left';
}

/** Libellé et flèche d'une manœuvre. */
export function describeManoeuvre(instruction) {
  const labels = {
    depart: ['Départ', '↑'],
    straight: ['Continuez', '↑'],
    slight_left: ['Légèrement à gauche', '↖'],
    slight_right: ['Légèrement à droite', '↗'],
    left: ['Tournez à gauche', '←'],
    right: ['Tournez à droite', '→'],
    sharp_left: ['Tournez franchement à gauche', '↰'],
    sharp_right: ['Tournez franchement à droite', '↱'],
    crossing: ['Traversez', '⇅'],
    arrive: ['Vous êtes arrivé', '◎'],
  };
  const [label, arrow] = labels[instruction.type] ?? labels.straight;

  let text = label;
  if (instruction.name && instruction.type !== 'arrive') {
    text +=
      instruction.type === 'crossing' ? ` vers ${instruction.name}` : ` — ${instruction.name}`;
  }
  // `label` et `name` sont renvoyés à part : la phrase parlée les recompose
  // autrement, sans tiret cadratin, que les moteurs de synthèse ânonnent.
  return { text, arrow, label, name: instruction.name, side: instruction.side };
}

/**
 * Projette une position sur l'itinéraire.
 *
 * L'indice précédent sert d'amorce : un itinéraire qui se recoupe passerait
 * sinon d'un brin à l'autre à la moindre imprécision du GPS, et le guidage
 * sauterait en avant ou en arrière.
 *
 * @returns {{distanceAlong: number, offset: number, index: number, snapped: number[]}}
 */
export function snapToRoute(route, lon, lat, hint = null) {
  const coords = route.coordinates;
  const from = hint === null ? 0 : Math.max(0, hint - 4);
  const to = hint === null ? coords.length - 1 : Math.min(coords.length - 1, hint + 25);

  // Longueur cumulée jusqu'au début de la fenêtre de recherche.
  let travelled = 0;
  for (let i = 0; i < from; i++) travelled += distance(coords[i], coords[i + 1]);

  let best = { offset: Infinity, distanceAlong: 0, index: from, snapped: coords[from] };
  let running = travelled;

  for (let i = from; i < to; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const length = distance(a, b);
    const { point, t } = projectOnSegment(a, b, lon, lat);
    const offset = distance(point, [lon, lat]);
    if (offset < best.offset) {
      best = { offset, distanceAlong: running + t * length, index: i, snapped: point };
    }
    running += length;
  }

  return best;
}

/**
 * Avancement forcé monotone le long de l'itinéraire.
 *
 * Le bruit du GPS fait reculer la position recalée de plusieurs mètres d'une
 * mesure à l'autre — mesuré à 10 m avec un bruit de ± 6 m — et la distance à la
 * prochaine manœuvre remonterait alors par à-coups, ce qui se lit comme une
 * panne. On n'autorise donc le recul que s'il dépasse `allowBack` : en deçà
 * c'est du bruit, au-delà c'est un demi-tour, et il faut le suivre.
 *
 * @param {number|null} previous avancement retenu jusqu'ici, en mètres
 * @param {number} measured avancement que donne la position du moment
 */
export function advanceProgress(previous, measured, { allowBack = 25 } = {}) {
  if (!Number.isFinite(previous)) return measured;
  return measured > previous || previous - measured > allowBack ? measured : previous;
}

/** Prochaine manœuvre à annoncer, et distance qui en sépare. */
export function nextManoeuvre(instructions, distanceAlong) {
  for (const instruction of instructions) {
    // 8 m de tolérance : on ne réannonce pas un virage qu'on vient de prendre.
    if (instruction.distance > distanceAlong + 8) {
      return { instruction, remaining: instruction.distance - distanceAlong };
    }
  }
  const last = instructions[instructions.length - 1];
  return { instruction: last, remaining: Math.max(0, last.distance - distanceAlong) };
}

// ------------------------------------------------------------------- outils

/** Cap en degrés depuis le nord, dans le sens horaire. */
export function bearingBetween([lon1, lat1], [lon2, lat2]) {
  const midLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const east = (lon2 - lon1) * Math.cos(midLat);
  const north = lat2 - lat1;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/** Écart de cap ramené dans [-180, 180]. Positif = vers la droite. */
export function angleDifference(to, from) {
  return ((to - from + 540) % 360) - 180;
}

export function distance([lon1, lat1], [lon2, lat2]) {
  const midLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx = (lon2 - lon1) * 111320 * Math.cos(midLat);
  const dy = (lat2 - lat1) * 111132;
  return Math.hypot(dx, dy);
}

function projectOnSegment([ax, ay], [bx, by], px, py) {
  const midLat = (((ay + by) / 2) * Math.PI) / 180;
  const scale = Math.cos(midLat);
  const vx = (bx - ax) * scale;
  const vy = by - ay;
  const wx = (px - ax) * scale;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSquared)) : 0;
  return { point: [ax + (bx - ax) * t, ay + (by - ay) * t], t };
}
