/**
 * L'application entière, dans un vrai navigateur.
 *
 * Les tests unitaires éprouvent les modules un par un ; aucun ne voyait que
 * `main.js` passait à `phraseFor` un objet sans libellé, ce qui levait une
 * exception à chaque position GPS et coupait tout le guidage. Ce défaut-là ne
 * se voit qu'en marchant. On marche donc : zone synthétique écrite par le
 * pipeline, Chromium, GPS posé point par point, voix enregistrée.
 *
 * `npm run test:e2e` — hors de `npm test`, parce qu'il faut un navigateur.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import {
  collectErrors,
  launchBrowser,
  makePublicDir,
  openApp,
  phoneContext,
  planRoute,
  pointsAlong,
  startDevServer,
  startPreviewServer,
  walk,
} from './harness.mjs';

let browser;
let publicDir;
let server;

before(async () => {
  publicDir = await makePublicDir([{}, { key: 'lente', label: 'Zone lente' }]);
  server = await startDevServer(publicDir);
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await server?.close();
  await rm(publicDir, { recursive: true, force: true });
});

test('la carte se peint, trottoir par trottoir', { timeout: 120000 }, async () => {
  const context = await phoneContext(browser);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await openApp(page, server.url, '?zone=synthese');

  const painted = await page.evaluate(() => {
    const features = window.svet.map.queryRenderedFeatures({
      layers: ['network-left', 'network-right'],
    });
    return {
      rendered: features.length,
      coloured: features.filter((f) => f.state && Object.keys(f.state).length > 0).length,
    };
  });
  assert.ok(painted.rendered > 100, `${painted.rendered} trottoirs dessinés`);
  // `feature-state` est ce qui colore : un trottoir sans état garde la couleur
  // du zéro, qui se lit « aucune gêne ».
  assert.equal(painted.coloured, painted.rendered);
  assert.deepEqual(errors, []);
  await context.close();
});

test(
  'une marche guidée annonce chaque palier, et se tait à l’arrêt',
  { timeout: 180000 },
  async () => {
    const context = await phoneContext(browser);
    const page = await context.newPage();
    const errors = collectErrors(page);
    await openApp(page, server.url, '?zone=synthese');
    await planRoute(page, 'Rue de Rivoli', 'Rue du Temple');

    await page.click('#route-navigate');
    const coordinates = await page.evaluate(() => window.svet.state.route.coordinates);
    const screens = await walk(page, context, pointsAlong(coordinates));

    // Sur le trajet, la distance s'affiche toujours : c'est elle qui manquait
    // quand le rendu s'interrompait sur une exception.
    for (const screen of screens.slice(1, -1)) {
      assert.notEqual(screen.distance, '', `distance vide sous « ${screen.instruction} »`);
    }
    // On n'est arrivé qu'à l'arrivée.
    assert.ok(screens.some((s) => s.instruction === 'Arrivée'));
    assert.equal(screens.at(-1).instruction, 'Vous êtes arrivé');

    const said = await page.evaluate(() => window.__said);
    const turns = said.filter((s) => /tournez/i.test(s));
    assert.deepEqual(
      turns.map((s) => s.split(',')[0]),
      ['Dans 200 mètres', 'Dans 60 mètres', 'Tournez à droite'],
    );
    assert.ok(said.includes('Dans 200 mètres, arrivée à destination.'));
    assert.equal(said.filter((s) => s === 'Vous êtes arrivé.').length, 1);
    assert.ok(!said.some((s) => /undefined|null/.test(s)), said.join(' / '));

    await page.click('#nav-stop');
    assert.equal(await page.evaluate(() => window.__said.at(-1)), '<coupé>');
    assert.deepEqual(errors, []);
    await context.close();
  },
);

test(
  'un écart recalculé reprend le guidage sans détour par le panneau',
  { timeout: 120000 },
  async () => {
    const context = await phoneContext(browser);
    const page = await context.newPage();
    await openApp(page, server.url, '?zone=synthese');
    await planRoute(page, 'Rue de Rivoli', 'Rue du Temple');
    await page.click('#route-navigate');

    const [lon, lat] = await page.evaluate(() => window.svet.state.route.coordinates[3]);
    await context.setGeolocation({ latitude: lat, longitude: lon });
    await page.waitForTimeout(300);
    // La rue parallèle, cent mètres à l'est : franchement hors du trajet.
    await context.setGeolocation({ latitude: lat, longitude: lon + 0.00136 });
    await page.waitForSelector('#nav-recompute');
    const before = await page.evaluate(() => window.svet.state.route);
    await page.click('#nav-recompute');
    await page.waitForFunction(
      (old) => window.svet.state.nav && window.svet.state.route !== old,
      before,
    );

    const state = await page.evaluate(() => ({
      guiding: !document.getElementById('nav').hidden,
      panel: !document.getElementById('route').hidden,
      from: window.svet.state.places.from.label,
    }));
    assert.deepEqual(state, { guiding: true, panel: false, from: 'Ma position' });
    await context.close();
  },
);

test(
  'changer de zone pendant un chargement installe la zone choisie',
  { timeout: 120000 },
  async () => {
    const context = await phoneContext(browser);
    const page = await context.newPage();
    // Le binaire de la zone lente met trois secondes : un gros fichier sur un
    // réseau mobile.
    await page.route('**/data/lente.data.bin*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await openApp(page, server.url, '?zone=synthese');

    await page.click('#settings-toggle');
    await page.selectOption('#zone', 'lente');
    await page.waitForTimeout(300);
    if (!(await page.isVisible('#zone'))) await page.click('#settings-toggle');
    await page.selectOption('#zone', 'synthese');
    await page.waitForTimeout(5000);

    const zones = await page.evaluate(() => ({
      chosen: document.getElementById('zone').value,
      loaded: window.svet.state.zoneKey,
    }));
    assert.deepEqual(zones, { chosen: 'synthese', loaded: 'synthese' });
    await context.close();
  },
);

test(
  'hors réseau, un onglet rechargé en plein guidage se rouvre',
  { timeout: 180000 },
  async () => {
    const preview = await startPreviewServer(publicDir);
    const context = await phoneContext(browser);
    try {
      const page = await context.newPage();
      // L'application enregistre son service worker une fois la zone chargée ;
      // la visite suivante passe par lui.
      await page.goto(`${preview.url}?zone=synthese`);
      await page.waitForFunction(
        () => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready,
        null,
        {
          timeout: 60000,
        },
      );
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
        timeout: 30000,
      });
      await page.waitForTimeout(1000);

      await preview.close();
      for (const query of [
        '',
        '?zone=synthese',
        '?zone=synthese&de=2.33623,48.85430|A&a=2.34983,48.86000|B&p=30&nav=1',
      ]) {
        const response = await page.goto(`${preview.url}${query}`);
        assert.ok(response?.ok(), `${query || '/'} ne s’ouvre pas hors réseau`);
        assert.ok(await page.evaluate(() => Boolean(document.getElementById('map'))));
      }
    } finally {
      await context.close();
      await preview.close().catch(() => {});
    }
  },
);
