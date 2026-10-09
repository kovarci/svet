/**
 * Régénère `src/lib/spectral-data.js` à partir des tables de référence.
 *
 * Le modèle ne contient aucun spectre recopié à la main : tout ce qui sert à
 * pondérer la lumière par la sensibilité de l'œil sort d'ici, et ce script dit
 * d'où. Le relancer doit redonner exactement le même fichier.
 *
 *  - **CIE S 026:2018**, fonctions d'efficacité α-opiques (mélanopsine), et
 *    **CIE 1931**, V(λ) photopique : tables publiées par la CIE, reprises telles
 *    quelles par l'application luox, dont le calcul a été vérifié par la CIE
 *    elle-même (« CIE Software Check », dans son dépôt).
 *  - **CIE D65**, pour normaliser le rapport mélanopique : il vaut 1 pour D65 par
 *    définition.
 *  - **SPCTRL2** (Bird & Riordan, 1986), le modèle spectral de ciel clair du
 *    NREL : spectre extraterrestre et coefficients d'absorption de l'ozone, de la
 *    vapeur d'eau et des gaz mélangés, dans la version de pvlib.
 *
 *     node derive-spectra.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'src', 'lib', 'spectral-data.js');

const SOURCES = {
  s026: 'https://raw.githubusercontent.com/luox-app/luox/master/data/cies026.csv',
  xyz31: 'https://raw.githubusercontent.com/luox-app/luox/master/data/ciexyz31_1.csv',
  illuminants:
    'https://raw.githubusercontent.com/luox-app/luox/master/data/reference_spectra/CIEStandardIlluminant_A_D65_Illuminant_E.csv',
  spectrl2: 'https://raw.githubusercontent.com/pvlib/pvlib-python/main/pvlib/spectrum/spectrl2.py',
};

/** Domaine d'intégration de la CIE S 026 : 380–780 nm. Pas de 5 nm. */
const FIRST = 380;
const LAST = 780;
const STEP = 5;

/** Les bandes de SPCTRL2 au-delà ne pèsent plus rien dans le visible. */
const SPCTRL2_LAST = 850;

async function text(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`);
  return response.text();
}

function table(csv, column, skip = 1) {
  const values = new Map();
  for (const line of csv.trim().split(/\r?\n/).slice(skip)) {
    const cells = line.split(',').map(Number);
    if (Number.isFinite(cells[0])) values.set(cells[0], cells[column]);
  }
  return values;
}

/** Une liste de nombres de `spectrl2.py`, lue entre crochets. */
function pythonArray(source, key) {
  const start = source.indexOf(`_SPECTRL2_COEFFS['${key}'] = [`);
  if (start < 0) throw new Error(`spectrl2.py : ${key} introuvable`);
  const open = source.indexOf('[', source.indexOf('=', start));
  const close = source.indexOf(']', open);
  return source
    .slice(open + 1, close)
    .replace(/#[^\n]*/g, '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function grid(values) {
  const out = [];
  for (let wavelength = FIRST; wavelength <= LAST; wavelength += STEP) {
    const value = values.get(wavelength);
    out.push(Number.isFinite(value) ? value : 0);
  }
  return out;
}

const format = (numbers) => numbers.map((value) => Number(value.toPrecision(6))).join(', ');

async function main() {
  const [s026, xyz31, illuminants, spectrl2] = await Promise.all(Object.values(SOURCES).map(text));

  const melanopic = grid(table(s026, 5));
  const photopic = grid(table(xyz31, 2, 0));
  const d65 = grid(table(illuminants, 2));

  const wavelengths = pythonArray(spectrl2, 'wavelength');
  const keep = wavelengths.filter((value) => value <= SPCTRL2_LAST).length;
  const columns = [
    'wavelength',
    'spectral_irradiance_et',
    'water_vapor_absorption',
    'ozone_absorption',
    'mixed_absorption',
  ].map((key) => pythonArray(spectrl2, key).slice(0, keep));

  const body = `/**
 * Tables spectrales — fichier **généré** par \`pipeline/derive-spectra.mjs\`.
 * Ne pas modifier à la main : relancer le script.
 *
 * Sources :
 *   ${SOURCES.s026}
 *   ${SOURCES.xyz31}
 *   ${SOURCES.illuminants}
 *   ${SOURCES.spectrl2}
 */

/** Première longueur d'onde des tables CIE, en nm. */
export const CIE_FIRST = ${FIRST};

/** Pas des tables CIE, en nm. */
export const CIE_STEP = ${STEP};

/** Efficacité mélanopique s_mel(λ), CIE S 026:2018, normalisée à 1 au maximum. */
export const MELANOPIC = [${format(melanopic)}];

/** Efficacité lumineuse photopique V(λ), CIE 1931 2°. */
export const PHOTOPIC = [${format(photopic)}];

/** Illuminant normalisé CIE D65, unités relatives. */
export const D65 = [${format(d65)}];

/** SPCTRL2 (Bird & Riordan 1986, version pvlib) : longueurs d'onde, en nm. */
export const SPCTRL2_WAVELENGTH = [${format(columns[0])}];

/** Éclairement extraterrestre spectral, en W/m²/nm. */
export const SPCTRL2_EXTRATERRESTRIAL = [${format(columns[1])}];

/** Coefficient d'absorption de la vapeur d'eau. */
export const SPCTRL2_WATER = [${format(columns[2])}];

/** Coefficient d'absorption de l'ozone, en (atm·cm)⁻¹. */
export const SPCTRL2_OZONE = [${format(columns[3])}];

/** Coefficient d'absorption des gaz uniformément mélangés. */
export const SPCTRL2_MIXED = [${format(columns[4])}];
`;

  await fs.writeFile(OUT, body);
  console.log(`écrit ${path.relative(process.cwd(), OUT)} — ${keep} bandes SPCTRL2`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
