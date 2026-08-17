// ---------- the canvas colour button (#canvasColorBtn, bottom-right beside the grid controls) ----------
// ONE button meaning "the colour of the canvas I'm standing on". What that IS depends on where you
// are, and main.ts's canvasOwner is the single place that decides:
//   · at the TOP level there's no frame, so it edits the MAP's own colour — state.canvasColor,
//     per-map in settings.json beside the grid, so it travels with the vault rather than the browser.
//   · inside an OPEN frame the canvas already IS that frame's interior and wears its fill, so the
//     button edits that FRAME's colour — the same `n.color` the float bar would write if the frame
//     were selected. Nothing new is introduced for the case; the existing paint just follows.
// Reading the same resolver the paint reads is what makes the button honest: the chip on it always
// shows the value it would overwrite.
//
// The chips are properties.ts's row verbatim (swatchRowHTML/markSwatchRow/renderRecentChips), so the
// palette, the custom picker and the recents MRU are shared with the card colour popover rather than
// copied. What can't be shared is createProperties itself — that whole factory is defined over node
// ids, and at the top level the target isn't a node. Hence this module: the same row, a different
// target, and its own undo bookkeeping for the half that isn't a node (history.ts's touchCanvas).
import { state, setStatus } from '../core/state.js';
import { nodeLabel, isLockedEffective } from '../utils/model.js';
import { record, touchCanvas, commitStep } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { scheduleSaveBoard } from '../data/board.js';
import { rememberColor } from './color-recents.js';
import { swatchRowHTML, markSwatchRow, renderRecentChips } from './properties.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { paintAll, colorFill, canvasOwner, syncCanvasBackground } from '../main.js';
import { placeInViewport } from '../utils/dom.js';

const btn = document.getElementById('canvasColorBtn') as HTMLButtonElement | null;
const pop = document.getElementById('canvasColorPop');
const colors = document.getElementById('canvasColors');
// 12px — the same margin every floating button keeps from the window edge, so the popover sits the
// same "distance away" from the button as the button does from the corner.
const POP_GAP = 12;
let built = false;

// The value the button would overwrite: the open frame's own authored colour, or the map's.
// Deliberately the AUTHORED value, not the effective one — an inheriting frame should show the
// stripes, exactly as it does in the float bar, rather than pretending it owns its parent's colour.
function currentColor(): string {
  const owner = canvasOwner();
  return owner ? owner.color : state.canvasColor;
}
function locked(): boolean {
  const owner = canvasOwner();
  return !!owner && isLockedEffective(owner);
}

// ---------- writing ----------
// Two targets, two kinds of undo entry, one gesture. A frame is an ordinary node edit (`record`); the
// map's canvas colour isn't a node at all, so it goes through history's touchCanvas/commitStep pair —
// the same shape the sketch layer uses for `state.strokes`. Both land in the one timeline, so ⌘Z after
// a pick puts the colour back wherever you were standing (see history.ts's Step).
function applyColor(color: string): void {
  const owner = canvasOwner();
  if (owner) { owner.color = color; owner.dirty = true; }
  else state.canvasColor = color;
}
// Repainting a frame means repainting the cards that INHERIT from it, so the whole scope. The map's
// own colour reaches the background — and the free edges' LABELS, whose ink is derived from the fill
// they sit on (view/free-edges.ts, main.ts canvasSurface), so a label left unpainted keeps ink chosen
// against the colour the canvas used to be. Still not paintAll: those two are the whole of what a map
// colour touches, and this runs once per pointer move over the native colour sheet.
function repaint(): void {
  if (canvasOwner()) paintAll();
  else { syncCanvasBackground(); paintFreeEdges(); }
}
function setColor(color: string): void {
  if (state.readOnly) { setStatus('Read-only — can’t recolour the canvas'); return; }
  const owner = canvasOwner();
  if (owner && isLockedEffective(owner)) { setStatus(`“${nodeLabel(owner)}” is locked`); return; }
  if (owner) {
    record([owner.id], () => applyColor(color));
    repaint();
    scheduleSave();
  } else {
    touchCanvas();
    applyColor(color);
    commitStep();
    repaint();
    scheduleSaveBoard();
  }
  // The COMMIT path only (a chip click, or the native sheet's `change`) — applyColor also runs per
  // `input` event during a live drag, and remembering there would bury the real picks under a drag's
  // worth of intermediates. Same rule as properties.ts's own setColor.
  rememberColor(color);
  if (colors) { renderRecentChips(colors); markSwatchRow(colors, currentColor()); }
}

// ---------- the button's own chip ----------
// Mirrors the live value rather than the popover's `.active` swatch, so it's right before the popover
// has ever been built. Reuses the same .swatch/.inherit/.nofill look the chips have (see index.html).
export function markCanvasColorBtn(): void {
  const chip = btn?.querySelector<HTMLElement>('.swatch');
  if (!btn || !chip) return;
  const v = currentColor();
  const fill = colorFill(v);
  chip.classList.remove('inherit', 'nofill');
  chip.style.removeProperty('--sw');
  if (v === 'none') chip.classList.add('nofill');
  else if (fill) chip.style.setProperty('--sw', fill);
  else chip.classList.add('inherit');
  const owner = canvasOwner();
  btn.title = owner ? `Colour of “${nodeLabel(owner)}” — the frame you’re in` : 'Canvas colour of this map';
}

// ---------- the popover ----------
// Rebuilt on every open rather than once: the FIRST chip depends on where you're standing (a frame
// inherits from its parent, the map falls back to the theme — see properties.ts's FirstChip), and the
// recents row is derived from the open map, which may have changed since the last time it was shown.
function build(): void {
  if (!colors) return;
  colors.innerHTML = swatchRowHTML(canvasOwner() ? 'inherit' : 'default');
  renderRecentChips(colors);
  markSwatchRow(colors, currentColor());
  if (built) return;
  built = true;
  // Delegated once, so the row above can be replaced freely. The custom chip is excluded: its click
  // OPENS the native sheet (the <label>'s job) and picks nothing.
  colors.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
    if (!sw) return;
    if (sw.classList.contains('custom')) return;   // closing here would tear the row down mid-choice
    setColor(sw.dataset.color ?? '');
    close();
  });
  bindCustom();
}
// A native colour input streams `input` for the whole time the user is dragging around the sheet and
// `change` once on commit. So: preview live (paint only — no history entry, no disk write per event),
// then make the commit ONE undo step. `record`/`commitStep` snapshot when they're called, which is
// already too late by then, so the pre-drag value is stashed at the first `input` and rewound just
// before committing — invisible, since nothing paints in between.
// Both listeners sit on the ROW, not on the input, and read the input off the event — build()
// replaces the row's innerHTML on every open, so a captured element reference would be detached
// from the second open onwards and every later drag would commit the first input's stale value.
function bindCustom(): void {
  if (!colors) return;
  const row = colors;
  let before: string | null = null;
  const picker = (e: Event): HTMLInputElement | null => {
    const el = e.target as HTMLElement;
    return el.closest('.swatch.custom') ? el as HTMLInputElement : null;
  };
  row.addEventListener('input', (e) => {
    const input = picker(e);
    if (!input || state.readOnly || locked()) return;
    if (before === null) before = currentColor();
    applyColor(input.value);
    repaint();                        // live preview: paint only — no history entry, no disk write
    markSwatchRow(row, currentColor());
  });
  row.addEventListener('change', (e) => {
    const input = picker(e);
    if (!input || before === null) return;
    const prev = before; before = null;
    applyColor(prev);                 // rewind, so the history sees the real before-image
    setColor(input.value);
  });
}
// Anchored above its own button (which lives in the bottom-right corner), clamped into the viewport.
function position(): void {
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2;
  let top = r.top - ph - POP_GAP;
  if (top < 4) top = r.bottom + POP_GAP;
  placeInViewport(pop, left, top);
}
function close(): void { pop?.classList.remove('open'); }
function toggle(): void {
  if (!pop) return;
  if (pop.classList.contains('open')) { close(); return; }
  build();
  pop.classList.add('open');
  position();
}

export function setupCanvasColor(): void {
  if (!btn || !pop) return;
  btn.onclick = (e) => { e.stopPropagation(); toggle(); };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (pop.classList.contains('open') && !pop.contains(t) && !btn.contains(t)) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
  // Deliberately NOT marking the chip here. setupCanvasColor runs while main.ts's own body is still
  // evaluating (beside setupTheme/setupGrid), and markCanvasColorBtn reads colorFill → SWATCH_BG,
  // which main.ts doesn't declare until much further down — reading it now is a TDZ crash that takes
  // the whole boot with it. The static `.swatch.inherit` in index.html is already the right default,
  // and the first paintAll marks it for real (syncCanvasBackground). Same shape as setupGrid, whose
  // first paint likewise waits for the map's settings.json to load.
}
