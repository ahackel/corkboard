// ============================================================
// Free edges: selecting, drawing, re-routing, deleting.
//
// The one rule this module exists to protect: DRAWING AN EDGE NEVER REORGANISES THE MAP. A drag that
// starts on a card moves that card (and re-parents it); a drag that starts on one of the card's
// SOCKETS draws an edge. Same pointer, two grabs, and neither can be mistaken for the other — which
// is what lets the sockets be always-available on a selected card without the accidental-connector
// problem Miro's users report.
// ============================================================
import { state, stage, setStatus, type BoardEdge, type EdgeSide } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { makeEdge, scheduleSaveBoard } from '../data/board.js';
import { paintFreeEdges, facingSides, portPoint, socketPoints, edgeGeometry, connectable } from '../view/free-edges.js';
import { syncEdgeBar, startLabelEdit } from './edge-bar.js';
import { touchEdges, commitStep } from './history.js';
import { isHidden } from '../utils/model.js';
import { screenToWorld } from '../view/camera.js';
import { paintAll, nodeW, nodeH } from '../main.js';

// Every selected edge, in board order. What the float bar's colour, dash, direction and delete act on.
export function selectedEdges(): BoardEdge[] {
  return state.edges.filter(e => state.selEdges.has(e.id));
}
// The one the bar hangs off and reads its state from: the LAST one clicked. `selEdges` is a Set, so
// its iteration order is insertion order and the newest is simply the last — which is the edge the
// user's attention is on, and the only one whose position the bar can sensibly follow.
export function leadEdge(): BoardEdge | null {
  const ids = [...state.selEdges];
  const last = ids[ids.length - 1];
  return last ? state.edges.find(e => e.id === last) ?? null : null;
}
// Selecting an edge clears the card selection and vice versa — see AppState.selEdges. `add` is the
// ⌘/Ctrl-click path and TOGGLES, exactly as it does for cards (main.ts selectNode).
export function selectEdge(id: string | null, add = false): void {
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

export function addEdge(fromId: string, toId: string, fromSide?: EdgeSide, toSide?: EdgeSide): BoardEdge | null {
  if (fromId === toId) return null;
  if (!connectable(fromId) || !connectable(toId)) return null;
  // Choose the ports ONCE, here. From then on they are the edge's own (core/state.ts EdgeSide) and
  // moving either card slides the line along its faces rather than re-picking them.
  const a = state.nodes.get(fromId)!, b = state.nodes.get(toId)!;
  const facing = facingSides(a, b);
  const fs = fromSide ?? facing.from, ts = toSide ?? facing.to;
  // Two cards may be joined by SEVERAL edges — "blocks" one way and "informs" the other is an
  // ordinary thing to want to say. What is refused is a second edge between the same two PORTS,
  // which would lie exactly on top of the first and be indistinguishable from it; that selects the
  // existing one instead. Direction is part of the identity: A.right→B.left and B.left→A.right are
  // the same physical line, so the reversed pair counts as the same edge.
  const dup = state.edges.find(e =>
    (e.from === fromId && e.to === toId && e.fromSide === fs && e.toSide === ts) ||
    (e.from === toId && e.to === fromId && e.fromSide === ts && e.toSide === fs));
  if (dup) { selectEdge(dup.id); return dup; }
  touchEdges();
  const e = makeEdge(fromId, toId, fs, ts);
  state.edges.push(e);
  scheduleSaveBoard();
  return e;
}
export function deleteEdge(id: string): void {
  const i = state.edges.findIndex(e => e.id === id);
  if (i < 0) return;
  touchEdges();
  state.edges.splice(i, 1);
  state.selEdges.delete(id);
  scheduleSaveBoard();
  paintAll();
  syncEdgeBar();
  commitStep();
  setStatus('Edge deleted');
}

// ⌘L / the float bar's Connect. Two cards selected: connect them. One selected: arm the sockets (they
// are already showing) and say so. This is the TOUCH path — iOS never fires contextmenu on
// long-press, so a socket drag can't be the only way in.
export function connectSelection(): void {
  if (state.readOnly) return;
  const ids = [...state.sel];
  if (ids.length < 2) { setStatus('Select two cards to connect — or drag from a ring on the selected card.'); return; }
  let made = 0;
  // Chain them in selection order: 3+ cards give A→B→C, which is what a flow usually wants — and as
  // ONE undo step, since it was one command.
  touchEdges();
  for (let i = 0; i < ids.length - 1; i++) if (addEdge(ids[i], ids[i+1])) made++;
  paintAll();
  commitStep();
  setStatus(made ? `Connected ${made + 1} cards` : 'Already connected');
}

// The node under a point, topmost first — the drop test for both a fresh draw and a re-route.
function nodeAt(p: Pt): string | null {
  let hit: string | null = null;
  for (const n of state.nodes.values()) {
    if (isHidden(n) || !connectable(n.id)) continue;
    if (p.x < n.x || p.y < n.y || p.x > n.x + nodeW(n) || p.y > n.y + nodeH(n)) continue;
    hit = n.id;      // later nodes paint over earlier ones; take the last match
  }
  return hit;
}
// How far outside a card still counts as "coming in to land" — the distance at which its ports light
// up so you can see what there is to aim at. Generous on purpose; it commits to nothing.
const PORT_HINT_DIST = 70;
// How near a PORT the pointer must actually be to snap to it, in SCREEN pixels (divided by the zoom
// below, so it feels the same however far out you are). Tight on purpose: docking is a choice, and a
// line that leapt onto a port the moment the pointer drifted within range of the CARD was making
// that choice on the user's behalf from much too far away.
const PORT_SNAP_PX = 20;
// The port under the pointer, or null. THE one thing that decides where an edge docks — both the
// live preview and the drop ask it, so they cannot disagree.
export function portSnapAt(p: Pt, excludeId?: string): { nodeId: string; side: EdgeSide } | null {
  const reach = PORT_SNAP_PX / (state.view.k || 1);
  let best: { nodeId: string; side: EdgeSide } | null = null, bestD = reach;
  for (const n of state.nodes.values()) {
    if (isHidden(n) || n.id === excludeId || !connectable(n.id)) continue;
    for (const { side, p: pt } of socketPoints(n)) {
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d < bestD) { bestD = d; best = { nodeId: n.id, side }; }
    }
  }
  return best;
}
// The card the pointer is over, or the nearest one within PORT_HINT_DIST of it — the card whose
// ports are worth showing. Commits to nothing; portSnapAt decides the docking.
function nodeNear(p: Pt): string | null {
  const over = nodeAt(p);
  if (over) return over;
  let best: string | null = null, bestD = PORT_HINT_DIST;
  for (const n of state.nodes.values()) {
    if (isHidden(n) || !connectable(n.id)) continue;
    const dx = Math.max(n.x - p.x, 0, p.x - (n.x + nodeW(n)));
    const dy = Math.max(n.y - p.y, 0, p.y - (n.y + nodeH(n)));
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

// ---------- pointer wiring ----------
// Bound on #STAGE in the CAPTURE phase so a grab on a socket, a handle or an edge is claimed before
// the card-drag and canvas-pan handlers below it ever see the event.
//
// #stage, not #world: `#world` is a transform origin with no size of its own (its rect is 0×0), so a
// click on the empty canvas never lands inside it and a listener there never hears one — which is
// exactly why a selected edge couldn't be dismissed by clicking away. #stage is the full-viewport
// surface, and the cards and the edge SVGs are all inside it, so one listener sees everything.
export function installEdgeTools(): void {
  stage.addEventListener('pointerdown', (ev: PointerEvent) => {
    const t = ev.target as Element | null;
    if (!t) return;
    const socket = t.closest('[data-socket]') as SVGElement | null;
    const handle = t.closest('[data-handle]') as SVGElement | null;
    const hit    = t.closest('[data-edge]') as SVGElement | null;

    if (socket && !state.readOnly) {
      const id = socket.getAttribute('data-node')!;
      const from = { x: +socket.getAttribute('cx')!, y: +socket.getAttribute('cy')! };
      // The ring you grabbed IS the port the finished edge docks to.
      beginDraw(ev, { from, to: from, sourceId: id, fromSide: socket.getAttribute('data-socket') as EdgeSide });
      return;
    }
    if (handle && !state.readOnly) {
      const edge = state.edges.find(e => e.id === handle.getAttribute('data-edge'));
      if (!edge) return;
      const end = handle.getAttribute('data-handle') as 'from' | 'to';
      // The end you are NOT dragging is the anchor the rubber line hangs off.
      const anchorId = end === 'to' ? edge.from : edge.to;
      const anchor = state.nodes.get(anchorId);
      if (!anchor) return;
      // The rubber line hangs off the port at the end you are NOT dragging, so it keeps its shape.
      const anchorSide = end === 'to' ? edge.fromSide : edge.toSide;
      beginDraw(ev, { from: portPoint(anchor, anchorSide), to: portPoint(anchor, anchorSide),
                      sourceId: anchorId, fromSide: anchorSide, edgeId: edge.id, end });
      return;
    }
    if (hit) {
      // stopPropagation only — preventDefault on pointerdown suppresses the click/dblclick the
      // browser would otherwise synthesise, and the press below is timed against the next one.
      ev.stopPropagation();
      const id = hit.getAttribute('data-edge')!;
      const dbl = twoPresses(id, ev);
      selectEdge(id, ev.metaKey || ev.ctrlKey);
      if (state.readOnly) return;
      // preventDefault ONLY here: the field is focused two lines down, and the press's default
      // action would move focus straight back out of it — a blur commits and closes the editor, so
      // without this the label opens and shuts in the same tick and nothing appears to happen.
      if (dbl) { ev.preventDefault(); startLabelEdit(id); return; }
      armBodyGrab(ev, id);
      return;
    }
    // Anything else on the canvas — a card, the background — takes the selection back, so an edge
    // and a card are never both selected (see AppState.selEdges).
    clearEdgeSelection();
  }, true);
  // Double-click an edge → edit its label. The browser's own `dblclick` cannot be used for this: the
  // FIRST click selects the edge, which repaints #freeEdges wholesale, so the element the second
  // click lands on is not the one the first did — and Chrome, finding no common target still in the
  // document, dispatches no dblclick at all. (Same hazard as main.ts's node cache.) So the two
  // presses are counted here instead, which has the side benefit of giving touch the gesture for
  // free: a double TAP on a line opens its label, and iOS never has to synthesise anything.
  stage.addEventListener('dblclick', (ev: MouseEvent) => {
    // …and on the occasions one DOES arrive (a click that changed nothing, so nothing repainted), it
    // must not fall through to the canvas's own double-click, which would drop a card on the line.
    if ((ev.target as Element | null)?.closest('[data-edge]')) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
}

// Two presses on the SAME edge, close enough in time and place to be one gesture. Deliberately not a
// dblclick: see the listener above.
const DBL_MS = 450, DBL_SLOP = 6;
let lastPress = { id: '', t: 0, x: 0, y: 0 };
function twoPresses(id: string, ev: PointerEvent): boolean {
  const near = lastPress.id === id && ev.timeStamp - lastPress.t < DBL_MS
            && Math.hypot(ev.clientX - lastPress.x, ev.clientY - lastPress.y) < DBL_SLOP;
  // The second press ends the pair rather than starting a new one, so a triple-click doesn't
  // re-open the editor the second one just opened.
  lastPress = { id: near ? '' : id, t: ev.timeStamp, x: ev.clientX, y: ev.clientY };
  return near;
}

// Grabbing the LINE ITSELF re-routes it — the half you take hold of is the end that comes loose.
// It is the gesture the shape already suggests: an edge looks like a piece of string between two
// pins, so pulling on one half should lift that end off its pin. The endpoint handles still work and
// are the precise version; this is the one you reach for without aiming.
//
// Armed, not started: a press that never moves is a plain selection (and a double-press is a label),
// so the re-route only begins once the pointer has travelled far enough to mean it.
const GRAB_SLOP = 4;
function armBodyGrab(down: PointerEvent, edgeId: string): void {
  const start = { x: down.clientX, y: down.clientY };
  const move = (e: PointerEvent): void => {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < GRAB_SLOP) return;
    stop();
    const edge = state.edges.find(x => x.id === edgeId); if (!edge) return;
    const g = edgeGeometry(edge); if (!g) return;
    // Which half was grabbed, measured against the route's own midpoint rather than the straight
    // line between the ports — on an elbow those are different points, and the midpoint is where the
    // label sits, so it is the division the user can actually see.
    const at = screenToWorld(start.x, start.y);
    const dFrom = Math.hypot(at.x - g.a.x, at.y - g.a.y), dTo = Math.hypot(at.x - g.b.x, at.y - g.b.y);
    const end: 'from' | 'to' = dFrom <= dTo ? 'from' : 'to';
    const anchorId = end === 'to' ? edge.from : edge.to;
    const anchorSide = end === 'to' ? edge.fromSide : edge.toSide;
    const anchor = state.nodes.get(anchorId); if (!anchor) return;
    const p = portPoint(anchor, anchorSide);
    beginDraw(e, { from: p, to: p, sourceId: anchorId, fromSide: anchorSide, edgeId, end });
  };
  const up = (): void => stop();
  const stop = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function beginDraw(ev: PointerEvent, seed: NonNullable<typeof ui.edgeDraw>): void {
  ev.preventDefault(); ev.stopPropagation();
  ui.edgeDraw = seed;
  const move = (e: PointerEvent): void => {
    const at = screenToWorld(e.clientX, e.clientY);
    const draw = ui.edgeDraw!;
    draw.to = at;
    // Show the ports of whatever card is close (an aim), and snap only to a port the pointer has
    // actually reached (a commitment).
    const hintId = nodeNear(at);
    draw.hintId = hintId && hintId !== draw.sourceId ? hintId : undefined;
    const snap = portSnapAt(at, draw.sourceId);
    draw.overId = snap?.nodeId;
    draw.overSide = snap?.side;
    paintFreeEdges();
  };
  const up = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    const draw = ui.edgeDraw!; ui.edgeDraw = null;
    finishDraw(draw, screenToWorld(e.clientX, e.clientY));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function finishDraw(draw: NonNullable<typeof ui.edgeDraw>, at: Pt): void {
  // The SAME question the preview asked: the port the line snapped to, or nothing. Preview and
  // commit disagreeing about the target is the one thing a drop gesture must never do.
  const snap = portSnapAt(at, draw.sourceId);
  const target = snap?.nodeId ?? null;
  const existing = draw.edgeId ? state.edges.find(e => e.id === draw.edgeId) : null;
  if (existing) {
    // Released without reaching a port: the end has nothing to attach to, and an edge with one end
    // nowhere is not a thing this format can hold — so the edge goes.
    if (!target) { deleteEdge(existing.id); return; }
    touchEdges();
    const side = snap!.side;
    if (draw.end === 'to') { existing.to = target; existing.toSide = side; }
    else { existing.from = target; existing.fromSide = side; }
    scheduleSaveBoard(); paintAll(); syncEdgeBar();
    commitStep();
    setStatus('Edge re-routed');
    return;
  }
  if (!target) { paintAll(); return; }                 // a draw into empty space just ends
  const made = addEdge(draw.sourceId, target, draw.fromSide, snap!.side);
  if (made) selectEdge(made.id); else paintAll();
  commitStep();
}

// Delete/Backspace with edges selected — handled before the card path in main.ts's key handler. All
// of them go in ONE undo step: the selection was the unit the user acted on.
export function deleteSelectedEdge(): boolean {
  const ids = [...state.selEdges];
  if (!ids.length) return false;
  touchEdges();
  for (const id of ids) {
    const i = state.edges.findIndex(e => e.id === id);
    if (i >= 0) state.edges.splice(i, 1);
  }
  state.selEdges.clear();
  scheduleSaveBoard();
  paintAll();
  syncEdgeBar();
  commitStep();
  setStatus(ids.length > 1 ? `${ids.length} edges deleted` : 'Edge deleted');
  return true;
}
