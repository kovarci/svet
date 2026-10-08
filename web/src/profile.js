/**
 * Profils de sensibilité : ce qui gêne, pour qui, et jusqu'où.
 *
 * Le modèle photométrique dit combien de lumière reçoit un trottoir ; il ne
 * dit pas ce qu'une personne en tolère. Ce module ne change donc **rien** à la
 * physique — il règle la manière dont l'indice la compose, et la tolérance de
 * l'itinéraire. Trois étages, séparés à dessein :
 *
 *  1. **Physique personnelle** : le facteur de diffusion `f` (œil clair, iris
 *     absent) amplifie le voile nocturne. C'est de la lumière reçue en plus.
 *  2. **Ce qui gêne** : l'importance `mu` de chaque composante, appliquée
 *     *après* ses saturations, puis les poids sont renormalisés. L'échelle
 *     0-100 et les couleurs de la carte restent comparables d'une personne à
 *     l'autre — `mu` dit *quoi*, pas *combien*.
 *  3. **Jusqu'où** : la sensibilité `s` ne touche pas l'indice. Elle abaisse le
 *     seuil au-delà duquel l'itinéraire se met à payer cher l'exposition.
 *
 * Pourquoi pas « abaisser les seuils de saturation » : toutes les composantes
 * saturent au soleil, donc un seuil abaissé aplatit le contraste entre le quai
 * et la rue à l'ombre — mesuré, l'écart passait de 50 à 27 points, et
 * l'itinéraire d'une personne très sensible choisissait le quai ensoleillé.
 * Plus on se disait sensible, moins on évitait la lumière.
 *
 * Les valeurs des préréglages sont des **hypothèses de conception** tirées de
 * la littérature, pas des prescriptions : seule une étude d'usage pourrait les
 * calibrer. Le niveau de preuve est affiché avec chacune. SVET estime une
 * exposition lumineuse modélisée ; il ne prévient, ne diagnostique ni ne traite
 * rien. Le profil est une donnée de santé : il ne quitte jamais l'appareil.
 *
 * Module pur : ni DOM, ni stockage, ni carte.
 */
import { discomfortIndex } from '@svet/pipeline/model';

/** Bornes de prudence : [min, max]. */
export const BOUNDS = {
  mu: [0, 3],
  s: [0.1, 1],
  uv: [0, 0.6],
  f: [1, 15],
};

/** Indice UV qui sature la composante UV (« très fort », OMS). */
export const UV_REFERENCE = 8;

/** Poids de la pénalité de dépassement dans le coût d'itinéraire. */
export const PENALTY = 3;

/** Exposant reliant la sensibilité au seuil d'indice (celui des composantes). */
const TOLERANCE_EXPONENT = 0.6;

export const COMPONENTS = ['sun', 'sky', 'bright', 'reverb', 'glare', 'flicker', 'night'];

/** Les six composantes de jour, dans l'ordre de leurs poids. */
const WEIGHT_KEYS = {
  sun: 'directSun',
  sky: 'skyView',
  bright: 'brightness',
  reverb: 'reverb',
  glare: 'glare',
  flicker: 'flicker',
};

const ones = () => Object.fromEntries(COMPONENTS.map((key) => [key, 1]));

export const NEUTRAL = Object.freeze({
  mu: Object.freeze(ones()),
  s: 1,
  uv: 0,
  f: 1,
});

/**
 * Importance par composante, depuis les colonnes de la synthèse : soleil,
 * éblouissement, ambiante (ciel et luminosité), parois, scintillement, nuit.
 */
function mu({ sun = 1, glare = 1, ambient = 1, walls = 1, flicker = 1, night = 1, sky, bright }) {
  return {
    sun,
    sky: sky ?? ambient,
    bright: bright ?? ambient,
    reverb: walls,
    glare,
    flicker,
    night,
  };
}

/**
 * Préréglages. `label` dit une expérience vécue, jamais un diagnostic ; `hint`
 * dit ce que le réglage change, en termes de lumière.
 */
export const PRESETS = [
  {
    id: 'migraine',
    label: 'Lumière vive et maux de tête',
    hint: 'Surveille de près le scintillement, les murs éclairés et l’éblouissement.',
    evidence: 'modérée',
    mu: mu({ glare: 1.3, ambient: 1.5, walls: 1.5, flicker: 1.8, night: 1.3 }),
    s: 0.5,
    // Interrupteur « En crise aujourd'hui » : seuils au plus bas, valables un jour.
    crisis: { mu: mu({ glare: 1.5, ambient: 1.5, walls: 1.5, flicker: 2.5, night: 1.5 }), s: 0.25 },
  },
  {
    id: 'commotion',
    label: 'Après un choc à la tête',
    hint: 'Même vigilance qu’au-dessus, avec une tolérance encore plus basse.',
    evidence: 'faible',
    mu: mu({ glare: 1.5, ambient: 1.5, walls: 1.5, flicker: 2, night: 1.5 }),
    s: 0.3,
  },
  {
    id: 'blepharospasme',
    label: 'Paupières qui se ferment à la lumière',
    hint: 'Pèse davantage le soleil direct et l’éblouissement.',
    evidence: 'modérée',
    mu: mu({ sun: 1.2, glare: 1.5, ambient: 1.5, walls: 1.5, flicker: 1.2, night: 1.2 }),
    s: 0.5,
  },
  {
    id: 'surface',
    label: 'Yeux secs, irrités ou inflammés',
    hint: 'Pèse la lumière ambiante et le soleil direct.',
    evidence: 'faible',
    mu: mu({ sun: 1.3, glare: 1.2, ambient: 1.8, walls: 1.3, flicker: 1.5 }),
    s: 0.6,
    uv: 0.05,
  },
  {
    id: 'cones',
    label: 'Je vois mal en pleine lumière',
    hint: 'Pèse fortement toute lumière intense, même diffuse.',
    evidence: 'modérée',
    mu: mu({ sun: 1.5, glare: 1.5, ambient: 2, walls: 2, night: 0.5 }),
    s: 0.1,
  },
  {
    id: 'albinisme',
    label: 'Yeux ou peau très clairs, iris absent',
    hint: 'Lumière très diffusée dans l’œil : le voile nocturne est triplé.',
    evidence: 'modérée',
    mu: mu({ sun: 1.5, glare: 2, ambient: 1.5, walls: 2, night: 2 }),
    s: 0.5,
    uv: 0.15,
    f: 3,
  },
  {
    id: 'diffusion',
    label: 'Éblouissement et halos, surtout la nuit',
    hint: 'Surveille l’éblouissement et les lampadaires.',
    evidence: 'solide',
    mu: mu({ glare: 1.5, walls: 1.2, night: 1.5 }),
    s: 1,
  },
  {
    id: 'scintillement',
    label: 'Scintillement et motifs',
    hint: 'Pèse trois fois plus l’alternance d’ombre et de lumière. Texte de prudence ci-dessous.',
    evidence: 'avis d’experts',
    mu: mu({ flicker: 3 }),
    s: 1,
  },
  {
    id: 'peau-uv',
    label: 'Ma peau réagit au soleil',
    hint: 'Ajoute les UV à l’indice et pèse le soleil direct.',
    evidence: 'modérée',
    mu: mu({ sun: 2, glare: 0.3, sky: 1.5, bright: 0.5, walls: 0.3, flicker: 0, night: 0 }),
    s: 1,
    uv: 0.4,
  },
  {
    id: 'peau-visible',
    label: 'Ma peau réagit même derrière une vitre',
    hint: 'Comme au-dessus, avec le rayonnement visible.',
    evidence: 'modérée',
    mu: mu({ sun: 2, glare: 0.3, ambient: 1.5, flicker: 0, night: 0 }),
    s: 1,
    uv: 0.2,
  },
  {
    id: 'hypersensibilite',
    label: 'Beaucoup de stimulations me fatiguent',
    hint: 'Pèse le scintillement et les alternances brusques.',
    evidence: 'faible',
    mu: mu({ glare: 1.3, ambient: 1.3, walls: 1.3, flicker: 2, night: 1.3 }),
    s: 0.6,
  },
];

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

const isNumber = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, [low, high]) => Math.max(low, Math.min(high, x));

/**
 * Le profil de plusieurs préréglages : pour chaque grandeur, le **pire** — le
 * plus grand `mu`, la plus petite sensibilité, le plus grand facteur —, jamais
 * la moyenne, qui diluerait ce que chacun cherche à éviter.
 */
export function combine(ids = [], { crisis = false } = {}) {
  const chosen = ids
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((preset) => (crisis && preset.crisis ? { ...preset, ...preset.crisis } : preset));
  if (chosen.length === 0) return { mu: { ...NEUTRAL.mu }, s: 1, uv: 0, f: 1 };

  // Le maximum part des préréglages eux-mêmes et non du neutre : un préréglage
  // qui *ignore* une composante (« peau » se moque du scintillement) doit
  // pouvoir l'exprimer quand il est seul.
  const mu = {};
  for (const key of COMPONENTS) mu[key] = Math.max(...chosen.map((preset) => preset.mu[key]));
  return {
    mu,
    s: Math.min(1, ...chosen.map((preset) => preset.s ?? 1)),
    uv: Math.max(0, ...chosen.map((preset) => preset.uv ?? 0)),
    f: Math.max(1, ...chosen.map((preset) => preset.f ?? 1)),
  };
}

/**
 * Le profil effectif d'un état stocké.
 *
 * L'état vient d'un stockage qu'on ne maîtrise pas — navigation privée, version
 * précédente, édition à la main — : toute valeur douteuse est ignorée plutôt
 * que d'empêcher le démarrage, et tout ce qui est retenu est borné.
 *
 * @param {object} [stored] `{presets, crisisDay, mu, sensitivity, uv, diffusion}`
 * @param {string} [today] jour local `AAAA-MM-JJ`, pour l'interrupteur de crise
 */
export function resolve(stored, today) {
  const state = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const ids = Array.isArray(state.presets) ? state.presets.filter((id) => BY_ID.has(id)) : [];
  const crisis = ids.includes('migraine') && state.crisisDay === today && today !== undefined;
  const profile = combine(ids, { crisis });

  if (state.mu && typeof state.mu === 'object') {
    for (const key of COMPONENTS) {
      if (isNumber(state.mu[key])) profile.mu[key] = clamp(state.mu[key], BOUNDS.mu);
    }
  }
  if (isNumber(state.sensitivity) && state.sensitivity > 0) {
    // Pas de « moins sensible que la normale » : aucune donnée ne l'étaye.
    profile.s = clamp(state.sensitivity, BOUNDS.s);
  }
  if (isNumber(state.uv)) profile.uv = clamp(state.uv, BOUNDS.uv);
  if (isNumber(state.diffusion)) profile.f = clamp(state.diffusion, BOUNDS.f);

  // Les préréglages sont écrits dans les bornes ; on borne aussi leur fusion.
  for (const key of COMPONENTS) profile.mu[key] = clamp(profile.mu[key], BOUNDS.mu);
  profile.s = clamp(profile.s, BOUNDS.s);
  profile.uv = clamp(profile.uv, BOUNDS.uv);
  profile.f = clamp(profile.f, BOUNDS.f);
  return profile;
}

export function isNeutral(profile) {
  return (
    profile.s === 1 &&
    profile.uv === 0 &&
    profile.f === 1 &&
    COMPONENTS.every((key) => profile.mu[key] === 1)
  );
}

/**
 * Poids personnels : `w · mu`, renormalisés pour garder une somme de 1, avec la
 * composante UV en plus (poids `uv`, nul par défaut).
 */
export function personalWeights(weights, profile) {
  const out = { ...weights, uv: 0 };
  if (isNeutral(profile)) return out;
  let total = profile.uv;
  for (const [component, key] of Object.entries(WEIGHT_KEYS)) {
    out[key] = (weights[key] ?? 0) * profile.mu[component];
    total += out[key];
  }
  out.uv = profile.uv;
  if (total <= 0) {
    for (const key of Object.values(WEIGHT_KEYS)) out[key] = 0;
    out.uv = 0;
    return out;
  }
  for (const key of [...Object.values(WEIGHT_KEYS), 'uv']) out[key] /= total;
  return out;
}

/**
 * L'indice 0-100 d'une scène pour ce profil.
 *
 * @param {object} c composantes saturées, comme `components()` les rend
 * @param {object} weights poids de la zone
 * @param {object} profile profil résolu
 * @param {number} uvIndex indice UV local (échelle OMS)
 */
export function personalIndex(c, weights, profile, uvIndex = 0) {
  if (isNeutral(profile)) return discomfortIndex(c, weights);
  const adjusted = {
    ...c,
    // Le facteur nocturne s'applique à la composante déjà saturée, avec
    // l'exposant des composantes : 2× plus sensible n'est pas 2× plus de gêne.
    night: Math.min(1, (c.night ?? 0) * Math.pow(profile.mu.night, TOLERANCE_EXPONENT)),
    uvc: Math.min(1, Math.max(0, uvIndex) / UV_REFERENCE),
  };
  return discomfortIndex(adjusted, personalWeights(weights, profile));
}

/**
 * Indice au-delà duquel l'itinéraire se met à payer l'exposition.
 *
 * 100 pour le profil neutre : aucune pénalité, comportement inchangé.
 */
export function tolerance(profile) {
  return 100 * Math.pow(profile.s, TOLERANCE_EXPONENT);
}
