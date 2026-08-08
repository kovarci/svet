/**
 * Recherche d'un lieu de départ ou d'arrivée.
 *
 * Trois sources, dans cet ordre :
 *
 *  1. **Les noms de rue du réseau déjà chargé.** Instantané, hors ligne, et
 *     forcément dans l'emprise calculée — ce qui évite de proposer une
 *     destination pour laquelle on n'a aucune donnée.
 *  2. **La Base Adresse Nationale**, à la frappe. C'est ce qui manquait : le
 *     réseau ne connaît que des *noms de voie*, si bien que « 12 rue de
 *     Sévigné » ne donnait rien — or c'est exactement ainsi qu'on saisit une
 *     destination. La BAN est le référentiel officiel des adresses françaises,
 *     ouvert, sans clé ni quota gênant, et conçu pour l'autocomplétion.
 *  3. **Nominatim** (OpenStreetMap), en dernier recours et sur validation
 *     explicite, pour ce qui n'est pas une adresse : gares, musées, jardins. Le
 *     service demande de rester sous une requête par seconde ; ne l'appeler que
 *     sur entrée validée tient largement l'engagement.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const BAN = 'https://api-adresse.data.gouv.fr/search/';

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
      byName.set(name, {
        name,
        lonSum: graph.nodeLon[node],
        latSum: graph.nodeLat[node],
        count: 1,
      });
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

/**
 * Adresses, à la frappe, par la Base Adresse Nationale.
 *
 * Le point de proximité classe les réponses : « rue de la Paix » existe dans
 * six cents communes, et sans lui la première proposée n'a aucune raison d'être
 * la bonne. Les réponses hors emprise calculée sont écartées ici plutôt que
 * proposées puis refusées au moment du calcul — proposer une destination pour
 * laquelle on n'a aucun relevé, c'est promettre ce qu'on ne peut pas tenir.
 *
 * @param {string} query
 * @param {object} options
 * @param {number[]} [options.center] `[lon, lat]` pour le classement
 * @param {number[]} [options.bbox] `[ouest, sud, est, nord]` de la zone
 * @param {AbortSignal} [options.signal]
 */
export async function searchAddresses(query, { center, bbox, limit = 5, signal } = {}) {
  const trimmed = query.trim();
  // La BAN refuse les requêtes trop courtes ; inutile de la déranger.
  if (trimmed.length < 3) return [];

  const params = new URLSearchParams({ q: trimmed, limit: String(limit * 2), autocomplete: '1' });
  if (center) {
    params.set('lon', center[0].toFixed(4));
    params.set('lat', center[1].toFixed(4));
  }

  const response = await fetch(`${BAN}?${params}`, {
    signal: signal ?? AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`La Base Adresse Nationale a répondu ${response.status}`);

  const { features = [] } = await response.json();
  return features
    .map((feature) => ({
      label: feature.properties.label,
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
      // « adresse », « rue », « commune » : le rang de la réponse dit ce qu'on
      // vise, et un numéro de rue ne se lit pas comme un chef-lieu.
      source:
        { housenumber: 'adresse', street: 'rue', locality: 'lieu-dit', municipality: 'commune' }[
          feature.properties.type
        ] ?? 'adresse',
    }))
    .filter((item) => inside(item, bbox))
    .slice(0, limit);
}

function inside(item, bbox) {
  if (!bbox) return true;
  const [west, south, east, north] = bbox;
  return item.lon >= west && item.lon <= east && item.lat >= south && item.lat <= north;
}

/**
 * Fusionne les propositions locales et distantes, sans doublon.
 *
 * Les rues du réseau viennent d'abord : elles sont instantanées, disponibles
 * hors ligne, et certaines d'être calculées. Une adresse de la BAN qui désigne
 * une voie déjà proposée n'apporte rien de plus — sauf si elle porte un numéro,
 * qui est justement ce qu'on est venu chercher.
 */
export function mergeSuggestions(local, remote, limit = 7) {
  const seen = new Set(local.map((item) => normalize(item.label)));
  const merged = [...local];
  for (const item of remote) {
    const key = normalize(item.label);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, limit);
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
  return (
    text
      .normalize('NFD')
      // Signes diacritiques combinants (U+0300 à U+036F), isolés juste avant par
      // la décomposition NFD : « Sévigné » se trouve alors en tapant « sevigne ».
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

/** Nominatim renvoie l'adresse administrative complète ; on garde le début. */
function shorten(displayName) {
  return displayName.split(',').slice(0, 3).join(',').trim();
}
