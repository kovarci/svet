/**
 * Propriétés vérifiables sans luxmètre et sans utilisateur.
 *
 * Le projet n'avait aucun test, et il en a payé le prix : sens d'enroulement
 * inversé entre tuiles et GeoJSON, champs renommés à l'empaquetage, décalages
 * de format binaire. Chacun était **silencieux** — l'application affichait des
 * couleurs plausibles et fausses, ce qui est pire qu'un plantage.
 *
 * On ne teste donc pas « le modèle dit-il vrai » — ça demande de sortir avec un
 * appareil. On teste ce qui doit tenir quoi qu'il arrive :
 *
 *  - l'**astronomie**, contre des éphémérides publiées ;
 *  - les **invariants** du modèle : monotonies, bornes, symétries ;
 *  - l'**aller-retour binaire** : ce qu'on écrit est ce qu'on relit.
 *
 * `node --test pipeline/test`
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sunPosition,
  applyRefraction,
  localToUTC,
  localDate,
  localMinutes,
  airMass,
  clearSkyIlluminance,
  clearSkyIrradiance,
  eccentricity,
  linkeTurbidity,
  luminousEfficacy,
  perezSkyIndices,
  precipitableWater,
  PEREZ_BINS,
  DEG,
} from '../src/lib/sun.js';
import {
  components,
  discomfortIndex,
  illuminance,
  reverberation,
  skyConditions,
  beamColourTemperature,
  skyColourTemperature,
  melanopicIlluminance,
  daylightMelanopicRatio,
  positionIndex,
  glareFactor,
  melanopicRatio,
  nightShare,
  veilingLuminance,
  localUV,
  uvDirectFraction,
  flickerFactor,
  dappleFactor,
  wetnessFromRain,
  CARDINALS,
  HIGHWAYS,
} from '../src/model.js';
import { coverKind } from '../src/fetch/network.js';
import { declaredAbsent } from '../src/sidewalks.js';

const PARIS = { lat: 48.8566, lon: 2.3522 };

// ─────────────────────────────────────────────────────────── astronomie ─────

test('midi solaire parisien tombe à l’heure connue', () => {
  // Paris est à 2,35° E, soit 9,4 min à l'est du méridien de son fuseau (15° E
  // en été). Le midi solaire est donc vers 13h50 heure légale d'été, décalé de
  // l'équation du temps. On cherche le maximum de hauteur au pas de la minute.
  let best = { minutes: 0, altitude: -90 };
  for (let m = 11 * 60; m <= 15 * 60; m++) {
    const h = Math.floor(m / 60);
    const { altitude } = sunPosition(localToUTC('2026-06-21', h, m - h * 60), PARIS.lat, PARIS.lon);
    if (altitude > best.altitude) best = { minutes: m, altitude };
  }
  const hours = best.minutes / 60;
  assert.ok(
    hours > 13.7 && hours < 14.1,
    `midi solaire trouvé à ${hours.toFixed(2)} h, attendu entre 13,7 et 14,1`,
  );
});

test('hauteur du soleil aux solstices et à l’équinoxe', () => {
  // Hauteur au midi solaire = 90° − latitude + déclinaison.
  // Paris : 41,1° à l'équinoxe, 64,6° au solstice d'été, 17,7° en hiver.
  const noonAltitude = (date) => {
    let max = -90;
    for (let m = 11 * 60; m <= 15 * 60; m += 2) {
      const h = Math.floor(m / 60);
      const { altitude } = sunPosition(localToUTC(date, h, m - h * 60), PARIS.lat, PARIS.lon);
      max = Math.max(max, altitude * DEG);
    }
    return max;
  };
  for (const [date, expected] of [
    ['2026-06-21', 64.6],
    ['2026-12-21', 17.7],
    ['2026-03-20', 41.1],
  ]) {
    const found = noonAltitude(date);
    assert.ok(
      Math.abs(found - expected) < 0.6,
      `${date} : ${found.toFixed(1)}° trouvé, ${expected}° attendu`,
    );
  }
});

test('la réfraction relève le soleil, et d’autant plus qu’il est bas', () => {
  const liftAt = (deg) => (applyRefraction(deg / DEG) - deg / DEG) * DEG;
  const atHorizon = liftAt(0);
  const high = liftAt(45);
  assert.ok(
    atHorizon > 0.4 && atHorizon < 0.7,
    `relèvement à l'horizon : ${atHorizon.toFixed(2)}°`,
  );
  assert.ok(high > 0 && high < atHorizon, 'la réfraction doit décroître avec la hauteur');
});

test('le soleil tourne dans le bon sens', () => {
  const azimuthAt = (hour) =>
    sunPosition(localToUTC('2026-06-21', hour, 0), PARIS.lat, PARIS.lon).azimuth * DEG;
  assert.ok(azimuthAt(8) < azimuthAt(12), 'le matin, le soleil va vers le sud');
  assert.ok(azimuthAt(12) < azimuthAt(18), 'l’après-midi, il va vers l’ouest');
  assert.ok(azimuthAt(8) > 45 && azimuthAt(8) < 120, `azimut à 8 h : ${azimuthAt(8).toFixed(0)}°`);
});

test('la date du jour est celle de Paris, pas celle de Greenwich', () => {
  // Une heure et demie du matin à Paris, le 8 octobre : encore le 7 en temps
  // universel. `toISOString` donnait donc la météo de la veille, étiquetée
  // « aujourd'hui », aux heures mêmes où l'on prépare un trajet de nuit.
  const night = new Date('2026-10-07T23:30:00Z');
  assert.equal(night.toISOString().slice(0, 10), '2026-10-07');
  assert.equal(localDate(night), '2026-10-08');
  assert.equal(localMinutes(night), 90);

  // Heure d'hiver : une heure d'écart seulement, et un changement d'année.
  const newYear = new Date('2026-12-31T23:30:00Z');
  assert.equal(localDate(newYear), '2027-01-01');
  assert.equal(localMinutes(newYear), 30);

  // En journée, les deux coïncident.
  assert.equal(localDate(new Date('2026-10-07T12:00:00Z')), '2026-10-07');
});

// ───────────────────────────────────────────── invariants de l’indice ─────

const baseSky = skyConditions(50 / DEG, 0);
const baseline = {
  transmission: 0.5,
  svf: 0.5,
  altitude: 50 / DEG,
  azimuth: Math.PI,
  horizon: new Uint8Array(16).fill(20),
  sky: baseSky,
};

test('l’indice reste borné entre 0 et 100, quoi qu’on lui donne', () => {
  const weights = {
    directSun: 0.34,
    skyView: 0.18,
    brightness: 0.16,
    reverb: 0.14,
    glare: 0.1,
    flicker: 0.08,
  };
  for (const transmission of [0, 0.5, 1]) {
    for (const svf of [0, 0.5, 1]) {
      for (const altitude of [-10, 0, 5, 30, 60]) {
        for (const veil of [0, 1, 50]) {
          const c = components({ ...baseline, transmission, svf, altitude: altitude / DEG, veil });
          const index = discomfortIndex(c, weights);
          assert.ok(
            Number.isFinite(index) && index >= 0 && index <= 100,
            `indice hors bornes : ${index} (t=${transmission} svf=${svf} h=${altitude}° voile=${veil})`,
          );
        }
      }
    }
  }
});

test('plus de soleil direct ne peut pas abaisser l’indice', () => {
  const weights = {
    directSun: 0.34,
    skyView: 0.18,
    brightness: 0.16,
    reverb: 0.14,
    glare: 0.1,
    flicker: 0.08,
  };
  let previous = -1;
  for (const transmission of [0, 0.25, 0.5, 0.75, 1]) {
    const index = discomfortIndex(components({ ...baseline, transmission }), weights);
    assert.ok(index >= previous, `indice non monotone : ${index} après ${previous}`);
    previous = index;
  }
});

test('sous l’horizon, le soleil direct ne contribue plus', () => {
  const c = components({ ...baseline, altitude: -5 / DEG, sky: skyConditions(-5 / DEG, 0) });
  assert.equal(c.sun, 0);
});

test('la clarté de Perez classe les ciels dans le bon ordre', () => {
  // ε ≈ 1 sous la couche, > 6 par ciel bleu franc. C'est l'indice normalisé,
  // et il doit croître avec la part de faisceau direct.
  // En W/m², l'unité dans laquelle Perez les définit.
  const overcast = perezSkyIndices(0, 170, 40 / DEG);
  const hazy = perezSkyIndices(190, 125, 40 / DEG);
  // Ciel clair parisien courant : 810 W/m² de faisceau pour 100 de diffus.
  // Il tombe en catégorie 7 de Perez, pas 8 — la catégorie 8 demande un diffus
  // bien plus faible, c'est-à-dire un air de montagne.
  const clear = perezSkyIndices(810, 100, 40 / DEG);
  const veryClear = perezSkyIndices(905, 58, 40 / DEG);
  assert.ok(overcast.epsilon < 1.1, `couvert : ε = ${overcast.epsilon.toFixed(2)}`);
  assert.ok(hazy.epsilon > overcast.epsilon, 'un ciel voilé est plus clair qu’un couvert');
  assert.ok(clear.epsilon > PEREZ_BINS[5], `ciel clair : ε = ${clear.epsilon.toFixed(2)}`);
  assert.ok(
    veryClear.epsilon > PEREZ_BINS[6],
    `ciel très pur : ε = ${veryClear.epsilon.toFixed(2)}`,
  );
  assert.ok(clear.brightness > 0 && clear.brightness < 1, 'Δ doit rester borné');
});

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} : ${actual.toFixed(4)} au lieu de ${expected} ± ${tolerance}`,
  );

test('le ciel clair ESRA redonne les valeurs de référence', () => {
  // Valeurs calculées par une réplique indépendante d'ESRA (Rigollier et al.
  // 2000), validée sur les mesures BSRN de Payerne : avec le trouble du jour,
  // faisceau à ±2 % au-dessus de 15° de hauteur.
  const cases = [
    [20, 3.1, 172, 643.2, 71.3],
    [5, 3.1, 172, 273.3, 29.2],
    [60, 3.1, 172, 915.6, 109.1],
    [10, 2.75, 355, 532.2, 43.3],
  ];
  for (const [deg, turbidity, day, beam, diffuse] of cases) {
    const sky = clearSkyIrradiance(deg / DEG, turbidity, day);
    near(sky.directNormal, beam, 0.15, `faisceau à ${deg}°, jour ${day}`);
    near(sky.diffuseHorizontal, diffuse, 0.15, `diffus à ${deg}°, jour ${day}`);
  }
  near(eccentricity(172), 0.96745, 1e-4, 'excentricité au solstice d’été');
  near(eccentricity(355), 1.0326, 1e-4, 'excentricité en décembre');
});

test('le trouble de Linke suit la climatologie mensuelle de Paris', () => {
  // Remund et al. 2003 (SoDa), lu au point de Paris : il n'est pas de 4 toute
  // l'année, et l'été n'est pas le plus trouble.
  near(linkeTurbidity(166), 3.1, 1e-9, 'mi-juin');
  near(linkeTurbidity(15), 2.65, 1e-9, 'mi-janvier');
  // Entre deux mois, une interpolation continue, y compris au passage de l'an.
  const dec31 = linkeTurbidity(365);
  assert.ok(dec31 > 2.65 && dec31 < 2.75, `31 décembre : ${dec31}`);
});

test('les efficacités lumineuses suivent Perez 1990, et chutent au soleil bas', () => {
  // Le faisceau rasant traverse plus d'atmosphère, qui en retire surtout le
  // bleu et le vert : il éclaire moins par watt. 105 lm/W constants le
  // surestimaient de 140 % entre 2 et 5° — le régime même de l'éblouissement.
  near(precipitableWater(10), 1.868, 1e-3, 'eau précipitable à 10 °C de rosée');
  const cases = [
    [643.2, 71.3, 20, 89.5, 154.5],
    [273.3, 29.2, 5, 48.7, 152.9],
    [915.6, 109.1, 60, 103.2, 132.4],
  ];
  for (const [beam, diffuse, deg, kb, kd] of cases) {
    const k = luminousEfficacy(beam, diffuse, deg / DEG, 172, 1.868);
    near(k.beam, kb, 0.1, `faisceau à ${deg}°`);
    near(k.diffuse, kd, 0.1, `diffus à ${deg}°`);
  }
  const twenty = luminousEfficacy(643.2, 71.3, 20 / DEG, 172, 1.868);
  near(twenty.epsilon, 4.112, 1e-3, 'clarté ε');
  near(twenty.brightness, 0.1572, 1e-4, 'luminosité Δ');
  assert.equal(twenty.category, 6);
  assert.equal(luminousEfficacy(915.6, 109.1, 60 / DEG, 172, 1.868).category, 8);

  const at = (deg) => {
    const sky = clearSkyIrradiance(deg / DEG, 3.1, 172);
    return luminousEfficacy(sky.directNormal, sky.diffuseHorizontal, deg / DEG, 172, 2).beam;
  };
  assert.ok(at(5) < at(20) && at(20) < at(60), 'le faisceau rasant éclaire moins par watt');
});

test('la nuit et le crépuscule ne font pas diverger les efficacités lumineuses', () => {
  // L'efficacité de Perez dépend de exp(5,73·Z − 5), qui explose pour un soleil
  // sous l'horizon : c'est la multiplication par un faisceau nul qui la rend
  // inoffensive, et c'est ce que ce test garde de toute simplification.
  for (const deg of [-30, -6, -0.5, 0, 0.2]) {
    for (const sky of [
      skyConditions(deg / DEG, 0, { beam: 0, diffuse: 0 }, 3, 16),
      skyConditions(deg / DEG, 0.5, null, 3, 16),
    ]) {
      for (const key of ['directNormal', 'diffuseHorizontal', 'epsilon', 'brightness']) {
        assert.ok(Number.isFinite(sky[key]), `${deg}° : ${key} = ${sky[key]}`);
      }
    }
  }
  assert.equal(skyConditions(-6 / DEG, 0, { beam: 0, diffuse: 0 }, 3, 16).directNormal, 0);
});

test('l’éclairement de ciel clair en lux combine ESRA et Perez', () => {
  const lux = clearSkyIlluminance(20 / DEG, {
    turbidity: 3.1,
    dayOfYear: 172,
    precipitableWater: 1.868,
  });
  near(lux.directNormal / 57559, 1, 0.002, 'faisceau à 20°, 21 juin');
  near(lux.diffuseHorizontal / 11021, 1, 0.002, 'diffus à 20°, 21 juin');
});

test('la masse d’air suit la sphéricité de l’atmosphère près de l’horizon', () => {
  // `1 / sin h` diverge : à 1° il annonce 57 masses d'air quand la réalité en
  // donne 27. C'est exactement le régime du soleil rasant, celui qui éblouit.
  assert.ok(Math.abs(airMass(90) - 1) < 0.01, 'au zénith, une masse d’air');
  assert.ok(Math.abs(airMass(30) - 2) < 0.02, 'à 30°, deux masses d’air');
  const low = airMass(1);
  assert.ok(low > 24 && low < 30, `à 1° : ${low.toFixed(1)} masses d’air, attendu ~27`);
  assert.ok(low < 1 / Math.sin(1 / DEG), 'doit rester sous la formule plate');

  let previous = 0;
  for (let h = 90; h >= 0; h -= 1) {
    const m = airMass(h);
    assert.ok(m >= previous, 'la masse d’air doit croître quand le soleil descend');
    previous = m;
  }
});

test('l’éclairement direct par ciel clair reste dans les ordres mesurés', () => {
  // Midi au solstice parisien : le soleil culmine à 64,6°, et les stations
  // mesurent 800 à 900 W/m² d'éclairement direct normal par beau temps, soit
  // 84 000 à 95 000 lux.
  const noon = clearSkyIlluminance(64.6 / DEG);
  assert.ok(
    noon.directNormal > 78000 && noon.directNormal < 98000,
    `direct normal à midi : ${Math.round(noon.directNormal)} lux`,
  );
  // Une atmosphère plus trouble éteint le faisceau et charge le diffus.
  const clean = clearSkyIlluminance(64.6 / DEG, { turbidity: 2.5 });
  const hazy = clearSkyIlluminance(64.6 / DEG, { turbidity: 6 });
  assert.ok(clean.directNormal > hazy.directNormal, 'plus de trouble, moins de faisceau');
  assert.ok(hazy.diffuseHorizontal > clean.diffuseHorizontal, 'plus de trouble, plus de diffus');
  assert.equal(clearSkyIlluminance(-1 / DEG).directNormal, 0, 'sous l’horizon, rien');
});

test('le sol éclairé pèse sur la réverbération', () => {
  // Le terme manquait entièrement. Une chaussée au soleil renvoie près de
  // 4 000 cd/m², dans la moitié basse du champ de vision.
  const lit = illuminance({ ...baseline, transmission: 1, horizon: new Uint8Array(16).fill(20) });
  const shaded = illuminance({
    ...baseline,
    transmission: 0,
    horizon: new Uint8Array(16).fill(20),
  });
  assert.ok(lit.groundLuminance > 2000, `sol au soleil : ${Math.round(lit.groundLuminance)} cd/m²`);
  assert.ok(
    lit.groundLuminance > shaded.groundLuminance,
    'au soleil, le sol vu reste plus clair qu’à l’ombre',
  );

  // Le sol qu'on *regarde* n'est pas celui sur lequel on se tient. À l'ombre
  // d'un immeuble dans une rue par ailleurs ensoleillée, la chaussée devant soi
  // est brillante — c'est le cas que le modèle manquait, et il exige que le sol
  // vu depuis l'ombre reste bien plus clair que dans une rue entièrement fermée.
  const deepCanyon = illuminance({
    ...baseline,
    transmission: 0,
    horizon: new Uint8Array(16).fill(70),
  });
  assert.ok(
    shaded.groundLuminance > deepCanyon.groundLuminance * 2,
    `ombre en rue ensoleillée ${Math.round(shaded.groundLuminance)} contre canyon fermé ${Math.round(deepCanyon.groundLuminance)}`,
  );
  assert.ok(
    shaded.groundSunlit > 0.5 && deepCanyon.groundSunlit === 0,
    'la part ensoleillée de la chaussée doit suivre la géométrie de la rue',
  );
  // La luminance des façades, elle, reste la grandeur validée : le sol ne doit
  // pas s'y mélanger.
  assert.ok(Number.isFinite(lit.wallLuminance) && lit.wallLuminance > 0);
  // Le sol s'ajoute, il ne dilue pas : un sol sombre ne doit jamais faire
  // *baisser* la charge due à une façade éblouissante.
  assert.ok(
    lit.surfaceLuminance >= lit.wallLuminance,
    `charge ${Math.round(lit.surfaceLuminance)} inférieure aux seules façades ${Math.round(lit.wallLuminance)}`,
  );
  assert.ok(
    shaded.surfaceLuminance >= shaded.wallLuminance,
    'même à l’ombre, ajouter le sol ne doit pas alléger la charge',
  );
});

test('la lumière du jour est pondérée par la sensibilité mélanopique', () => {
  // À éclairement égal, un ciel bleu franc est bien plus actif sur la
  // mélanopsine qu'un soleil rasant rougi. Le modèle le faisait déjà pour les
  // lampadaires ; il traitait les deux à égalité en plein jour.
  const bleu = daylightMelanopicRatio(skyColourTemperature(1));
  const couvert = daylightMelanopicRatio(skyColourTemperature(0));
  assert.ok(bleu > couvert, `ciel clair ${bleu} devrait dépasser le couvert ${couvert}`);

  const rasant = daylightMelanopicRatio(beamColourTemperature(1));
  const haut = daylightMelanopicRatio(beamColourTemperature(60));
  assert.ok(haut > rasant * 1.3, `soleil haut ${haut} contre rasant ${rasant}`);

  // D65 vaut exactement 1 par définition du rapport mélanopique.
  assert.equal(daylightMelanopicRatio(6500), 1);
  // Et la lumière du jour est plus bleue qu'un corps noir de même température :
  // c'est tout l'intérêt d'une table distincte de celle des lampadaires.
  assert.ok(
    daylightMelanopicRatio(5000) > melanopicRatio(5000) * 0.9,
    'les deux tables doivent rester du même ordre',
  );

  let previous = 0;
  for (const deg of [0, 5, 10, 20, 30, 50, 90]) {
    const cct = beamColourTemperature(deg);
    assert.ok(cct >= previous, 'le faisceau doit se refroidir en montant');
    previous = cct;
  }

  // La pondération ne doit jamais rendre l'éclairement négatif ni infini.
  for (const share of [0, 0.5, 1]) {
    const m = melanopicIlluminance(50000, 12000, 30, share);
    assert.ok(Number.isFinite(m) && m > 0, `éclairement mélanopique invalide : ${m}`);
  }
});

test('l’indice de position fait chuter l’éblouissement dès que le soleil monte', () => {
  // Sur la ligne de regard, l'indice vaut exactement 1 par construction.
  assert.ok(Math.abs(positionIndex(0) - 1) < 1e-9, `à l’horizon : ${positionIndex(0)}`);

  let previous = 0;
  for (const deg of [0, 5, 10, 20, 30, 45, 60, 80]) {
    const p = positionIndex(deg);
    assert.ok(p > previous, 'l’indice doit croître avec la hauteur');
    previous = p;
  }

  // La gêne décroît en 1/P². À 30° il ne doit plus rester qu'une fraction de ce
  // qu'on subit à l'horizon — l'ancienne rampe linéaire en laissait 40 %.
  const relative = (deg) => 1 / Math.pow(positionIndex(deg), 2);
  assert.ok(relative(30) < 0.15, `à 30° : ${relative(30).toFixed(3)}`);
  assert.ok(relative(60) < 0.01, `à 60° : ${relative(60).toFixed(4)}`);
  assert.ok(relative(5) > 0.6, `à 5°, la gêne doit rester forte : ${relative(5).toFixed(2)}`);

  // Et le terme complet reste borné, quelle que soit la position du soleil.
  for (const deg of [1, 10, 40, 70]) {
    const g = glareFactor({
      transmission: 1,
      altitude: deg / DEG,
      azimuth: Math.PI,
      heading: Math.PI,
      sky: skyConditions(deg / DEG, 0),
    });
    assert.ok(g >= 0 && g <= 1, `éblouissement hors bornes à ${deg}° : ${g}`);
  }
});

test('l’éblouissement solaire culmine à hauteur intermédiaire, pas à l’horizon', () => {
  // Contre-intuitif et pourtant juste, comme pour le lampadaire : au ras de
  // l'horizon le disque traverse une vingtaine de masses d'air et se ternit — on
  // peut le regarder. C'est vers dix degrés qu'il est à la fois encore dans
  // l'axe du regard et déjà pleinement lumineux.
  //
  // L'ancienne rampe linéaire donnait son maximum exactement à l'horizon : elle
  // décrivait l'inverse.
  const profile = [];
  for (let deg = 0.5; deg <= 60; deg += 0.5) {
    profile.push({
      deg,
      glare: glareFactor({
        transmission: 1,
        altitude: deg / DEG,
        azimuth: Math.PI,
        heading: Math.PI,
        sky: skyConditions(deg / DEG, 0),
      }),
    });
  }

  const peak = profile.reduce((best, p) => (p.glare > best.glare ? p : best));
  assert.ok(peak.deg >= 5 && peak.deg <= 20, `maximum à ${peak.deg}°, attendu entre 5 et 20`);
  assert.ok(profile[0].glare < peak.glare, 'au ras de l’horizon, le disque est déjà terni');

  // La composante doit couvrir toute sa plage : un poids de 0,10 sur une
  // grandeur qui plafonne à 0,12 ne pèserait qu'un point sur cent, et le README
  // annoncerait alors une pondération que le modèle n'applique pas.
  assert.ok(
    peak.glare > 0.9,
    `l’éblouissement plafonne à ${peak.glare.toFixed(3)} au lieu d’approcher 1`,
  );

  // Au-delà du maximum, la décroissance doit être franche et monotone.
  const far = profile.filter((p) => p.deg >= peak.deg);
  for (let i = 1; i < far.length; i++) {
    assert.ok(far[i].glare <= far[i - 1].glare + 1e-12, `remontée à ${far[i].deg}°`);
  }
});

test('les réflexions multiples n’amplifient que là où la rue est fermée', () => {
  // Série géométrique : en site dégagé le facteur vaut 1, et il croît quand les
  // surfaces se renvoient la lumière.
  const open = illuminance({ ...baseline, svf: 1, horizon: new Uint8Array(16) });
  const canyon = illuminance({ ...baseline, svf: 0.15, horizon: new Uint8Array(16).fill(60) });
  assert.ok(Math.abs(open.bounces - 1) < 1e-9, `site dégagé : ${open.bounces}`);
  assert.ok(canyon.bounces > 1.15, `ruelle : amplification ${canyon.bounces.toFixed(2)}`);
  assert.ok(canyon.bounces < 2, 'l’amplification doit rester physiquement plausible');
});

// ────────────────────────────────────────────────────────────── la nuit ─────

test('le rapport mélanopique croît avec la température de couleur', () => {
  let previous = 0;
  for (const cct of [1800, 2000, 2700, 3000, 4000, 5000, 6500]) {
    const ratio = melanopicRatio(cct);
    assert.ok(ratio > previous, `${cct} K : ${ratio} n'est pas supérieur à ${previous}`);
    previous = ratio;
  }
  // Une LED froide fait au moins trois fois plus de bleu qu'un sodium.
  assert.ok(melanopicRatio(5000) / melanopicRatio(2000) > 3);
});

test('la bascule jour/nuit est continue et bornée', () => {
  assert.equal(nightShare(10 / DEG), 0, 'en plein jour, aucune part nocturne');
  assert.equal(nightShare(-20 / DEG), 1, 'en pleine nuit, tout est nocturne');
  let previous = 0;
  for (let deg = 5; deg >= -10; deg -= 0.5) {
    const share = nightShare(deg / DEG);
    assert.ok(share >= previous - 1e-9, 'la part nocturne doit croître quand le soleil descend');
    assert.ok(share >= 0 && share <= 1, `part hors bornes : ${share}`);
    previous = share;
  }
});

test('l’éblouissement d’un lampadaire culmine à distance intermédiaire', () => {
  // Contre-intuitif mais juste, et le modèle doit le reproduire : au pied d'un
  // mât de 6 m, le luminaire est presque au-dessus de la tête — loin de la
  // ligne de regard, et hors du faisceau qui vise la chaussée. C'est à une
  // dizaine de mètres qu'il gêne le plus. Un test qui exigerait une décroissance
  // dès le premier mètre décrirait une autre physique que la nôtre.
  const lamp = { flux: 4000, height: 6, cct: 3000 };
  const profile = [2, 5, 10, 15, 25, 40, 80].map((d) => ({ d, veil: veilingLuminance(lamp, d) }));

  for (const { d, veil } of profile) {
    assert.ok(Number.isFinite(veil) && veil >= 0, `voile invalide à ${d} m : ${veil}`);
  }

  const peak = profile.reduce((best, p) => (p.veil > best.veil ? p : best));
  assert.ok(peak.d >= 5 && peak.d <= 20, `maximum trouvé à ${peak.d} m, attendu entre 5 et 20`);
  assert.ok(
    profile[0].veil < peak.veil,
    'au pied du mât, l’éblouissement doit être inférieur au maximum',
  );

  // Au-delà du maximum, la décroissance doit être franche et monotone.
  const far = profile.filter((p) => p.d >= peak.d);
  for (let i = 1; i < far.length; i++) {
    assert.ok(far[i].veil < far[i - 1].veil, `voile non décroissant à ${far[i].d} m`);
  }
});

test('à flux et distance égaux, une lampe froide éblouit davantage', () => {
  const chaud = veilingLuminance({ flux: 4000, height: 6, cct: 2000 }, 15);
  const froid = veilingLuminance({ flux: 4000, height: 6, cct: 5000 }, 15);
  assert.ok(froid > chaud * 2, `froid ${froid.toFixed(3)} vs chaud ${chaud.toFixed(3)}`);
});

test('un soleil dans l’axe de la rue n’ombre pas le mur d’en face', () => {
  // La formule de canyon supposait le soleil perpendiculaire à la rue. De biais,
  // son rayon traverse la chaussée sur une distance plus longue et descend
  // d'autant plus : l'ombre monte moins haut sur le mur d'en face. À la limite,
  // soleil dans l'axe de la rue, il ne traverse jamais — le mur est entièrement
  // éclairé, et le modèle l'ombrait à tort.

  // Rue nord-sud : murs hauts à l'est et à l'ouest, dégagée aux deux bouts.
  const bins = 16;
  const rue = new Uint8Array(bins);
  for (let i = 0; i < bins; i++) {
    const azimuth = (i * 360) / bins;
    const versLesBouts = Math.abs(Math.cos((azimuth * Math.PI) / 180));
    rue[i] = Math.round(55 * (1 - versLesBouts));
  }

  const altitude = 20 / DEG;
  const sky = skyConditions(altitude, 0);
  // Soleil au sud (dans l'axe de la rue) contre soleil à l'ouest (perpendiculaire).
  const axe = reverberation(rue, altitude, Math.PI, sky, 0.45);
  const travers = reverberation(rue, altitude, (270 / 180) * Math.PI, sky, 0.45);

  assert.ok(
    axe.sunlitWalls > travers.sunlitWalls,
    `dans l’axe ${axe.sunlitWalls.toFixed(3)} devrait dépasser en travers ${travers.sunlitWalls.toFixed(3)}`,
  );
  for (const r of [axe, travers]) {
    assert.ok(
      r.sunlitWalls >= 0 && r.sunlitWalls <= 1,
      `part éclairée hors bornes : ${r.sunlitWalls}`,
    );
    assert.ok(Number.isFinite(r.luminance) && r.luminance >= 0);
  }
});

test('un soleil oblique à la rue éclaire plus haut sur les façades', () => {
  // La formule de canyon supposait le soleil perpendiculaire à la rue. De biais,
  // son rayon traverse la chaussée sur une distance plus grande et descend donc
  // davantage avant d'atteindre le mur d'en face : l'ombre y monte moins haut.
  // À la limite — soleil dans l'axe de la rue — le rayon ne traverse jamais.
  //
  // Rue nord-sud : murs à l'est et à l'ouest, ouverte au nord et au sud.
  const bins = 16;
  const horizon = new Uint8Array(bins);
  for (let i = 0; i < bins; i++) {
    const azimuth = (i * 360) / bins;
    const toSide = Math.abs(Math.sin((azimuth * Math.PI) / 180));
    horizon[i] = Math.round(62 * toSide);
  }

  const altitude = 22 / DEG;
  const sky = skyConditions(altitude, 0);
  const lit = (azimuthDeg) =>
    reverberation(horizon, altitude, azimuthDeg / DEG, sky, 0.45).sunlitWalls;

  // De l'est franc (perpendiculaire) vers le sud-est puis le sud (dans l'axe).
  const perpendiculaire = lit(90);
  const oblique = lit(125);
  assert.ok(
    oblique > perpendiculaire,
    `oblique ${oblique.toFixed(3)} devrait dépasser perpendiculaire ${perpendiculaire.toFixed(3)}`,
  );

  // Et la part éclairée reste bornée, quelle que soit l'orientation.
  for (let azimuth = 0; azimuth < 360; azimuth += 15) {
    const value = lit(azimuth);
    assert.ok(value >= 0 && value <= 1, `part éclairée hors bornes à ${azimuth}° : ${value}`);
  }
});

test('une chaussée mouillée éblouit sous un soleil bas, pas sous un soleil haut', () => {
  // Fresnel : la réflectance spéculaire de l'eau grimpe en incidence rasante.
  // C'est ce qui rend une rue mouillée au soleil couchant si pénible, et le
  // modèle l'ignorait entièrement.
  const at = (deg, wet) =>
    illuminance({
      ...baseline,
      altitude: deg / DEG,
      transmission: 1,
      horizon: new Uint8Array(16).fill(10),
      wet,
      sky: skyConditions(deg / DEG, 0),
    });

  const bas = { sec: at(8, 0), mouille: at(8, 1) };
  const haut = { sec: at(60, 0), mouille: at(60, 1) };

  assert.equal(bas.sec.specular, 0, 'une chaussée sèche n’a pas de miroir');
  assert.ok(bas.mouille.specular > 0, 'une chaussée mouillée en a un');

  // Le rapport spéculaire/direct doit être bien plus fort au ras de l'horizon.
  const partBasse = bas.mouille.specular / Math.max(1, bas.mouille.direct);
  const partHaute = haut.mouille.specular / Math.max(1, haut.mouille.direct);
  assert.ok(
    partBasse > partHaute * 5,
    `soleil bas ${partBasse.toFixed(3)} contre soleil haut ${partHaute.toFixed(3)}`,
  );

  // Et l'eau assombrit le diffus au lieu de l'éclaircir : ce n'est pas une
  // surface plus claire, c'est un miroir.
  assert.ok(
    haut.mouille.groundLuminance < haut.sec.groundLuminance,
    'l’eau comble les pores : la réflectance diffuse baisse',
  );
  // Mais la charge totale sur les yeux, elle, ne baisse pas au soleil rasant.
  assert.ok(bas.mouille.surfaceLuminance > bas.sec.surfaceLuminance);

  // Le reflet est surtout une source d'éblouissement, pas une nappe : il doit
  // peser sur la composante dédiée, et seulement quand le soleil est bas.
  const glare = (deg, wet) =>
    glareFactor({
      transmission: 1,
      altitude: deg / DEG,
      azimuth: Math.PI,
      heading: Math.PI,
      wet,
      sky: skyConditions(deg / DEG, 0),
    });
  // À huit degrés la gêne sèche est déjà proche du maximum : on mesure l'écart
  // là où il reste de la marge, c'est-à-dire plus bas encore.
  assert.ok(
    glare(3, 1) > glare(3, 0) * 1.3,
    `mouillé ${glare(3, 1).toFixed(3)} contre sec ${glare(3, 0).toFixed(3)}`,
  );
  assert.ok(glare(8, 1) >= glare(8, 0), 'le miroir ne peut pas soulager');
  assert.ok(glare(60, 1) < glare(60, 0) * 1.05, 'soleil haut : le miroir ne compte presque plus');
});

test('le mouillage suit la pluie récente et reste borné', () => {
  assert.equal(wetnessFromRain(0), 0);
  assert.equal(wetnessFromRain(-1), 0);
  let previous = -1;
  for (const mm of [0, 0.05, 0.2, 0.5, 1, 5]) {
    const w = wetnessFromRain(mm);
    assert.ok(w >= previous, 'le mouillage doit croître avec la pluie');
    assert.ok(w >= 0 && w <= 1, `mouillage hors bornes : ${w}`);
    previous = w;
  }
  assert.equal(wetnessFromRain(5), 1, 'au-delà d’un millimètre, la surface est saturée');
  assert.ok(wetnessFromRain(0.1) > 0.3, 'un dixième de millimètre fait déjà briller l’asphalte');
});

test('le moucheté de feuillage culmine à mi-transmission', () => {
  // La variance d'un damier clair/sombre vaut T(1−T) : nulle sous un feuillage
  // transparent, nulle sous une ombre pleine, maximale à mi-chemin. C'est cette
  // gappiness qui strobe, et non la transmission moyenne.
  const canopy = new Uint8Array(10).fill(1);
  const uniform = (t) => dappleFactor(new Array(10).fill(t), canopy);

  assert.ok(uniform(0) < 1e-9, 'ombre pleine : rien ne scintille');
  assert.ok(uniform(1) < 1e-9, 'plein soleil : rien ne scintille');
  assert.ok(Math.abs(uniform(0.5) - 1) < 1e-9, 'mi-transmission : moucheté maximal');
  assert.ok(uniform(0.3) > uniform(0.05), 'la gappiness doit croître vers le milieu');

  // L'ombre d'un immeuble ne scintille pas, même à transmission identique.
  const mur = new Uint8Array(10);
  assert.equal(dappleFactor(new Array(10).fill(0.5), mur), 0);
});

test('le scintillement distingue l’ombre d’un mur de celle d’un platane', () => {
  const step = 4;
  // Même série de transmission, même alternance — seule l'origine de l'ombre change.
  const series = [1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5];
  const platanes = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1]);
  const murs = new Uint8Array(8);

  const sousArbres = flickerFactor(series, step, platanes);
  const sousImmeubles = flickerFactor(series, step, murs);
  assert.ok(
    sousArbres > sousImmeubles,
    `sous arbres ${sousArbres.toFixed(3)} devrait dépasser sous immeubles ${sousImmeubles.toFixed(3)}`,
  );

  // Sans information de houppier, le comportement doit être exactement celui
  // d'avant : un jeu de données antérieur ne doit pas dériver en silence.
  const historique = flickerFactor(series, step);
  let transitions = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i] > 0.5 !== series[i - 1] > 0.5) transitions++;
  }
  assert.equal(historique, Math.min(1, transitions / ((series.length - 1) * step) / 0.2));

  for (const f of [sousArbres, sousImmeubles, historique]) {
    assert.ok(f >= 0 && f <= 1, `scintillement hors bornes : ${f}`);
  }
});

// ───────────────────────────────────────────── étiquetage OpenStreetMap ─────

test('les passages sous immeuble sont reconnus comme couverts', () => {
  // Le filtre ne regardait que `tunnel=yes` et manquait les 1 210 voies en
  // `tunnel=building_passage` — dont le passage Choiseul.
  assert.equal(coverKind({ tunnel: 'building_passage' }), 1);
  assert.equal(coverKind({ covered: 'arcade' }), 1);
  assert.equal(coverKind({ covered: 'colonnade' }), 1);
  assert.equal(coverKind({ tunnel: 'yes' }), 2);
  assert.equal(coverKind({ indoor: 'yes' }), 2);
  assert.equal(coverKind({ covered: 'no' }), 0);
  assert.equal(coverKind({}), 0);
});

test('les côtés déclarés absents sont lus dans le bon sens', () => {
  assert.deepEqual(declaredAbsent({ sidewalk: 'left' }), {
    left: false,
    right: true,
    separate: false,
  });
  assert.deepEqual(declaredAbsent({ sidewalk: 'right' }), {
    left: true,
    right: false,
    separate: false,
  });
  assert.deepEqual(declaredAbsent({ sidewalk: 'separate' }), {
    left: true,
    right: true,
    separate: true,
  });
  assert.equal(declaredAbsent({ sidewalk: 'both' }).left, false);
  assert.equal(declaredAbsent({}), null);
});

// ─────────────────────────────────────────────────────── tables partagées ─────

test('les tables d’index sont figées : leur ordre est le format binaire', () => {
  // `HIGHWAYS` et `CARDINALS` sont encodées par leur **rang**. Réordonner l'une
  // d'elles renommerait silencieusement toutes les rues déjà calculées.
  assert.equal(CARDINALS[0], 'nord');
  assert.equal(CARDINALS[4], 'sud');
  assert.equal(CARDINALS.length, 8);
  assert.equal(HIGHWAYS[0], 'footway');
  assert.ok(HIGHWAYS.length < 256, 'un type de voie doit tenir dans un octet');
});

test('l’UV local reste sous l’UV en site dégagé', () => {
  for (const uv of [0, 3, 8, 11]) {
    for (const t of [0, 0.5, 1]) {
      for (const svf of [0, 0.5, 1]) {
        // Y compris avec le partage direct/diffus variable.
        for (const [alt, share] of [
          [null, null],
          [5, 0.2],
          [30, 0.7],
          [60, 0.9],
        ]) {
          const local = localUV(uv, t, svf, alt, share);
          assert.ok(local <= uv + 1e-9, `UV local ${local} supérieur à ${uv}`);
          assert.ok(local >= 0);
        }
      }
    }
  }
});

test('l’UV devient presque entièrement diffus quand le soleil descend', () => {
  // La part directe valait 0,45 quelle que soit la situation. À 10° de hauteur,
  // le trajet atmosphérique est tel que l'essentiel de l'UV est déjà diffusé :
  // se mettre à l'ombre d'un immeuble n'en protège presque plus.
  let previous = -1;
  for (const deg of [0, 10, 20, 30, 45, 60, 90]) {
    const fraction = uvDirectFraction(deg, 1);
    assert.ok(fraction > previous, 'la part directe doit croître avec la hauteur');
    previous = fraction;
  }
  assert.ok(uvDirectFraction(10, 1) < 0.2, `à 10° : ${uvDirectFraction(10, 1)}`);
  assert.ok(uvDirectFraction(60, 1) > 0.4, `à 60° : ${uvDirectFraction(60, 1)}`);

  // Sous la couche, il ne reste aucun faisceau — en UV comme en visible.
  assert.equal(uvDirectFraction(60, 0), 0);

  // Conséquence testable : à l'ombre d'un immeuble, l'UV reçu est bien plus
  // proche de l'UV en site dégagé au soleil rasant qu'à midi.
  const shaded = (deg, share) => localUV(8, 0, 0.5, deg, share) / 8;
  assert.ok(
    shaded(10, 0.6) > shaded(60, 0.9),
    `ombre à 10° ${shaded(10, 0.6).toFixed(3)} contre midi ${shaded(60, 0.9).toFixed(3)}`,
  );
});
