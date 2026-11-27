// Free edges: selecting, drawing, moving an end, deleting. Drawing a line NEVER reorganises the map:
// a drag from a card moves it, a drag from one of its rings draws a line.
import { state, stage, setStatus, type BoardEdge, type EdgeSide } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { makeEdge, scheduleSaveBoard } from '../data/board.js';
import { paintFreeEdges, connectable, portAt, type Anchor } from '../view/free-edges.js';
import { OPPOSITE } from '../utils/edge-route.js';
import { syncEdgeBar, startLabelEdit } from './edge-bar.js';
import { touchEdges } from './history.js';
import { mutate } from './mutate.js';
import { isHidden } from '../utils/model.js';
import { screenToWorld } from '../view/camera.js';
import { paintAll } from '../render.js';
import { createNode } from './crud.js';
import { trackPointer } from '../utils/dom.js';
import { nodeW, nodeH, NODE_W } from '../view/geometry.js';

export function selectedEdges(): BoardEdge[] {
  return state.edges.filter(e => state.selEdges.has(e.id));
}

// The LAST one clicked: a Set iterates in insertion order.
export function leadEdge(): BoardEdge | null {
  const ids = [...state.selEdges];
  const last = ids[ids.length - 1];
  return last ? state.edges.find(e => e.id === last) ?? null : null;
}

// Clears the card selection (AppState.selEdges). `add` TOGGLES, as ⌘-click does for cards.
function selectEdge(id: string | null, add = false): void {
  if (id == null) {
    state.selEdges.clear();
  } else if (!add) {
    state.selEdges.clear();
    state.selEdges.add(id);
  } else if (!state.selEdges.delete(id)) {
    state.selEdges.add(id);
  }
  if (state.selEdges.size) { state.sel.clear(); state.selId = null; }
  paintAll();
  syncEdgeBar();
}

export function clearEdgeSelection(): void {
  if (!state.selEdges.size) {
    return;
  }
  state.selEdges.clear();
  paintFreeEdges();
  syncEdgeBar();
}

// A face and how far along it; an unpinned end picks its face per paint.
interface Pin { side: EdgeSide; at: number }

// Two lines between the same POINTS would lie on top of each other; other points of the same cards are fine.
const samePin = (side: EdgeSide | undefined, at: number | undefined, p?: Pin): boolean =>
  side === p?.side && (!side || (at ?? 0.5) === p?.at);

function edgeBetween(a: string, b: string, pa?: Pin, pb?: Pin): BoardEdge | undefined {
  return state.edges.find(e => (e.from === a && e.to === b && samePin(e.fromPort, e.fromAt, pa) && samePin(e.toPort, e.toAt, pb))
                            || (e.from === b && e.to === a && samePin(e.fromPort, e.fromAt, pb) && samePin(e.toPort, e.toAt, pa)));
}

// The middle of a face is the plain port, so it stores no `at`.
function setPin(e: BoardEdge, end: 'from' | 'to', pin?: Pin): void {
  const port = end === 'from' ? 'fromPort' : 'toPort', at = end === 'from' ? 'fromAt' : 'toAt';
  delete e[port];
  delete e[at];
  if (pin) {
    e[port] = pin.side;
    if (pin.at !== 0.5) {
      e[at] = pin.at;
    }
  }
}

function addEdge(fromId: string, toId: string, fromPin?: Pin, toPin?: Pin): BoardEdge | null {
  if (fromId === toId || !connectable(fromId) || !connectable(toId)) {
    return null;
  }
  const dup = edgeBetween(fromId, toId, fromPin, toPin);
  if (dup) { selectEdge(dup.id); return dup; }
  const e = makeEdge(fromId, toId);
  setPin(e, 'from', fromPin);
  setPin(e, 'to', toPin);
  state.edges.push(e);
  return e;
}

// Chains the selection in order, A→B→C. Also the touch path in.
export function connectSelection(): void {
  const ids = [...state.sel];
  if (ids.length < 2) { setStatus('Select two cards to connect — or drag from a ring on the selected card.'); return; }
  let made = 0;
  mutate([], () => {
    for (let i = 0; i < ids.length - 1; i++) {
      if (addEdge(ids[i], ids[i+1])) {
        made++;
      }
    }
  }, { edges: true, reflow: 'paint' });
  if (!made) {
    setStatus('Already connected');
  }
}

// The end that STAYS while one is dragged: a moved end's other end as it's pinned, or the port a fresh draw left.
function anchorOf(draw: NonNullable<typeof ui.edgeDraw>): Anchor | undefined {
  const n = state.nodes.get(draw.sourceId);
  const e = draw.edgeId ? state.edges.find(x => x.id === draw.edgeId) : null;
  if (!n) {
    return undefined;
  }
  if (!e) {
    return { n, side: draw.side };
  }
  return draw.end === 'from' ? { n, side: e.toPort, at: e.toAt } : { n, side: e.fromPort, at: e.fromAt };
}

// A point on a card's FACE wins (its dots sit outside the card), else the topmost card under the point.
function dropAt(p: Pt, exclude: string, anchor?: Anchor): { id: string; pin?: Pin } | null {
  let hit: { id: string; pin?: Pin } | null = null;
  for (const n of state.nodes.values()) {
    if (n.id === exclude || isHidden(n) || !connectable(n.id)) {
      continue;
    }
    const pin = portAt(n, p, anchor);
    if (pin) { hit = { id: n.id, pin }; continue; }
    if (p.x < n.x || p.y < n.y || p.x > n.x + nodeW(n) || p.y > n.y + nodeH(n)) {
      continue;
    }
    if (!hit?.pin) {
      hit = { id: n.id };
    }
  }
  return hit;
}

// Capture phase on #stage, ahead of card drag and pan. Not #world: it has no size, so the empty canvas isn't in it.
export function installEdgeTools(): void {
  stage.addEventListener('pointerdown', (ev: PointerEvent) => {
    const t = ev.target as Element | null;
    if (!t) {
      return;
    }
    const socket = t.closest('[data-socket]') as SVGElement | null;
    const handle = t.closest('[data-handle]') as SVGElement | null;
    const hit    = t.closest('[data-edge]') as SVGElement | null;
    if (socket) {
      beginDraw(ev, { sourceId: socket.getAttribute('data-node')!, to: screenToWorld(ev.clientX, ev.clientY),
                      grabbedAt: screenToWorld(ev.clientX, ev.clientY),
                      side: socket.getAttribute('data-socket') as EdgeSide });
      return;
    }
    if (handle) {
      const edge = state.edges.find(e => e.id === handle.getAttribute('data-edge'));
      if (!edge) {
        return;
      }
      const end = handle.getAttribute('data-handle') as 'from' | 'to';
      beginDraw(ev, { sourceId: end === 'to' ? edge.from : edge.to, to: screenToWorld(ev.clientX, ev.clientY),
                      grabbedAt: screenToWorld(ev.clientX, ev.clientY), edgeId: edge.id, end });
      return;
    }
    if (hit) {
      // Not preventDefault, which would suppress the clicks twoPresses is timed against.
      ev.stopPropagation();
      const id = hit.getAttribute('data-edge')!;
      const dbl = twoPresses(id, ev);
      selectEdge(id, ev.metaKey || ev.ctrlKey);
      // The press's default action would move focus straight back out of the label field.
      if (dbl) { ev.preventDefault(); startLabelEdit(id); }
      return;
    }
    clearEdgeSelection();
  }, true);
  // The canvas's own double-click would drop a card on the line.
  stage.addEventListener('dblclick', (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.closest('[data-edge]')) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
}

// Not the browser's dblclick: the first press repaints #freeEdges, so Chrome dispatches none.
const DBL_MS = 450, DBL_SLOP = 6;
let lastPress = { id: '', t: 0, x: 0, y: 0 };

function twoPresses(id: string, ev: PointerEvent): boolean {
  const near = lastPress.id === id && ev.timeStamp - lastPress.t < DBL_MS
            && Math.hypot(ev.clientX - lastPress.x, ev.clientY - lastPress.y) < DBL_SLOP;
  lastPress = { id: near ? '' : id, t: ev.timeStamp, x: ev.clientX, y: ev.clientY };
  return near;
}

function beginDraw(ev: PointerEvent, seed: NonNullable<typeof ui.edgeDraw>): void {
  ev.preventDefault(); ev.stopPropagation();
  ui.edgeDraw = seed;
  const abort = (): void => { stop(); ui.edgeDraw = null; paintFreeEdges(); };
  const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); abort(); } };
  const move = (e: PointerEvent): void => {
    const draw = ui.edgeDraw!;
    draw.to = screenToWorld(e.clientX, e.clientY);
    const at = dropAt(draw.to, draw.sourceId, anchorOf(draw));
    draw.overId = at?.id; draw.overSide = at?.pin?.side; draw.overAt = at?.pin?.at;
    paintFreeEdges();
  };
  const up = (e: PointerEvent): void => {
    stop();
    const draw = ui.edgeDraw; ui.edgeDraw = null;
    if (draw) {
      finishDraw(draw, screenToWorld(e.clientX, e.clientY));
    }
  };
  const stop = trackPointer({ move, up, cancel: abort, key });
}

const MIN_DRAG_PX = 12;

function finishDraw(draw: NonNullable<typeof ui.edgeDraw>, at: Pt): void {
  const travelled = Math.hypot(at.x - draw.grabbedAt.x, at.y - draw.grabbedAt.y) * (state.view.k || 1);
  const target = draw.overId;
  if (travelled < MIN_DRAG_PX && draw.side && !draw.edgeId) { spawnConnected(draw.sourceId, draw.side); return; }
  // An end moved off into empty space leaves the line where it was.
  if (travelled < MIN_DRAG_PX || !target) { paintFreeEdges(); return; }
  const existing = draw.edgeId ? state.edges.find(e => e.id === draw.edgeId) : null;
  const overPin = draw.overSide ? { side: draw.overSide, at: draw.overAt ?? 0.5 } : undefined;
  if (existing) {
    const toEnd = draw.end === 'to';
    const other = toEnd ? existing.from : existing.to;
    const otherSide = toEnd ? existing.fromPort : existing.toPort, otherAt = toEnd ? existing.fromAt : existing.toAt;
    const dup = edgeBetween(other, target, otherSide ? { side: otherSide, at: otherAt ?? 0.5 } : undefined, overPin);
    if (target === other || (dup && dup !== existing)) { paintFreeEdges(); return; }
    // The end lets go of any path it held into a folded section's unread notes (data/board.ts).
    mutate([], () => {
      if (toEnd) { existing.to = target; delete existing.toPath; }
      else { existing.from = target; delete existing.fromPath; }
      setPin(existing, toEnd ? 'to' : 'from', overPin);
    }, { edges: true, reflow: 'paint' });
    syncEdgeBar();
    return;
  }
  let made = null as BoardEdge | null;
  mutate([], () => { made = addEdge(draw.sourceId, target, draw.side ? { side: draw.side, at: 0.5 } : undefined, overPin); },
         { edges: true, reflow: 'none' });
  if (!made) { paintFreeEdges(); return; }
  selectEdge(made.id);
}

// FigJam's ⊕: a card like its source, joined to it, exactly CONNECT_GAP away (no grid snap).
const CONNECT_GAP = 60;
const MAX_SLOT_TRIES = 50;

function spawnConnected(srcId: string, side: EdgeSide): void {
  const src = state.nodes.get(srcId);
  if (!src) {
    return;
  }
  const isCard = src.type !== 'section';
  const w = isCard ? nodeW(src) : NODE_W, h = isCard ? nodeH(src) : NODE_W;
  const sw = nodeW(src), sh = nodeH(src);
  const horiz = side === 'left' || side === 'right';
  let x = side === 'right' ? src.x + sw + CONNECT_GAP : side === 'left' ? src.x - CONNECT_GAP - w : src.x + (sw - w) / 2;
  let y = side === 'down' ? src.y + sh + CONNECT_GAP : side === 'up' ? src.y - CONNECT_GAP - h : src.y + (sh - h) / 2;
  // Step past whatever already stands there: down a column on the left/right, along a row up/down.
  const blocked = (): boolean => [...state.nodes.values()].some(o => o.parent === src.parent && o !== src && !isHidden(o)
    && x < o.x + nodeW(o) && x + w > o.x && y < o.y + nodeH(o) && y + h > o.y);
  for (let i = 0; i < MAX_SLOT_TRIES && blocked(); i++) {
    if (horiz) {
      y += h + CONNECT_GAP;
    } else {
      x += w + CONNECT_GAP;
    }
  }
  const n = createNode({ x, y, parent: src.parent, color: isCard ? src.color : undefined,
                         w: isCard ? src.w : undefined, h: isCard ? src.h : undefined });
  if (!n) {
    return;
  }

  // Into the new card's step, so an abandoned empty card takes its line with it.
  touchEdges();
  addEdge(srcId, n.id, { side, at: 0.5 }, { side: OPPOSITE[side], at: 0.5 });
  scheduleSaveBoard();
  paintFreeEdges();
}

export function deleteSelectedEdge(): boolean {
  const ids = [...state.selEdges];
  if (!ids.length) {
    return false;
  }
  mutate([], () => {
    state.edges = state.edges.filter(e => !state.selEdges.has(e.id));
    state.selEdges.clear();
  }, { edges: true, reflow: 'paint' });
  syncEdgeBar();
  return true;
}
