/**
 * Modèle d'exposition lumineuse.
 *
 * Partagé entre le pipeline et le web : il n'existe qu'une seule définition de
 * l'indice dans tout le projet.
 *
 * Le pipeline ne calcule et ne stocke que des grandeurs *physiques* qui
 * dépendent de la géométrie de la ville : la transmission du rayon solaire, le
 * facteur de vue du ciel, le scintillement. Tout le reste — éclairement,
 * éblouissement, indice, UV — se recompose ici, à l'affichage. C'est ce qui
 * permet d'appliquer la météo du jour ou de retoucher les pondérations sans
 * relancer une seule minute de calcul.
 *
 * L'indice n'est pas une mesure. C'est une estimation à partir de la forme de
 * la ville : il répond à « cet endroit est-il plus exposé que cet autre », pas
 * à « combien de lux exactement ».
 */

import { clearSkyIlluminance, linkeFromBeam, perezSkyIndices } from './lib/sun.js';
import { skyDistribution } from './lib/sky.js';

/**
 * Éclairement diffus horizontal qui sature la gêne due au ciel lui-même.
 *
 * Attention au piège : ce n'est *pas* la valeur d'un ciel clair (~15 500 lux au
 * zénith). Sous un ciel couvert, tout le rayonnement devient diffus et
 * l'éclairement diffus horizontal grimpe vers 50 000 lux — bien au-delà d'un
 * ciel bleu. Normaliser sur le ciel clair ferait dépasser 1 à cette composante
 * et rendrait la carte absurdement chaude dès qu'il y a des nuages.
 *
 * 25 000 lux correspond à un ciel blanc franchement lumineux ; au-delà, la
 * gêne ne croît plus vraiment, d'où la saturation.
 */
const SKY_SATURATION = 25000;

/** Plafond mesuré de l'éclairement diffus horizontal, ciel voilé lumineux d'été. */
const MAX_DIFFUSE = 45000;

/**
 * Luminance de façade qui sature la gêne, en cd/m².
 *
 * Un mur de calcaire en plein soleil — 50 000 lux dessus, albédo 0,45 —
 * atteint environ 7 000 cd/m². C'est du même ordre qu'un ciel couvert lumineux,
 * sauf que le mur, lui, est à hauteur des yeux. Au-delà de 8 000, la gêne ne
 * croît plus vraiment.
 */
const REVERB_SATURATION = 8000;

/**
 * Éclairement direct normal au-delà duquel l'éblouissement ne croît plus, en lux.
 *
 * C'est une référence de saturation, pas la valeur d'un ciel clair : le modèle
 * de ciel clair culmine vers 85 000 lux à Paris. Le nombre traînait en dur au
 * milieu de la formule d'éblouissement, où on le confondait avec le sommet du
 * modèle — et où il ne bornait rien, faute de `min`. Un flux mesuré supérieur
 * pouvait donc pousser la composante au-delà de 1.
 */
const GLARE_SATURATION = 128000;

/**
 * Réflectance du sol de rue, façades exclues.
 *
 * Le modèle n'avait aucun terme de sol : il additionnait le faisceau direct, le
 * ciel et les façades, et s'arrêtait là. Or une chaussée ensoleillée à 80 000 lux
 * renvoie près de 4 000 cd/m² — le même ordre de grandeur qu'un mur de calcaire
 * au soleil — et elle occupe **toute la moitié basse du champ de vision**, celle
 * où l'on regarde en marchant.
 *
 * 0,18 est un mélange : l'asphalte d'une chaussée tourne autour de 0,10, un
 * trottoir de pierre ou de béton entre 0,25 et 0,35. Bien plus sombre que les
 * 0,45 des façades parisiennes, d'où une valeur distincte plutôt que l'albédo
 * unique employé jusqu'ici.
 */
export const DEFAULT_GROUND_ALBEDO = 0.18;

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
 * Efficacités lumineuses, en lumens par watt : de quoi convertir les flux
 * énergétiques du modèle météo en lux, la grandeur qui nous intéresse.
 *
 * Le ciel diffus est plus « efficace » que le faisceau direct parce qu'il est
 * plus bleu, donc plus proche du pic de sensibilité de l'œil. Valeurs usuelles
 * pour un ciel dégagé (Littlefair, 1985).
 */
const BEAM_EFFICACY = 105;
const DIFFUSE_EFFICACY = 120;

/**
 * Atténuation par la couverture nuageuse.
 *
 * L'éclairement global suit la relation empirique de Kasten & Czeplak (1980),
 * G/G₀ = 1 − 0,75·N^3,4 avec N la nébulosité. Le rayonnement direct, lui,
 * s'effondre beaucoup plus vite : sous un ciel complètement couvert il ne reste
 * plus rien du faisceau, et toute la lumière arrive du ciel entier.
 *
 * C'est important ici, et pas seulement cosmétique : par temps couvert, éviter
 * le soleil n'a plus de sens, alors qu'une rue étroite protège toujours de la
 * luminance du ciel. Le classement des rues change complètement.
 *
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} cloud couverture nuageuse, de 0 (ciel clair) à 1 (couvert)
 */
export function skyConditions(altitude, cloud = 0, irradiance = null, azimuth = null, bins = 16) {
  const sinH = Math.max(Math.sin(altitude), 0);

  // Quand le modèle météo fournit directement les flux, on les prend : ils
  // valent bien mieux qu'une déduction à partir de la nébulosité. Reste à
  // passer des watts aux lux, ce que fait l'efficacité lumineuse — le faisceau
  // direct est un peu moins « efficace » que la lumière du ciel, plus bleue.
  if (irradiance && Number.isFinite(irradiance.beam)) {
    const directNormal = Math.max(0, irradiance.beam) * BEAM_EFFICACY;
    const diffuseHorizontal = Math.min(
      MAX_DIFFUSE,
      Math.max(0, irradiance.diffuse ?? 0) * DIFFUSE_EFFICACY,
    );
    const global = directNormal * sinH + diffuseHorizontal;
    return withDistribution(
      {
        directNormal,
        diffuseHorizontal,
        sinH,
        directShare: global > 0 ? (directNormal * sinH) / global : 0,
        measured: true,
      },
      altitude,
      azimuth,
      bins,
    );
  }

  const clear = clearSkyIlluminance(altitude);
  const c = Math.max(0, Math.min(1, cloud));

  const globalClear = clear.directNormal * sinH + clear.diffuseHorizontal;
  const globalCloudy = globalClear * (1 - 0.75 * Math.pow(c, 3.4));

  // La nébulosité est une *fraction de ciel couvert*, pas une transmission :
  // à 50 % le disque solaire reste dégagé une bonne partie du temps. L'exposant
  // 1,5 corrige légèrement à la baisse — les nuages s'accumulent plus volontiers
  // autour du soleil qu'ailleurs.
  const directNormal = clear.directNormal * Math.pow(1 - c, 1.5);

  // Le reste du global part en diffus, plafonné : sous ciel voilé lumineux on
  // mesure jusqu'à ~45 000 lux d'éclairement diffus horizontal, jamais plus.
  const diffuseHorizontal = Math.min(
    MAX_DIFFUSE,
    Math.max(0, globalCloudy - directNormal * sinH),
  );

  return withDistribution(
    {
      directNormal,
      diffuseHorizontal,
      sinH,
      /** Part de la lumière qui reste directionnelle : 1 par ciel clair, 0 sous la couche. */
      directShare: globalClear > 0 ? (directNormal * sinH) / globalClear : 0,
      measured: false,
    },
    altitude,
    azimuth,
    bins,
  );
}

/**
 * Attache la distribution de luminance du ciel, quand l'azimut solaire est connu.
 *
 * Elle coûte un tiers de milliseconde à construire, contre un dixième de
 * microseconde à interroger : c'est tout l'intérêt de la placer ici, dans un
 * objet qui ne dépend que de l'instant et que l'appelant met déjà en cache à la
 * minute. Un itinéraire évalue des dizaines de milliers d'arêtes, mais ne
 * traverse qu'une poignée de minutes distinctes.
 *
 * Sans azimut — anciens appels, tests d'invariants — on s'en passe, et le modèle
 * retombe sur le facteur de vue du ciel isotrope d'avant.
 */
function withDistribution(sky, altitude, azimuth, bins) {
  // Clarté de Perez : l'indice normalisé pour classer un ciel. Il remplace la
  // part directionnelle, une grandeur maison qui confondait des ciels très
  // différents — un voile uniforme et des cumulus épars peuvent avoir la même
  // part directe moyenne et des distributions de luminance sans rapport.
  const { epsilon, brightness } = perezSkyIndices(
    sky.directNormal,
    sky.diffuseHorizontal,
    altitude,
  );
  sky.epsilon = epsilon;
  sky.brightness = brightness;
  // Le trouble du jour, lu à l'envers du faisceau mesuré. Sert au mode « ciel
  // clair », qui devient ainsi la référence de *cette* atmosphère et non d'une
  // moyenne annuelle.
  if (sky.measured) sky.turbidity = linkeFromBeam(sky.directNormal, altitude);

  if (!Number.isFinite(azimuth)) return sky;
  // Le nombre de secteurs doit suivre celui du profil d'horizon stocké. S'il
  // diffère, `factor` refuse le profil et le modèle retombe **sans un mot** sur
  // le ciel isotrope : porter les secteurs de 16 à 32 aurait annulé en silence
  // toute l'anisotropie. C'est exactement le genre de panne muette que ce projet
  // a déjà payée.
  sky.distribution = skyDistribution({ altitude, azimuth, epsilon, bins });
  return sky;
}

/**
 * Part de l'éclairement diffus de ciel ouvert qui atteint réellement ce point.
 *
 * C'est ici que se joue le remplacement du ciel isotrope. Le facteur de vue du
 * ciel — la fraction *géométrique* de voûte visible — reste le repli : il
 * suppose une luminance uniforme, ce qui n'arrive jamais.
 */
function skyReach(svf, horizon, sky) {
  const factor = horizon ? sky?.distribution?.factor(horizon) : null;
  return Number.isFinite(factor) ? factor : svf;
}

/**
 * Température de couleur du faisceau solaire direct, selon sa hauteur.
 *
 * Le soleil rougit en descendant : la diffusion de Rayleigh retire d'autant plus
 * de bleu que le trajet dans l'atmosphère est long. De 5 600 K au zénith à
 * moins de 2 000 K au ras de l'horizon — l'écart de couleur qu'on voit à l'œil
 * nu entre midi et le coucher.
 *
 * @param {number} altitudeDeg hauteur du soleil, en degrés
 */
export function beamColourTemperature(altitudeDeg) {
  const table = [
    [0, 1900],
    [2, 2400],
    [5, 2900],
    [10, 3600],
    [20, 4600],
    [30, 5100],
    [50, 5600],
    [90, 5800],
  ];
  return interpolate(table, altitudeDeg);
}

/**
 * Température de couleur du ciel diffus, selon sa clarté.
 *
 * Un ciel couvert est à peu près neutre, autour de 6 500 K. Un ciel bleu franc
 * est la source la plus bleue qu'on rencontre dehors : au-delà de 15 000 K,
 * parce qu'on n'y voit précisément que la lumière diffusée par Rayleigh, celle
 * que le faisceau direct a perdue.
 *
 * @param {number} directShare part directionnelle de la lumière (0-1)
 */
export function skyColourTemperature(directShare) {
  const x = Math.max(0, Math.min(1, directShare));
  return 6500 + 9500 * x;
}

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
 * Éclairement pondéré par la sensibilité mélanopique, en lux équivalents.
 *
 * ── Pourquoi c'est ici la bonne grandeur ────────────────────────────────────
 *
 * La photophobie ne se joue pas en lumens. Elle passe pour l'essentiel par les
 * cellules ganglionnaires à mélanopsine, dont la sensibilité culmine vers 480 nm
 * — dans le bleu. Le modèle le savait déjà, et l'appliquait avec soin **aux
 * lampadaires** : c'est ce qui distingue un sodium d'une LED froide. Il ne le
 * faisait pas du tout pour la lumière du jour, où l'écart est pourtant plus
 * grand encore.
 *
 * À éclairement égal, un ciel bleu zénithal est près de **six fois** plus actif
 * sur la mélanopsine qu'un soleil rasant rougi. Les compter à égalité, comme le
 * faisait la composante de luminosité, revenait à dire que 10 000 lux de ciel
 * d'altitude et 10 000 lux de soleil couchant se valent — ce qui est faux pour
 * exactement le public visé.
 *
 * L'éblouissement, lui, reste photopique : un soleil couchant dans les yeux
 * éblouit par sa luminance, pas par son contenu bleu. Les deux mécanismes sont
 * distincts, et le modèle les sépare désormais.
 */
export function melanopicIlluminance(direct, diffuse, altitudeDeg, directShare) {
  return (
    Math.max(0, direct) * daylightMelanopicRatio(beamColourTemperature(altitudeDeg)) +
    Math.max(0, diffuse) * daylightMelanopicRatio(skyColourTemperature(directShare))
  );
}

/**
 * Rapport mélanopique moyen de la lumière incidente, faisceau et ciel mêlés.
 *
 * Sert à étendre la pondération à ce que renvoient les surfaces : une façade
 * n'invente pas de spectre, elle renvoie celui qu'elle reçoit, à peine teinté
 * par sa propre couleur. Sans ce prolongement, l'éclairement mélanopique affiché
 * ne couvrait que le direct et le diffus, quand l'éclairement total comptait
 * aussi les réflexions — deux grandeurs qu'on ne pouvait pas comparer.
 */
export function melanopicMix(direct, diffuse, altitudeDeg, directShare) {
  const sum = Math.max(0, direct) + Math.max(0, diffuse);
  if (sum <= 0) return 1;
  return melanopicIlluminance(direct, diffuse, altitudeDeg, directShare) / sum;
}

/**
 * Réverbération : ce que les façades renvoient dans les yeux.
 *
 * C'est le terme qui manquait, et probablement celui qui compte le plus pour ce
 * public. Un mur de calcaire lutétien au soleil, avec 70 000 lux dessus et un
 * albédo de 0,45, atteint 10 000 cd/m² — la luminance d'un ciel couvert
 * lumineux — et il occupe le champ de vision **à hauteur des yeux**, quand le
 * ciel, lui, est au-dessus. Marcher sur le trottoir à l'ombre face à un mur en
 * plein soleil peut être plus pénible qu'être au soleil.
 *
 * ── Comment savoir si le mur d'en face est éclairé ──────────────────────────
 * Le refaire au lancer de rayons à chaque instant coûterait des milliards
 * d'opérations. On s'en sort avec de la géométrie de canyon, sur le seul profil
 * d'horizon, qui est statique.
 *
 * Dans une rue de largeur W, le soleil à la hauteur α passant au-dessus d'un
 * bâtiment de hauteur H₁ projette son ombre jusqu'à la hauteur H₁ − W·tan α sur
 * le mur d'en face. En posant β₁ = atan(H₁/W) et β₂ = atan(H₂/W), les élévations
 * d'horizon vues du piéton, la part ensoleillée du mur d'en face vaut
 *
 *     1 − max(0, tan β₁ − tan α) / tan β₂
 *
 * La largeur de la rue s'élimine : il ne reste que des angles, ceux-là mêmes
 * que le balayage d'horizon a déjà relevés. Exact pour un canyon droit,
 * approché ailleurs.
 *
 * @param {number[]} horizon élévation de l'horizon bâti par secteur, en degrés
 * @param {number} altitude hauteur du soleil, en radians
 * @param {number} azimuth azimut du soleil, en radians depuis le nord
 * @param {object} sky conditions de ciel
 * @param {number} albedo réflectance des façades
 * @returns {{lux: number, sunlitWalls: number, wallView: number}}
 */
export function reverberation(horizon, altitude, azimuth, sky, albedo) {
  const bins = horizon?.length ?? 0;
  if (bins === 0) return { lux: 0, sunlitWalls: 0, wallView: 0 };

  const tanSun = altitude > 0 ? Math.tan(altitude) : 0;
  const tanSunSide = Math.tan(horizonAt(horizon, azimuth));

  let lux = 0;
  let sunlitWalls = 0;
  let wallView = 0;
  let weightedLuminance = 0;

  for (let i = 0; i < bins; i++) {
    const beta = (horizon[i] * Math.PI) / 180;
    // Part du champ de vision occupée par du mur dans ce secteur : le
    // complément de la part de ciel, cos²β.
    const share = 1 - Math.cos(beta) * Math.cos(beta);
    if (share <= 0) continue;
    wallView += share;

    const wallAzimuth = (2 * Math.PI * i) / bins;
    // Le mur me fait face : sa normale pointe vers moi. Le soleil l'éclaire
    // s'il se trouve de ce côté-là.
    const facing = -Math.cos(azimuth - wallAzimuth);

    // ── Le ciel que voit ce mur ─────────────────────────────────────────────
    //
    // On posait « un mur ne voit qu'un demi-ciel », soit 0,5 × E_diffus, pour
    // tous les murs de toutes les rues. C'est vrai d'un mur isolé en plein
    // champ ; dans une rue, le bâtiment d'en face lui en masque une bonne part,
    // et l'éclairement des façades était donc **surestimé là où la rue est
    // étroite** — exactement les rues qui comptent.
    //
    // Le mur d'en face, vu du pied de ce mur-ci, est deux fois moins haut en
    // angle que vu du milieu de la rue : la distance double. Sa hauteur relevée
    // dans le secteur opposé donne donc directement l'obstruction.
    // Le mur d'en face, vu du pied de ce mur-ci, est deux fois moins haut en
    // angle que vu du milieu de la rue : la distance double.
    const oppositeBeta = (horizon[(i + (bins >> 1)) % bins] * Math.PI) / 180;
    const seenFromWall = (Math.atan(Math.tan(oppositeBeta) / 2) * 180) / Math.PI;

    // Le ciel réellement vu par ce mur, luminance comprise. À défaut de
    // distribution — anciens appels — on retombe sur le demi-ciel uniforme
    // corrigé de la seule obstruction.
    const wallReach =
      sky.distribution?.wallFactor(i, seenFromWall) ??
      0.5 * Math.pow(Math.cos((seenFromWall * Math.PI) / 180), 2);
    let irradiated = wallReach * sky.diffuseHorizontal;

    if (facing > 0 && altitude > 0) {
      const tanWall = Math.tan(beta);
      // ── Soleil oblique à la rue ───────────────────────────────────────────
      //
      // La formule de canyon supposait le soleil **perpendiculaire** à la rue.
      // Quand il arrive de biais, son rayon traverse la chaussée sur une
      // distance W/|cos Δθ| au lieu de W, et descend donc d'autant plus avant
      // d'atteindre le mur d'en face : l'ombre y monte moins haut.
      //
      // À la limite, soleil dans l'axe de la rue (Δθ = 90°), le rayon ne
      // traverse jamais — le mur est entièrement éclairé, quelle que soit la
      // hauteur du bâtiment d'en face. C'est exactement ce qui se passe dans une
      // rue orientée vers le couchant, et le modèle l'ombrait à tort.
      //
      // `facing` est déjà le cosinus de l'angle entre le soleil et la normale du
      // mur : la correction ne coûte rien de plus qu'une division.
      const effectiveTanSun = tanSun / Math.max(facing, 0.05);
      const sunlit =
        tanWall > 0
          ? Math.max(0, Math.min(1, 1 - Math.max(0, tanSunSide - effectiveTanSun) / tanWall))
          : 0;
      irradiated += sky.directNormal * Math.cos(altitude) * facing * sunlit;
      sunlitWalls += share * sunlit;
    }

    lux += share * albedo * irradiated;
    // Luminance de la surface, en cd/m² : c'est *elle* qui éblouit, et non
    // l'éclairement horizontal qu'elle produit. Un mur à 7 000 cd/m² occupant
    // le tiers du champ de vision fait mal, même s'il n'ajoute que quelques
    // milliers de lux sur un plan horizontal — lequel regarde le ciel, pas le
    // mur.
    weightedLuminance += share * ((albedo * irradiated) / Math.PI);
  }

  return {
    lux: lux / bins,
    /** Luminance moyenne des murs visibles, pondérée par leur part de champ. */
    luminance: wallView > 0 ? weightedLuminance / wallView : 0,
    sunlitWalls: sunlitWalls / bins,
    wallView: wallView / bins,
  };
}

/** Élévation d'horizon dans une direction quelconque, interpolée entre secteurs. */
function horizonAt(horizon, azimuth) {
  const bins = horizon.length;
  const position = (((azimuth / (2 * Math.PI)) * bins) % bins + bins) % bins;
  const i = Math.floor(position);
  const j = (i + 1) % bins;
  const t = position - i;
  return ((horizon[i] + (horizon[j] - horizon[i]) * t) * Math.PI) / 180;
}

/**
 * Éclairement reçu par un piéton, en lux.
 *
 * @param {object} p
 * @param {number} p.transmission part du rayonnement direct qui l'atteint (0-1)
 * @param {number} p.svf facteur de vue du ciel (0-1)
 * @param {number} p.altitude hauteur du soleil, en radians
 * @param {number[]} [p.horizon] profil d'horizon bâti, en degrés par secteur
 * @param {number} [p.cloud] couverture nuageuse (0-1)
 * @param {number} [p.albedo] réflectance des façades
 * @param {number} [p.groundAlbedo] réflectance du sol de rue
 */
export function illuminance({
  transmission,
  svf,
  altitude,
  azimuth,
  horizon,
  cloud = 0,
  albedo = 0.45,
  groundAlbedo = DEFAULT_GROUND_ALBEDO,
  wet = 0,
  sky,
}) {
  sky ??= skyConditions(altitude, cloud, null, azimuth, horizon?.length ?? 16);

  const direct = transmission * sky.directNormal * sky.sinH;
  // Anisotropie du ciel : ce n'est pas la fraction de voûte visible qui compte,
  // c'est la luminance de la portion qu'on voit. Une ruelle ne voit que le
  // zénith — le plus lumineux sous un ciel couvert ; une rue tournée vers le
  // soleil couchant voit la région circumsolaire, jusqu'à onze fois le fond.
  const diffuse = skyReach(svf, horizon, sky) * sky.diffuseHorizontal;

  // Sans profil d'horizon — jeu de données antérieur — on retombe sur
  // l'ancienne estimation grossière, qui ignore si les murs sont éclairés.
  const walls = horizon
    ? reverberation(horizon, altitude, azimuth, sky, albedo)
    : (() => {
        const flat = (1 - svf) * albedo * (sky.directNormal * sky.sinH + sky.diffuseHorizontal) * 0.3;
        return { lux: flat, luminance: flat / Math.PI, sunlitWalls: 0, wallView: 1 - svf };
      })();

  // ── Le sol qu'on voit n'est pas celui sur lequel on se tient ───────────────
  //
  // On prenait la transmission du piéton : à l'ombre d'un immeuble, le sol était
  // donc réputé sombre. Or on regarde la rue devant soi, sur des dizaines de
  // mètres, et cette portion-là peut être en plein soleil. Se tenir à l'ombre
  // face à une chaussée éclairée est un cas courant, et pénible.
  //
  // La part ensoleillée de la chaussée se lit dans la même géométrie de canyon
  // que les façades : un mur d'élévation β vu du milieu de la rue porte une
  // ombre sur une fraction tan β / (2 tan α) de la largeur.
  const tanAlt = altitude > 0 ? Math.tan(altitude) : 0;
  const groundSunlit =
    horizon && tanAlt > 0
      ? Math.max(0, Math.min(1, 1 - Math.tan(horizonAt(horizon, azimuth)) / (2 * tanAlt)))
      : 0;
  // Moitié sous les pieds, moitié devant : la première suit ce qui nous ombre,
  // la seconde la géométrie de la rue.
  const groundLit = 0.5 * transmission + 0.5 * groundSunlit;
  const groundDirect = groundLit * sky.directNormal * sky.sinH;

  // ── Chaussée mouillée ─────────────────────────────────────────────────────
  //
  // Une chaussée humide n'est pas une chaussée plus claire : l'eau comble les
  // pores et la réflectance **diffuse baisse**. Ce qui apparaît, c'est un miroir.
  //
  // La réflectance spéculaire de l'eau suit Fresnel, et grimpe brutalement en
  // incidence rasante — approximation de Schlick, R₀ = 0,02 :
  //
  //     R = R₀ + (1 − R₀)·(1 − cos θ)⁵
  //
  // À 60° de hauteur de soleil, R vaut 0,02 : rien. À 10°, il vaut **0,40**. Une
  // rue mouillée sous un soleil bas renvoie donc l'image du disque solaire en
  // pleine face — l'une des situations les plus pénibles qui soient pour ce
  // public, et le modèle l'ignorait entièrement.
  const wetness = Math.max(0, Math.min(1, wet));
  const diffuseAlbedo = groundAlbedo * (1 - 0.3 * wetness);
  const groundLuminance = (diffuseAlbedo * (groundDirect + diffuse)) / Math.PI;

  // Le miroir ne renvoie que le faisceau direct, et seulement là où il arrive.
  const cosIncidence = Math.max(0, sky.sinH);
  const fresnel = 0.02 + 0.98 * Math.pow(1 - cosIncidence, 5);
  const specular = wetness * fresnel * groundDirect;

  // Charge lumineuse renvoyée dans les yeux : façades **et** sol.
  //
  // Additive, et non moyennée sur le champ de vision. La moyenne était tentante
  // — c'est la géométrie qui la suggère — mais elle décrit la mauvaise physique :
  // elle diluait des façades éblouissantes dans un sol sombre et faisait *baisser*
  // l'indice de deux points au soleil rasant. Or un fond sombre ne soulage pas
  // d'une source vive ; à luminance égale il l'aggrave, c'est tout le principe de
  // la luminance de voile déjà employée pour l'éclairage nocturne.
  //
  // Le sol entre donc en supplément, à hauteur de la moitié du champ qu'il
  // occupe, et la luminance des façades reste exactement ce qu'elle était — la
  // grandeur validée rue par rue.
  // ── Les rebonds suivants ──────────────────────────────────────────────────
  //
  // Le modèle s'arrêtait à la première réflexion. Dans une rue étroite bordée de
  // calcaire clair, la lumière renvoyée par une façade éclaire celle d'en face,
  // qui la renvoie à son tour. La série géométrique classique donne le facteur
  // d'amplification
  //
  //     1 / (1 − ρ̄ · (1 − ψ))
  //
  // avec ρ̄ la réflectance moyenne des surfaces et ψ la part de ciel — donc
  // (1 − ψ) la part de l'hémisphère occupée par des surfaces qui se renvoient la
  // lumière. En site dégagé le facteur vaut 1 et rien ne change ; rue de la
  // Colombe, ouverture au ciel de 19 %, il vaut 1,3.
  const enclosure = Math.max(0, Math.min(1, 1 - svf));
  const meanAlbedo = 0.5 * (albedo + groundAlbedo);
  const bounces = 1 / Math.max(0.4, 1 - meanAlbedo * enclosure);

  const wallLuminance = walls.luminance * bounces;
  const litGround = groundLuminance * bounces;

  // Charge lumineuse renvoyée dans les yeux : façades **et** sol.
  //
  // Additive, et non moyennée sur le champ de vision. La moyenne était tentante
  // — c'est la géométrie qui la suggère — mais elle décrit la mauvaise physique :
  // elle diluait des façades éblouissantes dans un sol sombre et faisait *baisser*
  // l'indice de deux points au soleil rasant. Or un fond sombre ne soulage pas
  // d'une source vive ; à luminance égale il l'aggrave, c'est tout le principe de
  // la luminance de voile déjà employée pour l'éclairage nocturne.
  //
  // Le sol entre donc en supplément, à hauteur de la moitié du champ qu'il
  // occupe.
  // Le reflet spéculaire est concentré, donc lumineux : on le compte comme une
  // luminance à part entière, non dilué dans la moitié de champ du sol diffus.
  const surfaceLuminance = wallLuminance + 0.5 * litGround + (specular / Math.PI) * bounces;
  const altitudeDeg = altitude * (180 / Math.PI);
  const total = direct + diffuse + walls.lux * bounces;

  return {
    direct,
    diffuse,
    reflected: walls.lux * bounces,
    /** Luminance des seules façades, rebonds compris. */
    wallLuminance,
    groundLuminance: litGround,
    /** Façades et sol réunis — ce qui pèse réellement sur les yeux. */
    surfaceLuminance,
    sunlitWalls: walls.sunlitWalls,
    /** Part de la chaussée en vue qui est au soleil. */
    groundSunlit,
    /** Éclairement renvoyé en miroir par une chaussée mouillée, en lux. */
    specular,
    /** Amplification due aux réflexions multiples. */
    bounces,
    /**
     * Éclairement du ciel et du soleil, pondéré mélanopiquement. C'est la
     * grandeur qui nourrit la composante de luminosité : les surfaces ont leur
     * propre composante, les compter ici les compterait deux fois.
     */
    melanopic: melanopicIlluminance(direct, diffuse, altitudeDeg, sky.directShare),
    /** Le même pondération appliquée à l'éclairement total, réflexions comprises. */
    melanopicTotal: melanopicMix(direct, diffuse, altitudeDeg, sky.directShare) * total,
    total,
  };
}

/**
 * Éblouissement : le soleil est-il visible, et assez bas pour tomber dans le
 * champ de vision d'un piéton qui regarde devant lui ?
 *
 * Au-delà de 50° de hauteur il faut lever la tête pour le voir : la gêne
 * bascule alors vers la luminance générale de la scène, que portent les autres
 * composantes de l'indice. C'est ce terme qui distingue 12 h de 19 h à
 * exposition égale — à midi le soleil cogne d'aplomb, le soir il arrive dans
 * l'axe du regard.
 */
export function glareFactor({
  transmission,
  altitude,
  azimuth,
  heading,
  cloud = 0,
  wet = 0,
  sky,
}) {
  if (altitude <= 0 || transmission <= 0) return 0;
  sky ??= skyConditions(altitude, cloud);
  const altitudeDeg = altitude * (180 / Math.PI);
  const p = positionIndex(altitudeDeg);
  const brightness = Math.min(1, sky.directNormal / GLARE_SATURATION);

  // L'inconfort décroît comme le carré de l'indice de position : c'est la
  // structure de l'UGR, où chaque source pèse L²·ω/P².
  let load = brightness / (p * p);

  // La chaussée mouillée renvoie l'image du disque solaire, à la même distance
  // angulaire de la ligne de regard mais **en dessous**. C'est une seconde
  // source, pondérée par Fresnel — négligeable soleil haut, dominante au ras de
  // l'horizon, où elle peut presque doubler la gêne.
  if (wet > 0) {
    const cosIncidence = Math.max(0, Math.sin(altitude));
    const fresnel = 0.02 + 0.98 * Math.pow(1 - cosIncidence, 5);
    load += Math.max(0, Math.min(1, wet)) * fresnel * load;
  }

  return Math.min(1, transmission * (load / GLARE_PEAK) * facingFactor(azimuth, heading));
}

/**
 * Maximum du produit « éclat × indice de position » sur la course du soleil.
 *
 * Sans lui, la composante d'éblouissement ne monte plus qu'à 0,12 : le passage à
 * l'indice de Guth a fait chuter le facteur positionnel de plusieurs ordres, et
 * le poids de 0,10 déclaré dans les métadonnées ne pesait plus, en pratique, que
 * 1,3 point sur cent. **Un poids qui ne veut plus dire ce qu'il dit est pire
 * qu'un poids mal choisi** — le README annonce des composantes ramenées entre 0
 * et 1, et c'est ce contrat qu'on rétablit ici.
 *
 * On normalise sur la géométrie, pas sur une valeur inventée : le maximum réel
 * du produit, atteint vers dix degrés de hauteur par ciel clair.
 */
const GLARE_PEAK = (() => {
  let peak = 0;
  for (let deg = 0.25; deg <= 90; deg += 0.25) {
    const clear = clearSkyIlluminance((deg * Math.PI) / 180);
    const p = positionIndex(deg);
    peak = Math.max(peak, Math.min(1, clear.directNormal / GLARE_SATURATION) / (p * p));
  }
  return peak;
})();

/**
 * Indice de position de Guth, pour une source au-dessus de la ligne de regard.
 *
 * Remplace une rampe linéaire coupée à 50°, qui était une invention. L'indice de
 * position est la grandeur normalisée qui dit combien une source gêne *moins*
 * lorsqu'elle s'écarte de l'axe du regard — c'est le P du dénominateur de l'UGR.
 *
 * L'ajustement analytique de Levin (1975) sur les données de Luckiesh & Guth,
 * ici pour un écart purement vertical, la ligne de regard d'un piéton étant
 * horizontale :
 *
 *     P = exp[ (35,2 − 1,22) · 10⁻³ · σ + 21 · 10⁻⁵ · σ² ]
 *
 * L'écart avec l'ancienne rampe est considérable, et dans le bon sens : à 30° de
 * hauteur, la rampe donnait encore 0,4 quand l'indice de position donne 0,09. Un
 * soleil à trente degrés est déjà largement au-dessus du champ utile ; c'est bien
 * le soleil rasant qui fait mal, et le modèle le disait trop mollement.
 *
 * @param {number} elevationDeg hauteur de la source au-dessus du regard, en degrés
 */
export function positionIndex(elevationDeg) {
  // Au-delà, la source est hors du champ de vision : l'ajustement n'y est plus
  // valable, et prolonger l'exponentielle donnerait des nombres absurdes.
  const sigma = Math.max(0, Math.min(80, elevationDeg));
  return Math.exp(0.03398 * sigma + 0.00021 * sigma * sigma);
}

/**
 * Le soleil est-il devant vous, ou dans votre dos ?
 *
 * Marcher vers l'est à huit heures du matin face à un soleil rasant est
 * pénible ; parcourir la même rue vers l'ouest à la même heure ne l'est pas du
 * tout. Sans direction de marche connue — sur la carte, où une rue n'a pas de
 * sens — on ne tranche pas et le terme vaut 1.
 *
 * Le plancher à 0,3 n'est pas de la timidité : soleil dans le dos, le trottoir
 * et les façades d'en face renvoient encore beaucoup de lumière dans les yeux.
 *
 * @param {number} azimuth azimut du soleil, en radians depuis le nord
 * @param {number} heading cap de marche, en radians depuis le nord
 */
function facingFactor(azimuth, heading) {
  if (!Number.isFinite(azimuth) || !Number.isFinite(heading)) return 1;
  return 0.3 + 0.7 * Math.max(0, Math.cos(azimuth - heading));
}

/**
 * Composantes normalisées (0-1) de la gêne lumineuse, en un point et un instant.
 * Toutes tombent à zéro la nuit — l'éclairage public n'est pas modélisé.
 */
export function components({
  transmission,
  svf,
  altitude,
  azimuth,
  heading,
  horizon,
  flicker = 0,
  cloud = 0,
  albedo = 0.45,
  groundAlbedo = DEFAULT_GROUND_ALBEDO,
  wet = 0,
  luxReference = 90000,
  veil = 0,
  sky,
}) {
  // `sky` ne dépend que de l'instant, jamais du lieu : l'appelant qui boucle
  // sur des dizaines de milliers de tronçons a tout intérêt à le calculer une
  // seule fois et à le passer ici.
  sky ??= skyConditions(altitude, cloud, null, azimuth, horizon?.length ?? 16);
  const lux = illuminance({
    transmission,
    svf,
    altitude,
    azimuth,
    horizon,
    albedo,
    groundAlbedo,
    wet,
    sky,
  });

  return {
    sun: altitude > 0 ? transmission * sky.directShare : 0,
    // Même correction que pour l'éclairement : la gêne due au ciel ne suit pas
    // la fraction de voûte visible, mais la luminance de ce qu'on en voit.
    sky:
      skyReach(svf, horizon, sky) *
      Math.min(1, Math.pow(sky.diffuseHorizontal / SKY_SATURATION, 0.7)),
    // `bright` ne retient que ce qui vient du ciel et du soleil ; ce que
    // renvoient les murs a sa propre composante. Les additionner ici les
    // compterait deux fois.
    //
    // Pondéré par la sensibilité mélanopique : c'est elle qui porte la
    // photophobie, et le modèle ne l'appliquait qu'aux lampadaires.
    bright: Math.min(1, Math.pow(lux.melanopic / luxReference, 0.6)),
    // Murs **et sol** : le sol manquait, alors qu'il occupe la moitié basse du
    // champ de vision et qu'une chaussée au soleil y atteint 4 000 cd/m².
    reverb: Math.min(1, Math.pow(Math.max(0, lux.surfaceLuminance) / REVERB_SATURATION, 0.7)),
    sunlitWalls: lux.sunlitWalls,
    wallLuminance: lux.wallLuminance,
    groundLuminance: lux.groundLuminance,
    glare: glareFactor({ transmission, altitude, azimuth, heading, wet, sky }),
    // Sans faisceau direct, il n'y a plus d'alternance ombre/soleil : sous un
    // ciel couvert, marcher sous les platanes ne fait plus clignoter la lumière.
    flicker: flicker * sky.directShare,
    lux: lux.total,
    /** Éclairement total pondéré mélanopiquement — ce qui compte pour la photophobie. */
    melanopicLux: lux.melanopicTotal,
    groundSunlit: lux.groundSunlit,
    // La gêne nocturne et la part qu'elle occupe. Les deux sont nulles en
    // plein jour : un jeu de données calculé avant l'éclairage public donne
    // donc exactement les mêmes chiffres qu'avant.
    night: nightComponent(veil),
    nightShare: nightShare(altitude),
    veil,
  };
}

/**
 * Indice de gêne lumineuse, de 0 (abrité) à 100 (plein soleil, ciel ouvert).
 *
 * @param {{sun: number, sky: number, bright: number, flicker: number}} c
 * @param {{directSun: number, skyView: number, brightness: number, flicker: number}} weights
 */
export function discomfortIndex(c, weights) {
  const raw =
    weights.directSun * c.sun +
    weights.skyView * c.sky +
    weights.brightness * c.bright +
    (weights.reverb ?? 0) * (c.reverb ?? 0) +
    // `?? 0` et non une valeur par défaut : un jeu de données calculé avant
    // l'ajout de cette composante doit continuer à donner exactement les mêmes
    // chiffres, plutôt que de dériver en silence.
    (weights.glare ?? 0) * (c.glare ?? 0) +
    weights.flicker * (c.flicker ?? 0);

  // Le jour et la nuit ne se comparent pas terme à terme : de jour la gêne est
  // une nappe diffuse, de nuit une poignée de sources vives dans un champ
  // sombre. On ne les additionne donc pas, on passe de l'une à l'autre au
  // crépuscule — moment où les deux coexistent réellement.
  const share = c.nightShare ?? 0;
  const blended = share > 0 ? raw * (1 - share) + (c.night ?? 0) * share : raw;

  return Math.max(0, Math.min(100, Math.round(blended * 100)));
}

// ───────────────────────────────────────────────────────────── la nuit ─────

/**
 * Luminance de voile au-delà de laquelle on considère la gêne maximale, cd/m².
 *
 * Calibré sur la distribution mesurée à Paris — voir le README. Une rue
 * résidentielle éclairée par un candélabre tous les 25 m tourne autour de
 * 0,3 cd/m² ; passer sous un luminaire de boulevard dépasse 3.
 */
export const VEIL_SATURATION = 2.5;

/**
 * Rapport mélanopique d'une source, d'après sa température de couleur.
 *
 * ── Pourquoi ce facteur existe ─────────────────────────────────────────────
 * La photophobie n'est pas une affaire de lumens. Elle passe pour l'essentiel
 * par les cellules ganglionnaires à mélanopsine, dont la sensibilité culmine
 * vers 480 nm — dans le bleu. À flux égal, une LED à 4 000 K est nettement plus
 * douloureuse qu'un sodium à 2 000 K, qui n'émet presque pas de bleu. Ignorer
 * la couleur reviendrait à dire que les deux se valent, ce qui est faux pour
 * exactement le public visé.
 *
 * Les valeurs sont les rapports d'efficacité lumineuse mélanopique (melanopic
 * DER, CIE S 026) de corps noirs aux températures indiquées, interpolés
 * linéairement. C'est une approximation : une LED n'est pas un corps noir, et
 * deux sources de même température de couleur peuvent différer dans le bleu.
 * Faute du spectre réel, c'est le meilleur proxy disponible — et il capte le
 * bon ordre de grandeur, un facteur trois entre 2 000 K et 5 000 K.
 */
const MELANOPIC = [
  [1800, 0.19],
  [2000, 0.24],
  [2700, 0.45],
  [3000, 0.53],
  [3500, 0.63],
  [4000, 0.72],
  [5000, 0.87],
  [6500, 1.1],
];

/**
 * Rapport mélanopique des **phases de lumière du jour** de la CIE (série D).
 *
 * Les corps noirs de la table ci-dessus décrivent bien une lampe, et mal le
 * ciel : au-delà de 5 000 K, la lumière naturelle n'est pas un corps noir mais
 * une phase D, dont le spectre est nettement plus riche dans le bleu à
 * température égale. Prolonger la table des lampadaires jusqu'au ciel revenait à
 * traiter un ciel bleu zénithal comme une LED froide.
 *
 * D65 vaut 1,0 par définition du rapport mélanopique (CIE S 026). Les autres
 * points suivent les phases normalisées : D50 en dessous, D75 et au-delà pour un
 * ciel franc — un ciel bleu profond dépasse 20 000 K et frôle 1,6.
 */
const DAYLIGHT_MELANOPIC = [
  [4000, 0.68],
  [5000, 0.83],
  [5500, 0.9],
  [6500, 1.0],
  [7500, 1.11],
  [10000, 1.29],
  [15000, 1.45],
  [25000, 1.58],
];

/**
 * Rapport mélanopique d'une source de lumière **naturelle**.
 *
 * Distinct de `melanopicRatio`, qui décrit les lampes : à température de couleur
 * égale, une phase de lumière du jour et un corps noir n'ont pas le même spectre,
 * et l'écart porte justement sur le bleu.
 */
export function daylightMelanopicRatio(cct) {
  if (!Number.isFinite(cct)) return 1;
  return interpolate(DAYLIGHT_MELANOPIC, cct);
}

export function melanopicRatio(cct) {
  if (!Number.isFinite(cct)) return 0.53;
  if (cct <= MELANOPIC[0][0]) return MELANOPIC[0][1];
  const last = MELANOPIC.at(-1);
  if (cct >= last[0]) return last[1];
  for (let i = 1; i < MELANOPIC.length; i++) {
    const [k1, v1] = MELANOPIC[i];
    if (cct > k1) continue;
    const [k0, v0] = MELANOPIC[i - 1];
    return v0 + ((v1 - v0) * (cct - k0)) / (k1 - k0);
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
  else if (deg < 70) shape = 1 + (0.5 * (deg - 55)) / 15; // le faisceau porte sur la chaussée
  else if (deg < 85) shape = 1.5 - (1.25 * (deg - 70)) / 15; // défilement
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

  return (10 * illuminanceAtEye * melanopicRatio(lamp.cct)) / (theta * theta);
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
export const CARDINALS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

/**
 * Types de voie retenus, dans un ordre figé.
 *
 * L'ordre fait foi : c'est l'index qui est écrit dans le fichier binaire, et le
 * réordonner invaliderait silencieusement toutes les données déjà calculées.
 */
export const HIGHWAYS = [
  'footway', 'residential', 'service', 'pedestrian', 'path', 'steps', 'cycleway',
  'living_street', 'tertiary', 'secondary', 'primary', 'unclassified', 'track', 'road',
];

/** Nom cardinal d'une direction, pour désigner un trottoir. */
export function cardinalLabel(east, north) {
  const degrees = (Math.atan2(east, north) * 180) / Math.PI;
  return CARDINALS[Math.round(((degrees + 360) % 360) / 45) % 8];
}
