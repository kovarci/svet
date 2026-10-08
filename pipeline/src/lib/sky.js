/**
 * Distribution de luminance du ciel — modèle « tous temps » de Perez, Seals &
 * Michalsky (1993), lue dans le profil d'horizon de chaque trottoir.
 *
 * ── Pourquoi la luminance ───────────────────────────────────────────────────
 *
 * Le modèle multipliait l'éclairement diffus horizontal par le facteur de vue du
 * ciel : `diffus = svf × E_diffus`. Cela revient à poser que **le ciel a la même
 * luminance partout**. Il ne l'a jamais.
 *
 * Sous un ciel couvert, le zénith est environ trois fois plus lumineux que
 * l'horizon (Moon & Spencer) : une ruelle, qui ne voit qu'une bande de ciel
 * autour du zénith, reçoit plus que son facteur de vue du ciel ne l'annonce.
 * Sous un ciel clair, c'est l'inverse et c'est pire : la luminance culmine
 * autour du soleil — la région circumsolaire vaut jusqu'à onze fois le fond de
 * ciel. Deux rues de même facteur de vue du ciel, l'une tournée vers le soleil,
 * l'autre à l'opposé, ne reçoivent pas la même lumière.
 *
 * ── Pourquoi Perez 1993 plutôt que les types CIE ────────────────────────────
 *
 * Une première version mélangeait huit des quinze types de ciel normalisés CIE,
 * choisis par fondu sur la clarté ε. Confrontée à des flux MESURÉS (BSRN
 * Payerne, juin 2016, 2 494 minutes de jour) et à l'intégration fine de la
 * référence, elle sous-estimait de 19 % l'éclairement d'un plan vertical dégagé
 * face au soleil, avec 25 % d'écart-type ; sa luminance zénithale était trop
 * forte de 32 % par rapport au modèle de Perez 1990. Le défaut n'est pas la
 * discrétisation : c'est la **correspondance** ε → type, qui retient des types
 * intermédiaires sous 45° de soleil par ciel parfaitement clair. Le modèle de
 * Perez 1993 est continu en (ε, Δ) — il lit la clarté ET la luminosité du ciel
 * — et ramène l'écart-type à 12,7 %, le biais à +2 %, la luminance zénithale à
 * −2,5 %.
 *
 * Les coefficients sont ceux de Radiance (`gendaylit.c`, LBNL), recopiés puis
 * contrôlés contre le binaire à 5·10⁻⁷ près. La luminance relative s'écrit
 *
 *     L(Z, χ) ∝ [1 + a·exp(b / cos Z)] · [1 + c·exp(d·χ) + e·cos²χ]
 *
 * avec Z l'angle zénithal de l'élément et χ sa distance angulaire au soleil.
 *
 * ── Secteurs centrés ────────────────────────────────────────────────────────
 *
 * Le pipeline tire le rayon du secteur s à l'azimut s·Δ : le secteur couvre
 * [(s − ½)Δ, (s + ½)Δ]. La version précédente intégrait [sΔ, (s+1)Δ] et décalait
 * chaque obstacle d'un demi-pas, soit un point d'écart-type de plus et l'essentiel
 * du biais ; au pire — un canyon de rapport 2 tourné de 60° — 5,3 % au lieu de
 * 1,7 %. Les poids d'angle solide sont les intégrales exactes de chaque cellule :
 * un ciel uniforme redonne exactement 1 (plan horizontal) et 0,5 (plan vertical
 * dégagé).
 *
 * ── Ce que l'on peut lire ───────────────────────────────────────────────────
 *
 *  - `factor(horizon)` : part de l'éclairement diffus horizontal reçue sous ce
 *    profil. Vaut 1 en site dégagé ;
 *  - `vertical(horizon, cap)` : la même chose pour un plan vertical de normale
 *    `cap` — l'éclairement à l'œil d'un piéton qui marche dans cette direction ;
 *  - `facadeSky(horizon, i)` : le ciel que reçoit la façade du secteur i, moyenné
 *    sur sa hauteur comme le voit le piéton ;
 *  - `zenithOverDh` : la luminance zénithale, en sr⁻¹ (vérification de la
 *    normalisation).
 *
 * Tout est normalisé sur le ciel ouvert : on ne déplace pas le niveau général,
 * on ne corrige que la répartition.
 */

const D2R = Math.PI / 180;

/**
 * Coefficients [catégorie de ε][paramètre a…e][x0, x1, x2, x3] (Perez et al.
 * 1993, via `gendaylit.c`). Les huit catégories de clarté vont du couvert (1) au
 * ciel bleu franc (8).
 */
const PEREZ_1993 = [
  [
    [1.3525, -0.2576, -0.269, -1.4366],
    [-0.767, 0.0007, 1.2734, -0.1233],
    [2.8, 0.6004, 1.2375, 1.0],
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
    [-5.0, 1.5218, 3.9229, -2.6204],
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
    [21.0, -4.7656, -21.5906, 7.2492],
    [-3.5, -0.1554, 1.4062, 0.3988],
    [0.0032, 0.0766, -0.0656, -0.1294],
  ],
  [
    [-1.0156, -0.367, 1.0078, 1.4051],
    [0.2875, -0.5328, -3.85, 3.375],
    [14.0, -0.9999, -7.1406, 7.5469],
    [-3.4, -0.1078, -1.075, 1.5702],
    [-0.0672, 0.4016, 0.3017, -0.4844],
  ],
  [
    [-1.0, 0.0211, 0.5025, -0.5119],
    [-0.3, 0.1922, 0.7023, -1.6317],
    [19.0, -5.0, 1.2438, -1.9094],
    [-4.0, 0.025, 0.3844, 0.2656],
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

/** Bornes des huit catégories de clarté ε (Perez et al. 1990). */
const EPSILON_BOUNDS = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];

/**
 * Luminosité Δ par défaut, quand l'appelant ne la fournit pas : un ciel de
 * luminosité moyenne. Tous les chemins du modèle la fournissent ; ce défaut ne
 * sert qu'aux appels qui ne s'intéressent qu'à la forme du ciel.
 */
const DEFAULT_DELTA = 0.2;

/**
 * (a, b, c, d, e) du modèle « tous temps », avec les règles de `gendaylit` :
 * bornes de ε et de Δ, plancher de Δ à 0,2 sous ε < 2,8, forme particulière de
 * la catégorie 1.
 *
 * `b` est borné à 0, comme le fait gendaylit en rejetant b > 0 : une luminance
 * qui croîtrait sans borne vers l'horizon. Jamais observé sur les mesures de
 * Payerne ; le garde-fou protège des entrées de prévision aberrantes.
 *
 * @param {number} zenith angle zénithal du soleil, en radians
 * @param {number} epsilon clarté de Perez
 * @param {number} delta luminosité de Perez
 */
export function perezCoefficients(zenith, epsilon, delta) {
  const eps = Math.min(Math.max(epsilon, 1.0), 12.009);
  let dl = Math.min(Math.max(delta, 0.01), 0.6);
  if (eps > 1.065 && eps < 2.8 && dl < 0.2) dl = 0.2;
  let k = 0;
  while (k < EPSILON_BOUNDS.length && eps >= EPSILON_BOUNDS[k]) k++;
  const x = PEREZ_1993[k];
  const linear = (i) => x[i][0] + x[i][1] * zenith + dl * (x[i][2] + x[i][3] * zenith);

  let c;
  let d;
  if (k > 0) {
    c = linear(2);
    d = linear(3);
  } else {
    c = Math.exp(Math.pow(dl * (x[2][0] + x[2][1] * zenith), x[2][2])) - x[2][3];
    d = -Math.exp(dl * (x[3][0] + x[3][1] * zenith)) + x[3][2] + dl * x[3][3];
  }
  return { a: linear(0), b: Math.min(linear(1), 0), c, d, e: linear(4) };
}

/** Luminance relative L(cos Z, χ), plancher de cos Z à 0,01 comme `perezlum.cal`. */
function perezRelative(p, cosZ, chi) {
  const gradation = 1 + p.a * Math.exp(p.b / Math.max(cosZ, 0.01));
  const indicatrix = 1 + p.c * Math.exp(p.d * chi) + p.e * Math.cos(chi) * Math.cos(chi);
  return Math.max(0, gradation * indicatrix);
}

/** ∫ max(0, cos x) dx sur [x0, x1], exact pour x1 − x0 ≤ π. */
function clippedCosine(x0, x1) {
  const turns = Math.floor((x0 + Math.PI) / (2 * Math.PI));
  x0 -= 2 * Math.PI * turns;
  x1 -= 2 * Math.PI * turns;
  let sum = 0;
  // La partie positive de cos : [−π/2 + 2πn, π/2 + 2πn] pour n = 0 et 1.
  for (const centre of [0, 2 * Math.PI]) {
    const low = Math.max(x0, centre - Math.PI / 2);
    const high = Math.min(x1, centre + Math.PI / 2);
    if (high > low) sum += Math.sin(high - centre) - Math.sin(low - centre);
  }
  return sum;
}

/**
 * Pas d'intégration en élévation, en degrés. Deux degrés suffisent : le
 * renforcement circumsolaire s'étale sur des dizaines de degrés, et le profil
 * d'horizon n'est stocké qu'au degré près.
 */
const ELEVATION_STEP = 2;
const BANDS = 90 / ELEVATION_STEP;
/** Sous-échantillons d'azimut par secteur, pour ne pas manquer le pic circumsolaire. */
const AZIMUTH_SAMPLES = 4;

/** Table des façades : plus grossière, un mur voit un ciel étalé. */
const FACADE_STEP = 3;
const FACADE_BANDS = 90 / FACADE_STEP;
/** Sous-échantillons d'écart à la normale d'une façade. */
const FACADE_OFFSETS = 12;

/**
 * Nœuds de Gauss-Legendre à quatre points sur [−1, 1] : la hauteur d'une façade
 * s'intègre à 3,4 % près (plan horizontal) et 1,0 % (plan vertical) contre
 * l'intégration fine.
 */
const GAUSS_LEGENDRE_4 = [
  [-0.8611363115940526, 0.3478548451374538],
  [-0.3399810435848563, 0.6521451548625461],
  [0.3399810435848563, 0.6521451548625461],
  [0.8611363115940526, 0.3478548451374538],
];

/**
 * Prépare la lecture du ciel pour un instant donné.
 *
 * À construire **une fois par instant**, jamais par trottoir : le modèle la met
 * en cache à la minute. Les tables de façade et de plan vertical, plus coûteuses
 * et plus rarement lues, ne se construisent qu'à la première lecture.
 *
 * @param {object} p
 * @param {number} p.altitude hauteur du soleil, en radians
 * @param {number} p.azimuth azimut du soleil, en radians depuis le nord
 * @param {number} p.epsilon clarté de Perez : 1 sous la couche, > 6 par ciel bleu
 * @param {number} [p.delta] luminosité de Perez
 * @param {number} [p.bins] nombre de secteurs du profil d'horizon
 * @param {(cosZ: number, chi: number) => number} [p.luminance] luminance relative
 *   de remplacement — un ciel uniforme, pour les vérifications analytiques
 */
export function skyDistribution({ altitude, azimuth, epsilon, delta, bins = 32, luminance }) {
  const sunZenith = Math.PI / 2 - Math.max(altitude, 0);
  const cosSun = Math.cos(sunZenith);
  const sinSun = Math.sin(sunZenith);
  const coefficients = luminance
    ? null
    : perezCoefficients(
        sunZenith,
        Number.isFinite(epsilon) ? epsilon : 1,
        Number.isFinite(delta) ? delta : DEFAULT_DELTA,
      );
  const radiance = luminance ?? ((cosZ, chi) => perezRelative(coefficients, cosZ, chi));

  /** Luminance relative d'un élément de ciel, par élévation et azimut. */
  const at = (elevation, direction) => {
    const cosZ = Math.sin(elevation);
    const sinZ = Math.cos(elevation);
    const cosChi = Math.max(
      -1,
      Math.min(1, cosSun * cosZ + sinSun * sinZ * Math.cos(direction - azimuth)),
    );
    return radiance(cosZ, Math.acos(cosChi));
  };

  const sector = (2 * Math.PI) / bins;

  // ── Plan horizontal : table cumulée du zénith vers l'horizon ──────────────
  //
  // La valeur au rang k est l'intégrale sur tout le ciel plus haut que k·pas.
  // Lire un profil d'horizon est alors un accès indexé, ce qui compte : un
  // itinéraire évalue des dizaines de milliers d'arêtes.
  const horizontal = new Float64Array(bins * (BANDS + 1));
  let total = 0;
  for (let s = 0; s < bins; s++) {
    const base = s * (BANDS + 1);
    for (let k = BANDS - 1; k >= 0; k--) {
      const low = k * ELEVATION_STEP * D2R;
      const high = (k + 1) * ELEVATION_STEP * D2R;
      const elevation = 0.5 * (low + high);
      // ∫ sin e cos e de : projection sur le plan horizontal et angle solide.
      const weight = 0.5 * (Math.sin(high) ** 2 - Math.sin(low) ** 2);
      let ring = 0;
      for (let j = 0; j < AZIMUTH_SAMPLES; j++) {
        const from = (s - 0.5 + j / AZIMUTH_SAMPLES) * sector;
        const to = (s - 0.5 + (j + 1) / AZIMUTH_SAMPLES) * sector;
        ring += at(elevation, 0.5 * (from + to)) * (to - from);
      }
      horizontal[base + k] = horizontal[base + k + 1] + ring * weight;
    }
    total += horizontal[base];
  }
  for (let i = 0; i < horizontal.length; i++) horizontal[i] /= total;

  /** Lecture indexée d'une table cumulée, interpolée entre deux bandes. */
  const read = (table, base, degrees, step, bands) => {
    const position = Math.max(0, Math.min(bands, degrees / step));
    const k = Math.floor(position);
    const next = Math.min(bands, k + 1);
    return table[base + k] + (table[base + next] - table[base + k]) * (position - k);
  };

  // ── Plan vertical à l'œil : construit à la première lecture ───────────────
  //
  // Le cumul se fait par sous-cellule d'azimut ; la projection sur la normale,
  // ∫ max(0, cos(φ − φₙ)) dφ, est appliquée EXACTEMENT à la lecture, pour tout
  // cap — pas seulement ceux alignés sur un secteur.
  let verticalTable = null;
  const buildVertical = () => {
    const table = new Float64Array(bins * AZIMUTH_SAMPLES * (BANDS + 1));
    for (let s = 0; s < bins; s++) {
      for (let j = 0; j < AZIMUTH_SAMPLES; j++) {
        const from = (s - 0.5 + j / AZIMUTH_SAMPLES) * sector;
        const to = (s - 0.5 + (j + 1) / AZIMUTH_SAMPLES) * sector;
        const base = (s * AZIMUTH_SAMPLES + j) * (BANDS + 1);
        for (let k = BANDS - 1; k >= 0; k--) {
          const low = k * ELEVATION_STEP * D2R;
          const high = (k + 1) * ELEVATION_STEP * D2R;
          // ∫ cos² e de : un plan vertical projette par cos e, l'angle solide par cos e.
          const weight = 0.5 * (high - low) + 0.25 * (Math.sin(2 * high) - Math.sin(2 * low));
          table[base + k] =
            table[base + k + 1] + at(0.5 * (low + high), 0.5 * (from + to)) * weight;
        }
      }
    }
    for (let i = 0; i < table.length; i++) table[i] /= total;
    return table;
  };

  // ── Façades : construit à la première lecture ─────────────────────────────
  //
  // La normale du mur du secteur s est sΔ + π (il fait face au piéton). Le
  // cumul se fait par écart o à cette normale.
  let facadeTable = null;
  const buildFacades = () => {
    const table = new Float64Array(bins * FACADE_OFFSETS * (FACADE_BANDS + 1));
    for (let s = 0; s < bins; s++) {
      const normal = s * sector + Math.PI;
      for (let j = 0; j < FACADE_OFFSETS; j++) {
        const from = -Math.PI / 2 + (j * Math.PI) / FACADE_OFFSETS;
        const to = from + Math.PI / FACADE_OFFSETS;
        const projection = Math.sin(to) - Math.sin(from);
        const base = (s * FACADE_OFFSETS + j) * (FACADE_BANDS + 1);
        for (let k = FACADE_BANDS - 1; k >= 0; k--) {
          const low = k * FACADE_STEP * D2R;
          const high = (k + 1) * FACADE_STEP * D2R;
          const weight = 0.5 * (high - low) + 0.25 * (Math.sin(2 * high) - Math.sin(2 * low));
          table[base + k] =
            table[base + k + 1] +
            at(0.5 * (low + high), normal + 0.5 * (from + to)) * projection * weight;
        }
      }
    }
    for (let i = 0; i < table.length; i++) table[i] /= total;
    return table;
  };

  /**
   * Ciel reçu par la façade du secteur s derrière une obstruction en **bande**,
   * rapporté à l'éclairement diffus horizontal.
   *
   * Le mur d'en face est une bande infinie : l'élévation qu'il occupe vu d'un
   * point de la façade décroît avec l'écart o à la normale, tan β(o) = tan β⊥ ·
   * cos o. L'ancienne table supposait une obstruction uniforme sur le demi-tour
   * d'azimut, donc un mur d'en face infiniment large, et sous-estimait la lumière
   * des façades à l'ombre d'un facteur 1,7 à 9 selon l'étroitesse de la rue.
   *
   * @param {number} s secteur de la façade
   * @param {number} tanPerpendicular tangente de l'élévation du bord du toit
   *   d'en face, vu dans la direction perpendiculaire à la façade
   */
  const wallStrip = (s, tanPerpendicular) => {
    facadeTable ??= buildFacades();
    let sum = 0;
    for (let j = 0; j < FACADE_OFFSETS; j++) {
      const offset = -Math.PI / 2 + ((j + 0.5) * Math.PI) / FACADE_OFFSETS;
      const beta = Math.atan(Math.max(0, tanPerpendicular) * Math.cos(offset)) / D2R;
      sum += read(
        facadeTable,
        (s * FACADE_OFFSETS + j) * (FACADE_BANDS + 1),
        beta,
        FACADE_STEP,
        FACADE_BANDS,
      );
    }
    return sum;
  };

  // Les profils stockés sont des degrés entiers : on retient donc les résultats
  // par (secteur, élévation de la façade, élévation d'en face). Un itinéraire
  // relit sans cesse les mêmes rues, et la lecture d'une façade coûte quarante
  // lectures de table.
  const memo = { h: new Map(), v: new Map() };

  return {
    bins,
    coefficients,
    /** L_z / D_h, en sr⁻¹ : l'intégrale de L·cos Z sur l'hémisphère vaut D_h. */
    zenithOverDh: radiance(1, sunZenith) / total,

    /**
     * Part de l'éclairement diffus horizontal reçue sous ce profil d'horizon.
     * Vaut 1 en site dégagé.
     *
     * @param {ArrayLike<number>} horizon élévation de l'horizon par secteur, en degrés
     */
    factor(horizon) {
      if (!horizon || horizon.length !== bins) return null;
      let sum = 0;
      for (let s = 0; s < bins; s++) {
        sum += read(horizontal, s * (BANDS + 1), horizon[s], ELEVATION_STEP, BANDS);
      }
      return sum;
    },

    /**
     * Part de l'éclairement diffus horizontal de ciel ouvert reçue par un plan
     * **vertical** de normale `heading` : l'éclairement à l'œil d'un piéton qui
     * marche dans cette direction. Vaut 0,5 sous un ciel uniforme dégagé, pour
     * tout cap.
     *
     * @param {ArrayLike<number>} horizon
     * @param {number} heading cap de la normale, en radians depuis le nord
     */
    vertical(horizon, heading) {
      if (!horizon || horizon.length !== bins) return null;
      verticalTable ??= buildVertical();
      let sum = 0;
      for (let s = 0; s < bins; s++) {
        for (let j = 0; j < AZIMUTH_SAMPLES; j++) {
          const from = (s - 0.5 + j / AZIMUTH_SAMPLES) * sector;
          const projection = clippedCosine(
            from - heading,
            from + sector / AZIMUTH_SAMPLES - heading,
          );
          if (projection <= 0) continue;
          sum +=
            projection *
            read(
              verticalTable,
              (s * AZIMUTH_SAMPLES + j) * (BANDS + 1),
              horizon[s],
              ELEVATION_STEP,
              BANDS,
            );
        }
      }
      return sum;
    },

    wallStrip,

    /**
     * Ciel reçu par la façade du secteur i, moyenné sur sa hauteur comme la voit
     * le piéton, rapporté à l'éclairement diffus horizontal.
     *
     * Le bas d'une façade voit un canyon ; le haut, bien plus de ciel : c'est la
     * façade entière que l'œil regarde. On intègre sur l'élévation θ ∈ [0, hᵢ],
     * hᵢ étant l'élévation de cette façade dans le profil, par quatre nœuds de
     * Gauss-Legendre. À hauteur θ, l'obstruction est la bande d'en face :
     * tan β⊥ = (tan hₒ − tan θ) / 2, hₒ étant l'élévation du mur d'en face — le
     * piéton est supposé au milieu de la rue, comme dans l'ancien modèle.
     *
     * @param {ArrayLike<number>} horizon
     * @param {number} i secteur de la façade
     * @param {'h'|'v'} [kernel] 'h' : éclairement horizontal à l'œil (sin θ cos θ),
     *   le terme qui s'ajoute à l'éclairement ; 'v' : plan vertical à l'œil
     *   (cos² θ), celui dont dépend la luminance de la façade vue de face
     */
    facadeSky(horizon, i, kernel = 'h') {
      const own = horizon[i];
      if (!(own > 0)) return 0;
      const opposite = horizon[(i + (bins >> 1)) % bins];

      const cache = Number.isInteger(own) && Number.isInteger(opposite) ? memo[kernel] : null;
      const key = (i * 91 + own) * 91 + opposite;
      if (cache?.has(key)) return cache.get(key);

      const top = own * D2R;
      const tanOpposite = Math.tan(opposite * D2R);
      let numerator = 0;
      let denominator = 0;
      for (const [node, weight] of GAUSS_LEGENDRE_4) {
        const theta = 0.5 * top * (node + 1);
        const kernelWeight =
          weight * (kernel === 'v' ? Math.cos(theta) ** 2 : Math.sin(theta) * Math.cos(theta));
        numerator += kernelWeight * wallStrip(i, (tanOpposite - Math.tan(theta)) / 2);
        denominator += kernelWeight;
      }
      const value = numerator / denominator;
      cache?.set(key, value);
      return value;
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
