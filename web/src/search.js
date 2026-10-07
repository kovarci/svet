/**
 * Recherche de lieux : le départ et l'arrivée de l'itinéraire.
 *
 * Trois façons de désigner un lieu, qui aboutissent toutes à `setPlace` : un
 * nom de rue ou une adresse tapés dans le champ, un point pointé sur la carte,
 * la position réelle. Ce module tient les deux champs, leurs listes de
 * suggestions et leur parcours au clavier, le pointage, la géolocalisation, et
 * les marqueurs qui montrent sur la carte ce qu'on a choisi.
 *
 * Il ne calcule rien : les lieux retenus vont dans `state.places`, où le
 * calcul d'itinéraire vient les lire.
 */
import { currentStreets, dom, map, motionDuration, state } from './app.js';
import { escapeHtml } from './format.js';
import { mergeSuggestions, searchAddresses, searchLocal, searchRemote } from './geocode.js';

// --------------------------------------------------------------- recherche

export function setPlace(target, place) {
  state.places[target] = place;
  dom[target].value = place.label;
  hideSuggestions(target);
  renderMarkers();
}

function renderMarkers() {
  const features = [];
  for (const kind of ['from', 'to']) {
    const place = state.places[kind];
    if (place) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
        properties: { kind },
      });
    }
  }
  map.getSource('markers').setData({ type: 'FeatureCollection', features });
}

/**
 * Interroge la Base Adresse Nationale, une fois la frappe reposée.
 *
 * Trois précautions, et chacune répond à un défaut précis :
 *
 *  - **Anti-rebond de 250 ms.** Sans lui, « rue de rivoli » part quatorze fois,
 *    une par lettre, pour une seule réponse utile.
 *  - **Abandon de la requête précédente.** Les réponses ne reviennent pas dans
 *    l'ordre où on les demande : une requête lente sur « rue » écraserait la
 *    liste de « rue de Rivoli », tapé depuis.
 *  - **Vérification que le champ n'a pas changé** avant d'afficher. L'abandon
 *    couvre le réseau, pas le cas où la réponse arrive juste après une frappe.
 *
 * Un échec ne dit rien à l'écran : les rues du réseau sont déjà affichées, et
 * l'application reste utilisable hors ligne — c'est même tout l'intérêt de les
 * chercher d'abord localement.
 */
const addressSearch = { timer: null, controller: null };

function askAddresses(target, query, local) {
  clearTimeout(addressSearch.timer);
  addressSearch.controller?.abort();
  if (query.trim().length < 3) return;

  addressSearch.timer = setTimeout(async () => {
    addressSearch.controller = new AbortController();
    try {
      const remote = await searchAddresses(query, {
        center: state.meta.center,
        bbox: state.meta.bbox,
        signal: addressSearch.controller.signal,
      });
      if (dom[target].value !== query) return;
      showSuggestions(target, mergeSuggestions(local, remote));
    } catch (error) {
      if (error.name !== 'AbortError') console.warn('Adresses indisponibles :', error.message);
    }
  }, 250);
}

function showSuggestions(target, items) {
  const list = dom[`${target}Suggestions`];
  if (items.length === 0) {
    hideSuggestions(target);
    return;
  }

  list.innerHTML = items
    .map(
      (item, i) =>
        `<li id="${target}-option-${i}" role="option" aria-selected="false" data-index="${i}">
           <span>${escapeHtml(item.label)}</span><em>${escapeHtml(item.source)}</em>
         </li>`,
    )
    .join('');
  list.hidden = false;
  list.dataset.items = JSON.stringify(items);
  dom[target].setAttribute('aria-expanded', 'true');
  setActiveOption(target, -1);
}

function hideSuggestions(target) {
  const list = dom[`${target}Suggestions`];
  list.hidden = true;
  list.dataset.active = '-1';
  dom[target].setAttribute('aria-expanded', 'false');
  dom[target].removeAttribute('aria-activedescendant');
}

/**
 * Désigne l'option parcourue au clavier.
 *
 * Le focus ne bouge pas : il reste dans le champ, et `aria-activedescendant`
 * indique laquelle des options est visée. C'est tout l'intérêt du motif — on
 * continue de taper pendant qu'on parcourt la liste, ce qu'un focus déplacé
 * d'option en option interdirait.
 *
 * @param {number} index rang de l'option, ou −1 pour n'en viser aucune.
 */
function setActiveOption(target, index) {
  const list = dom[`${target}Suggestions`];
  const options = [...list.children];
  list.dataset.active = String(index);

  options.forEach((option, i) => {
    const active = i === index;
    option.setAttribute('aria-selected', String(active));
    option.classList.toggle('is-active', active);
    if (active) option.scrollIntoView({ block: 'nearest' });
  });

  if (index < 0) dom[target].removeAttribute('aria-activedescendant');
  else dom[target].setAttribute('aria-activedescendant', options[index].id);
}

/** Déplace la visée d'un cran, en bouclant aux deux bouts. */
function moveActiveOption(target, delta) {
  const list = dom[`${target}Suggestions`];
  const count = list.children.length;
  if (list.hidden || count === 0) return;

  const current = Number(list.dataset.active ?? -1);
  // Depuis « aucune », la flèche du bas prend la première et celle du haut la
  // dernière : c'est ce qu'on attend en ouvrant une liste par le bas ou par le haut.
  const next = current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count;
  setActiveOption(target, next);
}

export function startPicking(target) {
  state.picking = target;
  map.getCanvas().style.cursor = 'crosshair';
  dom.routeResult.innerHTML = `<p class="muted">Cliquez sur la carte pour placer
    ${target === 'from' ? 'le départ' : "l'arrivée"}.</p>`;
}

export function stopPicking() {
  state.picking = null;
  map.getCanvas().style.cursor = '';
  dom.routeResult.innerHTML = '';
}

/**
 * Branche les champs de départ et d'arrivée : suggestions à la frappe,
 * parcours de la liste au clavier, validation par Entrée ou par un clic.
 */
export function bindPlaceFields() {
  for (const target of ['from', 'to']) {
    const input = dom[target];

    // Les rues du réseau s'affichent à la frappe, sans attendre ; les adresses
    // arrivent après, et complètent la liste sans la remplacer.
    input.addEventListener('input', () => {
      const local = searchLocal(currentStreets(), input.value);
      showSuggestions(target, local);
      askAddresses(target, input.value, local);
    });

    input.addEventListener('keydown', async (event) => {
      const list = dom[`${target}Suggestions`];

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Sans quoi la flèche irait déplacer le curseur dans le texte.
        event.preventDefault();
        moveActiveOption(target, event.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (event.key === 'Escape') {
        // Échap referme d'abord la liste, et rien d'autre : on ne veut pas
        // qu'une frappe de trop referme le panneau entier.
        if (list.hidden) return;
        event.stopPropagation();
        hideSuggestions(target);
        return;
      }

      if (event.key !== 'Enter') return;
      event.preventDefault();

      // Une option visée au clavier l'emporte sur tout : c'est celle qu'on voit
      // en surbrillance, et la valider doit donner exactement ce qu'on lit.
      const active = Number(list.dataset.active ?? -1);
      if (!list.hidden && active >= 0) {
        setPlace(target, JSON.parse(list.dataset.items ?? '[]')[active]);
        return;
      }

      // À défaut d'une option visée, la première de la liste affichée : c'est
      // ce qu'on lit, et valider doit donner ce qu'on lit. La liste peut déjà
      // contenir des adresses, arrivées après la frappe.
      const shown = JSON.parse(list.dataset.items ?? '[]');
      if (!list.hidden && shown.length > 0) {
        setPlace(target, shown[0]);
        return;
      }

      const local = searchLocal(currentStreets(), input.value);
      if (local.length > 0) {
        setPlace(target, local[0]);
        return;
      }

      // Ni rue du réseau, ni adresse : ce qu'on cherche est un lieu — une gare,
      // un musée, un square. Nominatim les connaît, et on ne le dérange qu'ici,
      // sur une validation explicite, jamais à chaque frappe.
      try {
        const addresses = await searchAddresses(input.value, {
          center: state.meta.center,
          bbox: state.meta.bbox,
        });
        if (addresses.length > 0) {
          setPlace(target, addresses[0]);
          return;
        }
        const remote = await searchRemote(input.value, state.meta.bbox);
        if (remote.length > 0) setPlace(target, remote[0]);
        else showSuggestions(target, []);
      } catch (error) {
        console.warn('Recherche indisponible :', error.message);
      }
    });

    dom[`${target}Suggestions`].addEventListener('click', (event) => {
      const option = event.target.closest('li');
      if (!option) return;
      const items = JSON.parse(dom[`${target}Suggestions`].dataset.items ?? '[]');
      setPlace(target, items[Number(option.dataset.index)]);
    });
  }
}

/**
 * Renseigne un champ de l'itinéraire avec la position réelle.
 *
 * Le guidage pas à pas existait déjà, mais il fallait d'abord saisir son propre
 * point de départ — au clavier, ou en le pointant sur la carte, ce qui suppose
 * de savoir déjà où l'on est. Pour quelqu'un qui sort de chez lui et cherche à
 * rentrer à l'ombre, c'était l'étape qui manquait.
 */
export function useMyPosition(target) {
  if (state.picking) stopPicking();
  const button = document.querySelector(`.locate[data-target="${target}"]`);

  if (!navigator.geolocation || !window.isSecureContext) {
    dom.routeResult.innerHTML = `<p class="warn">${
      navigator.geolocation
        ? 'La géolocalisation exige une connexion sécurisée (HTTPS ou localhost).'
        : 'Ce navigateur ne donne pas la position.'
    }</p>`;
    return;
  }

  button.classList.add('is-busy');
  dom.routeResult.innerHTML = `<p class="muted">Recherche de votre position…</p>`;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      button.classList.remove('is-busy');
      const { longitude, latitude, accuracy } = position.coords;
      setPlace(target, { label: 'Ma position', lon: longitude, lat: latitude });

      // Hors de l'emprise calculée, le dire tout de suite : le calcul
      // échouerait de toute façon, mais dix secondes plus tard et sans expliquer
      // que c'est la zone affichée qui est en cause, pas le trajet demandé.
      const [west, south, east, north] = state.meta.bbox;
      if (longitude < west || longitude > east || latitude < south || latitude > north) {
        dom.routeResult.innerHTML = `<p class="warn">
          Vous êtes hors de la zone « ${escapeHtml(state.meta.label)} ».
          Choisissez une zone qui vous contient.</p>`;
        return;
      }

      dom.routeResult.innerHTML =
        accuracy > 60
          ? `<p class="muted">Position connue à ± ${Math.round(accuracy)} m seulement —
             vérifiez le point sur la carte.</p>`
          : '';
      map.easeTo({
        center: [longitude, latitude],
        zoom: Math.max(map.getZoom(), 16),
        duration: motionDuration(600),
      });
    },
    (error) => {
      button.classList.remove('is-busy');
      dom.routeResult.innerHTML = `<p class="warn">${geolocationMessage(error)}</p>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

/** Cause d'un échec de géolocalisation, dite en clair. */
export function geolocationMessage(error) {
  const reasons = {
    1: 'Autorisation refusée. Activez la localisation pour ce site.',
    2: 'Position indisponible.',
    3: 'La position met trop de temps à arriver.',
  };
  const reason = reasons[error?.code] ?? 'Position indisponible.';
  return window.isSecureContext
    ? reason
    : `${reason} La géolocalisation exige une connexion sécurisée (HTTPS ou localhost).`;
}
