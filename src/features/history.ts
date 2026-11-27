// Undo/redo: per-step before/after node images keyed by id (cleared on every load). touch() opens a
// pending step before a change, commitStep() closes it; a step that changed nothing is dropped.
import { state, stage, setStatus, type MindNode, type BoardEdge } from '../core/state.js';
import { frameBox } from '../view/camera.js';
import { scheduleSaveBoard } from '../data/board.js';
import { remeasure } from '../render.js';
import { endInPlaceEdit } from './inline-edit.js';
import { syncEdgeBar } from './edge-bar.js';
import { isScopeRoot } from '../nav/scope.js';
import { nodesOf } from '../utils/model.js';
import { nodeW, nodeH } from '../view/geometry.js';
import { popScopeFor } from '../nav/sections.js';
import { setSelectionSet } from './selection.js';
import { scheduleSave } from '../data/save.js';
import { firstLineLabel } from '../utils/frontmatter.js';

// `file` is kept to resurrect a deleted node but never written back onto a live one (applyImages);
// rx/ry are re-derived from x/y before each save.
type NodeSnap = Omit<MindNode, 'id' | 'el' | 'sectionContentEl' | 'dirty' | '_parentPath' | 'rx' | 'ry'>;
// null = the node does not exist.
type Images = Map<string, NodeSnap | null>;

// One timeline for nodes, canvas colour and edges: deleting a card removes its edges too, and one ⌘Z
// must bring back both. Edges are few and small, so they are snapshotted wholesale.
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
let pendingCanvas: string | null = null;
let pendingEdges: EdgeGraph | null = null;

const cloneGraph = (g: EdgeGraph): EdgeGraph => structuredClone(g);
const sameGraph = (a: EdgeGraph, b: EdgeGraph): boolean => JSON.stringify(a) === JSON.stringify(b);
const liveGraph = (): EdgeGraph => state.edges;

// Fixed key order, so the JSON compare in sameSnap is reliable.
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

// Ids an undo/redo could recreate or rewrite, parents included, which data/lazy.ts must not let go of.
export function historyRefs(): Set<string> {
  const out = new Set<string>();
  const graph = (g?: EdgeGraph): void => { for (const e of g ?? []) { out.add(e.from); out.add(e.to); } };
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

// Call BEFORE mutating; for a creation, before state.nodes.set(), so its before-image is null.
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

// `=== null`, not falsy: '' (the theme default) is a real before-image.
export function touchCanvas(): void {
  if (pendingCanvas === null) {
    pendingCanvas = state.canvasColor;
  }
}

export function touchEdges(): void {
  if (!pendingEdges) {
    pendingEdges = cloneGraph(liveGraph());
  }
}

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
    return;
  }
  undoStack.push(step);
  if (undoStack.length > MAX_STEPS) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

// Re-entrant: inside an already-open step (e.g. a live drag) it only touches; the outer owner commits.
export function record(ids: Iterable<string | null | undefined>, fn: () => void): void {
  const ownsStep = !pending && pendingCanvas === null && !pendingEdges;
  touch(...ids);
  fn();
  if (ownsStep) {
    commitStep();
  }
}

export function clearHistory(): void {
  undoStack.length = 0; redoStack.length = 0;
  pending = null; pendingCanvas = null; pendingEdges = null;
}

function applyImages(images: Images): void {
  for (const [id, s] of images) {
    const live = state.nodes.get(id);
    if (!s) {
      if (live) {
        state.nodes.delete(id);
        live.el?.remove(); live.el = null;
        if (live.file) {
          state.toDelete.push(live.file);
        }
      }
    } else if (live) {
      // Keep the CURRENT path: a rename already on disk must be renamed back, not orphaned.
      Object.assign(live, cloneSnap(s), { file: live.file });
      live.dirty = true;
    } else {
      state.nodes.set(id, { id, ...cloneSnap(s), rx: 0, ry: 0, dirty: true, el: null });
    }
  }
}

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

// "Undo: Deleted 3 cards", read off the step's own images so the words can't drift from what it restores.
type Change = 'deleted' | 'added' | 'edited' | 'moved' | 'resized' | 'recoloured' | 'tagged' | 'folded' | 'unfolded' | 'changed';
const VERB: Record<Change, string> = {
  deleted: 'Deleted', added: 'Added', edited: 'Edited', moved: 'Moved', resized: 'Resized',
  recoloured: 'Recoloured', tagged: 'Changed the tags of', folded: 'Folded', unfolded: 'Unfolded', changed: 'Changed',
};
// A step is named by the FIRST kind of change it holds, in this order.
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
    // A section carries what it holds along, so count only the OUTERMOST.
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
  // Edges and canvas colour go back before the paint, so it is one pass.
  if (edges) {
    state.edges = cloneGraph(edges);
    for (const id of [...state.selEdges]) {
      if (!state.edges.some(e => e.id === id)) {
        state.selEdges.delete(id);
      }
    }
    scheduleSaveBoard();
  }
  if (canvas !== undefined) { state.canvasColor = canvas; scheduleSaveBoard(); }
  remeasure();
  const ids = [...images.keys()].filter(id => state.nodes.has(id));
  // Leave open sections until the change is visible, or the selection would drop it. Not for the
  // scope root: outOfScope counts it outside, yet it IS the canvas (its colour is undoable from there).
  const first = ids.map(id => state.nodes.get(id)).find((n): n is MindNode => !!n && !isScopeRoot(n));
  if (first) {
    popScopeFor(first);
  }
  setSelectionSet(ids);
  frameIfOffscreen(ids);
  syncEdgeBar();
  scheduleSave();
  setStatus(label);
}

export function undo(): void {
  endInPlaceEdit();
  commitStep();
  const step = undoStack.pop();
  if (!step) { setStatus('Nothing to undo'); return; }
  redoStack.push(step);
  applyStep(step.before, step.canvas?.before, step.edges?.before, stepLabel('Undo', step));
}

export function redo(): void {
  endInPlaceEdit();
  commitStep();
  const step = redoStack.pop();
  if (!step) { setStatus('Nothing to redo'); return; }
  undoStack.push(step);
  applyStep(step.after, step.canvas?.after, step.edges?.after, stepLabel('Redo', step));
}

