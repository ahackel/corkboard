// ============================================================
// board.json — the ONE sidecar beside the notes.
//
// A node is a file and carries its own frontmatter; everything that is about the BOARD rather than
// about a note lives here instead: where each card sits, the lines the user drew, and the per-map view
// preferences. It replaced the settings.json this app used to keep, which is still READ once when a
// map has no board.json yet — and never written again.
//
// The split rule, in one line: frontmatter describes the NOTE, board.json describes the BOARD's
// arrangement of it. Membership is neither: a section is a FOLDER (docs/architecture.md), so which section
// holds a note is where its file sits — which is what lets a folder stand on its own if this file is lost.
// ============================================================
import { state, GRID_STYLES, GRID_SIZES, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { dirOf } from '../utils/filenames.js';
import { store } from './persistence.js';
import { commitRel } from '../view/layout.js';
import { flattenJunctions } from '../utils/edge-graph.js';
import { saveFailed, saveSucceeded, holdWrites, releaseWrites, writesHeld } from './save-alert.js';
import { setSaving } from './save-flag.js';
import { colorFill } from '../view/color.js';

export const BOARD_FILE = 'board.json';
// The MODEL the board was last written by, which is how the flatten migration knows a map predates
// containment. 1 (or a missing board file) = a map whose card-to-card `mm_parent` links meant
// "placed BESIDE this card, joined by a branch line"; 2 = they mean "inside it, as outline rows".
// data/migrate.ts flattenLegacyBranches converts the first into the second, once, and the write
// that follows stamps this. Bump it only for another migration of the same kind.
const BOARD_MODEL = 2;
// The file's own generation. A board with a HIGHER version or model than this build knows was written by
// a newer one, and holds something this one would get wrong: it is shown, and not written to (loadBoard).
const BOARD_VERSION = 1;
let loadedModel = BOARD_MODEL;

// What a NEWER build wrote that this one has no name for — a key at the top level, in `settings`, on a
// node or on a line — goes back out as it came in, the way a note's unknown frontmatter does. So an
// older build opening a newer map of the SAME version loses nothing by saving it.
type Extra = Record<string, unknown>;
const KNOWN_TOP = new Set(['version', 'model', 'settings', 'edges', 'nodes', 'strokes', 'junctions']);
const KNOWN_SETTING = new Set(['grid', 'gridSize', 'canvasColor']);
const KNOWN_NODE = new Set(['x', 'y', 'w', 'h', 'clip', 'collapsed', 'stack', 'order']);
const KNOWN_EDGE = new Set(['id', 'from', 'to', 'fromJ', 'toJ', 'color', 'dashed', 'fromCap', 'toCap', 'fromPort', 'toPort',
  'fromAt', 'toAt', 'arrows', 'label']);
let extraTop: Extra = {}, extraSettings: Extra = {};
let extraNode = new Map<string, Extra>(), extraEdge = new Map<string, Extra>();

function unknownKeys(v: unknown, known: Set<string>): Extra | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return null;
  }
  const rest = Object.entries(v).filter(([k]) => !known.has(k));
  return rest.length ? Object.fromEntries(rest) : null;
}

// A note moved or was renamed (data/save.ts): what is kept for its old path follows it.
export function boardPathMoved(from: string, to: string): void {
  const extra = extraNode.get(from);
  if (extra) {
    extraNode.delete(from);
    extraNode.set(to, extra);
  }
}
// Did the map we just loaded predate containment? Only meaningful between loadBoard and the
// migration that reads it.
export function boardIsLegacy(): boolean { return loadedModel < BOARD_MODEL; }
// Superseded sidecar: read once when there is no board.json yet, never written.
const SETTINGS_FILE = 'settings.json';
// The ink of the retired sketch layer (docs/PRODUCT.md, "Cut"). Nothing draws it any more, but a
// board that has some keeps it, verbatim and untouched, so cutting the feature never deletes a drawing.
let keptStrokes: unknown;

export function boardJSON(): string {
  // rx/ry is the PERSISTED form of a node's position and is derived from the live x/y — refresh it
  // before reading it here. saveAll does the same before serializing notes; the board file has its
  // own debounce, so it cannot rely on that one having run.
  commitRel();
  return JSON.stringify({
    ...extraTop,
    version: BOARD_VERSION,
    model: BOARD_MODEL,
    settings: { ...extraSettings, grid: state.gridStyle, gridSize: state.gridSize, canvasColor: state.canvasColor },
    edges: state.edges.map(e => { const out = serializeEdge(e); return out ? { ...extraEdge.get(e.id), ...out } : null; }).filter(Boolean),
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
                    fromAt?: number; toAt?: number;   // a pinned end shifted along its face (BoardEdge)
                    arrows?: 'none' | 'to' | 'both';   // legacy: ONE direction axis, read never written
                    label?: string }
// A shifted end's place along its face, 0..1: three decimals is finer than any card is wide.
const shift = (at: number): number => Math.round(at * 1000) / 1000;
const isShift = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

function serializeEdge(e: BoardEdge): StoredEdge | null {
  // An end held by a PATH is a note inside a folded section nobody has read (resolveEdges): the section
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
           ...(e.fromPort ? { fromPort: e.fromPort } : {}), ...(e.toPort ? { toPort: e.toPort } : {}),
           ...(e.fromPort && e.fromAt != null ? { fromAt: shift(e.fromAt) } : {}),
           ...(e.toPort && e.toAt != null ? { toAt: shift(e.toAt) } : {}) };
}

// A persisted id, unlike a node's — a node is identified by its file and an edge has no file.
function newEdgeId(): string {
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
export interface StoredGeom { x?: number; y?: number; w?: number; h?: number; clip?: boolean; collapsed?: boolean; stack?: boolean; order?: string[] }
let geom = new Map<string, StoredGeom>();
export function boardGeom(path: string | null): StoredGeom | undefined {
  return path ? geom.get(path) : undefined;
}
// The folders of the folded sections whose notes are still unread (MindNode.lazy).
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
    // The AUTHORED size — every kind can carry both axes. A section's and an IMAGE card's h is its box;
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
    if (n.stack) {
      g.stack = true;                  // a section drawn as a pile (features/stacks.ts)
    }
    const order = (n.kidOrder ?? []).map(id => state.nodes.get(id)?.file).filter((f): f is string => !!f);
    if (order.length > 1) {
      g.order = order;       // a single child has no order worth writing
    }
    if (n.lazy != null && geom.get(n.file)?.order) {
      g.order = geom.get(n.file)!.order;   // its kids are unread
    }
    out[n.file] = { ...extraNode.get(n.file), ...g };
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
                       collapsed: n.collapsed, stack: !!n.stack, order: order.length > 1 ? order : geom.get(n.file)?.order });
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
// A board file that is THERE but can't be read as one — cut short by a sync, hand-edited into a typo —
// is not the same as no board file: every position, size and line in it is about to be written over.
// So its text is put aside first, beside it, under a name that says when.
let notice = '';

// What the last loadBoard has to tell the user, once (data/load.ts shows it when the map is up).
export function takeBoardNotice(): string {
  const said = notice;
  notice = '';
  return said;
}

async function keepUnreadable(text: string): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const name = `board.unreadable-${stamp}.json`;
  try {
    await store.write(name, text);
    notice = `board.json could not be read, so the cards were laid out afresh. The old file is kept as ${name}.`;
  } catch {
    notice = 'board.json could not be read, so the cards were laid out afresh.';
  }
}

async function readJSON(path: string): Promise<Record<string, unknown> | null> {
  const blob = await store.readBlob(path).catch(() => null);
  if (!blob) {
    return null;
  }
  let text = '';
  try {
    text = await blob.text();
    const data: unknown = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch { /* malformed: handled below */ }
  if (path === BOARD_FILE && text.trim() && store.isOpen) {
    await keepUnreadable(text);
  }
  return null;
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
    const extra = unknownKeys(raw, KNOWN_NODE);
    if (extra) {
      extraNode.set(path, extra);
    }
    geom.set(path, {
      x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h),
      clip: raw.clip === true,
      collapsed: raw.collapsed === true,
      stack: raw.stack === true,
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
    const id = typeof raw.id === 'string' && /^[\w-]+$/.test(raw.id) ? raw.id : newEdgeId();
    const extra = unknownKeys(raw, KNOWN_EDGE);
    if (extra) {
      extraEdge.set(id, extra);
    }
    state.edges.push({
      // The id goes into SVG markup (view/free-edges.ts), and a board.json can come from anywhere — a
      // zip, a synced vault — so only the shape this app mints is kept.
      id,
      from: fromJ, to: toJ,
      ...(fromJ ? {} : { fromPath: raw.from }), ...(toJ ? {} : { toPath: raw.to }),
      color: (typeof raw.color === 'string' && colorFill(raw.color)) ? raw.color : '',
      dashed: raw.dashed === true,   // absent = the default, which is SOLID
      fromCap: cap(raw.fromCap, legacy(raw.arrows).from),
      toCap: cap(raw.toCap, legacy(raw.arrows).to),
      label: typeof raw.label === 'string' ? raw.label : '',
      ...(port(raw.fromPort) ? { fromPort: port(raw.fromPort) } : {}),
      ...(port(raw.toPort) ? { toPort: port(raw.toPort) } : {}),
      ...(port(raw.fromPort) && isShift(raw.fromAt) ? { fromAt: raw.fromAt } : {}),
      ...(port(raw.toPort) && isShift(raw.toAt) ? { toAt: raw.toAt } : {}),
    });
  }
}

export async function loadBoard(): Promise<void> {
  keptStrokes = undefined; state.edges = []; legacyJunctions = new Set(); geom = new Map();
  extraTop = {}; extraSettings = {}; extraNode = new Map(); extraEdge = new Map();
  releaseWrites();
  state.gridStyle = 'none'; state.gridSize = 20; state.canvasColor = '';
  const board = await readJSON(BOARD_FILE);
  const newer = (v: unknown, mine: number): boolean => typeof v === 'number' && v > mine;
  if (board && (newer(board.version, BOARD_VERSION) || newer(board.model, BOARD_MODEL))) {
    holdWrites('This map was saved by a newer Corkboard. Nothing you change here is saved: reload to get the new version.');
  }
  // No board file at all is the strongest legacy signal there is: every map written since this
  // landed has one. An older board file (sketches/settings only) says the same thing.
  loadedModel = typeof board?.model === 'number' ? board.model : 1;
  if (board) {
    extraTop = unknownKeys(board, KNOWN_TOP) ?? {};
    extraSettings = unknownKeys(board.settings, KNOWN_SETTING) ?? {};
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
// …EXCEPT an end inside a folded section whose notes weren't read (data/lazy.ts): `standIn` names that
// section, which holds the end on the canvas the way a folded pill always has, and the path is KEPT —
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
    // An end already held by a path (it was on a folded section inside this one) keeps that path.
    const f = gone.get(e.from); if (f) { e.fromPath ??= f; e.from = standIn; }
    const t = gone.get(e.to); if (t) { e.toPath ??= t; e.to = standIn; }
  }
}

// ---------- writing ----------
// Its own debounce, separate from the notes': a burst of pen moves must not rewrite any .md, and an
// edge restyle must not touch a note at all.
let boardTimer: number | undefined;
export function scheduleSaveBoard(): void {
  if (!store.isOpen || writesHeld()) {
    return;   // demo mode, or a map from a newer build: never write
  }
  setSaving('board', true);
  clearTimeout(boardTimer);
  boardTimer = window.setTimeout(flushBoard, 400);
}
// A write that FAILED is still pending: the board in memory is the only copy of it, and a reload
// (data/persistence.ts reloadFromDisk) must not read the older one over it.
let boardFailed = false;
export function boardSavePending(): boolean { return boardTimer != null || boardFailed; }
export async function flushBoard(): Promise<void> {
  clearTimeout(boardTimer); boardTimer = undefined;
  if (!store.isOpen || writesHeld()) {
    setSaving('board', false);
    return;
  }
  setSaving('board', true);
  try {
    await store.write(BOARD_FILE, boardJSON());
    state.lastSelfWrite = Date.now();            // so the focus-reload ignores our own write
    boardFailed = false;
    saveSucceeded('board');
  } catch (err) {
    boardFailed = true;
    saveFailed('board', err, () => { void flushBoard(); });
  }
  if (boardTimer == null) {
    setSaving('board', false);
  }
}
