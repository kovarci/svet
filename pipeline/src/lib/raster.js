/**
 * Rastérisation du modèle numérique de surface (MNS).
 *
 * Quatre grilles alignées, en coordonnées métriques locales :
 *  - `ground`    : altitude du terrain nu (RGE ALTI)
 *  - `surface`   : altitude du dessus des obstacles opaques — le terrain
 *                  lui-même là où il n'y a rien, le toit là où il y a du bâti
 *  - `canopyTop` / `canopyBase` : enveloppe verticale des houppiers
 *  - `canopyK`   : coefficient d'extinction du feuillage (Beer-Lambert, m⁻¹)
 *
 * Toutes les hauteurs sont des **altitudes absolues**, pas des hauteurs au-dessus
 * du sol. C'est ce qui permet à un rayon rasant de buter sur une colline comme
 * il bute sur un immeuble, sans traitement particulier : la butte Montmartre
 * est un obstacle comme un autre.
 *
 * On sépare volontairement bâti et végétation : l'ombre d'un immeuble est nette
 * et stable, celle d'un arbre est tamisée et clignotante quand on marche
 * dessous. Pour une personne photosensible, ce n'est pas du tout la même chose.
 */

export function createGrid(projection, res) {
  const width = Math.ceil(projection.widthM / res);
  const height = Math.ceil(projection.heightM / res);
  const cells = width * height;

  return {
    res,
    width,
    height,
    projection,
    ground: new Float32Array(cells),
    surface: new Float32Array(cells),
    canopyTop: new Float32Array(cells),
    canopyBase: new Float32Array(cells),
    canopyK: new Float32Array(cells),
    maxHeight: 0,

    /** Indice de cellule pour des coordonnées métriques. -1 hors grille. */
    index(x, y) {
      const col = (x / res) | 0;
      const row = (y / res) | 0;
      if (col < 0 || row < 0 || col >= width || row >= height) return -1;
      return row * width + col;
    },
  };
}

/**
 * Remplit la grille de terrain, et cale la surface opaque dessus.
 * @param {(x: number, y: number) => number} elevationAt altitude en mètres
 */
export function fillGround(grid, elevationAt) {
  const { width, height, res, ground, surface } = grid;
  let max = -Infinity;

  for (let row = 0; row < height; row++) {
    const y = (row + 0.5) * res;
    const offset = row * width;
    for (let col = 0; col < width; col++) {
      const value = elevationAt((col + 0.5) * res, y);
      ground[offset + col] = value;
      surface[offset + col] = value;
      if (value > max) max = value;
    }
  }

  grid.maxHeight = Math.max(grid.maxHeight, max);
}

/**
 * Remplissage scanline avec règle pair-impair.
 * Les anneaux intérieurs (cours, patios) sont donc gérés gratuitement : il
 * suffit de passer tous les anneaux du polygone.
 *
 * @param {ReturnType<createGrid>} grid
 * @param {number[][][]} rings anneaux en coordonnées métriques
 * @param {number} heightAboveGround hauteur du bâtiment, en mètres
 * @param {Uint8Array} [gapsOnly] si fourni, n'écrit que là où le masque vaut 0 —
 *   sert à combler les trous du LiDAR sans écraser ce qu'il a mesuré.
 */
export function fillPolygon(grid, rings, heightAboveGround, gapsOnly) {
  if (heightAboveGround <= 0) return;
  const { res, width, height, ground, surface } = grid;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY)) return;

  const rowStart = Math.max(0, Math.floor(minY / res));
  const rowEnd = Math.min(height - 1, Math.ceil(maxY / res));

  const crossings = [];
  for (let row = rowStart; row <= rowEnd; row++) {
    const scanY = (row + 0.5) * res;
    crossings.length = 0;

    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        // Convention semi-ouverte : évite de compter deux fois un sommet.
        if (y1 <= scanY ? y2 > scanY : y2 <= scanY) {
          crossings.push(x1 + ((scanY - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }

    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const rowOffset = row * width;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const colStart = Math.max(0, Math.round(crossings[i] / res - 0.5));
      const colEnd = Math.min(width - 1, Math.round(crossings[i + 1] / res - 0.5));
      for (let col = colStart; col <= colEnd; col++) {
        const idx = rowOffset + col;
        if (gapsOnly && gapsOnly[idx]) continue;
        const top = ground[idx] + heightAboveGround;
        if (surface[idx] < top) {
          surface[idx] = top;
          if (top > grid.maxHeight) grid.maxHeight = top;
        }
      }
    }
  }
}

/**
 * Couvert végétal sur toute l'emprise d'un polygone.
 *
 * Le pendant de `stampCrown` pour les données surfaciques : la BD TOPO donne
 * des parcelles — un bois, une haie — là où le fichier des arbres de Paris
 * donne des sujets. On ne peut plus dessiner de dôme, faute de savoir où sont
 * les troncs ; on pose un couvert d'épaisseur constante sur la parcelle.
 *
 * C'est plus grossier, et ça reste du bon côté de l'erreur pour ce qu'on en
 * fait : à l'échelle d'un bois, le piéton qui longe la lisière est de toute
 * façon sous un couvert continu.
 */
export function fillCanopy(grid, rings, top, base, k, gapsOnly) {
  if (top <= base) return;
  const { res, width, height, ground, canopyTop, canopyBase, canopyK } = grid;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY)) return;

  const rowStart = Math.max(0, Math.floor(minY / res));
  const rowEnd = Math.min(height - 1, Math.ceil(maxY / res));
  const crossings = [];

  for (let row = rowStart; row <= rowEnd; row++) {
    const scanY = (row + 0.5) * res;
    crossings.length = 0;

    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        if (y1 <= scanY ? y2 > scanY : y2 <= scanY) {
          crossings.push(x1 + ((scanY - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }

    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const rowOffset = row * width;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const colStart = Math.max(0, Math.round(crossings[i] / res - 0.5));
      const colEnd = Math.min(width - 1, Math.round(crossings[i + 1] / res - 0.5));
      for (let col = colStart; col <= colEnd; col++) {
        const idx = rowOffset + col;
        if (gapsOnly && gapsOnly[idx]) continue;
        const soil = ground[idx];
        const localTop = soil + top;
        if (canopyTop[idx] < localTop) canopyTop[idx] = localTop;
        if (canopyBase[idx] === 0 || canopyBase[idx] > soil + base) canopyBase[idx] = soil + base;
        if (canopyK[idx] < k) canopyK[idx] = k;
        if (localTop > grid.maxHeight) grid.maxHeight = localTop;
      }
    }
  }
}

/**
 * Marque les cellules couvertes par un polygone dans un masque binaire.
 * Même balayage que `fillPolygon`, mais sans notion de hauteur.
 */
export function fillMask(grid, mask, rings) {
  const { res, width, height } = grid;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY)) return;

  const rowStart = Math.max(0, Math.floor(minY / res));
  const rowEnd = Math.min(height - 1, Math.ceil(maxY / res));
  const crossings = [];

  for (let row = rowStart; row <= rowEnd; row++) {
    const scanY = (row + 0.5) * res;
    crossings.length = 0;

    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        if (y1 <= scanY ? y2 > scanY : y2 <= scanY) {
          crossings.push(x1 + ((scanY - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }

    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const rowOffset = row * width;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const colStart = Math.max(0, Math.round(crossings[i] / res - 0.5));
      const colEnd = Math.min(width - 1, Math.round(crossings[i + 1] / res - 0.5));
      for (let col = colStart; col <= colEnd; col++) mask[rowOffset + col] = 1;
    }
  }
}

/**
 * Dilate un masque binaire d'un rayon donné, en mètres.
 *
 * Indispensable pour croiser emprises au sol et LiDAR : l'emprise APUR décrit le
 * bâtiment **au sol**, quand le LiDAR voit la **corniche**, qui déborde de
 * 0,5 à 1,5 m sur les toits parisiens. Sans cette marge, tout le pourtour de
 * chaque immeuble ressort comme un obstacle non bâti — donc classé en
 * végétation, donc rendu translucide. Mesuré sur le Marais : 33 000 pixels
 * aberrants sur 49 500 disparaissent avec 2 m de marge.
 *
 * Dilatation séparable, en deux passes 1-D : coût linéaire en rayon plutôt que
 * quadratique.
 */
export function dilateMask(grid, mask, meters) {
  const radius = Math.round(meters / grid.res);
  if (radius <= 0) return mask;
  const { width, height } = grid;
  const horizontal = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);

  for (let row = 0; row < height; row++) {
    const offset = row * width;
    for (let col = 0; col < width; col++) {
      if (!mask[offset + col]) continue;
      const from = Math.max(0, col - radius);
      const to = Math.min(width - 1, col + radius);
      for (let c = from; c <= to; c++) horizontal[offset + c] = 1;
    }
  }

  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      if (!horizontal[row * width + col]) continue;
      const from = Math.max(0, row - radius);
      const to = Math.min(height - 1, row + radius);
      for (let r = from; r <= to; r++) out[r * width + col] = 1;
    }
  }

  return out;
}

/**
 * Empreinte d'un houppier : dôme ellipsoïdal centré sur le tronc.
 *
 * @param {ReturnType<createGrid>} grid
 * @param {number} cx centre X en mètres
 * @param {number} cy centre Y en mètres
 * @param {number} radius rayon du houppier en mètres
 * @param {number} top hauteur totale de l'arbre, au-dessus du sol
 * @param {number} base hauteur du bas du houppier, au-dessus du sol
 * @param {number} k coefficient d'extinction du feuillage en m⁻¹
 */
export function stampCrown(grid, cx, cy, radius, top, base, k) {
  const { res, width, height, ground, canopyTop, canopyBase, canopyK } = grid;
  if (radius <= 0 || top <= base) return;

  const colStart = Math.max(0, Math.floor((cx - radius) / res));
  const colEnd = Math.min(width - 1, Math.ceil((cx + radius) / res));
  const rowStart = Math.max(0, Math.floor((cy - radius) / res));
  const rowEnd = Math.min(height - 1, Math.ceil((cy + radius) / res));
  const r2 = radius * radius;

  for (let row = rowStart; row <= rowEnd; row++) {
    const y = (row + 0.5) * res - cy;
    const rowOffset = row * width;
    for (let col = colStart; col <= colEnd; col++) {
      const x = (col + 0.5) * res - cx;
      const d2 = x * x + y * y;
      if (d2 > r2) continue;

      const idx = rowOffset + col;
      const soil = ground[idx];
      // Profil en dôme : plein au centre, effilé sur les bords.
      const localTop = soil + base + (top - base) * Math.sqrt(1 - d2 / r2);
      const localBase = soil + base;

      if (canopyTop[idx] < localTop) canopyTop[idx] = localTop;
      if (canopyBase[idx] === 0 || canopyBase[idx] > localBase) canopyBase[idx] = localBase;
      if (canopyK[idx] < k) canopyK[idx] = k;
      if (localTop > grid.maxHeight) grid.maxHeight = localTop;
    }
  }
}
