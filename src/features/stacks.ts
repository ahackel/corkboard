// STACKS: a section drawn as a PILE of its cards (see "A STACK is a section drawn as a PILE" in
// docs/architecture.md). Where its cards lie, piled or fanned, is view/pile.ts.
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
import { effectiveColor, paintAll, paintNode, relayout, remeasure, placeSelf } from '../render.js';
import { animateLayout, LAYOUT_ANIM_MS } from '../layout-anim.js';
import { startNodeDrag, feedDragMove, commitDrag } from './drag.js';
import { mkNode, deleteNodes } from './crud.js';
import { touch, record } from './history.js';
import { hydrateImages } from './images.js';
import { selectedIds, setSelectionSet } from './selection.js';
import { fitSectionToContent, SECTION_FIT_PAD } from './float-bar.js';
import { scheduleSave } from '../data/save.js';
import { reorderedPile } from '../utils/fan.js';
import { contains, inflate } from '../utils/rect.js';

// How long a dragged card rests on another before letting go makes the two a stack.
export const PILE_HOVER_MS = 400;

// What an uncoloured stack's pin wears.
export const STACK_DEFAULT_COLOR = 'bold-red';

const PILE_SHOWN = 3;

// ---------- the pile ----------

// The pile cards are plain drawings, each KEYED on what it shows, so a paint that changed nothing
// writes and measures nothing. `data-cards` marks an element that has a face.
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

  // The bottom card is always drawn (the pile stands on it), and over it the top ones.
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
    const depthFromTop = shown.length - 1 - i;
    const col = effectiveColor(k), image = isImageCard(k), md = cardMarkdown(k);
    const exactH = image ? nodeH(k) : k.clip && k.h != null ? k.h : null;
    const minH = !image && !k.clip && k.h != null ? k.h : null;
    const key = [k.id, col, imageLook(k), depthFromTop, nodeW(k), baseW, exactH, minH, places[i], md].join('\u0000');
    if (card.dataset.key !== key) {
      card.dataset.key = key;
      card.dataset.kid = k.id;   // for a press on it (beginPileGesture)
      card.className = 'pile-card ' + colorClass(col) + (imageLook(k) ? ' image-card' : '') + (depthFromTop ? ' under' : '');
      applyColorVars(card, col);
      card.style.width = nodeW(k) + 'px';
      card.style.left = i ? (baseW - nodeW(k)) / 2 + 'px' : '';   // centred over the bottom card
      card.style.height = exactH != null ? exactH + 'px' : '';
      card.style.minHeight = minH != null ? minH + 'px' : '';
      card.style.rotate = mess[i].tilt + 'deg';
      card.style.translate = `${mess[i].dx}px ${mess[i].dy}px`;
      const body = card.firstElementChild as HTMLElement;
      body.innerHTML = renderBodyHTML(md);
      hydrateImages(body, k.file);
    }
    return key;
  });
  el.dataset.cards = String(kids.length);
  const pin = face.querySelector<HTMLElement>(':scope > .stack-pin')!;
  const fill = colorFill(effectiveColor(n)) ?? '';
  if (pin.style.background !== fill) {
    pin.style.background = fill;
  }

  // The ring MEASURES the pile, so only when what it shows has changed.
  const ringKey = keys.join('\u0001');
  if (face.dataset.ring !== ringKey) {
    face.dataset.ring = ringKey;
    ringPile(face, pile, shown, mess, baseW);
  }
}

function pileDim(place: number, count: number): string {
  return place === count - 1 ? '1' : 'var(--pile-dim)';
}

// By place from the bottom, so a card keeps its angle as others pile on; the bottom card lies square.
interface Mess { tilt: number; dx: number; dy: number }

function messAt(place: number): Mess {
  return place ? PILE_MESS[(place - 1) % PILE_MESS.length] : { tilt: 0, dx: 0, dy: 0 };
}

const PILE_MESS = [
  { tilt: -2.5, dx: -3, dy: 2 }, { tilt: 2, dx: 3, dy: -2 }, { tilt: -1, dx: -1, dy: 3 },
  { tilt: 3, dx: 2, dy: 1 }, { tilt: -3, dx: -2, dy: -1 }, { tilt: 1.5, dx: 1, dy: 2 },
];

// The selection ring bounds every card as it lies, rotated about its centre over the bottom card's middle.
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

// A click on the pile's BODY fans it out; a drag lifts the pressed card off through the ordinary drag.
export function beginPileGesture(n: MindNode, e: PointerEvent): void {
  try { n.el?.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const sx = e.clientX, sy = e.clientY, slop = e.pointerType === 'touch' ? 8 : 2;
  let lifted = false;

  // A lower card can show round the edges of those above it.
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
    touch(top.id, n.id);
    top.parent = n.parent; top.dirty = true;
    paintAll();
    startNodeDrag(top, sx, sy);
    paintNode(top);   // into the drag layer
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

// ---------- the fan: real cards again, over a dimmed board; nothing is saved by it ----------

const scrim = Object.assign(document.createElement('div'), { id: 'fanScrim' });

export function toggleFan(id: string): void {
  if (ui.fan === id) {
    closeFan();
  } else {
    openFan(id);
  }
}

export function openFan(id: string): void {
  if (!isStack(state.nodes.get(id)) || !childrenOf(id).length) {
    return;
  }
  setSelectionSet([]);
  animateLayout(() => { ui.fan = id; });
  syncFan();
}

// The fan stays open for the glide home, and only then becomes the pile again.
let closing: string | null = null;

export function closeFan(): void {
  const id = ui.fan;
  if (!id || closing === id) {
    return;
  }

  // A card picked out of the fan can't stay selected in the pile.
  if ([...state.sel].some(k => state.nodes.get(k)?.parent === id)) {
    setSelectionSet([]);
  }
  const s = state.nodes.get(id);
  const kids = childrenOf(id).filter(k => k.el && !isHidden(k));
  const done = (): void => {
    closing = null;
    document.body.classList.remove('fan-closing');
    kids.forEach((k) => {
      k.el?.classList.remove('lt-anim');   // or a later drag would glide too
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
  document.body.classList.add('fan-closing');

  // Each card glides to how it lies on the pile, so the pile that replaces it is where it already is.
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

// Run by every paintAll, so the scrim follows ui.fan whatever cleared it. `--tilt` is set only here, after
// the layout that decided it (for openFan's animateLayout that comes AFTER its paint).
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

    // Where the glide out starts from (fan-lift in styles.css).
    const lie = messAt(i);
    k.el?.style.setProperty('--pile-tilt', lie.tilt + 'deg');
    k.el?.style.setProperty('--pile-nudge', `${lie.dx}px ${lie.dy}px`);
    k.el?.style.setProperty('--pile-card-dim', pileDim(i, kids.length));
  });
}

// ---------- dropping on a pile ----------

function canPile(n: MindNode | undefined): boolean {
  return !!n && (n.type === 'card' || isStack(n)) && !isLockedEffective(n);
}

// Plain arithmetic over the model, so most of a drag never asks the browser what is drawn (elementsFromPoint
// is the costliest call of a drag on a big board).
const PILE_REACH = 24;

function pileNear(cx: number, cy: number, skip: Set<string>): boolean {
  const p = screenToWorld(cx, cy);
  for (const n of state.nodes.values()) {
    if (skip.has(n.id) || !canPile(n) || isHidden(n)) {
      continue;
    }
    if (contains(inflate({ x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) }, PILE_REACH), p)) {
      return true;
    }
  }
  return false;
}

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

// Onto a stack at once; onto a plain card only after PILE_HOVER_MS, as a new stack (`make`).
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

const insertLine = Object.assign(document.createElement('div'), { id: 'fanInsert' });

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

// Inside the caller's undo step.
export function reorderPile(id: string, slot: number): boolean {
  const k = state.nodes.get(id);
  const s = k?.parent ? state.nodes.get(k.parent) : null;
  if (!k || !isStack(s)) {
    return false;
  }
  const order = reorderedPile(pileKids(s!).map(m => m.id), id, slot);
  touch(s!.id);
  s!.kidOrder = order;
  return true;
}

// Onto the stack `targetId`, or (`make`) a new one with that card at the bottom; a dragged STACK gives up its
// cards. Inside the caller's undo step.
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

// A stack of one is no stack: its last card is left where the pile was. Inside the caller's undo step.
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
      ui.fan = null;
    }
    deleteNodes([s.id]);
  }
}

// ---------- spreading a pile out: Unstack, Turn into section ----------

// The cards must be painted first: their heights are measured.
function layGrid(cards: MindNode[], at: Pt): void {
  const g = gridOf(cards, SPACING);
  cards.forEach((c, i) => {
    touch(c.id);
    moveSubtreeTo(c, at.x + g.at[i].x, at.y + g.at[i].y);
  });
}

export function selectedStacks(): MindNode[] {
  return nodesOf(selectedIds()).filter(n => isStack(n) && !isLockedEffective(n));
}

export const hasStackSelected = (): boolean => selectedStacks().length > 0;

// Inside the caller's undo step; returns the cards it let go of.
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
    paintAll();   // so the cards are measurable
    layGrid(cards, s);
  }
  return loose;
}

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

export function installStacks(): void {
  scrim.addEventListener('pointerdown', (e) => { e.stopPropagation(); closeFan(); });
  scrim.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); });
  window.addEventListener('keydown', (e) => {
    if (ui.fan && e.key === 'Escape') {
      e.stopPropagation();
      closeFan();
    }
  }, true);
}
