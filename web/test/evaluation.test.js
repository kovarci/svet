/**
 * L'exposition d'un trottoir à une minute donnée, sur une zone jouet.
 *
 * C'est le cœur du navigateur, et c'était la seule partie qu'aucun test
 * n'atteignait : elle vivait dans `main.js`, mêlée à la carte et au DOM. Or
 * rien de ce qui s'y trompe ne plante. Une interpolation décalée d'un pas,
 * des flux mesurés perdus en route, un cache qui garde le ciel d'hier, un mode
 * qui lit la mauvaise composante : chaque fois la carte reste colorée, les
 * couleurs sont plausibles, et elles sont fausses.
 *
 * La zone tient en quelques lignes — quatre pas de temps, une rue à deux
 * trottoirs, un tronçon dont la cellule n'est pas arrivée — et l'état de
 * l'application est un simple objet qu'on modifie entre deux appels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../../pipeline/src/config.js';
import { skyConditions } from '../../pipeline/src/model.js';
import { DEG } from '../../pipeline/src/lib/sun.js';
import { createEvaluator, sampleSide, uvFallback } from '../src/evaluation.js';
import { CLEAR_SKY } from '../src/weather.js';

const BINS = 16;

/** Quatre pas d'une demi-heure, de midi à 13 h 30 : le soleil est haut. */
const META = {
  date: '2026-06-21',
  times: [720, 750, 780, 810].map((minutes) => ({ minutes })),
  horizonBins: BINS,
  albedo: CONFIG.albedo,
  groundAlbedo: CONFIG.groundAlbedo,
  luxReference: CONFIG.luxReference,
  weights: CONFIG.weights,
};

/** Séries d'un trottoir, telles que `sideAt` les rend : des octets. */
function series(sun, flicker = sun.map(() => 0), horizon = 20) {
  return {
    sun: Uint8Array.from(sun),
    flicker: Uint8Array.from(flicker),
    horizon: new Uint8Array(BINS).fill(horizon),
  };
}

function street(overrides = {}) {
  return {
    name: 'Rue jouet',
    twoSided: true,
    lSide: 'nord',
    rSide: 'sud',
    lSvf: 80,
    rSvf: 30,
    lCanopy: 0,
    rCanopy: 40,
    lVeil: 0,
    rVeil: 0,
    lWork: 0,
    rWork: 0,
    ...overrides,
  };
}

const SUNNY = series([100, 100, 100, 100], [0, 0, 0, 0], 10);
const SHADED = series([0, 0, 0, 0], [0, 0, 0, 0], 50);

/**
 * Relevés comme les rend une zone ou une région : `null` pour ce qui manque.
 *
 *  0. une rue au soleil côté nord, à l'ombre côté sud ;
 *  1. la même, mais le trottoir à l'ombre est barré par un chantier ;
 *  2. un tronçon connu dont les séries manquent ;
 *  3. rien du tout : la cellule n'est pas encore chargée.
 */
const ROWS = [
  { segment: street(), left: SUNNY, right: SHADED },
  { segment: street({ rWork: 100 }), left: SUNNY, right: SHADED },
  { segment: street(), left: null, right: null },
];

function toyData(rows) {
  return {
    segmentAt: (id) => rows[id]?.segment ?? null,
    sideAt: (id, right) => (right ? rows[id]?.right : rows[id]?.left) ?? null,
  };
}

/** Deux jours de prévision, avec des valeurs qui s'interpolent sans arrondi. */
const FORECAST = {
  dates: ['2026-06-21', '2026-06-22'],
  series: {
    '2026-06-21': [
      { cloud: 0.25, uv: 6, rain: 0, irradiance: { beam: 600, diffuse: 100 } },
      { cloud: 0.75, uv: 8, rain: 1, irradiance: { beam: 800, diffuse: 200 } },
      // Un pas sans flux : la prévision ne les fournit pas toujours.
      { cloud: 0.75, uv: 8, rain: 1 },
      { cloud: 0.75, uv: 8, rain: 1, irradiance: { beam: 800, diffuse: 200 } },
    ],
    '2026-06-22': Array.from({ length: 4 }, () => ({
      cloud: 1,
      uv: 1,
      rain: 0,
      irradiance: { beam: 0, diffuse: 150 },
    })),
  },
};

/** Un évaluateur branché sur un état qu'on modifie à la main. */
function setup(overrides = {}) {
  const world = {
    meta: META,
    data: toyData(ROWS),
    forecast: null,
    skyMode: 'forecast',
    day: null,
    mode: 'index',
    ...overrides,
  };
  const evaluator = createEvaluator({
    getMeta: () => world.meta,
    getData: () => world.data,
    getForecast: () => world.forecast,
    getSkyMode: () => world.skyMode,
    getDay: () => world.day,
    getMode: () => world.mode,
  });
  return { world, ...evaluator };
}

test('entre deux pas de temps, les relevés s’interpolent', () => {
  const { seriesCursor, evaluateSide, contextAt } = setup();

  assert.deepEqual(seriesCursor(735), { i: 0, j: 1, t: 0.5 });
  assert.deepEqual(seriesCursor(750), { i: 1, j: 2, t: 0 });
  // Hors de la plage calculée, on tient le premier ou le dernier pas : une
  // extrapolation inventerait du soleil avant l'aube.
  assert.deepEqual(seriesCursor(600), { i: 0, j: 1, t: 0 });
  assert.deepEqual(seriesCursor(900), { i: 3, j: 3, t: 1 });

  const rising = series([0, 100, 100, 100], [40, 0, 0, 0]);
  assert.deepEqual(sampleSide(rising, seriesCursor(735)), { transmission: 0.5, flicker: 0.2 });

  // Et c'est bien la valeur interpolée qui entre dans le modèle, pas celle du
  // pas le plus proche.
  const entry = { ...rising, svf: 50 };
  assert.equal(evaluateSide(entry, contextAt(735)).transmission, 0.5);
  assert.equal(evaluateSide(entry, contextAt(720)).transmission, 0);
  assert.equal(evaluateSide(entry, contextAt(750)).transmission, 1);
});

test('la météo interpolée garde les flux mesurés', () => {
  const { world, weatherAt, contextAt, evaluateSide, invalidateContexts } = setup({
    forecast: FORECAST,
    day: '2026-06-21',
  });

  assert.deepEqual(weatherAt(735), {
    cloud: 0.5,
    uv: 7,
    rain: 0.5,
    dewPoint: null,
    irradiance: { beam: 700, diffuse: 150 },
    source: 'météo',
  });

  // Les flux ont traversé l'interpolation jusqu'au ciel : sans eux, le modèle
  // retomberait en silence sur la déduction par nébulosité.
  const context = contextAt(735);
  assert.equal(context.sky.measured, true);
  const expected = skyConditions(
    context.sun.altitude,
    0.5,
    { beam: 700, diffuse: 150 },
    context.sun.azimuth,
    BINS,
    // 21 juin, sans point de rosée : 2 cm d'eau précipitable.
    { dayOfYear: 172, precipitableWater: 2 },
  );
  assert.equal(context.sky.directNormal, expected.directNormal);
  assert.equal(context.sky.diffuseHorizontal, expected.diffuseHorizontal);

  // Un pas sans flux ne les fait pas tomber à zéro : on garde ceux du pas
  // précédent, faute de mieux, plutôt que d'annoncer une nuit en plein midi.
  assert.deepEqual(weatherAt(765).irradiance, { beam: 800, diffuse: 200 });

  // L'UV de la prévision prime sur l'approximation par la hauteur du soleil.
  const open = { ...SUNNY, svf: 100 };
  assert.ok(Math.abs(evaluateSide(open, context).uv - 7) < 1e-9);

  // Le jour choisi décide de la série ; un jour inconnu retombe sur le premier.
  world.day = '2026-06-22';
  invalidateContexts();
  assert.equal(weatherAt(735).cloud, 1);
  world.day = '2026-06-25';
  assert.equal(weatherAt(735).cloud, 0.5);

  // Ciel clair demandé, ou pas de prévision : la référence, et l'objet
  // lui-même — l'affichage le reconnaît par identité.
  world.skyMode = 'clear';
  assert.equal(weatherAt(735), CLEAR_SKY);
  world.skyMode = 'forecast';
  world.forecast = null;
  assert.equal(weatherAt(735), CLEAR_SKY);
});

test('le contexte se retient à la minute, et s’oublie quand on le demande', () => {
  const { world, contextAt, invalidateContexts } = setup({
    forecast: FORECAST,
    day: '2026-06-21',
  });

  const first = contextAt(735);
  assert.equal(contextAt(735.3), first);
  assert.notEqual(contextAt(736), first);

  // Le contrat : c'est l'appelant qui prévient quand un ingrédient change.
  // Sans invalidation, le ciel d'avant reste — c'est ce que fait le cache.
  world.day = '2026-06-22';
  assert.equal(contextAt(735).weather.cloud, 0.5);
  invalidateContexts();
  assert.notEqual(contextAt(735), first);
  assert.equal(contextAt(735).weather.cloud, 1);

  // Deux évaluateurs ne partagent pas leur mémoire.
  const other = setup({ forecast: FORECAST, day: '2026-06-21' });
  assert.equal(other.contextAt(735).weather.cloud, 0.5);
});

test('chaque mode de lecture affiche sa propre composante', () => {
  const { world, displayValue } = setup();
  const evaluated = {
    index: 42,
    sun: 0.25,
    svf: 0.5,
    glare: 0.75,
    flicker: 0.125,
    reverb: 0.375,
    night: 0.625,
    uv: 6.5,
  };
  const expected = {
    index: 42,
    sun: 25,
    svf: 50,
    glare: 75,
    flicker: 12.5,
    reverb: 37.5,
    night: 62.5,
    // L'UV reste sur son échelle propre, de 0 à 11 : c'est la carte qui la
    // ramène à cent.
    uv: 6.5,
  };
  for (const [mode, value] of Object.entries(expected)) {
    world.mode = mode;
    assert.equal(displayValue(evaluated), value, mode);
  }

  // Un mode disparu — réglage d'une version antérieure — retombe sur l'indice.
  world.mode = 'disparu';
  assert.equal(displayValue(evaluated), 42);
});

test('chaque trottoir lit ses propres attributs', () => {
  const { sideOf } = setup();
  const left = sideOf(0, false);
  const right = sideOf(0, true);

  // Un côté qui lirait les attributs de l'autre donnerait une carte inversée,
  // parfaitement plausible.
  assert.deepEqual(
    { side: left.side, svf: left.svf, canopy: left.canopy, work: left.work },
    { side: 'nord', svf: 80, canopy: 0, work: 0 },
  );
  assert.deepEqual(
    { side: right.side, svf: right.svf, canopy: right.canopy, work: right.work },
    { side: 'sud', svf: 30, canopy: 40, work: 0 },
  );
  assert.equal(left.sun, SUNNY.sun);
  assert.equal(right.sun, SHADED.sun);
});

test('l’itinéraire passe du côté le moins exposé, chantier compris', () => {
  const { evaluateSegment, evaluateSide, sideOf, contextAt } = setup();
  const context = contextAt(735);
  const sunny = evaluateSide(sideOf(0, false), context);
  const shaded = evaluateSide(sideOf(0, true), context);
  assert.ok(shaded.index + 10 < sunny.index, `${shaded.index} contre ${sunny.index}`);

  assert.deepEqual(evaluateSegment(0, 735), {
    index: shaded.index,
    sun: shaded.sun * 100,
    side: 'sud',
    work: 0,
    twoSided: true,
    name: 'Rue jouet',
  });

  // Le trottoir à l'ombre est barré : on passe en face, et on annonce
  // l'exposition réelle de ce côté-là, pas un indice gonflé par la palissade.
  assert.deepEqual(evaluateSegment(1, 735), {
    index: sunny.index,
    sun: sunny.sun * 100,
    side: 'nord',
    work: 0,
    twoSided: true,
    name: 'Rue jouet',
  });
});

test('un chantier léger ne fait pas changer de côté, ni d’indice', () => {
  const rows = [{ segment: street({ rWork: 5 }), left: SUNNY, right: SHADED }];
  const { evaluateSegment, evaluateSide, sideOf, contextAt } = setup({ data: toyData(rows) });
  const shaded = evaluateSide(sideOf(0, true), contextAt(735));

  const result = evaluateSegment(0, 735);
  assert.equal(result.side, 'sud');
  assert.equal(result.work, 5);
  // L'emprise départage les côtés ; elle n'entre pas dans l'indice rendu.
  assert.equal(result.index, shaded.index);
});

test('un tronçon sans relevés rend null, et l’itinéraire un coût neutre', () => {
  const { sideOf, evaluateSegment } = setup();
  const neutral = { index: 50, sun: 0, side: null, work: 0, twoSided: false, name: null };

  // Cellule pas encore chargée : ni tronçon, ni séries. Un relevé à zéro se
  // lirait « aucune gêne », exactement ce qu'il ne faut pas dire.
  assert.equal(sideOf(3, false), null);
  assert.equal(sideOf(3, true), null);
  assert.deepEqual(evaluateSegment(3, 735), neutral);

  // Tronçon connu, séries absentes : même réponse.
  assert.equal(sideOf(2, false), null);
  assert.deepEqual(evaluateSegment(2, 735), neutral);
});

test('le soleil suit la date de la zone, et l’UV sans prévision sa hauteur', () => {
  const { world, sunAt, contextAt, evaluateSide } = setup();

  // 13 h 30 à Paris, au solstice d'été puis d'hiver : la date vient des
  // métadonnées, pas de l'horloge de la machine.
  const summer = sunAt(810).altitude * DEG;
  world.meta = { ...META, date: '2026-12-21' };
  const winter = sunAt(810).altitude * DEG;
  assert.ok(summer > 60 && winter < 20, `${summer.toFixed(1)}° puis ${winter.toFixed(1)}°`);

  // Sans prévision, l'UV d'un trottoir pleinement dégagé est celui qu'on
  // déduit de la hauteur du soleil.
  world.meta = META;
  const context = contextAt(780);
  assert.equal(context.weather, CLEAR_SKY);
  const open = { ...SUNNY, svf: 100 };
  assert.ok(Math.abs(evaluateSide(open, context).uv - uvFallback(context.sun.altitude)) < 1e-9);

  assert.equal(uvFallback(-0.1), 0);
  assert.equal(uvFallback(0), 0);
  assert.equal(uvFallback(Math.PI / 2), 8.5);
  assert.ok(uvFallback(0.3) < uvFallback(0.6));
});

test('le point de rosée prévu atteint le ciel', () => {
  // Les efficacités lumineuses de Perez dépendent de l'eau précipitable : un
  // ciel calculé sans l'humidité prévue serait faux de quelques pour cent sans
  // que rien ne le signale.
  const humid = {
    dates: ['2026-06-21'],
    series: {
      '2026-06-21': Array.from({ length: 4 }, () => ({
        cloud: 0,
        uv: 6,
        rain: 0,
        dewPoint: 20,
        irradiance: { beam: 700, diffuse: 120 },
      })),
    },
  };
  const dry = structuredClone(humid);
  for (const step of dry.series['2026-06-21']) step.dewPoint = -5;

  const wet = setup({ forecast: humid, day: '2026-06-21' }).contextAt(735);
  const arid = setup({ forecast: dry, day: '2026-06-21' }).contextAt(735);
  assert.equal(wet.weather.dewPoint, 20);
  assert.notEqual(wet.sky.directNormal, arid.sky.directNormal);
});
