/**
 * Lancer de rayons sur le MNS : occultation solaire et facteur de vue du ciel.
 *
 * On ne calcule pas d'image d'ombre pour toute la ville — on interroge le MNS
 * uniquement aux points d'échantillonnage du réseau piéton. C'est deux ordres
 * de grandeur moins cher, et c'est exactement ce dont le calcul d'itinéraire a
 * besoin ensuite.
 *
 * Toutes les altitudes sont absolues : `eyeZ` vaut l'altitude du sol au point,
 * plus la hauteur des yeux.
 */

/**
 * Transmission du rayon solaire jusqu'au piéton.
 *
 * @returns {{transmission: number, blocker: 'sky'|'surface'|'canopy'}}
 *   `transmission` vaut 1 en plein soleil, 0 derrière un obstacle opaque
 *   (immeuble ou relief), et une valeur intermédiaire sous un feuillage.
 */
export function sunTransmission(grid, x, y, eyeZ, azimuth, altitude, maxDistance) {
  if (altitude <= 0) return { transmission: 0, blocker: 'sky' };

  const step = grid.res * 0.8;
  const dx = Math.sin(azimuth) * step;
  const dy = Math.cos(azimuth) * step;
  const dz = Math.tan(altitude) * step;

  const { surface, canopyTop, canopyBase, canopyK } = grid;
  let px = x;
  let py = y;
  let rayZ = eyeZ;
  let tau = 0;

  for (let d = step; d <= maxDistance; d += step) {
    px += dx;
    py += dy;
    rayZ += dz;
    // Plus rien ne peut intercepter le rayon au-dessus du point le plus haut.
    if (rayZ > grid.maxHeight) break;

    const idx = grid.index(px, py);
    if (idx < 0) break; // sorti de l'emprise : on suppose le ciel dégagé

    if (surface[idx] > rayZ) {
      return { transmission: 0, blocker: 'surface' };
    }
    if (canopyTop[idx] > rayZ && canopyBase[idx] < rayZ) {
      tau += canopyK[idx] * step;
    }
  }

  const transmission = Math.exp(-tau);
  return { transmission, blocker: transmission < 0.98 ? 'canopy' : 'sky' };
}

/**
 * Facteur de vue du ciel (SVF) : proportion de la voûte céleste visible depuis
 * le point, pondérée par le cosinus. 1 = plein champ, 0,15 = ruelle étroite.
 *
 * Pour un horizon d'élévation uniforme β, SVF = cos²β ; on discrétise sur
 * `azimuths` directions et on moyenne.
 *
 * Le feuillage n'est pas opaque : on calcule le SVF sans les arbres puis avec,
 * et on interpole selon l'opacité effective du houppier.
 *
 * @returns {{svf: number, svfBuilt: number, canopyCover: number}}
 */
export function skyViewFactor(grid, x, y, eyeZ, azimuths, radius, horizonBins = 0) {
  const step = grid.res;
  const { surface, canopyTop, canopyK } = grid;

  let sumBuilt = 0;
  let sumAll = 0;
  // Épaisseur optique du feuillage rencontrée dans chaque direction, pour
  // pondérer l'occultation du ciel par la même loi que le rayon solaire.
  let sumFoliage = 0;
  // Profil d'horizon : l'élévation de l'obstacle dans chaque secteur. Il ne
  // sert pas au SVF, qui n'en garde que la moyenne, mais à la réverbération —
  // savoir *où* sont les murs, et non seulement combien il y en a.
  const horizon = horizonBins > 0 ? new Float32Array(horizonBins) : null;
  const counts = horizonBins > 0 ? new Uint16Array(horizonBins) : null;

  for (let a = 0; a < azimuths; a++) {
    const angle = (2 * Math.PI * a) / azimuths;
    const dx = Math.sin(angle) * step;
    const dy = Math.cos(angle) * step;

    let px = x;
    let py = y;
    let maxTanBuilt = 0;
    let maxTanAll = 0;
    let tau = 0;

    for (let d = step; d <= radius; d += step) {
      px += dx;
      py += dy;
      const idx = grid.index(px, py);
      if (idx < 0) break;

      const hb = surface[idx] - eyeZ;
      if (hb > 0) {
        const t = hb / d;
        if (t > maxTanBuilt) maxTanBuilt = t;
        if (t > maxTanAll) maxTanAll = t;
      }
      const hc = canopyTop[idx] - eyeZ;
      if (hc > 0) {
        const t = hc / d;
        if (t > maxTanAll) maxTanAll = t;
        // Même loi d'extinction que pour le rayon solaire — Beer-Lambert avec
        // le coefficient réel du houppier, saison et essence comprises. On
        // n'accumule que sous l'horizon bâti : au-delà, c'est le mur qui masque.
        if (canopyK) tau += canopyK[idx] * step;
      }
    }

    sumBuilt += cos2(Math.atan(maxTanBuilt));
    sumAll += cos2(Math.atan(maxTanAll));
    sumFoliage += tau;

    if (horizon) {
      // Seul le bâti compte pour la réverbération : un feuillage absorbe la
      // lumière au lieu de la renvoyer.
      const bin = Math.floor((a * horizonBins) / azimuths) % horizonBins;
      horizon[bin] += (Math.atan(maxTanBuilt) * 180) / Math.PI;
      counts[bin]++;
    }
  }

  const svfBuilt = sumBuilt / azimuths;
  const svfOpaqueTrees = sumAll / azimuths;

  // Opacité du feuillage, par la **même loi que le rayon solaire**.
  //
  // On appliquait ici une opacité fixe de 0,65, saison et essence confondues,
  // pendant que la transmission solaire utilisait Beer-Lambert avec un
  // coefficient distinct pour un platane en feuilles, un platane nu et un
  // conifère. Deux modèles de feuillage dans le même calcul, dont l'un ignorait
  // qu'un arbre perd ses feuilles — d'où un facteur de vue du ciel identique en
  // janvier et en juillet sous les mêmes marronniers.
  const meanTau = sumFoliage / azimuths;
  const foliageOpacity = canopyK ? 1 - Math.exp(-meanTau) : 0.65;
  const svf = svfBuilt - (svfBuilt - svfOpaqueTrees) * foliageOpacity;

  if (horizon) {
    for (let i = 0; i < horizonBins; i++) horizon[i] /= Math.max(1, counts[i]);
  }

  return { svf, svfBuilt, canopyCover: Math.max(0, svfBuilt - svfOpaqueTrees), horizon };
}

/**
 * Distance à la première façade en partant de l'axe de la voie, le long d'une
 * normale. Sert à mesurer la largeur réelle de la chaussée plutôt que de la
 * deviner d'après le type de voie.
 *
 * @param {number} nx composante est de la normale (unitaire)
 * @param {number} ny composante nord de la normale (unitaire)
 * @param {number} maxDistance portée de la recherche, en mètres
 * @returns {number} distance en mètres, ou `maxDistance` si rien n'est trouvé
 */
export function distanceToFacade(grid, x, y, groundZ, nx, ny, maxDistance) {
  const step = grid.res;
  const { surface } = grid;
  // Un obstacle de plus de 2 m est une façade ou un mur ; en dessous, c'est du
  // bruit de terrain (bordure, marche, imprécision du MNT).
  const threshold = groundZ + 2;

  for (let d = step; d <= maxDistance; d += step) {
    const idx = grid.index(x + nx * d, y + ny * d);
    if (idx < 0) return maxDistance;
    if (surface[idx] > threshold) return d;
  }
  return maxDistance;
}

function cos2(angle) {
  const c = Math.cos(angle);
  return c * c;
}
