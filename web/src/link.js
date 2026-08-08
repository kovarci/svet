/**
 * Ce qu'un lien porte, et ce qu'il rend.
 *
 * L'URL portait déjà la zone et le cadrage de la carte — un lien vers une rue
 * précise se partageait. L'itinéraire, lui, ne survivait à rien : ni un lien
 * envoyé à quelqu'un, ni un rechargement d'onglet. Or un navigateur mobile
 * recharge les onglets qu'il a mis en veille, et il le fait exactement quand on
 * marche depuis dix minutes sans toucher l'écran. Retrouver alors un panneau
 * vide, à ressaisir deux adresses, c'est perdre le guidage au pire moment.
 *
 * Tout est ici en fonctions pures sur une `URL` : rien n'y touche au document,
 * ce qui permet de les éprouver sans navigateur.
 */

/**
 * Un lieu, en un paramètre : coordonnées puis libellé.
 *
 * Cinq décimales valent un mètre à cette latitude — la précision d'un trottoir,
 * qui est la seule qui nous intéresse, et bien plus courte que les quinze
 * chiffres d'un flottant. Le libellé suit après une barre verticale : c'est le
 * seul caractère qu'aucun nom de rue français ne contient, et `URLSearchParams`
 * l'encode de toute façon.
 */
export function encodePlace(place) {
  if (!place || !Number.isFinite(place.lon) || !Number.isFinite(place.lat)) return null;
  return `${place.lon.toFixed(5)},${place.lat.toFixed(5)}|${place.label ?? ''}`;
}

export function decodePlace(text) {
  if (!text) return null;
  const bar = text.indexOf('|');
  const coordinates = bar < 0 ? text : text.slice(0, bar);
  const [lon, lat] = coordinates.split(',').map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  // Un lien fabriqué à la main peut n'avoir que des coordonnées : on rend alors
  // le libellé que l'application donne à un point pointé sur la carte.
  const label = bar < 0 ? '' : text.slice(bar + 1);
  return { lon, lat, label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

/**
 * Lit l'itinéraire décrit par une URL.
 *
 * @returns {{from: object|null, to: object|null, alpha: number|null, navigating: boolean}}
 */
export function readRoute(url) {
  const params = new URL(url).searchParams;
  // `Number(null)` vaut zéro, et non `NaN` : lu sans précaution, un lien sans
  // priorité aurait poussé le curseur sur « le plus rapide » à chaque ouverture,
  // c'est-à-dire supprimé la fonction même de l'application.
  const written = params.get('p');
  const alpha = written === null ? Number.NaN : Number(written);
  return {
    from: decodePlace(params.get('de')),
    to: decodePlace(params.get('a')),
    // Le curseur de priorité va de 0 à 60 ; hors de ces bornes, on ignore
    // plutôt que de coincer le curseur sur une valeur qu'il ne peut pas rendre.
    alpha: Number.isFinite(alpha) && alpha >= 0 && alpha <= 60 ? alpha : null,
    navigating: params.get('nav') === '1',
  };
}

/**
 * Réécrit les paramètres d'itinéraire d'une URL, sans toucher au reste.
 *
 * La zone et le fragment de position appartiennent à d'autres : les écraser
 * ferait perdre le cadrage au premier calcul d'itinéraire.
 *
 * @returns {string} l'URL réécrite
 */
export function writeRoute(url, { from, to, alpha, navigating } = {}) {
  const next = new URL(url);
  const set = (key, value) => {
    if (value === null || value === undefined || value === '') next.searchParams.delete(key);
    else next.searchParams.set(key, String(value));
  };

  set('de', encodePlace(from));
  set('a', encodePlace(to));
  set('p', Number.isFinite(alpha) ? alpha : null);
  set('nav', navigating ? '1' : null);
  return next.toString();
}
