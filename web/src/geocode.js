/**
 * Recherche d'un lieu de départ ou d'arrivée.
 *
 * Deux sources, dans cet ordre :
 *
 *  1. **Les noms de rue du réseau déjà chargé.** Instantané, hors ligne, et
 *     forcément dans l'emprise calculée — ce qui évite de proposer une
 *     destination pour laquelle on n'a aucune donnée.
 *  2. **Nominatim** (OpenStreetMap), uniquement sur validation explicite, pour
 *     les lieux qui ne sont pas des rues : gares, musées, jardins. Le service
 *     demande de rester sous une requête par seconde ; ne l'appeler que sur
 *     entrée validée, jamais à la frappe, tient largement l'engagement.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/**
 * Index des noms de rue, avec un point représentatif.
 *
 * Il se construisait en parcourant la géométrie complète. Celle-ci étant
 * désormais tuilée, on passe par le graphe : chaque arête connaît son tronçon,
 * donc son nom, et porte des coordonnées de nœud. On obtient le même index
 * sans avoir à charger un octet de géométrie.
 */
export function indexStreetNames(data, graph) {
  const byName = new Map();

  for (let i = 0; i < graph.edgeCount; i++) {
    const { name } = data.segmentAt(graph.edgeSegment[i]);
    if (!name) continue;
    const node = graph.edgeA[i];
    const entry = byName.get(name);
    if (entry) {
      entry.lonSum += graph.nodeLon[node];
      entry.latSum += graph.nodeLat[node];
      entry.count++;
    } else {
      byName.set(name, { name, lonSum: graph.nodeLon[node], latSum: graph.nodeLat[node], count: 1 });
    }
  }

  return [...byName.values()].map((entry) => ({
    label: entry.name,
    lon: entry.lonSum / entry.count,
    lat: entry.latSum / entry.count,
    source: 'réseau',
  }));
}

/** Recherche immédiate dans les noms de rue, sans accents ni casse. */
export function searchLocal(streets, query, limit = 6) {
  const needle = normalize(query);
  if (needle.length < 2) return [];

  const scored = [];
  for (const street of streets) {
    const haystack = normalize(street.label);
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    // Une correspondance en début de nom passe avant une correspondance au milieu.
    scored.push({ street, score: at === 0 ? 0 : 1, length: haystack.length });
  }

  scored.sort((a, b) => a.score - b.score || a.length - b.length);
  return scored.slice(0, limit).map((s) => s.street);
}

/** Recherche de lieux, bornée à l'emprise de la zone. */
export async function searchRemote(query, bbox, limit = 5) {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit),
    viewbox: `${west},${north},${east},${south}`,
    bounded: '1',
  });

  const response = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Nominatim a répondu ${response.status}`);

  const results = await response.json();
  return results.map((entry) => ({
    label: shorten(entry.display_name),
    lon: Number(entry.lon),
    lat: Number(entry.lat),
    source: 'OpenStreetMap',
  }));
}

function normalize(text) {
  return text
    .normalize('NFD')
    // Signes diacritiques combinants (U+0300 à U+036F), isolés juste avant par
    // la décomposition NFD : « Sévigné » se trouve alors en tapant « sevigne ».
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Nominatim renvoie l'adresse administrative complète ; on garde le début. */
function shorten(displayName) {
  return displayName.split(',').slice(0, 3).join(',').trim();
}
