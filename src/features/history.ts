// ---------- undo / redo ----------
// A unified, in-memory history of every mutation, as per-step per-node before/after snapshots
// keyed by node id (safe: ids are stable within a session and the history is cleared on every
// loadFromDir). Capture is a lazy "pending step": any mutation site calls touch(id) BEFORE
// changing a node (creations touch before inserting, so their before-image is null) and some
// gesture boundary calls commitStep() — pointer-up for drags, end-of-edit for inline editing,
// record() for one-shot ops. A step whose before/after images are identical is discarded, so
// plain clicks, cancelled drags and unchanged edits never pollute the history.
import { state, stage, setStatus, type MindNode, type Stroke, type BoardEdge, type Junction } from '../core/state.js';
import { frameBox } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { scheduleSaveBoard } from '../data/board.js';
import { setSelectionSet, popScopeFor, nodeW, nodeH, remeasure } from '../main.js';
import { paintStrokes } from './sketch.js';
import { endInPlaceEdit } from './inline-edit.js';
import { syncEdgeBar } from './edge-bar.js';
import { isScopeRoot } from '../nav/scope.js';
import { byId } from '../utils/dom.js';

// Everything persistent about a node EXCEPT its identity/render/dirty fields. `file` is
// snapshotted (needed to restore a deleted node) but is NOT written back onto a node that
// still exists — see applyImages. rx/ry are omitted too: they're the persisted relative form of
// x/y, re-derived by commitRel() before each save, so restoring x/y suffices. `w`/`h` ARE
// snapshotted — without them a resize that only moves the east/south edge left x/y unchanged, so
// sameSnap() saw no difference and commitStep() discarded the whole step (⌘Z then undid the
// PREVIOUS action instead). A stack's `h` is derived, but restoring it is harmless: applyStep
// re-runs applyLayouts(), which recomputes it.
type NodeSnap = Omit<MindNode, 'id' | 'el' | 'frameContentEl' | 'tabStripEl' | 'dirty' | 'dirtyLayout' | '_parentPath' | 'rx' | 'ry'>;
type Images = Map<string, NodeSnap | null>;      // null = the node does not exist
// A step captures node before/after images and, where an op changed something that isn't a node:
// the whole strokes array (a sketch gesture, see touchStrokes), the map's canvas colour (see
// touchCanvas), and the whole EDGE list (see touchEdges). One unified timeline covers all four —
// ⌘Z after recolouring the canvas has to put the colour back wherever you were standing, and inside
// an open frame that same gesture edits a NODE, so the two halves of one button must land in the
// same history. Deleting a CARD is the case that makes edges part of it rather than a timeline of
// their own: it removes the card AND every edge touching it, and one ⌘Z has to bring back both.
//
// Edges are snapshotted WHOLESALE rather than per-edge. There are few of them, they're small, and
// the alternative — keyed before/after images like nodes — buys nothing here: an edge has no
// identity problem to solve (its id is persisted) and no resurrect-vs-update distinction to make.
interface Step {
  before: Images; after: Images;
  strokes?: { before: Stroke[]; after: Stroke[] };
  canvas?: { before: string; after: string };
  edges?: { before: EdgeGraph; after: EdgeGraph };
}
// The edges AND the junctions they meet at, snapshotted together as one thing — which is what they
// are: a junction exists only as the point some edges share (core/state.ts Junction), so restoring
// one list without the other would leave lines ending nowhere, or a dot with nothing at it. Moving a
// junction touches only the second half, which is why the comparison below has to see both.
type EdgeGraph = { edges: BoardEdge[]; junctions: Junction[] };

const MAX_STEPS = 100;
const undoStack: Step[] = [];
const redoStack: Step[] = [];
let pending: Images | null = null;
let pendingStrokes: Stroke[] | null = null;      // strokes before-image for the open step, if a sketch op touched it
let pendingCanvas: string | null = null;         // canvas-colour before-image for the open step, if one was picked
let pendingEdges: EdgeGraph | null = null;       // edge-graph before-image for the open step, if an edge op touched it

const cloneStrokes = (s: Stroke[]): Stroke[] => structuredClone(s);
const sameStrokes = (a: Stroke[], b: Stroke[]): boolean => JSON.stringify(a) === JSON.stringify(b);
const cloneGraph = (g: EdgeGraph): EdgeGraph => structuredClone(g);
const sameGraph = (a: EdgeGraph, b: EdgeGraph): boolean => JSON.stringify(a) === JSON.stringify(b);
const liveGraph = (): EdgeGraph => ({ edges: state.edges, junctions: state.junctions });

// Fixed key order (so JSON-compare in commitStep is reliable) + deep copies of the arrays.
function snap(n: MindNode): NodeSnap {
  return {
    file: n.file, x: n.x, y: n.y, parent: n.parent,
    collapsed: n.collapsed, locked: n.locked, done: n.done, checklist: n.checklist,
    type: n.type, layout: n.layout, w: n.w, h: n.h,
    title: n.title, color: n.color, keepStatus: n.keepStatus,
    tags: [...n.tags], body: n.body, titleGap: n.titleGap,
    fmEntries: n.fmEntries?.map(e => ({ key: e.key, lines: [...e.lines] })),
    kidOrder: n.kidOrder ? [...n.kidOrder] : undefined,
  };
}
const cloneSnap = (s: NodeSnap): NodeSnap => structuredClone(s);
const sameSnap = (a: NodeSnap | null, b: NodeSnap | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// Remember a node's pre-mutation image in the pending step (opening one if needed). Call
// BEFORE mutating — and for creations, before state.nodes.set(), so the image is null.
// Idempotent per id; a no-op in read-only mode (nothing records there).
export function touch(...ids: (string | null | undefined)[]): void {
  if (state.readOnly) return;
  for (const id of ids) {
    if (!id) continue;
    if (!pending) pending = new Map();
    if (pending.has(id)) continue;
    const n = state.nodes.get(id);
    pending.set(id, n ? snap(n) : null);
  }
}
// Remember the ink layer's pre-mutation image in the pending step. Call BEFORE changing
// state.strokes (adding a stroke, erasing). Idempotent per step; a no-op in read-only mode.
export function touchStrokes(): void {
  if (state.readOnly) return;
  if (!pendingStrokes) pendingStrokes = cloneStrokes(state.strokes);
}
// Remember the map's canvas colour before changing it. Idempotent per step, and `=== null` rather
// than a falsy test: '' (the theme default) is a real value and the commonest before-image there is.
export function touchCanvas(): void {
  if (state.readOnly) return;
  if (pendingCanvas === null) pendingCanvas = state.canvasColor;
}
// Remember the edge graph before changing it — drawing, deleting, re-routing, restyling or MOVING a
// junction, and the pruning that follows a card delete. Call BEFORE the change. Idempotent per step, and a
// no-op in read-only mode, like the rest.
export function touchEdges(): void {
  if (state.readOnly) return;
  if (!pendingEdges) pendingEdges = cloneGraph(liveGraph());
}
// Close the pending step: capture after-images, drop untouched-in-practice nodes, and push.
export function commitStep(): void {
  const before = pending; pending = null;
  const strokesBefore = pendingStrokes; pendingStrokes = null;
  const canvasBefore = pendingCanvas; pendingCanvas = null;
  const edgesBefore = pendingEdges; pendingEdges = null;
  const step: Step = { before: new Map(), after: new Map() };
  if (before) for (const [id, b] of before) {
    const n = state.nodes.get(id);
    const a = n ? snap(n) : null;
    if (sameSnap(b, a)) continue;
    step.before.set(id, b); step.after.set(id, a);
  }
  if (strokesBefore && !sameStrokes(strokesBefore, state.strokes))
    step.strokes = { before: strokesBefore, after: cloneStrokes(state.strokes) };
  if (canvasBefore !== null && canvasBefore !== state.canvasColor)
    step.canvas = { before: canvasBefore, after: state.canvasColor };
  if (edgesBefore && !sameGraph(edgesBefore, liveGraph()))
    step.edges = { before: edgesBefore, after: cloneGraph(liveGraph()) };
  if (!step.before.size && !step.strokes && !step.canvas && !step.edges) return;   // nothing changed
  undoStack.push(step);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
// Sugar for one-shot synchronous ops. Re-entrant: called while another step is already
// pending (e.g. deleteNode inside a live drag), it only touches — the outer owner commits.
export function record(ids: Iterable<string | null | undefined>, fn: () => void): void {
  const owner = !pending;
  touch(...ids);
  fn();
  if (owner) commitStep();
}
export function clearHistory(): void {
  undoStack.length = 0; redoStack.length = 0;
  pending = null; pendingStrokes = null; pendingCanvas = null; pendingEdges = null;
  updateUndoButtons();
}

// Overwrite live state with one side of a step's images.
function applyImages(images: Images): void {
  for (const [id, s] of images) {
    const live = state.nodes.get(id);
    if (!s) {                                       // node must not exist
      if (live) {
        state.nodes.delete(id);
        live.el?.remove(); live.el = null;
        if (live.file) state.toDelete.push(live.file);
      }
    } else if (live) {
      // Keep the CURRENT file path: if a rename already flushed, saveAll's phase 1 must see
      // the on-disk name so it can rename back — restoring the old path would orphan the new
      // file. The restored title re-derives the right name via desiredFileFor.
      Object.assign(live, cloneSnap(s), { file: live.file });
      live.dirty = true; live.dirtyLayout = true;
    } else {                                        // resurrect a deleted node
      // rx/ry are re-derived from the restored x/y by commitRel() before the next save.
      state.nodes.set(id, { id, ...cloneSnap(s), rx: 0, ry: 0, dirty: true, dirtyLayout: true, el: null });
    }
  }
}
// Glide to the affected nodes only when they're entirely off-screen; a visible change
// shouldn't yank the camera around.
function frameIfOffscreen(ids: string[]): void {
  const nodes = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!nodes.length) return;
  const v = state.view, r = stage.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x * v.k + v.x);            minY = Math.min(minY, n.y * v.k + v.y);
    maxX = Math.max(maxX, (n.x + nodeW(n)) * v.k + v.x); maxY = Math.max(maxY, (n.y + nodeH(n)) * v.k + v.y);
  }
  if (maxX < 0 || minX > r.width || maxY < 0 || minY > r.height) frameBox(nodes);
}
function applyStep(images: Images, strokes: Stroke[] | undefined, canvas: string | undefined,
                   edges: EdgeGraph | undefined, label: string): void {
  applyImages(images);
  // Edges go back BEFORE the paint below, like the canvas colour: paintAll paints the free-edge
  // layer, so restoring them here means one pass rather than two. A selected edge the step removed
  // stops resolving, which is what closes its bar (features/edge-bar.ts syncEdgeBar).
  if (edges) {
    const g = cloneGraph(edges);
    state.edges = g.edges; state.junctions = g.junctions;
    for (const id of [...state.selEdges]) if (!state.edges.some(e => e.id === id)) state.selEdges.delete(id);
    scheduleSaveBoard();
  }
  if (strokes) { state.strokes = cloneStrokes(strokes); paintStrokes(); scheduleSaveBoard(); }
  // Restored BEFORE the paint below: syncCanvasBackground runs off paintAll, so the canvas repaints
  // in the same pass everything else does rather than needing a second one.
  if (canvas !== undefined) { state.canvasColor = canvas; scheduleSaveBoard(); }
  // paint first so resurrected cards have real DOM heights, then lay out, then commit
  remeasure();
  const ids = [...images.keys()].filter(id => state.nodes.has(id));
  // An undo can resurrect (or move) a node that lives outside the frame you're standing in — come out
  // of as many levels as it takes to show it, or setSelectionSet would silently drop it (isSelectable
  // refuses an out-of-scope id) and the step would look like it did nothing. See popScopeFor.
  // The one node that must NOT pop is the scope root itself. outOfScope deliberately reports it as
  // outside its own scope (that's what stops its box and tab being painted while you're inside it),
  // but it's the one node whose change you can always already see — the canvas IS it. Recolouring the
  // open frame from the canvas-colour button records a step on exactly that node, so without this
  // skip every ⌘Z would throw you out of the frame you were working in.
  const first = ids.map(id => state.nodes.get(id)).find((n): n is MindNode => !!n && !isScopeRoot(n));
  if (first) popScopeFor(first);
  setSelectionSet(ids);
  frameIfOffscreen(ids);
  syncEdgeBar();      // the selected edge may have moved, changed, or gone
  scheduleSave();
  setStatus(label);
}
export function undo(): void {
  if (state.readOnly) return;
  endInPlaceEdit();      // an open edit session becomes the step being undone
  commitStep();                        // flush any dangling pending step
  const step = undoStack.pop();
  if (!step) { setStatus('Nothing to undo'); return; }
  redoStack.push(step);
  applyStep(step.before, step.strokes?.before, step.canvas?.before, step.edges?.before, 'Undo');
  updateUndoButtons();
}
export function redo(): void {
  if (state.readOnly) return;
  endInPlaceEdit();
  commitStep();                        // a fresh step clears redo, so this usually empties it
  const step = redoStack.pop();
  if (!step) { setStatus('Nothing to redo'); return; }
  undoStack.push(step);
  applyStep(step.after, step.strokes?.after, step.canvas?.after, step.edges?.after, 'Redo');
  updateUndoButtons();
}

// ---------- toolbar buttons ----------
const undoBtn = byId<HTMLButtonElement>('undoBtn');
const redoBtn = byId<HTMLButtonElement>('redoBtn');
undoBtn.onclick = undo;
redoBtn.onclick = redo;
export function updateUndoButtons(): void {
  undoBtn.disabled = state.readOnly || !undoStack.length;
  redoBtn.disabled = state.readOnly || !redoStack.length;
}
updateUndoButtons();
