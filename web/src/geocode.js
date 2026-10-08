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
 * Deux morceaux de même nom plus proches que cela sont la même rue — coupée par
 * une place, un carrefour mal relié, un bord de cellule. Plus loin, ce sont deux
 * rues : « rue de la République » existe dans la moitié des communes de la
 * région.
 */
const SAME_STREET_METERS = 300;

/**
 * Index des noms de rue, avec un point représentatif.
 *
 * Il se construisait en parcourant la géométrie complète. Celle-ci étant
 * désormais tuilée, on passe par le graphe : chaque arête connaît son tronçon,
 * donc son nom, et porte des coordonnées de nœud. On obtient le même index
 * sans avoir à charger un octet de géométrie.
 *
 * Le point représentatif était la moyenne de tous les nœuds du nom. Deux
 * défauts, l'un et l'autre silencieux : deux rues homonymes de deux communes
 * devenaient un seul point, au milieu des champs entre elles ; et une rue
 * coudée avait son point au creux du coude, dans l'îlot. On regroupe donc les
 * morceaux de même nom qui se touchent ou se suivent de près, et chaque groupe
 * prend pour point **son nœud le plus proche de sa moyenne** — un point de la
 * rue elle-même.
 */
export function indexStreetNames(data, graph) {
  const edgesByName = new Map();
  for (let i = 0; i < graph.edgeCount; i++) {
    const { name } = data.segmentAt(graph.edgeSegment[i]);
    if (!name) continue;
    if (!edgesByName.has(name)) edgesByName.set(name, []);
    edgesByName.get(name).push(i);
  }

  const entries = [];
  for (const [name, edges] of edgesByName) {
    for (const nodes of streetGroups(graph, edges)) {
      let lon = 0;
      let lat = 0;
      for (const n of nodes) {
        lon += graph.nodeLon[n];
        lat += graph.nodeLat[n];
      }
      lon /= nodes.length;
      lat /= nodes.length;
      let best = nodes[0];
      let bestDistance = Infinity;
      for (const n of nodes) {
        const d = meters(lon, lat, graph.nodeLon[n], graph.nodeLat[n]);
        if (d < bestDistance) {
          bestDistance = d;
          best = n;
        }
      }
      entries.push({
        label: name,
        lon: graph.nodeLon[best],
        lat: graph.nodeLat[best],
        source: 'réseau',
      });
    }
  }
  return entries;
}

/**
 * Les nœuds d'un nom, regroupés en rues : morceaux connexes d'abord, puis
 * morceaux voisins de moins de `SAME_STREET_METERS` réunis.
 */
function streetGroups(graph, edges) {
  // Morceaux connexes : union des deux bouts de chaque arête.
  const parent = new Map();
  const find = (n) => {
    while (parent.get(n) !== n) {
      parent.set(n, parent.get(parent.get(n)));
      n = parent.get(n);
    }
    return n;
  };
  for (const e of edges) {
    for (const n of [graph.edgeA[e], graph.edgeB[e]]) if (!parent.has(n)) parent.set(n, n);
    const [a, b] = [find(graph.edgeA[e]), find(graph.edgeB[e])];
    if (a !== b) parent.set(a, b);
  }
  const pieces = new Map();
  for (const n of parent.keys()) {
    const root = find(n);
    if (!pieces.has(root)) pieces.set(root, []);
    pieces.get(root).push(n);
  }

  // Morceaux proches : réunis de proche en proche, jusqu'à ce que plus rien ne bouge.
  const groups = [...pieces.values()];
  let merged = true;
  while (merged && groups.length > 1) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (closest(graph, groups[i], groups[j]) < SAME_STREET_METERS) {
          groups[i] = groups[i].concat(groups[j]);
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

function closest(graph, a, b) {
  let best = Infinity;
  for (const m of a) {
    for (const n of b) {
      const d = meters(graph.nodeLon[m], graph.nodeLat[m], graph.nodeLon[n], graph.nodeLat[n]);
      if (d < best) best = d;
    }
  }
  return best;
}

function meters(lon1, lat1, lon2, lat2) {
  const midLat = (((lat1 + lat2) / 2) * Math.PI) / 180;
  return Math.hypot((lon2 - lon1) * 111320 * Math.cos(midLat), (lat2 - lat1) * 111132);
}

/**
 * Recherche immédiate dans les noms de rue, sans accents ni casse.
 *
 * Des homonymes — la même rue dans deux communes — se distinguent par leur
 * distance au centre de la carte, le plus proche d'abord : sans cela, deux
 * lignes identiques laissaient choisir au hasard.
 *
 * @param {number[]} [center] `[lon, lat]` du centre de la carte
 */
export function searchLocal(streets, query, limit = 6, center = null) {
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

  const distance = (street) => (center ? meters(center[0], center[1], street.lon, street.lat) : 0);
  scored.sort(
    (a, b) => a.score - b.score || a.length - b.length || distance(a.street) - distance(b.street),
  );
  const found = scored.slice(0, limit).map((s) => s.street);

  const count = new Map();
  for (const street of found) count.set(street.label, (count.get(street.label) ?? 0) + 1);
  return found.map((street) =>
    count.get(street.label) > 1 && center
      ? {
          ...street,
          source: `${street.source} · à ${(distance(street) / 1000).toFixed(1).replace('.', ',')} km`,
        }
      : street,
  );
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
      // Le nom de voie seul, sans code postal ni commune : c'est lui qui dit si
      // la réponse désigne une rue déjà proposée par le réseau.
      name: feature.properties.name,
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
 *
 * Le doublon se reconnaît au **nom de voie** de la BAN, pas à son libellé : le
 * libellé porte le code postal et la commune (« Rue de Rivoli 75001 Paris »),
 * et ne ressemblait donc jamais au nom du réseau — la même rue revenait deux
 * fois. Encore faut-il qu'elle soit au même endroit : une homonyme d'une autre
 * commune reste proposée.
 */
export function mergeSuggestions(local, remote, limit = 7) {
  const seen = new Set(local.map((item) => normalize(item.label)));
  const merged = [...local];
  const sameStreet = (item) =>
    item.name &&
    local.some(
      (street) =>
        normalize(street.label) === normalize(item.name) &&
        meters(street.lon, street.lat, item.lon, item.lat) < 1000,
    );
  for (const item of remote) {
    const key = normalize(item.label);
    if (seen.has(key) || sameStreet(item)) continue;
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
