/**
 * Formulations parlées des curseurs, pour `aria-valuetext`.
 *
 * Sans elles, un lecteur d'écran annonce la valeur brute — « 510 » pour 8 h 30.
 * Fonctions pures : elles s'éprouvent sans navigateur.
 */

/** « 8 h 30 », « midi », « minuit » — l'heure comme on la dit. */
export function spokenClock(minutes) {
  const total = Math.round(minutes) % 1440;
  if (total === 0) return 'minuit';
  if (total === 720) return 'midi';
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

/** Position du curseur « rapide ↔ abrité », de 0 à 60. */
export function alphaLabel(value) {
  const v = Math.round(Number(value));
  if (v <= 0) return 'le plus rapide, sans égard à la lumière';
  if (v >= 60) return 'le moins de lumière, quitte à allonger le trajet';
  return `compromis ${v} sur 60`;
}
