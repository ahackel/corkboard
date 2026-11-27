// The floating bar's colour swatch row (#floatBar), plus the row helpers the canvas colour picker shares.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { mutate } from './mutate.js';
import { paintAll, effectiveColor } from '../render.js';
import { isHexColor } from '../utils/ink.js';
import { recentColors, rememberColor } from './color-recents.js';
import { SWATCH_BG, PICKER_ROWS } from '../view/color.js';

export interface PropEls {
  colors: HTMLElement;
}

export interface PropertyControls {
  sync(): void;
  setColor(color: string): void;   // one undo step
}

// Where the native sheet opens before anything custom is picked (rather than on black).
const CUSTOM_FALLBACK = '#3f8cff';
const NO_CHIP = '\u0000';

// 'default' (the map's canvas) adds a reset chip.
export type FirstChip = 'inherit' | 'default';

// Row breaks are elements inside ONE flex container, so every chip stays a sibling for the delegated
// click handler and the `.swatch.active` lookups.
export function paletteChipsHTML(): string {
  const chip = (c: string): string => `<div class="swatch" data-color="${c}" title="${c}" style="--sw:${SWATCH_BG[c]}"></div>`;
  return PICKER_ROWS.map(row => row.map(chip).join('')).join(`<span class="swatch-break"></span>`);
}

export function swatchRowHTML(first: FirstChip): string {
  let html = paletteChipsHTML();

  // A <label> WRAPPING the input is the one form iOS opens natively from a single tap.
  html += `<label class="swatch custom" title="custom colour — any colour you like">`
    + `<input type="color" value="${CUSTOM_FALLBACK}" aria-label="Custom colour"></label>`;
  if (first === 'default') {
    html += `<span class="swatch-break"></span><div class="swatch" data-color="" title="default map colour" style="--sw:var(--bg)"></div>`;
  }
  return html;
}

export function renderRecentChips(colors: HTMLElement): void {
  colors.querySelectorAll('.swatch.recent').forEach(el => el.remove());
  for (const c of recentColors()) {
    colors.insertAdjacentHTML('beforeend',
      `<div class="swatch recent" data-color="${c}" title="${c}" style="--sw:${c}"></div>`);
  }
}

// Ring the chip carrying `active` ('' → the first chip). The custom chip adopts a hex no recent chip
// carries, since the float bar's trigger mirrors `.swatch.active` and would otherwise read "no colour".
export function markSwatchRow(colors: HTMLElement, active: string): void {
  const custom = colors.querySelector<HTMLElement>('.swatch.custom');
  if (custom) {
    const onRecent = isHexColor(active) && !!colors.querySelector(`.swatch.recent[data-color="${active}"]`);
    const adopt = isHexColor(active) && !onRecent;

    // Deleted, not '': '' is the first chip's value, and both would ring.
    if (adopt) {
      custom.dataset.color = active;
    } else {
      delete custom.dataset.color;
    }
    custom.style.setProperty('--sw', adopt ? active : CUSTOM_FALLBACK);
    custom.classList.toggle('picked', adopt);
    const input = custom.querySelector<HTMLInputElement>('input');
    if (input) {
      input.value = isHexColor(active) ? active : CUSTOM_FALLBACK;
    }
  }
  colors.querySelectorAll<HTMLElement>('.swatch').forEach(sw =>
    sw.classList.toggle('active', sw.dataset.color === active));
}

export function createProperties(els: PropEls, getIds: () => string[]): PropertyControls {
  function rebuildSwatches(): void {
    els.colors.innerHTML = swatchRowHTML('inherit');
    renderRecents();

    // Delegated, so the recents can be re-rendered freely; the custom chip's click opens the sheet.
    els.colors.addEventListener('click', (e) => {
      const sw = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
      if (!sw || sw.classList.contains('custom')) {
        return;
      }
      setColor(sw.dataset.color ?? '');
    });
    bindCustom(els.colors.querySelector<HTMLInputElement>('.swatch.custom input')!);
  }

  function renderRecents(): void { renderRecentChips(els.colors); }

  function setColor(color: string): void {
    const ids = editableIds();
    if (!ids.length) {
      return;
    }
    mutate(ids, () => {
      for (const id of ids) {
        applyColor(id, color);
      }
    }, { reflow: 'paint' });

    // Here, not in applyColor, which also runs for every live-drag `input` event.
    rememberColor(color);
    renderRecents();
    markSwatch();
  }

  function editableIds(): string[] { return getIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); }

  function applyColor(id: string, color: string): void {
    const n = state.nodes.get(id); if (n){ n.color = color; n.dirty = true; }
  }

  // `input` streams during a drag (paint-only preview); `change` commits ONE undo step. The pre-drag
  // colours are rewound first so `record` snapshots the real before-image.
  function bindCustom(input: HTMLInputElement): void {
    let before: Map<string, string> | null = null;
    input.addEventListener('input', () => {
      const ids = editableIds();
      if (!ids.length) {
        return;
      }
      if (!before) {
        before = new Map(ids.map(id => [id, state.nodes.get(id)?.color ?? '']));
      }
      for (const id of ids) {
        applyColor(id, input.value);
      }
      markSwatch();
      paintAll();
    });
    input.addEventListener('change', () => {
      if (!before) {
        return;
      }
      const prev = before; before = null;
      for (const [id, color] of prev) {
        applyColor(id, color);
      }
      setColor(input.value);
    });
  }

  // Rings the colour every target SHOWS (effectiveColor when uncoloured); mixed → nothing rings.
  function markSwatch(): void {
    const colors = new Set(getIds().map(id => { const n = state.nodes.get(id); return n ? n.color || effectiveColor(n) : ''; }));
    markSwatchRow(els.colors, colors.size === 1 ? [...colors][0] : NO_CHIP);
  }

  function sync(): void {
    renderRecents();   // the recents depend on the open map
    markSwatch();
  }

  rebuildSwatches();
  const panel = { sync, setColor };
  return panel;
}
