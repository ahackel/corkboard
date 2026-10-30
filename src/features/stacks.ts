// ---------- STACKS: a section drawn as a PILE of its cards ----------
// Hold a dragged card over another for a moment and the two become a stack, like the Dock's; drop more cards
// on the pile and they go on top. It's a SECTION all the same — a folder of its cards on disk — that shows
// its cards lying on top of each other instead of sitting in a box (core/state.ts isStack).
//   · the pile shows its top card, two more peeking out behind it, a pushpin and how many it holds
//   · a CLICK fans it out over the board; dragging the pile's BODY lifts its top card off; dragging the PIN
//     moves the whole stack
//   · down to one card, it's no stack any more: the last card is left lying where the pile was
// Where its cards lie, piled or fanned, is view/pile.ts.
import { state, stage, setStatus, isStack, isImageCard, type MindNode } from '../core/state.js';
import { ui, type Drag, type Pt } from '../core/ui-state.js';
import { childrenOf, isHidden, isLockedEffective, nodeLabel, nodesOf } from '../utils/model.js';
import { cardMarkdown } from '../utils/frontmatter.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { trackPointer } from '../utils/dom.js';
import { pileKids, topOfPile, jitter, fanSlotAt, fanTilt, FAN_ARC_MAX } from '../view/pile.js';
import { nodeW, nodeH, imageLook, gridSnap } from '../view/geometry.js';
import { moveSubtreeTo } from '../view/layout.js';
import { screenToWorld, frameBox } from '../view/camera.js';
import { applyColorVars, colorClass } from '../view/color.js';
import { SPACING } from '../utils/guides.js';
import { effectiveColor, paintAll, paintNode, relayout, remeasure, animateLayout } from '../main.js';
import { startNodeDrag, feedDragMove, commitDrag } from './drag.js';
import { mkNode, deleteNodes } from './crud.js';
import { touch, record } from './history.js';
import { hydrateImages } from './images.js';
import { selectedIds, setSelectionSet } from './selection.js';
import { MIN_SECTION_W, MIN_SECTION_H } from './resize.js';
import { growSectionsToHold } from './float-bar.js';
import { scheduleSave } from '../data/save.js';

// How long a dragged card rests on another before letting go makes the two a stack. A quick pass over a
// card is just a pass: the cards overlap, as they always have.
export const PILE_HOVER_MS = 400;

// The cards drawn in the pile: the top one, and two peeking out from under it.
const PILE_SHOWN = 3;

// A red pushpin, seen from above: the stack's handle (styles.css .stack-pin).
const PIN_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#e5383b"/>`
  + `<circle cx="12" cy="12" r="8" fill="none" stroke="#a4161a" stroke-width="1.2"/>`
  + `<circle cx="9.2" cy="9" r="2.6" fill="#fff" opacity=".55"/></svg>`;

// ---------- the pile ----------
// A stack's face, inside its own element: its top cards as plain drawings (they're not nodes on the board
// while piled — isHidden says so), the pin and the count. Built once and refreshed on every paint, each
// card's text keyed on its markdown the way paintNode keys a card's own. Anything that stops being a stack
// (Turn into section, an undo) drops its face here too.
export function paintPile(n: MindNode, el: HTMLElement): void {
  let face = el.querySelector<HTMLElement>(':scope > .stack-face');
  if (!isStack(n)) {
    face?.remove();
    return;
  }
  if (!face) {
    face = document.createElement('div');
    face.className = 'stack-face';
    face.innerHTML = `<div class="pile"></div><span class="stack-count"></span>`
      + `<span class="stack-pin" title="Drag to move the stack">${PIN_SVG}</span>`;
    el.appendChild(face);
  }
  const kids = pileKids(n);
  const shown = kids.slice(-PILE_SHOWN);
  const pile = face.querySelector<HTMLElement>(':scope > .pile')!;
  while (pile.children.length > shown.length) {
    pile.lastElementChild!.remove();
  }
  while (pile.children.length < shown.length) {
    pile.insertAdjacentHTML('beforeend', '<div class="pile-card"><div class="body"></div></div>');
  }
  shown.forEach((k, i) => {
    const card = pile.children[i] as HTMLElement;
    const under = shown.length - 1 - i;   // 0 = the top card
    const col = effectiveColor(k);
    card.className = 'pile-card ' + colorClass(col) + (imageLook(k) ? ' image-card' : '') + (under ? ' under' : '');
    applyColorVars(card, col);
    card.style.width = nodeW(k) + 'px';
    card.style.height = isImageCard(k) ? nodeH(k) + 'px' : '';
    card.style.minHeight = !under && !isImageCard(k) && k.h != null ? k.h + 'px' : '';

    // The mess: the cards underneath lie askew and a little off, the top one nearly square.
    const tilt = jitter(k, 1) * (under ? 5 : 1.2);
    card.style.rotate = tilt.toFixed(2) + 'deg';
    card.style.translate = under ? `${(jitter(k, 2) * 6).toFixed(1)}px ${(jitter(k, 3) * 5).toFixed(1)}px` : '';
    const body = card.firstElementChild as HTMLElement;
    const md = cardMarkdown(k);
    if (body.dataset.md !== md) {
      body.dataset.md = md;
      body.innerHTML = renderBodyHTML(md);
      hydrateImages(body);
    }
  });
  const count = face.querySelector<HTMLElement>(':scope > .stack-count')!;
  if (count.textContent !== String(kids.length)) {
    count.textContent = String(kids.length);
    count.title = `${kids.length} card${kids.length === 1 ? '' : 's'}`;
  }
}

// ---------- pressing the pile ----------
// A press on the pile's BODY (bindNodeDrag hands it over): a click fans it out, a drag LIFTS its top card off
// and carries it away through the ordinary drag, so it lands by the ordinary drop rule — back on this pile,
// on another, in a section or on the board. The pin and the name tab take the ordinary path instead: they
// select the stack and move it whole.
export function beginPileGesture(n: MindNode, e: PointerEvent): void {
  try { n.el?.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const sx = e.clientX, sy = e.clientY, slop = e.pointerType === 'touch' ? 8 : 2;
  let lifted = false;
  const stop = trackPointer({ move, up, cancel: up });

  function move(ev: PointerEvent): void {
    if (lifted) {
      feedDragMove(ev.clientX, ev.clientY);
      return;
    }
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= slop || state.readOnly || isLockedEffective(n)) {
      return;
    }
    const top = topOfPile(n);
    if (!top) {
      return;
    }
    lifted = true;

    // off the pile, onto whatever the pile lies on — a card on the board again, where the pile is
    touch(top.id, n.id);
    top.parent = n.parent; top.dirty = true; top.dirtyLayout = true;
    paintAll();
    startNodeDrag(top, sx, sy);
    paintNode(top);   // into the drag layer, out of any section's clip
    feedDragMove(ev.clientX, ev.clientY);
  }

  function up(): void {
    stop();
    if (lifted) {
      commitDrag();
    } else {
      toggleFan(n.id);
    }
  }
}

// ---------- the fan ----------
// FANNED OUT, a stack's cards are real cards again, held up over a dimmed board (view/pile.ts places them):
// read them, drag one out, drag one to another place in the pile. A click on the board, Esc or a click on the
// pile again puts them back. Nothing is saved by it — it's a way of looking.
const scrim = document.createElement('div');
scrim.id = 'fanScrim';
scrim.addEventListener('pointerdown', (e) => { e.stopPropagation(); closeFan(); });
scrim.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); });   // not a new card
window.addEventListener('keydown', (e) => {
  if (ui.fan && e.key === 'Escape') {
    e.stopPropagation();
    closeFan();
  }
}, true);

export function toggleFan(id: string): void {
  if (ui.fan === id) {
    closeFan();
  } else {
    openFan(id);
  }
}

// The cards glide out of the pile to their places (main.ts animateLayout: a card just shown starts at the
// nearest ancestor already on screen — the pile).
export function openFan(id: string): void {
  if (!isStack(state.nodes.get(id)) || !childrenOf(id).length) {
    return;
  }
  setSelectionSet([]);
  animateLayout(() => { ui.fan = id; });
  syncFan();

  // …and if it opened past the edge of the screen, the view goes to it.
  // (From where the cards are GOING: on screen they're still gliding out of the pile.)
  const shown = [state.nodes.get(id)!, ...childrenOf(id)];
  const r = stage.getBoundingClientRect(), v = state.view;
  const out = shown.some(n => n.x * v.k + v.x < 0 || n.y * v.k + v.y < 0
    || (n.x + nodeW(n)) * v.k + v.x > r.width || (n.y + nodeH(n)) * v.k + v.y > r.height);
  if (out) {
    frameBox(shown);
  }
}

export function closeFan(): void {
  const id = ui.fan;
  if (!id) {
    return;
  }
  ui.fan = null;

  // a card picked out of the fan goes back into the pile, and can't stay selected there
  if ([...state.sel].some(k => state.nodes.get(k)?.parent === id)) {
    setSelectionSet([]);
  }
  relayout();
}

// The scrim and the body class follow ui.fan, whatever cleared it — a close, or the stack dissolving under
// an open fan (view/pile.ts layStacks). Run by every paintAll. The tilt each fanned card wears is set here
// too, for the paint that happened before the layout that decided it (openFan's animateLayout) — a
// custom property, which leaves the glide's own left/top transition running.
export function syncFan(): void {
  const on = !!ui.fan;
  document.body.classList.toggle('fan-open', on);
  if (on && !scrim.isConnected) {
    document.getElementById('world')!.appendChild(scrim);
  } else if (!on && scrim.isConnected) {
    scrim.remove();
  }
  scrim.classList.toggle('grid', on && childrenOf(ui.fan!).length > FAN_ARC_MAX);
  for (const k of on ? childrenOf(ui.fan!) : []) {
    k.el?.style.setProperty('--tilt', (fanTilt(k.id) ?? 0).toFixed(2) + 'deg');
  }
}

// ---------- dropping on a pile ----------
// What can go on a pile: a card, or another stack (its cards join this one). Sections keep their boxes.
function canPile(n: MindNode | undefined): boolean {
  return !!n && (n.type === 'card' || isStack(n)) && !isLockedEffective(n);
}

// The board node under the POINTER — the top one, as drawn, skipping the cards in hand.
function nodeUnder(cx: number, cy: number, skip: Set<string>): MindNode | null {
  for (const hit of document.elementsFromPoint(cx, cy)) {
    const id = hit.closest<HTMLElement>('#world .node')?.dataset.id;
    if (id && !skip.has(id)) {
      return state.nodes.get(id) ?? null;
    }
  }
  return null;
}

// Where a drop right now would PILE the dragged cards (features/drag.ts updateDropTarget): onto the stack under
// the pointer at once; onto a plain card only once the pointer has rested on it for PILE_HOVER_MS, and then
// as a new stack made around it (`make`). Not while a fan is open: the board is under the scrim.
export function pileTarget(drag: Drag, cx: number, cy: number, skip: Set<string>): Drag['pile'] {
  const n = ui.fan || !drag.selRoots.every(id => canPile(state.nodes.get(id))) ? null : nodeUnder(cx, cy, skip);
  if (!n || isHidden(n) || isLockedEffective(n) || !(n.type === 'card' || isStack(n))) {
    drag.pileHover = null;
    return null;
  }
  if (isStack(n)) {
    drag.pileHover = null;
    return { id: n.id, make: false };
  }
  if (drag.pileHover?.id !== n.id) {
    drag.pileHover = { id: n.id, since: performance.now() };
  }
  return performance.now() - drag.pileHover.since >= PILE_HOVER_MS ? { id: n.id, make: true } : null;
}

// Dragging ONE card of the open fan within the fan: the place in its pile it would take.
export function fanSlot(drag: Drag, cx: number, cy: number): number | null {
  const s = ui.fan ? state.nodes.get(ui.fan) : null;
  const r = drag.selRoots.length === 1 && !drag.cloned ? state.nodes.get(drag.selRoots[0]) : null;
  if (!s || !r || r.parent !== s.id) {
    return null;
  }
  return fanSlotAt(s, screenToWorld(cx, cy), r.id);
}

// …and the card of the fan whose place that is, for the drop preview.
export function fanSlotCard(slot: number): MindNode | null {
  const s = ui.fan ? state.nodes.get(ui.fan) : null;
  return s ? pileKids(s)[slot] ?? null : null;
}

// Move a card of a stack to another place in its pile. Inside the caller's undo step.
export function reorderPile(id: string, slot: number): boolean {
  const k = state.nodes.get(id);
  const s = k?.parent ? state.nodes.get(k.parent) : null;
  if (!k || !isStack(s)) {
    return false;
  }
  const order = pileKids(s!).map(m => m.id).filter(x => x !== id);
  order.splice(Math.min(slot, order.length), 0, id);
  touch(s!.id);
  s!.kidOrder = order;
  s!.dirtyLayout = true;
  return true;
}

// Put the dragged roots on a pile — the stack `targetId`, or (`make`) a new stack made around the card
// `targetId`, which becomes its bottom card. A dragged STACK gives up its cards to this one, in their own
// order, and goes. They go on TOP, in the order they're listed. Inside the caller's undo step (the drag's).
// Returns the stack.
export function pileInto(targetId: string, make: boolean, roots: string[]): MindNode | null {
  const t = state.nodes.get(targetId);
  if (!t || state.readOnly) {
    return null;
  }
  let s = t;
  if (make) {
    s = mkNode({ type: 'section', stack: true, parent: t.parent, x: t.x, y: t.y });
    state.nodes.set(s.id, s);
    touch(t.id);
    t.parent = s.id; t.dirty = true;
    s.kidOrder = [t.id];
  }
  touch(s.id);
  let order = pileKids(s).map(k => k.id);
  for (const id of roots) {
    const r = state.nodes.get(id);
    if (!r || r.id === s.id) {
      continue;
    }
    const cards = isStack(r) ? pileKids(r) : [r];
    for (const c of cards) {
      touch(c.id);
      c.parent = s.id; c.dirty = true; c.dirtyLayout = true;
      order = order.filter(x => x !== c.id).concat(c.id);
    }
    s.kidOrder = order;
    if (isStack(r)) {
      deleteNodes([r.id]);
    }
  }
  s.kidOrder = order;
  s.dirtyLayout = true;
  return s;
}

// ---------- a stack of one is no stack ----------
// Every stack down to its LAST card lets it go and disappears: the card is left lying where the pile was,
// in whatever the pile was in. An empty one just goes. Run after anything that can take cards off a pile — a
// drop (features/drag.ts), a delete (crud.ts deleteNodes). Inside the caller's undo step.
export function settleStacks(): void {
  for (const s of [...state.nodes.values()]) {
    if (!isStack(s) || !state.nodes.has(s.id) || isLockedEffective(s)) {
      continue;
    }
    const kids = childrenOf(s.id);
    if (kids.length > 1) {
      continue;
    }
    for (const k of kids) {
      touch(k.id);
      k.parent = s.parent; k.x = s.x; k.y = s.y; k.dirty = true; k.dirtyLayout = true;
    }
    if (ui.fan === s.id) {
      ui.fan = null;
    }
    deleteNodes([s.id]);
  }
}

// ---------- spreading a pile out: Unstack, Turn into section ----------
// Lay cards out in a tidy grid, its top-left at `at` — the top card first, then down the pile, row by row,
// at the house spacing. Heights are MEASURED, so the cards must be painted (visible) first. Returns its size.
function layGrid(cards: MindNode[], at: Pt): { w: number; h: number } {
  const cols = Math.ceil(Math.sqrt(cards.length));
  const colW = Math.max(...cards.map(nodeW)) + SPACING;
  let y = at.y, w = 0;
  for (let i = 0; i < cards.length; i += cols) {
    const row = cards.slice(i, i + cols);
    row.forEach((c, j) => {
      touch(c.id);
      moveSubtreeTo(c, at.x + j * colW, y);
    });
    w = Math.max(w, row.length * colW - SPACING);
    y += Math.max(...row.map(nodeH)) + SPACING;
  }
  return { w, h: y - SPACING - at.y };
}

// The selected stacks, unlocked — what Unstack and Turn into section act on.
function selectedStacks(): MindNode[] {
  return nodesOf(selectedIds()).filter(n => isStack(n) && !isLockedEffective(n));
}
export const hasStackSelected = (): boolean => !state.readOnly && selectedStacks().length > 0;

// UNSTACK: the cards go back on the board as loose cards, in a grid where the pile was, and the stack goes.
// (Ungroup on a stack does this — crud.ts deleteSelectionKeepChildren hands it over.)
export function unstackSelection(): void {
  const stacks = selectedStacks();
  if (!stacks.length) {
    return;
  }
  const loose: string[] = [];
  record([], () => {
    for (const s of stacks) {
      const cards = pileKids(s).reverse();
      for (const c of cards) {
        touch(c.id);
        c.parent = s.parent; c.dirty = true;
        loose.push(c.id);
      }
      if (ui.fan === s.id) {
        ui.fan = null;
      }
      deleteNodes([s.id]);
      paintAll();   // the cards are on the board now, and measurable
      layGrid(cards, s);
    }
    growSectionsToHold(loose);
    relayout();
  });
  setSelectionSet(loose);
  scheduleSave();
  setStatus(`Unstacked ${loose.length} card${loose.length === 1 ? '' : 's'}`);
}

// TURN INTO SECTION: the same grid, kept in the stack's folder, which becomes an ordinary section box sized
// round it.
const SECTION_PAD = 16;

export function stackToSection(): void {
  const stacks = selectedStacks();
  if (!stacks.length) {
    return;
  }
  record([], () => {
    for (const s of stacks) {
      touch(s.id);
      const cards = pileKids(s).reverse();
      if (ui.fan === s.id) {
        ui.fan = null;
      }
      s.stack = false; s.dirtyLayout = true;
      paintAll();
      const size = layGrid(cards, { x: s.x + SECTION_PAD, y: s.y + SECTION_PAD });
      const up = (v: number): number => Math.ceil(v / gridSnap()) * gridSnap();
      s.w = Math.max(MIN_SECTION_W, up(size.w + SECTION_PAD * 2));
      s.h = Math.max(MIN_SECTION_H, up(size.h + SECTION_PAD * 2));
    }
    growSectionsToHold(stacks.map(s => s.id));
    remeasure();
  });
  setSelectionSet(stacks.map(s => s.id));
  scheduleSave();
  setStatus(stacks.length > 1 ? `${stacks.length} stacks are sections now` : `“${nodeLabel(stacks[0])}” is a section now`);
}
