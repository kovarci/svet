/**
 * Annonces vocales et retour haptique pendant le guidage.
 *
 * Ce n'est pas un confort. Le public visé souffre de la lumière : lui demander
 * de fixer un écran de téléphone en plein soleil est une contradiction du même
 * ordre qu'une interface blanche. Pouvoir marcher **téléphone dans la poche**
 * est une fonction centrale, pas une option.
 *
 * `SpeechSynthesis` est natif partout et gratuit ; `navigator.vibrate` couvre
 * Android. Sur iOS la vibration n'existe pas depuis le web, et la synthèse
 * vocale exige un premier geste de l'utilisateur — d'où `unlock()`.
 */

/** Distances auxquelles une manœuvre est annoncée, en mètres. */
const ANNOUNCE_AT = [180, 60, 18];

export function createVoice() {
  const synth = window.speechSynthesis;
  const supported = Boolean(synth);
  let enabled = supported;
  let voice = null;
  /** Manœuvres déjà annoncées : clé « indice:palier ». */
  const said = new Set();

  function pickVoice() {
    if (!supported) return;
    const voices = synth.getVoices();
    voice =
      voices.find((v) => v.lang?.startsWith('fr') && v.localService) ??
      voices.find((v) => v.lang?.startsWith('fr')) ??
      null;
  }
  if (supported) {
    pickVoice();
    synth.addEventListener?.('voiceschanged', pickVoice);
  }

  /**
   * iOS et Chrome mobile refusent de parler tant que l'utilisateur n'a pas
   * interagi. On consomme donc le clic qui démarre le guidage pour émettre un
   * énoncé vide, ce qui débloque la suite.
   */
  function unlock() {
    if (!supported) return;
    const silent = new SpeechSynthesisUtterance('');
    silent.volume = 0;
    synth.speak(silent);
  }

  function speak(text, { interrupt = false } = {}) {
    if (!supported || !enabled || !text) return;
    if (interrupt) synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'fr-FR';
    if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    synth.speak(utterance);
  }

  function vibrate(pattern) {
    if (enabled && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  }

  /**
   * Annonce une manœuvre quand on franchit un palier de distance.
   *
   * Chaque palier n'est dit qu'une fois : sans cette mémoire, une position
   * rafraîchie chaque seconde répéterait la même phrase indéfiniment.
   */
  function announce(instruction, remaining, phrase) {
    const step = ANNOUNCE_AT.find((threshold) => remaining <= threshold);
    if (step === undefined) return false;

    const key = `${instruction.index}:${step}`;
    if (said.has(key)) return false;
    // On marque aussi les paliers plus lointains : arriver directement à 18 m
    // ne doit pas déclencher ensuite l'annonce des 60 m.
    for (const threshold of ANNOUNCE_AT) {
      if (threshold >= step) said.add(`${instruction.index}:${threshold}`);
    }

    speak(phrase, { interrupt: step === ANNOUNCE_AT.at(-1) });
    vibrate(step === ANNOUNCE_AT.at(-1) ? [90, 60, 90] : 60);
    return true;
  }

  return {
    supported,
    unlock,
    speak,
    vibrate,
    announce,
    reset: () => said.clear(),
    setEnabled(value) {
      enabled = value;
      if (!value && supported) synth.cancel();
    },
    get enabled() {
      return enabled;
    },
  };
}

/**
 * Met une manœuvre en phrase.
 *
 * On dit la distance avant l'action — « dans cinquante mètres, tournez à
 * droite » — parce qu'on ne peut pas anticiper un ordre qu'on entend après
 * coup. C'est la seule règle qui compte pour un guidage écouté sans regarder.
 */
export function phraseFor(instruction, remaining, { label, name, side }) {
  // Le départ et l'arrivée n'ont pas de distance : « dans deux cents mètres,
  // départ » ne veut rien dire.
  if (instruction.type === 'arrive') return 'Vous êtes arrivé.';
  if (instruction.type === 'depart') return 'Départ.';

  const distance = remaining <= 20 ? '' : `Dans ${roundDistance(remaining)}, `;
  const action = distance ? lowerFirst(label) : label;
  // Virgule et non tiret cadratin : le tiret est soit ignoré, soit prononcé
  // « tiret » selon le moteur de synthèse.
  const street = name ? (instruction.type === 'crossing' ? ` vers ${name}` : `, ${name}`) : '';
  const sidewalk = side ? `, trottoir ${side}` : '';

  return `${distance}${action}${street}${sidewalk}.`;
}

/** Les mètres s'arrondissent à la dizaine : personne n'entend « 47 mètres ». */
function roundDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} kilomètres`;
  const rounded = meters >= 100 ? Math.round(meters / 50) * 50 : Math.round(meters / 10) * 10;
  return `${rounded} mètres`;
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
