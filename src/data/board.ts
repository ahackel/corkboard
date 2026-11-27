// board.json, the one sidecar: the board's ARRANGEMENT (positions, sizes, folds, lines, view settings).
// Membership is not here: a section is a folder.
import { state, GRID_STYLES, GRID_SIZES, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { dirOf } from '../utils/filenames.js';
import { store } from './active-store.js';
import { commitRel } from '../view/layout.js';
import { flattenJunctions } from '../utils/edge-graph.js';
import { saveFailed, saveSucceeded, holdWrites, releaseWrites, writesHeld } from './save-alert.js';
import { setSaving } from './save-flag.js';
import { colorFill } from '../view/color.js';

export const BOARD_FILE = 'board.json';
// Model 1 (or no board file) predates containment; flattenLegacyBranches migrates it. Bump only for
// another migration of that kind.
const BOARD_MODEL = 2;
// A board with a higher version or model was written by a newer build: shown, never written.
const BOARD_VERSION = 1;
let loadedModel = BOARD_MODEL;

// Keys this build doesn't know are written back as they came in, like a note's unknown frontmatter.
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

export function boardPathMoved(from: string, to: string): void {
  const extra = extraNode.get(from);
  if (extra) {
    extraNode.delete(from);
    extraNode.set(to, extra);
  }
}
// Only meaningful between loadBoard and the migration that reads it.
export function boardIsLegacy(): boolean { return loadedModel < BOARD_MODEL; }
// Superseded sidecar: read once when there is no board.json yet, never written.
const SETTINGS_FILE = 'settings.json';
// The retired sketch layer's ink, kept verbatim so cutting the feature never deleted a drawing.
let keptStrokes: unknown;

export function boardJSON(): string {
  // The board has its own debounce, so it can't rely on saveAll having refreshed rx/ry.
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

// Endpoints are stored as PATHS (ids are minted per load); an end with no file yet is dropped until saved.
interface StoredEdge { id: string; from: string; to: string;
                    fromJ?: string; toJ?: string;      // legacy junction end: read, flattened, never written
                    color?: string; dashed?: boolean; fromCap?: EdgeCap; toCap?: EdgeCap;
                    // Deliberately not the old `fromSide`/`toSide`, which pinned every line to a face nobody chose.
                    fromPort?: EdgeSide; toPort?: EdgeSide;
                    fromAt?: number; toAt?: number;
                    arrows?: 'none' | 'to' | 'both';   // legacy: read, never written
                    label?: string }
// Three decimals is finer than any card is wide.
const shift = (at: number): number => Math.round(at * 1000) / 1000;
const isShift = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

function serializeEdge(e: BoardEdge): StoredEdge | null {
  // A path-held end is a note in an unread folded section: the path is still where the line goes.
  const from = e.fromPath ?? state.nodes.get(e.from)?.file, to = e.toPath ?? state.nodes.get(e.to)?.file;
  if (!from || !to) {
    return null;
  }
  // Defaults are omitted, except `dashed`: omitting a boolean silently inverts it if its default ever flips.
  return { id: e.id, from, to,
           ...(e.color ? { color: e.color } : {}), dashed: e.dashed,
           ...(e.fromCap !== 'none' ? { fromCap: e.fromCap } : {}),
           ...(e.toCap !== 'arrow' ? { toCap: e.toCap } : {}), ...(e.label ? { label: e.label } : {}),
           ...(e.fromPort ? { fromPort: e.fromPort } : {}), ...(e.toPort ? { toPort: e.toPort } : {}),
           ...(e.fromPort && e.fromAt != null ? { fromAt: shift(e.fromAt) } : {}),
           ...(e.toPort && e.toAt != null ? { toAt: shift(e.toAt) } : {}) };
}

// Persisted, unlike a node's id: an edge has no file to be identified by.
function newEdgeId(): string {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeEdge(from: string, to: string): BoardEdge {
  return { id: newEdgeId(), from, to, color: '', dashed: false,
           fromCap: 'none', toCap: 'arrow', label: '' };
}

// Keyed by the note's PATH. `x`/`y` are relative to the parent (world coords at the top level). `order` is
// only a sort hint (orderedKids reconciles it), never membership: the folder alone says that.
export interface StoredGeom { x?: number; y?: number; w?: number; h?: number; clip?: boolean; collapsed?: boolean; stack?: boolean; order?: string[] }
let geom = new Map<string, StoredGeom>();
export function boardGeom(path: string | null): StoredGeom | undefined {
  return path ? geom.get(path) : undefined;
}
function lazyFolders(): string[] {
  return [...state.nodes.values()].filter(n => n.lazy != null && n.file).map(n => dirOf(n.file!));
}
function collectGeom(): Record<string, StoredGeom> {
  const out: Record<string, StoredGeom> = {};
  // An unread folder's notes aren't in memory: carry their geometry over or the write would forget it.
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
      continue;                       // never saved yet: no key to store it under
    }
    const g: StoredGeom = { x: Math.round(n.rx), y: Math.round(n.ry) };
    if (n.w != null) {
      g.w = Math.round(n.w);
    }
    if (n.h != null) {
      g.h = Math.round(n.h);
    }
    if (n.clip) {
      g.clip = true;
    }
    if (n.collapsed) {
      g.collapsed = true;
    }
    if (n.stack) {
      g.stack = true;
    }
    const order = (n.kidOrder ?? []).map(id => state.nodes.get(id)?.file).filter((f): f is string => !!f);
    if (order.length > 1) {
      g.order = order;
    }
    if (n.lazy != null && geom.get(n.file)?.order) {
      g.order = geom.get(n.file)!.order;   // its kids are unread
    }
    out[n.file] = { ...extraNode.get(n.file), ...g };
  }
  return out;
}
// For nodes about to be let go of (releaseFolded): collectGeom keeps writing it, the next read seeds from it.
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

// An unreadable board.json is about to be written over, so its text is kept aside first (keepUnreadable).
let notice = '';

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

// Same keys under board.json's `settings` and at the top of the legacy settings.json.
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
  // colorFill accepts only a palette key or hex: a hand-edited file can't inject arbitrary CSS.
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

// Legacy junction ids, read before the edges so resolveEdges can flatten lines that met at one.
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
  // The old single `arrows` axis maps exactly onto the two caps.
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
    // A junction end is already an id, so it gets no *Path for resolveEdges to look up.
    const fromJ = typeof raw.fromJ === 'string' ? raw.fromJ : '';
    const toJ = typeof raw.toJ === 'string' ? raw.toJ : '';
    if ((fromJ && !legacyJunctions.has(fromJ)) || (toJ && !legacyJunctions.has(toJ))) {
      continue;
    }
    // The id goes into SVG markup and the file can come from anywhere: only the shape we mint is kept.
    const id = typeof raw.id === 'string' && /^[\w-]+$/.test(raw.id) ? raw.id : newEdgeId();
    const extra = unknownKeys(raw, KNOWN_EDGE);
    if (extra) {
      extraEdge.set(id, extra);
    }
    state.edges.push({
      id,
      from: fromJ, to: toJ,
      ...(fromJ ? {} : { fromPath: raw.from }), ...(toJ ? {} : { toPath: raw.to }),
      color: (typeof raw.color === 'string' && colorFill(raw.color)) ? raw.color : '',
      dashed: raw.dashed === true,
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
  const legacy = await readJSON(SETTINGS_FILE);
  // A brand-new map starts dotted; an existing one keeps its grid.
  if (!legacy) {
    state.gridStyle = 'dot';
  }
  applySettings(legacy);
}

// Stored paths → live ids. An unresolved end drops the edge (a board degrades, never corrupts), unless it
// is in an unread folded section: `standIn` holds it on the canvas and the path is kept (unparkEdges).
export function resolveEdges(byPath: Map<string | null, string>, standIn: (path: string) => string | null = () => null): void {
  state.edges = state.edges.filter(e => {
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
  if (legacyJunctions.size) {
    state.edges = flattenJunctions(state.edges, id => legacyJunctions.has(id))
      .filter(e => state.nodes.has(e.from) && state.nodes.has(e.to) && e.from !== e.to);
    legacyJunctions = new Set();
  }
}

export function unparkEdges(byPath: Map<string | null, string>): void {
  for (const e of state.edges) {
    const f = e.fromPath != null ? byPath.get(e.fromPath) : undefined;
    if (f) { e.from = f; delete e.fromPath; }
    const t = e.toPath != null ? byPath.get(e.toPath) : undefined;
    if (t) { e.to = t; delete e.toPath; }
  }
}
// Nodes are being let go of: their ends go back to PATHS, held by `standIn` (an existing path is kept).
export function parkEdges(gone: Map<string, string>, standIn: string): void {
  for (const e of state.edges) {
    const f = gone.get(e.from); if (f) { e.fromPath ??= f; e.from = standIn; }
    const t = gone.get(e.to); if (t) { e.toPath ??= t; e.to = standIn; }
  }
}

// Its own debounce: an edge restyle must not touch a note.
const BOARD_SAVE_DELAY_MS = 400;
let boardTimer: number | undefined;
export function scheduleSaveBoard(): void {
  if (!store.isOpen || writesHeld()) {
    return;
  }
  setSaving('board', true);
  clearTimeout(boardTimer);
  boardTimer = window.setTimeout(flushBoard, BOARD_SAVE_DELAY_MS);
}
// A failed write is still pending: a reload must not read the older file over it.
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
