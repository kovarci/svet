/**
 * Grille de tuiles Web Mercator.
 *
 * Ces conversions vivaient dans `pack.js`, où elles ne servaient qu'à borner le
 * balayage de la pyramide. Elles décident désormais de bien plus : le découpage
 * régional est **calé sur cette grille**, et c'est ce calage qui garantit
 * qu'aucune tuile n'appartient à deux cellules à la fois. Une deuxième
 * implémentation qui dériverait d'un demi-pixel suffirait à faire écrire deux
 * cellules dans le même fichier.
 */

/** Indices de la tuile qui contient ce point, au zoom donné. */
export function tileOf(lon, lat, z) {
  const side = 1 << z;
  const x = Math.floor(((lon + 180) / 360) * side);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * side);
  return [clampTile(x, side), clampTile(y, side)];
}

/** Longitude du bord ouest d'une colonne de tuiles. */
export function tileWest(x, z) {
  return (x / (1 << z)) * 360 - 180;
}

/** Latitude du bord nord d'une ligne de tuiles. */
export function tileNorth(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Emprise géographique d'une tuile : [ouest, sud, est, nord]. */
export function tileBbox(x, y, z) {
  return [tileWest(x, z), tileNorth(y + 1, z), tileWest(x + 1, z), tileNorth(y, z)];
}

function clampTile(value, side) {
  return Math.max(0, Math.min(side - 1, value));
}
