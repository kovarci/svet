/**
 * Ce que propose la recherche de lieu.
 *
 * Une suggestion fausse ne plante rien : elle envoie l'itinéraire partir d'un
 * autre endroit que celui qu'on a choisi. Deux défauts de ce genre :
 *
 *  - une rue homonyme dans deux villes de la région devenait **un** point, la
 *    moyenne des deux — au milieu des champs, et l'itinéraire partait du nœud le
 *    plus proche de nulle part ;
 *  - la même rue revenait deux fois dans la liste, une fois du réseau, une fois
 *    de la Base Adresse Nationale (« Rue de Rivoli 75001 Paris »).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  indexStreetNames,
  mergeSuggestions,
  searchAddresses,
  searchLocal,
} from '../src/geocode.js';

/** Un graphe jouet : chaque rue est une suite de nœuds reliés bout à bout. */
function network(streets) {
  const nodeLon = [];
  const nodeLat = [];
  const edgeA = [];
  const edgeB = [];
  const edgeSegment = [];
  const names = [];
  for (const { name, points } of streets) {
    const first = nodeLon.length;
    for (const [lon, lat] of points) {
      nodeLon.push(lon);
      nodeLat.push(lat);
    }
    for (let i = 1; i < points.length; i++) {
      edgeA.push(first + i - 1);
      edgeB.push(first + i);
      edgeSegment.push(names.length);
      names.push(name);
    }
  }
  return {
    data: { segmentAt: (id) => ({ name: names[id] }) },
    graph: { edgeCount: edgeA.length, edgeA, edgeB, edgeSegment, nodeLon, nodeLat },
  };
}

const flat = ([lon1, lat1], [lon2, lat2]) =>
  Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 111132);

test('deux rues homonymes éloignées restent deux lieux, chacun sur sa rue', () => {
  // « Rue de la République » à Saint-Denis et à Montreuil, à dix kilomètres.
  const { data, graph } = network([
    {
      name: 'Rue de la République',
      points: [
        [2.355, 48.936],
        [2.357, 48.937],
        [2.359, 48.938],
      ],
    },
    {
      name: 'Rue de la République',
      points: [
        [2.441, 48.861],
        [2.443, 48.862],
        [2.445, 48.863],
      ],
    },
  ]);
  const entries = indexStreetNames(data, graph).filter((e) => e.label === 'Rue de la République');
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const nearest = Math.min(
      ...graph.nodeLon.map((lon, i) => flat([entry.lon, entry.lat], [lon, graph.nodeLat[i]])),
    );
    assert.ok(nearest < 1, `point à ${nearest.toFixed(0)} m de la rue`);
  }
});

test('une rue coudée garde un point sur la rue, pas au creux du coude', () => {
  // En L : la moyenne des nœuds tomberait dans l'îlot, à 50 m de toute voie.
  const { data, graph } = network([
    {
      name: 'Rue en équerre',
      points: [
        [2.35, 48.85],
        [2.3505, 48.85],
        [2.351, 48.85],
        [2.351, 48.8505],
        [2.351, 48.851],
      ],
    },
  ]);
  const [entry] = indexStreetNames(data, graph);
  const nearest = Math.min(
    ...graph.nodeLon.map((lon, i) => flat([entry.lon, entry.lat], [lon, graph.nodeLat[i]])),
  );
  assert.ok(nearest < 1);
});

test('une rue coupée par une place reste un seul lieu', () => {
  const { data, graph } = network([
    {
      name: 'Rue Saint-Antoine',
      points: [
        [2.36, 48.853],
        [2.362, 48.853],
      ],
    },
    {
      name: 'Rue Saint-Antoine',
      points: [
        [2.3635, 48.853],
        [2.365, 48.853],
      ],
    },
  ]);
  assert.equal(indexStreetNames(data, graph).length, 1);
});

test('des homonymes dans la liste se distinguent par leur distance, le plus proche d’abord', () => {
  const streets = [
    { label: 'Rue de la République', lon: 2.357, lat: 48.937, source: 'réseau' },
    { label: 'Rue de la République', lon: 2.443, lat: 48.862, source: 'réseau' },
  ];
  const found = searchLocal(streets, 'republique', 6, [2.44, 48.86]);
  assert.equal(found.length, 2);
  assert.equal(found[0].lon, 2.443);
  assert.match(found[0].source, /réseau · à [\d,]+ km/);
  assert.notEqual(found[0].source, found[1].source);
});

test('une rue déjà proposée par le réseau ne revient pas de la Base Adresse Nationale', () => {
  const local = [{ label: 'Rue de Rivoli', lon: 2.3522, lat: 48.8567, source: 'réseau' }];
  const remote = [
    {
      label: 'Rue de Rivoli 75001 Paris',
      name: 'Rue de Rivoli',
      lon: 2.3531,
      lat: 48.8572,
      source: 'rue',
    },
    {
      label: '12 Rue de Rivoli 75004 Paris',
      name: '12 Rue de Rivoli',
      lon: 2.356,
      lat: 48.8555,
      source: 'adresse',
    },
    // Même nom, autre commune : ce n'est pas la même rue.
    {
      label: 'Rue de Rivoli 94100 Saint-Maur',
      name: 'Rue de Rivoli',
      lon: 2.49,
      lat: 48.8,
      source: 'rue',
    },
  ];
  assert.deepEqual(
    mergeSuggestions(local, remote).map((s) => s.label),
    ['Rue de Rivoli', '12 Rue de Rivoli 75004 Paris', 'Rue de Rivoli 94100 Saint-Maur'],
  );
});

test('les adresses de la BAN gardent le nom de voie, qui sert à reconnaître les doublons', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [
        {
          properties: { label: 'Rue de Rivoli 75001 Paris', name: 'Rue de Rivoli', type: 'street' },
          geometry: { coordinates: [2.3531, 48.8572] },
        },
      ],
    }),
  });
  try {
    const [item] = await searchAddresses('rue de rivoli');
    assert.deepEqual(item, {
      label: 'Rue de Rivoli 75001 Paris',
      name: 'Rue de Rivoli',
      lon: 2.3531,
      lat: 48.8572,
      source: 'rue',
    });
  } finally {
    globalThis.fetch = original;
  }
});
