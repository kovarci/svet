/**
 * Modèle d'exposition lumineuse.
 *
 * Partagé entre le pipeline et le web : il n'existe qu'une seule définition de
 * l'indice dans tout le projet.
 *
 * Le pipeline ne calcule et ne stocke que des grandeurs *physiques* qui
 * dépendent de la géométrie de la ville : la transmission du rayon solaire, le
 * facteur de vue du ciel, le profil d'horizon, le scintillement. Tout le reste —
 * éclairement à l'œil, éblouissement, indice, UV — se recompose ici, à
 * l'affichage. C'est ce qui permet d'appliquer la météo du jour ou de retoucher
 * les pondérations sans relancer une seule minute de calcul.
 *
 * ── La chaîne, et d'où vient chaque maillon ─────────────────────────────────
 *
 *   flux du modèle météo (W/m²)            Open-Meteo, ou ciel clair
 *     → ciel clair                          Ineichen & Perez 2002
 *     → partage direct/diffus hors ligne    Erbs, Klein & Duffie 1982
 *     → lux                                 efficacités de Perez 1990
 *     → luminance du ciel                   Perez, Seals & Michalsky 1993
 *     → spectre, rapport mélanopique        SPCTRL2, Bird & Riordan 1986 ; CIE S 026
 *     → éclairement **à l'œil**             plan vertical, CIE S 026
 *     → signal photophobe                   Zele et al. 2021
 *     → dose, en logarithme                 McAdams et al. 2020 ; seuil de Perenboom et al. 2018
 *     → sources éblouissantes               structure de la DGP, Wienold & Christoffersen 2006 ;
 *                                           indices de position de Guth et d'Iwata
 *
 * L'indice n'est pas une mesure. Il répond à « cet endroit est-il plus exposé
 * que cet autre », pas à « combien de lux exactement ». Ce qui reste un
 * jugement — les trois poids de l'indice, quelques hypothèses de géométrie — est
 * dit là où c'est posé.
 */

import {
  clearSkyIrradiance,
  DEFAULT_LINKE_TURBIDITY,
  erbsSplit,
  linkeFromBeam,
  perezCategory,
  perezEfficacy,
  perezSkyIndices,
  precipitableWater,
} from './lib/sun.js';
import { geometricSkyView, skyDistribution } from './lib/sky.js';
import { daylightMelanopic, photophobicRatio, planckMelanopicDER } from './lib/spectrum.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Tangente au degré entier près. Le profil d'horizon est stocké en degrés
 * entiers : la carte évalue des milliers de trottoirs à chaque repeinte, et la
 * trigonométrie de ses trente-deux secteurs coûtait plus que tout le reste.
 */
const TAN_DEGREES = Float64Array.from({ length: 91 }, (_, d) => Math.tan(Math.min(d, 89.9) * D2R));

function tanDeg(value) {
  return Number.isInteger(value) && value >= 0 && value <= 90
    ? TAN_DEGREES[value]
    : Math.tan(Math.max(0, Math.min(89.9, value)) * D2R);
}

/** Cosinus et sinus des azimuts de secteur, par nombre de secteurs. */
const sectorTrigCache = new Map();
function sectorTrig(bins) {
  let trig = sectorTrigCache.get(bins);
  if (!trig) {
    const cos = new Float64Array(bins);
    const sin = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / bins);
      sin[i] = Math.sin((2 * Math.PI * i) / bins);
    }
    trig = { cos, sin };
    sectorTrigCache.set(bins, trig);
  }
  return trig;
}

/**
 * Réflectance du sol de rue, façades exclues.
 *
 * Une chaussée ensoleillée à 80 000 lux renvoie près de 4 000 cd/m² — le même
 * ordre de grandeur qu'un mur de calcaire au soleil — et elle occupe **toute la
 * moitié basse du champ de vision**, celle où l'on regarde en marchant.
 *
 * 0,18 est un mélange : l'asphalte d'une chaussée tourne autour de 0,10, un
 * trottoir de pierre ou de béton entre 0,25 et 0,35.
 */
export const DEFAULT_GROUND_ALBEDO = 0.18;

/**
 * Part vitrée des façades, hypothèse.
 *
 * Un immeuble haussmannien perce sa façade d'environ un quart de fenêtres ; un
 * immeuble de bureaux bien davantage. Le vitrage sert deux fois : il retire sa
 * part à la réflexion diffuse de la pierre — une fenêtre renvoie peu, l'intérieur
 * est sombre — et il renvoie le soleil **en miroir**, ce qui fait une source
 * d'éblouissement à part entière. Aucune donnée ouverte ne donne la part vitrée
 * bâtiment par bâtiment : c'est une valeur moyenne, déclarée comme telle.
 */
export const DEFAULT_GLAZING_RATIO = 0.25;

/**
 * Mouillage de la chaussée déduit des précipitations, de 0 à 1.
 *
 * Une chaussée ne sèche pas à l'instant où la pluie cesse : elle reste
 * miroitante une bonne demi-heure, et c'est souvent là que le soleil ressort —
 * précisément la conjonction qui fait mal. On lit donc le cumul récent, et non
 * la seule intensité de l'heure en cours.
 *
 * Un dixième de millimètre suffit à faire briller l'asphalte ; au-delà d'un
 * millimètre la surface est saturée et ne brille pas davantage.
 *
 * @param {number} recentRainMm cumul de précipitation sur l'heure écoulée, en mm
 */
export function wetnessFromRain(recentRainMm) {
  if (!Number.isFinite(recentRainMm) || recentRainMm <= 0) return 0;
  return Math.max(0, Math.min(1, Math.pow(recentRainMm / 1, 0.4)));
}

/**
 * Réflectance de Fresnel d'une interface, lumière non polarisée.
 *
 * Remplace l'approximation de Schlick, qui s'écarte de quelques pour cent de la
 * formule exacte au voisinage de l'incidence rasante — là où tout se joue ici.
 *
 * @param {number} cosIncidence cosinus de l'angle d'incidence
 * @param {number} n indice de réfraction (eau 1,333 ; verre 1,52)
 */
export function fresnel(cosIncidence, n) {
  const ci = Math.max(0, Math.min(1, cosIncidence));
  const si2 = 1 - ci * ci;
  const ct = Math.sqrt(Math.max(0, 1 - si2 / (n * n)));
  const rs = (ci - n * ct) / (ci + n * ct);
  const rp = (n * ci - ct) / (n * ci + ct);
  return Math.min(1, 0.5 * (rs * rs + rp * rp));
}

/**
 * Réflectance d'un simple vitrage, ses deux faces comprises (réflexions
 * multiples dans la lame, absorption négligée) : 2R / (1 + R).
 */
function glassReflectance(cosIncidence) {
  const r = fresnel(cosIncidence, 1.52);
  return (2 * r) / (1 + r);
}

// ─────────────────────────────────────────────────────── le ciel du jour ───

/**
 * Conditions de ciel à un instant : ce qui ne dépend que de l'heure et de la
 * météo, jamais du lieu.
 *
 * ── Les flux ────────────────────────────────────────────────────────────────
 *
 * Quand le modèle météo fournit le direct normal et le diffus horizontal, on les
 * prend : « 100 % de couverture nuageuse » est une moyenne horaire sur une
 * maille, qui ne dit pas si le disque solaire est masqué. Sinon — hors ligne —
 * on part du ciel clair d'Ineichen-Perez, on l'atténue par la relation de Kasten
 * & Czeplak (1980), G/G₀ = 1 − 0,75·N^3,4, et on partage le global par le modèle
 * d'Erbs. Le partage posé jusqu'ici, (1 − N)^1,5, n'avait pas de source.
 *
 * ── Les lux ─────────────────────────────────────────────────────────────────
 *
 * Par les efficacités de Perez (1990), qui suivent la clarté du ciel, la hauteur
 * du soleil et l'eau précipitable, au lieu de 105 et 120 lm/W en toute
 * circonstance.
 *
 * ── Le spectre ──────────────────────────────────────────────────────────────
 *
 * Par SPCTRL2 pour le faisceau et le ciel clair. Sous les nuages, la lumière
 * diffusée par les gouttelettes est spectralement neutre : la part nuageuse du
 * ciel reçoit le spectre du global clair, la part dégagée celui du ciel bleu. Le
 * partage suit la clarté de Perez — 0 sous la couche, 1 par ciel clair.
 *
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} [cloud] couverture nuageuse, de 0 à 1 — repli hors ligne
 * @param {{beam: number, diffuse: number, dewPoint?: number}} [irradiance]
 *   flux du modèle météo, en W/m² : direct normal, diffus horizontal
 * @param {number} [azimuth] azimut du soleil, en radians — sans lui, pas de
 *   distribution de luminance
 * @param {number} [bins] nombre de secteurs du profil d'horizon stocké
 */
export function skyConditions(altitude, cloud = 0, irradiance = null, azimuth = null, bins = 16) {
  const sinH = Math.max(Math.sin(altitude), 0);
  const water = precipitableWater(irradiance?.dewPoint);
  const clear = clearSkyIrradiance(altitude, DEFAULT_LINKE_TURBIDITY);

  let dni;
  let dhi;
  const measured = Boolean(irradiance && Number.isFinite(irradiance.beam));
  if (measured) {
    dni = Math.max(0, irradiance.beam);
    dhi = Math.max(0, irradiance.diffuse ?? 0);
  } else {
    const c = Math.max(0, Math.min(1, cloud));
    const ghi = clear.ghi * (1 - 0.75 * Math.pow(c, 3.4));
    const split = erbsSplit(ghi, altitude);
    // Par ciel tout à fait clair, Ineichen-Perez dit mieux le partage qu'une
    // régression faite sur tous les temps ; on passe de l'un à l'autre sur les
    // premiers 20 % de couverture, sans palier.
    const w = Math.min(1, c / 0.2);
    const scale = clear.ghi > 0 ? ghi / clear.ghi : 0;
    dni = (1 - w) * clear.dni * scale + w * split.dni;
    dhi = (1 - w) * clear.dhi * scale + w * split.dhi;
  }

  const { epsilon, brightness } = perezSkyIndices(dni, dhi, altitude);
  const efficacy = perezEfficacy(epsilon, brightness, altitude, water);
  const directNormal = dni * efficacy.beam;
  const diffuseHorizontal = dhi * efficacy.diffuse;
  const global = directNormal * sinH + diffuseHorizontal;

  // Le trouble du jour, relu dans le faisceau — seulement par ciel clair : un
  // nuage devant le disque l'éteint sans rien dire de l'atmosphère.
  const turbidity =
    measured && perezCategory(epsilon) >= 6 && altitude > 5 * D2R
      ? linkeFromBeam(dni, altitude)
      : DEFAULT_LINKE_TURBIDITY;

  const sky = {
    /** Éclairement direct normal, en lux. */
    directNormal,
    /** Éclairement diffus horizontal, en lux. */
    diffuseHorizontal,
    /** Les mêmes, en W/m². */
    dni,
    dhi,
    sinH,
    /** Part de l'éclairement global horizontal qui arrive en faisceau. */
    directShare: global > 0 ? (directNormal * sinH) / global : 0,
    measured,
    epsilon,
    brightness,
    turbidity,
    water,
    melanopic: daylightRatios(altitude, epsilon, turbidity, water),
  };

  if (Number.isFinite(azimuth) && altitude > 0) {
    // Le nombre de secteurs doit suivre celui du profil d'horizon stocké. S'il
    // diffère, `factor` refuse le profil et le modèle retombe **sans un mot** sur
    // le facteur de vue du ciel isotrope — la panne muette que ce projet a déjà
    // payée.
    sky.distribution = skyDistribution({ altitude, azimuth, epsilon, brightness, bins });
  }
  return sky;
}

/**
 * Rapports mélanopiques du faisceau, du ciel et de la lumière qu'ils déposent
 * ensemble sur les surfaces.
 */
function daylightRatios(altitude, epsilon, turbidity, water) {
  if (altitude <= 0) return { beam: 0.5, sky: 1, surfaces: 1 };
  const altitudeDeg = altitude * R2D;
  const spectral = daylightMelanopic(altitudeDeg, turbidity, water);
  const clear = clearSkyIrradiance(altitude, turbidity);
  const clearEpsilon = perezSkyIndices(clear.dni, clear.dhi, altitude).epsilon;
  // Part dégagée du ciel, lue dans la clarté : 0 sous la couche (ε = 1), 1 quand
  // le ciel est aussi clair que le ciel clair de ce jour.
  const clearShare =
    clearEpsilon > 1 ? Math.max(0, Math.min(1, (epsilon - 1) / (clearEpsilon - 1))) : 0;
  const sinH = Math.sin(altitude);
  const globalClear =
    (spectral.beam * clear.dni * sinH + spectral.diffuse * clear.dhi) /
    Math.max(1e-9, clear.dni * sinH + clear.dhi);
  const sky = clearShare * spectral.diffuse + (1 - clearShare) * globalClear;
  return { beam: spectral.beam, sky, surfaces: globalClear };
}

// ──────────────────────────────────────────────────── géométrie du lieu ────

/** Élévation d'horizon dans une direction quelconque, interpolée entre secteurs. */
function horizonAt(horizon, azimuth) {
  const bins = horizon.length;
  const position = ((((azimuth / (2 * Math.PI)) * bins) % bins) + bins) % bins;
  const i = Math.floor(position);
  const j = (i + 1) % bins;
  const t = position - i;
  return ((horizon[i] + (horizon[j] - horizon[i]) * t) * Math.PI) / 180;
}

/**
 * Part du ciel que le feuillage laisse passer, au-dessus de l'horizon bâti.
 *
 * Le profil d'horizon ne relève que le bâti ; le facteur de vue du ciel stocké,
 * lui, compte le feuillage par Beer-Lambert. Leur rapport dit donc quelle part
 * du ciel visible les arbres retirent.
 *
 * **C'était une régression.** En passant au ciel anisotrope, le modèle avait
 * cessé de lire le facteur de vue du ciel dès qu'un profil existait : sous les
 * platanes, le ciel était compté comme dégagé. Mesuré à profil égal, la
 * composante de ciel restait à 0,453 pour un facteur de vue de 0,6, 0,3 ou 0,1.
 */
function foliageTransmission(svf, horizon) {
  if (!horizon) return 1;
  const built = geometricSkyView(horizon);
  if (!(built > 0)) return 1;
  return Math.max(0, Math.min(1, svf / built));
}

/**
 * Orientation réelle des façades, lue dans la forme du profil d'horizon.
 *
 * Le modèle traitait chaque secteur comme un mur **tourné vers le piéton**. Vrai
 * pour une place circulaire ; faux dans une rue, où le mur qu'on voit en
 * enfilade est le même plan que celui d'en face, et regarde la chaussée, pas le
 * piéton. Conséquence : un soleil dans l'axe de la rue éclairait de plein fouet
 * des façades qu'il ne fait que raser.
 *
 * Un mur plan à la distance W, de hauteur H, se voit sous l'élévation
 * tan β(φ) = (H/W)·cos(φ − θ), avec θ la direction du pied de la perpendiculaire.
 * Trois secteurs voisins suffisent à retrouver θ :
 *
 *     tan(φ − θ) = (t₋ − t₊) / (t₋ + t₊) · cot δ
 *
 * avec t± = tan β dans les secteurs voisins et δ leur écart. Si un voisin
 * manque — angle de l'immeuble —, deux suffisent. Isolé, le secteur garde
 * l'ancienne hypothèse : un mur tourné vers le piéton.
 *
 * @returns {Float64Array} azimut de la normale de chaque mur, tournée vers le piéton
 */
export function wallNormals(horizon) {
  return wallGeometry(horizon).angle;
}

const TAN_LIMIT = Math.tan(80 * D2R);

/**
 * Géométrie des façades d'un profil, mise en cache.
 *
 * Elle ne dépend que du profil, jamais de l'heure ; or une repeinte de la carte
 * ou un itinéraire réinterrogent les mêmes trottoirs à plusieurs instants. Le
 * profil stocké est une vue dans le fichier de zone : son tampon et sa position
 * l'identifient sans rien recopier. Le cache est vidé au-delà d'une borne, pour
 * qu'une longue session sur toute la région ne le fasse pas grossir sans fin.
 */
let geometryCache = new WeakMap();
let geometryCount = 0;
const GEOMETRY_LIMIT = 60000;

function wallGeometry(horizon) {
  const buffer = horizon.buffer;
  if (!buffer) return computeWallGeometry(horizon);
  let byOffset = geometryCache.get(buffer);
  if (!byOffset) {
    byOffset = new Map();
    geometryCache.set(buffer, byOffset);
  }
  const key = horizon.byteOffset * 256 + horizon.length;
  let geometry = byOffset.get(key);
  if (!geometry) {
    if (geometryCount >= GEOMETRY_LIMIT) {
      geometryCache = new WeakMap();
      geometryCount = 0;
      return wallGeometry(horizon);
    }
    geometry = computeWallGeometry(horizon);
    byOffset.set(key, geometry);
    geometryCount++;
  }
  return geometry;
}

/**
 * L'azimut de chaque normale et son vecteur unitaire, obtenu sans
 * trigonométrie depuis tan(φ − θ) ; et l'obstacle que voit chaque mur.
 */
function computeWallGeometry(horizon) {
  const bins = horizon.length;
  const width = (2 * Math.PI) / bins;
  const cotWidth = 1 / Math.tan(width);
  const cosWidth = Math.cos(width);
  const sinWidth = Math.sin(width);
  const { cos, sin } = sectorTrig(bins);
  const angle = new Float32Array(bins);
  const nx = new Float32Array(bins);
  const ny = new Float32Array(bins);
  const seen = new Float32Array(bins);

  for (let i = 0; i < bins; i++) {
    const t0 = tanDeg(horizon[i]);
    const before = tanDeg(horizon[(i + bins - 1) % bins]);
    const after = tanDeg(horizon[(i + 1) % bins]);
    let q = 0;
    if (t0 > 0) {
      if (before > 0 && after > 0) q = ((before - after) / (before + after)) * cotWidth;
      else if (after > 0) q = (cosWidth - after / t0) / sinWidth;
      else if (before > 0) q = (before / t0 - cosWidth) / sinWidth;
    }
    q = Math.max(-TAN_LIMIT, Math.min(TAN_LIMIT, q));
    // Le pied de la perpendiculaire est en φ − x, avec tan x = q ; la normale
    // pointe à l'opposé, vers le piéton.
    const cx = 1 / Math.sqrt(1 + q * q);
    const sx = q * cx;
    nx[i] = -(cos[i] * cx + sin[i] * sx);
    ny[i] = -(sin[i] * cx - cos[i] * sx);
    angle[i] = (i * width - Math.atan(q) + Math.PI) % (2 * Math.PI);
  }
  // L'obstacle que voit chaque mur : l'horizon du piéton dans la direction où
  // le mur regarde, deux fois moins haut en angle vu de son pied.
  for (let i = 0; i < bins; i++) {
    if (!(horizon[i] > 0)) continue;
    seen[i] = Math.atan(tanDeg(horizonAt(horizon, angle[i]) * R2D) / 2) * R2D;
  }
  return { angle, cos: nx, sin: ny, seen };
}

/**
 * Ce que renvoient les façades : luminance de chaque mur, part éclairée, et
 * réflexions du soleil dans les vitrages.
 *
 * ── Le mur d'en face est-il éclairé ─────────────────────────────────────────
 *
 * Géométrie de canyon, sur le seul profil d'horizon. Dans une rue de largeur W,
 * le soleil à la hauteur α passant au-dessus d'un bâtiment de hauteur H₁ projette
 * son ombre jusqu'à H₁ − W·tan α sur le mur d'en face, d'où une part éclairée
 *
 *     1 − max(0, tan β₁ − tan α_eff) / tan β₂
 *
 * avec α_eff corrigé de l'obliquité : de biais, le rayon traverse la chaussée sur
 * W/cos Δθ. La largeur de la rue s'élimine ; il ne reste que des angles.
 *
 * ── Le ciel que voit chaque mur ─────────────────────────────────────────────
 *
 * Intégré sur son plan vertical, à travers l'obstruction du bâtiment d'en face
 * vu de son pied — deux fois moins haut en angle que vu du piéton.
 *
 * ── Les vitrages ────────────────────────────────────────────────────────────
 *
 * Une fenêtre renvoie l'image du soleil. Pour un mur vertical de normale n,
 * l'image se voit à la même hauteur que le soleil, à l'azimut 2n + π − A_s. Elle
 * existe si le soleil éclaire ce mur, si le mur monte assez haut dans cette
 * direction, et si le point de réflexion est au-dessus de la ligne d'ombre. Sa
 * luminance moyenne vaut part vitrée × réflectance de Fresnel × luminance du
 * disque. C'est le cas typique du soleil **dans le dos** : on ne le voit pas, on
 * voit son reflet sur la façade d'en face.
 *
 * @param {ArrayLike<number>} horizon élévation de l'horizon bâti par secteur, en degrés
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} azimuth azimut du soleil, en radians depuis le nord
 * @param {object} sky conditions de ciel
 * @param {number} albedo réflectance de la pierre
 * @param {number} [glazing] part vitrée des façades
 */
export function reverberation(horizon, altitude, azimuth, sky, albedo, glazing = 0) {
  const bins = horizon?.length ?? 0;
  const empty = {
    lux: 0,
    luminance: 0,
    sunlitWalls: 0,
    wallView: 0,
    sectors: new Float64Array(bins),
    projected: new Float64Array(bins),
    images: [],
  };
  if (bins === 0) return empty;

  const width = (2 * Math.PI) / bins;
  const normals = wallGeometry(horizon);
  const cosSun = Math.cos(azimuth);
  const sinSun = Math.sin(azimuth);
  const cosAltitude = Math.cos(altitude);
  const tanSun = altitude > 0 ? Math.tan(altitude) : 0;
  const tanSunSide = Math.tan(horizonAt(horizon, azimuth));
  const diffuseAlbedo = albedo * (1 - glazing);

  const sectors = new Float64Array(bins);
  const projected = new Float64Array(bins);
  const sunlitBySector = new Float64Array(bins);
  let lux = 0;
  let sunlitWalls = 0;
  let wallView = 0;
  let weightedLuminance = 0;

  for (let i = 0; i < bins; i++) {
    const tanWall = tanDeg(horizon[i]);
    // Part du champ occupée par du mur dans ce secteur : le complément de cos²β.
    const share = (tanWall * tanWall) / (1 + tanWall * tanWall);
    if (share <= 0) continue;
    wallView += share;

    const normal = normals.angle[i];
    const facing = cosSun * normals.cos[i] + sinSun * normals.sin[i];

    const seenFromWall = normals.seen[i];
    const wallReach =
      sky.distribution?.wallFactorToward(normal, seenFromWall) ??
      0.5 * Math.pow(Math.cos(seenFromWall * D2R), 2);
    let irradiated = wallReach * sky.diffuseHorizontal;

    if (facing > 0 && altitude > 0) {
      const effectiveTanSun = tanSun / Math.max(facing, 0.05);
      const sunlit =
        tanWall > 0
          ? Math.max(0, Math.min(1, 1 - Math.max(0, tanSunSide - effectiveTanSun) / tanWall))
          : 0;
      sunlitBySector[i] = sunlit;
      irradiated += sky.directNormal * cosAltitude * facing * sunlit;
      sunlitWalls += share * sunlit;
    }

    // Luminance de la surface, en cd/m² : c'est *elle* qui éblouit, et non
    // l'éclairement horizontal qu'elle produit.
    const luminance = (diffuseAlbedo * irradiated) / Math.PI;
    sectors[i] = luminance;
    // Angle solide de ce pan de mur projeté sur un plan vertical qui lui ferait
    // face : ∫₀^β cos²e de = β/2 + sin 2β / 4, fois la largeur du secteur. Le
    // cosinus du regard s'applique ensuite, cap par cap.
    const beta = Math.atan(tanWall);
    projected[i] = luminance * (beta / 2 + tanWall / (2 * (1 + tanWall * tanWall))) * width;
    lux += share * diffuseAlbedo * irradiated;
    weightedLuminance += share * luminance;
  }

  // Reflets du soleil dans les vitrages.
  const images = [];
  if (glazing > 0 && altitude > 0 && sky.directNormal > 0) {
    for (let i = 0; i < bins; i++) {
      if (!(sunlitBySector[i] > 0)) continue;
      const normal = normals.angle[i];
      const facing = cosSun * normals.cos[i] + sinSun * normals.sin[i];
      if (facing <= 0) continue;
      const imageAzimuth = 2 * normal + Math.PI - azimuth;
      const offset = Math.atan2(
        Math.sin(imageAzimuth - i * width),
        Math.cos(imageAzimuth - i * width),
      );
      if (Math.abs(offset) > width / 2) continue;
      const tanWall = tanDeg(horizon[i]);
      if (tanWall <= tanSun) continue;
      // Le point de réflexion est à tan α / tan β de la hauteur visible du mur ;
      // l'ombre d'en face en couvre le bas, sur 1 − part éclairée.
      if (tanSun / tanWall < 1 - sunlitBySector[i]) continue;
      const cosIncidence = cosAltitude * facing;
      images.push({
        azimuth: imageAzimuth,
        elevation: altitude,
        normalIlluminance: glazing * glassReflectance(cosIncidence) * sky.directNormal,
      });
    }
  }

  return {
    lux: lux / bins,
    /** Luminance moyenne des murs visibles, pondérée par leur part de champ. */
    luminance: wallView > 0 ? weightedLuminance / wallView : 0,
    sunlitWalls: sunlitWalls / bins,
    wallView: wallView / bins,
    /** Luminance de chaque secteur de mur, en cd/m². */
    sectors,
    /** La même, multipliée par l'angle solide projeté du secteur. */
    projected,
    /** Images du soleil dans les vitrages. */
    images,
  };
}

/**
 * Part du sol vu qui partage l'ombre du piéton.
 *
 * Elle était posée à la moitié. Elle se dérive : pour un regard horizontal, le
 * sol à la dépression δ pèse cos²δ dans l'éclairement du plan vertical de l'œil.
 * Le trottoir sous les pieds — jusqu'à 2 m, la distance à laquelle le piéton est
 * placé de sa façade — est vu au-delà de δ* = atan(1,6 / 2) = 38,7°, et pèse
 *
 *     ∫_{δ*}^{π/2} cos²δ dδ / ∫_0^{π/2} cos²δ dδ = 0,26.
 *
 * Le reste, c'est la chaussée devant soi.
 */
const NEAR_GROUND_SHARE = (() => {
  const depression = Math.atan(1.6 / 2);
  const below = depression / 2 + Math.sin(2 * depression) / 4;
  return (Math.PI / 4 - below) / (Math.PI / 4);
})();

/**
 * Éclairement et luminances d'un lieu, à un instant — tout ce qui ne dépend pas
 * de la direction du regard.
 *
 * @param {object} p
 * @param {number} p.transmission part du rayonnement direct qui atteint le piéton (0-1)
 * @param {number} p.svf facteur de vue du ciel, feuillage compris (0-1)
 * @param {number} p.altitude hauteur du soleil, en radians
 * @param {number} [p.azimuth] azimut du soleil, en radians
 * @param {number[]} [p.horizon] profil d'horizon bâti, en degrés par secteur
 * @param {number} [p.cloud] couverture nuageuse (0-1)
 * @param {number} [p.albedo] réflectance de la pierre des façades
 * @param {number} [p.groundAlbedo] réflectance du sol de rue
 * @param {number} [p.glazing] part vitrée des façades
 * @param {number} [p.wet] mouillage de la chaussée (0-1)
 */
export function illuminance({
  transmission,
  svf,
  altitude,
  azimuth = Math.PI,
  horizon,
  cloud = 0,
  albedo = 0.45,
  groundAlbedo = DEFAULT_GROUND_ALBEDO,
  glazing = DEFAULT_GLAZING_RATIO,
  wet = 0,
  sky,
}) {
  sky ??= skyConditions(altitude, cloud, null, azimuth, horizon?.length ?? 16);

  const direct = transmission * sky.directNormal * sky.sinH;
  const foliage = foliageTransmission(svf, horizon);
  const reach = horizon ? sky.distribution?.factor(horizon) : null;
  const diffuse = (Number.isFinite(reach) ? reach * foliage : svf) * sky.diffuseHorizontal;

  // Sans profil d'horizon — jeu de données antérieur — on retombe sur
  // l'ancienne estimation grossière, qui ignore si les murs sont éclairés.
  const walls = horizon
    ? reverberation(horizon, altitude, azimuth, sky, albedo, glazing)
    : (() => {
        const flat =
          (1 - svf) * albedo * (sky.directNormal * sky.sinH + sky.diffuseHorizontal) * 0.3;
        return {
          lux: flat,
          luminance: flat / Math.PI,
          sunlitWalls: 0,
          wallView: 1 - svf,
          projected: null,
          images: [],
        };
      })();

  // ── Le sol qu'on voit n'est pas celui sur lequel on se tient ───────────────
  //
  // La part ensoleillée de la chaussée devant soi se lit dans la géométrie de
  // canyon : un mur d'élévation β vu du milieu de la rue porte une ombre sur une
  // fraction tan β / (2 tan α) de la largeur.
  const tanAlt = altitude > 0 ? Math.tan(altitude) : 0;
  const groundSunlit =
    horizon && tanAlt > 0
      ? Math.max(0, Math.min(1, 1 - Math.tan(horizonAt(horizon, azimuth)) / (2 * tanAlt)))
      : 0;
  const groundLit = NEAR_GROUND_SHARE * transmission + (1 - NEAR_GROUND_SHARE) * groundSunlit;
  const groundDirect = groundLit * sky.directNormal * sky.sinH;

  // ── Chaussée mouillée ─────────────────────────────────────────────────────
  //
  // L'eau comble les pores : la réflectance **diffuse** baisse. Ce qui apparaît,
  // c'est un miroir, dont la réflectance suit Fresnel et grimpe en incidence
  // rasante — 0,02 soleil haut, 0,40 à dix degrés.
  const wetness = Math.max(0, Math.min(1, wet));
  const diffuseGroundAlbedo = groundAlbedo * (1 - 0.3 * wetness);
  const groundLuminance = (diffuseGroundAlbedo * (groundDirect + diffuse)) / Math.PI;
  const waterReflectance = fresnel(sky.sinH, 1.333);
  const specular = wetness * waterReflectance * groundDirect;

  // ── Les rebonds suivants ──────────────────────────────────────────────────
  //
  // Série géométrique 1 / (1 − ρ̄·(1 − ψ)) : en site dégagé elle vaut 1 ; rue de la
  // Colombe, ouverture au ciel de 19 %, environ 1,3.
  const enclosure = Math.max(0, Math.min(1, 1 - svf));
  const meanAlbedo = 0.5 * (albedo * (1 - glazing) + groundAlbedo);
  const bounces = 1 / Math.max(0.4, 1 - meanAlbedo * enclosure);

  const wallLuminance = walls.luminance * bounces;
  const litGround = groundLuminance * bounces;
  // Charge lumineuse renvoyée dans les yeux, façades et sol : additive, jamais
  // moyennée — un fond sombre ne soulage pas d'une source vive.
  const surfaceLuminance = wallLuminance + 0.5 * litGround + (specular / Math.PI) * bounces;
  const total = direct + diffuse + walls.lux * bounces;

  return {
    direct,
    diffuse,
    reflected: walls.lux * bounces,
    /** Luminance des seules façades, rebonds compris. */
    wallLuminance,
    groundLuminance: litGround,
    /** Façades et sol réunis — la charge renvoyée vers les yeux. */
    surfaceLuminance,
    sunlitWalls: walls.sunlitWalls,
    /** Part de la chaussée en vue qui est au soleil. */
    groundSunlit,
    /** Éclairement renvoyé en miroir par une chaussée mouillée, en lux. */
    specular,
    /** Amplification due aux réflexions multiples. */
    bounces,
    /** Part du ciel au-dessus du bâti que le feuillage laisse passer. */
    foliage,
    /** Éclairement horizontal total, en lux. */
    total,
    // Ce qu'il faut pour la suite — l'éclairement à l'œil.
    transmission,
    wetness,
    waterReflectance,
    wallProjected: walls.projected,
    glazingImages: walls.images,
  };
}

// ─────────────────────────────────────────────────────────── à l'œil ───────

/** Angle solide du disque solaire, en stéradians (diamètre apparent 0,533°). */
export const SUN_SOLID_ANGLE = 6.8e-5;

/**
 * Seuil d'inconfort lumineux de la personne migraineuse entre les crises, en lux.
 *
 * Perenboom et al., *Pain* 159 (2018) : 2,64 ± 0,5 log lux chez 39 patients
 * atteints de migraine épisodique, contre 2,98 chez les témoins. C'est le zéro de
 * la dose : en dessous, rien ne gêne la personne médiane du public visé.
 */
export const DISCOMFORT_THRESHOLD = Math.pow(10, 2.64);

/**
 * Limites du champ visuel binoculaire, en degrés au-dessus, au-dessous et de
 * part et d'autre de la ligne de regard : 60°, 75° et 100°, les valeurs
 * cliniques usuelles de la périmétrie. Entre ces axes, le bord du champ est
 * pris elliptique — l'« îlot de vision » de Traquair n'est pas un rectangle.
 *
 * Ce n'est pas un détail. Avec des limites rectangulaires, un soleil à 60° de
 * haut et 90° sur le côté restait « visible » ; et comme il n'éclaire alors
 * presque pas le plan de l'œil, le terme de contraste de la DGP l'aurait rendu
 * plus éblouissant qu'un soleil de face. Il est en réalité au-dessus de la
 * tempe, hors du champ.
 */
const FIELD = { up: 60, down: 75, side: 100 };

/**
 * Dispersion du bord du champ d'une personne à l'autre, en degrés — arcade
 * sourcilière, paupières, forme du visage. Hypothèse déclarée.
 *
 * Un bord franc ne convient pas : le terme de sources est logarithmique, et le
 * soleil y pèse lourd partout où il est visible. À 59,9° droit devant il donnait
 * 0,66 d'éblouissement, à 60,1° zéro — la carte aurait sauté au passage du
 * soleil. On rend donc l'**espérance** sur la population : la probabilité que la
 * source soit dans le champ, bord distribué autour de sa valeur clinique.
 */
const FIELD_SPREAD = 5;

/**
 * Indice de position d'une source, dans la direction (élévation, écart
 * d'azimut) par rapport à un regard horizontal.
 *
 * Au-dessus de la ligne de regard, l'indice de **Guth** dans l'ajustement de
 * Levin (IES Lighting Handbook) :
 *
 *     P = exp[(35,2 − 0,31889·τ − 1,22·e^(−2τ/9))·10⁻³·σ
 *             + (21 + 0,26667·τ − 0,002963·τ²)·10⁻⁵·σ²]
 *
 * avec σ l'écart angulaire à la ligne de regard et τ l'angle, depuis la
 * verticale, du plan qui contient la source et la ligne de regard. En dessous,
 * l'indice d'**Iwata** retenu par la CIE (2010) : les sources basses gênent
 * davantage. C'est le code d'`evalglare`, l'outil de référence de Wienold, à
 * une différence près : `evalglare` plafonne l'indice à 16. Dans notre champ
 * l'indice ne dépasse pas 16,4, et ce plafond faisait remonter l'éblouissement
 * à l'approche du bord — l'indice cessait de croître pendant que l'éclairement
 * à l'œil, au dénominateur, continuait de baisser.
 *
 * L'ancien modèle n'employait que la branche verticale, et remplaçait l'écart
 * latéral par une rampe en cosinus, plancher à 0,3 compris, posée sans mesure.
 *
 * @param {number} elevationDeg hauteur de la source au-dessus du regard, en degrés
 * @param {number} [lateralDeg] écart d'azimut entre la source et le regard, en degrés
 */
export function positionIndex(elevationDeg, lateralDeg = 0) {
  const e = elevationDeg * D2R;
  const a = lateralDeg * D2R;
  const forward = Math.cos(e) * Math.cos(a);
  const right = Math.cos(e) * Math.sin(a);
  const up = Math.sin(e);
  const sigma = Math.acos(Math.max(-1, Math.min(1, forward))) * R2D;
  if (sigma < 1e-6) return 1;
  const tau = Math.atan2(Math.abs(right), up) * R2D;

  let p;
  if (up >= 0) {
    p = Math.exp(
      ((35.2 - 0.31889 * tau - 1.22 * Math.exp((-2 * tau) / 9)) / 1000) * sigma +
        ((21 + 0.26667 * tau - 0.002963 * tau * tau) / 100000) * sigma * sigma,
    );
  } else {
    const s = Math.min(89.9, sigma) * D2R;
    const beta =
      Math.atan(Math.tan(s) * Math.sqrt(1 + 0.3225 * Math.pow(Math.cos(tau * D2R), 2))) * R2D;
    p = Math.exp((6.49 / 1000) * beta + (21 / 100000) * beta * beta);
  }
  return p;
}

/**
 * Probabilité qu'une source soit dans le champ visuel, de 0 à 1 : le bord
 * elliptique, adouci par la dispersion entre personnes (loi logistique de même
 * écart-type).
 */
function visibility(elevationDeg, lateralDeg) {
  const e = elevationDeg * D2R;
  const a = lateralDeg * D2R;
  const forward = Math.cos(e) * Math.cos(a);
  const right = Math.cos(e) * Math.sin(a);
  const up = Math.sin(e);
  const eccentricity = Math.acos(Math.max(-1, Math.min(1, forward))) * R2D;
  if (eccentricity < 1e-6) return 1;
  // Méridien de la source, depuis la verticale ; bord du champ sur ce méridien.
  const meridian = Math.atan2(Math.abs(right), Math.abs(up));
  const vertical = up >= 0 ? FIELD.up : FIELD.down;
  const limit = 1 / Math.hypot(Math.cos(meridian) / vertical, Math.sin(meridian) / FIELD.side);
  const scale = (FIELD_SPREAD * Math.sqrt(3)) / Math.PI;
  return 1 / (1 + Math.exp((eccentricity - limit) / scale));
}

function wrapDeg(radians) {
  return Math.atan2(Math.sin(radians), Math.cos(radians)) * R2D;
}

/**
 * Lumière qui atteint l'œil d'un piéton regardant dans la direction `heading`.
 *
 * ── Pourquoi le plan vertical ───────────────────────────────────────────────
 *
 * L'indice reposait sur l'éclairement **horizontal** — celui d'un plan qui
 * regarde le zénith. Or la lumière qui gêne entre par l'œil, et l'œil regarde
 * devant lui. La CIE S 026 définit l'éclairement mélanopique au niveau de la
 * cornée, dans le plan vertical ; et l'éclairement vertical à l'œil est, de
 * toutes les grandeurs étudiées, le meilleur prédicteur de l'inconfort visuel en
 * lumière naturelle — c'est le premier terme de la DGP (Wienold &
 * Christoffersen, 2006), confirmé depuis (Luo et al., 2024).
 *
 * L'horizontal surpondérait le soleil de midi et sous-pondérait le soleil bas :
 * l'inverse de ce qui fait mal. Le terme d'éblouissement compensait après coup.
 *
 * ── Les termes ──────────────────────────────────────────────────────────────
 *
 *  - le soleil, selon l'angle entre lui et le regard ;
 *  - le ciel visible devant soi, intégré sur le plan vertical ;
 *  - chaque secteur de façade, sa luminance multipliée par son angle solide
 *    projeté : ∫cos²e de · ∫cos(φ − h) dφ ;
 *  - le sol, qui occupe tout le demi-espace sous la ligne d'horizon : π/2 fois sa
 *    luminance ;
 *  - les reflets du soleil — vitrages, chaussée mouillée.
 *
 * @returns {{photopic: number, melanopic: number, photophobic: number, glare: number}}
 *   éclairements en lux ; `glare`, le terme de sources de la DGP, log₁₀(1 + Σ)
 */
export function eyeExposure(scene, heading, { altitude, azimuth, horizon, svf, sky }) {
  const cosAlt = Math.cos(Math.max(0, altitude));
  const toward = (direction) => Math.max(0, Math.cos(direction - heading));

  const sunFacing = toward(azimuth);
  const direct = altitude > 0 ? scene.transmission * sky.directNormal * cosAlt * sunFacing : 0;

  const eyeFactor = horizon ? sky.distribution?.eyeFactor(heading, horizon) : null;
  const skyLux =
    (Number.isFinite(eyeFactor) ? eyeFactor * scene.foliage : 0.5 * Math.max(0, svf)) *
    sky.diffuseHorizontal;

  let walls = 0;
  if (scene.wallProjected && horizon) {
    const { cos, sin } = sectorTrig(horizon.length);
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    for (let i = 0; i < horizon.length; i++) {
      const weight = scene.wallProjected[i];
      if (!(weight > 0)) continue;
      const facing = cos[i] * cosH + sin[i] * sinH;
      if (facing > 0) walls += weight * facing;
    }
    walls *= scene.bounces;
  } else {
    walls = scene.wallLuminance * Math.PI * 0.5 * (1 - svf);
  }

  const ground = (scene.groundLuminance * Math.PI) / 2;

  // Les sources ponctuelles : le disque, son reflet dans la chaussée mouillée,
  // ses reflets dans les vitrages. Chacune avec son éclairement normal.
  const sources = [];
  if (altitude > 0 && sky.directNormal > 0) {
    sources.push({
      elevation: altitude,
      azimuth,
      normalIlluminance: scene.transmission * sky.directNormal,
    });
    if (scene.wetness > 0) {
      sources.push({
        elevation: -altitude,
        azimuth,
        normalIlluminance:
          scene.wetness * scene.waterReflectance * scene.groundSunlit * sky.directNormal,
      });
    }
    for (const image of scene.glazingImages ?? []) sources.push(image);
  }

  let reflections = 0;
  for (const source of sources.slice(1)) {
    reflections += source.normalIlluminance * Math.cos(source.elevation) * toward(source.azimuth);
  }

  const photopic = direct + skyLux + walls + ground + reflections;
  const ratios = sky.melanopic ?? { beam: 1, sky: 1, surfaces: 1 };
  const melanopic =
    (direct + reflections) * ratios.beam + skyLux * ratios.sky + (walls + ground) * ratios.surfaces;

  // ── Les sources, à la manière de la DGP ───────────────────────────────────
  //
  // Σ L²·ω / P², divisé par E_v^1,87 : la structure du second terme de la
  // DGP. L'éclairement à l'œil au dénominateur traduit l'adaptation — une
  // source vive gêne moins sur un fond clair. Pour un disque d'angle solide ω,
  // L²·ω = E_n² / ω.
  //
  // Chaque source n'est vue que par la part de la population dont le champ la
  // contient : on ajoute donc les sources de la plus vive à la plus faible, et
  // chacune apporte sa marche de logarithme pondérée par sa visibilité. Une
  // source seule donne v·log₁₀(1 + X) ; toutes visibles, log₁₀(1 + ΣX).
  const adaptation = Math.pow(Math.max(1, photopic), 1.87);
  const terms = [];
  for (const source of sources) {
    if (!(source.normalIlluminance > 0)) continue;
    const elevationDeg = source.elevation * R2D;
    const lateralDeg = wrapDeg(source.azimuth - heading);
    const seen = visibility(elevationDeg, lateralDeg);
    if (seen < 1e-4) continue;
    const p = positionIndex(elevationDeg, lateralDeg);
    const x =
      (source.normalIlluminance * source.normalIlluminance) /
      SUN_SOLID_ANGLE /
      (p * p) /
      adaptation;
    terms.push([x, seen]);
  }
  terms.sort((a, b) => b[0] - a[0]);
  let glare = 0;
  let cumulated = 0;
  for (const [x, seen] of terms) {
    const before = Math.log10(1 + cumulated);
    cumulated += x;
    glare += seen * (Math.log10(1 + cumulated) - before);
  }

  return {
    photopic,
    melanopic,
    // Le signal qui porte la photophobie : cônes et mélanopsine, la seconde
    // comptant 1,5 fois (Zele et al.). Exprimé en lux équivalents D65.
    photophobic: (photopic + 1.5 * melanopic) / 2.5,
    glare,
  };
}

/**
 * Plafonds de la dose et de l'éblouissement : ce que le modèle peut produire de
 * pire, en site dégagé, par ciel clair, face au soleil.
 *
 * On normalise sur la physique et non sur une valeur choisie : un poids qui ne
 * veut plus dire ce qu'il dit est pire qu'un poids mal choisi. Calculés une
 * fois, au premier usage.
 */
let ceilings = null;
function exposureCeilings() {
  if (ceilings) return ceilings;
  const bins = 32;
  const open = new Array(bins).fill(0);
  let dose = DISCOMFORT_THRESHOLD * 10;
  let glare = 0.1;
  for (let deg = 1; deg <= 89; deg += 2) {
    const altitude = deg * D2R;
    const sky = skyConditions(altitude, 0, null, Math.PI, bins);
    const place = { altitude, azimuth: Math.PI, horizon: open, svf: 1, sky };
    const scene = illuminance({ ...place, transmission: 1 });
    const eye = eyeExposure(scene, Math.PI, place);
    dose = Math.max(dose, eye.photophobic);
    glare = Math.max(glare, eye.glare);
  }
  ceilings = { dose, glare };
  return ceilings;
}

/**
 * Dose de lumière à l'œil, de 0 à 1, sur une échelle **logarithmique**.
 *
 * McAdams et al. (*PNAS*, 2020) : la gêne déclarée croît linéairement avec le
 * logarithme du signal — la loi de Weber-Fechner. Zéro au seuil d'inconfort des
 * migraineux, un au plafond physique.
 */
export function doseComponent(photophobicLux) {
  const ceiling = exposureCeilings().dose;
  if (!(photophobicLux > DISCOMFORT_THRESHOLD)) return 0;
  return Math.min(
    1,
    Math.log(photophobicLux / DISCOMFORT_THRESHOLD) / Math.log(ceiling / DISCOMFORT_THRESHOLD),
  );
}

/**
 * Éblouissement par les sources vives, de 0 à 1 : le terme log₁₀(1 + Σ) de la
 * DGP, rapporté au plafond physique.
 *
 * @param {number} glareLog terme de sources, déjà en logarithme décimal
 */
export function glareComponent(glareLog) {
  if (!(glareLog > 0)) return 0;
  return Math.min(1, glareLog / exposureCeilings().glare);
}

/**
 * Éblouissement solaire seul, pour un piéton à découvert : la composante
 * d'éblouissement, réduite au disque et à son reflet sur la chaussée.
 *
 * Conservé pour les appelants qui n'ont pas de lieu à décrire.
 */
export function glareFactor({ transmission, altitude, azimuth, heading, cloud = 0, wet = 0, sky }) {
  if (altitude <= 0 || transmission <= 0) return 0;
  sky ??= skyConditions(altitude, cloud);
  const bins = 32;
  const place = {
    altitude,
    azimuth,
    horizon: new Array(bins).fill(0),
    svf: 1,
    sky: sky.distribution ? sky : skyConditions(altitude, cloud, null, azimuth, bins),
  };
  const scene = illuminance({ ...place, transmission, wet });
  const eye = eyeExposure(scene, Number.isFinite(heading) ? heading : azimuth, place);
  return glareComponent(eye.glare);
}

/**
 * Poids de l'indice.
 *
 * Trois composantes au lieu de six, et presque indépendantes. Les six d'avant —
 * soleil direct, ouverture au ciel, luminosité, réverbération, éblouissement,
 * scintillement — dépendaient presque toutes du faisceau direct : le soleil
 * pesait en réalité bien plus que les 0,34 annoncés, et deux jeux de poids
 * plausibles pouvaient inverser le classement de deux rues.
 *
 * La dose porte l'essentiel parce que l'éclairement à l'œil est, dans les études
 * d'inconfort en lumière naturelle, le prédicteur dominant (Wienold 2006 ; Luo
 * et al. 2024) ; les sources vives viennent ensuite. Le partage chiffré reste un
 * jugement — c'est le premier endroit à recalibrer avec des retours d'usage.
 */
export const DEFAULT_WEIGHTS = {
  dose: 0.62,
  glare: 0.3,
  flicker: 0.08,
};

/**
 * Le soleil est-il devant vous, ou dans votre dos ? Sans direction de marche,
 * on prend le pire cas : le regard tourné vers le soleil.
 */
function headingsFor(heading, azimuth) {
  if (Array.isArray(heading)) {
    const finite = heading.filter(Number.isFinite);
    if (finite.length > 0) return finite;
  } else if (Number.isFinite(heading)) {
    return [heading];
  }
  return [Number.isFinite(azimuth) ? azimuth : Math.PI];
}

/**
 * Composantes de la gêne lumineuse, en un point et un instant.
 *
 * @param {object} p
 * @param {number|number[]} [p.heading] cap de marche, en radians ; un tableau de
 *   caps rend le pire d'entre eux — c'est ce que fait la carte, qui ne sait pas
 *   dans quel sens on prendra la rue.
 */
export function components({
  transmission,
  svf,
  altitude,
  azimuth = Math.PI,
  heading,
  horizon,
  flicker = 0,
  cloud = 0,
  albedo = 0.45,
  groundAlbedo = DEFAULT_GROUND_ALBEDO,
  glazing = DEFAULT_GLAZING_RATIO,
  wet = 0,
  veil = 0,
  weights = DEFAULT_WEIGHTS,
  sky,
}) {
  // `sky` ne dépend que de l'instant, jamais du lieu : l'appelant qui boucle
  // sur des dizaines de milliers de tronçons a tout intérêt à le calculer une
  // seule fois et à le passer ici.
  sky ??= skyConditions(altitude, cloud, null, azimuth, horizon?.length ?? 16);
  const scene = illuminance({
    transmission,
    svf,
    altitude,
    azimuth,
    horizon,
    albedo,
    groundAlbedo,
    glazing,
    wet,
    sky,
  });
  const place = { altitude, azimuth, horizon, svf, sky };

  // Le pire des caps proposés, au sens de l'indice qu'ils produiraient.
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  let worst = null;
  for (const h of headingsFor(heading, azimuth)) {
    const eye = altitude > 0 ? eyeExposure(scene, h, place) : null;
    const dose = eye ? doseComponent(eye.photophobic) : 0;
    const glare = eye ? glareComponent(eye.glare) : 0;
    const score = w.dose * dose + w.glare * glare;
    if (!worst || score > worst.score) worst = { eye, dose, glare, score, heading: h };
  }

  return {
    // ── Ce qui fait l'indice ──
    dose: worst.dose,
    glare: worst.glare,
    // Sans faisceau direct, il n'y a plus d'alternance ombre/soleil : sous un
    // ciel couvert, marcher sous les platanes ne fait plus clignoter la lumière.
    flicker: flicker * sky.directShare,
    // La gêne nocturne et la part qu'elle occupe, nulles en plein jour.
    night: nightComponent(veil),
    nightShare: nightShare(altitude),
    veil,

    // ── Ce qui l'explique ──
    /** Part du faisceau direct qui atteint le piéton, pondérée par sa part du global. */
    sun: altitude > 0 ? transmission * sky.directShare : 0,
    /** Charge renvoyée par les façades et le sol, ramenée entre 0 et 1. */
    reverb: Math.min(1, Math.pow(Math.max(0, scene.surfaceLuminance) / 8000, 0.7)),
    sunlitWalls: scene.sunlitWalls,
    wallLuminance: scene.wallLuminance,
    groundLuminance: scene.groundLuminance,
    groundSunlit: scene.groundSunlit,
    /** Éclairement horizontal total, en lux. */
    lux: scene.total,
    /** Éclairement à l'œil, plan vertical, en lux. */
    eyeLux: worst.eye?.photopic ?? 0,
    /** Éclairement mélanopique équivalent D65 à l'œil (CIE S 026), en lux. */
    melanopicLux: worst.eye?.melanopic ?? 0,
    /** Signal photophobe, cônes et mélanopsine, en lux équivalents D65. */
    photophobicLux: worst.eye?.photophobic ?? 0,
    /** Le cap retenu pour ce qui précède. */
    heading: worst.heading,
  };
}

/**
 * Indice de gêne lumineuse, de 0 (abrité) à 100.
 *
 * Les poids viennent des métadonnées de la zone. Un jeu calculé avant ce modèle
 * porte les six poids d'avant, qui ne désignent plus rien ici : on les ignore
 * plutôt que d'en appliquer la moitié.
 */
export function discomfortIndex(c, weights) {
  const w = Number.isFinite(weights?.dose) ? weights : DEFAULT_WEIGHTS;
  const raw =
    w.dose * (c.dose ?? 0) + (w.glare ?? 0) * (c.glare ?? 0) + (w.flicker ?? 0) * (c.flicker ?? 0);

  // Le jour et la nuit ne se comparent pas terme à terme : de jour la gêne est
  // une nappe diffuse, de nuit une poignée de sources vives dans un champ
  // sombre. On passe de l'une à l'autre au crépuscule.
  const share = c.nightShare ?? 0;
  const blended = share > 0 ? raw * (1 - share) + (c.night ?? 0) * share : raw;

  return Math.max(0, Math.min(100, Math.round(blended * 100)));
}

// ───────────────────────────────────────────────────────────── la nuit ─────

/**
 * Rapport mélanopique d'une lampe, d'après sa température de couleur.
 *
 * Calculé sur les fonctions de la CIE S 026 pour un corps noir à cette
 * température — et non plus lu dans une table de huit points recopiée. C'est
 * une approximation : une LED n'est pas un corps noir, et deux sources de même
 * température de couleur peuvent différer dans le bleu. Faute du spectre réel,
 * c'est le meilleur proxy disponible.
 */
export function melanopicRatio(cct) {
  return planckMelanopicDER(cct);
}

/**
 * Facteur photophobe d'une lampe, par lux : cônes et mélanopsine réunis, à la
 * manière de Zele et al. — la même pondération que pour la lumière du jour.
 *
 * Il remplace le seul rapport mélanopique. Entre un sodium à 2 000 K et une LED
 * à 5 000 K, la mélanopsine seule donnait un facteur 2,9 ; avec les cônes, 1,9.
 * Les cônes voient aussi la lampe chaude.
 */
export function lampPhotophobicRatio(cct) {
  return photophobicRatio(planckMelanopicDER(cct));
}

/**
 * Ce que valait le rapport mélanopique d'une lampe à 2 800 K — la médiane du
 * parc parisien — dans la table qui servait avant. Il sert à relire les jeux de
 * données calculés avec elle.
 */
const LEGACY_MEDIAN_MELANOPIC = 0.477;

/**
 * Facteur à appliquer à une luminance de voile **stockée** par un jeu de données
 * antérieur, pondérée par la mélanopsine seule, pour la ramener à l'échelle
 * photophobe d'aujourd'hui. Exact pour la lampe médiane, approché pour les
 * autres ; recalculer la zone supprime l'approximation.
 */
export const LEGACY_VEIL_SCALE = lampPhotophobicRatio(2800) / LEGACY_MEDIAN_MELANOPIC;

/**
 * Luminance de voile au-delà de laquelle on considère la gêne maximale, cd/m².
 *
 * Calibrée à 2,5 cd/m² sur la distribution mesurée à Paris, quand la voile était
 * pondérée par la mélanopsine seule — voir le README. Le passage à la pondération
 * photophobe relève toutes les voiles d'un même facteur pour la lampe médiane ;
 * la saturation suit, pour que la distribution — et donc la carte — reste celle
 * qu'on avait calibrée.
 */
export const VEIL_SATURATION = 2.5 * LEGACY_VEIL_SCALE;

function interpolate(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const last = table.at(-1);
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    if (x > table[i][0]) continue;
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/**
 * Intensité d'un luminaire de voirie vers un observateur, en candelas.
 *
 * Sans fichier photométrique, la répartition est une hypothèse. On part de
 * l'intensité moyenne sur l'hémisphère inférieur, `flux / 2π`, puis on lui
 * applique un profil « semi-défilé » : un luminaire de rue vise la chaussée,
 * donc **de côté**, avec un maximum vers 65–70° du nadir, et il est conçu pour
 * couper au-delà de 80° — c'est précisément ce qui limite l'éblouissement.
 *
 * L'hypothèse est déclarée parce qu'elle porte le résultat : une répartition
 * uniforme surestimerait d'un facteur trois ce que reçoit un piéton éloigné.
 *
 * @param {number} gamma angle depuis le nadir, en radians
 */
function luminaireIntensity(flux, gamma) {
  const mean = flux / (2 * Math.PI);
  const deg = (gamma * 180) / Math.PI;
  let shape;
  if (deg < 55) shape = 1;
  else if (deg < 70)
    shape = 1 + (0.5 * (deg - 55)) / 15; // le faisceau porte sur la chaussée
  else if (deg < 85)
    shape = 1.5 - (1.25 * (deg - 70)) / 15; // défilement
  else shape = 0.25 - Math.min(0.2, (0.2 * (deg - 85)) / 5);
  return mean * Math.max(0.05, shape);
}

/**
 * Luminance de voile due à un luminaire, en cd/m².
 *
 * Formule de Stiles–Holladay, retenue par la CIE pour l'éblouissement
 * d'incapacité : la lumière parasite diffusée dans l'œil forme un voile
 * uniforme qui masque le contraste. `L_v = 10 · E / θ²`, avec E l'éclairement
 * reçu au niveau de l'œil et θ l'écart angulaire à la ligne de regard.
 *
 * On suppose le regard horizontal — c'est ce que fait un piéton qui marche — et
 * θ vaut donc la hauteur angulaire du luminaire. Le plancher à 1,5° est celui
 * du domaine de validité : en deçà la formule diverge, et on regarderait la
 * lampe en face.
 *
 * @param {{flux:number, height:number, cct:number}} lamp
 * @param {number} distance distance horizontale, en mètres
 * @param {number} eyeHeight hauteur de l'œil, en mètres
 */
export function veilingLuminance(lamp, distance, eyeHeight = 1.6) {
  const rise = lamp.height - eyeHeight;
  const range2 = distance * distance + rise * rise;
  if (range2 < 0.25) return 0;

  // Angle depuis le nadir du luminaire, pour la répartition d'intensité.
  const gamma = Math.atan2(distance, Math.max(0.1, rise));
  const intensity = luminaireIntensity(lamp.flux, gamma);

  // Éclairement au niveau de l'œil, perpendiculairement à la direction de la
  // source : c'est ce que la formule d'éblouissement attend.
  const illuminanceAtEye = intensity / range2;

  // Hauteur angulaire au-dessus du regard. Une borne au sol est **sous** la
  // ligne de regard : elle éblouit aussi, d'où la valeur absolue.
  const theta = Math.max(1.5, Math.abs((Math.atan2(rise, distance) * 180) / Math.PI));

  return (10 * illuminanceAtEye * lampPhotophobicRatio(lamp.cct)) / (theta * theta);
}

/**
 * Composante de gêne nocturne, de 0 à 1.
 *
 * Elle ne se substitue pas aux composantes diurnes : elle prend le relais au
 * crépuscule. Entre le coucher du soleil et la nuit close, les deux coexistent,
 * et c'est bien ce que vit un piéton — le ciel n'est pas encore noir, les
 * lampadaires sont déjà allumés.
 */
export function nightComponent(veil) {
  if (!Number.isFinite(veil) || veil <= 0) return 0;
  return Math.min(1, Math.pow(veil / VEIL_SATURATION, 0.6));
}

/**
 * Part de la gêne qui relève de la nuit, entre 0 et 1, selon la hauteur du soleil.
 *
 * L'éclairage public s'allume au crépuscule civil (soleil à −6°) et l'œil met
 * de longues minutes à s'adapter. On fait donc glisser la bascule sur cette
 * plage plutôt que de la faire claquer au coucher : à −6° la nuit compte pour
 * tout, à +2° pour rien.
 */
export function nightShare(altitude) {
  const deg = (altitude * 180) / Math.PI;
  if (deg <= -6) return 1;
  if (deg >= 2) return 0;
  return (2 - deg) / 8;
}

/**
 * Indice UV local, à partir de l'indice UV annoncé pour un site dégagé.
 *
 * L'ultraviolet est bien plus diffus que la lumière visible : la diffusion de
 * Rayleigh est d'autant plus forte que la longueur d'onde est courte. Se mettre
 * à l'ombre d'un immeuble ne coupe donc pas l'UV autant que l'éblouissement —
 * plus de la moitié continue d'arriver depuis le reste du ciel.
 *
 * L'UV n'est pas ce qui déclenche la photophobie (c'est la lumière visible),
 * mais il compte pour les photodermatoses, le lupus et les traitements
 * photosensibilisants. On l'expose donc à part, jamais fondu dans l'indice.
 *
 * @param {number} uvIndex indice UV en site dégagé (météo, nuages déjà pris en compte)
 * @param {number} transmission transmission du rayonnement direct au point
 * @param {number} svf facteur de vue du ciel
 */
export function localUV(uvIndex, transmission, svf, altitudeDeg = null, directShare = null) {
  if (!Number.isFinite(uvIndex) || uvIndex <= 0) return 0;
  const direct = uvDirectFraction(altitudeDeg, directShare);
  return uvIndex * (direct * transmission + (1 - direct) * svf);
}

/**
 * Part de l'UV qui arrive en faisceau direct, le reste venant du ciel entier.
 *
 * Elle valait 0,45 quelle que soit la situation. C'est à peu près juste par
 * soleil haut et ciel clair, et franchement faux partout ailleurs : à 10° de
 * hauteur, le trajet atmosphérique est tel que **plus de 85 %** de l'UV est déjà
 * diffusé, et sous un ciel couvert la totalité l'est. Une constante disait donc
 * qu'un immeuble protège autant de l'UV à midi qu'au soleil couchant, ce qui est
 * l'inverse de ce qui se passe.
 *
 * Deux facteurs se composent :
 *
 *  - la **hauteur du soleil**, par la longueur du trajet — l'UV est bien plus
 *    diffusé que le visible, la diffusion de Rayleigh variant en λ⁻⁴ ;
 *  - la **part directionnelle** du moment : sous la couche, il ne reste aucun
 *    faisceau, en UV comme en visible.
 *
 * Sans ces informations — appels anciens — on retombe sur l'ancienne constante.
 */
export function uvDirectFraction(altitudeDeg, directShare) {
  if (!Number.isFinite(altitudeDeg)) return 0.45;
  const clearSky = interpolate(
    [
      [0, 0.02],
      [10, 0.15],
      [20, 0.27],
      [30, 0.35],
      [45, 0.43],
      [60, 0.48],
      [90, 0.52],
    ],
    altitudeDeg,
  );
  if (!Number.isFinite(directShare)) return clearSky;
  return Math.max(0, Math.min(1, clearSky * Math.max(0, Math.min(1, directShare))));
}

/** Seuils OMS de l'indice UV. */
export function uvLabel(uv) {
  if (uv < 3) return 'faible';
  if (uv < 6) return 'modéré';
  if (uv < 8) return 'fort';
  if (uv < 11) return 'très fort';
  return 'extrême';
}

/**
 * Scintillement : fréquence d'alternance soleil/ombre le long d'un tronçon.
 *
 * Marcher sous un alignement de platanes ou le long d'une rangée d'immeubles
 * percée de rues transversales produit une stroboscopie lente. Elle reste sous
 * la bande classique de la photosensibilité épileptique (3-30 Hz), mais est
 * très fréquemment rapportée comme déclencheur de migraine — d'où son poids
 * modéré dans l'indice.
 *
 * @param {number[]} transmissions valeurs de transmission le long du tronçon
 * @param {number} sampleStep espacement des échantillons, en mètres
 */
export function flickerFactor(transmissions, sampleStep, underCanopy = null) {
  if (transmissions.length < 3) return 0;

  let transitions = 0;
  let previous = transmissions[0] > 0.5;
  for (let i = 1; i < transmissions.length; i++) {
    const current = transmissions[i] > 0.5;
    if (current !== previous) transitions++;
    previous = current;
  }

  const lengthM = (transmissions.length - 1) * sampleStep;
  if (lengthM <= 0) return 0;

  // À 1,4 m/s, une transition tous les 10 m ≈ 0,14 Hz. On sature à une
  // transition tous les 5 m : au-delà la gêne ne croît plus vraiment.
  const alternation = Math.min(1, transitions / lengthM / 0.2);

  // Sans information de houppier — appels anciens — on s'en tient là.
  if (!underCanopy) return alternation;

  return Math.min(1, dappleFactor(transmissions, underCanopy) + 0.5 * alternation);
}

/**
 * Moucheté de feuillage : le scintillement rapide, celui qui déclenche.
 *
 * ── Pourquoi l'alternance ne suffisait pas ──────────────────────────────────
 *
 * On relève un point tous les 4 m. La fréquence spatiale maximale résoluble est
 * donc de 0,125 cycle/m, soit **0,17 Hz** à 1,35 m/s. La bande rapportée comme
 * déclenchante commence à **3 Hz** : il faudrait échantillonner tous les 23 cm
 * pour l'atteindre. Le modèle captait l'alternance d'arbre en arbre — un platane
 * toutes les huit secondes — et manquait entièrement le moucheté à l'échelle de
 * la feuille, qui est précisément ce qui strobe.
 *
 * ── Ce qu'on mesure à la place ──────────────────────────────────────────────
 *
 * Non pas la fréquence, qu'aucun échantillonnage raisonnable ne donnera, mais la
 * **gappiness** du houppier — sa propension à trouer la lumière. Sous un couvert
 * de transmission moyenne T, la lumière au sol est un damier de taches claires et
 * sombres dont la variance vaut T(1 − T) : nulle sous un feuillage transparent
 * (T = 1, rien ne coupe), nulle sous un feuillage opaque (T = 0, ombre pleine et
 * uniforme), **maximale à mi-chemin**. On normalise à 1 en son sommet.
 *
 * Et l'on ne compte que ce qui est ombré par du **feuillage** : l'ombre d'un
 * immeuble ne scintille pas. Le lancer de rayons distinguait déjà les deux — il
 * renvoie `blocker: 'canopy'` ou `'surface'` — mais cette information était
 * jetée à la sortie.
 *
 * @param {ArrayLike<number>} transmissions transmission le long du tronçon
 * @param {ArrayLike<number>} underCanopy 1 là où l'ombre vient du feuillage
 */
export function dappleFactor(transmissions, underCanopy) {
  let sum = 0;
  for (let i = 0; i < transmissions.length; i++) {
    if (!underCanopy[i]) continue;
    const t = Math.max(0, Math.min(1, transmissions[i]));
    sum += 4 * t * (1 - t);
  }
  return sum / transmissions.length;
}

/** Échelle de couleur de l'indice, partagée par la carte et la légende. */
export const SCALE = [
  { value: 0, color: '#1a2b4a', label: 'Abrité' },
  { value: 20, color: '#2b6b8f', label: 'Ombragé' },
  { value: 40, color: '#4aa3a2', label: 'Modéré' },
  { value: 60, color: '#d9a441', label: 'Exposé' },
  { value: 80, color: '#e8663d', label: 'Très exposé' },
  { value: 100, color: '#f7e463', label: 'Plein soleil' },
];

export function levelLabel(index) {
  let label = SCALE[0].label;
  for (const stop of SCALE) {
    if (index >= stop.value) label = stop.label;
  }
  return label;
}

/** Les huit orientations cardinales, dans l'ordre horaire depuis le nord. */
export const CARDINALS = [
  'nord',
  'nord-est',
  'est',
  'sud-est',
  'sud',
  'sud-ouest',
  'ouest',
  'nord-ouest',
];

/**
 * Types de voie retenus, dans un ordre figé.
 *
 * L'ordre fait foi : c'est l'index qui est écrit dans le fichier binaire, et le
 * réordonner invaliderait silencieusement toutes les données déjà calculées.
 */
export const HIGHWAYS = [
  'footway',
  'residential',
  'service',
  'pedestrian',
  'path',
  'steps',
  'cycleway',
  'living_street',
  'tertiary',
  'secondary',
  'primary',
  'unclassified',
  'track',
  'road',
];

/** Nom cardinal d'une direction, pour désigner un trottoir. */
export function cardinalLabel(east, north) {
  const degrees = (Math.atan2(east, north) * 180) / Math.PI;
  return CARDINALS[Math.round(((degrees + 360) % 360) / 45) % 8];
}
