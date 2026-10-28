// ============================================================
// The selected EDGE's floating bar: colour ▾ · line style ▾ · ends ▾ · delete (label = double-click).
//
// Its own bar rather than a mode of features/float-bar.ts. That one is keyed on `state.sel` and
// anchored to a CARD from end to end (anchorNode, labelRect, the locked-selection collapse), and an
// edge shares none of its controls — folding two unrelated control sets into one component would
// cost more than the shell it saves. It wears the same chrome, so the two still read as one idea.
//
// It anchors to the MIDPOINT of the curve, tracked across pan/zoom/drag by the same kind of rAF
// follow loop the card bar uses.
// ============================================================
import { state, type EdgeCap } from '../core/state.js';
import { selectedEdges, leadEdge, deleteSelectedEdge } from './edge-tools.js';
import { edgeGeometry, edgeVisible } from '../view/free-edges.js';
import { scheduleSaveBoard } from '../data/board.js';
import { touchEdges, commitStep } from './history.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { byId } from '../utils/dom.js';
import { isInteracting } from './float-bar.js';
import { paletteChipsHTML } from './properties.js';
import { safeInsets } from '../utils/dom.js';
import { chevron } from '../view/icons.js';
import { colorFill } from '../view/color.js';

const bar = byId('edgeBar');
const colorBtn = byId<HTMLButtonElement>('ebColor');
const colorDot = byId('ebColorDot');
const dashBtn = byId<HTMLButtonElement>('ebDash');
const arrowsBtn = byId<HTMLButtonElement>('ebArrows');

const deleteBtn = byId<HTMLButtonElement>('ebDelete');
const colorPop = byId('ebColorPop');
const colorRow = byId('ebColors');
const arrowPop = byId('ebArrowPop');
const arrowChips = byId('ebArrowChips');
const dashPop = byId('ebDashPop');
const dashChips = byId('ebDashChips');

const GAP = 22;   // clear of the end handles (HANDLE_R) and the arrowhead

// Inline SVG rather than the icon sheet: these three are specific to an edge and exist nowhere else,
// and the glyph has to CHANGE with the control's state (a dashed line, one arrowhead or two), which
// a data-icon placeholder can't do.
const SVG = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
const ICON_SOLID  = SVG('<path d="M4 12h16"/>');
const ICON_DASHED = SVG('<path d="M4 12h16" stroke-dasharray="4 3"/>');
// The two ends, drawn as they will look. A cap glyph sits at one end of a short line, and the SHAFT
// is shortened to make room for it — the same relationship the real edge has with its terminators,
// so a chip is a small picture of the result rather than a symbol to be learnt.
const CAP_DOT_R = 2.6;
function capIcon(cap: EdgeCap, end: 'from' | 'to'): string {
  const left = end === 'from';
  const x = left ? 5 : 19;                                   // where the cap sits
  const x1 = left && cap !== 'none' ? 7 : 4;                 // …and where the shaft starts
  const x2 = !left && cap !== 'none' ? 17 : 20;
  const shaft = `<path d="M${x1} 12H${x2}"/>`;
  if (cap === 'dot') return SVG(shaft + `<circle cx="${x}" cy="12" r="${CAP_DOT_R}" fill="currentColor" stroke="none"/>`);
  if (cap === 'arrow') {
    const head = left ? `M9 8l-4 4 4 4` : `M15 8l4 4-4 4`;
    return SVG(shaft + `<path d="${head}"/>`);
  }
  return SVG(shaft);
}
// The BAR's own button shows the pair — the line as it currently ends, at both ends at once.
function endsIcon(from: EdgeCap, to: EdgeCap): string {
  const x1 = from === 'none' ? 4 : 7, x2 = to === 'none' ? 20 : 17;
  let g = `<path d="M${x1} 12H${x2}"/>`;
  if (from === 'dot') g += `<circle cx="5" cy="12" r="${CAP_DOT_R}" fill="currentColor" stroke="none"/>`;
  if (from === 'arrow') g += `<path d="M9 8l-4 4 4 4"/>`;
  if (to === 'dot') g += `<circle cx="19" cy="12" r="${CAP_DOT_R}" fill="currentColor" stroke="none"/>`;
  if (to === 'arrow') g += `<path d="M15 8l4 4-4 4"/>`;
  return SVG(g);
}
// Each end offers the same three, and they are chosen INDEPENDENTLY: one axis of three values could
// never say "a dot here, an arrow there", which is an ordinary thing a diagram wants to say.
const CAP_CHOICES: Array<{ key: EdgeCap; label: string }> = [
  { key: 'none',  label: 'Bare' },
  { key: 'dot',   label: 'Dot — attaches here, no direction' },
  { key: 'arrow', label: 'Arrow' },
];
const CAP_NAME: Record<EdgeCap, string> = { none: 'bare', dot: 'dot', arrow: 'arrow' };
const ICON_TRASH = SVG('<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>');

let wired = false;
function wire(): void {
  if (wired) return; wired = true;
  deleteBtn.innerHTML = ICON_TRASH;

  // Every control acts on the WHOLE selection, and sets one VALUE across it rather than toggling
  // each edge's own — three lines where two are dashed become three dashed lines, not two solid and
  // one dashed. The lead edge (the last one clicked, whose state the button shows) decides which
  // value that is, so the button does what it looks like it will do.
  dashBtn.onclick = (ev) => { ev.stopPropagation(); dashPop.classList.contains('open') ? closeDashPop() : openDashPop(); };
  dashChips.onclick = (ev) => {
    const chip = (ev.target as Element).closest<HTMLElement>('[data-dash]');
    const es = selectedEdges(); if (!chip || !es.length) return;
    const want = chip.dataset.dash === '1';
    touchEdges();
    for (const e of es) e.dashed = want;
    closeDashPop(); commit(); commitStep();
  };
  arrowsBtn.onclick = (ev) => { ev.stopPropagation(); arrowPop.classList.contains('open') ? closeArrowPop() : openArrowPop(); };
  arrowChips.onclick = (ev) => {
    const chip = (ev.target as Element).closest<HTMLElement>('[data-cap]');
    const col = chip?.closest<HTMLElement>('[data-end]');
    const es = selectedEdges(); if (!chip || !col || !es.length) return;
    const cap = chip.dataset.cap as EdgeCap;
    touchEdges();
    // The picker stays OPEN: the two ends are two choices, and closing after the first would make
    // setting both a matter of reopening the same menu.
    for (const e of es) { if (col.dataset.end === 'from') e.fromCap = cap; else e.toCap = cap; }
    commit(); openArrowPop();
    commitStep();
  };
  deleteBtn.onclick = () => { deleteSelectedEdge(); };

  colorBtn.onclick = (ev) => { ev.stopPropagation(); colorPop.classList.contains('open') ? closeColorPop() : openColorPop(); };
  colorRow.onclick = (ev) => {
    const sw = (ev.target as Element).closest<HTMLElement>('[data-color]');
    const es = selectedEdges(); if (!sw || !es.length) return;
    touchEdges();
    for (const e of es) e.color = sw.dataset.color!;
    closeColorPop(); commit(); commitStep();
  };
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target as Node;
    if (colorPop.classList.contains('open') && !colorPop.contains(t) && !colorBtn.contains(t)) closeColorPop();
    if (arrowPop.classList.contains('open') && !arrowPop.contains(t) && !arrowsBtn.contains(t)) closeArrowPop();
    if (dashPop.classList.contains('open') && !dashPop.contains(t) && !dashBtn.contains(t)) closeDashPop();
  }, true);
}
function commit(): void {
  scheduleSaveBoard();
  paintFreeEdges();
  syncControls();
}

function openColorPop(): void {
  // No separate "default" chip: the default ink IS the palette's `stone`, so that chip puts a coloured
  // line back to how it looked.
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
// Line style: a menu of the two, each drawn as it looks — the same dropdown every picker in the bar is.
function openDashPop(): void {
  const dashed = leadEdge()?.dashed ?? false;
  dashChips.innerHTML = [{ v: false, icon: ICON_SOLID, label: 'Solid' }, { v: true, icon: ICON_DASHED, label: 'Dashed' }]
    .map(c => `<button class="layoutchip${c.v === dashed ? ' active' : ''}" data-dash="${c.v ? 1 : 0}" title="${c.label}">${c.icon}</button>`).join('');
  dashPop.classList.add('open');
  placePop(dashPop, dashBtn);
}
function closeDashPop(): void { dashPop.classList.remove('open'); }
// A picker opens on the side of the bar AWAY from the line (barAbove, set by place()), so it never
// covers what it's changing either.
let barAbove = true;
function placePop(pop: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect(), br = bar.getBoundingClientRect();
  pop.style.left = Math.max(8, r.left + r.width / 2 - pop.offsetWidth / 2) + 'px';
  pop.style.top = (barAbove ? br.top - pop.offsetHeight - 8 : br.bottom + 8) + 'px';
}
function placeColorPop(): void { placePop(colorPop, colorBtn); }

function syncControls(): void {
  const e = leadEdge(); if (!e) return;
  colorDot.style.setProperty('--sw', colorFill(e.color) ?? 'var(--edge)');
  dashBtn.innerHTML = (e.dashed ? ICON_DASHED : ICON_SOLID) + chevron();
  dashBtn.title = e.dashed ? 'Line style: dashed' : 'Line style: solid';
  arrowsBtn.innerHTML = endsIcon(e.fromCap, e.toCap) + chevron();
  arrowsBtn.title = `Ends: ${CAP_NAME[e.fromCap]} → ${CAP_NAME[e.toCap]}`;
}

// The whole line's bounds in SCREEN space — what the bar hangs clear of. Returns null when the edge has
// gone (deleted, or an endpoint hidden), which is what closes the bar.
function lineBox(): { x0: number; y0: number; x1: number; y1: number } | null {
  const e = leadEdge();
  if (!e || !edgeVisible(e)) return null;
  const g = edgeGeometry(e); if (!g) return null;
  const k = state.view.k, sx = (x: number): number => x * k + state.view.x, sy = (y: number): number => y * k + state.view.y;
  return { x0: sx(g.box.x0), y0: sy(g.box.y0), x1: sx(g.box.x1), y1: sy(g.box.y1) };
}

// FigJam's placement: ABOVE the whole line, centred on it, never on top of it — the bar is for the line,
// and covering it hides what you're changing. Below it when there's no room above.
function place(): boolean {
  const b = lineBox(); if (!b) return false;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = b.y0 - bh - GAP;
  barAbove = top >= safeInsets().top + 4;
  if (!barAbove) top = b.y1 + GAP;
  const left = Math.min(Math.max(8, (b.x0 + b.x1) / 2 - bw / 2), window.innerWidth - bw - 8);
  bar.style.left = left + 'px';
  bar.style.top = Math.min(top, window.innerHeight - bh - 8) + 'px';
  if (colorPop.classList.contains('open')) placeColorPop();
  if (arrowPop.classList.contains('open')) placePop(arrowPop, arrowsBtn);
  if (dashPop.classList.contains('open')) placePop(dashPop, dashBtn);
  return true;
}

let raf: number | null = null;
function followLoop(): void {
  if (!bar.classList.contains('open')) { raf = null; return; }
  if (!place()) { hide(); return; }
  if (editingId) placeLabelEdit();
  const busy = isInteracting();
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

// Called from applySelection / paintFreeEdges' callers whenever the edge selection may have changed.
export function syncEdgeBar(): void {
  wire();
  const e = leadEdge();
  if (!e || state.readOnly || !edgeVisible(e)) { hide(); return; }
  syncControls();
  bar.classList.add('open');
  if (!place()) { hide(); return; }
  if (raf == null) followLoop();
}
// ---------- the label, edited IN PLACE ----------
// Double-clicking an edge opens a small field over the line's midpoint, where the label already is
// (or is about to be) — the same gesture that opens a card's own text, and it puts the caret exactly
// where the result will appear rather than in a bar off to one side.
const labelEdit = byId<HTMLInputElement>('ebLabelEdit');
let editingId: string | null = null;
let labelBefore = '';

export function startLabelEdit(edgeId: string): void {
  if (state.readOnly) return;
  const e = state.edges.find(x => x.id === edgeId); if (!e || !edgeVisible(e)) return;
  editingId = edgeId;
  touchEdges();                       // one undo step for the whole editing session
  labelBefore = e.label;
  labelEdit.value = e.label;
  labelEdit.classList.add('open');
  placeLabelEdit();
  labelEdit.focus(); labelEdit.select();
}
// The field is a fixed-position HTML element while the label it stands in for is SVG inside #world —
// so everything about it has to be scaled by the zoom BY HAND, or the two are the same size only at
// 100%: typing at 60% showed big text that shrank the moment it was committed, which reads as the
// edit having changed something. Font, width and padding all take the same k.
const LABEL_PX = 14;                 // must match .fe-label's font-size (styles.css)
function placeLabelEdit(): void {
  const e = editingId ? state.edges.find(x => x.id === editingId) : null; if (!e) return;
  const g = edgeGeometry(e); if (!g) return;
  const k = state.view.k || 1;
  const x = g.mid.x * state.view.k + state.view.x, y = g.mid.y * state.view.k + state.view.y;
  labelEdit.style.fontSize = (LABEL_PX * k) + 'px';
  labelEdit.style.padding = `${2 * k}px ${6 * k}px`;
  // Grow with the text so the field is never narrower than what it holds — the same estimate the
  // label's own plate is sized by (view/free-edges.ts), in world px, brought into screen px.
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
    // typing wrote the label live, so a cancel has to put it back
    e.label = labelBefore;
  }
  paintFreeEdges();
  commitStep();                       // a cancelled edit nets no change, so the step discards itself
}
labelEdit.addEventListener('input', () => {
  const e = editingId ? state.edges.find(x => x.id === editingId) : null; if (!e) return;
  e.label = labelEdit.value;          // live on the line, like a card's inline edit
  paintFreeEdges();
  placeLabelEdit();
});
labelEdit.addEventListener('keydown', (ev) => {
  ev.stopPropagation();               // canvas shortcuts stay out of a text field
  if (ev.key === 'Enter') { ev.preventDefault(); endLabelEdit(true); }
  else if (ev.key === 'Escape') { ev.preventDefault(); endLabelEdit(false); }
});
labelEdit.addEventListener('blur', () => endLabelEdit(true));
