/**
 * Outillage des tests de bout en bout : un serveur Vite sur des données
 * synthétiques, un Chromium, et de quoi rejouer une marche.
 *
 * Les données vont dans un dossier temporaire servi comme `public/`, et jamais
 * dans `web/public/data` : celui-ci contient les zones réellement calculées, que
 * des tests n'ont pas à écraser.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build, createServer, preview } from 'vite';

import { writeZone } from './zone.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(WEB, 'vite.config.js');

/**
 * WebGL sans carte graphique : SwiftShader, le rendu logiciel de Chromium. Sans
 * ces drapeaux, MapLibre 6 — qui exige WebGL2 — refuse de créer la carte sur
 * une machine d'intégration continue.
 */
const BROWSER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
];

/** Un dossier `public/` complet : les fichiers du dépôt, plus des zones synthétiques. */
export async function makePublicDir(zones = [{}]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'svet-e2e-'));
  await cp(path.join(WEB, 'public'), dir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}data`),
  });
  for (const zone of zones) await writeZone(path.join(dir, 'data'), zone);
  return dir;
}

/** Serveur de développement sur ce dossier. */
export async function startDevServer(publicDir) {
  const server = await createServer({
    configFile: CONFIG_FILE,
    root: WEB,
    publicDir,
    logLevel: 'error',
    server: { port: 5300, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

/** Construction de production, puis aperçu — ce que sert un hébergement réel. */
export async function startPreviewServer(publicDir) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'svet-e2e-dist-'));
  await build({
    configFile: CONFIG_FILE,
    root: WEB,
    publicDir,
    logLevel: 'error',
    build: { outDir, emptyOutDir: true },
  });
  const server = await preview({
    configFile: CONFIG_FILE,
    root: WEB,
    logLevel: 'error',
    build: { outDir },
    preview: { port: 5400, strictPort: false, host: '127.0.0.1' },
  });
  return {
    url: server.resolvedUrls.local[0],
    close: async () => {
      await server.close();
      await rm(outDir, { recursive: true, force: true });
    },
  };
}

export function launchBrowser() {
  return chromium.launch({ args: BROWSER_ARGS });
}

/**
 * Un contexte de navigation de téléphone : géolocalisation permise, et voix
 * ou vibreur remplacés par des enregistreurs — `window.__said`,
 * `window.__vibrations` — qu'on relit ensuite.
 */
export async function phoneContext(browser, { latitude = 48.8606, longitude = 2.3376 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 420, height: 860 },
    permissions: ['geolocation'],
    geolocation: { latitude, longitude },
  });
  await context.addInitScript(() => {
    window.__said = [];
    window.__vibrations = [];
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = (utterance) => window.__said.push(utterance.text);
      window.speechSynthesis.cancel = () => window.__said.push('<coupé>');
    }
    navigator.vibrate = (pattern) => {
      window.__vibrations.push(pattern);
      return true;
    };
  });
  return context;
}

/** Erreurs de la page, hors ressources distantes que la machine de test n'atteint pas. */
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource|cartocdn|open-meteo|ERR_/i.test(message.text())) return;
    errors.push(message.text());
  });
  return errors;
}

/** Ouvre l'application et attend que la carte soit peinte. */
export async function openApp(page, url, query = '') {
  await page.goto(`${url}${query}`);
  await page.waitForFunction(
    () =>
      document.getElementById('loading')?.classList.contains('is-hidden') &&
      window.svet?.map?.loaded() &&
      window.svet.state.lastContext,
    null,
    { timeout: 60000 },
  );
}

/** Itinéraire par la recherche de rue, comme un utilisateur. */
export async function planRoute(page, from, to, { fastest = true } = {}) {
  if (await page.isHidden('#route')) await page.click('#route-toggle');
  // Par défaut le trajet le plus rapide : son tracé ne dépend que de la
  // géométrie du réseau. Au curseur par défaut, il suit l'exposition calculée
  // par le modèle — et un parcours de guidage cesserait de passer chaque fois
  // qu'on affine la physique, alors qu'il n'éprouve pas la physique.
  if (fastest) await page.evaluate(() => (document.getElementById('alpha').value = '0'));
  for (const [field, query] of [
    ['from', from],
    ['to', to],
  ]) {
    await page.fill(`#${field}`, query);
    await page.waitForSelector(`#${field}-suggestions li`);
    await page.click(`#${field}-suggestions li >> nth=0`);
  }
  await page.click('#route-go');
  await page.waitForFunction(() => window.svet.state.route, null, { timeout: 20000 });
}

/** Points tous les `step` mètres le long d'un tracé. */
export function pointsAlong(coordinates, step = 4) {
  const flat = ([lon1, lat1], [lon2, lat2]) =>
    Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 111132);
  const points = [];
  for (let i = 1; i < coordinates.length; i++) {
    const [a, b] = [coordinates[i - 1], coordinates[i]];
    const length = flat(a, b);
    for (let s = 0; s < length; s += step) {
      const t = s / length;
      points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  points.push(coordinates.at(-1));
  return points;
}

/** Rejoue une marche : une position GPS par point, et l'écran relevé en chemin. */
export async function walk(page, context, points, { every = 10 } = {}) {
  const screens = [];
  for (const [k, [longitude, latitude]] of points.entries()) {
    await context.setGeolocation({ latitude, longitude, accuracy: 5 });
    await page.waitForTimeout(60);
    if (k % every === 0 || k === points.length - 1) {
      screens.push(
        await page.evaluate(() => ({
          instruction: document.getElementById('nav-instruction').textContent.trim(),
          distance: document.getElementById('nav-distance').textContent.trim(),
          remaining: document.getElementById('nav-remaining').textContent.trim(),
        })),
      );
    }
  }
  return screens;
}
