/**
 * Éblouissement nocturne au niveau du trottoir.
 *
 * Jusqu'ici l'indice tombait à zéro au coucher du soleil. Pour qui souffre de
 * la lumière, c'est faux au point d'être trompeur — et c'est même l'inverse
 * qui est vrai : sur un œil adapté à l'obscurité, un luminaire à vingt mètres
 * fait plus mal que le même à midi.
 *
 * Comme le facteur de vue du ciel, la grandeur est **statique** : les
 * lampadaires ne bougent pas. On la calcule donc une fois par point
 * d'échantillonnage, et la seule dépendance au temps qui reste est l'allumage,
 * traité côté modèle par `nightShare()`.
 *
 * Ce qui est modélisé :
 *  - la géométrie (distance, hauteur de feu, angle au regard) ;
 *  - le flux réel de chaque lampe, issu du jeu de la Ville ;
 *  - la **couleur** de la lumière, par le rapport mélanopique.
 *
 * Ce qui ne l'est pas, et qu'il faut savoir :
 *  - **l'occultation.** Un mur entre le piéton et le lampadaire n'arrête rien
 *    dans ce calcul. C'est peu gênant en pratique : un luminaire de voirie
 *    éclaire la voirie où l'on marche, et il est rare qu'un bâtiment s'y
 *    interpose. Ça l'est davantage en bord de parc ou de cour.
 *  - les vitrines, enseignes et phares de voiture, qui n'ont pas de jeu ouvert ;
 *  - la gradation nocturne : Paris abaisse la puissance en fin de nuit, le jeu
 *    ne dit pas selon quel horaire.
 */
import { veilingLuminance } from './model.js';

/**
 * Rayon de recherche autour d'un point, en mètres.
 *
 * Au-delà, un luminaire de voirie ne contribue plus : à 80 m d'un mât de 6 m,
 * l'angle au regard tombe sous 3,2° et l'éclairement sous le millième de lux.
 */
const SEARCH_RADIUS = 80;

/** Maille de l'index spatial, en mètres. */
const CELL = 40;

/**
 * Maille de la carte de couverture, en mètres.
 *
 * Le jeu de la Ville s'arrête aux limites de la commune. Or les emprises de
 * calcul débordent — celle de « Paris intra-muros » mord sur Neuilly, Pantin,
 * Montreuil. Sans cette carte, l'application annoncerait « aucun lampadaire »
 * avenue Jean Lolive, ce qui est faux et exactement la mauvaise erreur : on ne
 * promet pas l'obscurité à quelqu'un qui va trouver un boulevard éclairé.
 *
 * 250 m est un compromis : assez grand pour qu'une rue parisienne ordinaire
 * remplisse ses mailles, assez petit pour épouser la limite communale à un
 * pâté de maisons près.
 */
const COVERAGE_CELL = 250;

/**
 * Indexe les luminaires en mailles, dans le repère projeté du calcul.
 * @param {{lon:number, lat:number, flux:number, height:number, cct:number}[]} lamps
 */
export function indexLamps(lamps, projection) {
  const cells = new Map();
  const seeded = new Set();
  let kept = 0;

  for (const lamp of lamps) {
    const [x, y] = projection.forward(lamp.lon, lamp.lat);
    const entry = { x, y, flux: lamp.flux, height: lamp.height, cct: lamp.cct };
    const key = `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, (bucket = []));
    bucket.push(entry);
    seeded.add(`${Math.round(x / COVERAGE_CELL)},${Math.round(y / COVERAGE_CELL)}`);
    kept++;
  }

  // Une maille sans lampadaire peut être de deux natures opposées : un trou
  // **intérieur** — bois, emprise ferroviaire, cimetière — où la donnée existe
  // et dit « rien ici » ; ou un **bord de commune**, où la donnée s'arrête.
  //
  // On les distingue par le voisinage. Un trou intérieur est cerné de mailles
  // pourvues ; un bord de commune n'en a que d'un côté. Exiger cinq voisins sur
  // huit tranche proprement : une dilatation uniforme, elle, faisait passer une
  // bande de 250 m au-delà du périphérique pour « non éclairée », et annoncer
  // l'obscurité avenue Jean Lolive est exactement la mauvaise erreur.
  const covered = new Set(seeded);
  const candidates = new Set();
  for (const key of seeded) {
    const [cx, cy] = key.split(',').map(Number);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iy = -1; iy <= 1; iy++) {
        const neighbour = `${cx + ix},${cy + iy}`;
        if (!seeded.has(neighbour)) candidates.add(neighbour);
      }
    }
  }
  for (const key of candidates) {
    const [cx, cy] = key.split(',').map(Number);
    let around = 0;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iy = -1; iy <= 1; iy++) {
        if (ix === 0 && iy === 0) continue;
        if (seeded.has(`${cx + ix},${cy + iy}`)) around++;
      }
    }
    if (around >= 5) covered.add(key);
  }

  return { cells, covered, count: kept };
}

/** La donnée d'éclairage existe-t-elle ici ? */
export function coveredAt(index, x, y) {
  if (index.count === 0) return false;
  return index.covered.has(`${Math.round(x / COVERAGE_CELL)},${Math.round(y / COVERAGE_CELL)}`);
}

/**
 * Luminance de voile en un point, en cd/m², toutes sources confondues.
 *
 * Les luminances de voile s'additionnent : chaque source ajoute sa part de
 * lumière diffusée dans l'œil, et c'est leur somme qui masque le contraste.
 */
export function veilAt(index, x, y, eyeHeight) {
  const reach = Math.ceil(SEARCH_RADIUS / CELL);
  const cx = Math.round(x / CELL);
  const cy = Math.round(y / CELL);
  let total = 0;

  for (let ix = -reach; ix <= reach; ix++) {
    for (let iy = -reach; iy <= reach; iy++) {
      const bucket = index.cells.get(`${cx + ix},${cy + iy}`);
      if (!bucket) continue;
      for (const lamp of bucket) {
        const dx = lamp.x - x;
        const dy = lamp.y - y;
        const distance = Math.hypot(dx, dy);
        if (distance > SEARCH_RADIUS) continue;
        total += veilingLuminance(lamp, distance, eyeHeight);
      }
    }
  }

  return total;
}
