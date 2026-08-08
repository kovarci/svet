/**
 * Distribution de luminance du ciel — ciel général normalisé CIE.
 *
 * ── Ce que ce fichier corrige ───────────────────────────────────────────────
 *
 * Le modèle multipliait l'éclairement diffus horizontal par le facteur de vue du
 * ciel : `diffuse = svf × E_diffus`. Cela revient à poser que **le ciel a la même
 * luminance partout**. Il ne l'a jamais.
 *
 * Sous un ciel couvert, le zénith est environ **trois fois plus lumineux que
 * l'horizon** (Moon & Spencer, repris par la CIE). Une ruelle du Marais ne voit
 * qu'une bande de ciel autour du zénith : c'est-à-dire la partie la plus
 * lumineuse. Le facteur de vue du ciel, qui la crédite de 0,25, **sous-estime**
 * ce qu'elle reçoit.
 *
 * Sous un ciel clair, c'est l'inverse et c'est pire : la luminance culmine
 * **autour du soleil** — la région circumsolaire vaut jusqu'à onze fois le fond
 * de ciel — et remonte vers l'horizon. Deux rues de même facteur de vue du ciel,
 * l'une orientée vers le soleil et l'autre à l'opposé, reçoivent des
 * éclairements diffus très différents. L'ancien modèle leur donnait la même
 * valeur, à la seconde près.
 *
 * ── Ce qu'on met à la place ─────────────────────────────────────────────────
 *
 * Le ciel général normalisé de la CIE (ISO 15469:2004 / CIE S 011), la référence
 * pour ce calcul. La luminance relative d'un élément de ciel s'écrit
 *
 *     L(Z, χ) / L_z = [ φ(Z) · f(χ) ] / [ φ(0) · f(Z_s) ]
 *
 * avec Z l'angle zénithal de l'élément, Z_s celui du soleil, χ la distance
 * angulaire entre les deux, et deux fonctions tabulées :
 *
 *     gradation   φ(Z) = 1 + a · exp(b / cos Z)      — variation zénith/horizon
 *     indicatrice f(χ) = 1 + c · [exp(d·χ) − exp(d·π/2)] + e · cos²χ
 *                                                     — renforcement circumsolaire
 *
 * On intègre cette luminance sur la portion de ciel **réellement visible**,
 * lue dans le profil d'horizon de seize secteurs que le pipeline stocke déjà
 * pour chaque trottoir. Aucune donnée nouvelle n'est nécessaire : le calcul
 * d'ombre n'est pas refait, on lit mieux ce qui était déjà mesuré.
 *
 * ── Ce qui reste calibré à l'identique ──────────────────────────────────────
 *
 * Le résultat est **normalisé sur le ciel ouvert** : en site dégagé, le facteur
 * vaut exactement 1 et l'éclairement diffus reste celui qu'annonce la météo. On
 * ne déplace pas le niveau général, on corrige seulement la répartition — et
 * pour un ciel uniforme, le facteur redonne exactement le facteur de vue du
 * ciel d'avant. C'est un raffinement strict, pas un remplacement.
 */

const D2R = Math.PI / 180;

/**
 * Paramètres (a, b, c, d, e) des types de ciel normalisés CIE.
 *
 * On en retient trois des quinze, ceux qui encadrent ce qu'on rencontre :
 *
 *  - **type 1**, couvert normalisé CIE : gradation forte (zénith trois fois
 *    l'horizon), aucune trace du soleil — `c = 0` annule l'indicatrice.
 *  - **type 7**, ciel intermédiaire : gradation nulle, circumsolaire modéré.
 *  - **type 12**, ciel clair d'atmosphère polluée : c'est le ciel parisien clair,
 *    pas celui d'un observatoire d'altitude. Gradation douce, forte indicatrice.
 *
 * Le passage de l'un à l'autre se fait en fondu, jamais par palier : un seuil
 * ferait sauter les couleurs de toute la carte quand la nébulosité annoncée
 * franchit une valeur ronde.
 */
export const SKY_TYPES = {
  /** Type 1 — couvert normalisé CIE : zénith trois fois l'horizon, pas de soleil. */
  overcast: { a: 4.0, b: -0.7, c: 0, d: -1.0, e: 0.0 },
  /** Type 3 — couvert à gradation modérée. */
  denseOvercast: { a: 1.1, b: -0.8, c: 0, d: -1.0, e: 0.0 },
  /** Type 5 — luminance uniforme. Le ciel que supposait l'ancien modèle. */
  uniform: { a: 0.0, b: -1.0, c: 0, d: -1.0, e: 0.0 },
  /** Type 7 — intermédiaire, circumsolaire modéré. */
  intermediate: { a: 0.0, b: -1.0, c: 5, d: -2.5, e: 0.3 },
  /** Type 8 — intermédiaire à soleil marqué. */
  brightIntermediate: { a: 0.0, b: -1.0, c: 10, d: -3.0, e: 0.45 },
  /** Type 10 — partiellement nuageux, soleil net. */
  partlyCloudy: { a: -1.0, b: -0.55, c: 5, d: -2.5, e: 0.3 },
  /** Type 11 — partiellement nuageux, circumsolaire fort. */
  brightPartly: { a: -1.0, b: -0.55, c: 10, d: -3.0, e: 0.45 },
  /** Type 12 — ciel clair d'atmosphère polluée : le ciel parisien dégagé. */
  clear: { a: -1.0, b: -0.32, c: 10, d: -3.0, e: 0.45 },
};

/**
 * Correspondance entre la clarté de Perez et les types de ciel CIE.
 *
 * La sélection se faisait sur `directShare`, une grandeur maison. ε est
 * l'indice normalisé pour cela : il compare le global au diffus en corrigeant de
 * la hauteur du soleil, et toute la littérature d'éclairage naturel s'en sert.
 * Les huit catégories de Perez couvrent le couvert dense (ε ≈ 1) au ciel bleu
 * franc (ε > 6) ; on les rattache aux types CIE de gradation et d'indicatrice
 * comparables.
 *
 * Les ancres sont les milieux de catégorie, et l'on interpole entre les deux qui
 * encadrent — jamais de palier : un seuil ferait sauter les couleurs de toute la
 * carte quand la météo franchit une valeur ronde.
 */
const EPSILON_ANCHORS = [
  [1.0, 'overcast'],
  [1.15, 'denseOvercast'],
  [1.36, 'uniform'],
  [1.72, 'intermediate'],
  [2.37, 'brightIntermediate'],
  [3.65, 'partlyCloudy'],
  [5.35, 'brightPartly'],
  [7.0, 'clear'],
];

/**
 * Pas d'intégration en élévation, en degrés.
 *
 * Deux degrés suffisent : le renforcement circumsolaire décroît en exp(−3χ), il
 * s'étale donc sur des dizaines de degrés, et le profil d'horizon lui-même n'est
 * stocké qu'au degré près.
 */
const ELEVATION_STEP = 2;
const ELEVATION_BANDS = 90 / ELEVATION_STEP;

/** Sous-échantillons d'azimut par secteur, pour ne pas manquer le pic circumsolaire. */
const AZIMUTH_SAMPLES = 3;

/**
 * Résolution de la table des surfaces verticales, plus grossière.
 *
 * Un plan vertical intègre sur un demi-tour d'azimut, là où un plan horizontal
 * se contente de son secteur : à résolution égale la table coûterait seize fois
 * plus. Or elle sert à un terme moins vif — un mur voit un ciel étalé, jamais le
 * pic circumsolaire concentré dans quelques degrés.
 */
const WALL_ELEVATION_STEP = 3;
const WALL_ELEVATION_BANDS = 90 / WALL_ELEVATION_STEP;
const WALL_AZIMUTH_SAMPLES = 8;

function gradation(type, cosZenith) {
  // `cos Z` tend vers zéro à l'horizon ; `b` étant négatif, l'exponentielle tend
  // vers zéro et φ vers 1. Le plancher évite seulement la division par zéro.
  return 1 + type.a * Math.exp(type.b / Math.max(cosZenith, 0.01));
}

function indicatrix(type, chi) {
  return (
    1 +
    type.c * (Math.exp(type.d * chi) - Math.exp((type.d * Math.PI) / 2)) +
    type.e * Math.cos(chi) * Math.cos(chi)
  );
}

/**
 * Table cumulée d'un type de ciel : pour chaque secteur d'azimut, l'éclairement
 * horizontal apporté par la portion de ciel située **au-dessus** d'une élévation
 * donnée.
 *
 * Cumulée depuis le zénith vers l'horizon : la valeur au rang k est l'intégrale
 * sur tout le ciel plus haut que k·pas. Lire le profil d'horizon revient alors à
 * un accès indexé, ce qui compte — l'itinéraire évalue des dizaines de milliers
 * d'arêtes, et cette table est calculée une fois par instant, pas une fois par
 * trottoir.
 *
 * Normalisée pour que la somme des secteurs à horizon nul vaille exactement 1.
 */
function cumulativeTable(type, sunAltitude, sunAzimuth, bins) {
  const sunZenith = Math.PI / 2 - Math.max(sunAltitude, 0);
  const cosSunZenith = Math.cos(sunZenith);
  const sinSunZenith = Math.sin(sunZenith);
  const normal = gradation(type, 1) * indicatrix(type, sunZenith);

  const table = new Float64Array(bins * (ELEVATION_BANDS + 1));
  // Mesures explicites de l'angle solide : sans elles, la table verticale — qui
  // balaie un demi-tour d'azimut avec un autre pas — ne serait pas comparable à
  // celle-ci, et le rapport des deux n'aurait aucun sens physique.
  const dPhi = (2 * Math.PI) / bins / AZIMUTH_SAMPLES;
  const dZ = ELEVATION_STEP * D2R;
  let total = 0;

  for (let sector = 0; sector < bins; sector++) {
    // On accumule du zénith vers l'horizon, puis on relit à l'envers : la valeur
    // au rang k doit contenir tout ce qui est au-dessus de l'élévation k.
    const band = new Float64Array(ELEVATION_BANDS);

    for (let k = 0; k < ELEVATION_BANDS; k++) {
      // Centre de la bande d'élévation, converti en angle zénithal.
      const elevation = (k + 0.5) * ELEVATION_STEP * D2R;
      const zenith = Math.PI / 2 - elevation;
      const cosZenith = Math.cos(zenith);
      const sinZenith = Math.sin(zenith);

      let sum = 0;
      for (let s = 0; s < AZIMUTH_SAMPLES; s++) {
        const azimuth = ((sector + (s + 0.5) / AZIMUTH_SAMPLES) * 2 * Math.PI) / bins;
        const cosChi = Math.max(
          -1,
          Math.min(
            1,
            cosSunZenith * cosZenith + sinSunZenith * sinZenith * Math.cos(azimuth - sunAzimuth),
          ),
        );
        const relative =
          (gradation(type, cosZenith) * indicatrix(type, Math.acos(cosChi))) / normal;
        // `cos Z` : projection sur le plan horizontal. `sin Z` : l'angle solide
        // d'une bande d'élévation, qui s'amincit vers le zénith.
        sum += Math.max(0, relative) * cosZenith * sinZenith;
      }

      band[k] = sum * dPhi * dZ;
      total += band[k];
    }

    // Cumul depuis l'horizon vers le zénith, écrit à l'envers.
    const base = sector * (ELEVATION_BANDS + 1);
    table[base + ELEVATION_BANDS] = 0;
    for (let k = ELEVATION_BANDS - 1; k >= 0; k--) {
      table[base + k] = table[base + k + 1] + band[k];
    }
  }

  if (total > 0) for (let i = 0; i < table.length; i++) table[i] /= total;
  return { table, total };
}

/**
 * Table cumulée pour une **surface verticale**, un plan par secteur d'horizon.
 *
 * Le modèle posait « un mur ne voit qu'un demi-ciel », soit 0,5 × E_diffus, pour
 * tous les murs de toutes les rues. C'est exact pour un mur isolé sous un ciel
 * uniforme, et faux dès que le ciel a une structure : deux façades à l'ombre,
 * l'une tournée vers la moitié lumineuse du ciel et l'autre à l'opposé, ne
 * reçoivent pas le même éclairement — et c'est tout ce qu'elles reçoivent.
 *
 * L'intégrande change de deux façons par rapport au plan horizontal :
 * `cos Z` devient `sin Z · cos(φ − φₙ)` — la projection sur une normale
 * horizontale — et l'azimut ne balaie qu'un demi-tour, le mur ne voyant rien
 * derrière lui.
 *
 * Normalisée par le **même total horizontal** que l'autre table : le facteur
 * rendu se multiplie donc directement par l'éclairement diffus horizontal. Sous
 * ciel uniforme et sans obstruction il vaut exactement 0,5, ce qui redonne la
 * formule d'avant — la nouvelle physique contient l'ancienne.
 */
function verticalTable(type, sunAltitude, sunAzimuth, bins, horizontalTotal) {
  const sunZenith = Math.PI / 2 - Math.max(sunAltitude, 0);
  const cosSunZenith = Math.cos(sunZenith);
  const sinSunZenith = Math.sin(sunZenith);
  const normal = gradation(type, 1) * indicatrix(type, sunZenith);

  const table = new Float64Array(bins * (WALL_ELEVATION_BANDS + 1));
  const dPhi = Math.PI / WALL_AZIMUTH_SAMPLES;
  const dZ = WALL_ELEVATION_STEP * D2R;

  for (let sector = 0; sector < bins; sector++) {
    // La normale du mur pointe vers le piéton : le secteur donne la direction
    // du mur vu du piéton, la normale est donc à l'opposé.
    const wallNormal = (2 * Math.PI * sector) / bins + Math.PI;
    const band = new Float64Array(WALL_ELEVATION_BANDS);

    for (let k = 0; k < WALL_ELEVATION_BANDS; k++) {
      const elevation = (k + 0.5) * WALL_ELEVATION_STEP * D2R;
      const zenith = Math.PI / 2 - elevation;
      const cosZenith = Math.cos(zenith);
      const sinZenith = Math.sin(zenith);

      let sum = 0;
      for (let s = 0; s < WALL_AZIMUTH_SAMPLES; s++) {
        // Un demi-tour centré sur la normale, le mur ne voyant pas derrière lui.
        const offset = -Math.PI / 2 + ((s + 0.5) * Math.PI) / WALL_AZIMUTH_SAMPLES;
        const azimuth = wallNormal + offset;
        const cosChi = Math.max(
          -1,
          Math.min(
            1,
            cosSunZenith * cosZenith + sinSunZenith * sinZenith * Math.cos(azimuth - sunAzimuth),
          ),
        );
        const relative =
          (gradation(type, cosZenith) * indicatrix(type, Math.acos(cosChi))) / normal;
        // `sin Z · cos(φ − φₙ)` : projection sur la normale horizontale.
        // `sin Z` : l'angle solide de la bande. D'où le carré.
        sum += Math.max(0, relative) * sinZenith * sinZenith * Math.cos(offset);
      }
      band[k] = sum * dPhi * dZ;
    }

    const base = sector * (WALL_ELEVATION_BANDS + 1);
    table[base + WALL_ELEVATION_BANDS] = 0;
    for (let k = WALL_ELEVATION_BANDS - 1; k >= 0; k--) {
      table[base + k] = table[base + k + 1] + band[k];
    }
  }

  if (horizontalTotal > 0) for (let i = 0; i < table.length; i++) table[i] /= horizontalTotal;
  return table;
}

/**
 * Poids relatif des trois types de ciel, d'après la part directionnelle de la
 * lumière — 0 sous la couche, 1 par ciel franchement clair.
 *
 * Le fondu porte sur les tables déjà normalisées, donc sur des distributions
 * d'éclairement, et non sur les paramètres (a, b, c, d, e) : interpoler ceux-ci
 * donnerait un ciel qui n'est aucun de ceux que la CIE décrit.
 */
function typeWeights(epsilon) {
  const e = Math.max(EPSILON_ANCHORS[0][0], Math.min(EPSILON_ANCHORS.at(-1)[0], epsilon));

  for (let i = 1; i < EPSILON_ANCHORS.length; i++) {
    const [high, upper] = EPSILON_ANCHORS[i];
    if (e > high) continue;
    const [low, lower] = EPSILON_ANCHORS[i - 1];
    // Interpolation sur le logarithme : les catégories de Perez sont espacées
    // géométriquement, pas linéairement.
    const t = (Math.log(e) - Math.log(low)) / (Math.log(high) - Math.log(low));
    return { [lower]: 1 - t, [upper]: t };
  }
  return { [EPSILON_ANCHORS.at(-1)[1]]: 1 };
}

/**
 * Prépare la lecture du ciel pour un instant donné.
 *
 * À construire **une fois par instant**, jamais par trottoir : c'est là tout
 * l'intérêt de la table cumulée. Le résultat expose `factor(horizon)`, qui ne
 * coûte plus que seize lectures indexées.
 *
 * @param {object} p
 * @param {number} p.altitude hauteur du soleil, en radians
 * @param {number} p.azimuth azimut du soleil, en radians depuis le nord
 * @param {number} p.epsilon clarté de Perez : 1 sous la couche, > 6 par ciel bleu
 * @param {number} [p.bins] nombre de secteurs du profil d'horizon
 */
export function skyDistribution({ altitude, azimuth, epsilon, bins = 16 }) {
  const weights = typeWeights(Number.isFinite(epsilon) ? epsilon : 1);
  const blended = new Float64Array(bins * (ELEVATION_BANDS + 1));
  const blendedWall = new Float64Array(bins * (WALL_ELEVATION_BANDS + 1));

  for (const [name, weight] of Object.entries(weights)) {
    if (weight <= 0) continue;
    const { table, total } = cumulativeTable(SKY_TYPES[name], altitude, azimuth, bins);
    for (let i = 0; i < blended.length; i++) blended[i] += weight * table[i];

    const wall = verticalTable(SKY_TYPES[name], altitude, azimuth, bins, total);
    for (let i = 0; i < blendedWall.length; i++) blendedWall[i] += weight * wall[i];
  }

  return {
    bins,

    /**
     * Part de l'éclairement diffus horizontal que reçoit la **façade** du
     * secteur donné, l'obstruction d'en face déduite.
     *
     * Vaut 0,5 pour un mur isolé sous ciel uniforme — exactement la constante
     * qu'employait le modèle, qui la servait à tous les murs de toutes les rues.
     *
     * @param {number} sector rang du secteur d'horizon
     * @param {number} blockingElevationDeg élévation de l'obstacle vu du mur, en degrés
     */
    wallFactor(sector, blockingElevationDeg) {
      const base = (sector % bins) * (WALL_ELEVATION_BANDS + 1);
      const position = Math.max(
        0,
        Math.min(WALL_ELEVATION_BANDS, blockingElevationDeg / WALL_ELEVATION_STEP),
      );
      const k = Math.floor(position);
      const next = Math.min(WALL_ELEVATION_BANDS, k + 1);
      return (
        blendedWall[base + k] + (blendedWall[base + next] - blendedWall[base + k]) * (position - k)
      );
    },
    /**
     * Part de l'éclairement diffus de ciel ouvert qui atteint réellement ce
     * point, d'après son profil d'horizon. Vaut 1 en site dégagé.
     *
     * @param {ArrayLike<number>} horizon élévation de l'horizon par secteur, en degrés
     */
    factor(horizon) {
      if (!horizon || horizon.length !== bins) return null;
      let sum = 0;
      for (let sector = 0; sector < bins; sector++) {
        const base = sector * (ELEVATION_BANDS + 1);
        const position = Math.max(0, Math.min(ELEVATION_BANDS, horizon[sector] / ELEVATION_STEP));
        const k = Math.floor(position);
        // Interpolation entre deux bandes : sans elle, le profil étant stocké au
        // degré près, la couleur d'une rue sauterait d'un cran à l'autre.
        const next = Math.min(ELEVATION_BANDS, k + 1);
        sum += blended[base + k] + (blended[base + next] - blended[base + k]) * (position - k);
      }
      return sum;
    },
  };
}

/**
 * Facteur de vue du ciel géométrique du même profil, pour comparaison.
 *
 * C'est exactement ce que le modèle utilisait : la fraction de ciel visible,
 * cos²β par secteur, sans aucune considération de luminance. On le garde parce
 * qu'il reste la bonne grandeur pour ce qui est purement géométrique — la part
 * d'UV diffus reçue, par exemple, où le ciel est bien plus uniforme.
 */
export function geometricSkyView(horizon) {
  if (!horizon || horizon.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < horizon.length; i++) {
    const cos = Math.cos(Math.max(0, Math.min(90, horizon[i])) * D2R);
    sum += cos * cos;
  }
  return sum / horizon.length;
}
