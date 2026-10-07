/**
 * Réglages retenus d'une visite à l'autre.
 *
 * Tout passe par ce guichet, et tout y est enveloppé d'un `try`. Ce n'est pas
 * de la prudence de principe : en navigation privée Safari, et sous une
 * politique qui bloque les cookies du site, la simple lecture de
 * `localStorage` lève une `SecurityError`. Elle survenait au démarrage, faisait
 * échouer l'initialisation entière, et l'application affichait « lancez d'abord
 * le calcul » — un conseil parfaitement inutile pour quelqu'un dont les données
 * étaient là.
 *
 * Ce qu'on retient est ce qui relève de la personne plutôt que du moment : la
 * pénombre dont elle a besoin, sa zone, sa façon de lire la carte. Pas l'heure
 * ni le trajet, qui appartiennent à la fois où on les a choisis.
 */
const PREFS_KEY = 'svet.prefs';

export const prefs = {
  read() {
    try {
      const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
      // Reprise de l'ancien réglage isolé, écrit par les versions précédentes.
      if (stored.dim === undefined) {
        const legacy = Number(localStorage.getItem('svet.dim'));
        if (Number.isFinite(legacy) && legacy > 0) stored.dim = legacy;
      }
      return stored;
    } catch {
      return {};
    }
  },
  write(patch) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs.read(), ...patch }));
    } catch {
      // Navigation privée, quota plein, stockage refusé : le réglage ne
      // survivra pas à cette visite. C'est tout ce qu'on perd.
    }
  },
};
