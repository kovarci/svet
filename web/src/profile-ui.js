/**
 * L'écran « Mon profil de lumière » : choisir ce qui gêne, et jusqu'où.
 *
 * Le calcul est dans `profile.js` ; ici, on branche l'écran sur le stockage
 * local, sur la carte et sur l'itinéraire. Trois blocs : des préréglages
 * nommés par une expérience vécue (jamais par un diagnostic), une sensibilité
 * en cinq crans, et des curseurs fins — repliés — pour qui veut préciser.
 *
 * Le profil est une donnée de santé : il reste dans ce navigateur (`prefs.js`),
 * n'entre dans aucun lien partagé, et s'efface en un geste. Les textes restent
 * descriptifs : SVET n'allègue aucune finalité médicale.
 */
import { localDate } from '@svet/pipeline/sun';

import { dom, fail, state } from './app.js';
import { profileStore } from './prefs.js';
import { PRESETS, BOUNDS, personalWeights, resolve, isNeutral } from './profile.js';
import { refreshLayers } from './layers.js';
import { setOfflinePanel } from './offline-ui.js';
import { computeRoute, setRoutePanel } from './route.js';

/** Cinq crans de sensibilité, du neutre au plus bas. */
const SENSITIVITY = [
  { s: 1, text: 'comme tout le monde' },
  { s: 0.6, text: 'un peu plus' },
  { s: 0.4, text: 'nettement plus' },
  { s: 0.25, text: 'beaucoup plus' },
  { s: 0.1, text: 'extrêmement' },
];

/**
 * Curseurs fins. « Ciel et lumière ambiante » règle deux composantes à la fois
 * (ouverture au ciel et luminosité) : les séparer n'a de sens pour personne.
 */
const SLIDERS = [
  { id: 'sun', keys: ['sun'], label: 'Soleil direct sur moi' },
  { id: 'glare', keys: ['glare'], label: 'Soleil bas dans les yeux' },
  { id: 'ambient', keys: ['sky', 'bright'], label: 'Ciel et lumière ambiante' },
  { id: 'reverb', keys: ['reverb'], label: 'Murs et sol éclairés' },
  { id: 'flicker', keys: ['flicker'], label: 'Ombre et lumière qui clignotent' },
  { id: 'night', keys: ['night'], label: 'Lampadaires la nuit' },
];

const MU_STEP = 0.25;

/** Le texte d'une importance, pour les lecteurs d'écran autant que pour la vue. */
export function importanceText(mu) {
  if (mu === 0) return 'ignoré';
  if (mu < 1) return 'réduit';
  if (mu === 1) return 'comme par défaut';
  if (mu <= 1.5) return 'élevé';
  if (mu <= 2.25) return 'très élevé';
  return 'maximal';
}

/** Écriture de l'état stocké ; vrai si le navigateur l'a gardé. */
let stored = {};
let persisted = true;

/** Applique l'état stocké : profil résolu, carte, itinéraire. */
function apply({ repaint = true } = {}) {
  state.profile = resolve(stored, localDate());
  dom.profileToggle.classList.toggle('is-on', !isNeutral(state.profile));
  if (!repaint) return;
  refreshLayers();
  if (state.route) computeRoute().catch(fail);
}

function save() {
  persisted = Object.keys(stored).length === 0 ? profileStore.clear() : profileStore.write(stored);
}

/** Au démarrage : relit le profil, sans toucher à la carte (pas encore là). */
export function loadProfile() {
  stored = profileStore.read();
  apply({ repaint: false });
}

export function setProfilePanel(open) {
  if (!open && dom.profile.contains(document.activeElement)) dom.profileToggle.focus();
  if (open && !dom.route.hidden) setRoutePanel(false);
  if (open && !dom.offline.hidden) setOfflinePanel(false);
  dom.profile.hidden = !open;
  dom.profileToggle.classList.toggle('is-open', open);
  dom.profileToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    render();
    dom.profileClose.focus();
  }
}

export function bindProfile({ onOpen = () => {} } = {}) {
  dom.profileToggle.addEventListener('click', () => {
    setProfilePanel(dom.profile.hidden);
    onOpen();
  });
  dom.profileClose.addEventListener('click', () => setProfilePanel(false));
}

// ------------------------------------------------------------------ rendu

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function presetCard(preset) {
  const checked = (stored.presets ?? []).includes(preset.id);
  const input = element('input', { type: 'checkbox', id: `preset-${preset.id}`, checked });
  input.addEventListener('change', () => {
    const chosen = new Set(stored.presets ?? []);
    if (input.checked) chosen.add(preset.id);
    else chosen.delete(preset.id);
    stored.presets = [...chosen];
    if (stored.presets.length === 0) delete stored.presets;
    if (!chosen.has('migraine')) delete stored.crisisDay;
    // Un nouveau préréglage repart de ses valeurs : les réglages fins faits sur
    // le précédent n'ont plus de raison de s'y superposer.
    delete stored.mu;
    delete stored.sensitivity;
    delete stored.uv;
    save();
    apply();
    render();
  });
  return element(
    'div',
    { className: 'preset' },
    input,
    element(
      'label',
      { htmlFor: input.id },
      element('strong', {}, preset.label),
      element('span', { className: 'muted' }, preset.hint),
      element('span', { className: 'evidence' }, `Preuves : ${preset.evidence}`),
    ),
  );
}

function crisisSwitch() {
  const today = localDate();
  const on = stored.crisisDay === today;
  const input = element('input', { type: 'checkbox', id: 'profile-crisis', checked: on });
  input.addEventListener('change', () => {
    if (input.checked) stored.crisisDay = today;
    else delete stored.crisisDay;
    save();
    apply();
    render();
  });
  return element(
    'div',
    { className: 'preset crisis' },
    input,
    element(
      'label',
      { htmlFor: input.id },
      element('strong', {}, 'En crise aujourd’hui'),
      element('span', { className: 'muted' }, 'Seuils au plus bas jusqu’à minuit, puis retour.'),
    ),
  );
}

function slider({ id, label, min, max, step, value, text, onChange }) {
  const input = element('input', { type: 'range', id, min, max, step, value });
  const readout = element('span', { className: 'slider-text muted' }, text(Number(value)));
  const refresh = () => {
    const words = text(Number(input.value));
    readout.textContent = words;
    // Une valeur annoncée en toutes lettres, pas un nombre sans unité.
    input.setAttribute('aria-valuetext', words);
  };
  input.setAttribute('aria-valuetext', text(Number(value)));
  input.addEventListener('input', refresh);
  input.addEventListener('change', () => onChange(Number(input.value)));
  return element(
    'div',
    { className: 'profile-slider' },
    element('label', { htmlFor: id }, label),
    input,
    readout,
  );
}

function sensitivityIndex(s) {
  let best = 0;
  SENSITIVITY.forEach((notch, i) => {
    if (Math.abs(notch.s - s) < Math.abs(SENSITIVITY[best].s - s)) best = i;
  });
  return best;
}

function fineTuning() {
  const profile = state.profile;
  const details = element('details', { className: 'profile-fine' });
  details.append(element('summary', {}, 'Réglages fins'));

  details.append(
    slider({
      id: 'profile-sensitivity',
      label: 'Plus sensible que les autres à la lumière',
      min: 0,
      max: SENSITIVITY.length - 1,
      step: 1,
      value: sensitivityIndex(profile.s),
      text: (i) => SENSITIVITY[i].text,
      onChange: (i) => {
        stored.sensitivity = SENSITIVITY[i].s;
        save();
        apply();
        render();
      },
    }),
  );

  for (const spec of SLIDERS) {
    details.append(
      slider({
        id: `profile-${spec.id}`,
        label: spec.label,
        min: BOUNDS.mu[0],
        max: BOUNDS.mu[1],
        step: MU_STEP,
        value: profile.mu[spec.keys[0]],
        text: importanceText,
        onChange: (value) => {
          stored.mu = { ...stored.mu };
          for (const key of spec.keys) stored.mu[key] = value;
          save();
          apply();
          render();
        },
      }),
    );
  }

  details.append(
    slider({
      id: 'profile-uv',
      label: 'UV (peau)',
      min: BOUNDS.uv[0],
      max: BOUNDS.uv[1],
      step: 0.05,
      value: profile.uv,
      text: (value) => (value === 0 ? 'hors de l’indice' : 'pris en compte'),
      onChange: (value) => {
        stored.uv = value;
        save();
        apply();
        render();
      },
    }),
  );

  details.append(
    element(
      'button',
      {
        type: 'button',
        className: 'toggle',
        onclick: () => {
          delete stored.mu;
          delete stored.sensitivity;
          delete stored.uv;
          save();
          apply();
          render();
        },
      },
      'Revenir aux préréglages',
    ),
  );
  return details;
}

/** Une seule composante qui fait plus de 60 % de l'indice : on le dit. */
function dominanceWarning() {
  const weights = personalWeights(state.meta?.weights ?? {}, state.profile);
  const shares = ['directSun', 'skyView', 'brightness', 'reverb', 'glare', 'flicker', 'uv'].map(
    (key) => weights[key] ?? 0,
  );
  if (Math.max(...shares) <= 0.6) return null;
  return element(
    'p',
    { className: 'warn', role: 'status' },
    'Une seule composante pèse plus de 60 % de l’indice : les autres comptent à peine. Vérifiez ce choix.',
  );
}

function render() {
  const body = dom.profileBody;
  body.replaceChildren();

  body.append(
    element(
      'p',
      { className: 'muted' },
      'SVET estime l’exposition à la lumière d’après un modèle. Il ne diagnostique, ne soigne et ne prévient rien. ',
      'Ces réglages sont des points de départ tirés de la littérature : ajustez-les selon votre ressenti.',
    ),
    element(
      'p',
      { className: 'muted' },
      'Ce profil reste sur cet appareil. Il n’est ni envoyé, ni inclus dans les liens partagés.',
    ),
  );
  if (!persisted) {
    body.append(
      element(
        'p',
        { className: 'warn', role: 'status' },
        'Ce navigateur refuse de garder ce profil (navigation privée ?) : il sera perdu à la fermeture.',
      ),
    );
  }

  const group = element('fieldset', { className: 'presets' });
  group.append(element('legend', {}, 'Ce qui me gêne'));
  for (const preset of PRESETS) {
    group.append(presetCard(preset));
    if (preset.id === 'migraine' && (stored.presets ?? []).includes('migraine')) {
      group.append(crisisSwitch());
    }
  }
  body.append(group);

  if ((stored.presets ?? []).includes('scintillement')) {
    body.append(
      element(
        'p',
        { className: 'warn' },
        'Cet outil n’est pas conçu pour protéger d’un déclencheur de crise. Il ne remplace pas l’avis de votre médecin.',
      ),
    );
  }

  body.append(fineTuning());
  const warning = dominanceWarning();
  if (warning) body.append(warning);

  body.append(
    element(
      'button',
      {
        type: 'button',
        className: 'toggle',
        onclick: () => {
          stored = {};
          save();
          apply();
          render();
        },
      },
      'Effacer mon profil',
    ),
    element(
      'details',
      { className: 'profile-flags' },
      element('summary', {}, 'Quand demander un avis médical'),
      element(
        'p',
        { className: 'muted' },
        'Œil rouge et douloureux avec gêne à la lumière, baisse brutale de la vue, gêne nouvelle après un choc à la tête qui s’aggrave, crise d’épilepsie : demandez un avis médical. Un modèle de lumière ne le remplace pas.',
      ),
    ),
  );
}
