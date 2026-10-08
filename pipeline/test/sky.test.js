/**
 * La distribution de luminance du ciel, éprouvée contre des solutions exactes.
 *
 * Rien de ce qui se trompe ici ne plante : une table décalée d'un demi-secteur,
 * un facteur de normalisation à 0,98, un mur d'en face supposé uniforme. La
 * carte reste colorée, les couleurs sont plausibles, elles sont fausses. On
 * compare donc à ce qui ne dépend pas du code : des intégrales analytiques (ciel
 * uniforme, canyon infini d'Oke 1981), et les coefficients que sort le binaire
 * `gendaylit` de Radiance, la référence du modèle de Perez et al. 1993.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { geometricSkyView, perezCoefficients, skyDistribution } from '../src/lib/sky.js';

const DEG = 180 / Math.PI;
const UNIFORM = () => 1;

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} : ${actual} au lieu de ${expected} ± ${tolerance}`,
  );

/** Profil d'horizon de 32 secteurs d'un canyon infini N-S ou E-O, piéton au centre. */
function canyon(ratio, axis = 'NS', bins = 32) {
  const profile = new Float64Array(bins);
  for (let s = 0; s < bins; s++) {
    const azimuth = (2 * Math.PI * s) / bins;
    // Rue N-S : les murs sont à l'est et à l'ouest, donc visibles à sin(az) ;
    // rue E-O : au nord et au sud, à cos(az).
    const across = Math.abs(axis === 'NS' ? Math.sin(azimuth) : Math.cos(azimuth));
    // Le mur est à W/2 et haut de H au-dessus de l'œil : tan β = (H/(W/2))·|⊥|.
    profile[s] = Math.atan(2 * ratio * across) * DEG;
  }
  return profile;
}

test('les coefficients de Perez 1993 sont ceux de Radiance', () => {
  // Sortis du binaire `gendaylit` (LBNL), à reproduire à 1·10⁻⁵. Le dernier cas
  // vérifie la règle de gendaylit : sous ε < 2,8, Δ est relevé à 0,2.
  const cases = [
    [35, 6.9, 0.1, [-0.945196, -0.135982, 17.847638, -5.447586, 1.12289]],
    [10, 4.0, 0.18, [-0.993485, -0.301199, 13.215311, -3.349383, 0.426102]],
    [30, 1.03, 0.25, [0.639391, -0.480197, 1.28503, -0.839613, 0.022345]],
    [25, 2.0, 0.3, [-0.963261, -0.727656, 11.583605, -3.118708, 0.02638]],
    [25, 2.0, 0.1, [-0.977024, -0.368447, 12.92027, -3.304571, 0.04762]],
  ];
  for (const [altitude, epsilon, delta, expected] of cases) {
    const p = perezCoefficients(Math.PI / 2 - altitude / DEG, epsilon, delta);
    [p.a, p.b, p.c, p.d, p.e].forEach((value, i) =>
      near(value, expected[i], 2e-5, `${'abcde'[i]} à ${altitude}°, ε ${epsilon}, Δ ${delta}`),
    );
  }
});

test('en site dégagé, la distribution redonne exactement l’éclairement annoncé', () => {
  // Propriété de calibrage : la distribution répartit la lumière, elle n'en
  // change pas le total. Sans elle, tout le modèle se décalerait en niveau.
  const open = new Uint8Array(32);
  for (const epsilon of [1.0, 1.3, 2, 4, 7]) {
    for (const delta of [0.05, 0.2, 0.4]) {
      for (const altitude of [3, 20, 60]) {
        const d = skyDistribution({ altitude: altitude / DEG, azimuth: 2, epsilon, delta });
        near(d.factor(open), 1, 1e-9, `ε ${epsilon} Δ ${delta} à ${altitude}°`);
      }
    }
  }
});

test('un ciel uniforme redonne le facteur de vue du ciel, plan horizontal et vertical', () => {
  // La nouvelle physique contient l'ancienne comme cas particulier. Ciel
  // uniforme, obstruction uniforme β : le plan horizontal reçoit cos²β ; le plan
  // vertical, rapporté à l'éclairement horizontal de ciel ouvert,
  //     (2/π) · [ (π/2 − β)/2 − sin(2β)/4 ]
  // et 0,5 sans obstruction, pour n'importe quel cap.
  const sky = skyDistribution({
    altitude: 35 / DEG,
    azimuth: 200 / DEG,
    epsilon: 4,
    delta: 0.2,
    luminance: UNIFORM,
  });
  for (const beta of [0, 20, 45, 65]) {
    const profile = new Float64Array(32).fill(beta);
    near(sky.factor(profile), geometricSkyView(profile), 0.003, `horizontal, β ${beta}°`);

    const b = beta / DEG;
    const analytic = (2 / Math.PI) * ((Math.PI / 2 - b) / 2 - Math.sin(2 * b) / 4);
    for (const heading of [0, 0.7, Math.PI / 2, 3.5]) {
      near(sky.vertical(profile, heading), analytic, 0.004, `vertical, β ${beta}°, cap ${heading}`);
    }
  }
});

test('un canyon infini : le facteur de vue du ciel d’Oke, au centre de la rue', () => {
  // ψ = cos(atan(2H/W)) (Oke 1981), exact pour un ciel uniforme. Profil de 32
  // secteurs, c'est-à-dire un rayon par secteur : l'information que le pipeline
  // stocke.
  const sky = skyDistribution({
    altitude: 30 / DEG,
    azimuth: 1,
    epsilon: 4,
    delta: 0.2,
    luminance: UNIFORM,
  });
  for (const ratio of [0.5, 1, 2, 3]) {
    const oke = Math.cos(Math.atan(2 * ratio));
    for (const axis of ['NS', 'EW']) {
      near(sky.factor(canyon(ratio, axis)), oke, 0.006, `H/W ${ratio}, rue ${axis}`);
    }
  }
});

test('les secteurs sont centrés : le miroir d’une rue est une rue miroir', () => {
  // Le pipeline tire le rayon du secteur s à l'azimut sΔ : le secteur couvre
  // [(s − ½)Δ, (s + ½)Δ]. Intégrés sur [sΔ, (s+1)Δ], les secteurs décalaient
  // chaque obstacle d'un demi-pas — un biais de 1 point de rms, 5,3 % dans le
  // pire cas. Le symétrique par rapport au nord (s → −s, azimut du soleil
  // a → −a) doit donner le même résultat ; avec des secteurs décalés il ne le
  // donne pas.
  const bins = 32;
  const sunAzimuth = 1.1;
  for (const sector of [1, 5, 9, 16, 23]) {
    const here = new Uint8Array(bins);
    const mirror = new Uint8Array(bins);
    here[sector] = 60;
    mirror[(bins - sector) % bins] = 60;
    const a = skyDistribution({ altitude: 30 / DEG, azimuth: sunAzimuth, epsilon: 6, delta: 0.1 });
    const b = skyDistribution({
      altitude: 30 / DEG,
      azimuth: 2 * Math.PI - sunAzimuth,
      epsilon: 6,
      delta: 0.1,
    });
    near(a.factor(here), b.factor(mirror), 1e-9, `secteur ${sector}`);
  }
});

test('la luminance zénithale suit la normalisation de Perez', () => {
  // L_z / D_h, en sr⁻¹ : l'intégrale de L·cos Z sur l'hémisphère vaut D_h.
  // Ciel uniforme : 1/π. Les autres valeurs sont celles de l'intégration fine
  // à 0,25° de la formule de référence, contrôlée contre `gendaylit`.
  const cases = [
    [UNIFORM, 30, 1, 0.2, 0.3183],
    [undefined, 30, 1.03, 0.25, 0.3447],
    [undefined, 25, 2.0, 0.3, 0.1757],
    [undefined, 10, 4.0, 0.18, 0.1349],
    [undefined, 35, 6.9, 0.1, 0.1584],
  ];
  for (const [luminance, altitude, epsilon, delta, expected] of cases) {
    const sky = skyDistribution({
      altitude: altitude / DEG,
      azimuth: 2,
      epsilon,
      delta,
      luminance,
    });
    near(sky.zenithOverDh, expected, 6e-4, `Lz/Dh à ${altitude}°, ε ${epsilon}, Δ ${delta}`);
  }
});

test('sous un ciel couvert, une ruelle reçoit plus que sa part géométrique', () => {
  // Moon & Spencer : le zénith d'un ciel couvert vaut environ trois fois
  // l'horizon. Une ruelle ne voit que le zénith — la partie la plus lumineuse —
  // donc le facteur de vue du ciel la sous-estime. C'est l'erreur que la
  // distribution corrige, et son signe n'est pas négociable.
  const overcast = skyDistribution({
    altitude: 30 / DEG,
    azimuth: Math.PI,
    epsilon: 1,
    delta: 0.3,
  });
  for (const wall of [30, 50, 65]) {
    const profile = new Float64Array(32).fill(wall);
    const reach = overcast.factor(profile);
    assert.ok(
      reach > geometricSkyView(profile),
      `murs à ${wall}° : ${reach.toFixed(3)} devrait dépasser le SVF`,
    );
    assert.ok(reach <= 1, `facteur hors bornes : ${reach}`);
  }
});

test('par ciel clair, l’orientation compte à découpe de ciel égale', () => {
  // Deux rues de même facteur de vue du ciel, l'une ouverte vers le soleil,
  // l'autre à l'opposé. L'ancien modèle leur donnait la même valeur ; la région
  // circumsolaire vaut jusqu'à onze fois le fond de ciel.
  const towards = new Float64Array(32);
  const away = new Float64Array(32);
  for (let i = 0; i < 32; i++) {
    const azimuth = (i * 360) / 32;
    const east = azimuth > 30 && azimuth < 210;
    towards[i] = east ? 0 : 70;
    away[i] = east ? 70 : 0;
  }
  near(geometricSkyView(towards), geometricSkyView(away), 1e-9, 'SVF des deux profils');

  const clear = skyDistribution({ altitude: 25 / DEG, azimuth: 120 / DEG, epsilon: 7, delta: 0.1 });
  assert.ok(
    clear.factor(towards) > clear.factor(away) * 1.5,
    `vers le soleil ${clear.factor(towards).toFixed(3)} contre ${clear.factor(away).toFixed(3)}`,
  );
});

test('le ciel anisotrope survit à un changement du nombre de secteurs', () => {
  // Piège muet : un profil dont la longueur ne correspond pas au nombre de
  // secteurs de la table était refusé, et le modèle retombait sur le facteur de
  // vue du ciel isotrope — sans erreur, avec des couleurs plausibles et fausses.
  for (const bins of [8, 16, 32]) {
    const horizon = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
      const azimuth = (i * 360) / bins;
      horizon[i] = azimuth > 30 && azimuth < 210 ? 0 : 70;
    }
    const sky = skyDistribution({
      altitude: 25 / DEG,
      azimuth: 120 / DEG,
      epsilon: 6,
      delta: 0.1,
      bins,
    });
    assert.equal(sky.bins, bins);
    const reach = sky.factor(horizon);
    assert.ok(Number.isFinite(reach), `${bins} secteurs : profil refusé`);
    assert.ok(
      reach > geometricSkyView(horizon) * 1.2,
      `${bins} secteurs : ${reach.toFixed(3)} — retombé en isotrope ?`,
    );
  }
});

test('un mur isolé sous un ciel uniforme reçoit la moitié de l’éclairement', () => {
  // Ancrage de la bande : sans bâtiment en face, la façade voit un demi-ciel.
  const sky = skyDistribution({
    altitude: 35 / DEG,
    azimuth: 200 / DEG,
    epsilon: 4,
    delta: 0.2,
    luminance: UNIFORM,
  });
  for (const sector of [0, 7, 16, 25])
    near(sky.wallStrip(sector, 0), 0.5, 0.004, `secteur ${sector}`);
});

test('une façade de canyon voit le ciel que lui laisse la bande d’en face', () => {
  // Canyon infini, ciel uniforme : un point de façade dont le toit d'en face est
  // vu sous l'angle α reçoit, rapporté à l'éclairement horizontal de ciel ouvert,
  //     ½ · (1 − sin α)        avec tan α = hauteur restante / largeur.
  // L'ancien modèle supposait une obstruction uniforme sur le demi-tour d'azimut,
  // donc un mur d'en face infiniment large — la bande décroît, elle, comme cos o.
  const sky = skyDistribution({
    altitude: 35 / DEG,
    azimuth: 200 / DEG,
    epsilon: 4,
    delta: 0.2,
    luminance: UNIFORM,
  });
  for (const tanPerp of [0.25, 0.5, 1, 2]) {
    const alpha = Math.atan(tanPerp);
    near(sky.wallStrip(5, tanPerp), 0.5 * (1 - Math.sin(alpha)), 0.006, `tan α = ${tanPerp}`);
  }
});

test('la façade moyenne suit l’intégrale sur sa hauteur, et croît avec la hauteur du toit d’en face', () => {
  // Le piéton regarde la façade entière, pas son pied : le haut voit bien plus de
  // ciel. Référence : intégration fine, point par point, de la même formule.
  const sky = skyDistribution({
    altitude: 35 / DEG,
    azimuth: 200 / DEG,
    epsilon: 4,
    delta: 0.2,
    luminance: UNIFORM,
  });
  const reference = (hi, ho) => {
    // Poids sin θ cos θ : l'éclairement horizontal à l'œil.
    let num = 0;
    let den = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) / n) * hi;
      const w = Math.sin(t) * Math.cos(t);
      const alpha = Math.atan((Math.tan(ho) - Math.tan(t)) / 2);
      num += w * 0.5 * (1 - Math.sin(Math.max(0, alpha)));
      den += w;
    }
    return num / den;
  };
  for (const [hi, ho] of [
    [40, 40],
    [60, 60],
    [60, 45],
    [75, 70],
  ]) {
    const profile = new Float64Array(32).fill(0);
    profile[3] = hi;
    profile[19] = ho;
    near(
      sky.facadeSky(profile, 3, 'h'),
      reference(hi / DEG, ho / DEG),
      0.02,
      `façade ${hi}° face à ${ho}°`,
    );
  }

  const low = new Float64Array(32);
  const tall = new Float64Array(32);
  low[3] = tall[3] = 60;
  low[19] = 30;
  tall[19] = 70;
  assert.ok(sky.facadeSky(low, 3) > sky.facadeSky(tall, 3), 'un toit plus bas laisse plus de ciel');
  assert.equal(sky.facadeSky(new Float64Array(32), 3), 0, 'pas de façade, pas de ciel reçu');
});

test('par ciel clair, deux façades opposées ne reçoivent pas le même ciel', () => {
  // Deux murs à l'ombre, l'un tourné vers la moitié lumineuse du ciel et l'autre
  // à l'opposé : le ciel est tout ce qu'ils reçoivent.
  const clear = skyDistribution({ altitude: 20 / DEG, azimuth: 120 / DEG, epsilon: 7, delta: 0.1 });
  const profile = new Float64Array(32);
  let brightest = 0;
  let dimmest = Infinity;
  for (let sector = 0; sector < 16; sector++) {
    profile.fill(0);
    profile[sector] = 55;
    profile[sector + 16] = 55;
    const f = clear.facadeSky(profile, sector);
    brightest = Math.max(brightest, f);
    dimmest = Math.min(dimmest, f);
  }
  assert.ok(brightest > dimmest * 1.5, `rapport ${(brightest / dimmest).toFixed(2)}`);
  assert.ok(dimmest > 0, 'aucune façade ne reçoit rien du ciel');
});
