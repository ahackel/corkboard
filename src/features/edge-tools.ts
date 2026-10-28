// ============================================================
// Free edges: selecting, drawing, moving an end, deleting.
//
// The one rule this module exists to protect: DRAWING AN EDGE NEVER REORGANISES THE MAP. A drag that
// starts on a card moves that card (and re-parents it); a drag that starts on one of the card's
// RINGS draws an edge. Same pointer, two grabs, and neither can be mistaken for the other — which
// is what lets the rings be always-available on a selected card without accidental connectors.
// A line goes from CARD to CARD: drop it anywhere on the target. There is nothing else to aim at.
// ============================================================
import { state, stage, setStatus, type BoardEdge, type EdgeSide } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { makeEdge, scheduleSaveBoard } from '../data/board.js';
import { paintFreeEdges, connectable, portAt } from '../view/free-edges.js';
import { syncEdgeBar, startLabelEdit } from './edge-bar.js';
import { touchEdges, commitStep } from './history.js';
import { isHidden } from '../utils/model.js';
import { screenToWorld } from '../view/camera.js';
import { paintAll } from '../main.js';
import { createNode } from './crud.js';
import { SPACING } from '../utils/guides.js';
import { trackPointer } from '../utils/dom.js';
import { nodeW, nodeH, snapPt } from '../view/geometry.js';

// Every selected edge, in board order. What the edge bar's colour, dash, ends and delete act on.
export function selectedEdges(): BoardEdge[] {
  return state.edges.filter(e => state.selEdges.has(e.id));
}
// The one the bar hangs off and reads its state from: the LAST one clicked (a Set iterates in
// insertion order, so the newest is simply the last).
export function leadEdge(): BoardEdge | null {
  const ids = [...state.selEdges];
  const last = ids[ids.length - 1];
  return last ? state.edges.find(e => e.id === last) ?? null : null;
}
// Selecting an edge clears the card selection and vice versa — see AppState.selEdges. `add` is the
// ⌘/Ctrl-click path and TOGGLES, exactly as it does for cards (features/selection.ts selectNode).
function selectEdge(id: string | null, add = false): void {
  if (id == null) state.selEdges.clear();
  else if (!add) { state.selEdges.clear(); state.selEdges.add(id); }
  else if (!state.selEdges.delete(id)) state.selEdges.add(id);
  if (state.selEdges.size) { state.sel.clear(); state.selId = null; }
  paintAll();
  syncEdgeBar();
}
export function clearEdgeSelection(): void {
  if (!state.selEdges.size) return;
  state.selEdges.clear();
  paintFreeEdges();
  syncEdgeBar();
}

// The edge already joining these two cards THROUGH THE SAME PORTS, either way round (an unpinned end
// counts as its own "port"). Two such lines would lie exactly on top of each other, so a second draw
// selects the first instead — but the same two cards can be joined again through different ports.
function edgeBetween(a: string, b: string, pa?: EdgeSide, pb?: EdgeSide): BoardEdge | undefined {
  return state.edges.find(e => (e.from === a && e.to === b && e.fromPort === pa && e.toPort === pb)
                            || (e.from === b && e.to === a && e.fromPort === pb && e.toPort === pa));
}
// `fromPort`/`toPort` pin the ends to those faces (BoardEdge); left out, an end picks its face itself.
function addEdge(fromId: string, toId: string, fromPort?: EdgeSide, toPort?: EdgeSide): BoardEdge | null {
  if (fromId === toId || !connectable(fromId) || !connectable(toId)) return null;
  const dup = edgeBetween(fromId, toId, fromPort, toPort);
  if (dup) { selectEdge(dup.id); return dup; }
  touchEdges();
  const e = makeEdge(fromId, toId);
  if (fromPort) e.fromPort = fromPort;
  if (toPort) e.toPort = toPort;
  state.edges.push(e);
  scheduleSaveBoard();
  return e;
}

// ⌘L / the float bar's Connect. Two or more cards selected: chain them in selection order (A→B→C,
// which is what a flow usually wants), as ONE undo step. This is also the TOUCH path — iOS never
// fires contextmenu on long-press, so a ring drag can't be the only way in.
export function connectSelection(): void {
  if (state.readOnly) return;
  const ids = [...state.sel];
  if (ids.length < 2) { setStatus('Select two cards to connect — or drag from a ring on the selected card.'); return; }
  let made = 0;
  touchEdges();
  for (let i = 0; i < ids.length - 1; i++) if (addEdge(ids[i], ids[i+1])) made++;
  paintAll();
  commitStep();
  setStatus(made ? `Connected ${made + 1} cards` : 'Already connected');
}

// What a line end dropped at `p` lands on: a card's PORT (pinning the end to that face — the floating
// dots sit outside the card, so a port wins even off the card's body), else the card under the point,
// topmost first — the drop target for both a fresh draw and a moved end.
function dropAt(p: Pt, exclude: string): { id: string; side?: EdgeSide } | null {
  let hit: { id: string; side?: EdgeSide } | null = null;
  for (const n of state.nodes.values()) {
    if (n.id === exclude || isHidden(n) || !connectable(n.id)) continue;
    const side = portAt(n, p);
    if (side) { hit = { id: n.id, side }; continue; }
    if (p.x < n.x || p.y < n.y || p.x > n.x + nodeW(n) || p.y > n.y + nodeH(n)) continue;
    if (!hit?.side) hit = { id: n.id };      // later nodes paint over earlier ones; take the last match
  }
  return hit;
}

// ---------- pointer wiring ----------
// Bound on #STAGE in the CAPTURE phase so a grab on a ring, a handle or an edge is claimed before the
// card-drag and canvas-pan handlers ever see the event. (#stage, not #world: #world has no size of its
// own, so a click on the empty canvas never lands inside it.)
export function installEdgeTools(): void {
  stage.addEventListener('pointerdown', (ev: PointerEvent) => {
    const t = ev.target as Element | null;
    if (!t) return;
    const socket = t.closest('[data-socket]') as SVGElement | null;
    const handle = t.closest('[data-handle]') as SVGElement | null;
    const hit    = t.closest('[data-edge]') as SVGElement | null;
    if (socket && !state.readOnly) {
      beginDraw(ev, { sourceId: socket.getAttribute('data-node')!, to: screenToWorld(ev.clientX, ev.clientY),
                      grabbedAt: screenToWorld(ev.clientX, ev.clientY),
                      side: socket.getAttribute('data-socket') as EdgeSide });
      return;
    }
    if (handle && !state.readOnly) {
      const edge = state.edges.find(e => e.id === handle.getAttribute('data-edge'));
      if (!edge) return;
      const end = handle.getAttribute('data-handle') as 'from' | 'to';
      // The end you are NOT dragging is the anchor the draft hangs off.
      beginDraw(ev, { sourceId: end === 'to' ? edge.from : edge.to, to: screenToWorld(ev.clientX, ev.clientY),
                      grabbedAt: screenToWorld(ev.clientX, ev.clientY), edgeId: edge.id, end });
      return;
    }
    if (hit) {
      // stopPropagation only — preventDefault on pointerdown would suppress the clicks the two-press
      // label gesture below is timed against.
      ev.stopPropagation();
      const id = hit.getAttribute('data-edge')!;
      const dbl = twoPresses(id, ev);
      selectEdge(id, ev.metaKey || ev.ctrlKey);
      // preventDefault ONLY here: the field is focused next, and the press's default action would move
      // focus straight back out of it, closing the editor in the same tick.
      if (dbl && !state.readOnly) { ev.preventDefault(); startLabelEdit(id); }
      return;
    }
    // Anything else on the canvas — a card, the background — takes the selection back, so an edge
    // and a card are never both selected (see AppState.selEdges).
    clearEdgeSelection();
  }, true);
  // A browser dblclick that does arrive on a line must not fall through to the canvas's own
  // double-click, which would drop a card on it.
  stage.addEventListener('dblclick', (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.closest('[data-edge]')) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
}

// Two presses on the SAME edge, close in time and place: double-click an edge → edit its label. Not the
// browser's dblclick: the first press selects the edge, which repaints #freeEdges wholesale, so the
// second lands on a different element and Chrome dispatches no dblclick at all. Counting presses here
// also gives touch a double TAP for free.
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
    const at = dropAt(draw.to, draw.sourceId);
    draw.overId = at?.id; draw.overSide = at?.side;
    paintFreeEdges();
  };
  const up = (e: PointerEvent): void => {
    stop();
    const draw = ui.edgeDraw; ui.edgeDraw = null;
    if (draw) finishDraw(draw, screenToWorld(e.clientX, e.clientY));
  };
  const stop = trackPointer({ move, up, cancel: abort, key });
}

// How far the pointer must travel before a release lands anything — below it the gesture was a press.
const MIN_DRAG_PX = 12;

function finishDraw(draw: NonNullable<typeof ui.edgeDraw>, at: Pt): void {
  const travelled = Math.hypot(at.x - draw.grabbedAt.x, at.y - draw.grabbedAt.y) * (state.view.k || 1);
  const target = draw.overId;
  // A CLICK on a port (FigJam's ⊕): a new card on that side, joined to this one.
  if (travelled < MIN_DRAG_PX && draw.side && !draw.edgeId) { spawnConnected(draw.sourceId, draw.side); return; }
  // A press that never travelled, or a release over no card: nothing changes. Moving an end off into
  // empty space leaves the line where it was — Delete is how a line goes away.
  if (travelled < MIN_DRAG_PX || !target) { paintFreeEdges(); return; }
  const existing = draw.edgeId ? state.edges.find(e => e.id === draw.edgeId) : null;
  if (existing) {
    const other = draw.end === 'to' ? existing.from : existing.to;
    const otherPort = draw.end === 'to' ? existing.fromPort : existing.toPort;
    const dup = edgeBetween(other, target, otherPort, draw.overSide);
    if (target === other || (dup && dup !== existing)) { paintFreeEdges(); return; }
    touchEdges();
    // …and the end lets go of the path it held into a folded frame's unread notes, if any (data/board.ts)
    if (draw.end === 'to') { existing.to = target; existing.toPort = draw.overSide; delete existing.toPath; }
    else { existing.from = target; existing.fromPort = draw.overSide; delete existing.fromPath; }
    scheduleSaveBoard(); paintAll(); syncEdgeBar();
    commitStep();
    setStatus('Edge moved');
    return;
  }
  const made = addEdge(draw.sourceId, target, draw.side, draw.overSide);
  if (!made) { paintFreeEdges(); return; }
  selectEdge(made.id);
  commitStep();
}

// FigJam's ⊕: click a port and a new card appears CONNECT_GAP away on that side — the same colour and
// size as the card it came from, joined to it by a line, and open for typing. Click again and the
// next one lands beside the last instead of on it. Its home is the source's: a card's frame, or for a
// frame the place the frame itself sits. One undo step with the card (createNode's rename session
// commits it), so an abandoned empty card takes its line with it (crud.ts discardNewCard).
const CONNECT_GAP = 80;
function spawnConnected(srcId: string, side: EdgeSide): void {
  const src = state.nodes.get(srcId); if (!src || state.readOnly) return;
  const isCard = src.type !== 'frame';
  const w = isCard ? nodeW(src) : 240, h = isCard ? nodeH(src) : 64;
  const sw = nodeW(src), sh = nodeH(src);
  const horiz = side === 'left' || side === 'right';
  let x = side === 'right' ? src.x + sw + CONNECT_GAP : side === 'left' ? src.x - CONNECT_GAP - w : src.x + (sw - w) / 2;
  let y = side === 'down' ? src.y + sh + CONNECT_GAP : side === 'up' ? src.y - CONNECT_GAP - h : src.y + (sh - h) / 2;
  // Step past whatever already stands there: down a column on the left/right, along a row up/down.
  const blocked = (): boolean => [...state.nodes.values()].some(o => o.parent === src.parent && o !== src && !isHidden(o)
    && x < o.x + nodeW(o) && x + w > o.x && y < o.y + nodeH(o) && y + h > o.y);
  for (let i = 0; i < 50 && blocked(); i++) { if (horiz) y += h + SPACING; else x += w + SPACING; }
  const at = snapPt({ x, y });
  const n = createNode({ ...at, parent: src.parent, color: isCard ? src.color : '',
                         w: isCard ? src.w : undefined, h: isCard ? src.h : undefined });
  if (!n) return;
  const opposite: Record<EdgeSide, EdgeSide> = { up: 'down', down: 'up', left: 'right', right: 'left' };
  addEdge(srcId, n.id, side, opposite[side]);
  paintFreeEdges();
}

// Delete/Backspace with edges selected — handled before the card path in features/tag-tray.ts's key handler. All
// of them go in ONE undo step: the selection was the unit the user acted on.
export function deleteSelectedEdge(): boolean {
  const ids = [...state.selEdges];
  if (!ids.length) return false;
  touchEdges();
  state.edges = state.edges.filter(e => !state.selEdges.has(e.id));
  state.selEdges.clear();
  scheduleSaveBoard();
  paintAll();
  syncEdgeBar();
  commitStep();
  setStatus(ids.length > 1 ? `${ids.length} edges deleted` : 'Edge deleted');
  return true;
}
