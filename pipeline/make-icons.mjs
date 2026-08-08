/**
 * Icônes de l'application, dessinées plutôt que déposées.
 *
 * Le manifeste n'en déclarait aucune, ce qui suffit à rendre l'application non
 * installable : Chrome exige une icône de 192 et une de 512 pour proposer
 * l'ajout à l'écran d'accueil, et iOS ignore le manifeste au profit d'un
 * `apple-touch-icon`. Une application pensée pour servir hors ligne, en
 * marchant, qu'on ne peut pas installer sur son téléphone perd l'essentiel de
 * ce que le service worker lui apporte.
 *
 * Le motif est le sujet même de l'application : deux trottoirs d'une rue, l'un à
 * l'ombre, l'autre au soleil, et le soleil qui décide lequel. Les couleurs sont
 * celles de la carte — le vert d'eau de l'accent, l'ambre des valeurs hautes —
 * pour que l'icône et l'écran se répondent.
 *
 * On dessine en coordonnées normalisées, puis on suréchantillonne : c'est ce qui
 * donne des bords lisses à toutes les tailles sans dépendre d'un moteur de rendu.
 *
 *   node pipeline/make-icons.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'web', 'public', 'icons');

const BG = [0x0b, 0x0f, 0x16];
/** Vert d'eau de l'accent : le trottoir abrité. */
const SHADE = [0x4a, 0xa3, 0xa2];
/** Ambre des valeurs hautes : le trottoir exposé. */
const LIT = [0xd9, 0xa4, 0x41];
const SUN_COLOR = [0xf7, 0xe4, 0x63];

const LEFT = { x0: 0.3, x1: 0.445, y0: 0.26, y1: 0.86 };
const RIGHT = { x0: 0.555, x1: 0.7, y0: 0.26, y1: 0.86 };
const SUN = { x: 0.775, y: 0.185, r: 0.1, halo: 0.235 };

/** Suréchantillonnage par côté : 16 mesures par pixel rendu. */
const SAMPLES = 4;

/**
 * Couleur en un point, les formes empilées de l'arrière vers l'avant.
 *
 * Le halo est posé deux fois : franchement sur le fond, puis à demi par-dessus
 * les trottoirs. C'est ce second passage qui fait le sujet — la haut du trottoir
 * exposé baigne dans la lumière, celui d'à côté non. Sans lui, on lit deux
 * barres de couleur et un point jaune, trois formes sans rapport entre elles.
 */
function colorAt(x, y) {
  let colour = BG;
  const toSun = Math.hypot(x - SUN.x, y - SUN.y);
  const falloff = toSun < SUN.halo ? 1 - toSun / SUN.halo : 0;

  if (falloff > 0) colour = mix(colour, SUN_COLOR, 0.5 * Math.pow(falloff, 2.2));

  if (inStadium(x, y, LEFT)) colour = SHADE;
  if (inStadium(x, y, RIGHT)) colour = LIT;

  if (falloff > 0) colour = mix(colour, SUN_COLOR, 0.42 * Math.pow(falloff, 1.6));
  if (toSun < SUN.r) colour = SUN_COLOR;

  return colour;
}

/** Rectangle aux extrémités arrondies : le rayon vaut la demi-largeur. */
function inStadium(x, y, { x0, x1, y0, y1 }) {
  const radius = (x1 - x0) / 2;
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * @param {number} size côté en pixels.
 * @param {number} scale réduction du motif autour du centre. Les icônes
 *   « maskable » sont rognées par le système jusqu'à un disque de 40 % de rayon :
 *   tout ce qui dépasse peut disparaître, il faut donc rentrer le dessin.
 */
function render(size, scale = 1) {
  const png = new PNG({ width: size, height: size });

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          // Centre du sous-pixel, ramené au repère du motif.
          const x = 0.5 + ((px + (sx + 0.5) / SAMPLES) / size - 0.5) / scale;
          const y = 0.5 + ((py + (sy + 0.5) / SAMPLES) / size - 0.5) / scale;
          const [cr, cg, cb] = colorAt(x, y);
          r += cr;
          g += cg;
          b += cb;
        }
      }

      const count = SAMPLES * SAMPLES;
      const at = (py * size + px) * 4;
      png.data[at] = Math.round(r / count);
      png.data[at + 1] = Math.round(g / count);
      png.data[at + 2] = Math.round(b / count);
      png.data[at + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  // Rognée en disque par Android : le motif rentre dans la zone sûre.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.62 },
  // iOS n'arrondit pas de lui-même sur toutes les versions et n'accepte pas la
  // transparence : un fond plein, un motif un peu rentré.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.88 },
  { file: 'favicon-32.png', size: 32, scale: 1 },
];

await mkdir(OUT, { recursive: true });
for (const { file, size, scale } of ICONS) {
  await writeFile(path.join(OUT, file), render(size, scale));
  console.log(`${file} — ${size}×${size}`);
}
