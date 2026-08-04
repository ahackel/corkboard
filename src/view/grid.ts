// ---------- background grid (none / dot / line) ----------
// A cosmetic layer behind the cards, drawn Miro-style in SCREEN space: see #grid in index.html,
// a stage-sized div (sibling of #world) whose CSS-gradient tile is sized in screen pixels rather
// than world units. That's the whole point — a pattern living inside #world inherits the zoom
// transform, so its dots/strokes scale with it and at any k≠1 the browser resamples a sub-pixel
// pattern across the entire canvas, which is what produced the moiré shimmer. Here the ink is
// always exactly 1 screen px wide and only the cell SPACING follows the zoom.
//
// The structure is the standard "infinite grid" recipe from shader-land (Blender's floor grid,
// Godot/Unity infinite-grid shaders, Ben Golus' grid-shader writeup) — the same math, minus the
// shader, since CSS gradients already tile for us:
//  - a MAJOR grid plus a SUB-GRID of SUBDIVS finer cells inside each major cell;
//  - line width clamped in screen space (1px) instead of being allowed to thin out — thin lines
//    are what alias;
//  - level of detail: which world step plays "sub-grid" steps up by whole factors of SUBDIVS as
//    you zoom out, so the sub-grid never gets denser than LOD_MIN px;
//  - the sub-grid's opacity is the fractional part of that same log — it fades out as its cells
//    shrink and is fully gone by the time the level steps, so the step never pops. Both levels
//    share one ink colour (--grid-ink), scaled down by SUB_MAX for the sub-grid so the major
//    lines always read as the stronger ones.
//
// Cost per pan/zoom frame is one transform write plus one opacity write, both compositor-only;
// the gradients are rebuilt only when the level actually changes.
// Persisted per-map in settings.json (data/persistence.ts) — not localStorage, since it's a
// property of the map/vault, like the sketch layer, and should travel with it.
import gridOffIcon from '../assets/icons/grid-off.svg?raw';
import gridDotIcon from '../assets/icons/grid-dot.svg?raw';
import gridLineIcon from '../assets/icons/grid-line.svg?raw';
import { state, type GridStyle, type GridSize } from '../core/state.js';
import { scheduleSaveSettings } from '../data/persistence.js';
import { openMenu } from '../features/context-menu.js';

const GRID_STYLES: GridStyle[] = ['none', 'dot', 'line'];
const GRID_ICONS: Record<GridStyle, string> = { none: gridOffIcon, dot: gridDotIcon, line: gridLineIcon };
const GRID_SIZES: GridSize[] = [0, 20, 40, 80, 160, 320];

let gridBtn: HTMLElement | null = null;
let gridSizeBtn: HTMLElement | null = null;
const gridEl = document.getElementById('grid');
const gridFineEl = document.getElementById('gridFine');

// Sub-cells per major cell. state.gridSize is the SUB-grid step (what dragged cards snap to), so
// the major cell is SUBDIVS × that.
const SUBDIVS = 4;
// Smallest on-screen sub-cell (px) before the level steps up. Only reached with the sub-grid
// already faded to nothing, so it's a floor on the *invisible* extreme, not on legibility.
const MIN_PX = 6;
// The sub-grid never gets brighter than this fraction of --grid-ink, keeping the major lines
// visibly dominant even when it has fully faded in. The cost of capping below 1 is that a level
// step is no longer perfectly seamless — at the step the outgoing major becomes the incoming
// sub-grid, so the finest lines drop from full ink to SUB_MAX of it. Faint lines mid-zoom, so it
// reads as a settle rather than a pop; raise this toward 1 to trade hierarchy back for seamlessness.
const SUB_MAX = 0.6;
// Grid ink stays 1 screen px at every zoom (see above). The second, slightly larger stop is what
// the browser antialiases the dot against — a hard stop renders a harsher, aliased edge.
const DOT_R = 1, LINE_W = 1;

const LOG_SUBDIVS = Math.log(SUBDIVS);
const log = (x: number) => Math.log(x) / LOG_SUBDIVS;

function paintLayer(el: HTMLElement, step: number): void {
  if (state.gridStyle === 'dot'){
    // Dot at the tile's centre with the tiling origin pushed half a cell, so the dots land ON the
    // grid intersections — and, crucially, both levels stay aligned off the one shared transform
    // (offsetting by half a MAJOR cell would sit a fraction of a sub-cell out).
    el.style.backgroundImage = `radial-gradient(circle, var(--grid-ink) ${DOT_R}px, transparent ${DOT_R + 0.5}px)`;
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

// Called on every pan/zoom (view/camera.ts applyView) as well as after a style/size change.
export function paintGrid(): void {
  if (!gridEl || !gridFineEl) return;
  const base = state.gridSize;
  if (state.gridStyle === 'none' || !base){ gridEl.style.display = 'none'; return; }
  gridEl.style.display = '';

  // Step the sub-grid up by whole factors of SUBDIVS until its cell clears MIN_PX, so
  // sub ∈ [MIN_PX, SUBDIVS*MIN_PX) — and the fade is where `sub` sits inside that span.
  const cell = base * state.view.k;
  const sub = cell * SUBDIVS ** Math.max(0, Math.ceil(log(MIN_PX / cell)));
  const major = sub * SUBDIVS;
  const subAlpha = Math.max(0, Math.min(1, log(sub / MIN_PX))) * SUB_MAX;

  const key = `${state.gridStyle}|${major}`;
  if (key !== painted){
    painted = key;
    paintLayer(gridEl, major);
    paintLayer(gridFineEl, sub);
    // Overhang one major cell on every side so the pan-translate below never drags a bare edge
    // into view; sized here rather than in CSS because it tracks the level we just picked.
    gridEl.style.inset = `${-major}px`;
  }
  gridFineEl.style.opacity = String(subAlpha);

  // Translate the over-sized layer so its tiling origin lands on a world grid line. The element's
  // top-left sits one major cell outside the stage and the tile repeats every `major`, so the
  // offset is just view mod major (which is congruent mod `sub` too — hence one transform aligns
  // both levels). Rounded to a whole px so the tile is never resampled at a half-pixel offset.
  const off = (v: number) => Math.round((v % major + major) % major);
  gridEl.style.transform = `translate(${off(state.view.x)}px,${off(state.view.y)}px)`;
}

// Reflects state.gridStyle/gridSize onto the toolbar buttons (icon + title/label) and repaints the
// layer. Called after a fresh map load (settings.json may have just changed it) and each toggle/pick.
export function refreshGrid(): void {
  if (gridBtn) { gridBtn.innerHTML = GRID_ICONS[state.gridStyle]; gridBtn.title = `Background grid: ${state.gridStyle} — click to cycle`; }
  if (gridSizeBtn) { gridSizeBtn.textContent = String(state.gridSize); gridSizeBtn.title = `Grid size: ${state.gridSize} — click to choose`; }
  painted = '';   // force a rebuild — the style may have changed, not just the step
  paintGrid();
}

function cycleGridStyle(): void {
  const i = GRID_STYLES.indexOf(state.gridStyle);
  state.gridStyle = GRID_STYLES[(i + 1) % GRID_STYLES.length];
  refreshGrid();
  scheduleSaveSettings();
}

function pickGridSize(size: GridSize): void {
  state.gridSize = size;
  refreshGrid();
  scheduleSaveSettings();
}

// Wires the toolbar buttons. Called once at startup; the initial paint happens once the first
// map's settings.json has loaded (loadFromDir calls refreshGrid()).
export function setupGrid(): void {
  gridBtn = document.getElementById('gridBtn');
  if (gridBtn) gridBtn.onclick = cycleGridStyle;
  gridSizeBtn = document.getElementById('gridSizeBtn');
  if (gridSizeBtn){
    gridSizeBtn.onclick = (e) => {
      e.stopPropagation();
      const r = gridSizeBtn!.getBoundingClientRect();
      // sy is clamped to fit above the viewport bottom (see openMenuAt in context-menu.ts), so
      // passing the button's own top edge naturally pushes the menu up from this bottom-corner button.
      openMenu(GRID_SIZES.map(size => ({
        label: String(size), run: () => pickGridSize(size),
      })), r.left, r.top);
    };
  }
}
