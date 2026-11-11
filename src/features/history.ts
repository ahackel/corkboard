// ---------- undo / redo ----------
// A unified, in-memory history of every mutation, as per-step per-node before/after snapshots
// keyed by node id (safe: ids are stable within a session and the history is cleared on every
// loadFromDir). Capture is a lazy "pending step": any mutation site calls touch(id) BEFORE
// changing a node (creations touch before inserting, so their before-image is null) and some
// gesture boundary calls commitStep() — pointer-up for drags, end-of-edit for inline editing,
// record() for one-shot ops. A step whose before/after images are identical is discarded, so
// plain clicks, cancelled drags and unchanged edits never pollute the history.
import { state, stage, setStatus, type MindNode, type BoardEdge } from '../core/state.js';
import { frameBox } from '../view/camera.js';
import { scheduleSaveBoard } from '../data/board.js';
import { remeasure } from '../main.js';
import { endInPlaceEdit } from './inline-edit.js';
import { syncEdgeBar } from './edge-bar.js';
import { isScopeRoot } from '../nav/scope.js';
import { nodesOf } from '../utils/model.js';
import { nodeW, nodeH } from '../view/geometry.js';
import { popScopeFor } from '../nav/sections.js';
import { setSelectionSet } from './selection.js';
import { scheduleSave } from '../data/save.js';
import { firstLineLabel } from '../utils/frontmatter.js';

// Everything persistent about a node EXCEPT its identity/render/dirty fields. `file` is
// snapshotted (needed to restore a deleted node) but is NOT written back onto a node that
// still exists — see applyImages. rx/ry are omitted too: they're the persisted relative form of
// x/y, re-derived by commitRel() before each save, so restoring x/y suffices. `w`/`h` ARE
// snapshotted — without them a resize that only moves the east/south edge left x/y unchanged, so
// sameSnap() saw no difference and commitStep() discarded the whole step (⌘Z then undid the
// PREVIOUS action instead).
type NodeSnap = Omit<MindNode, 'id' | 'el' | 'sectionContentEl' | 'dirty' | '_parentPath' | 'rx' | 'ry'>;
type Images = Map<string, NodeSnap | null>;      // null = the node does not exist
// A step captures node before/after images and, where an op changed something that isn't a node:
// the map's canvas colour (see touchCanvas) and the whole EDGE list (see touchEdges). One unified
// timeline covers all three —
// ⌘Z after recolouring the canvas has to put the colour back wherever you were standing, and inside
// an open section that same gesture edits a NODE, so the two halves of one button must land in the
// same history. Deleting a CARD is the case that makes edges part of it rather than a timeline of
// their own: it removes the card AND every edge touching it, and one ⌘Z has to bring back both.
//
// Edges are snapshotted WHOLESALE rather than per-edge. There are few of them, they're small, and
// the alternative — keyed before/after images like nodes — buys nothing here: an edge has no
// identity problem to solve (its id is persisted) and no resurrect-vs-update distinction to make.
interface Step {
  before: Images; after: Images;
  canvas?: { before: string; after: string };
  edges?: { before: EdgeGraph; after: EdgeGraph };
}
type EdgeGraph = BoardEdge[];

const MAX_STEPS = 100;
const undoStack: Step[] = [];
const redoStack: Step[] = [];
let pending: Images | null = null;
let pendingCanvas: string | null = null;         // canvas-colour before-image for the open step, if one was picked
let pendingEdges: EdgeGraph | null = null;       // edge-graph before-image for the open step, if an edge op touched it

const cloneGraph = (g: EdgeGraph): EdgeGraph => structuredClone(g);
const sameGraph = (a: EdgeGraph, b: EdgeGraph): boolean => JSON.stringify(a) === JSON.stringify(b);
const liveGraph = (): EdgeGraph => state.edges;

// Fixed key order (so JSON-compare in commitStep is reliable) + deep copies of the arrays.
function snap(n: MindNode): NodeSnap {
  return {
    file: n.file, x: n.x, y: n.y, parent: n.parent,
    collapsed: n.collapsed, locked: n.locked,
    type: n.type, w: n.w, h: n.h, clip: n.clip, stack: n.stack,
    title: n.title, color: n.color,
    tags: [...n.tags], body: n.body, titleGap: n.titleGap, titleLevel: n.titleLevel,
    fmEntries: n.fmEntries?.map(e => ({ key: e.key, lines: [...e.lines] })),
    kidOrder: n.kidOrder ? [...n.kidOrder] : undefined,
  };
}
const cloneSnap = (s: NodeSnap): NodeSnap => structuredClone(s);
const sameSnap = (a: NodeSnap | null, b: NodeSnap | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// Every node id the history can still reach — an undo or redo would recreate or rewrite these, so
// none of them may be let go of while it can (data/lazy.ts releaseFolded).
export function historyRefs(): Set<string> {
  const out = new Set<string>();
  const graph = (g?: EdgeGraph): void => { for (const e of g ?? []) { out.add(e.from); out.add(e.to); } };
  // …and the PARENT each image names: restoring a card into a section that had been let go of would
  // otherwise hand it a parent id that no longer exists, and drop it at the top level.
  const images = (m: Images): void => { for (const [id, im] of m) {
    out.add(id);
    if (im?.parent) {
      out.add(im.parent);
    }
  } };
  for (const st of [...undoStack, ...redoStack]) {
    images(st.before); images(st.after);
    graph(st.edges?.before); graph(st.edges?.after);
  }
  if (pending) {
    images(pending);
  }
  graph(pendingEdges ?? undefined);
  return out;
}
// Remember a node's pre-mutation image in the pending step (opening one if needed). Call
// BEFORE mutating — and for creations, before state.nodes.set(), so the image is null.
// Idempotent per id.
export function touch(...ids: Array<string | null | undefined>): void {
  for (const id of ids) {
    if (!id) {
      continue;
    }
    if (!pending) {
      pending = new Map();
    }
    if (pending.has(id)) {
      continue;
    }
    const n = state.nodes.get(id);
    pending.set(id, n ? snap(n) : null);
  }
}
// Remember the map's canvas colour before changing it. Idempotent per step, and `=== null` rather
// than a falsy test: '' (the theme default) is a real value and the commonest before-image there is.
export function touchCanvas(): void {
  if (pendingCanvas === null) {
    pendingCanvas = state.canvasColor;
  }
}
// Remember the edge list before changing it — drawing, deleting, re-routing, restyling, and the
// pruning that follows a card delete. Call BEFORE the change. Idempotent per step.
export function touchEdges(): void {
  if (!pendingEdges) {
    pendingEdges = cloneGraph(liveGraph());
  }
}
// Close the pending step: capture after-images, drop untouched-in-practice nodes, and push.
export function commitStep(): void {
  const before = pending; pending = null;
  const canvasBefore = pendingCanvas; pendingCanvas = null;
  const edgesBefore = pendingEdges; pendingEdges = null;
  const step: Step = { before: new Map(), after: new Map() };
  if (before) {
    for (const [id, b] of before) {
      const n = state.nodes.get(id);
      const a = n ? snap(n) : null;
      if (sameSnap(b, a)) {
        continue;
      }
      step.before.set(id, b); step.after.set(id, a);
    }
  }
  if (canvasBefore !== null && canvasBefore !== state.canvasColor) {
    step.canvas = { before: canvasBefore, after: state.canvasColor };
  }
  if (edgesBefore && !sameGraph(edgesBefore, liveGraph())) {
    step.edges = { before: edgesBefore, after: cloneGraph(liveGraph()) };
  }
  if (!step.before.size && !step.canvas && !step.edges) {
    return;   // nothing changed
  }
  undoStack.push(step);
  if (undoStack.length > MAX_STEPS) {
    undoStack.shift();
  }
  redoStack.length = 0;
}
// Sugar for one-shot synchronous ops. Re-entrant: called while another step is already
// pending (e.g. deleteNode inside a live drag), it only touches — the outer owner commits.
export function record(ids: Iterable<string | null | undefined>, fn: () => void): void {
  // Any open half — nodes, canvas or edges (an edge-bar editing session) — means an outer owner.
  const owner = !pending && pendingCanvas === null && !pendingEdges;
  touch(...ids);
  fn();
  if (owner) {
    commitStep();
  }
}
export function clearHistory(): void {
  undoStack.length = 0; redoStack.length = 0;
  pending = null; pendingCanvas = null; pendingEdges = null;
}

// Overwrite live state with one side of a step's images.
function applyImages(images: Images): void {
  for (const [id, s] of images) {
    const live = state.nodes.get(id);
    if (!s) {                                       // node must not exist
      if (live) {
        state.nodes.delete(id);
        live.el?.remove(); live.el = null;
        if (live.file) {
          state.toDelete.push(live.file);
        }
      }
    } else if (live) {
      // Keep the CURRENT file path: if a rename already flushed, saveAll's phase 1 must see
      // the on-disk name so it can rename back — restoring the old path would orphan the new
      // file. The restored title re-derives the right name via desiredFileFor.
      Object.assign(live, cloneSnap(s), { file: live.file });
      live.dirty = true;
    } else {                                        // resurrect a deleted node
      // rx/ry are re-derived from the restored x/y by commitRel() before the next save.
      state.nodes.set(id, { id, ...cloneSnap(s), rx: 0, ry: 0, dirty: true, el: null });
    }
  }
}
// Glide to the affected nodes only when they're entirely off-screen; a visible change
// shouldn't yank the camera around.
function frameIfOffscreen(ids: string[]): void {
  const nodes = nodesOf(ids);
  if (!nodes.length) {
    return;
  }
  const v = state.view, r = stage.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x * v.k + v.x);            minY = Math.min(minY, n.y * v.k + v.y);
    maxX = Math.max(maxX, (n.x + nodeW(n)) * v.k + v.x); maxY = Math.max(maxY, (n.y + nodeH(n)) * v.k + v.y);
  }
  if (maxX < 0 || minX > r.width || maxY < 0 || minY > r.height) {
    frameBox(nodes);
  }
}
// ---------- what a step did, in words ----------
// "Undo: Deleted 3 cards". Read off the step's own images rather than handed in by whoever recorded it, so
// every path that makes a step — a drag, an edit session, a mutate() — is named without having to say
// anything, and the words can't drift from what the step actually restores.
type Change = 'deleted' | 'added' | 'edited' | 'moved' | 'resized' | 'recoloured' | 'tagged' | 'folded' | 'unfolded' | 'changed';
const VERB: Record<Change, string> = {
  deleted: 'Deleted', added: 'Added', edited: 'Edited', moved: 'Moved', resized: 'Resized',
  recoloured: 'Recoloured', tagged: 'Changed the tags of', folded: 'Folded', unfolded: 'Unfolded', changed: 'Changed',
};
// In this order a step is named by the FIRST kind of change it holds: deleting a card that a line touched is
// "Deleted", not "Changed a line"; a paste that also nudged a section is "Added".
const ORDER: Change[] = ['deleted', 'added', 'edited', 'moved', 'resized', 'recoloured', 'tagged', 'folded', 'unfolded', 'changed'];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function changeOf(b: NodeSnap | null, a: NodeSnap | null): Change {
  if (!a) {
    return 'deleted';
  }
  if (!b) {
    return 'added';
  }
  if (a.title !== b.title || a.body !== b.body) {
    return 'edited';
  }
  if (a.x !== b.x || a.y !== b.y || a.parent !== b.parent || a.stack !== b.stack) {
    return 'moved';
  }
  if (a.w !== b.w || a.h !== b.h || a.clip !== b.clip) {
    return 'resized';
  }
  if (a.color !== b.color) {
    return 'recoloured';
  }
  if (!same(a.tags, b.tags)) {
    return 'tagged';
  }
  if (a.collapsed !== b.collapsed) {
    return a.collapsed ? 'folded' : 'unfolded';
  }
  return 'changed';
}
const kindOf = (s: NodeSnap): string => s.type === 'section' ? (s.stack ? 'stack' : 'section') : 'card';
const LABEL_MAX = 32;
function snapLabel(s: NodeSnap): string {
  const l = s.title.trim() || firstLineLabel(s.body);
  if (!l) {
    return `a ${kindOf(s)}`;
  }
  return `“${l.length > LABEL_MAX ? l.slice(0, LABEL_MAX - 1).trimEnd() + '…' : l}”`;
}
function describeStep(step: Step, useAfter: boolean): string {
  const groups = new Map<Change, NodeSnap[]>();
  for (const [id, b] of step.before) {
    const a = step.after.get(id) ?? null, c = changeOf(b, a), shown = (useAfter ? a : b) ?? a ?? b;
    if (shown) {
      groups.set(c, [...(groups.get(c) ?? []), shown]);
    }
  }
  const c = ORDER.find(k => groups.has(k));
  if (c) {
    // A section deleted, added or moved takes what it holds along, so count only the OUTERMOST of them.
    const all = groups.get(c)!, files = new Set(all.map(s => s.file));
    const top = all.filter(s => !s.parent || !files.has(s.parent));
    const list = top.length ? top : all;
    if (list.length === 1) {
      return `${VERB[c]} ${snapLabel(list[0])}`;
    }
    const kinds = new Set(list.map(kindOf));
    const noun = kinds.size === 1 ? kindOf(list[0]) : 'item';
    return `${VERB[c]} ${list.length} ${noun}s`;
  }
  if (step.edges) {
    const d = step.edges.after.length - step.edges.before.length;
    return d === 0 ? 'Changed a line' : d > 0 ? 'Drew a line' : 'Deleted a line';
  }
  return step.canvas ? 'Changed the canvas colour' : '';
}
function stepLabel(head: 'Undo' | 'Redo', step: Step): string {
  const what = describeStep(step, head === 'Redo');
  return what ? `${head}: ${what}` : head;
}

function applyStep(images: Images, canvas: string | undefined,
                   edges: EdgeGraph | undefined, label: string): void {
  applyImages(images);
  // Edges go back BEFORE the paint below, like the canvas colour: paintAll paints the free-edge
  // layer, so restoring them here means one pass rather than two. A selected edge the step removed
  // stops resolving, which is what closes its bar (features/edge-bar.ts syncEdgeBar).
  if (edges) {
    state.edges = cloneGraph(edges);
    for (const id of [...state.selEdges]) {
      if (!state.edges.some(e => e.id === id)) {
        state.selEdges.delete(id);
      }
    }
    scheduleSaveBoard();
  }
  // Restored BEFORE the paint below: syncCanvasBackground runs off paintAll, so the canvas repaints
  // in the same pass everything else does rather than needing a second one.
  if (canvas !== undefined) { state.canvasColor = canvas; scheduleSaveBoard(); }
  // paint first so resurrected cards have real DOM heights, then lay out, then commit
  remeasure();
  const ids = [...images.keys()].filter(id => state.nodes.has(id));
  // An undo can resurrect (or move) a node that lives outside the section you're standing in — come out
  // of as many levels as it takes to show it, or setSelectionSet would silently drop it (isSelectable
  // refuses an out-of-scope id) and the step would look like it did nothing. See popScopeFor.
  // The one node that must NOT pop is the scope root itself. outOfScope deliberately reports it as
  // outside its own scope (that's what stops its box and tab being painted while you're inside it),
  // but it's the one node whose change you can always already see — the canvas IS it. Recolouring the
  // open section from the canvas-colour button records a step on exactly that node, so without this
  // skip every ⌘Z would throw you out of the section you were working in.
  const first = ids.map(id => state.nodes.get(id)).find((n): n is MindNode => !!n && !isScopeRoot(n));
  if (first) {
    popScopeFor(first);
  }
  setSelectionSet(ids);
  frameIfOffscreen(ids);
  syncEdgeBar();      // the selected edge may have moved, changed, or gone
  scheduleSave();
  setStatus(label);
}
export function undo(): void {
  endInPlaceEdit();      // an open edit session becomes the step being undone
  commitStep();                        // flush any dangling pending step
  const step = undoStack.pop();
  if (!step) { setStatus('Nothing to undo'); return; }
  redoStack.push(step);
  applyStep(step.before, step.canvas?.before, step.edges?.before, stepLabel('Undo', step));
}
export function redo(): void {
  endInPlaceEdit();
  commitStep();                        // a fresh step clears redo, so this usually empties it
  const step = redoStack.pop();
  if (!step) { setStatus('Nothing to redo'); return; }
  undoStack.push(step);
  applyStep(step.after, step.canvas?.after, step.edges?.after, stepLabel('Redo', step));
}

