// ============================================================
// board.json — the ONE sidecar beside the notes.
//
// A node is a file and carries its own frontmatter; everything that is about the BOARD rather than
// about a note lives here instead: the free edges the user drew, the freehand ink layer, and the
// per-map view preferences. It replaces the two sidecars this app used to keep (sketch.json and
// settings.json), which are still READ so an older vault opens unchanged — but never written again.
//
// The split rule, in one line: frontmatter describes the NOTE, board.json describes the BOARD's
// arrangement of it. `mm_parent` is the deliberate exception (see docs/architecture.md) — keeping
// membership in the note is what lets a folder stand on its own if this file is lost.
// ============================================================
import { state, setStatus, GRID_STYLES, GRID_SIZES, isBoxType, isImageCard, type Stroke, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { store } from './persistence.js';
import { colorFill } from '../main.js';
import { commitRel } from '../view/layout.js';
import { facingSides } from '../view/free-edges.js';

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
// Superseded sidecars: read once when there is no board.json yet, never written.
export const SKETCH_FILE = 'sketch.json';
export const SETTINGS_FILE = 'settings.json';

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
    strokes: state.strokes,
  });
}

// An edge's ENDPOINTS go to disk as paths, never as ids — see BoardEdge in core/state.ts. An edge
// whose endpoint has no file yet (a card created this session and not yet saved) is dropped rather
// than written half-resolved; the next save, once the note has a name, writes it whole.
type StoredEdge = { id: string; from: string; to: string; fromSide?: EdgeSide; toSide?: EdgeSide;
                    color?: string; dashed?: boolean; fromCap?: EdgeCap; toCap?: EdgeCap;
                    arrows?: 'none' | 'to' | 'both';   // legacy: ONE direction axis, read never written
                    label?: string };
function serializeEdge(e: BoardEdge): StoredEdge | null {
  const from = state.nodes.get(e.from)?.file, to = state.nodes.get(e.to)?.file;
  if (!from || !to) return null;
  // Most fields are omitted when they equal the DEFAULT a fresh edge is born with (makeEdge), so a
  // board file stays readable. `dashed` is written ALWAYS, deliberately: it is a boolean whose
  // default has already been changed once, and the omit-when-default rule silently inverts such a
  // field the moment its default flips (a solid edge came back dashed, and then the reverse). A few
  // bytes buy immunity from that whole class of bug.
  return { id: e.id, from, to, fromSide: e.fromSide, toSide: e.toSide,
           ...(e.color ? { color: e.color } : {}), dashed: e.dashed,
           ...(e.fromCap !== 'none' ? { fromCap: e.fromCap } : {}),
           ...(e.toCap !== 'arrow' ? { toCap: e.toCap } : {}), ...(e.label ? { label: e.label } : {}) };
}

// A persisted id, unlike a node's — a node is identified by its file and an edge has no file.
export function newEdgeId(): string {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeEdge(from: string, to: string, fromSide: EdgeSide = 'right', toSide: EdgeSide = 'left'): BoardEdge {
  return { id: newEdgeId(), from, to, fromSide, toSide, color: '', dashed: false,
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
// `order` is a SORT HINT, never a record of membership: `mm_parent` alone says who belongs to whom.
// Entries that don't resolve are ignored and children missing from the list are appended by position
// (view/layout.ts orderedKids already does exactly this), so the list cannot lie about the tree — at
// worst it is incomplete, and incomplete degrades to filename order.
export interface StoredGeom { x?: number; y?: number; w?: number; h?: number; collapsed?: boolean; order?: string[] }
let geom = new Map<string, StoredGeom>();
export function boardGeom(path: string | null): StoredGeom | undefined {
  return path ? geom.get(path) : undefined;
}
function collectGeom(): Record<string, StoredGeom> {
  const out: Record<string, StoredGeom> = {};
  for (const n of state.nodes.values()) {
    if (!n.file) continue;                       // never saved yet: it has no key to be stored under
    const g: StoredGeom = { x: Math.round(n.rx), y: Math.round(n.ry) };
    // The AUTHORED width — every kind can carry one (a card is resizable on this axis alone). The
    // HEIGHT belongs to the kinds that own a box, plus the one card that IS one: an IMAGE card
    // (core/state.ts isImageCard) is its picture, so both axes are authored. Any other card measures
    // its height from its content, and a card with children derives its own from its outline, so
    // storing an h for either would freeze a value they recompute anyway.
    if (n.w != null) g.w = Math.round(n.w);
    if ((isBoxType(n.type) || isImageCard(n)) && n.h != null) g.h = Math.round(n.h);
    if (n.collapsed) g.collapsed = true;
    const order = (n.kidOrder ?? []).map(id => state.nodes.get(id)?.file).filter((f): f is string => !!f);
    if (order.length > 1) g.order = order;       // a single child has no order worth writing
    out[n.file] = g;
  }
  return out;
}
// Re-seed each parent's in-memory child order from the stored paths. Called by loadFromDir once the
// path index exists. orderedKids owns the reconciliation from here — see the `order` note above.
export function resolveOrder(byPath: Map<string | null, string>): void {
  for (const n of state.nodes.values()) {
    const order = geom.get(n.file ?? '')?.order;
    if (!order) continue;
    const ids = order.map(p => byPath.get(p)).filter((id): id is string => !!id);
    if (ids.length) n.kidOrder = ids;
  }
}

// ---------- reading ----------
async function readJSON(path: string): Promise<Record<string, unknown> | null> {
  try {
    const blob = store.readBlob ? await store.readBlob(path) : null;
    if (!blob) return null;
    const data = JSON.parse(await blob.text());
    return (data && typeof data === 'object') ? data as Record<string, unknown> : null;
  } catch { return null; }        // missing or malformed → the caller's defaults stand
}

// Both shapes land here: board.json nests these under `settings`, the legacy settings.json had them
// at the top level, and the keys are the same either way.
function applySettings(d: Record<string, unknown> | null | undefined): void {
  if (!d) return;
  if (GRID_STYLES.includes(d.grid as never)) state.gridStyle = d.grid as never;
  if (GRID_SIZES.includes(d.gridSize as never)) state.gridSize = d.gridSize as never;
  // Validated the same way a node's own colour is (colorFill resolves a palette key OR a hex, and
  // nothing else), so a hand-edited board.json can't paint the canvas an arbitrary CSS value.
  if (typeof d.canvasColor === 'string' && colorFill(d.canvasColor)) state.canvasColor = d.canvasColor;
}

function applyStrokes(v: unknown): void { if (Array.isArray(v)) state.strokes = v as Stroke[]; }

function applyGeom(v: unknown): void {
  if (!v || typeof v !== 'object') return;
  const num = (x: unknown): number | undefined => typeof x === 'number' && isFinite(x) ? x : undefined;
  for (const [path, raw] of Object.entries(v as Record<string, StoredGeom>)) {
    if (!raw || typeof raw !== 'object') continue;
    geom.set(path, {
      x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h),
      collapsed: raw.collapsed === true,
      order: Array.isArray(raw.order) ? raw.order.filter(p => typeof p === 'string') : undefined,
    });
  }
}

// Edges arrive holding PATHS; resolveEdges (below) turns them into ids once the notes are loaded.
function applyEdges(v: unknown): void {
  if (!Array.isArray(v)) return;
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
  // An edge written before ports were stored has no sides. Rather than guess here — the nodes aren't
  // loaded yet — leave them undefined and let resolveEdges backfill from the geometry, ONCE.
  const side = (v: unknown): EdgeSide | undefined =>
    (v === 'up' || v === 'down' || v === 'left' || v === 'right') ? v : undefined;
  for (const raw of v as StoredEdge[]) {
    if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') continue;
    state.edges.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : newEdgeId(),
      from: '', to: '', fromPath: raw.from, toPath: raw.to,
      fromSide: side(raw.fromSide) as EdgeSide, toSide: side(raw.toSide) as EdgeSide,
      color: (typeof raw.color === 'string' && colorFill(raw.color)) ? raw.color : '',
      dashed: raw.dashed === true,   // absent = the default, which is SOLID
      fromCap: cap(raw.fromCap, legacy(raw.arrows).from),
      toCap: cap(raw.toCap, legacy(raw.arrows).to),
      label: typeof raw.label === 'string' ? raw.label : '',
    });
  }
}

export async function loadBoard(): Promise<void> {
  state.strokes = []; state.edges = []; geom = new Map();
  state.gridStyle = 'none'; state.gridSize = 20; state.canvasColor = '';
  const board = await readJSON(BOARD_FILE);
  // No board file at all is the strongest legacy signal there is: every map written since this
  // landed has one. An older board file (sketches/settings only) says the same thing.
  loadedModel = typeof board?.model === 'number' ? board.model : 1;
  if (board) {
    applySettings(board.settings as Record<string, unknown>);
    applyEdges(board.edges);
    applyGeom(board.nodes);
    applyStrokes(board.strokes);
    return;
  }
  // No board.json: an older vault. Read the two sidecars it replaced, once. Nothing deletes them —
  // the next save simply writes board.json beside them, so the old files stay readable by an older
  // build of the app until the user removes them.
  applyStrokes((await readJSON(SKETCH_FILE))?.strokes);
  applySettings(await readJSON(SETTINGS_FILE));
}

// Turn each edge's stored PATHS into live node ids. Called by loadFromDir once every note is in
// state.nodes and the path index exists. An endpoint that doesn't resolve — a note deleted in
// Finder, a renamed file — drops the whole edge silently: a board degrades, it never corrupts.
export function resolveEdges(byPath: Map<string | null, string>): void {
  state.edges = state.edges.filter(e => {
    const from = byPath.get(e.fromPath ?? ''), to = byPath.get(e.toPath ?? '');
    if (!from || !to || from === to) return false;
    e.from = from; e.to = to;
    delete e.fromPath; delete e.toPath;
    return true;
  });
  // An edge stored before ports existed gets them backfilled ONCE, from where its two cards sit
  // right now — and never again, which is the whole point of storing them (core/state.ts EdgeSide).
  // Deferred to here rather than done in applyEdges because it needs the nodes, and their final
  // positions, both of which only exist by this point in the load.
  for (const e of state.edges) {
    if (e.fromSide && e.toSide) continue;
    const a = state.nodes.get(e.from), b = state.nodes.get(e.to);
    if (!a || !b) continue;
    const facing = facingSides(a, b);
    e.fromSide ??= facing.from;
    e.toSide ??= facing.to;
  }
}

// ---------- writing ----------
// Its own debounce, separate from the notes': a burst of pen moves must not rewrite any .md, and an
// edge restyle must not touch a note at all.
let boardTimer: number | undefined;
export function scheduleSaveBoard(): void {
  if (state.readOnly || !store.isOpen) return;   // read-only / demo mode: never write
  clearTimeout(boardTimer);
  boardTimer = setTimeout(flushBoard, 400);
}
export function boardSavePending(): boolean { return boardTimer != null; }
export async function flushBoard(): Promise<void> {
  clearTimeout(boardTimer); boardTimer = undefined;
  if (state.readOnly || !store.isOpen) return;
  try {
    await store.write(BOARD_FILE, boardJSON());
    state.lastSelfWrite = Date.now();            // so the focus-reload ignores our own write
  } catch (err) {
    console.error('Board save failed:', err);
    setStatus('⚠ Board save failed: ' + ((err as Error).message || (err as Error).name));
  }
}
