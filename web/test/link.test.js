/**
 * Ce qu'un lien porte.
 *
 * Un lien d'itinéraire s'envoie à quelqu'un et se rouvre après un rechargement
 * d'onglet — c'est-à-dire dans les deux cas où personne n'est là pour vérifier
 * qu'il dit bien ce qu'il devrait. On fixe donc ici l'aller-retour, et surtout
 * ce qu'il advient d'un lien abîmé : tronqué par une messagerie, tapé à la
 * main, écrit par une version antérieure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePlace, encodePlace, readRoute, writeRoute } from '../src/link.js';

const BASE = 'https://exemple.fr/svet/?zone=paris#15/48.85/2.35';

test('un lieu fait l’aller-retour sans perdre le trottoir', () => {
  const place = { lon: 2.351234, lat: 48.856789, label: 'Gare Saint-Lazare' };
  const back = decodePlace(encodePlace(place));
  // Cinq décimales valent le mètre : c'est la précision d'un trottoir.
  assert.ok(Math.abs(back.lon - place.lon) < 1e-5);
  assert.ok(Math.abs(back.lat - place.lat) < 1e-5);
  assert.equal(back.label, place.label);
});

test('un libellé contenant une virgule survit', () => {
  const place = { lon: 2.35, lat: 48.85, label: '12, rue de Sévigné, Paris' };
  assert.equal(decodePlace(encodePlace(place)).label, place.label);
});

test('des coordonnées seules donnent un libellé lisible', () => {
  const place = decodePlace('2.35000,48.85000');
  assert.equal(place.lon, 2.35);
  assert.equal(place.label, '48.85000, 2.35000');
});

test('un paramètre abîmé ne rend pas un lieu à moitié', () => {
  // Le pire cas serait un lieu dont la latitude est `NaN` : le calcul partirait
  // et échouerait bien plus loin, sur un message qui ne parlerait pas de ça.
  assert.equal(decodePlace('nord-est|Quelque part'), null);
  assert.equal(decodePlace('2.35|Sans latitude'), null);
  assert.equal(decodePlace(''), null);
  assert.equal(encodePlace({ lon: 2.35, lat: undefined, label: 'x' }), null);
});

test('l’itinéraire s’écrit dans l’URL sans toucher au reste', () => {
  const url = writeRoute(BASE, {
    from: { lon: 2.35, lat: 48.85, label: 'Départ' },
    to: { lon: 2.36, lat: 48.86, label: 'Arrivée' },
    alpha: 15,
    navigating: true,
  });
  const parsed = new URL(url);
  // La zone et le cadrage appartiennent à d'autres : les écraser ferait perdre
  // la position au premier calcul d'itinéraire.
  assert.equal(parsed.searchParams.get('zone'), 'paris');
  assert.equal(parsed.hash, '#15/48.85/2.35');

  const route = readRoute(url);
  assert.equal(route.from.label, 'Départ');
  assert.equal(route.to.label, 'Arrivée');
  assert.equal(route.alpha, 15);
  assert.equal(route.navigating, true);
});

test('un itinéraire vide efface ses paramètres, et eux seuls', () => {
  const withRoute = writeRoute(BASE, {
    from: { lon: 2.35, lat: 48.85, label: 'A' },
    to: { lon: 2.36, lat: 48.86, label: 'B' },
    alpha: 30,
  });
  const cleared = new URL(writeRoute(withRoute, {}));
  assert.equal(cleared.searchParams.has('de'), false);
  assert.equal(cleared.searchParams.has('a'), false);
  assert.equal(cleared.searchParams.has('p'), false);
  assert.equal(cleared.searchParams.get('zone'), 'paris');
});

test('une priorité hors bornes est ignorée plutôt que subie', () => {
  // Le curseur va de 0 à 60 ; une valeur écrite à la main ne doit pas le coincer
  // sur une position qu'il ne sait pas rendre.
  const withPriority = (value) => `https://exemple.fr/svet/?zone=paris&p=${value}#15/48.85/2.35`;
  assert.equal(readRoute(withPriority(900)).alpha, null);
  assert.equal(readRoute(withPriority('beaucoup')).alpha, null);
  assert.equal(readRoute(withPriority(0)).alpha, 0);
  // Absente, elle ne vaut pas zéro : « le plus rapide » est un choix, pas un
  // défaut, et l'imposer viderait l'application de son objet.
  assert.equal(readRoute(BASE).alpha, null);
});

test('un lien sans itinéraire ne prétend pas en avoir un', () => {
  const route = readRoute(BASE);
  assert.equal(route.from, null);
  assert.equal(route.to, null);
  assert.equal(route.navigating, false);
});
