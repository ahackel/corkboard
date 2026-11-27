// The map settings panel (#settingsPop). Its colour row edits the canvas you're standing on: the open
// section's colour, else the map's own (canvasOwner decides, for this and for the paint alike).
import { state, setStatus, type MindNode, stage } from '../core/state.js';
import { nodeLabel, isLockedEffective, ancestors } from '../utils/model.js';
import { mutate } from './mutate.js';
import { rememberColor } from './color-recents.js';
import { swatchRowHTML, markSwatchRow, renderRecentChips } from './properties.js';
import { paintFreeEdges, useCanvasSurface } from '../view/free-edges.js';
import { paintAll, effectiveColor } from '../render.js';
import { placePopover, placeInViewport, closeOnOutside } from '../utils/dom.js';
import { renderGridControls } from '../view/grid.js';
import { colorFill, THEME_BG } from '../view/color.js';
import { scopeRootNode } from '../nav/scope.js';
import { paleFill, inkFor } from '../utils/ink.js';

const btn = document.getElementById('settingsBtn') as HTMLButtonElement | null;
const pop = document.getElementById('settingsPop');
const colorBtn = document.getElementById('canvasColorBtn');
const colors = document.getElementById('canvasColors');
let built = false;

// The AUTHORED value, not the effective one: an inheriting section shows the stripes, as in the float bar.
function currentColor(): string {
  const owner = canvasOwner();
  return owner ? owner.color : state.canvasColor;
}

function locked(): boolean {
  const owner = canvasOwner();
  return !!owner && isLockedEffective(owner);
}

function applyColor(color: string): void {
  const owner = canvasOwner();
  if (owner) {
    owner.color = color;
    owner.dirty = true;
  } else {
    state.canvasColor = color;
  }
}

// A section's cards inherit its colour, so repaint them all. The map's colour reaches only the background
// and the free edges' labels (ink from canvasSurface); not paintAll, as this runs per pointer move.
function repaint(): void {
  if (canvasOwner()) {
    paintAll();
  } else {
    syncCanvasBackground();
    paintFreeEdges();
  }
}

function setColor(color: string): void {
  const owner = canvasOwner();
  if (owner && isLockedEffective(owner)) { setStatus(`“${nodeLabel(owner)}” is locked`); return; }
  mutate(owner ? [owner.id] : [], () => { applyColor(color); repaint(); }, { reflow: 'none', canvas: !owner });
  rememberColor(color);
  if (colors) { renderRecentChips(colors); markSwatchRow(colors, currentColor()); }
}

export function markCanvasColorBtn(): void {
  const chip = colorBtn?.querySelector<HTMLElement>('.swatch');
  if (!colorBtn || !chip) {
    return;
  }
  const v = currentColor();
  const fill = colorFill(v);
  chip.classList.remove('inherit', 'nofill');
  chip.style.removeProperty('--sw');
  if (v === 'none') {
    chip.classList.add('nofill');
  } else {
    chip.style.setProperty('--sw', fill ?? canvasSurface());
  }
}

// Rebuilt on every open: the first chip depends on where you stand, and the recents on the open map.
function build(): void {
  if (!colors) {
    return;
  }
  colors.innerHTML = swatchRowHTML(canvasOwner() ? 'inherit' : 'default');
  renderRecentChips(colors);
  markSwatchRow(colors, currentColor());
  if (built) {
    return;
  }
  built = true;
  colors.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
    if (!sw) {
      return;
    }
    // Its click opens the native sheet; closing here would tear the row down mid-choice.
    if (sw.classList.contains('custom')) {
      return;
    }
    setColor(sw.dataset.color ?? '');
    closeSubs();
  });
  bindCustom();
}

// `input` previews live (paint only); `change` commits ONE undo step, so the pre-drag value is rewound
// first for the history's snapshot. On the ROW, not the input: build() replaces the input on every open.
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
    if (!input || locked()) {
      return;
    }
    if (before === null) {
      before = currentColor();
    }
    applyColor(input.value);
    repaint();
    markSwatchRow(row, currentColor());
  });
  row.addEventListener('change', (e) => {
    const input = picker(e);
    if (!input || before === null) {
      return;
    }
    const prev = before; before = null;
    applyColor(prev);
    setColor(input.value);
  });
}

// Each [data-pop] button opens the popover it names, nested in the panel so a click in it counts as inside.
const dropdowns = (): HTMLElement[] => [...(pop?.querySelectorAll<HTMLElement>('[data-pop]') ?? [])];

function closeSubs(): void {
  for (const b of dropdowns()) {
    document.getElementById(b.dataset.pop!)?.classList.remove('open');
    b.setAttribute('aria-expanded', 'false');
  }
}

function close(): void {
  closeSubs();
  pop?.classList.remove('open');
  btn?.setAttribute('aria-expanded', 'false');
}

export function openSettings(): void {
  if (!pop || !btn) {
    return;
  }
  const owner = canvasOwner();
  const head = document.getElementById('setColorHead');
  if (head) {
    head.textContent = owner ? `Colour of “${nodeLabel(owner)}”` : 'Canvas colour';
  }
  markCanvasColorBtn();
  renderGridControls();
  pop.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  placePopover(pop, btn, document.getElementById('dock') ?? btn);
}

function toggle(): void {
  if (pop?.classList.contains('open')) {
    close();
  } else {
    openSettings();
  }
}

const SUB_GAP = 8, SUB_MARGIN = 4;

export function installCanvasColor(): void {
  useCanvasSurface(canvasSurface);
  if (!btn || !pop) {
    return;
  }
  btn.onclick = (e) => { e.stopPropagation(); toggle(); };
  closeOnOutside(pop, btn, close);
  for (const b of dropdowns()) {
    const sub = document.getElementById(b.dataset.pop!)!;
    b.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = sub.classList.contains('open');
      closeSubs();
      if (wasOpen) {
        return;
      }
      if (b === colorBtn) {
        build();
      }
      sub.classList.add('open');
      b.setAttribute('aria-expanded', 'true');
      // Bottom-aligned beside its field, as the panel sits low: right if it fits, else left, else above.
      const r = b.getBoundingClientRect(), w = sub.offsetWidth;
      if (r.right + SUB_GAP + w <= innerWidth - SUB_MARGIN) {
        placeInViewport(sub, r.right + SUB_GAP, r.bottom - sub.offsetHeight);
      } else if (r.left - SUB_GAP - w >= SUB_MARGIN) {
        placeInViewport(sub, r.left - SUB_GAP - w, r.bottom - sub.offsetHeight);
      } else {
        placePopover(sub, b);
      }
    };
    closeOnOutside(sub, b, closeSubs);
  }
  pop.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.set-item')) {
      closeSubs();
    }
  });
}

// Not the hex: effectiveColor falls back to a neutral fill for an uncoloured section, which must not
// paint the canvas, while a section explicitly coloured white still tints.
function hasAuthoredColor(n: MindNode): boolean {
  return [n, ...ancestors(n)].some(a => !!a.color);
}

// Whose colour the canvas shows and the button edits: the open section, or null for the map itself.
export const canvasOwner = (): MindNode | null => scopeRootNode();

// null: the theme's background shows. An open section wears the PALE wash its box wore; an uncoloured
// one shows whatever is behind IT, the map's colour.
function canvasFill(): string | null {
  const owner = canvasOwner();
  if (!owner || !hasAuthoredColor(owner)) {
    return colorFill(state.canvasColor);
  }
  const fill = colorFill(effectiveColor(owner));
  return fill && paleFill(fill);
}

// What a thing drawn on the canvas (a free edge's label plate) sits on.
export function canvasSurface(): string { return canvasFill() ?? THEME_BG; }

// On #stage, not <body>, so the theme's --bg is untouched. --grid-pat re-derives the theme's 55/45 grid
// recipe from the real fill and its ink, since the theme's grid ink is invisible or harsh on a colour.
export function syncCanvasBackground(): void {
  const fill = canvasFill();
  if (fill) {
    stage.style.setProperty('--canvas-bg', fill);
    stage.style.setProperty('--grid-pat', `color-mix(in srgb, ${fill} 55%, ${inkFor(fill)} 45%)`);
  } else {
    stage.style.removeProperty('--canvas-bg');
    stage.style.removeProperty('--grid-pat');
  }
  markCanvasColorBtn();
  syncThemeColor(fill);
}

// The browser's theme colour follows the canvas. A fill can be a CSS variable, which a meta tag can't read:
// resolve it on a hidden probe, not off #stage, whose background is mid-transition after a change.
const themeMeta = document.querySelector('meta[name="theme-color"]');
let themeProbe: HTMLElement | null = null;
let lastThemeFill: string | null | undefined = '\0';

function syncThemeColor(fill: string | null | undefined): void {
  // Every paintAll asks; a computed-style read right after its writes would restyle the board.
  if (!themeMeta || fill === lastThemeFill) {
    return;
  }
  lastThemeFill = fill;
  if (!themeProbe) { themeProbe = document.createElement('i'); themeProbe.hidden = true; document.body.append(themeProbe); }
  themeProbe.style.color = fill || 'var(--bg)';
  const rgb = getComputedStyle(themeProbe).color;
  if (themeMeta.getAttribute('content') !== rgb) {
    themeMeta.setAttribute('content', rgb);
  }
}
