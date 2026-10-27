// ---------- the colour control ----------
// The swatch row the floating bar's colour popover shows (#floatBar). Given the row element plus a
// "which cards am I editing" provider, it wires the swatches and the custom-colour chip to the undo /
// paint / save contract. Also exports the swatch-row helpers the canvas-colour picker shares.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, SWATCH_BG, PICKER_ROWS, effectiveColor } from '../main.js';
import { isHexColor } from '../utils/ink.js';
import { recentColors, rememberColor } from './color-recents.js';

export interface PropEls {
  colors: HTMLElement;
}
export interface PropertyControls {
  sync(): void;            // reflect the current target(s) into the controls
}

// What the custom chip offers before anything custom is picked — a mid blue, so opening the native
// sheet starts somewhere neutral rather than on black. Only ever the input's starting value.
const CUSTOM_FALLBACK = '#3f8cff';

// ---------- the swatch row itself: markup + marking ----------
// Split out of createProperties so the CANVAS colour popover (features/canvas-color.ts) is the same
// row rather than a copy of it — the palette, the custom picker, the recents and the ring logic all
// have exactly one implementation, so none of them can drift between the two surfaces. What the
// canvas popover can't reuse is createProperties itself: that whole factory is defined over NODE ids
// (state.nodes, isLockedEffective, record-per-id), and at the top level the target isn't a node.
//
// `first` is the one difference in the markup: 'default' (the map's canvas) adds a reset chip.
export type FirstChip = 'inherit' | 'default';
// FigJam's picker: two rows of eleven (PICKER_ROWS). A row break is a full-width element in ONE flex
// container rather than separate containers, so every chip stays a sibling — a single delegated click
// handler, markSwatchRow's one querySelectorAll and the float bar's `.swatch.active` lookup all keep
// working over the whole picker. The line toolbar's colour popover (features/edge-bar.ts) is these alone.
export function paletteChipsHTML(): string {
  const chip = (c: string): string => `<div class="swatch" data-color="${c}" title="${c}" style="--sw:${SWATCH_BG[c]}"></div>`;
  return PICKER_ROWS.map(row => row.map(chip).join('')).join(`<span class="swatch-break"></span>`);
}
export function swatchRowHTML(first: FirstChip): string {
  // …the second row ending in the custom chip.
  let html = paletteChipsHTML();
  // Any colour at all — the card's ink follows automatically (utils/ink.ts), which is what makes an
  // off-palette colour safe to offer. A <label> WRAPPING the input, rather than a div that forwards
  // a click: that's the one form every platform opens natively from a single tap, including iOS,
  // where the input is the only way to reach the system colour sheet. The input itself is invisible
  // and covers the chip (styles.css), so the chip keeps the round-bubble look its neighbours have.
  html += `<label class="swatch custom" title="custom colour — any colour you like">`
    + `<input type="color" value="${CUSTOM_FALLBACK}" aria-label="Custom colour"></label>`;
  // No "inherit" or "none" chips, as in FigJam: a card nobody coloured still follows its frame (or is
  // the default yellow), and the picker rings the colour it SHOWS (markSwatch). The custom colours used
  // recently wrap onto a third row (renderRecentChips). The MAP's canvas alone gets a reset chip in
  // the board's own grey, ahead of them, since there is no other way back to "no canvas colour".
  if (first === 'default')
    html += `<span class="swatch-break"></span><div class="swatch" data-color="" title="default board colour" style="--sw:var(--bg)"></div>`;
  return html;
}
// The recents chips, replaced wholesale each time (there are at most SHOWN_MAX of them). Rendered at
// the end of the third row, after the default chips.
export function renderRecentChips(colors: HTMLElement): void {
  colors.querySelectorAll('.swatch.recent').forEach(el => el.remove());
  for (const c of recentColors())
    colors.insertAdjacentHTML('beforeend',
      `<div class="swatch recent" data-color="${c}" title="${c}" style="--sw:${c}"></div>`);
}
// Ring the chip carrying `active` ('' → the first chip). A custom colour is usually carried by one of
// the RECENT chips, and that's the one that should ring. The custom chip only ADOPTS the colour when
// no recent chip has it — a colour that's been pushed out of the cap, or one authored/imported into a
// note by hand. It can't simply stop adopting: `.swatch.active` is also what the float bar's trigger
// mirrors (markColorTrigger), so with nothing ringed the trigger would fall back to the inherit
// stripes and read as "no colour".
export function markSwatchRow(colors: HTMLElement, active: string): void {
  const custom = colors.querySelector<HTMLElement>('.swatch.custom');
  if (custom) {
    const onRecent = isHexColor(active) && !!colors.querySelector(`.swatch.recent[data-color="${active}"]`);
    const adopt = isHexColor(active) && !onRecent;
    // DELETED rather than set to '' when the chip isn't adopting: '' is the *first* chip's own
    // value, so an empty data-color here would light up two chips at once on a fresh card.
    if (adopt) custom.dataset.color = active; else delete custom.dataset.color;
    custom.style.setProperty('--sw', adopt ? active : CUSTOM_FALLBACK);
    custom.classList.toggle('picked', adopt);   // .picked shows the colour; otherwise a spectrum chip
    const input = custom.querySelector<HTMLInputElement>('input');
    // The sheet should open on whatever colour is showing, recent chip or not — that's the one
    // you'd want to nudge — falling back to the neutral start only when there's no custom colour.
    if (input) input.value = isHexColor(active) ? active : CUSTOM_FALLBACK;
  }
  colors.querySelectorAll<HTMLElement>('.swatch').forEach(sw =>
    sw.classList.toggle('active', sw.dataset.color === active));
}

// getIds returns the card ids the controls act on: the whole selection in the sidebar, the single
// active card in the branch sheet. Empty → the controls no-op (nothing selected).
export function createProperties(els: PropEls, getIds: () => string[]): PropertyControls {
  // ---- colour swatches ----
  // The palette rows are a fixed set, built once. The recently-used custom colours are NOT fixed (see
  // features/color-recents.ts), so they're rebuilt on every sync — a colour picked from the sheet has to
  // appear as a chip straight away, and one recoloured away from has to stop being offered.
  function rebuildSwatches(): void {
    els.colors.innerHTML = swatchRowHTML('inherit');
    renderRecents();
    // Delegated, so the recents row can be re-rendered freely without re-binding anything. The
    // custom chip is excluded: its click OPENS the native sheet (the <label>'s job) and picks nothing.
    els.colors.addEventListener('click', (e) => {
      const sw = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
      if (!sw || sw.classList.contains('custom')) return;
      setColor(sw.dataset.color ?? '');
    });
    bindCustom(els.colors.querySelector<HTMLInputElement>('.swatch.custom input')!);
  }
  function renderRecents(): void { renderRecentChips(els.colors); }
  function setColor(color: string): void {
    const ids = editableIds(); if (!ids.length) return;
    record(ids, () => { for (const id of ids) applyColor(id, color); });
    // Deliberately here and not in applyColor: this is the COMMIT path (a chip click, or the native
    // sheet's `change`), while applyColor also runs per `input` event during a live drag — remembering
    // there would bury the real picks under a drag's worth of intermediate colours.
    rememberColor(color);
    renderRecents();   // a colour just picked from the sheet becomes a chip immediately
    markSwatch();
    paintAll(); scheduleSave();
  }
  function editableIds(): string[] { return getIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); }
  function applyColor(id: string, color: string): void {
    const n = state.nodes.get(id); if (n){ n.color = color; n.dirty = true; }
  }
  // ---- the custom picker ----
  // A native colour input streams `input` events for the whole time the user is dragging around the
  // sheet, and `change` once when they commit. So: preview live (paint only — no history entry, no
  // disk write per event), then make the commit ONE undo step. `record` snapshots its before-image
  // when it's called, which is already too late by then, so the pre-drag colours are stashed at the
  // first `input` and rewound just before recording — invisible, since nothing paints in between.
  function bindCustom(input: HTMLInputElement): void {
    let before: Map<string, string> | null = null;
    input.addEventListener('input', () => {
      const ids = editableIds(); if (!ids.length) return;
      if (!before) before = new Map(ids.map(id => [id, state.nodes.get(id)?.color ?? '']));
      for (const id of ids) applyColor(id, input.value);
      markSwatch();
      paintAll();
    });
    input.addEventListener('change', () => {
      if (!before) return;
      const prev = before; before = null;
      for (const [id, color] of prev) applyColor(id, color);   // rewind, so `record` sees the real before-image
      setColor(input.value);
    });
  }
  // active swatch = the colour every target SHOWS — its own, or for one nobody coloured, the one it
  // inherits or defaults to (effectiveColor). Mixed → nothing rings.
  function markSwatch(): void {
    const colors = new Set(getIds().map(id => { const n = state.nodes.get(id); return n ? n.color || effectiveColor(n) : ''; }));
    markSwatchRow(els.colors, colors.size === 1 ? [...colors][0] : '\u0000');
  }

  function sync(): void {
    renderRecents();   // the offered set depends on the open MAP, so re-derive it whenever we're shown
    markSwatch();
  }

  rebuildSwatches();
  const panel = { sync };
  return panel;
}
