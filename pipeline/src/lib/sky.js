/**
 * Distribution de luminance du ciel.
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
 * **autour du soleil** et remonte vers l'horizon. Deux rues de même facteur de
 * vue du ciel, l'une orientée vers le soleil et l'autre à l'opposé, reçoivent
 * des éclairements diffus très différents.
 *
 * ── Le modèle : Perez « toutes conditions » ─────────────────────────────────
 *
 * La luminance relative d'un élément de ciel s'écrit
 *
 *     L(Z, χ) ∝ [1 + a · exp(b / cos Z)] · [1 + c · exp(d·χ) + e · cos²χ]
 *
 * avec Z l'angle zénithal de l'élément et χ sa distance angulaire au soleil.
 * C'est la forme du ciel général normalisé de la CIE (ISO 15469), et celle du
 * modèle de Perez, Seals & Michalsky (*Solar Energy* 50, 1993), qui en calcule
 * les cinq coefficients **depuis les flux mesurés** — clarté ε, luminosité Δ et
 * hauteur du soleil. C'est le modèle de `gendaylit`, dans Radiance, la
 * référence de la simulation d'éclairage naturel.
 *
 * Il remplace un fondu entre huit des quinze types CIE, choisis d'après ε
 * seul : la luminosité Δ n'y servait pas, alors qu'elle distingue un couvert
 * lumineux d'un couvert d'orage à ε égal. Les types CIE restent ici, comme
 * repli et comme référence pour les tests.
 *
 * ── Trois intégrales sur la même grille ─────────────────────────────────────
 *
 * On échantillonne la luminance une fois par instant, sur une grille de secteurs
 * d'azimut et de bandes d'élévation. Trois lectures en sortent :
 *
 *  - le **plan horizontal** du piéton, qui reçoit l'éclairement diffus ;
 *  - le **plan vertical** d'une façade, qui reçoit le ciel de son demi-espace ;
 *  - le **plan vertical de l'œil**, tourné dans le sens de la marche.
 *
 * Toutes trois sont normalisées par le même total horizontal : elles se
 * multiplient directement par l'éclairement diffus horizontal annoncé.
 */

const D2R = Math.PI / 180;

/**
 * Paramètres (a, b, c, d, e) de quelques types de ciel normalisés CIE
 * (ISO 15469:2004 / CIE S 011). Repli, quand on ne connaît pas la luminosité.
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

/** Ancres du repli CIE sur la clarté de Perez, milieux de catégorie. */
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
 * Coefficients du modèle de Perez (1993), par catégorie de clarté : pour chacun
 * des cinq paramètres, quatre nombres (x₀, x₁, x₂, x₃) tels que
 * `p = x₀ + x₁·Z + Δ·(x₂ + x₃·Z)`. Recopiés de `gendaylit` (Radiance).
 *
 * La première catégorie, le couvert, a ses propres formes pour c et d.
 */
const PEREZ_COEFFICIENTS = [
  [
    [1.3525, -0.2576, -0.269, -1.4366],
    [-0.767, 0.0007, 1.2734, -0.1233],
    [2.8, 0.6004, 1.2375, 1],
    [1.8734, 0.6297, 0.9738, 0.2809],
    [0.0356, -0.1246, -0.5718, 0.9938],
  ],
  [
    [-1.2219, -0.773, 1.4148, 1.1016],
    [-0.2054, 0.0367, -3.9128, 0.9156],
    [6.975, 0.1774, 6.4477, -0.1239],
    [-1.5798, -0.5081, -1.7812, 0.108],
    [0.2624, 0.0672, -0.219, -0.4285],
  ],
  [
    [-1.1, -0.2515, 0.8952, 0.0156],
    [0.2782, -0.1812, -4.5, 1.1766],
    [24.7219, -13.0812, -37.7, 34.8438],
    [-5, 1.5218, 3.9229, -2.6204],
    [-0.0156, 0.1597, 0.4199, -0.5562],
  ],
  [
    [-0.5484, -0.6654, -0.2672, 0.7117],
    [0.7234, -0.6219, -5.6812, 2.6297],
    [33.3389, -18.3, -62.25, 52.0781],
    [-3.5, 0.0016, 1.1477, 0.1062],
    [0.4659, -0.3296, -0.0876, -0.0329],
  ],
  [
    [-0.6, -0.3566, -2.5, 2.325],
    [0.2937, 0.0496, -5.6812, 1.8415],
    [21, -4.7656, -21.5906, 7.2492],
    [-3.5, -0.1554, 1.4062, 0.3988],
    [0.0032, 0.0766, -0.0656, -0.1294],
  ],
  [
    [-1.0156, -0.367, 1.0078, 1.4051],
    [0.2875, -0.5328, -3.85, 3.375],
    [14, -0.9999, -7.1406, 7.5469],
    [-3.4, -0.1078, -1.075, 1.5702],
    [-0.0672, 0.4016, 0.3017, -0.4844],
  ],
  [
    [-1, 0.0211, 0.5025, -0.5119],
    [-0.3, 0.1922, 0.7023, -1.6317],
    [19, -5, 1.2438, -1.9094],
    [-4, 0.025, 0.3844, 0.2656],
    [1.0468, -0.3788, -2.4517, 1.4656],
  ],
  [
    [-1.05, 0.0289, 0.426, 0.359],
    [-0.325, 0.1156, 0.7781, 0.0025],
    [31.0625, -14.5, -46.1148, 55.375],
    [-7.2312, 0.405, 13.35, 0.6234],
    [1.5, -0.6426, 1.8564, 0.5636],
  ],
];

const PEREZ_BOUNDS = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];

/**
 * Paramètres du ciel de Perez pour un instant, à la manière de `gendaylit`.
 *
 * Deux garde-fous de `gendaylit` sont repris tels quels : ε borné à [1, 12], et
 * Δ relevé à 0,2 dans les catégories 2 à 5, où le modèle produit sinon des
 * luminances négatives.
 *
 * @param {number} epsilon clarté de Perez
 * @param {number} brightness luminosité de Perez
 * @param {number} sunZenith angle zénithal du soleil, en radians
 */
export function perezParameters(epsilon, brightness, sunZenith) {
  const e = Math.max(1, Math.min(12, epsilon));
  let delta = Math.max(0.01, Math.min(0.6, brightness));
  if (e > 1.065 && e < 2.8) delta = Math.max(0.2, delta);
  let category = 0;
  while (category < PEREZ_BOUNDS.length && e >= PEREZ_BOUNDS[category]) category++;
  const x = PEREZ_COEFFICIENTS[category];
  const Z = sunZenith;
  const linear = (row) => row[0] + row[1] * Z + delta * (row[2] + row[3] * Z);

  if (category === 0) {
    return {
      a: linear(x[0]),
      b: linear(x[1]),
      c: Math.exp(Math.pow(delta * (x[2][0] + x[2][1] * Z), x[2][2])) - x[2][3],
      d: -Math.exp(delta * (x[3][0] + x[3][1] * Z)) + x[3][2] + delta * x[3][3],
      e: linear(x[4]),
      perez: true,
    };
  }
  return {
    a: linear(x[0]),
    b: linear(x[1]),
    c: linear(x[2]),
    d: linear(x[3]),
    e: linear(x[4]),
    perez: true,
  };
}

/** Pas d'intégration en élévation, en degrés. */
const ELEVATION_STEP = 2;
const ELEVATION_BANDS = 90 / ELEVATION_STEP;

/** Sous-échantillons d'azimut par secteur, pour ne pas manquer le pic circumsolaire. */
const AZIMUTH_SAMPLES = 3;

function gradation(type, cosZenith) {
  // `cos Z` tend vers zéro à l'horizon ; `b` étant négatif, l'exponentielle tend
  // vers zéro et φ vers 1. Le plancher évite seulement la division par zéro.
  return 1 + type.a * Math.exp(type.b / Math.max(cosZenith, 0.01));
}

function indicatrix(type, chi) {
  // La CIE retranche exp(d·π/2) pour que l'indicatrice vaille 1 + e·0 à 90° du
  // soleil ; Perez ne le fait pas. La normalisation finale efface l'écart d'un
  // facteur constant, mais pas celui de forme : on garde chacun sa définition.
  const offset = type.perez ? 0 : Math.exp((type.d * Math.PI) / 2);
  return 1 + type.c * (Math.exp(type.d * chi) - offset) + type.e * Math.cos(chi) * Math.cos(chi);
}

/**
 * Luminance relative échantillonnée sur la grille, pour un type de ciel.
 *
 * Rendue normalisée : la somme pondérée par `cos Z · sin Z` — l'éclairement d'un
 * plan horizontal sous le ciel entier — vaut exactement 1.
 */
function sampleLuminance(type, sunAltitude, sunAzimuth, bins) {
  const sunZenith = Math.PI / 2 - Math.max(sunAltitude, 0);
  const cosSunZenith = Math.cos(sunZenith);
  const sinSunZenith = Math.sin(sunZenith);
  const samples = new Float64Array(bins * AZIMUTH_SAMPLES * ELEVATION_BANDS);
  const dPhi = (2 * Math.PI) / bins / AZIMUTH_SAMPLES;
  const dZ = ELEVATION_STEP * D2R;
  let total = 0;

  for (let sector = 0; sector < bins; sector++) {
    for (let s = 0; s < AZIMUTH_SAMPLES; s++) {
      // Le secteur est **centré** sur son azimut : le profil d'horizon est relevé
      // par un rayon tiré à 2π·s/n exactement (voir `shadow.js`). L'intégration
      // couvrait [s, s+1[, décalée d'un demi-secteur — 5,6° — sur ce qu'elle
      // prétendait lire.
      const azimuth = ((sector - 0.5 + (s + 0.5) / AZIMUTH_SAMPLES) * 2 * Math.PI) / bins;
      const cosDelta = Math.cos(azimuth - sunAzimuth);
      for (let k = 0; k < ELEVATION_BANDS; k++) {
        const elevation = (k + 0.5) * ELEVATION_STEP * D2R;
        const cosZenith = Math.sin(elevation);
        const sinZenith = Math.cos(elevation);
        const cosChi = Math.max(
          -1,
          Math.min(1, cosSunZenith * cosZenith + sinSunZenith * sinZenith * cosDelta),
        );
        // Une luminance négative n'a pas de sens physique ; le modèle de Perez en
        // produit au ras de l'horizon pour quelques combinaisons, que `gendaylit`
        // écrête de même.
        const value = Math.max(0, gradation(type, cosZenith) * indicatrix(type, Math.acos(cosChi)));
        const index = (sector * AZIMUTH_SAMPLES + s) * ELEVATION_BANDS + k;
        samples[index] = value;
        total += value * cosZenith * sinZenith * dPhi * dZ;
      }
    }
  }
  if (total > 0) for (let i = 0; i < samples.length; i++) samples[i] /= total;
  return samples;
}

/**
 * Pondération du repli CIE d'après la clarté de Perez. Le fondu porte sur les
 * luminances normalisées, jamais sur les paramètres (a, b, c, d, e) :
 * interpoler ceux-ci donnerait un ciel qui n'est aucun de ceux que la CIE décrit.
 */
function typeWeights(epsilon) {
  const e = Math.max(EPSILON_ANCHORS[0][0], Math.min(EPSILON_ANCHORS.at(-1)[0], epsilon));
  for (let i = 1; i < EPSILON_ANCHORS.length; i++) {
    const [high, upper] = EPSILON_ANCHORS[i];
    if (e > high) continue;
    const [low, lower] = EPSILON_ANCHORS[i - 1];
    const t = (Math.log(e) - Math.log(low)) / (Math.log(high) - Math.log(low));
    return [
      [SKY_TYPES[lower], 1 - t],
      [SKY_TYPES[upper], t],
    ];
  }
  return [[SKY_TYPES[EPSILON_ANCHORS.at(-1)[1]], 1]];
}

/**
 * Prépare la lecture du ciel pour un instant donné.
 *
 * À construire **une fois par instant**, jamais par trottoir. Les tables des
 * plans verticaux se construisent à la demande, une par orientation, et restent
 * en mémoire le temps de l'instant.
 *
 * @param {object} p
 * @param {number} p.altitude hauteur du soleil, en radians
 * @param {number} p.azimuth azimut du soleil, en radians depuis le nord
 * @param {number} p.epsilon clarté de Perez
 * @param {number} [p.brightness] luminosité de Perez ; sans elle, repli CIE
 * @param {number} [p.bins] nombre de secteurs du profil d'horizon
 * @param {object} [p.type] type de ciel imposé (a, b, c, d, e) — tests
 */
export function skyDistribution({ altitude, azimuth, epsilon, brightness, bins = 16, type }) {
  const sources = type
    ? [[type, 1]]
    : Number.isFinite(brightness)
      ? [[perezParameters(epsilon, brightness, Math.PI / 2 - Math.max(altitude, 0)), 1]]
      : typeWeights(Number.isFinite(epsilon) ? epsilon : 1);

  const samples = new Float64Array(bins * AZIMUTH_SAMPLES * ELEVATION_BANDS);
  for (const [sky, weight] of sources) {
    if (weight <= 0) continue;
    const part = sampleLuminance(sky, altitude, azimuth, bins);
    for (let i = 0; i < samples.length; i++) samples[i] += weight * part[i];
  }

  const dPhi = (2 * Math.PI) / bins / AZIMUTH_SAMPLES;
  const dZ = ELEVATION_STEP * D2R;
  const bandCos = new Float64Array(ELEVATION_BANDS);
  const bandSin = new Float64Array(ELEVATION_BANDS);
  for (let k = 0; k < ELEVATION_BANDS; k++) {
    const elevation = (k + 0.5) * ELEVATION_STEP * D2R;
    bandCos[k] = Math.sin(elevation); // cos Z
    bandSin[k] = Math.cos(elevation); // sin Z
  }

  // Plan horizontal : pour chaque secteur, cumul de l'éclairement apporté par le
  // ciel situé au-dessus de chaque élévation. Lire le profil d'horizon revient
  // alors à un accès indexé.
  const horizontal = new Float64Array(bins * (ELEVATION_BANDS + 1));
  for (let sector = 0; sector < bins; sector++) {
    const base = sector * (ELEVATION_BANDS + 1);
    for (let k = ELEVATION_BANDS - 1; k >= 0; k--) {
      let band = 0;
      for (let s = 0; s < AZIMUTH_SAMPLES; s++) {
        band += samples[(sector * AZIMUTH_SAMPLES + s) * ELEVATION_BANDS + k];
      }
      horizontal[base + k] = horizontal[base + k + 1] + band * bandCos[k] * bandSin[k] * dPhi * dZ;
    }
  }

  // Plans verticaux, un par orientation de secteur. `sin Z · cos(φ − φₙ)` est
  // la projection sur une normale horizontale, `sin Z` l'angle solide de la
  // bande : d'où le carré. Seule la moitié du ciel qui fait face au plan compte.
  //
  // Construits d'un bloc au premier usage, dans un tableau plat : une `Map` de
  // tables par orientation coûtait deux recherches par secteur de mur, soit la
  // moitié du temps de calcul d'un trottoir.
  const stride = ELEVATION_BANDS + 1;
  let eye = null;
  let uniform = null;
  const buildVertical = () => {
    eye = new Float64Array(bins * bins * stride);
    uniform = new Float64Array(bins * stride);
    const projection = new Float64Array(AZIMUTH_SAMPLES);
    for (let facing = 0; facing < bins; facing++) {
      const normal = (2 * Math.PI * facing) / bins;
      const wall = facing * stride;
      for (let sector = 0; sector < bins; sector++) {
        const base = (facing * bins + sector) * stride;
        let any = false;
        for (let s = 0; s < AZIMUTH_SAMPLES; s++) {
          const azimuth = ((sector - 0.5 + (s + 0.5) / AZIMUTH_SAMPLES) * 2 * Math.PI) / bins;
          projection[s] = Math.max(0, Math.cos(azimuth - normal));
          any ||= projection[s] > 0;
        }
        if (!any) continue;
        for (let k = ELEVATION_BANDS - 1; k >= 0; k--) {
          let band = 0;
          for (let s = 0; s < AZIMUTH_SAMPLES; s++) {
            band += samples[(sector * AZIMUTH_SAMPLES + s) * ELEVATION_BANDS + k] * projection[s];
          }
          const value = band * bandSin[k] * bandSin[k] * dPhi * dZ;
          eye[base + k] = eye[base + k + 1] + value;
          uniform[wall + k] += value;
        }
      }
      // Somme sur tous les secteurs, à obstruction uniforme : ce que voit une façade.
      for (let k = ELEVATION_BANDS - 1; k >= 0; k--) uniform[wall + k] += uniform[wall + k + 1];
    }
  };

  const read = (table, base, elevationDeg) => {
    if (Number.isInteger(elevationDeg) && (elevationDeg & 1) === 0 && elevationDeg >= 0) {
      return table[base + Math.min(ELEVATION_BANDS, elevationDeg >> 1)];
    }
    const position = Math.max(0, Math.min(ELEVATION_BANDS, elevationDeg / ELEVATION_STEP));
    const k = Math.floor(position);
    const next = Math.min(ELEVATION_BANDS, k + 1);
    return table[base + k] + (table[base + next] - table[base + k]) * (position - k);
  };

  /** Rang de l'orientation verticale la plus proche en dessous, et l'écart. */
  const facingOf = (heading) => {
    let position = (heading / (2 * Math.PI)) * bins;
    position -= Math.floor(position / bins) * bins;
    const i = Math.floor(position);
    return { i, j: i + 1 === bins ? 0 : i + 1, t: position - i };
  };

  return {
    bins,

    /**
     * Part de l'éclairement diffus de ciel ouvert qui atteint le **plan
     * horizontal** du piéton, d'après son profil d'horizon. Vaut 1 en site
     * dégagé.
     *
     * @param {ArrayLike<number>} horizon élévation de l'horizon par secteur, en degrés
     */
    factor(horizon) {
      if (!horizon || horizon.length !== bins) return null;
      let sum = 0;
      for (let sector = 0; sector < bins; sector++) {
        sum += read(horizontal, sector * stride, horizon[sector]);
      }
      return sum;
    },

    /**
     * Part de l'éclairement diffus horizontal que reçoit une **façade** dont la
     * normale pointe vers `normal`, sous une obstruction d'élévation uniforme.
     *
     * Vaut 0,5 pour un mur isolé sous ciel uniforme — la constante qu'employait
     * le modèle pour tous les murs de toutes les rues.
     *
     * @param {number} normal azimut de la normale du mur, en radians
     * @param {number} blockingElevationDeg élévation de l'obstacle vu du mur, en degrés
     */
    wallFactorToward(normal, blockingElevationDeg) {
      if (!uniform) buildVertical();
      const { i, j, t } = facingOf(normal);
      const a = read(uniform, i * stride, blockingElevationDeg);
      const b = read(uniform, j * stride, blockingElevationDeg);
      return a + (b - a) * t;
    },

    /**
     * Même chose, la normale désignée par un rang de secteur — celui d'un mur
     * vu du piéton, sa normale pointant vers lui.
     */
    wallFactor(sector, blockingElevationDeg) {
      return this.wallFactorToward(
        (2 * Math.PI * (sector + bins / 2)) / bins,
        blockingElevationDeg,
      );
    },

    /**
     * Part de l'éclairement diffus horizontal qui atteint **l'œil**, plan
     * vertical tourné vers `heading`, à travers le profil d'horizon.
     *
     * C'est la grandeur de la CIE S 026 : l'éclairement mélanopique se mesure
     * dans le plan vertical, à hauteur d'œil, dans la direction du regard. Vaut
     * 0,5 en site dégagé sous ciel uniforme.
     *
     * @param {number} heading direction du regard, en radians depuis le nord
     * @param {ArrayLike<number>} horizon élévation de l'horizon par secteur, en degrés
     */
    eyeFactor(heading, horizon) {
      if (!horizon || horizon.length !== bins) return null;
      if (!eye) buildVertical();
      const { i, j, t } = facingOf(heading);
      const sum = (facing) => {
        let total = 0;
        const offset = facing * bins * stride;
        for (let sector = 0; sector < bins; sector++) {
          total += read(eye, offset + sector * stride, horizon[sector]);
        }
        return total;
      };
      const a = sum(i);
      return t > 1e-9 ? a + (sum(j) - a) * t : a;
    },
  };
}

/**
 * Facteur de vue du ciel géométrique du même profil, pour comparaison.
 *
 * La fraction de ciel visible, cos²β par secteur, sans aucune considération de
 * luminance. Elle reste la bonne grandeur pour ce qui est purement géométrique —
 * la part d'UV diffus reçue, où le ciel est bien plus uniforme — et c'est elle
 * qui dit, rapportée au facteur de vue mesuré, quelle part du ciel le feuillage
 * retire.
 */
export function geometricSkyView(horizon) {
  if (!horizon || horizon.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < horizon.length; i++) {
    const value = horizon[i];
    if (Number.isInteger(value) && value >= 0 && value <= 90) {
      sum += COS2_DEGREES[value];
    } else {
      const cos = Math.cos(Math.max(0, Math.min(90, value)) * D2R);
      sum += cos * cos;
    }
  }
  return sum / horizon.length;
}

/** cos² au degré entier : le profil d'horizon est stocké en degrés entiers. */
const COS2_DEGREES = Float64Array.from({ length: 91 }, (_, d) => Math.cos(d * D2R) ** 2);
