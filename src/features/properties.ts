// ---------- shared card-property controls (colour / tags / checklist) ----------
// ONE implementation, used by both the canvas floating bar (#floatBar) and the branch-view bottom sheet
// (#branchProps). Given the control elements plus a "which cards am I editing" provider, it wires
// the swatch row, the tags input and the checklist toggle to the same undo / paint / save contract the
// sidebar always used. Title & body are edited elsewhere (inline editors / branch cards), so this
// deliberately owns only the sidebar-style properties. Layout chips stay in main.ts — they're
// canvas geometry with no meaning in the outline, so the branch sheet doesn't get them.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, SWATCH_BG, PALETTE } from '../main.js';
import { isHexColor } from '../utils/ink.js';
import { recentColors, rememberColor } from './color-recents.js';
import { setTagOnNodes, tagPillHTML } from './tags.js';
import { openEmojiPicker } from './emoji-picker.js';

export interface PropEls {
  colors: HTMLElement;
  tagRow?: HTMLElement;   // omitted where there's no tags UI at all (this factory has no canvas caller — the canvas card renders its own tag row directly, see main.ts)
  checklist: HTMLInputElement;
}
export interface PropertyControls {
  sync(): void;            // reflect the current target(s) into the controls
  rebuildSwatches(): void; // re-read the palette hexes (theme switch) and rebuild the swatch row
}

// What the custom chip offers before anything custom is picked — a mid blue, so opening the native
// sheet starts somewhere neutral rather than on black. Only ever the input's starting value.
const CUSTOM_FALLBACK = '#3f8cff';
// every live instance, so a theme switch can rebuild all their swatch rows at once (refreshSwatches)
const panels: PropertyControls[] = [];
// Re-read the palette hexes into every instance's swatch row. Called from main.refreshPalette after
// a light/dark switch (the --pal-* values differ per theme).
export function refreshSwatches(): void { for (const p of panels) p.rebuildSwatches(); }

// ---------- the swatch row itself: markup + marking ----------
// Split out of createProperties so the CANVAS colour popover (features/canvas-color.ts) is the same
// row rather than a copy of it — the palette, the custom picker, the recents and the ring logic all
// have exactly one implementation, so none of them can drift between the two surfaces. What the
// canvas popover can't reuse is createProperties itself: that whole factory is defined over NODE ids
// (state.nodes, isLockedEffective, record-per-id), and at the top level the target isn't a node.
//
// `first` is the one difference in the markup. A card's default is to INHERIT its parent's colour,
// so it gets the striped chip plus a separate explicit `none`. The MAP's canvas has no parent to
// inherit from — its fallback is the theme's own background — so it gets ONE reset chip and no
// `none`, which there would mean the identical thing twice.
export type FirstChip = 'inherit' | 'default';
export function swatchRowHTML(first: FirstChip): string {
  let html = first === 'inherit'
    ? `<div class="swatch inherit" data-color="" title="inherit colour from parent (default)"></div>`
    : `<div class="swatch inherit" data-color="" title="theme default — no canvas colour"></div>`;
  for (const c of PALETTE)
    html += `<div class="swatch" data-color="${c}" title="${c}" style="--sw:${SWATCH_BG[c]}"></div>`;
  if (first === 'inherit')
    html += `<div class="swatch nofill" data-color="none" title="no colour — don’t inherit"></div>`;
  // Two rows in ONE flex container rather than two containers: a full-width break element makes
  // the wrap happen exactly here (see .swatch-break), which keeps every chip a sibling — so a
  // single delegated click handler, markSwatchRow's one querySelectorAll and the float bar's
  // `.swatch.active` lookup all keep working over the whole picker, on both rows.
  html += `<span class="swatch-break"></span>`;
  // Any colour at all — the card's ink follows automatically (utils/ink.ts), which is what makes an
  // off-palette colour safe to offer. A <label> WRAPPING the input, rather than a div that forwards
  // a click: that's the one form every platform opens natively from a single tap, including iOS,
  // where the input is the only way to reach the system colour sheet (there's no EyeDropper API and
  // showPicker() isn't dependable). The input itself is invisible and covers the chip (styles.css),
  // so the chip keeps the same round-bubble look as its neighbours.
  html += `<label class="swatch custom" title="custom colour — any colour you like">`
    + `<input type="color" value="${CUSTOM_FALLBACK}" aria-label="Custom colour"></label>`;
  return html;
}
// The recents chips, replaced wholesale each time (there are at most SHOWN_MAX of them). Rendered
// after the custom chip so the row reads "pick a new one → the ones you already picked".
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
  // Row 1: inherit ('') + the 11 palette keys + explicit none — a fixed set, so it's built once per
  // theme. Row 2: the custom picker plus recently-used custom colours, which are NOT fixed (see
  // features/color-recents.ts), so it's rebuilt on every sync — a colour picked from the sheet has to
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
  // active swatch = the value shared by every target; mixed (or nothing) → the inherit swatch.
  function markSwatch(): void {
    const colors = new Set(getIds().map(id => state.nodes.get(id)?.color || ''));
    markSwatchRow(els.colors, colors.size === 1 ? ([...colors][0] || '') : '');
  }

  // ---- checklist toggle (set on every target; mixed → indeterminate) ----
  function setChecklist(on: boolean): void {
    const ids = getIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
    record(ids, () => {
      for (const id of ids){ const n = state.nodes.get(id); if (n){ n.checklist = on; n.dirty = true; } }
    });
    markChecklist();
    paintAll(); scheduleSave();
  }
  function markChecklist(): void {
    const vals = new Set(getIds().map(id => !!state.nodes.get(id)?.checklist));
    els.checklist.indeterminate = vals.size > 1;
    els.checklist.checked = vals.size === 1 && [...vals][0];
  }
  els.checklist.addEventListener('change', () => setChecklist(els.checklist.checked));

  // ---- tags: emoji pills + a trailing "+" that opens the shared MRU picker (features/emoji-picker.ts).
  // Tags are per-card, so they only apply to a single target. Optional: this factory is only used
  // by the outline properties sheet — the canvas card renders its own tag row directly (main.ts),
  // matching how the card's own pill click removes a tag instead of going through a shared control.
  function renderTagRow(): void {
    if (!els.tagRow) return;
    const ids = getIds();
    const n = ids.length === 1 ? state.nodes.get(ids[0]) : undefined;
    const tags = n ? n.tags : [];
    els.tagRow.innerHTML = tags.map(t => tagPillHTML(t, ' data-removable')).join('') +
      `<button type="button" class="tag-add-btn" title="Add tag" aria-label="Add tag">+</button>`;
    els.tagRow.querySelectorAll<HTMLElement>('.tag-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        if (!n || isLockedEffective(n)) return;
        setTagOnNodes([n.id], pill.dataset.tag!, false);
        renderTagRow();
      });
    });
    const addBtn = els.tagRow.querySelector<HTMLButtonElement>('.tag-add-btn')!;
    addBtn.addEventListener('click', () => { if (n && !isLockedEffective(n)) openEmojiPicker(addBtn, [n.id], renderTagRow); });
  }

  function sync(): void {
    renderRecents();   // the offered set depends on the open MAP, so re-derive it whenever we're shown
    markSwatch();
    markChecklist();
    renderTagRow();
  }

  rebuildSwatches();
  const panel = { sync, rebuildSwatches };
  panels.push(panel);
  return panel;
}
