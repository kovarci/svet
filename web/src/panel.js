/**
 * Ce qu'on lit à côté de la carte : le panneau de détail d'un tronçon, sa
 * courbe sur la journée, la légende, et les couleurs de l'échelle.
 *
 * Le panneau dit d'un trottoir ce que sa couleur ne peut pas dire : de quoi
 * l'indice est fait, et si l'autre côté de la rue vaut mieux. Les couleurs
 * servent aussi au résultat d'itinéraire et au bandeau de guidage, qui les
 * prennent ici : un même indice doit avoir partout la même teinte.
 */
import { MODES, UV_LEGEND, contextAt, dom, evaluateSide, map, sideOf, state } from './app.js';
import { legibleOn } from './contrast.js';
import { formatClock } from './format.js';
import { ensureVisibleCells } from './layers.js';
import { levelLabel, uvLabel } from '@svet/pipeline/model';

// --------------------------------------------------------------- affichage

export function renderLegend() {
  dom.modeNote.textContent = MODES[state.mode].note;
  const stops = state.mode === 'uv' ? UV_LEGEND : state.meta.scale;
  dom.legend.innerHTML = stops
    .map(
      (stop, i) => `
        <div class="step">
          <div class="swatch" style="background:linear-gradient(90deg,${stop.color},${
            stops[i + 1]?.color ?? stop.color
          })"></div>
          <div class="label">${stop.label}</div>
        </div>`,
    )
    .join('');
}

export function selectSegment(feature) {
  state.selected = feature.properties;
  map.setFilter('network-selected', ['==', ['get', 'id'], feature.properties.id]);
  dom.panel.hidden = false;
  renderPanel(state.selected);
}

export function renderPanel(props) {
  const segment = state.data.segmentAt(props.id);
  const leftSide = sideOf(props.id, false);
  const rightSide = sideOf(props.id, true);
  // Cliquer sur une rue dont les relevés ne sont pas encore là est parfaitement
  // ordinaire en région : le trait vient d'une tuile, le relevé d'une cellule,
  // et les deux ne voyagent pas ensemble. On le dit, et la cellule arrive.
  if (!segment || !leftSide || !rightSide) {
    dom.panelTitle.textContent = 'Relevés en cours de chargement';
    dom.panelSub.textContent = 'ce secteur arrive';
    dom.panelScore.innerHTML = '<span class="value muted">—</span>';
    dom.panelAdvice.innerHTML =
      '<span class="muted">Le détail s’affichera dès que les relevés du secteur seront là.</span>';
    dom.panelChart.innerHTML = '';
    // Le clic est aussi une demande : on va chercher la cellule, et le panneau
    // se remplira à la prochaine peinture.
    ensureVisibleCells().then(() => {
      if (state.selected?.id === props.id) renderPanel(props);
    });
    return;
  }
  const context = contextAt(state.minutes);
  const l = evaluateSide(leftSide, context);
  const r = evaluateSide(rightSide, context);
  const twoSided = segment.twoSided;

  const best = l.index <= r.index ? l : r;
  const worst = l.index <= r.index ? r : l;
  const shown = state.sideMode === 'worst' ? worst : best;

  dom.panelTitle.textContent = segment.name ?? labelForHighway(segment.hw, segment.crossing);
  dom.panelSub.textContent = [
    segment.name ? labelForHighway(segment.hw, segment.crossing) : 'voie sans nom',
    segment.width ? `${segment.width} m de large` : null,
    formatClock(state.minutes),
  ]
    .filter(Boolean)
    .join(' · ');

  dom.panelScore.innerHTML = `
    <span class="value" style="color:${textColorFor(shown.index)}">${shown.index}</span>
    <span class="level">${levelLabel(shown.index)}</span>`;

  const gap = worst.index - best.index;
  dom.panelAdvice.innerHTML = !twoSided
    ? `<span class="muted">Cheminement piéton : un seul relevé, pas de côté à choisir.</span>`
    : gap < 8
      ? `<span class="muted">Les deux trottoirs se valent (écart de ${gap} point${gap > 1 ? 's' : ''}).</span>`
      : `Marchez côté <strong>${best.side}</strong> — ${best.index} contre ${worst.index}
         côté ${worst.side}, soit <strong>${gap} points</strong> de moins.`;

  dom.panelChart.innerHTML = sparkline(props.id);

  const pct = (value) => `${Math.round(value * 100)} %`;
  // Les luminances se lisent par ordre de grandeur, pas à l'unité : sous mille,
  // la centaine suffit ; au-delà, le millier.
  const cdm2 = (value) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)} kcd/m²` : `${Math.round(value / 10) * 10} cd/m²`;
  const rows = twoSided
    ? [
        ['', `côté ${l.side}`, `côté ${r.side}`],
        ['Indice', l.index, r.index],
        ['Soleil direct', pct(l.sun), pct(r.sun)],
        ['Éblouissement de face', pct(l.glare), pct(r.glare)],
        ['Scintillement', pct(l.flicker), pct(r.flicker)],
        ['Réverbération', pct(l.reverb), pct(r.reverb)],
        ['Murs éclairés', pct(l.sunlitWalls), pct(r.sunlitWalls)],
        ['Luminance façades', cdm2(l.wallLuminance), cdm2(r.wallLuminance)],
        ['Luminance du sol', cdm2(l.groundLuminance), cdm2(r.groundLuminance)],
        ['Ouverture au ciel', pct(l.svf), pct(r.svf)],
        ['Couvert arboré', `${l.canopy} %`, `${r.canopy} %`],
        ['Éclairement', `${(l.lux / 1000).toFixed(0)} klx`, `${(r.lux / 1000).toFixed(0)} klx`],
        [
          'Équivalent mélanopique',
          `${(l.melanopicLux / 1000).toFixed(0)} klx`,
          `${(r.melanopicLux / 1000).toFixed(0)} klx`,
        ],
        ['Indice UV', l.uv.toFixed(1), r.uv.toFixed(1)],
      ]
    : [
        ['Soleil direct', pct(l.sun)],
        ['Éblouissement de face', pct(l.glare)],
        ['Scintillement', pct(l.flicker)],
        ['Réverbération', pct(l.reverb)],
        ['Murs éclairés', pct(l.sunlitWalls)],
        ['Luminance façades', cdm2(l.wallLuminance)],
        ['Luminance du sol', cdm2(l.groundLuminance)],
        ['Ouverture au ciel', pct(l.svf)],
        ['Couvert arboré', `${l.canopy} %`],
        ['Éclairement', `${(l.lux / 1000).toFixed(0)} klx`],
        ['Équivalent mélanopique', `${(l.melanopicLux / 1000).toFixed(0)} klx`],
        ['Indice UV', `${l.uv.toFixed(1)} — ${uvLabel(l.uv)}`],
      ];

  dom.panelStats.className = twoSided ? 'two-sided' : '';
  dom.panelStats.innerHTML = rows
    .map(
      ([label, ...values]) =>
        `<div class="row"><span class="key">${label}</span>${values
          .map((v) => `<span class="val">${v}</span>`)
          .join('')}</div>`,
    )
    .join('');
}

/** Courbe de l'indice sur la journée, un trait par trottoir. */
function sparkline(id) {
  const width = 280;
  const height = 74;
  const pad = 4;
  const times = state.meta.times;

  const seriesFor = (entry) =>
    times.map((step) => evaluateSide(entry, contextAt(step.minutes)).index);

  const l = seriesFor(sideOf(id, false));
  const r = seriesFor(sideOf(id, true));

  const toPoints = (values) =>
    values
      .map((value, i) => {
        const x = pad + (i / (values.length - 1)) * (width - pad * 2);
        const y = height - pad - (value / 100) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const first = times[0].minutes;
  const span = times[times.length - 1].minutes - first;
  const cursorX = pad + ((state.minutes - first) / span) * (width - pad * 2);

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="Évolution de l'indice sur la journée, pour chaque trottoir">
      <polyline points="${toPoints(l)}" fill="none" stroke="#4aa3a2" stroke-width="1.8" />
      <polyline points="${toPoints(r)}" fill="none" stroke="#d9a441" stroke-width="1.8" />
      <line x1="${cursorX.toFixed(1)}" y1="${pad}" x2="${cursorX.toFixed(1)}" y2="${height - pad}"
            stroke="#d7dbe3" stroke-width="1" stroke-dasharray="2 3" opacity="0.7" />
    </svg>
    <p class="chart-key">
      <span style="color:#4aa3a2">— côté ${state.data.segmentAt(id).lSide}</span>
      <span style="color:#d9a441">— côté ${state.data.segmentAt(id).rSide}</span>
    </p>`;
}

export function colorFor(value) {
  let result = state.meta.scale[0].color;
  for (const stop of state.meta.scale) {
    if (value >= stop.value) result = stop.color;
  }
  return result;
}

/**
 * Fond des panneaux, `--surface` de la feuille de style. La variante à fort
 * contraste est plus sombre encore : ce qui se lit ici s'y lit aussi.
 */
const PANEL_BACKGROUND = '#131924';

/** Couleur de l'échelle pour écrire un chiffre, et non peindre une rue. */
export function textColorFor(value) {
  return legibleOn(colorFor(value), PANEL_BACKGROUND);
}

function labelForHighway(highway, crossing) {
  if (crossing) return 'traversée piétonne';
  return (
    {
      footway: 'trottoir / cheminement',
      pedestrian: 'voie piétonne',
      path: 'sentier',
      steps: 'escalier',
      living_street: 'zone de rencontre',
      residential: 'rue',
      service: 'voie de desserte',
      cycleway: 'piste cyclable',
      tertiary: 'rue',
      secondary: 'avenue',
      primary: 'grand axe',
    }[highway] ?? 'voie'
  );
}

export function closeDetailPanel() {
  // La carte reprend le focus : c'est d'elle qu'on vient, et les raccourcis
  // horaires y répondent.
  if (dom.panel.contains(document.activeElement)) map.getCanvas().focus();
  dom.panel.hidden = true;
  state.selected = null;
  map.setFilter('network-selected', ['==', ['get', 'id'], -1]);
}
