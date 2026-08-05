// ---------- background grid (none / dot / mesh / line) ----------
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
//    share one ink colour (--grid-ink), scaled down by SUB_MAX for the sub-grid where the two need
//    telling apart, so the major level reads as the stronger one.
// The three visible styles are three fillings of those same two levels (see paintLayer):
//  - `dot`  — a plain even dot field with no hierarchy at all: the SUB level draws every dot and the
//    major level draws nothing (see paintLayer for why it can't just draw the same dot twice), and
//    it's the one style that doesn't use the opacity ramp below (see subAlpha, which is where the
//    cost of that lands — its level step changes density instead of fading).
//  - `mesh` — major DOTS on the intersections of the sub-grid's faint LINES: the two levels read as
//    different things rather than as strong-and-weak, so the dots stay legible while the mesh gives
//    the fine step you actually snap to.
//  - `line` — lines at both levels, the classic graph paper, told apart by SUB_MAX alone.
//
// Cost per pan/zoom frame is one transform write plus one opacity write, both compositor-only;
// the gradients are rebuilt only when the level actually changes.
// Persisted per-map in settings.json (data/persistence.ts) — not localStorage, since it's a
// property of the map/vault, like the sketch layer, and should travel with it.
import gridOffIcon from '../assets/icons/grid-off.svg?raw';
import gridDotIcon from '../assets/icons/grid-dot.svg?raw';
import gridMeshIcon from '../assets/icons/grid-mesh.svg?raw';
import gridLineIcon from '../assets/icons/grid-line.svg?raw';
import { state, GRID_STYLES, GRID_SIZES, type GridStyle, type GridSize } from '../core/state.js';
import { scheduleSaveSettings } from '../data/persistence.js';
import { openMenu } from '../features/context-menu.js';

const GRID_ICONS: Record<GridStyle, string> = { none: gridOffIcon, dot: gridDotIcon, mesh: gridMeshIcon, line: gridLineIcon };

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
// Wherever the sub-grid needs telling apart from the major level (`mesh`, `line`) it never gets
// brighter than this fraction of --grid-ink, which keeps the major level dominant even once it has
// fully faded in. The cost of capping below 1 is that a level step is no longer seamless — at the
// step the outgoing major becomes the incoming sub-grid, so the finest lines drop from full ink to
// SUB_MAX of it. Faint lines mid-zoom, so it reads as a settle rather than a pop; raise this toward
// 1 to trade hierarchy back for seamlessness.
const SUB_MAX = 0.6;
// Grid ink stays a fixed screen size at every zoom (see above): 1px lines, and dots of DOT_R —
// doubled to MAJOR_DOT_R for `mesh`'s major dots, which have to hold their own against the lines
// crossing under them (`dot`'s single level of dots keeps the plain radius throughout).
const DOT_R = 1, MAJOR_DOT_R = DOT_R * 2, LINE_W = 1;

const LOG_SUBDIVS = Math.log(SUBDIVS);
const log = (x: number) => Math.log(x) / LOG_SUBDIVS;

// Fills ONE level (major or sub) of the two-level grid for the live style: dots at the major level
// for `mesh` (whose sub-grid is the line style's own faint mesh) and at the SUB level only for `dot`,
// lines everywhere else. Dots and lines register against each other because both are placed off the
// tiling origin the shared transform aligns: a dot's centre lands one whole cell in, which is a
// multiple of `sub` as well, hence exactly on a crossing of the mesh below it.
//
// `dot` leaving its major level EMPTY is what actually makes the field even, and it's the reason a
// flat dot grid can't be "both levels, same paint": --grid-ink is translucent, so a major dot drawn
// over the sub dot it coincides with composites to roughly twice the alpha (21% over 21% ≈ 38%) and
// every 4th dot comes out visibly darker — the major/minor distinction back again by another route.
// One layer can carry the whole style because the sub level alone is already the full field: it
// tracks the LOD step, and (uniquely for `dot`) never fades, so nothing is left for a second layer
// to hold up. The empty layer still earns its keep — #grid is what owns the transform, the overhang
// inset and the display toggle.
function paintLayer(el: HTMLElement, step: number, isMajor: boolean): void {
  if (state.gridStyle === 'dot' && isMajor){
    el.style.backgroundImage = 'none';
    return;
  }
  if (state.gridStyle === 'dot' || (state.gridStyle === 'mesh' && isMajor)){
    // Dot at the tile's centre with the tiling origin pushed half a cell, so the dots land ON the
    // grid intersections — and, crucially, both levels stay aligned off the one shared transform
    // (offsetting by half a MAJOR cell would sit a fraction of a sub-cell out).
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
  // `dot` is a flat field of identical dots, so it opts out of the LOD FADE entirely — a partly
  // faded sub-grid is exactly the major/minor distinction it doesn't want. Its two levels are then
  // one indistinguishable dot field (they share the radius, the ink and this opacity, and the major
  // dots land on sub dots), at the price of the level step being a visible change in DENSITY rather
  // than a crossfade: the dots go from MIN_PX apart to SUBDIVS× that in one frame. It only bites at
  // the far end of a zoom-out, where the fade would have been a fine texture dissolving anyway.
  const subAlpha = state.gridStyle === 'dot' ? 1 : Math.max(0, Math.min(1, log(sub / MIN_PX))) * SUB_MAX;

  const key = `${state.gridStyle}|${major}`;
  if (key !== painted){
    painted = key;
    paintLayer(gridEl, major, true);
    paintLayer(gridFineEl, sub, false);
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
