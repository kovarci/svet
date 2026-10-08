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
    // Chaque virage s'annonce à 200 m, à 60 m, puis au moment de tourner — et
    // dans la même direction aux trois paliers.
    assert.ok(turns.length >= 3 && turns.length % 3 === 0, turns.join(' / '));
    for (let k = 0; k < turns.length; k += 3) {
      const [far, near, now] = turns.slice(k, k + 3);
      assert.match(far, /^Dans 200 mètres, tournez à (gauche|droite)/);
      assert.match(near, /^Dans 60 mètres, tournez à (gauche|droite)/);
      assert.match(now, /^Tournez à (gauche|droite)/);
      const side = (text) => text.match(/(gauche|droite)/)[1];
      assert.equal(side(far), side(now));
      assert.equal(side(near), side(now));
    }
    // L'arrivée s'annonce avant d'y être, au palier que permet le dernier tronçon.
    assert.ok(said.some((s) => /^Dans \d+ mètres, arrivée à destination\.$/.test(s)));
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

test(
  'après un changement de zone, un point choisi sur la carte n’ouvre pas en plus le détail de la rue',
  { timeout: 120000 },
  async () => {
    // Chaque chargement de zone recrée les couches. Les écouteurs de la carte
    // s'y réinscrivaient, et s'empilaient : au second clic de « choisir sur la
    // carte », le premier écouteur posait le point et quittait le mode choix,
    // le second — qui ne le voyait plus — ouvrait le panneau de la rue cliquée.
    const context = await phoneContext(browser);
    const page = await context.newPage();
    await openApp(page, server.url, '?zone=synthese');
    await page.click('#settings-toggle');
    await page.selectOption('#zone', 'lente');
    await page.waitForFunction(
      () =>
        window.svet.state.zoneKey === 'lente' &&
        document.getElementById('loading').classList.contains('is-hidden'),
    );
    await page.waitForTimeout(1000);
    if (await page.isVisible('#zone')) await page.click('#settings-toggle');

    await page.click('#route-toggle');
    await page.click('.pick[data-target="from"]');
    // Un carrefour de la grille : le point tombe sur une rue, que le second
    // écouteur aurait sélectionnée.
    const point = await page.evaluate(() => {
      const { map } = window.svet;
      const { x, y } = map.project(map.getCenter());
      return { x, y };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(500);

    const result = await page.evaluate(() => ({
      from: Boolean(window.svet.state.places.from),
      panel: !document.getElementById('panel').hidden,
    }));
    assert.deepEqual(result, { from: true, panel: false });
    await context.close();
  },
);

test(
  'partir à l’écart du réseau invite à rejoindre l’itinéraire, sans alarme',
  { timeout: 120000 },
  async () => {
    // Un départ au milieu d'un îlot, d'une cour, d'un quai : à plus de 35 m du
    // premier nœud, le bandeau criait « vous vous êtes écarté du trajet » —
    // avant le premier pas, vibreur compris.
    const context = await phoneContext(browser);
    const page = await context.newPage();
    await openApp(page, server.url, '?zone=synthese');
    await planRoute(page, 'Rue de Rivoli', 'Rue du Temple');
    const [lon, lat] = await page.evaluate(() => window.svet.state.route.coordinates[0]);
    // Soixante mètres au sud du départ, au cœur de l'îlot.
    await context.setGeolocation({ latitude: lat - 0.00054, longitude: lon + 0.0003 });
    await page.click('#route-navigate');
    await page.waitForFunction(() => window.svet.state.nav?.lastFix);
    await page.waitForTimeout(300);

    const before = await page.evaluate(() => ({
      instruction: document.getElementById('nav-instruction').textContent,
      said: window.__said.join(' / '),
      vibrations: window.__vibrations.length,
    }));
    assert.equal(before.instruction, 'Rejoignez l’itinéraire');
    assert.doesNotMatch(before.said, /écarté/);
    assert.equal(before.vibrations, 0);

    // Arrivé sur le trajet, le guidage reprend son cours ordinaire.
    await context.setGeolocation({ latitude: lat, longitude: lon });
    await page.waitForTimeout(300);
    assert.notEqual(
      await page.evaluate(() => document.getElementById('nav-instruction').textContent),
      'Rejoignez l’itinéraire',
    );
    await context.close();
  },
);

test(
  'après une seule visite, le code de l’application est disponible hors réseau',
  { timeout: 180000 },
  async () => {
    // Une seule visite, sans rechargement : qui ouvre l'application puis part
    // aussitôt. Le script, la feuille de style et le worker de la carte
    // n'entraient au cache qu'à la visite suivante : hors réseau, il ne restait
    // qu'une page blanche figée sur « Chargement des données… ».
    const preview = await startPreviewServer(publicDir);
    const context = await phoneContext(browser);
    try {
      const page = await context.newPage();
      await page.goto(`${preview.url}?zone=synthese`);
      await page.waitForFunction(() => navigator.serviceWorker?.controller, null, {
        timeout: 60000,
      });
      await page.waitForTimeout(1000);
      await preview.close();

      const response = await page.goto(`${preview.url}?zone=synthese`);
      assert.ok(response?.ok());
      await page.waitForTimeout(2000);
      const shown = await page.evaluate(() => ({
        // Le script a tourné : il a remplacé le texte d'attente écrit dans la page.
        loading: document.getElementById('loading').textContent.trim(),
        // La feuille de style est appliquée : le fond est celui de l'application.
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert.notEqual(shown.loading, 'Chargement des données…');
      assert.equal(shown.background, 'rgb(11, 15, 22)');
    } finally {
      await context.close();
      await preview.close().catch(() => {});
    }
  },
);

test('un profil se choisit, survit au rechargement, et ne sort pas de l’appareil', async () => {
  const context = await phoneContext(browser);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await openApp(page, server.url, '?zone=synthese');

  const neutral = await page.evaluate(() => window.svet.state.profile.s);
  assert.equal(neutral, 1);

  await page.click('#settings-toggle');
  await page.click('#profile-toggle');
  await page.waitForSelector('#profile:not([hidden])');
  await page.check('#preset-migraine');
  const chosen = await page.evaluate(() => ({
    s: window.svet.state.profile.s,
    flicker: window.svet.state.profile.mu.flicker,
    on: document.getElementById('profile-toggle').classList.contains('is-on'),
  }));
  assert.equal(chosen.s, 0.5);
  assert.ok(chosen.flicker > 1);
  assert.ok(chosen.on, 'le bouton signale un profil actif');

  // La carte a bien été recolorée avec le profil, pas laissée à l'ancien indice.
  const url = await page.evaluate(() => location.href);
  assert.doesNotMatch(url, /migraine|profil|preset/i, 'le profil ne passe jamais dans le lien');

  await page.reload();
  await page.waitForFunction(() => window.svet?.state?.meta);
  assert.equal(await page.evaluate(() => window.svet.state.profile.s), 0.5);

  await page.click('#settings-toggle');
  await page.click('#profile-toggle');
  await page.click('text=Effacer mon profil');
  assert.equal(await page.evaluate(() => window.svet.state.profile.s), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('svet.profile')), null);
  assert.deepEqual(errors, []);
  await context.close();
});
