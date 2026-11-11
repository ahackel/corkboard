// ---------- STACKS: a section drawn as a PILE of its cards ----------
// Hold a dragged card over another for a moment and the two become a stack, like the Dock's; drop more cards
// on the pile and they go on top. It's a SECTION all the same — a folder of its cards on disk — that shows
// its cards lying on top of each other instead of sitting in a box (core/state.ts isStack).
//   · the pile shows its top card, two more peeking out behind it, and a pushpin in the stack's colour
//   · a CLICK fans it out over the board; dragging the pile's BODY lifts its top card off; dragging the PIN
//     moves the whole stack
//   · down to one card, it's no stack any more: the last card is left lying where the pile was
// Where its cards lie, piled or fanned, is view/pile.ts.
import { state, setStatus, isStack, isImageCard, type MindNode } from '../core/state.js';
import { ui, type Drag, type Pt } from '../core/ui-state.js';
import { childrenOf, isHidden, isLockedEffective, nodeLabel, nodesOf, nodeAtTarget } from '../utils/model.js';
import { cardMarkdown } from '../utils/frontmatter.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { trackPointer } from '../utils/dom.js';
import { pileKids, pileX, topOfPile, fanSlotAt, fanTilt, gridOf, FAN_ARC_MAX, type FanInsert } from '../view/pile.js';
import { nodeW, nodeH, imageLook } from '../view/geometry.js';
import { moveSubtreeTo } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { applyColorVars, colorClass, colorFill } from '../view/color.js';
import { SPACING } from '../utils/guides.js';
import { effectiveColor, paintAll, paintNode, relayout, remeasure, animateLayout, placeSelf, LAYOUT_ANIM_MS } from '../main.js';
import { startNodeDrag, feedDragMove, commitDrag } from './drag.js';
import { mkNode, deleteNodes } from './crud.js';
import { touch, record } from './history.js';
import { hydrateImages } from './images.js';
import { selectedIds, setSelectionSet } from './selection.js';
import { fitSectionToContent, SECTION_FIT_PAD } from './float-bar.js';
import { scheduleSave } from '../data/save.js';

// How long a dragged card rests on another before letting go makes the two a stack. A quick pass over a
// card is just a pass: the cards overlap, as they always have.
export const PILE_HOVER_MS = 400;

// What an uncoloured stack wears — on its pin, the one thing its colour is for.
export const STACK_DEFAULT_COLOR = 'bold-red';

// The cards drawn in the pile: the top one, and two peeking out from under it.
const PILE_SHOWN = 3;

// ---------- the pile ----------
// A stack's face, inside its own element: its top cards as plain drawings (they're not nodes on the board
// while piled — isHidden says so), the pin, and the selection ring round all of them. Built once and refreshed
// on every paint — each card KEYED on what it shows, the way paintNode keys a card's text, so a paint that
// changed nothing writes nothing and measures nothing. Anything that stops being a stack (Turn into section,
// an undo) drops its face here too; `data-cards` marks an element that has one.
export function paintPile(n: MindNode, el: HTMLElement): void {
  if (!isStack(n)) {
    if (el.dataset.cards != null) {
      el.querySelector(':scope > .stack-face')?.remove();
      delete el.dataset.cards;
    }
    return;
  }
  let face = el.querySelector<HTMLElement>(':scope > .stack-face');
  if (!face) {
    face = document.createElement('div');
    face.className = 'stack-face';
    face.innerHTML = `<div class="pile"></div><span class="stack-ring"></span>`
      + `<span class="stack-pin" title="Drag to move the stack"></span>`;
    el.appendChild(face);
  }
  const kids = pileKids(n);

  // The bottom card is always drawn — it's what the pile stands on and is measured by — and over it the top ones.
  const places = kids.length > PILE_SHOWN
    ? [0, ...kids.map((_, i) => i).slice(1 - PILE_SHOWN)]
    : kids.map((_, i) => i);
  const shown = places.map(i => kids[i]);
  const pile = face.querySelector<HTMLElement>(':scope > .pile')!;
  while (pile.children.length > shown.length) {
    pile.lastElementChild!.remove();
  }
  while (pile.children.length < shown.length) {
    pile.insertAdjacentHTML('beforeend', '<div class="pile-card"><div class="body"></div></div>');
  }
  const mess = places.map(messAt);
  const baseW = shown.length ? nodeW(shown[0]) : 0;
  const keys = shown.map((k, i) => {
    const card = pile.children[i] as HTMLElement;
    const under = shown.length - 1 - i;   // 0 = the top card
    const col = effectiveColor(k), image = isImageCard(k), md = cardMarkdown(k);

    // Every card keeps its OWN height on the pile: an image its box, a clipped card exactly n.h, any other
    // card its text over its authored minimum.
    const exactH = image ? nodeH(k) : k.clip && k.h != null ? k.h : null;
    const minH = !image && !k.clip && k.h != null ? k.h : null;
    const key = [k.id, col, imageLook(k), under, nodeW(k), baseW, exactH, minH, places[i], md].join('\u0000');
    if (card.dataset.key !== key) {
      card.dataset.key = key;
      card.dataset.kid = k.id;   // which card this drawing is, for a press on it (beginPileGesture)
      card.className = 'pile-card ' + colorClass(col) + (imageLook(k) ? ' image-card' : '') + (under ? ' under' : '');
      applyColorVars(card, col);
      card.style.width = nodeW(k) + 'px';
      card.style.left = i ? (baseW - nodeW(k)) / 2 + 'px' : '';   // centred over the bottom card (pileX)
      card.style.height = exactH != null ? exactH + 'px' : '';
      card.style.minHeight = minH != null ? minH + 'px' : '';

      // The mess: each card lies askew by its PLACE in the pile, counted from the bottom (messAt), so a card
      // keeps its angle as others are piled on top of it.
      card.style.rotate = mess[i].tilt + 'deg';
      card.style.translate = `${mess[i].dx}px ${mess[i].dy}px`;
      const body = card.firstElementChild as HTMLElement;
      body.innerHTML = renderBodyHTML(md);
      hydrateImages(body, k.file);
    }
    return key;
  });
  el.dataset.cards = String(kids.length);
  // The stack's colour is its PIN's — red until one is picked (STACK_DEFAULT_COLOR, via effectiveColor, so the
  // colour picker rings what the pin shows).
  const pin = face.querySelector<HTMLElement>(':scope > .stack-pin')!;
  const fill = colorFill(effectiveColor(n)) ?? '';
  if (pin.style.background !== fill) {
    pin.style.background = fill;
  }
  // The ring MEASURES the pile, so only when what the pile shows has changed.
  const ringKey = keys.join('\u0001');
  if (face.dataset.ring !== ringKey) {
    face.dataset.ring = ringKey;
    ringPile(face, pile, shown, mess, baseW);
  }
}

// How dark a card lies on the pile: all but the top one are dimmed (`.pile-card.under`, --pile-dim).
function pileDim(place: number, count: number): string {
  return place === count - 1 ? '1' : 'var(--pile-dim)';
}

// How a card lies, by its place in the pile from the bottom: an angle (degrees) and a nudge (px). The BOTTOM
// card lies square — the pile's footing; every card above it takes the next of a fixed list, cycled, so the
// same pile always looks the same.
interface Mess { tilt: number; dx: number; dy: number }
function messAt(place: number): Mess {
  return place ? PILE_MESS[(place - 1) % PILE_MESS.length] : { tilt: 0, dx: 0, dy: 0 };
}

const PILE_MESS = [
  { tilt: -2.5, dx: -3, dy: 2 }, { tilt: 2, dx: 3, dy: -2 }, { tilt: -1, dx: -1, dy: 3 },
  { tilt: 3, dx: 2, dy: 1 }, { tilt: -3, dx: -2, dy: -1 }, { tilt: 1.5, dx: 1, dy: 2 },
];

// The selection ring goes round the WHOLE pile — every card as it lies, askew — not just the element's box,
// which is the bottom card's footprint unrotated. Each card turns about its own centre — all of them over the
// bottom card's middle — so its bounds are those of the rotated rectangle, at its own measured height.
function ringPile(face: HTMLElement, pile: HTMLElement, shown: MindNode[], mess: Mess[], baseW: number): void {
  const ring = face.querySelector<HTMLElement>(':scope > .stack-ring')!;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  shown.forEach((k, i) => {
    const w = nodeW(k), h = (pile.children[i] as HTMLElement).offsetHeight, { dx, dy } = mess[i];
    const a = mess[i].tilt * Math.PI / 180;
    const cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const cx = baseW / 2 + dx, cy = h / 2 + dy, hw = (w * cos + h * sin) / 2, hh = (w * sin + h * cos) / 2;
    x0 = Math.min(x0, cx - hw); y0 = Math.min(y0, cy - hh); x1 = Math.max(x1, cx + hw); y1 = Math.max(y1, cy + hh);
  });
  if (!isFinite(x0)) {
    x0 = 0; y0 = 0; x1 = 0; y1 = 0;
  }
  ring.style.left = x0.toFixed(1) + 'px';
  ring.style.top = y0.toFixed(1) + 'px';
  ring.style.width = (x1 - x0).toFixed(1) + 'px';
  ring.style.height = (y1 - y0).toFixed(1) + 'px';
}

// ---------- pressing the pile ----------
// A press on the pile's BODY (bindNodeDrag hands it over): a click fans it out, a drag LIFTS the card it
// pressed off — the top one, or a lower one showing from under it — and carries it away through the ordinary drag, so it lands by the ordinary drop rule — back on this pile,
// on another, in a section or on the board. The pin and the name tab take the ordinary path instead: they
// select the stack and move it whole.
export function beginPileGesture(n: MindNode, e: PointerEvent): void {
  try { n.el?.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const sx = e.clientX, sy = e.clientY, slop = e.pointerType === 'touch' ? 8 : 2;
  let lifted = false;

  // the card drawn under the pointer — a card lying lower in the pile shows round the edges of those above it
  const drawn = (e.target as Element | null)?.closest<HTMLElement>('.pile-card');
  const pressed = pileKids(n).find(k => k.id === drawn?.dataset.kid) ?? null;
  const stop = trackPointer({ move, up, cancel: up });

  function move(ev: PointerEvent): void {
    if (lifted) {
      feedDragMove(ev.clientX, ev.clientY);
      return;
    }
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= slop || isLockedEffective(n)) {
      return;
    }
    const top = pressed ?? topOfPile(n);
    if (!top) {
      return;
    }
    lifted = true;

    // off the pile, onto whatever the pile lies on — a card on the board again, where the pile is
    touch(top.id, n.id);
    top.parent = n.parent; top.dirty = true;
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

}

// The cards glide back onto the pile, straightening as they go, and only then become the pile again: the fan
// stays open (scrim and all) for the length of the glide. A second close meanwhile is the same close.
let closing: string | null = null;
export function closeFan(): void {
  const id = ui.fan;
  if (!id || closing === id) {
    return;
  }

  // a card picked out of the fan goes back into the pile, and can't stay selected there
  if ([...state.sel].some(k => state.nodes.get(k)?.parent === id)) {
    setSelectionSet([]);
  }
  const s = state.nodes.get(id);
  const kids = childrenOf(id).filter(k => k.el && !isHidden(k));
  const done = (): void => {
    closing = null;
    document.body.classList.remove('fan-closing');
    kids.forEach((k) => {
      k.el?.classList.remove('lt-anim');   // or a later drag of the card would glide too
      k.el?.style.removeProperty('translate');
      k.el?.style.removeProperty('--fan-dim');
    });
    if (ui.fan === id) {
      ui.fan = null;
      relayout();
    }
  };
  if (!s || !kids.length) {
    done();
    return;
  }
  closing = id;
  document.body.classList.add('fan-closing');   // the dimming and the shadows fade as the cards go home

  // Each card turns to the angle and nudge it lies at on the pile (messAt), so the pile that replaces it at the
  // end of the glide is where the card already is.
  const place = new Map(pileKids(s).map((k, i) => [k.id, i]));
  for (const k of kids) {
    const lie = messAt(place.get(k.id) ?? 0);
    k.el!.classList.add('lt-anim');
    k.el!.style.setProperty('--tilt', lie.tilt + 'deg');
    k.el!.style.setProperty('--fan-dim', pileDim(place.get(k.id) ?? 0, place.size));
    k.el!.style.translate = `${lie.dx}px ${lie.dy}px`;
    placeSelf(k, pileX(s, k), s.y);
  }
  setTimeout(done, LAYOUT_ANIM_MS);
}

// The scrim and the body class follow ui.fan, whatever cleared it — a close, or the stack dissolving under
// an open fan (view/pile.ts layStacks). Run by every paintAll. The tilt each fanned card wears (`--tilt`) is
// set here and only here — after the layout that decided it, which for openFan's animateLayout comes AFTER
// its paint; a custom property, so the glide's own left/top transition keeps running. A card that leaves the
// fan keeps a stale `--tilt`, which nothing reads once it isn't `.fanned`. `--fan-z` is its place in the pile
// (bottom 0), so the cards stack as the pile does while they glide out and back. `--pile-tilt`/`--pile-nudge`/
// `--pile-card-dim` are how it lay on the pile, so the glide out starts from there and the glide home ends there (closeFan).
export function syncFan(): void {
  const on = !!ui.fan;
  document.body.classList.toggle('fan-open', on);
  if (on && !scrim.isConnected) {
    document.getElementById('world')!.appendChild(scrim);
  } else if (!on && scrim.isConnected) {
    scrim.remove();
  }
  const stack = on ? state.nodes.get(ui.fan!) : null;
  const kids = stack ? pileKids(stack) : [];
  scrim.classList.toggle('grid', kids.length > FAN_ARC_MAX);
  kids.forEach((k, i) => {
    k.el?.style.setProperty('--tilt', (fanTilt(k.id) ?? 0).toFixed(2) + 'deg');
    k.el?.style.setProperty('--fan-z', String(i));

    // where the card lay on the pile, for the glide out to start from (fan-lift in styles.css)
    const lie = messAt(i);
    k.el?.style.setProperty('--pile-tilt', lie.tilt + 'deg');
    k.el?.style.setProperty('--pile-nudge', `${lie.dx}px ${lie.dy}px`);
    k.el?.style.setProperty('--pile-card-dim', pileDim(i, kids.length));
  });
}

// ---------- dropping on a pile ----------
// What can go on a pile: a card, or another stack (its cards join this one). Sections keep their boxes.
function canPile(n: MindNode | undefined): boolean {
  return !!n && (n.type === 'card' || isStack(n)) && !isLockedEffective(n);
}

// Could ANYTHING be piled on at this point — is it inside (or a tilt's width from) the box of a card or
// stack that takes one? Plain arithmetic over the model, so the pointer crossing empty board or a
// section's floor, which is most of any drag, never asks the browser what is drawn there.
const PILE_REACH = 24;

function pileNear(cx: number, cy: number, skip: Set<string>): boolean {
  const p = screenToWorld(cx, cy);
  for (const n of state.nodes.values()) {
    if (skip.has(n.id) || !canPile(n) || isHidden(n)) {
      continue;
    }
    if (p.x >= n.x - PILE_REACH && p.x <= n.x + nodeW(n) + PILE_REACH && p.y >= n.y - PILE_REACH && p.y <= n.y + nodeH(n) + PILE_REACH) {
      return true;
    }
  }
  return false;
}

// The board node under the POINTER — the top one, as drawn, skipping the cards in hand. Asking the
// browser for everything drawn at a point is the costliest call of a drag on a big board, hence pileNear.
function nodeUnder(cx: number, cy: number, skip: Set<string>): MindNode | null {
  if (!pileNear(cx, cy, skip)) {
    return null;
  }
  for (const hit of document.elementsFromPoint(cx, cy)) {
    const n = nodeAtTarget(hit);
    if (n && !skip.has(n.id)) {
      return n;
    }
  }
  return null;
}

// Where a drop right now would PILE the dragged cards (features/drag.ts updateDropTarget): onto the stack under
// the pointer at once; onto a plain card only once the pointer has rested on it for PILE_HOVER_MS, and then
// as a new stack made around it (`make`). Not while a fan is open: the board is under the scrim.
export function pileTarget(drag: Drag, cx: number, cy: number, skip: Set<string>): Drag['pile'] {
  const n = ui.fan || !drag.selRoots.every(id => canPile(state.nodes.get(id))) ? null : nodeUnder(cx, cy, skip);
  if (!n || isHidden(n) || !canPile(n)) {
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

// Dragging ONE card of the open fan within the fan: where in its pile it would go.
export function fanSlot(drag: Drag, cx: number, cy: number): FanInsert | null {
  const s = ui.fan ? state.nodes.get(ui.fan) : null;
  const r = drag.selRoots.length === 1 && !drag.cloned ? state.nodes.get(drag.selRoots[0]) : null;
  if (!s || !r || r.parent !== s.id) {
    return null;
  }
  return fanSlotAt(s, screenToWorld(cx, cy), r.id);
}

// …shown as a LINE in the gap the card would drop into (styles.css #fanInsert); null hides it.
const insertLine = document.createElement('div');
insertLine.id = 'fanInsert';
export function showFanInsert(at: FanInsert | null): void {
  if (!at) {
    insertLine.remove();
    return;
  }
  insertLine.style.left = at.x + 'px';
  insertLine.style.top = at.y + 'px';
  insertLine.style.height = at.h + 'px';
  if (!insertLine.isConnected) {
    document.getElementById('world')!.appendChild(insertLine);
  }
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
  return true;
}

// Put the dragged roots on a pile — the stack `targetId`, or (`make`) a new stack made around the card
// `targetId`, which becomes its bottom card. A dragged STACK gives up its cards to this one, in their own
// order, and goes. They go on TOP, in the order they're listed. Inside the caller's undo step (the drag's).
// Returns the stack.
export function pileInto(targetId: string, make: boolean, roots: string[]): MindNode | null {
  const t = state.nodes.get(targetId);
  if (!t) {
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
      c.parent = s.id; c.dirty = true;
      order = order.filter(x => x !== c.id).concat(c.id);
    }
    if (isStack(r)) {
      deleteNodes([r.id]);
    }
  }
  s.kidOrder = order;
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
      k.parent = s.parent; k.x = s.x; k.y = s.y; k.dirty = true;
    }
    if (ui.fan === s.id) {
      ui.fan = null;   // its fan goes with it — no scrim left over a board with nothing to fan
    }
    deleteNodes([s.id]);
  }
}

// ---------- spreading a pile out: Unstack, Turn into section ----------
// Lay cards out in a tidy grid (view/pile.ts gridOf), its top-left at `at` — the top card first, then down the
// pile, row by row, at the house spacing. The cards must be painted (visible) first: their heights are measured.
function layGrid(cards: MindNode[], at: Pt): void {
  const g = gridOf(cards, SPACING);
  cards.forEach((c, i) => {
    touch(c.id);
    moveSubtreeTo(c, at.x + g.at[i].x, at.y + g.at[i].y);
  });
}

// The selected stacks, unlocked — what Unstack and Turn into section act on.
export function selectedStacks(): MindNode[] {
  return nodesOf(selectedIds()).filter(n => isStack(n) && !isLockedEffective(n));
}
export const hasStackSelected = (): boolean => selectedStacks().length > 0;

// Let stacks go: each one's cards back on the board as loose cards, in a grid where the pile was, and the stack
// gone. Inside the caller's undo step; returns the cards it let go of. Unstack's, and Ungroup's for the stacks
// in its selection (crud.ts deleteSelectionKeepChildren).
export function spreadPiles(stacks: MindNode[]): string[] {
  const loose: string[] = [];
  for (const s of stacks) {
    const cards = pileKids(s).reverse();
    for (const c of cards) {
      touch(c.id);
      c.parent = s.parent; c.dirty = true;
      loose.push(c.id);
    }
    deleteNodes([s.id]);
    paintAll();   // the cards are on the board now, and measurable
    layGrid(cards, s);
  }
  return loose;
}

// UNSTACK: every selected stack spreads its cards out and goes.
export function unstackSelection(): void {
  const stacks = selectedStacks();
  if (!stacks.length) {
    return;
  }
  let loose: string[] = [];
  record([], () => {
    loose = spreadPiles(stacks);
    relayout();
  });
  setSelectionSet(loose);
  scheduleSave();
  setStatus(`Unstacked ${loose.length} card${loose.length === 1 ? '' : 's'}`);
}

// TURN INTO SECTION: the same grid, kept in the stack's folder, which becomes an ordinary section box fitted
// round it (float-bar.ts fitSectionToContent, Fit's own sizing).
export function stackToSection(): void {
  const stacks = selectedStacks();
  if (!stacks.length) {
    return;
  }
  record([], () => {
    for (const s of stacks) {
      touch(s.id);
      const cards = pileKids(s).reverse();
      s.stack = false;
      paintAll();
      layGrid(cards, { x: s.x + SECTION_FIT_PAD, y: s.y + SECTION_FIT_PAD });
      fitSectionToContent(s);
    }
    remeasure();
  });
  setSelectionSet(stacks.map(s => s.id));
  scheduleSave();
  setStatus(stacks.length > 1 ? `${stacks.length} stacks are sections now` : `“${nodeLabel(stacks[0])}” is a section now`);
}
