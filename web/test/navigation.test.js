/**
 * Le guidage, rejoué sans capteur.
 *
 * Tout ce fichier existe pour une raison : sur le terrain, un guidage faux ne
 * se signale pas. Il annonce une distance qui remonte, un virage qui n'existe
 * pas, un trottoir qu'on vient de quitter — et l'on met plusieurs centaines de
 * mètres à comprendre que c'est l'application qui se trompe, pas soi. Or c'est
 * le moment où l'on marche, où l'on ne regarde pas l'écran, et où l'on a le
 * moins de moyens de vérifier.
 *
 * Les fonctions visées sont pures : un itinéraire décrit à la main, des
 * positions posées à la main, et l'on compare. Aucun GPS, aucun navigateur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceProgress,
  angleDifference,
  bearingBetween,
  buildInstructions,
  describeManoeuvre,
  distance,
  nextManoeuvre,
  snapToRoute,
} from '../src/navigation.js';

// ------------------------------------------------------------------ géométrie

test('le cap se compte depuis le nord, dans le sens horaire', () => {
  assert.equal(Math.round(bearingBetween([2.35, 48.85], [2.35, 48.86])), 0);
  assert.equal(Math.round(bearingBetween([2.35, 48.85], [2.36, 48.85])), 90);
  assert.equal(Math.round(bearingBetween([2.35, 48.85], [2.35, 48.84])), 180);
  assert.equal(Math.round(bearingBetween([2.35, 48.85], [2.34, 48.85])), 270);
});

test('l’écart de cap reste dans [-180, 180], positif vers la droite', () => {
  assert.equal(angleDifference(10, 350), 20);
  assert.equal(angleDifference(350, 10), -20);
  assert.equal(Math.abs(angleDifference(180, 0)), 180);
});

// ----------------------------------------------------------- progression GPS

test('le bruit du GPS ne fait pas reculer la progression', () => {
  // Trois mesures qui bruitent autour de 100 m : la progression ne redescend
  // jamais, sans quoi la distance à la prochaine manœuvre remonterait.
  let progress = advanceProgress(undefined, 100);
  assert.equal(progress, 100);
  progress = advanceProgress(progress, 94);
  assert.equal(progress, 100);
  progress = advanceProgress(progress, 103);
  assert.equal(progress, 103);
});

test('un vrai demi-tour, lui, est suivi', () => {
  // Au-delà du seuil, ce n'est plus du bruit : on a réellement rebroussé chemin
  // et s'obstiner à croire l'ancienne position rendrait le guidage aveugle.
  assert.equal(advanceProgress(300, 260), 260);
  assert.equal(advanceProgress(300, 280), 300);
});

// ------------------------------------------------------------------- recalage

/** Un itinéraire en L : cent mètres vers l'est, puis cent mètres vers le nord. */
const L_ROUTE = {
  coordinates: [
    [2.35, 48.85],
    [2.35137, 48.85],
    [2.35137, 48.8509],
  ],
  steps: [
    {
      length: 100,
      name: 'Rue de l’Est',
      crossing: false,
      state: { index: 20, side: 'sud', twoSided: true },
    },
    {
      length: 100,
      name: 'Rue du Nord',
      crossing: false,
      state: { index: 20, side: 'ouest', twoSided: true },
    },
  ],
};

test('une position sur le trajet se recale avec un écart nul', () => {
  const fix = snapToRoute(L_ROUTE, 2.35068, 48.85);
  assert.ok(fix.offset < 1, `écart de ${fix.offset.toFixed(1)} m sur un point du trajet`);
  assert.ok(Math.abs(fix.distanceAlong - 50) < 3);
});

test('une position à côté donne son écart réel', () => {
  // Environ 22 m au nord du premier segment.
  const fix = snapToRoute(L_ROUTE, 2.35068, 48.8502);
  assert.ok(fix.offset > 15 && fix.offset < 30, `écart mesuré : ${fix.offset.toFixed(1)} m`);
});

test('la distance cumulée tient compte de la partie déjà parcourue', () => {
  const fix = snapToRoute(L_ROUTE, 2.35137, 48.85045);
  // Cent mètres de la première branche, plus la moitié de la seconde.
  assert.ok(Math.abs(fix.distanceAlong - 150) < 5, `cumul : ${fix.distanceAlong.toFixed(1)} m`);
});

test('l’amorce évite de sauter sur un brin qui se recoupe', () => {
  // Un aller-retour : trois cents mètres vers l'est, puis le retour deux mètres
  // plus au nord. C'est la géométrie d'un boulevard qu'on remonte du trottoir
  // d'en face — et le GPS ne sait pas dire lequel des deux brins on suit.
  const there = Array.from({ length: 30 }, (_, i) => [2.35 + i * 0.0001, 48.85]);
  const back = Array.from({ length: 30 }, (_, i) => [2.3529 - i * 0.0001, 48.850019]);
  const loop = { coordinates: [...there, ...back], steps: [] };

  // Un point posé à un mètre du brin de retour, à deux mètres de celui de
  // l'aller : le plus proche n'est pas celui qu'on parcourt.
  const near = [2.351, 48.850017];

  const blind = snapToRoute(loop, near[0], near[1]);
  const hinted = snapToRoute(loop, near[0], near[1], 10);
  assert.ok(blind.index >= 30, `sans amorce, on saute sur le brin de retour (${blind.index})`);
  assert.ok(hinted.index < 30, `avec l’amorce, on reste sur l’aller (${hinted.index})`);
  // Et la différence n'est pas cosmétique : elle vaut la moitié du trajet.
  assert.ok(blind.distanceAlong > hinted.distanceAlong + 200);
});

// ------------------------------------------------------------------ manœuvres

test('un virage franc devient une manœuvre, une courbe non', () => {
  const instructions = buildInstructions(L_ROUTE);
  const types = instructions.map((i) => i.type);
  assert.equal(types[0], 'depart');
  assert.ok(types.includes('left'), `types obtenus : ${types.join(', ')}`);
  assert.equal(types.at(-1), 'arrive');
});

test('la dernière manœuvre porte la longueur totale', () => {
  const instructions = buildInstructions(L_ROUTE);
  assert.equal(instructions.at(-1).distance, 200);
});

test('un changement de côté recommandé devient une consigne', () => {
  const route = {
    coordinates: [
      [2.35, 48.85],
      [2.3514, 48.85],
      [2.3528, 48.85],
    ],
    steps: [
      {
        length: 100,
        name: 'Rue de Rivoli',
        crossing: false,
        state: { index: 20, side: 'nord', twoSided: true },
      },
      {
        length: 100,
        name: 'Rue de Rivoli',
        crossing: true,
        state: { index: 20, side: 'sud', twoSided: true },
      },
    ],
  };
  const instructions = buildInstructions(route);
  assert.ok(instructions.some((i) => i.type === 'crossing'));
});

test('le côté retenu est celui qui domine la rue, pas celui de chaque tronçon', () => {
  // Trois tronçons de la même rue : deux au nord, un au sud pris en sandwich.
  // Personne ne traverse deux fois pour trente mètres d'ombre.
  const zigzag = {
    coordinates: [
      [2.35, 48.85],
      [2.3514, 48.85],
      [2.3518, 48.85],
      [2.3532, 48.85],
    ],
    steps: [
      {
        length: 100,
        name: 'Rue Auber',
        crossing: false,
        state: { index: 20, side: 'nord', twoSided: true },
      },
      {
        length: 30,
        name: 'Rue Auber',
        crossing: false,
        state: { index: 20, side: 'sud', twoSided: true },
      },
      {
        length: 100,
        name: 'Rue Auber',
        crossing: false,
        state: { index: 20, side: 'nord', twoSided: true },
      },
    ],
  };
  const sides = buildInstructions(zigzag).map((i) => i.side);
  assert.ok(!sides.includes('sud'), `côtés annoncés : ${sides.join(', ')}`);
});

test('la prochaine manœuvre ne réannonce pas celle qu’on vient de prendre', () => {
  const instructions = [
    { index: 0, distance: 0, type: 'depart' },
    { index: 1, distance: 100, type: 'left' },
    { index: 2, distance: 200, type: 'arrive' },
  ];
  const { instruction, remaining } = nextManoeuvre(instructions, 104);
  assert.equal(instruction.type, 'arrive');
  assert.equal(remaining, 96);

  // À quatre mètres du virage, on l'annonce encore : c'est maintenant.
  assert.equal(nextManoeuvre(instructions, 96).instruction.type, 'arrive');
  assert.equal(nextManoeuvre(instructions, 80).instruction.type, 'left');
});

test('le libellé d’une manœuvre porte la rue, sauf à l’arrivée', () => {
  assert.match(describeManoeuvre({ type: 'left', name: 'Rue Vieille du Temple' }).text, /Temple/);
  assert.equal(describeManoeuvre({ type: 'arrive', name: 'Rue X' }).text, 'Vous êtes arrivé');
});

test('la distance plane vaut la distance réelle à quelques mètres près', () => {
  // Un degré de latitude fait 111,1 km ; on vérifie qu'on ne s'est pas trompé
  // d'ordre de grandeur, ce qui fausserait toutes les annonces.
  assert.ok(Math.abs(distance([2.35, 48.85], [2.35, 48.86]) - 1111) < 15);
});
