/**
 * Configuration du pipeline SVET.
 *
 * Une « zone » définit l'emprise géographique traitée et la résolution du modèle
 * numérique de surface (MNS). Tout le reste du pipeline en découle.
 */

export const ZONES = {
  // Zone de démo : Marais / Île de la Cité / quais de Seine / Bastille.
  // Contraste maximal entre ruelles médiévales (très ombragées) et quais ouverts.
  marais: {
    label: 'Marais — Île de la Cité — Bastille',
    bbox: [2.33, 48.848, 2.38, 48.87], // [ouest, sud, est, nord]
    res: 1.0, // taille de cellule du MNS, en mètres
  },

  // Cœur de Paris : de Saint-Lazare à la Bastille, en passant par le Louvre et
  // les Halles. C'est la zone de démonstration du calcul d'itinéraire — il faut
  // que départ et arrivée tiennent dans la même emprise.
  centre: {
    label: 'Centre — Saint-Lazare · Louvre · Bastille',
    bbox: [2.308, 48.848, 2.38, 48.883],
    res: 1.5,
    // Emprise deux fois et demie plus grande : on relâche un peu la finesse
    // d'échantillonnage pour que le calcul reste sous le quart d'heure.
    sampleStep: 6,
    svfAzimuths: 24,
  },

  // Paris intra-muros. ~44 M cellules à 2 m : compter ~10-20 min et 2-3 Go de RAM.
  paris: {
    label: 'Paris intra-muros',
    bbox: [2.224, 48.815, 2.47, 48.903],
    res: 2.0,
  },

  // Petite zone pour itérer vite pendant le développement.
  test: {
    label: 'Test — Île de la Cité',
    bbox: [2.345, 48.853, 2.362, 48.86],
    res: 1.0,
  },
};

export const CONFIG = {
  zone: 'marais',

  /** Date simulée (heure locale Europe/Paris). */
  date: '2026-07-31',

  /**
   * Pas de temps de la simulation, en minutes.
   *
   * Passé de 30 à 15. Un front d'ombre de façade traverse un trottoir en
   * quelques minutes ; à trente, l'interpolation linéaire de l'affichage lissait
   * une transition qui est nette, et la question « j'y vais maintenant ou dans
   * vingt minutes » n'avait pas de réponse fiable.
   *
   * Le format binaire n'en souffre pas — le décodeur lit le nombre de pas dans
   * l'en-tête — mais le fichier grossit d'environ deux tiers.
   */
  stepMinutes: 15,

  /** Plage horaire simulée (heure locale). */
  hourStart: 5,
  hourEnd: 22,

  /** Hauteur des yeux du piéton, en mètres. */
  eyeHeight: 1.6,

  /**
   * Plafonds appliqués sous un toit, par degré de couverture.
   *
   * Le modèle numérique de surface rate la moitié des passages couverts : leur
   * toit est trop mince, trop étroit ou trop ajouré pour ressortir d'une maille
   * de 2 m. La moitié des 6 785 tronçons couverts de Paris ressortait avec une
   * ouverture au ciel supérieure à 40 % — donc réputés presque à ciel ouvert.
   *
   * C'est l'erreur la plus coûteuse du modèle, parce qu'elle porte exactement
   * sur ce qu'on veut recommander : galeries, passages, arcades. On plafonne
   * donc plutôt que de faire confiance au relevé.
   *
   * Les valeurs ne sont pas nulles : une galerie garde de la lumière par ses
   * deux bouts et ses verrières. Un couloir de gare, beaucoup moins.
   */
  coverCap: {
    /** `covered=yes` : galerie, arcade, passage — ouvert aux extrémités. */
    1: { svf: 0.18, transmission: 0.12 },
    /** `tunnel=yes` ou `indoor=yes` : souterrain, couloir, gare. */
    2: { svf: 0.05, transmission: 0.02 },
  },

  /**
   * Origine de la géométrie du modèle numérique de surface.
   *
   * `lidar` — LiDAR HD de l'IGN : toitures et houppiers réels. Par défaut.
   * `vector` — emprises extrudées et arbres en dômes. Repli, et point de
   *            comparaison pour mesurer ce que le LiDAR apporte.
   */
  surfaceModel: 'lidar',

  /**
   * Marge de corniche, en mètres : de combien élargir les emprises au sol pour
   * qu'elles recouvrent les toitures vues par le LiDAR. Sans elle, le pourtour
   * de chaque immeuble serait pris pour de la végétation.
   */
  roofOverhang: 2,

  /** Résolution du modèle numérique de terrain téléchargé, en mètres. */
  terrainResolution: 8,

  /** Portée de la recherche de façade pour mesurer la largeur d'une rue, en mètres. */
  facadeSearch: 40,

  /** Vitesse de marche retenue pour les itinéraires, en m/s (≈ 4,9 km/h). */
  walkingSpeed: 1.35,

  /** Temps perdu à une traversée piétonne (attente + traversée), en secondes. */
  crossingPenalty: 25,

  /** Longueur cible d'un tronçon de rue, en mètres. */
  segmentLength: 30,

  /**
   * Écart entre l'axe de la voie et le trottoir, en mètres, par type de voie.
   *
   * À Paris, OpenStreetMap ne cartographie presque jamais les deux trottoirs
   * séparément : une rue est un seul trait. Or le trottoir au nord et celui au
   * sud d'une même rue n'ont rien à voir — c'est souvent la différence entre
   * plein soleil et ombre totale. On déporte donc les points d'échantillonnage
   * de part et d'autre de l'axe pour traiter les deux côtés distinctement.
   *
   * 0 signifie « cette voie est déjà à sa position réelle » : trottoir, piste
   * cyclable, contre-allée, rue piétonne. Les déporter serait un contresens —
   * le tracé OSM y est le cheminement lui-même, pas l'axe d'une chaussée. Les
   * deux côtés se confondent alors, et on ne relève qu'une fois.
   */
  sidewalkOffset: {
    primary: 9,
    primary_link: 9,
    secondary: 8,
    secondary_link: 8,
    tertiary: 6.5,
    tertiary_link: 6.5,
    residential: 5,
    unclassified: 5,
    living_street: 4,
    road: 5,
    footway: 0,
    path: 0,
    steps: 0,
    pedestrian: 0,
    cycleway: 0,
    track: 0,
    service: 0,
    _default: 5,
  },

  /** Pas d'échantillonnage le long d'un tronçon, en mètres. */
  sampleStep: 4,

  /**
   * Portée maximale du lancer de rayon solaire, en mètres.
   *
   * Calée sur `SHADOW_MARGIN_M` dans `build.js` : les données de bâti sont
   * téléchargées 450 m au-delà de l'emprise, et s'arrêter à 400 m revenait à
   * ignorer les cinquante derniers mètres de bâti qu'on avait déjà payés. Une
   * ombre de 450 m correspond à un immeuble de 40 m au solstice d'hiver.
   *
   * Le rayon s'arrête de toute façon dès qu'il dépasse le point le plus haut du
   * modèle de surface : cette borne ne mord qu'au soleil rasant.
   */
  maxRayDistance: 450,

  /** Nombre d'azimuts pour le calcul du facteur de vue du ciel (SVF). */
  svfAzimuths: 32,

  /** Portée du balayage d'horizon pour le SVF, en mètres. */
  svfRadius: 150,

  /**
   * Réflectance des façades. Paris est une ville de calcaire lutétien, dont
   * l'albédo tourne autour de 0,45 — bien plus clair que les 0,25 qu'on
   * retenait jusqu'ici pour un mélange vague de murs et de chaussée.
   */
  albedo: 0.45,

  /**
   * Réflectance du sol de rue — nettement plus sombre que les façades.
   *
   * L'asphalte d'une chaussée tourne autour de 0,10, un trottoir de pierre ou de
   * béton entre 0,25 et 0,35 ; 0,18 est le mélange courant. Distinguer les deux
   * albédos était nécessaire pour ajouter le sol au bilan : lui prêter les 0,45
   * du calcaire l'aurait rendu deux fois trop lumineux.
   */
  groundAlbedo: 0.18,

  /**
   * Nombre de secteurs du profil d'horizon conservé par tronçon.
   *
   * Porté de 16 à 32. Seize suffisaient tant que le profil ne servait qu'à la
   * réverbération, qui dépend de la hauteur *moyenne* des murs dans une
   * direction. Il porte désormais aussi l'intégration du ciel anisotrope, et un
   * secteur de 22,5° diluait un immeuble haut isolé sur toute sa largeur —
   * lissant précisément les contrastes qu'on cherche à voir. Trente-deux
   * secteurs les ramènent à 11,25°.
   *
   * Trente-deux octets par trottoir, contre un lancer de rayons par pas de temps
   * si on voulait recalculer la chose à l'affichage.
   */
  horizonBins: 32,

  /** Hauteur par défaut d'un bâtiment sans attribut de hauteur, en mètres. */
  defaultBuildingHeight: 15,

  /** Coefficients d'extinction du feuillage (Beer-Lambert), en m⁻¹. */
  canopy: {
    kLeafOn: 0.265, // ~12 % de transmission sur 8 m de houppier
    kLeafOff: 0.075, // ~55 % de transmission sur 8 m, branches nues
    kConifer: 0.3, // persistant, dense toute l'année
    leafOnStart: '04-15',
    leafOnEnd: '11-05',
  },

  /**
   * Pondération de l'indice de gêne lumineuse (doit sommer à 1).
   * Voir README pour la justification de chaque terme.
   */
  weights: {
    directSun: 0.34, // soleil direct sur le piéton
    skyView: 0.18, // ouverture au ciel (luminance de fond, éblouissement diffus)
    brightness: 0.16, // éclairement reçu du ciel et du soleil
    reverb: 0.14, // ce que renvoient les façades éclairées, à hauteur des yeux
    glare: 0.1, // soleil bas dans l'axe du regard — dépend du sens de marche
    flicker: 0.08, // alternance ombre/soleil le long du trajet
  },

  /** Éclairement de référence pour normaliser la composante « brightness », en lux. */
  luxReference: 90000,
};

export function resolveZone(name) {
  const zone = ZONES[name];
  if (!zone) {
    throw new Error(
      `Zone inconnue : "${name}". Zones disponibles : ${Object.keys(ZONES).join(', ')}`,
    );
  }
  const { label, bbox, res, ...overrides } = zone;
  return { key: name, label, bbox, res, overrides };
}
