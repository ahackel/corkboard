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
import { makeEdge, makeJunction, gcJunctions, junctionOf, scheduleSaveBoard } from '../data/board.js';
import { paintFreeEdges, facingSides, socketPoints, edgeGeometry, connectable, edgeVisible,
         junctionShown, endPoint, nearestOnPolyline, HIT_W, SOCKET_R } from '../view/free-edges.js';
import { syncEdgeBar, startLabelEdit } from './edge-bar.js';
import { touchEdges, commitStep } from './history.js';
import { isHidden } from '../utils/model.js';
import { screenToWorld } from '../view/camera.js';
import { snapTo } from '../utils/num.js';
import { paintAll, nodeW, nodeH, gridSnap, snapPt } from '../main.js';

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
  // A junction end has no node and no faces: the sides come from the caller (a drop always knows
  // them), and facingSides is asked only when both ends are cards.
  const a = state.nodes.get(fromId), b = state.nodes.get(toId);
  const facing = a && b ? facingSides(a, b) : null;
  const fs = fromSide ?? facing?.from ?? 'right', ts = toSide ?? facing?.to ?? 'left';
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
  gcJunctions();                 // the point this was the last edge at goes with it
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
// An existing junction under the pointer, or null — the second thing a drop can land ON, asked with
// the same reach as a port so the two feel like one gesture. This is what makes three lines meet at
// ONE point instead of at three points a pixel apart, which would look joined until you dragged one.
export function junctionSnapAt(p: Pt, excludeId?: string): string | null {
  const reach = Math.max(PORT_SNAP_PX, SOCKET_R * 2) / (state.view.k || 1);
  let best: string | null = null, bestD = reach;
  for (const j of state.junctions) {
    if (j.id === excludeId || !junctionShown(j.id)) continue;   // the drop's targets are the painted set
    const d = Math.hypot(j.x - p.x, j.y - p.y);
    if (d < bestD) { bestD = d; best = j.id; }
  }
  return best;
}
// The EDGE under the pointer, or null — the third thing a drop can land on, and the only way a
// junction is ever made. Measured against the route as it is drawn (its polyline), so the target is
// the line the user can see rather than a straight guess between the ports.
export function edgeSnapAt(p: Pt, excludeId?: string): { id: string; at: Pt } | null {
  const reach = Math.max(HIT_W / 2, 14 / (state.view.k || 1));
  let best: { id: string; at: Pt } | null = null, bestD = reach;
  for (const e of state.edges) {
    // Only a line the user can SEE is a line they can drop onto — the same gate portSnapAt applies to
    // cards. Without it an end could be dropped on an edge hidden under a fold or outside the open
    // frame, splitting something that isn't on screen.
    if (e.id === excludeId || !edgeVisible(e)) continue;
    const g = edgeGeometry(e); if (!g) continue;
    const near = nearestOnPolyline(g.pts, p);
    // On the grid here, once: this is the point the ghost shows and the point the split uses.
    if (near.d < bestD) { bestD = near.d; best = { id: e.id, at: snapPt(near.at) }; }
  }
  return best;
}

// Drop an end on a line and the line SPLITS there: a junction at the point, and the target becomes
// two edges meeting at it. That is the only way a junction comes into being, which is why there is
// nothing to "place" and no tool to pick up — the branch appears where you joined the two lines.
//
// The first half keeps the original edge's id, its label and its cap at the far end; the second half
// is a new edge carrying the same colour, dash and the original's OTHER cap. The two ends that MEET at
// the junction lose their terminators — an arrowhead there would point into a dot the line merely
// passes through, and one head per half would land two of them in the middle of what reads as one
// line. That is an edit to the caps, not a drawing rule: the edge bar can put one back.
function splitEdgeAt(edgeId: string, at: Pt): string | null {
  const e = state.edges.find(x => x.id === edgeId); if (!e) return null;
  // `at` is the projection onto the line, already put on the grid by edgeSnapAt — so the dot lands where
  // the ghost showed it, and no longer on the line's OLD path, which it does not need to: both halves
  // re-route through the point the moment it exists.
  // If a point is already within snapping reach, meet THAT one instead of stacking a second dot on it —
  // the same question junctionSnapAt answers for the pointer, at the same tolerance.
  const here = junctionSnapAt(at);
  const j = here ? junctionOf(here)! : makeJunction(at.x, at.y);
  const tail = makeEdge(j.id, e.to, e.toSide, e.toSide);
  tail.color = e.color; tail.dashed = e.dashed; tail.fromCap = 'none'; tail.toCap = e.toCap;
  e.to = j.id; e.toCap = 'none';      // …the head keeps everything else it had, id and label included
  state.edges.push(tail);
  return j.id;
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
    const dot    = t.closest('[data-junction]') as SVGElement | null;
    const hit    = t.closest('[data-edge]') as SVGElement | null;

    if (dot && !state.readOnly) {
      // A dot is a thing you MOVE and nothing else: it has no properties, and it needs no delete —
      // pull one of its lines off and the point dissolves itself (data/board.ts gcJunctions).
      dragJunction(ev, dot.getAttribute('data-junction')!);
      return;
    }

    if (socket && !state.readOnly) {
      const id = socket.getAttribute('data-node')!;
      const from = { x: +socket.getAttribute('cx')!, y: +socket.getAttribute('cy')! };
      // The ring you grabbed IS the port the finished edge docks to.
      beginDraw(ev, { from, to: from, sourceId: id, grabbedAt: screenToWorld(ev.clientX, ev.clientY),
                      fromSide: socket.getAttribute('data-socket') as EdgeSide });
      return;
    }
    if (handle && !state.readOnly) {
      const edge = state.edges.find(e => e.id === handle.getAttribute('data-edge'));
      if (!edge) return;
      const end = handle.getAttribute('data-handle') as 'from' | 'to';
      // The end you are NOT dragging is the anchor the rubber line hangs off.
      const anchorId = end === 'to' ? edge.from : edge.to;
      // The rubber line hangs off the far end, whatever KIND it is — a card's port or a junction —
      // so it keeps its shape while you move this one.
      const anchorSide = end === 'to' ? edge.fromSide : edge.toSide;
      const p = endPoint(anchorId, anchorSide);
      if (!p) return;
      beginDraw(ev, { from: p, to: p, sourceId: anchorId, grabbedAt: screenToWorld(ev.clientX, ev.clientY),
                      fromSide: anchorSide, edgeId: edge.id, end });
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

// Dragging a meeting point MOVES it, and every line ending there follows — that is the whole reason
// the point is a shared entity with an id rather than a pair of coordinates stored on each end.
// A plain pointer drag, not the edge-draw machinery: nothing is being connected or disconnected, so
// there is no target to snap to and no landing to decide. The point stays where it is dropped.
function dragJunction(down: PointerEvent, id: string): void {
  down.preventDefault(); down.stopPropagation();
  const j = junctionOf(id); if (!j) return;
  const start = screenToWorld(down.clientX, down.clientY);
  const from = { x: j.x, y: j.y };
  let moved = false;
  const move = (e: PointerEvent): void => {
    const at = screenToWorld(e.clientX, e.clientY);
    // Snapshot on the FIRST real movement, so a press that only selects nothing leaves no undo step.
    if (!moved) { moved = true; touchEdges(); }
    // Snapped to the visible grid on every move, exactly as a dragged card is (utils/num.ts snapTo — a
    // no-op when the grid is off): the dot is always ON a grid position and steps to the next as the
    // pointer crosses halfway, so there is nothing left for the release to correct.
    const g = gridSnap();
    j.x = snapTo(from.x + (at.x - start.x), g);
    j.y = snapTo(from.y + (at.y - start.y), g);
    paintFreeEdges();
  };
  const up = (): void => {
    stop();
    if (!moved) return;
    scheduleSaveBoard();
    commitStep();
  };
  const stop = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
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
    const p = endPoint(anchorId, anchorSide); if (!p) return;
    beginDraw(e, { from: p, to: p, sourceId: anchorId, grabbedAt: at,
                   fromSide: anchorSide, edgeId, end });
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
  // Cancelling and releasing are now DIFFERENT outcomes, where both used to run finishDraw: a
  // release lands the end (and makes a junction if it is over nothing), so a cancelled gesture —
  // Esc, or the pointer being taken away by the system — has to be able to leave everything alone.
  const abort = (): void => { stop(); ui.edgeDraw = null; paintFreeEdges(); };
  const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); abort(); } };
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
    // A card's port wins over a junction, and a junction over a line: most specific target first, and
    // the same order the drop itself asks in (landing).
    draw.overJunction = snap ? undefined : junctionSnapAt(at, draw.sourceId) ?? undefined;
    const onEdge = (snap || draw.overJunction) ? null : edgeSnapAt(at, draw.edgeId);
    draw.overEdge = onEdge?.id;
    draw.overEdgeAt = onEdge?.at;
    paintFreeEdges();
  };
  const up = (e: PointerEvent): void => {
    stop();
    const draw = ui.edgeDraw; ui.edgeDraw = null;
    if (draw) finishDraw(draw, screenToWorld(e.clientX, e.clientY));
  };
  const stop = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', abort);
    window.removeEventListener('keydown', key);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', abort);
  window.addEventListener('keydown', key);
}

// How far the pointer must travel before a release lands anything. Below it the gesture was a press, not
// a drag — a tug on a handle must not throw away the edge it grabbed, and a twitch on a socket must not
// draw one. (armBodyGrab has its own, smaller slop for a different question: whether to START a
// re-route at all rather than treat the press as a selection.)
const MIN_DRAG_PX = 12;

// Where a released end lands, read STRAIGHT OFF the live preview: whatever the last pointermove decided
// (a card's port, an existing junction, or a line to split, in that order of specificity — see move()).
// Asking the three spatial questions again here is how a drop and the ghost that promised it come to
// disagree; taking the answer that was on screen makes that impossible by construction.
// A junction's own side is meaningless — endSide derives it per paint from where the other end is — so
// 'left' is a placeholder, not a choice.
function landing(draw: NonNullable<typeof ui.edgeDraw>): { id: string; side: EdgeSide; onJunction: boolean } | null {
  if (draw.overId && draw.overSide) return { id: draw.overId, side: draw.overSide, onJunction: false };
  if (draw.overJunction) return { id: draw.overJunction, side: 'left', onJunction: true };
  if (draw.overEdge && draw.overEdgeAt) {
    const id = splitEdgeAt(draw.overEdge, draw.overEdgeAt);
    return id ? { id, side: 'left', onJunction: true } : null;
  }
  return null;
}

function finishDraw(draw: NonNullable<typeof ui.edgeDraw>, at: Pt): void {
  // A press that never travelled is not a drag at all: nothing lands, nothing is deleted, and — since
  // nothing changes — nothing is snapshotted either. This is what stops a twitch on a handle from
  // throwing away the edge it grabbed.
  const travelled = Math.hypot(at.x - draw.grabbedAt.x, at.y - draw.grabbedAt.y) * (state.view.k || 1);
  if (travelled < MIN_DRAG_PX) { paintFreeEdges(); return; }
  const existing = draw.edgeId ? state.edges.find(e => e.id === draw.edgeId) : null;
  // touchEdges BEFORE landing(): the point it may create is part of the step, and the snapshot has
  // to predate it or an undo would leave the junction behind with nothing ending at it.
  touchEdges();
  const land = landing(draw);
  // Released over nothing: an edge cannot have an end that is nowhere, so a re-route that reached no
  // card, junction or line takes the edge with it — dragging an end off into space is how you throw a
  // line away. A fresh draw simply never became one.
  // The same tail covers the two other ways this comes to nothing: an edge onto its own other end, and
  // an addEdge that refused. All three leave the graph as it was, minus any point landing() had minted.
  const nothing = (): void => { gcJunctions(); paintAll(); commitStep(); };
  if (!land) { if (existing) deleteEdge(existing.id); else nothing(); return; }
  if (existing) {
    // Both ends on the same point would be an edge from somewhere to itself — nothing to draw and
    // nothing meant by it. (The snappers already exclude the anchor, so this only catches a NEW point
    // minted right on top of it.)
    if ((draw.end === 'to' ? existing.from : existing.to) === land.id) { nothing(); return; }
    // The edge keeps its terminators wherever the end lands, junction included: an end MEETING a point
    // is still that line's end, and the arrow says which way it runs. Only the line being SPLIT loses
    // caps, and only at the cut (splitEdgeAt).
    if (draw.end === 'to') { existing.to = land.id; existing.toSide = land.side; }
    else { existing.from = land.id; existing.fromSide = land.side; }
    gcJunctions();                                      // the point it just left may now be empty
    scheduleSaveBoard(); paintAll(); syncEdgeBar();
    commitStep();
    setStatus(land.onJunction ? 'Lines joined at a junction' : 'Edge re-routed');
    return;
  }
  const made = addEdge(draw.sourceId, land.id, draw.fromSide, land.side);
  if (!made) { nothing(); return; }
  selectEdge(made.id);
  if (land.onJunction) setStatus('Lines joined at a junction');
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
  gcJunctions();
  scheduleSaveBoard();
  paintAll();
  syncEdgeBar();
  commitStep();
  setStatus(ids.length > 1 ? `${ids.length} edges deleted` : 'Edge deleted');
  return true;
}
