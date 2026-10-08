import {
  components,
  discomfortIndex,
  localUV,
  skyConditions,
  wetnessFromRain,
} from '@svet/pipeline/model';
import {
  applyRefraction,
  dayOfYear,
  localToUTC,
  precipitableWater,
  sunPosition,
  DEG,
} from '@svet/pipeline/sun';

import { CLEAR_SKY } from './weather.js';

/**
 * L'exposition d'un trottoir à un instant : le soleil, la météo, le modèle.
 *
 * C'est ici que les relevés précalculés rencontrent l'heure affichée et la
 * prévision du jour. La carte, le panneau de détail, sa courbe et le calcul
 * d'itinéraire passent tous par ces fonctions : ils lisent donc la même valeur
 * pour le même trottoir à la même minute.
 *
 * Le module ne connaît ni la carte ni le DOM. Ce qu'il lit — métadonnées de la
 * zone, relevés, prévision, mode de lecture — lui est donné par des fonctions,
 * interrogées à chaque appel : il suit ainsi l'état de l'application sans en
 * dépendre, et s'éprouve sous Node sur une zone dessinée à la main. C'est la
 * partie du navigateur où une erreur se voit le moins — une interpolation
 * décalée donne des couleurs plausibles et fausses — et c'était la seule
 * qu'aucun test n'atteignait.
 *
 * Une fabrique plutôt que des fonctions libres : le cache de contextes
 * appartient à un état, celui de l'application ou celui d'un test, et deux
 * évaluateurs n'ont pas à se le partager.
 */

const PARIS_LAT = 48.8566;
const PARIS_LON = 2.3522;

/**
 * Transmission et scintillement à un instant quelconque, interpolés entre les
 * deux pas de temps qui l'encadrent.
 */
export function sampleSide(entry, cursor) {
  const { i, j, t } = cursor;
  return {
    transmission: (entry.sun[i] + (entry.sun[j] - entry.sun[i]) * t) / 100,
    flicker: (entry.flicker[i] + (entry.flicker[j] - entry.flicker[i]) * t) / 100,
  };
}

/**
 * Indice UV approché quand aucune prévision n'est disponible : il suit de près
 * le sinus de la hauteur du soleil, avec un maximum d'environ 8 à Paris en été.
 */
export function uvFallback(altitude) {
  if (altitude <= 0) return 0;
  return 8.5 * Math.pow(Math.sin(altitude), 1.4);
}

/**
 * @param {object} sources ce que l'évaluateur lit, au moment où il le lit
 * @param {() => object} sources.getMeta métadonnées de la zone ou de la région
 * @param {() => object} sources.getData relevés : `segmentAt` et `sideAt`
 * @param {() => object|null} sources.getForecast prévision, ou `null`
 * @param {() => string} sources.getSkyMode `forecast` ou `clear`
 * @param {() => string|null} sources.getDay jour de prévision affiché
 * @param {() => string} sources.getMode mode de lecture de la carte
 */
export function createEvaluator({ getMeta, getData, getForecast, getSkyMode, getDay, getMode }) {
  /**
   * Position du soleil à l'instant exact demandé.
   *
   * Le pipeline échantillonne toutes les demi-heures, mais rien n'oblige
   * l'affichage à s'y tenir : la position du soleil est une formule, pas une
   * donnée. Le voile de lumière tourne donc de façon parfaitement continue,
   * sans les à-coups qu'on voyait en sautant de 10 h 30 à 11 h.
   */
  function sunAt(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes - hour * 60;
    const instant = localToUTC(getMeta().date, hour, minute);
    const raw = sunPosition(instant, PARIS_LAT, PARIS_LON);
    return { altitude: applyRefraction(raw.altitude), azimuth: raw.azimuth };
  }

  /** Position dans la série précalculée, et poids d'interpolation entre deux pas. */
  function seriesCursor(minutes) {
    const times = getMeta().times;
    const first = times[0].minutes;
    const stepMinutes = times[1].minutes - first;
    const raw = (minutes - first) / stepMinutes;
    const i = Math.max(0, Math.min(times.length - 1, Math.floor(raw)));
    const j = Math.min(times.length - 1, i + 1);
    return { i, j, t: Math.max(0, Math.min(1, raw - i)) };
  }

  /**
   * Prévision du jour sélectionné, ou `null` s'il n'y en a pas.
   *
   * Seule la **météo** change d'un jour à l'autre : les séries d'ombrage restent
   * celles de la date du calcul. Sur trois jours la dérive solaire vaut moins de
   * 3 % de longueur d'ombre, sous l'incertitude sur la hauteur des bâtiments —
   * c'est ce qui borne l'horizon proposé.
   */
  function forecastSeries() {
    const forecast = getForecast();
    if (getSkyMode() !== 'forecast' || !forecast) return null;
    return forecast.series[getDay()] ?? forecast.series[forecast.dates[0]] ?? null;
  }

  function weatherAt(minutes) {
    const series = forecastSeries();
    if (!series) return CLEAR_SKY;
    const { i, j, t } = seriesCursor(minutes);
    const a = series[i] ?? CLEAR_SKY;
    const b = series[j] ?? a;
    const mix = (x, y) => x + (y - x) * t;

    return {
      cloud: mix(a.cloud, b.cloud),
      uv: mix(a.uv, b.uv),
      rain: mix(a.rain ?? 0, b.rain ?? 0),
      // Le point de rosée donne l'eau précipitable, dont dépendent les
      // efficacités lumineuses de Perez — à défaut, 2 cm.
      dewPoint:
        Number.isFinite(a.dewPoint) && Number.isFinite(b.dewPoint)
          ? mix(a.dewPoint, b.dewPoint)
          : null,
      // Les flux modélisés doivent traverser cette interpolation comme le reste :
      // les oublier ici ferait silencieusement retomber tout le modèle sur la
      // déduction par nébulosité, celle qui se trompe de 27 klx.
      irradiance: a.irradiance
        ? {
            beam: mix(a.irradiance.beam, b.irradiance?.beam ?? a.irradiance.beam),
            diffuse: mix(a.irradiance.diffuse, b.irradiance?.diffuse ?? a.irradiance.diffuse),
          }
        : null,
      source: 'météo',
    };
  }

  /**
   * Contexte de calcul pour un instant : tout ce qui ne dépend pas du lieu.
   *
   * Mémorisé à la minute près, et ce n'est pas une micro-optimisation : le calcul
   * d'itinéraire évalue des dizaines de milliers d'arêtes, et la conversion en
   * heure locale passe par `Intl.DateTimeFormat`, qui coûte des microsecondes.
   * Sans ce cache, une recherche prendrait plusieurs secondes.
   */
  const contextCache = new Map();

  function contextAt(minutes) {
    const key = Math.round(minutes);
    const cached = contextCache.get(key);
    if (cached) return cached;

    const sun = sunAt(key);
    const weather = weatherAt(key);
    const context = {
      minutes: key,
      sun,
      weather,
      // L'azimut construit la distribution de luminance du ciel : sans lui, le
      // modèle retombe sur un ciel uniforme. Elle est bâtie une fois par minute,
      // ici, et non une fois par trottoir — c'est ce qui la rend gratuite.
      // Le dernier argument doit suivre le nombre de secteurs du profil d'horizon
      // stocké : un décalage ferait retomber le modèle sur un ciel isotrope, sans
      // erreur ni message.
      sky: skyConditions(
        sun.altitude,
        weather.cloud,
        weather.irradiance,
        sun.azimuth,
        getMeta().horizonBins ?? 16,
        // La date règle l'excentricité de l'orbite et le trouble mensuel ; le
        // point de rosée, l'efficacité lumineuse.
        {
          dayOfYear: dayOfYear(getMeta().date),
          precipitableWater: precipitableWater(weather.dewPoint),
        },
      ),
    };
    contextCache.set(key, context);
    return context;
  }

  /** À appeler dès qu'un ingrédient du contexte change : date, météo, zone. */
  function invalidateContexts() {
    contextCache.clear();
  }

  /**
   * Relevés d'un trottoir : les vues binaires, plus les attributs du tronçon.
   *
   * Rien n'est copié — `sun`, `flicker` et `horizon` sont des fenêtres sur le
   * tampon reçu. Sur Paris entier, les matérialiser en objets ferait quarante
   * millions d'allocations.
   */
  function sideOf(id, right) {
    const data = getData();
    const segment = data.segmentAt(id);
    const series = data.sideAt(id, right);
    // En région, la géométrie arrive en tuiles et les relevés par cellules : une
    // rue peut être dessinée avant que son binaire soit là. On rend `null` plutôt
    // qu'un relevé à zéro, qui se lirait « aucune gêne » — le mensonge exact
    // qu'il ne faut pas faire à quelqu'un qui choisit son trajet.
    if (!segment || !series) return null;
    return {
      ...series,
      side: right ? segment.rSide : segment.lSide,
      svf: right ? segment.rSvf : segment.lSvf,
      canopy: right ? segment.rCanopy : segment.lCanopy,
      veil: right ? segment.rVeil : segment.lVeil,
      work: right ? segment.rWork : segment.lWork,
    };
  }

  function evaluateSide(entry, context, heading) {
    const meta = getMeta();
    const cursor = seriesCursor(context.minutes);
    const { transmission, flicker } = sampleSide(entry, cursor);
    const svf = entry.svf / 100;
    const c = components({
      transmission,
      svf,
      altitude: context.sun.altitude,
      azimuth: context.sun.azimuth,
      heading,
      horizon: entry.horizon,
      flicker,
      albedo: meta.albedo,
      // Absent des jeux calculés avant l'ajout du terme de sol : le modèle
      // retombe alors sur sa valeur par défaut, sans recalcul nécessaire.
      groundAlbedo: meta.groundAlbedo,
      // Chaussée mouillée : elle renvoie le soleil bas en miroir.
      wet: wetnessFromRain(context.weather.rain),
      luxReference: meta.luxReference,
      veil: entry.veil,
      sky: context.sky,
    });
    return {
      ...c,
      transmission,
      svf,
      index: discomfortIndex(c, meta.weights),
      // Le partage direct/diffus de l'UV dépend de la hauteur du soleil et de la
      // couverture : à 10° de hauteur, l'essentiel de l'UV est déjà diffusé, et un
      // immeuble n'en protège presque plus.
      uv: localUV(
        context.weather.uv ?? uvFallback(context.sun.altitude),
        transmission,
        svf,
        context.sun.altitude * DEG,
        context.sky.directShare,
      ),
      side: entry.side,
      canopy: entry.canopy,
      // Part du trottoir barrée par un chantier. Elle ne rentre pas dans
      // l'indice — un trottoir barré n'est pas plus lumineux, il est
      // impraticable — mais elle pèse sur l'itinéraire et s'affiche au clic.
      work: entry.work ?? 0,
    };
  }

  /** Valeur cartographiée pour un trottoir, selon le mode de lecture. */
  function displayValue(evaluated) {
    switch (getMode()) {
      case 'sun':
        return evaluated.sun * 100;
      case 'svf':
        return evaluated.svf * 100;
      case 'glare':
        return evaluated.glare * 100;
      case 'flicker':
        return evaluated.flicker * 100;
      case 'reverb':
        return evaluated.reverb * 100;
      // L'éblouissement des lampadaires se lit à toute heure, indépendamment de
      // la part qu'il occupe dans l'indice : c'est une propriété du lieu, et on
      // veut pouvoir la consulter en plein jour pour préparer un trajet du soir.
      case 'night':
        return evaluated.night * 100;
      case 'uv':
        return evaluated.uv;
      default:
        return evaluated.index;
    }
  }

  /**
   * État d'un tronçon à un instant : c'est ce que le calcul d'itinéraire
   * interroge, des milliers de fois par recherche.
   *
   * On retient le trottoir le moins exposé — un piéton choisit son côté.
   */
  function evaluateSegment(id, minutes, heading) {
    const context = contextAt(minutes);
    const segment = getData().segmentAt(id);
    const leftSide = sideOf(id, false);
    const rightSide = sideOf(id, true);
    // Le graphe ne contient que des arêtes de cellules chargées : ce cas ne
    // devrait pas se produire. S'il se produit — cellule libérée en cours de
    // recherche — on rend un coût neutre, qui laisse le tronçon franchissable au
    // temps de marche seul. Le bloquer inventerait un obstacle ; le dire abrité
    // inventerait un abri.
    if (!segment || !leftSide || !rightSide) {
      return { index: 50, sun: 0, side: null, work: 0, twoSided: false, name: null };
    }
    const left = evaluateSide(leftSide, context, heading);
    const right = evaluateSide(rightSide, context, heading);
    // Le choix du côté tient compte du chantier avant l'exposition : un trottoir
    // barré n'est pas une gêne lumineuse, c'est un trottoir où l'on ne passe pas.
    // On ajoute donc l'emprise à l'indice pour comparer les deux côtés, mais on
    // rend l'indice réel — sans quoi la carte annoncerait de la lumière là où il
    // n'y a qu'une palissade.
    const penalised = (side) => side.index + side.work;
    const best = penalised(left) <= penalised(right) ? left : right;
    return {
      index: best.index,
      sun: best.sun * 100,
      side: best.side,
      work: best.work,
      twoSided: segment.twoSided,
      name: segment.name,
    };
  }

  return {
    sunAt,
    seriesCursor,
    forecastSeries,
    weatherAt,
    contextAt,
    invalidateContexts,
    sideOf,
    evaluateSide,
    displayValue,
    evaluateSegment,
  };
}
