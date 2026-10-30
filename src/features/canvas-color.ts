// ---------- the canvas colour button (#canvasColorBtn, bottom-right beside the grid controls) ----------
// ONE button meaning "the colour of the canvas I'm standing on". What that IS depends on where you
// are, and features/canvas-color.ts's canvasOwner is the single place that decides:
//   · at the TOP level there's no section, so it edits the MAP's own colour — state.canvasColor,
//     per-map in settings.json beside the grid, so it travels with the vault rather than the browser.
//   · inside an OPEN section the canvas already IS that section's interior and wears its fill, so the
//     button edits that SECTION's colour — the same `n.color` the float bar would write if the section
//     were selected. Nothing new is introduced for the case; the existing paint just follows.
// Reading the same resolver the paint reads is what makes the button honest: the chip on it always
// shows the value it would overwrite.
//
// The chips are properties.ts's row verbatim (swatchRowHTML/markSwatchRow/renderRecentChips), so the
// palette, the custom picker and the recents MRU are shared with the card colour popover rather than
// copied. What can't be shared is createProperties itself — that whole factory is defined over node
// ids, and at the top level the target isn't a node. Hence this module: the same row, a different
// target, and its own undo bookkeeping for the half that isn't a node (history.ts's touchCanvas).
import { state, setStatus, type MindNode, stage } from '../core/state.js';
import { nodeLabel, isLockedEffective, ancestors } from '../utils/model.js';
import { record, touchCanvas, commitStep } from './history.js';
import { scheduleSaveBoard } from '../data/board.js';
import { rememberColor } from './color-recents.js';
import { swatchRowHTML, markSwatchRow, renderRecentChips } from './properties.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { paintAll, effectiveColor } from '../main.js';
import { placePopover, closeOnOutside } from '../utils/dom.js';
import { colorFill, colorTexture, swatchBg, THEME_BG } from '../view/color.js';
import { paintCanvasTexture } from '../view/grid.js';
import { scopeRootNode } from '../nav/scope.js';
import { inkFor } from '../utils/ink.js';
import { scheduleSave } from '../data/save.js';

const btn = document.getElementById('canvasColorBtn') as HTMLButtonElement | null;
const pop = document.getElementById('canvasColorPop');
const colors = document.getElementById('canvasColors');
let built = false;

// The value the button would overwrite: the open section's own authored colour, or the map's.
// Deliberately the AUTHORED value, not the effective one — an inheriting section should show the
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
// Two targets, two kinds of undo entry, one gesture. A section is an ordinary node edit (`record`); the
// map's canvas colour isn't a node at all, so it goes through history's touchCanvas/commitStep pair —
// the same shape the edge list uses. Both land in the one timeline, so ⌘Z after
// a pick puts the colour back wherever you were standing (see history.ts's Step).
function applyColor(color: string): void {
  const owner = canvasOwner();
  if (owner) {
    owner.color = color;
    owner.dirty = true;
  } else {
    state.canvasColor = color;
  }
}
// Repainting a section means repainting the cards that INHERIT from it, so the whole scope. The map's
// own colour reaches the background — and the free edges' LABELS, whose ink is derived from the fill
// they sit on (view/free-edges.ts, features/canvas-color.ts canvasSurface), so a label left unpainted keeps ink chosen
// against the colour the canvas used to be. Still not paintAll: those two are the whole of what a map
// colour touches, and this runs once per pointer move over the native colour sheet.
function repaint(): void {
  if (canvasOwner()) {
    paintAll();
  } else {
    syncCanvasBackground();
    paintFreeEdges();
  }
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
// has ever been built. Reuses the .swatch look the chips have (see index.html).
export function markCanvasColorBtn(): void {
  const chip = btn?.querySelector<HTMLElement>('.swatch');
  if (!btn || !chip) {
    return;
  }
  const v = currentColor();
  const fill = colorFill(v);
  chip.classList.remove('inherit', 'nofill');
  chip.style.removeProperty('--sw');
  if (v === 'none') {
    chip.classList.add('nofill');
  }
  // nothing authored: the colour actually behind you — the board's own grey at the top level
  else {
    chip.style.setProperty('--sw', fill ? swatchBg(v) : canvasSurface());
  }
  const owner = canvasOwner();
  btn.title = owner ? `Colour of “${nodeLabel(owner)}” — the section you’re in` : 'Canvas colour of this map';
}

// ---------- the popover ----------
// Rebuilt on every open rather than once: the FIRST chip depends on where you're standing (a section
// inherits from its parent, the map falls back to the theme — see properties.ts's FirstChip), and the
// recents row is derived from the open map, which may have changed since the last time it was shown.
function build(): void {
  if (!colors) {
    return;
  }
  colors.innerHTML = swatchRowHTML(canvasOwner() ? 'inherit' : 'default');
  colors.classList.add('surfaces');   // the canvas is always a surface: it offers the surface palette
  renderRecentChips(colors);
  markSwatchRow(colors, currentColor());
  if (built) {
    return;
  }
  built = true;
  // Delegated once, so the row above can be replaced freely. The custom chip is excluded: its click
  // OPENS the native sheet (the <label>'s job) and picks nothing.
  colors.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
    if (!sw) {
      return;
    }
    if (sw.classList.contains('custom')) {
      return;   // closing here would tear the row down mid-choice
    }
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
  if (!colors) {
    return;
  }
  const row = colors;
  let before: string | null = null;
  const picker = (e: Event): HTMLInputElement | null => {
    const el = e.target as HTMLElement;
    return el.closest('.swatch.custom') ? el as HTMLInputElement : null;
  };
  row.addEventListener('input', (e) => {
    const input = picker(e);
    if (!input || state.readOnly || locked()) {
      return;
    }
    if (before === null) {
      before = currentColor();
    }
    applyColor(input.value);
    repaint();                        // live preview: paint only — no history entry, no disk write
    markSwatchRow(row, currentColor());
  });
  row.addEventListener('change', (e) => {
    const input = picker(e);
    if (!input || before === null) {
      return;
    }
    const prev = before; before = null;
    applyColor(prev);                 // rewind, so the history sees the real before-image
    setColor(input.value);
  });
}
function close(): void { pop?.classList.remove('open'); }
function toggle(): void {
  if (!pop || !btn) {
    return;
  }
  if (pop.classList.contains('open')) { close(); return; }
  build();
  pop.classList.add('open');
  placePopover(pop, btn);   // above its own button, in the bottom-right corner
}

export function setupCanvasColor(): void {
  if (!btn || !pop) {
    return;
  }
  btn.onclick = (e) => { e.stopPropagation(); toggle(); };
  closeOnOutside(pop, btn, close);
  // Deliberately NOT marking the chip here: no map is loaded yet, the static `.swatch.inherit` in
  // index.html is already the right default, and the first paintAll marks it for real
  // (syncCanvasBackground).
}

// While a section is OPEN the canvas IS its interior, so the canvas takes the section's own fill — the
// very colour its box was wearing a moment before, through the same resolver its box used
// (effectiveColor → colorFill), so the two can't drift. At the TOP level there is no section and the
// canvas wears the MAP's own colour instead (state.canvasColor, per-map in settings.json). Written on
// #stage, not <body>, so the theme's own --bg is left completely alone; #stage sits under #grid, so
// the grid still draws over it.
// Both are SURFACE colours (view/color.ts SURFACE_ROW), painted exactly, so a board and a section picked
// the same are the same.
// …and, for a section, only when that colour is AUTHORED somewhere up the chain. effectiveColor
// deliberately falls back to the theme's neutral card fill for a section nobody has coloured, and
// painting the whole canvas THAT would be both a lie (there's no colour to show) and a real problem in
// the light theme, where the near-white fill swallows the floating chrome sitting on the canvas — the
// ghost-card pill, the status line. The test is authorship, not the hex, so a section explicitly
// coloured white still tints. state.canvasColor needs no such test: it's authored by definition.
function hasAuthoredColor(n: MindNode): boolean {
  return [n, ...ancestors(n)].some(a => !!a.color);
}
// WHOSE colour the canvas shows, and therefore what the canvas-colour button edits: the section you're
// standing IN, or nothing (= the map itself) at the top level. ONE resolver, read by the paint below
// and by the picker (features/canvas-color.ts), so the colour you can see and the colour the button
// writes can't become two different things.
export const canvasOwner = (): MindNode | null => scopeRootNode();

// The colour VALUE behind the cards right now — the one input the background, its texture and the grid
// ink are all derived from.
//
// An owner with NO authored colour anywhere up its chain falls through to the MAP's own canvas colour
// rather than to nothing: what's behind an uncoloured section is whatever is behind IT. Standing inside a section nobody coloured
// used to discard the canvas colour the map itself was painted in — so
// going in turned a teal board grey, and coming out turned it teal again.
function canvasColor(): string {
  const owner = canvasOwner();
  return owner && hasAuthoredColor(owner) ? effectiveColor(owner) : state.canvasColor;
}

// …and the fill it paints as. null = none, and the theme's own background shows through as before.
function canvasFill(): string | null { return colorFill(canvasColor()); }
// The fill a thing drawn ON THE CANVAS is sitting on: the canvas's own colour, else the theme's. What a
// free edge's label plate is painted in — a label is a small
// patch of the canvas laid over the line, so its ink is measured against exactly this.
export function canvasSurface(): string { return canvasFill() ?? THEME_BG; }
// The grid ink is derived from the THEME (--grid/--text in styles.css), which on a coloured canvas
// leaves it either invisible or harsh. So re-derive --grid-pat from the fill that's really behind it,
// by the theme's own 55/45 recipe with the fill standing in for --grid and, for --text, the direction
// that HAS contrast against that fill — inkFor, the same call a card's own ink goes through, so an
// arbitrary picked colour needs no special case. Written on #stage, which is where the fill is set;
// #grid is its child and declares --grid-ink from it, so one write covers both grid levels.
export function syncCanvasBackground(): void {
  const fill = canvasFill();

  // A TEXTURED colour (cork) lays its texture over the fill, on #canvasTex (styles.css).
  const tex = colorTexture(canvasColor());
  stage.classList.toggle('textured', !!tex);
  if (tex) {
    stage.style.setProperty('--canvas-tex', tex);
    paintCanvasTexture();
  }
  if (fill) {
    stage.style.setProperty('--canvas-bg', fill);
    stage.style.setProperty('--grid-pat', `color-mix(in srgb, ${fill} 55%, ${inkFor(fill)} 45%)`);
  } else {
    stage.style.removeProperty('--canvas-bg');
    stage.style.removeProperty('--grid-pat');
  }
  markCanvasColorBtn();   // the button's own chip mirrors whatever it would edit
  syncThemeColor(fill);
}
// The browser's theme colour (Safari's bars, an installed app's title bar) is the canvas you're standing
// on, so the chrome around the board reads as part of it; the board's own grey when it has no colour. A
// fill can be a palette VARIABLE, which a meta tag can't read, so it is resolved to rgb on a hidden probe
// — not off #stage, whose background is mid-transition right after a change.
const themeMeta = document.querySelector('meta[name="theme-color"]');
let themeProbe: HTMLElement | null = null;
function syncThemeColor(fill: string | null | undefined): void {
  if (!themeMeta) {
    return;
  }
  if (!themeProbe) { themeProbe = document.createElement('i'); themeProbe.hidden = true; document.body.append(themeProbe); }
  themeProbe.style.color = fill || 'var(--bg)';
  const rgb = getComputedStyle(themeProbe).color;
  if (themeMeta.getAttribute('content') !== rgb) {
    themeMeta.setAttribute('content', rgb);
  }
}
