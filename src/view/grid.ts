// The background grid, drawn in SCREEN space (#grid, not inside #world): inside the zoom transform a
// sub-pixel pattern resamples into moiré. A major grid plus a sub-grid that fades out by level of detail.
import { chevron } from './icons.js';
import gridOffIcon from '../assets/icons/grid-off.svg?raw';
import gridDotIcon from '../assets/icons/grid-dot.svg?raw';
import gridMeshIcon from '../assets/icons/grid-mesh.svg?raw';
import gridLineIcon from '../assets/icons/grid-line.svg?raw';
import { state, GRID_STYLES, GRID_SIZES, type GridStyle, type GridSize } from '../core/state.js';
import { clamp } from '../utils/num.js';

const GRID_ICONS: Record<GridStyle, string> = { none: gridOffIcon, dot: gridDotIcon, mesh: gridMeshIcon, line: gridLineIcon };

const gridEl = document.getElementById('grid');
const gridFineEl = document.getElementById('gridFine');

// state.gridSize is the SUB-grid step (what cards snap to).
const SUBDIVS = 4;
// Smallest on-screen sub-cell before the level steps up (already faded out by then).
const MIN_PX = 6;
// The sub-grid's peak share of --grid-ink, so the major level stays dominant. Toward 1 trades that
// hierarchy for a seamless level step.
const SUB_MAX = 0.6;
// Screen pixels at every zoom.
const DOT_R = 1, MAJOR_DOT_R = DOT_R * 2, LINE_W = 1;

const LOG_SUBDIVS = Math.log(SUBDIVS);
const log = (x: number) => Math.log(x) / LOG_SUBDIVS;

// `dot` draws only its sub level: --grid-ink is translucent, so a major dot over a sub dot would come
// out darker. `mesh` has major dots over sub lines; `line` lines at both levels.
function paintLayer(el: HTMLElement, step: number, isMajor: boolean): void {
  if (state.gridStyle === 'dot' && isMajor){
    el.style.backgroundImage = 'none';
    return;
  }
  if (state.gridStyle === 'dot' || (state.gridStyle === 'mesh' && isMajor)){
    // Centred in the tile, origin pushed half a cell: dots land on the intersections of both levels.
    const r = state.gridStyle === 'mesh' ? MAJOR_DOT_R : DOT_R;
    el.style.backgroundImage = `radial-gradient(circle, var(--grid-ink) ${r}px, transparent ${r + 0.5}px)`;
    el.style.backgroundPosition = `${step / 2}px ${step / 2}px`;
  } else {
    el.style.backgroundImage = `linear-gradient(to right, var(--grid-ink) ${LINE_W}px, transparent ${LINE_W}px),`
      + `linear-gradient(to bottom, var(--grid-ink) ${LINE_W}px, transparent ${LINE_W}px)`;
    el.style.backgroundPosition = '0 0';
  }
  el.style.backgroundSize = `${step}px ${step}px`;
}

// Cached so a pan only ever writes transform/opacity — never `background`, which would repaint.
let painted = '';

// Runs on every pan/zoom.
export function paintGrid(): void {
  if (!gridEl || !gridFineEl) {
    return;
  }
  const base = state.gridSize;
  if (state.gridStyle === 'none' || !base){ gridEl.style.display = 'none'; return; }
  gridEl.style.display = '';

  // sub ∈ [MIN_PX, SUBDIVS*MIN_PX); the fade is where it sits in that span.
  const cell = base * state.view.k;
  const sub = cell * SUBDIVS ** Math.max(0, Math.ceil(log(MIN_PX / cell)));
  const major = sub * SUBDIVS;
  // `dot` never fades: a half-faded sub-grid is the hierarchy it doesn't want.
  const subAlpha = state.gridStyle === 'dot' ? 1 : clamp(log(sub / MIN_PX), 0, 1) * SUB_MAX;

  const key = `${state.gridStyle}|${major}`;
  if (key !== painted){
    painted = key;
    paintLayer(gridEl, major, true);
    paintLayer(gridFineEl, sub, false);
    // Overhang one major cell so the pan-translate never drags a bare edge into view.
    gridEl.style.inset = `${-major}px`;
  }
  gridFineEl.style.opacity = String(subAlpha);

  // view mod major is congruent mod sub too, so one transform aligns both levels. Whole px: no resampling.
  const off = (v: number) => Math.round((v % major + major) % major);
  gridEl.style.transform = `translate(${off(state.view.x)}px,${off(state.view.y)}px)`;
}

export function refreshGrid(): void {
  renderGridControls();
  painted = '';   // force a rebuild — the style may have changed, not just the step
  paintGrid();
}

const STYLE_LABELS: Record<GridStyle, string> = { none: 'Off', dot: 'Dots', mesh: 'Mesh', line: 'Lines' };

const sizeLabel = (z: GridSize): string => z ? `${z} px` : 'Off';
const tick = (on: boolean): string => `<span class="set-tick">${on ? '✓' : ''}</span>`;

export function renderGridControls(): void {
  const styleBtn = document.getElementById('gridBtn');
  const snapBtn = document.getElementById('snapBtn');
  const styles = document.getElementById('gridStyles');
  const sizes = document.getElementById('gridSizes');
  if (!styleBtn || !snapBtn || !styles || !sizes) {
    return;
  }
  styleBtn.innerHTML = GRID_ICONS[state.gridStyle] + `<span class="set-val">${STYLE_LABELS[state.gridStyle]}</span>` + chevron();
  snapBtn.innerHTML = `<span class="set-val">${sizeLabel(state.gridSize)}</span>` + chevron();
  styles.innerHTML = GRID_STYLES.map(s => {
    const on = s === state.gridStyle;
    return `<button class="set-item" data-style="${s}" aria-pressed="${on}">${tick(on)}${GRID_ICONS[s]}${STYLE_LABELS[s]}</button>`;
  }).join('');
  sizes.innerHTML = GRID_SIZES.map(z => {
    const on = z === state.gridSize;
    return `<button class="set-item" data-size="${z}" aria-pressed="${on}">${tick(on)}${sizeLabel(z)}</button>`;
  }).join('');
}

let gridChanged: () => void = () => {};

export function onGridChanged(listener: () => void): void {
  gridChanged = listener;
}

function set(patch: { gridStyle?: GridStyle; gridSize?: GridSize }): void {
  Object.assign(state, patch);
  refreshGrid();
  gridChanged();
}

export function installGrid(): void {
  document.getElementById('gridStyles')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-style]');
    if (b) {
      set({ gridStyle: b.dataset.style as GridStyle });
    }
  });
  document.getElementById('gridSizes')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-size]');
    if (b) {
      set({ gridSize: Number(b.dataset.size) as GridSize });
    }
  });
}
