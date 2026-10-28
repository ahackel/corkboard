// ============================================================
// board.json — the ONE sidecar beside the notes.
//
// A node is a file and carries its own frontmatter; everything that is about the BOARD rather than
// about a note lives here instead: the free edges the user drew, the freehand ink layer, and the
// per-map view preferences. It replaces the two sidecars this app used to keep (sketch.json and
// settings.json), which are still READ so an older vault opens unchanged — but never written again.
//
// The split rule, in one line: frontmatter describes the NOTE, board.json describes the BOARD's
// arrangement of it. Membership is neither: a frame is a FOLDER (docs/architecture.md), so which frame
// holds a note is where its file sits — which is what lets a folder stand on its own if this file is lost.
// ============================================================
import { state, GRID_STYLES, GRID_SIZES, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { dirOf } from '../utils/filenames.js';
import { store } from './persistence.js';
import { colorFill } from '../main.js';
import { commitRel } from '../view/layout.js';
import { flattenJunctions } from '../utils/edge-graph.js';
import { saveFailed, saveSucceeded } from './save-alert.js';

export const BOARD_FILE = 'board.json';
// The MODEL the board was last written by, which is how the flatten migration knows a map predates
// containment. 1 (or a missing board file) = a map whose card-to-card `mm_parent` links meant
// "placed BESIDE this card, joined by a branch line"; 2 = they mean "inside it, as outline rows".
// data/persistence.ts flattenLegacyBranches converts the first into the second, once, and the write
// that follows stamps this. Bump it only for another migration of the same kind.
export const BOARD_MODEL = 2;
let loadedModel = BOARD_MODEL;
// Did the map we just loaded predate containment? Only meaningful between loadBoard and the
// migration that reads it.
export function boardIsLegacy(): boolean { return loadedModel < BOARD_MODEL; }
// Superseded sidecar: read once when there is no board.json yet, never written.
export const SETTINGS_FILE = 'settings.json';
// The ink of the retired sketch layer (docs/PRODUCT.md, "Cut"). Nothing draws it any more, but a
// board that has some keeps it, verbatim and untouched, so cutting the feature never deletes a drawing.
let keptStrokes: unknown;

export function boardJSON(): string {
  // rx/ry is the PERSISTED form of a node's position and is derived from the live x/y — refresh it
  // before reading it here. saveAll does the same before serializing notes; the board file has its
  // own debounce, so it cannot rely on that one having run.
  commitRel();
  return JSON.stringify({
    version: 1,
    model: BOARD_MODEL,
    settings: { grid: state.gridStyle, gridSize: state.gridSize, canvasColor: state.canvasColor },
    edges: state.edges.map(serializeEdge).filter(Boolean),
    nodes: collectGeom(),
    ...(keptStrokes !== undefined ? { strokes: keptStrokes } : {}),
  });
}

// An edge's ENDPOINTS go to disk as paths, never as ids — see BoardEdge in core/state.ts. An edge
// whose endpoint has no file yet (a card created this session and not yet saved) is dropped rather
// than written half-resolved; the next save, once the note has a name, writes it whole.
interface StoredEdge { id: string; from: string; to: string;
                    fromJ?: string; toJ?: string;      // legacy: a JUNCTION end (read, flattened, never written)
                    color?: string; dashed?: boolean; fromCap?: EdgeCap; toCap?: EdgeCap;
                    // The pinned faces. NOT the `fromSide`/`toSide` an older build wrote on EVERY edge
                    // (defaulting to right/left): reading those back would pin every old line to a
                    // face nobody chose, so they stay ignored and these are new keys.
                    fromPort?: EdgeSide; toPort?: EdgeSide;
                    arrows?: 'none' | 'to' | 'both';   // legacy: ONE direction axis, read never written
                    label?: string }
function serializeEdge(e: BoardEdge): StoredEdge | null {
  // An end held by a PATH is a note inside a folded frame nobody has read (resolveEdges): the frame
  // stands in for it on the canvas, but the path is still where the line goes.
  const from = e.fromPath ?? state.nodes.get(e.from)?.file, to = e.toPath ?? state.nodes.get(e.to)?.file;
  if (!from || !to) {
    return null;
  }
  // Most fields are omitted when they equal the DEFAULT a fresh edge is born with (makeEdge), so a
  // board file stays readable. `dashed` is written ALWAYS, deliberately: it is a boolean whose
  // default has already been changed once, and the omit-when-default rule silently inverts such a
  // field the moment its default flips (a solid edge came back dashed, and then the reverse). A few
  // bytes buy immunity from that whole class of bug.
  return { id: e.id, from, to,
           ...(e.color ? { color: e.color } : {}), dashed: e.dashed,
           ...(e.fromCap !== 'none' ? { fromCap: e.fromCap } : {}),
           ...(e.toCap !== 'arrow' ? { toCap: e.toCap } : {}), ...(e.label ? { label: e.label } : {}),
           ...(e.fromPort ? { fromPort: e.fromPort } : {}), ...(e.toPort ? { toPort: e.toPort } : {}) };
}

// A persisted id, unlike a node's — a node is identified by its file and an edge has no file.
export function newEdgeId(): string {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeEdge(from: string, to: string): BoardEdge {
  return { id: newEdgeId(), from, to, color: '', dashed: false,
           fromCap: 'none', toCap: 'arrow', label: '' };
}

// ---------- node geometry ----------
// Where a card SITS, how big it is, whether it is folded, and the order of its children — everything
// about a note's place on the board rather than about the note. Keyed by the note's PATH, for the same
// reason an edge's endpoints are: in-memory ids are minted fresh every load.
//
// `x`/`y` keep the meaning `mm_position_x/y` had — an offset from the parent, world coords for a
// top-level card — so nothing about the layout pipeline had to change when they moved file.
//
// `order` is a SORT HINT, never a record of membership: the folder alone says who belongs to whom.
// Entries that don't resolve are ignored and children missing from the list are appended by position
// (view/layout.ts orderedKids already does exactly this), so the list cannot lie about the tree — at
// worst it is incomplete, and incomplete degrades to filename order.
export interface StoredGeom { x?: number; y?: number; w?: number; h?: number; clip?: boolean; collapsed?: boolean; order?: string[] }
let geom = new Map<string, StoredGeom>();
export function boardGeom(path: string | null): StoredGeom | undefined {
  return path ? geom.get(path) : undefined;
}
// The folders of the folded frames whose notes are still unread (MindNode.lazy).
function lazyFolders(): string[] {
  return [...state.nodes.values()].filter(n => n.lazy != null && n.file).map(n => dirOf(n.file!));
}
function collectGeom(): Record<string, StoredGeom> {
  const out: Record<string, StoredGeom> = {};
  // What sits in an UNREAD folder isn't in memory, so its geometry is carried over as it was read
  // (or as it was when it was let go of — rememberGeom), or the next write would forget it.
  const lazy = lazyFolders();
  if (lazy.length) {
    for (const [path, g] of geom) {
      if (lazy.some(d => path.startsWith(d))) {
        out[path] = g;
      }
    }
  }
  for (const n of state.nodes.values()) {
    if (!n.file) {
      continue;                       // never saved yet: it has no key to be stored under
    }
    const g: StoredGeom = { x: Math.round(n.rx), y: Math.round(n.ry) };
    // The AUTHORED size — every kind can carry both axes. A frame's and an IMAGE card's h is its box;
    // a plain card's is a MINIMUM its text can still grow past (main.ts paintNode).
    if (n.w != null) {
      g.w = Math.round(n.w);
    }
    if (n.h != null) {
      g.h = Math.round(n.h);
    }
    if (n.clip) {
      g.clip = true;                   // …unless it was dragged SHORTER than its text: then exact
    }
    if (n.collapsed) {
      g.collapsed = true;
    }
    const order = (n.kidOrder ?? []).map(id => state.nodes.get(id)?.file).filter((f): f is string => !!f);
    if (order.length > 1) {
      g.order = order;       // a single child has no order worth writing
    }
    if (n.lazy != null && geom.get(n.file)?.order) {
      g.order = geom.get(n.file)!.order;   // its kids are unread
    }
    out[n.file] = g;
  }
  return out;
}
// Note the live geometry of nodes about to be LET GO of (data/lazy.ts releaseFolded), so collectGeom
// keeps writing it while they're not in memory, and the next read of their folder seeds them from it.
export function rememberGeom(nodes: Iterable<MindNode>): void {
  commitRel();
  for (const n of nodes) {
    if (!n.file) {
      continue;
    }
    const order = (n.kidOrder ?? []).map(id => state.nodes.get(id)?.file).filter((f): f is string => !!f);
    geom.set(n.file, { x: Math.round(n.rx), y: Math.round(n.ry), w: n.w, h: n.h, clip: !!n.clip,
                       collapsed: n.collapsed, order: order.length > 1 ? order : geom.get(n.file)?.order });
  }
}
// Re-seed each parent's in-memory child order from the stored paths. Called by loadFromDir once the
// path index exists. orderedKids owns the reconciliation from here — see the `order` note above.
export function resolveOrder(byPath: Map<string | null, string>): void {
  for (const n of state.nodes.values()) {
    const order = geom.get(n.file ?? '')?.order;
    if (!order) {
      continue;
    }
    const ids = order.map(p => byPath.get(p)).filter((id): id is string => !!id);
    if (ids.length) {
      n.kidOrder = ids;
    }
  }
}

// ---------- reading ----------
async function readJSON(path: string): Promise<Record<string, unknown> | null> {
  try {
    const blob = store.readBlob ? await store.readBlob(path) : null;
    if (!blob) {
      return null;
    }
    const data = JSON.parse(await blob.text());
    return (data && typeof data === 'object') ? data as Record<string, unknown> : null;
  } catch { return null; }        // missing or malformed → the caller's defaults stand
}

// Both shapes land here: board.json nests these under `settings`, the legacy settings.json had them
// at the top level, and the keys are the same either way.
function applySettings(d: Record<string, unknown> | null | undefined): void {
  if (!d) {
    return;
  }
  if (GRID_STYLES.includes(d.grid as never)) {
    state.gridStyle = d.grid as never;
  }
  if (GRID_SIZES.includes(d.gridSize as never)) {
    state.gridSize = d.gridSize as never;
  }
  // Validated the same way a node's own colour is (colorFill resolves a palette key OR a hex, and
  // nothing else), so a hand-edited board.json can't paint the canvas an arbitrary CSS value.
  if (typeof d.canvasColor === 'string' && colorFill(d.canvasColor)) {
    state.canvasColor = d.canvasColor;
  }
}

function applyGeom(v: unknown): void {
  if (!v || typeof v !== 'object') {
    return;
  }
  const num = (x: unknown): number | undefined => typeof x === 'number' && isFinite(x) ? x : undefined;
  for (const [path, raw] of Object.entries(v as Record<string, StoredGeom>)) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    geom.set(path, {
      x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h),
      clip: raw.clip === true,
      collapsed: raw.collapsed === true,
      order: Array.isArray(raw.order) ? raw.order.filter(p => typeof p === 'string') : undefined,
    });
  }
}

// Edges arrive holding PATHS; resolveEdges (below) turns them into ids once the notes are loaded.
// The meeting points, read BEFORE the edges so an edge can check its end exists (applyEdges).
// A board written while JUNCTIONS existed lists them; their ids are all that matters now, so the edges
// ending at one can be recognised and flattened into card-to-card lines (resolveEdges).
let legacyJunctions = new Set<string>();
function applyJunctions(v: unknown): void {
  if (!Array.isArray(v)) {
    return;
  }
  for (const raw of v as Array<{ id?: unknown }>) {
    if (raw && typeof raw.id === 'string' && raw.id) {
      legacyJunctions.add(raw.id);
    }
  }
}
function applyEdges(v: unknown): void {
  if (!Array.isArray(v)) {
    return;
  }
  const cap = (c: unknown, fallback: EdgeCap): EdgeCap =>
    (c === 'none' || c === 'dot' || c === 'arrow') ? c : fallback;
  // An edge written before the two caps existed carries the old single `arrows` axis instead. It maps
  // exactly — none → bare at both ends, to → an arrowhead at the target, both → one at each end — so
  // the migration is a READ, with nothing to rewrite: the next save writes caps and the old key drops
  // out on its own.
  const legacy = (a: unknown): { from: EdgeCap; to: EdgeCap } =>
    a === 'none' ? { from: 'none', to: 'none' }
  : a === 'both' ? { from: 'arrow', to: 'arrow' }
  : { from: 'none', to: 'arrow' };
  const port = (s: unknown): EdgeSide | undefined =>
    s === 'up' || s === 'down' || s === 'left' || s === 'right' ? s : undefined;
  for (const raw of v as StoredEdge[]) {
    if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
      continue;
    }
    // A legacy junction end is already an id — it needs no path lookup, so it goes straight into
    // `from`/`to` and leaves the matching *Path undefined for resolveEdges to skip.
    const fromJ = typeof raw.fromJ === 'string' ? raw.fromJ : '';
    const toJ = typeof raw.toJ === 'string' ? raw.toJ : '';
    if ((fromJ && !legacyJunctions.has(fromJ)) || (toJ && !legacyJunctions.has(toJ))) {
      continue;   // point is gone: so is the edge
    }
    state.edges.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : newEdgeId(),
      from: fromJ, to: toJ,
      ...(fromJ ? {} : { fromPath: raw.from }), ...(toJ ? {} : { toPath: raw.to }),
      color: (typeof raw.color === 'string' && colorFill(raw.color)) ? raw.color : '',
      dashed: raw.dashed === true,   // absent = the default, which is SOLID
      fromCap: cap(raw.fromCap, legacy(raw.arrows).from),
      toCap: cap(raw.toCap, legacy(raw.arrows).to),
      label: typeof raw.label === 'string' ? raw.label : '',
      ...(port(raw.fromPort) ? { fromPort: port(raw.fromPort) } : {}),
      ...(port(raw.toPort) ? { toPort: port(raw.toPort) } : {}),
    });
  }
}

export async function loadBoard(): Promise<void> {
  keptStrokes = undefined; state.edges = []; legacyJunctions = new Set(); geom = new Map();
  state.gridStyle = 'none'; state.gridSize = 20; state.canvasColor = '';
  const board = await readJSON(BOARD_FILE);
  // No board file at all is the strongest legacy signal there is: every map written since this
  // landed has one. An older board file (sketches/settings only) says the same thing.
  loadedModel = typeof board?.model === 'number' ? board.model : 1;
  if (board) {
    applySettings(board.settings as Record<string, unknown>);
    applyJunctions(board.junctions);
    applyEdges(board.edges);
    applyGeom(board.nodes);
    keptStrokes = board.strokes;
    return;
  }
  // No board.json: an older vault. Read the settings sidecar it replaced, once. Nothing deletes it —
  // the next save simply writes board.json beside it, so the old file stays readable by an older
  // build of the app until the user removes it.
  const legacy = await readJSON(SETTINGS_FILE);
  // A brand-new map (no board, no old settings) starts on a dotted board — the paper-and-sticky look
  // (docs/PRODUCT.md). An existing map keeps whatever grid it saved.
  if (!legacy) {
    state.gridStyle = 'dot';
  }
  applySettings(legacy);
}

// Turn each edge's stored PATHS into live node ids. Called by loadFromDir once every note is in
// state.nodes and the path index exists. An endpoint that doesn't resolve — a note deleted in
// Finder, a renamed file — drops the whole edge silently: a board degrades, it never corrupts.
// …EXCEPT an end inside a folded frame whose notes weren't read (data/lazy.ts): `standIn` names that
// frame, which holds the end on the canvas the way a folded pill always has, and the path is KEPT —
// it is what serializeEdge writes back, and what resolves once the folder is read (unparkEdges).
export function resolveEdges(byPath: Map<string | null, string>, standIn: (path: string) => string | null = () => null): void {
  state.edges = state.edges.filter(e => {
    // A legacy junction end has no path; only the note ends go through the index.
    const end = (path: string | undefined, id: string): [string | null | undefined, boolean] => {
      if (path == null) {
        return [id, false];
      }
      const real = byPath.get(path);
      return real ? [real, false] : [standIn(path), true];
    };
    const [from, fromParked] = end(e.fromPath, e.from), [to, toParked] = end(e.toPath, e.to);
    if (!from || !to || (from === to && !fromParked && !toParked)) {
      return false;
    }
    e.from = from; e.to = to;
    if (!fromParked) {
      delete e.fromPath;
    }
    if (!toParked) {
      delete e.toPath;
    }
    return true;
  });
  // …and lines that met at a junction become plain card-to-card lines (utils/edge-graph.ts). The next
  // board write drops the junctions for good.
  if (legacyJunctions.size) {
    state.edges = flattenJunctions(state.edges, id => legacyJunctions.has(id))
      .filter(e => state.nodes.has(e.from) && state.nodes.has(e.to) && e.from !== e.to);
    legacyJunctions = new Set();
  }
}

// A folder has just been read: the ends that were waiting on its notes take their real ids.
export function unparkEdges(byPath: Map<string | null, string>): void {
  for (const e of state.edges) {
    const f = e.fromPath != null ? byPath.get(e.fromPath) : undefined;
    if (f) { e.from = f; delete e.fromPath; }
    const t = e.toPath != null ? byPath.get(e.toPath) : undefined;
    if (t) { e.to = t; delete e.toPath; }
  }
}
// Nodes are being let go of: every end on one of them goes back to its PATH, held by `standIn`.
export function parkEdges(gone: Map<string, string>, standIn: string): void {
  for (const e of state.edges) {
    // An end already held by a path (it was on a folded frame inside this one) keeps that path.
    const f = gone.get(e.from); if (f) { e.fromPath ??= f; e.from = standIn; }
    const t = gone.get(e.to); if (t) { e.toPath ??= t; e.to = standIn; }
  }
}

// ---------- writing ----------
// Its own debounce, separate from the notes': a burst of pen moves must not rewrite any .md, and an
// edge restyle must not touch a note at all.
let boardTimer: number | undefined;
export function scheduleSaveBoard(): void {
  if (state.readOnly || !store.isOpen) {
    return;   // read-only / demo mode: never write
  }
  clearTimeout(boardTimer);
  boardTimer = window.setTimeout(flushBoard, 400);
}
// A write that FAILED is still pending: the board in memory is the only copy of it, and a reload
// (data/persistence.ts reloadFromDisk) must not read the older one over it.
let boardFailed = false;
export function boardSavePending(): boolean { return boardTimer != null || boardFailed; }
export async function flushBoard(): Promise<void> {
  clearTimeout(boardTimer); boardTimer = undefined;
  if (state.readOnly || !store.isOpen) {
    return;
  }
  try {
    await store.write(BOARD_FILE, boardJSON());
    state.lastSelfWrite = Date.now();            // so the focus-reload ignores our own write
    boardFailed = false;
    saveSucceeded('board');
  } catch (err) {
    boardFailed = true;
    saveFailed('board', err, () => { void flushBoard(); });
  }
}
