/**
 * Le panneau « hors ligne » : préparer le secteur affiché pour s'en servir
 * sans réseau.
 *
 * Il estime ce qu'il faudrait télécharger — les tuiles, du zoom de l'écran au
 * plus fin, et les relevés de la zone ou des cellules du secteur —, refuse ce
 * qui dépasse un quartier, et lance le pré-chargement. Le plan et le
 * téléchargement eux-mêmes sont dans `offline.js`, qui s'éprouve sans
 * navigateur ; ici, on les branche sur la carte et sur le panneau.
 */
import { dom, map, state } from './app.js';
import { escapeHtml } from './format.js';
import { tileTemplate } from './layers.js';
import {
  MAX_PREFETCH_TILES,
  buildPlan,
  cellBytes,
  formatBytes,
  prefetch,
  tilesInBounds,
} from './offline.js';
import { setRoutePanel } from './route.js';

// ------------------------------------------------------------------ hors ligne

/**
 * Ce qu'il faudrait télécharger pour tenir hors ligne sur le secteur affiché.
 *
 * Les zooms retenus vont de celui de l'écran au plus fin de la pyramide : on
 * prépare ce qu'on regarde et ce qu'on regardera de plus près, pas la vue
 * d'ensemble qu'on vient de quitter. Zoomer avant de préparer réduit donc à la
 * fois l'emprise et le volume, ce qui est le réglage naturel.
 */
function offlinePlan() {
  const view = map.getBounds();
  const bounds = {
    west: view.getWest(),
    south: view.getSouth(),
    east: view.getEast(),
    north: view.getNorth(),
  };
  const { minZoom, maxZoom } = state.meta.tiles ?? { minZoom: 11, maxZoom: 16 };
  const from = Math.max(minZoom, Math.min(maxZoom, Math.floor(map.getZoom())));
  const tiles = tilesInBounds(bounds, { minZoom: from, maxZoom });

  const absolute = (url) => new URL(url, location.href).toString();
  const data = state.region
    ? state.region.cellsIn(bounds).map((cell) => ({
        url: absolute(
          `data/${state.meta.region}/cellules/${cell.key}.data.bin${cell.stamp ? `?v=${cell.stamp}` : ''}`,
        ),
        bytes: cellBytes(cell),
      }))
    : [
        { url: absolute(`data/${state.zoneKey}.meta.json${state.version}`), bytes: 4000 },
        {
          url: absolute(`data/${state.zoneKey}.data.bin${state.version}`),
          bytes: (state.data?.segmentCount ?? 0) * 192,
        },
      ];

  return { ...buildPlan({ tileUrl: tileTemplate(), tiles, data }), cells: data.length, from };
}

export function setOfflinePanel(open) {
  if (!open && dom.offline.contains(document.activeElement)) dom.offlineToggle.focus();
  // Les deux panneaux occupent la même place à l'écran ; ouvrir l'un ferme donc
  // l'autre, plutôt que de les empiler.
  if (open && !dom.route.hidden) setRoutePanel(false);
  dom.offline.hidden = !open;
  dom.offlineToggle.classList.toggle('is-on', open);
  dom.offlineToggle.setAttribute('aria-expanded', String(open));
  if (!open) return;

  dom.offlineResult.innerHTML = '';
  const plan = offlinePlan();
  const tooMuch = plan.tiles > MAX_PREFETCH_TILES;
  dom.offlineGo.disabled = tooMuch;
  dom.offlineEstimate.innerHTML = tooMuch
    ? `<p class="warn">Le secteur affiché demande ${plan.tiles.toLocaleString('fr-FR')} tuiles —
       bien plus qu'un quartier. Zoomez sur ce que vous allez vraiment parcourir.</p>`
    : `<p class="offline-size"><strong>${formatBytes(plan.bytes)}</strong>
       <span class="muted">· ${
         state.region
           ? `${plan.cells} secteur${plan.cells > 1 ? 's' : ''} de relevés`
           : 'relevés de la zone'
       } et ${plan.tiles.toLocaleString('fr-FR')} tuiles, du zoom ${plan.from} au plus fin</span></p>`;
}

export async function runOffline() {
  // Le plan est refait au moment du clic, et non repris de l'ouverture du
  // panneau : la carte a pu bouger derrière, et c'est bien ce qu'on voit
  // maintenant qu'on veut emporter. Mais alors le garde-fou de volume, posé à
  // l'ouverture, ne vaut plus rien — il faut le reposer ici, sinon un
  // dézoomage entre les deux gestes lance le téléchargement de la région.
  const plan = offlinePlan();
  if (plan.tiles > MAX_PREFETCH_TILES) {
    setOfflinePanel(true);
    return;
  }

  dom.offlineGo.disabled = true;
  dom.offlineResult.innerHTML = `<p class="muted">Téléchargement… 0 %</p>`;

  try {
    const { failed } = await prefetch(plan.urls, (done, total) => {
      dom.offlineResult.innerHTML = `<p class="muted">Téléchargement…
        ${Math.floor((done / total) * 100)} %</p>`;
    });
    dom.offlineResult.innerHTML =
      failed > 0
        ? `<p class="warn">Secteur préparé, mais ${failed} fichier(s) manquent —
           relancez pour les rattraper.</p>`
        : `<p class="offline-done">Secteur disponible hors ligne.</p>`;
  } catch (error) {
    dom.offlineResult.innerHTML = `<p class="warn">${escapeHtml(error.message)}</p>`;
  } finally {
    dom.offlineGo.disabled = false;
  }
}
