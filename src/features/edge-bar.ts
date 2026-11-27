// The selected line's floating bar (colour, line style, ends) and its label editor. Not a mode of
// float-bar.ts: that one is anchored to a CARD throughout, and shares none of these controls.
import { state, type EdgeCap, type BoardEdge } from '../core/state.js';
import { canvasMoving } from '../core/ui-state.js';
import { selectedEdges, leadEdge } from './edge-tools.js';
import { edgeGeometry, edgeVisible } from '../view/free-edges.js';
import { scheduleSaveBoard } from '../data/board.js';
import { touchEdges, commitStep } from './history.js';
import { mutate } from './mutate.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { paletteChipsHTML } from './properties.js';
import { byId, safeInsets, placeInViewport, placePopover, closeOnOutside } from '../utils/dom.js';
import { chevron } from '../view/icons.js';
import { colorFill } from '../view/color.js';

const bar = byId('edgeBar');
const colorBtn = byId<HTMLButtonElement>('ebColor');
const colorDot = byId('ebColorDot');
const dashBtn = byId<HTMLButtonElement>('ebDash');
const arrowsBtn = byId<HTMLButtonElement>('ebArrows');

const colorPop = byId('ebColorPop');
const colorRow = byId('ebColors');
const arrowPop = byId('ebArrowPop');
const arrowChips = byId('ebArrowChips');
const dashPop = byId('ebDashPop');
const dashChips = byId('ebDashChips');

// Clear of the end handles (HANDLE_R) and the arrowhead.
const GAP = 22;

// Inline, not the icon sheet: the glyph CHANGES with the control's state.
const SVG = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
const ICON_SOLID  = SVG('<path d="M4 12h16"/>');
const ICON_DASHED = SVG('<path d="M4 12h16" stroke-dasharray="4 3"/>');
const CAP_DOT_R = 2.6;

// The shaft is shortened to make room for the cap, as on the real line.
function capIcon(cap: EdgeCap, end: 'from' | 'to'): string {
  const left = end === 'from';
  const capX = left ? 5 : 19;
  const x1 = left && cap !== 'none' ? 7 : 4;
  const x2 = !left && cap !== 'none' ? 17 : 20;
  const shaft = `<path d="M${x1} 12H${x2}"/>`;
  if (cap === 'dot') {
    return SVG(shaft + `<circle cx="${capX}" cy="12" r="${CAP_DOT_R}" fill="currentColor" stroke="none"/>`);
  }
  if (cap === 'arrow') {
    const head = left ? `M9 8l-4 4 4 4` : `M15 8l4 4-4 4`;
    return SVG(shaft + `<path d="${head}"/>`);
  }
  return SVG(shaft);
}

function endsIcon(from: EdgeCap, to: EdgeCap): string {
  const x1 = from === 'none' ? 4 : 7, x2 = to === 'none' ? 20 : 17;
  let g = `<path d="M${x1} 12H${x2}"/>`;
  if (from === 'dot') {
    g += `<circle cx="5" cy="12" r="${CAP_DOT_R}" fill="currentColor" stroke="none"/>`;
  }
  if (from === 'arrow') {
    g += `<path d="M9 8l-4 4 4 4"/>`;
  }
  if (to === 'dot') {
    g += `<circle cx="19" cy="12" r="${CAP_DOT_R}" fill="currentColor" stroke="none"/>`;
  }
  if (to === 'arrow') {
    g += `<path d="M15 8l4 4-4 4"/>`;
  }
  return SVG(g);
}

// Chosen per end, independently.
const CAP_CHOICES: Array<{ key: EdgeCap; label: string }> = [
  { key: 'none',  label: 'Bare' },
  { key: 'dot',   label: 'Dot — attaches here, no direction' },
  { key: 'arrow', label: 'Arrow' },
];
const CAP_NAME: Record<EdgeCap, string> = { none: 'bare', dot: 'dot', arrow: 'arrow' };

let wired = false;

function wire(): void {
  if (wired) {
    return;
  }
  wired = true;

  // Each control SETS one value across the selection, the one the lead edge shows, rather than toggling.
  dashBtn.onclick = (ev) => { ev.stopPropagation(); dashPop.classList.contains('open') ? closeDashPop() : openDashPop(); };
  dashChips.onclick = (ev) => {
    const chip = (ev.target as Element).closest<HTMLElement>('[data-dash]');
    const es = selectedEdges();
    if (!chip || !es.length) {
      return;
    }
    const want = chip.dataset.dash === '1';
    editEdges(e => { e.dashed = want; });
    closeDashPop();
  };
  arrowsBtn.onclick = (ev) => { ev.stopPropagation(); arrowPop.classList.contains('open') ? closeArrowPop() : openArrowPop(); };
  arrowChips.onclick = (ev) => {
    const chip = (ev.target as Element).closest<HTMLElement>('[data-cap]');
    const col = chip?.closest<HTMLElement>('[data-end]');
    const es = selectedEdges();
    if (!chip || !col || !es.length) {
      return;
    }
    const cap = chip.dataset.cap as EdgeCap;
    editEdges(e => {
      if (col.dataset.end === 'from') {
        e.fromCap = cap;
      } else {
        e.toCap = cap;
      }
    });
    // Stays open: the two ends are two choices.
    openArrowPop();
  };

  colorBtn.onclick = (ev) => { ev.stopPropagation(); colorPop.classList.contains('open') ? closeColorPop() : openColorPop(); };
  colorRow.onclick = (ev) => {
    const sw = (ev.target as Element).closest<HTMLElement>('[data-color]');
    const es = selectedEdges();
    if (!sw || !es.length) {
      return;
    }
    editEdges(e => { e.color = sw.dataset.color!; });
    closeColorPop();
  };
  closeOnOutside(colorPop, colorBtn, closeColorPop);
  closeOnOutside(arrowPop, arrowsBtn, closeArrowPop);
  closeOnOutside(dashPop, dashBtn, closeDashPop);
}

function editEdges(set: (e: BoardEdge) => void): void {
  mutate([], () => { selectedEdges().forEach(set); }, { edges: true, reflow: 'none' });
  paintFreeEdges();
  syncControls();
}

function openColorPop(): void {
  // No "default" chip: the default ink IS the palette's `stone`.
  colorRow.innerHTML = paletteChipsHTML();
  colorPop.classList.add('open');
  placeColorPop();
}

function closeColorPop(): void { colorPop.classList.remove('open'); }

function openArrowPop(): void {
  const e = leadEdge();
  const cur: Record<'from' | 'to', EdgeCap> = { from: e?.fromCap ?? 'none', to: e?.toCap ?? 'arrow' };
  arrowChips.innerHTML = (['from', 'to'] as const).map(end =>
    `<div class="layoutchips" data-end="${end}">` + CAP_CHOICES.map(c =>
      `<button class="layoutchip${c.key === cur[end] ? ' active' : ''}" data-cap="${c.key}" ` +
      `title="${end === 'from' ? 'Start' : 'End'}: ${c.label}">${capIcon(c.key, end)}</button>`).join('') +
    `</div>`).join('');
  arrowPop.classList.add('open');
  placePop(arrowPop, arrowsBtn);
}

function closeArrowPop(): void { arrowPop.classList.remove('open'); }

function openDashPop(): void {
  const dashed = leadEdge()?.dashed ?? false;
  dashChips.innerHTML = [{ v: false, icon: ICON_SOLID, label: 'Solid' }, { v: true, icon: ICON_DASHED, label: 'Dashed' }]
    .map(c => `<button class="layoutchip${c.v === dashed ? ' active' : ''}" data-dash="${c.v ? 1 : 0}" title="${c.label}">${c.icon}</button>`).join('');
  dashPop.classList.add('open');
  placePop(dashPop, dashBtn);
}

function closeDashPop(): void { dashPop.classList.remove('open'); }

// Pickers open on the side of the bar AWAY from the line, never covering it.
let barAbove = true;
const placePop = (pop: HTMLElement, anchor: HTMLElement): void => placePopover(pop, anchor, bar, !barAbove);

function placeColorPop(): void { placePop(colorPop, colorBtn); }

function syncControls(): void {
  const e = leadEdge();
  if (!e) {
    return;
  }
  colorDot.style.setProperty('--sw', colorFill(e.color) ?? 'var(--edge)');
  dashBtn.innerHTML = (e.dashed ? ICON_DASHED : ICON_SOLID) + chevron();
  dashBtn.title = e.dashed ? 'Line style: dashed' : 'Line style: solid';
  arrowsBtn.innerHTML = endsIcon(e.fromCap, e.toCap) + chevron();
  arrowsBtn.title = `Ends: ${CAP_NAME[e.fromCap]} → ${CAP_NAME[e.toCap]}`;
}

// In SCREEN space; null once the line has gone or is hidden, which closes the bar.
function lineBox(): { x0: number; y0: number; x1: number; y1: number } | null {
  const e = leadEdge();
  if (!e || !edgeVisible(e)) {
    return null;
  }
  const g = edgeGeometry(e);
  if (!g) {
    return null;
  }
  const k = state.view.k, sx = (x: number): number => x * k + state.view.x, sy = (y: number): number => y * k + state.view.y;
  return { x0: sx(g.box.x0), y0: sy(g.box.y0), x1: sx(g.box.x1), y1: sy(g.box.y1) };
}

// FigJam's: centred above the whole line, never on it; below when there's no room above.
function place(): boolean {
  const b = lineBox();
  if (!b) {
    return false;
  }
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = b.y0 - bh - GAP;
  barAbove = top >= safeInsets().top + 4;
  if (!barAbove) {
    top = b.y1 + GAP;
  }
  placeInViewport(bar, (b.x0 + b.x1) / 2 - bw / 2, top, 8);
  if (colorPop.classList.contains('open')) {
    placeColorPop();
  }
  if (arrowPop.classList.contains('open')) {
    placePop(arrowPop, arrowsBtn);
  }
  if (dashPop.classList.contains('open')) {
    placePop(dashPop, dashBtn);
  }
  return true;
}

let raf: number | null = null;

function followLoop(): void {
  if (!bar.classList.contains('open')) { raf = null; return; }
  if (!place()) { hide(); return; }
  if (editingId) {
    placeLabelEdit();
  }
  const busy = canvasMoving();
  bar.classList.toggle('hide-interact', busy);
  colorPop.classList.toggle('hide-interact', busy);
  arrowPop.classList.toggle('hide-interact', busy);
  dashPop.classList.toggle('hide-interact', busy);
  raf = requestAnimationFrame(followLoop);
}

function hide(): void {
  bar.classList.remove('open');
  closeColorPop(); closeArrowPop(); closeDashPop();
  if (raf != null) { cancelAnimationFrame(raf); raf = null; }
}

export function syncEdgeBar(): void {
  wire();
  const e = leadEdge();
  if (!e || !edgeVisible(e)) { hide(); return; }
  syncControls();
  bar.classList.add('open');
  if (!place()) { hide(); return; }
  if (raf == null) {
    followLoop();
  }
}

// The label is edited in place, over the line's midpoint.
const labelEdit = byId<HTMLInputElement>('ebLabelEdit');
let editingId: string | null = null;
let labelBefore = '';

export function startLabelEdit(edgeId: string): void {
  const e = state.edges.find(x => x.id === edgeId);
  if (!e || !edgeVisible(e)) {
    return;
  }
  editingId = edgeId;
  touchEdges();
  labelBefore = e.label;
  labelEdit.value = e.label;
  labelEdit.classList.add('open');
  placeLabelEdit();
  labelEdit.focus(); labelEdit.select();
}

// Must match .fe-label's font-size (styles.css).
const LABEL_PX = 14;

// A fixed HTML field standing in for SVG inside #world, so it is scaled by the zoom BY HAND.
function placeLabelEdit(): void {
  const e = editingId ? state.edges.find(x => x.id === editingId) : null;
  if (!e) {
    return;
  }
  const g = edgeGeometry(e);
  if (!g) {
    return;
  }
  const k = state.view.k || 1;
  const x = g.mid.x * state.view.k + state.view.x, y = g.mid.y * state.view.k + state.view.y;
  labelEdit.style.fontSize = (LABEL_PX * k) + 'px';
  labelEdit.style.padding = `${2 * k}px ${6 * k}px`;
  // The same width estimate the label's plate is sized by (view/free-edges.ts).
  labelEdit.style.width = (Math.max(56, labelEdit.value.length * 8 + 16) * k) + 'px';
  labelEdit.style.left = (x - labelEdit.offsetWidth / 2) + 'px';
  labelEdit.style.top = (y - labelEdit.offsetHeight / 2) + 'px';
}

function endLabelEdit(commitIt: boolean): void {
  if (!editingId) {
    return;
  }
  const e = state.edges.find(x => x.id === editingId);
  editingId = null;
  labelEdit.classList.remove('open');
  if (e && commitIt) {
    e.label = labelEdit.value.trim();
    scheduleSaveBoard();
  } else if (e) {
    // Typing wrote the label live.
    e.label = labelBefore;
  }
  paintFreeEdges();
  commitStep();
}

export function installEdgeBar(): void {
  labelEdit.addEventListener('input', () => {
    const e = editingId ? state.edges.find(x => x.id === editingId) : null;
    if (!e) {
      return;
    }
    e.label = labelEdit.value;
    paintFreeEdges();
    placeLabelEdit();
  });
  labelEdit.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); endLabelEdit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); endLabelEdit(false); }
  });
  labelEdit.addEventListener('blur', () => endLabelEdit(true));
}
