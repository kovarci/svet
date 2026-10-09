/**
 * Spectre de la lumière du jour, et ce qu'en fait l'œil photophobe.
 *
 * ── Pourquoi un modèle spectral ─────────────────────────────────────────────
 *
 * Le modèle pondérait la lumière du jour par des températures de couleur
 * posées à la main — 5 600 K pour le soleil haut, de 6 500 à 16 000 K pour le
 * ciel selon une « part directionnelle » maison —, puis par une table de phases
 * D. Deux choses ne tenaient pas : les températures n'avaient pas de source, et
 * une température de couleur ne dit pas le contenu en bleu d'un spectre qui
 * n'est ni un corps noir ni une phase D, ce qu'est précisément le soleil rougi
 * par une atmosphère urbaine.
 *
 * On calcule donc les spectres eux-mêmes, par **SPCTRL2** (Bird & Riordan,
 * *Journal of Climate and Applied Meteorology* 25, 1986), le modèle de ciel
 * clair du NREL : diffusion de Rayleigh, extinction et diffusion des aérosols,
 * absorption de l'ozone, de la vapeur d'eau et des gaz mélangés. Puis on les
 * intègre contre les fonctions d'efficacité de la **CIE S 026:2018**.
 *
 * Vérifié contre ASTM G173 (spectre de référence AM1.5, calculé par SMARTS) :
 * rapport mélanopique du faisceau direct 0,866 ici, 0,881 pour la référence.
 *
 * ── Ce qui déclenche la photophobie ─────────────────────────────────────────
 *
 * Le modèle posait que la photophobie passait « pour l'essentiel » par la
 * mélanopsine, et pondérait tout par elle seule. Les mesures les plus directes
 * disent autre chose :
 *
 *  - Zele et al., *Cephalalgia* 41 (2021) : seuils de photophobie mesurés par
 *    électromyographie, en lumière plein champ, sur des lumières étroites qui
 *    balaient les deux spectres d'action. Le modèle qui rend compte des seuils
 *    **combine** mélanopsine et luminance des cônes, la mélanopsine pesant
 *    environ **1,5 fois** plus. Seuils des migraineux plus bas de 0,55 log.
 *  - McAdams et al., *PNAS* 117 (2020) : même conclusion par une autre voie —
 *    les cônes et la mélanopsine se combinent, de la même façon chez les
 *    migraineux et chez les témoins ; ce qui diffère est une amplification en
 *    aval de la rétine. Et la gêne croît **comme le logarithme** du signal.
 *  - Noseda et al., *Brain* 139 (2016) : le vert aggrave le moins la céphalée,
 *    le bleu, l'ambre et le rouge davantage — une composante portée par les
 *    cônes, que la mélanopsine seule ne prédit pas.
 *
 * On retient donc la forme de Zele, la plus proche de la situation modélisée
 * (lumière continue, plein champ) : une somme des deux signaux, la mélanopsine
 * comptant pour 1,5.
 */

import {
  CIE_FIRST,
  CIE_STEP,
  D65,
  MELANOPIC,
  PHOTOPIC,
  SPCTRL2_EXTRATERRESTRIAL,
  SPCTRL2_MIXED,
  SPCTRL2_OZONE,
  SPCTRL2_WATER,
  SPCTRL2_WAVELENGTH,
} from './spectral-data.js';

/**
 * Poids de la mélanopsine face à la luminance des cônes dans la photophobie.
 * Zele et al. (2021) : « melanopsin contributions were ∼1.5× greater than cone
 * luminance ».
 */
export const MELANOPSIN_WEIGHT = 1.5;

/** Rapport des intégrales mélanopique et photopique de D65 : l'étalon. */
const D65_RATIO = cieRatio((i) => D65[i]);

function cieRatio(power) {
  let melanopic = 0;
  let photopic = 0;
  for (let i = 0; i < MELANOPIC.length; i++) {
    const p = power(i);
    melanopic += p * MELANOPIC[i];
    photopic += p * PHOTOPIC[i];
  }
  return photopic > 0 ? melanopic / photopic : 0;
}

/**
 * Rapport mélanopique d'un spectre (melanopic DER, CIE S 026) : l'éclairement
 * mélanopique équivalent D65 par lux photopique. Vaut 1 pour D65.
 *
 * @param {(wavelength: number) => number} spectrum puissance spectrale relative
 */
export function melanopicDER(spectrum) {
  return cieRatio((i) => Math.max(0, spectrum(CIE_FIRST + i * CIE_STEP))) / D65_RATIO;
}

/**
 * Facteur photophobe d'une lumière, par lux photopique, d'après son rapport
 * mélanopique : (1 + 1,5·DER) / 2,5. Vaut 1 pour D65, comme le DER lui-même —
 * la même grandeur, mais qui compte aussi ce que voient les cônes.
 *
 * Entre un sodium à 2 000 K et D65, le rapport mélanopique varie d'un facteur
 * 3,4 ; le facteur photophobe d'un facteur 2,1. Les cônes voient aussi la lampe
 * chaude, et c'est ce que mesurent Zele et al.
 */
export function photophobicRatio(der) {
  const value = Number.isFinite(der) ? Math.max(0, der) : 1;
  return (1 + MELANOPSIN_WEIGHT * value) / (1 + MELANOPSIN_WEIGHT);
}

// ─────────────────────────────────────────────────────── corps noirs ───────

const C2 = 1.4388e-2;

function planck(cct) {
  return (wavelength) => {
    const metres = wavelength * 1e-9;
    return 1 / (metres ** 5 * (Math.exp(C2 / (metres * cct)) - 1));
  };
}

/**
 * Rapport mélanopique d'un corps noir, tabulé tous les 100 K et interpolé.
 *
 * Il remplace une table recopiée de huit points. Calculé ici sur les fonctions
 * de la CIE, il redonne l'illuminant A (2 856 K) à 0,496 — et c'est par lui que
 * passent les lampadaires, faute de leur spectre réel.
 */
const PLANCK_FIRST = 1000;
const PLANCK_STEP = 100;
const PLANCK_TABLE = (() => {
  const values = [];
  for (let cct = PLANCK_FIRST; cct <= 25000; cct += PLANCK_STEP) {
    values.push(melanopicDER(planck(cct)));
  }
  return values;
})();

export function planckMelanopicDER(cct) {
  if (!Number.isFinite(cct)) return planckMelanopicDER(2800);
  const position = (cct - PLANCK_FIRST) / PLANCK_STEP;
  const clamped = Math.max(0, Math.min(PLANCK_TABLE.length - 1, position));
  const i = Math.floor(clamped);
  const j = Math.min(PLANCK_TABLE.length - 1, i + 1);
  return PLANCK_TABLE[i] + (PLANCK_TABLE[j] - PLANCK_TABLE[i]) * (clamped - i);
}

// ─────────────────────────────────────────────────── ciel clair, SPCTRL2 ────

const SPCTRL2 = {
  /** Albédo de diffusion simple des aérosols à 400 nm. */
  scatteringAlbedo400: 0.945,
  /** Exposant d'Ångström. */
  alpha: 1.14,
  wavelengthVariation: 0.095,
  /** Facteur d'asymétrie des aérosols. */
  asymmetry: 0.65,
  /** Pression au sol à Paris, ~35 m d'altitude. */
  pressure: 100900,
  /** Ozone total, en atm·cm. Moyenne annuelle aux latitudes moyennes. */
  ozone: 0.33,
  /** Albédo du sol pour la rétrodiffusion sol-ciel. */
  groundAlbedo: 0.15,
};

function transmittances(zenithDeg, airMass, water, depth, albedo) {
  const n = SPCTRL2_WAVELENGTH.length;
  const pressureMass = (airMass * SPCTRL2.pressure) / 101300;
  const cosZ = Math.cos((zenithDeg * Math.PI) / 180);
  const h0 = 22 / 6370;
  const ozoneMass = (1 + h0) / Math.sqrt(cosZ * cosZ + 2 * h0);
  const out = {
    Tr: new Float64Array(n),
    Ta: new Float64Array(n),
    Tw: new Float64Array(n),
    To: new Float64Array(n),
    Tu: new Float64Array(n),
    Tas: new Float64Array(n),
    Taa: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const um = SPCTRL2_WAVELENGTH[i] / 1000;
    out.Tr[i] = Math.exp(-pressureMass / (um ** 4 * (115.6406 - 1.3366 / (um * um))));
    out.Ta[i] = Math.exp(-depth[i] * airMass);
    const aWM = SPCTRL2_WATER[i] * water * airMass;
    out.Tw[i] = Math.exp((-0.2385 * aWM) / Math.pow(1 + 20.07 * aWM, 0.45));
    out.To[i] = Math.exp(-SPCTRL2_OZONE[i] * SPCTRL2.ozone * ozoneMass);
    const aM = SPCTRL2_MIXED[i] * pressureMass;
    out.Tu[i] = Math.exp((-1.41 * aM) / Math.pow(1 + 118.3 * aM, 0.45));
    out.Tas[i] = Math.exp(-albedo[i] * depth[i] * airMass);
    out.Taa[i] = Math.exp(-(1 - albedo[i]) * depth[i] * airMass);
  }
  return out;
}

/**
 * Spectres du faisceau direct (normal) et du ciel diffus (horizontal) par ciel
 * clair, en W/m²/nm, sur la grille SPCTRL2.
 *
 * Portage fidèle de `pvlib.spectrum.spectrl2`, lui-même vérifié contre le code
 * C du NREL ; le test l'éprouve contre des valeurs de pvlib.
 *
 * @param {object} p
 * @param {number} p.zenithDeg angle zénithal apparent du soleil, en degrés
 * @param {number} p.airMass masse d'air relative
 * @param {number} p.aod500 épaisseur optique des aérosols à 500 nm
 * @param {number} [p.water] eau précipitable, en cm
 */
export function clearSkySpectra({ zenithDeg, airMass, aod500, water = 2 }) {
  const n = SPCTRL2_WAVELENGTH.length;
  const depth = new Float64Array(n);
  const albedo = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const wavelength = SPCTRL2_WAVELENGTH[i];
    depth[i] = aod500 * Math.pow(wavelength / 500, -SPCTRL2.alpha);
    albedo[i] =
      SPCTRL2.scatteringAlbedo400 *
      Math.exp(-SPCTRL2.wavelengthVariation * Math.log(wavelength / 400) ** 2);
  }

  const t = transmittances(zenithDeg, airMass, water, depth, albedo);
  const p = transmittances(zenithDeg, 1.8, water, depth, albedo);
  const cosZ = Math.cos((zenithDeg * Math.PI) / 180);

  const alg = Math.log(1 - SPCTRL2.asymmetry);
  const bfs = alg * (0.0783 + alg * (-0.3824 - alg * 0.5874));
  const afs = alg * (1.459 + alg * (0.1595 + alg * 0.4129));
  const fs = 1 - 0.5 * Math.exp((afs + bfs * cosZ) * cosZ);
  const fsp = 1 - 0.5 * Math.exp((afs + bfs / 1.8) / 1.8);

  const beam = new Float64Array(n);
  const diffuse = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const wavelength = SPCTRL2_WAVELENGTH[i];
    const et = SPCTRL2_EXTRATERRESTRIAL[i];
    beam[i] = et * t.Tr[i] * t.Ta[i] * t.Tw[i] * t.To[i] * t.Tu[i];
    const common = et * cosZ * t.To[i] * t.Tu[i] * t.Tw[i] * t.Taa[i];
    const rayleigh = common * (1 - Math.pow(t.Tr[i], 0.95)) * 0.5;
    const aerosol = common * Math.pow(t.Tr[i], 1.5) * (1 - t.Tas[i]) * fs;
    const sky =
      p.Tu[i] * p.Tw[i] * p.Taa[i] * (0.5 * (1 - p.Tr[i]) + (1 - fsp) * p.Tr[i] * (1 - p.Tas[i]));
    const ground =
      ((beam[i] * cosZ + rayleigh + aerosol) * sky * SPCTRL2.groundAlbedo) /
      (1 - sky * SPCTRL2.groundAlbedo);
    const cs = wavelength <= 450 ? Math.pow((wavelength + 550) / 1000, 1.8) : 1;
    diffuse[i] = (rayleigh + aerosol + ground) * cs;
  }
  return { wavelength: SPCTRL2_WAVELENGTH, beam, diffuse };
}

/** Interpolation linéaire d'un spectre tabulé, nulle hors de la grille. */
function sampled(values) {
  return (wavelength) => {
    const grid = SPCTRL2_WAVELENGTH;
    if (wavelength < grid[0] || wavelength > grid[grid.length - 1]) return 0;
    let i = 1;
    while (grid[i] < wavelength) i++;
    const t = (wavelength - grid[i - 1]) / (grid[i] - grid[i - 1]);
    return values[i - 1] + (values[i] - values[i - 1]) * t;
  };
}

/**
 * Épaisseur optique des aérosols à 500 nm, déduite du trouble de Linke.
 *
 * Par la formule pyrhéliométrique de Kasten, sous la forme de Molineaux et al.
 * (*Applied Optics* 37, 1998) et Ineichen (*Solar Energy* 82, 2008) — celle de
 * `pvlib.atmosphere.kasten96_lt`, ici inversée à masse d'air 2, où le trouble
 * d'Ineichen-Perez est défini. L'épaisseur large bande équivaut à celle de
 * 700 nm (Molineaux) ; on la ramène à 500 nm par la loi d'Ångström.
 *
 * Trouble 4, eau 2 cm : 0,22 à 500 nm — ce que mesure le photomètre AERONET de
 * Paris en moyenne.
 */
export function aod500FromLinke(turbidity, water = 2) {
  const m = 2;
  const rayleighAndGases = -0.101 + 0.235 * Math.pow(m, -0.16);
  const vapour = 0.112 * Math.pow(m, -0.55) * Math.pow(Math.max(0.1, water), 0.34);
  const broadband = turbidity / (9.4 + 0.9 * m) - rayleighAndGases - vapour;
  return Math.max(0.01, broadband) * Math.pow(700 / 500, SPCTRL2.alpha);
}

const daylightCache = new Map();

/**
 * Rapports mélanopiques du soleil et du ciel clair, pour une hauteur de soleil
 * et une atmosphère données.
 *
 * Mis en cache au degré et au dixième de trouble près : l'appelant interroge à
 * chaque minute, et la réponse ne bouge pas à cette échelle.
 *
 * Ce qu'on en tire, à trouble 4 : le faisceau passe de 0,87 soleil haut à 0,59
 * à 10° de hauteur ; le ciel clair reste entre 1,0 et 1,15 — moins bleu que ne
 * le supposait le modèle (1,4), parce qu'un ciel parisien n'est pas un ciel de
 * montagne : les aérosols diffusent toutes les couleurs.
 *
 * @param {number} altitudeDeg hauteur du soleil, en degrés
 * @param {number} turbidity trouble de Linke
 * @param {number} [water] eau précipitable, en cm
 */
export function daylightMelanopic(altitudeDeg, turbidity, water = 2) {
  const altitude = Math.max(0.5, Math.min(90, Math.round(altitudeDeg)));
  const tl = Math.round(Math.max(1.5, Math.min(8, turbidity)) * 10) / 10;
  const w = Math.round(Math.max(0.2, Math.min(6, water)) * 2) / 2;
  const key = `${altitude}|${tl}|${w}`;
  const cached = daylightCache.get(key);
  if (cached) return cached;

  const zenithDeg = 90 - altitude;
  const airMass =
    1 / (Math.sin((altitude * Math.PI) / 180) + 0.50572 * Math.pow(altitude + 6.07995, -1.6364));
  const spectra = clearSkySpectra({
    zenithDeg,
    airMass,
    aod500: aod500FromLinke(tl, w),
    water: w,
  });
  const result = {
    beam: melanopicDER(sampled(spectra.beam)),
    diffuse: melanopicDER(sampled(spectra.diffuse)),
  };
  if (daylightCache.size > 4000) daylightCache.clear();
  daylightCache.set(key, result);
  return result;
}
