/**
 * Petits outils sans état, partagés par tous les modules de l'interface.
 *
 * Rien ici ne lit l'état de l'application, la carte ni la zone chargée : ce
 * sont des fonctions qu'on peut appeler de partout sans tirer de dépendance
 * derrière soi — mise en forme d'une heure ou d'une distance, écriture
 * prudente dans le DOM, distance entre deux points.
 */

export function formatClock(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatMeters(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 5) * 5} m`;
}

export function haversineMeters(lon1, lat1, lon2, lat2) {
  const midLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  return Math.hypot((lon2 - lon1) * 111320 * Math.cos(midLat), (lat2 - lat1) * 111132);
}

export function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Écrit un texte, et rien du tout s'il n'a pas changé.
 *
 * Ce n'est pas une économie de rendu : une zone vivante annonce sur **mutation
 * du DOM**, pas sur changement de valeur. Réécrire la même consigne à chaque
 * point GPS la faisait donc relire à chaque seconde, alors que rien ne s'était
 * passé — le bandeau de guidage devenait inutilisable au lecteur d'écran.
 * Scoper `aria-live` était nécessaire, mais pas suffisant.
 */
export function setText(element, text) {
  const value = String(text ?? '');
  if (element.textContent === value) return;
  element.textContent = value;
}

/** Même chose pour un fragment balisé — voir `setText`. */
export function setHTML(element, html) {
  if (element.innerHTML === html) return;
  element.innerHTML = html;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
