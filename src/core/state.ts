// The shared mutable `state` (mutate its properties, never reassign it) and the DOM handles.
import { byId } from '../utils/dom.js';
import { soleImage } from '../utils/markdown.js';

// A card never holds cards; a section is a box whose children are the cards inside it.
export type NodeType = 'card' | 'section';

// Kinds with an authored box size. An image card authors a height too, but isn't a kind (isImageCard).
export const isBoxType = (t: NodeType): boolean => t === 'section';
export type GridStyle = 'none' | 'dot' | 'mesh' | 'line';
export type GridSize = 0 | 20 | 40 | 80 | 160 | 320;

// Also what data/persistence.ts validates settings.json against.
export const GRID_STYLES: GridStyle[] = ['none', 'dot', 'mesh', 'line'];
export const GRID_SIZES: GridSize[] = [0, 20, 40, 80, 160, 320];

// A top-level `key:` line plus its continuation lines; `key` is null for keyless content.
// One ordered frontmatter entry: a top-level `key:` line plus its continuation lines.
// `key` is null for leading content with no key (preserved verbatim on save).
export interface FmEntry {
  key: string | null;
  lines: string[];
}

// One .md file per node, identified on disk by its path; `id`s are minted fresh per load.
export interface MindNode {
  id: string;
  file: string | null;             // null until first save

  // x/y: absolute world coords, the working form. rx/ry: offset from the parent, derived by
  // commitRel() before a save and possibly stale in between.
  x: number;
  y: number;
  rx: number;
  ry: number;
  parent: string | null;           // the containing section's id
  lazy?: number;                   // a folded section's unread note count (data/lazy.ts)
  lazySections?: number;           // …of which sections
  _parentPath?: string;            // resolved to `parent` after load
  collapsed: boolean;
  locked: boolean;                 // cascades: descendants can't even be selected (hasLockedAncestor)
  type: NodeType;
  w?: number;                      // world px; `h` is authored only by sections and image cards
  h?: number;
  clip?: boolean;                  // dragged shorter than its text: `h` is exact and the rest clipped
  stack?: boolean;                 // a section drawn as a pile (isStack)
  title: string;
  color: string;
  tags: string[];
  body: string;
  titleGap?: boolean;              // see splitHeading; absent = spaced
  titleLevel?: number;             // the title heading's `#` count; absent = 1
  fmEntries?: FmEntry[];
  dirty: boolean;

  // A sort HINT, never membership (the folder is that): orderedKids drops unknown ids and appends the rest.
  kidOrder?: string[];
  el?: HTMLElement | null;
  sectionContentEl?: HTMLElement | null;
  hostSectionId?: string | null;   // whose content wrapper `el` lives in (null = #world); see settledHost
}

// Derived from the note, never a kind: see "A card whose whole note is one image IS that image".
export function isImageCard(n: MindNode | null | undefined): boolean {
  return !!n && n.type === 'card' && !n.title.trim() && !!soleImage(n.body);
}

// Not a third kind: `type` stays 'section'.
export function isStack(n: MindNode | null | undefined): boolean {
  return !!n && n.type === 'section' && !!n.stack;
}

export interface View { x: number; y: number; k: number; }

// A free EDGE means nothing structural. Its `id` is persisted (it has no file to be known by); its
// endpoints are node ids at runtime and paths on disk (`fromPath`/`toPath`).
export type EdgeCap = 'none' | 'dot' | 'arrow';

// A face a line end can be PINNED to; an unpinned end picks its face afresh on every paint.
export type EdgeSide = 'up' | 'down' | 'left' | 'right';
export interface BoardEdge {
  id: string;
  from: string;
  to: string;

  // Kept while that end is inside an unread folded section, which `from` then stands in for.
  fromPath?: string;
  toPath?: string;
  color: string;                   // '' = the default ink
  dashed: boolean;
  fromCap: EdgeCap;
  toCap: EdgeCap;
  fromPort?: EdgeSide;             // absent = auto
  toPort?: EdgeSide;
  fromAt?: number;                 // 0..1 along the pinned face; absent = the middle
  toAt?: number;
  label: string;
}

export interface AppState {
  nodes: Map<string, MindNode>;
  view: View;
  selId: string | null;            // the primary selection

  // Never non-empty alongside a card selection: they share the one floating bar.
  selEdges: Set<string>;
  sel: Set<string>;
  gridStyle: GridStyle;
  gridSize: GridSize;
  canvasColor: string;             // top level only; '' = the theme's (see canvasFill)
  edges: BoardEdge[];
  searchMatch: Set<string> | null; // the visible reps of find's matches, or null when not searching
  searchActiveId: string | null;
  singleNote: boolean;             // see singleNoteRefuses
  idSeq: number;
  toDelete: string[];
  lastSelfWrite?: number;          // guards the external-change reload against our own writes
}

export const state: AppState = {
  nodes: new Map<string, MindNode>(),
  view: { x: 80, y: 40, k: 1 },
  selId: null,
  sel: new Set<string>(),
  selEdges: new Set<string>(),
  gridStyle: 'none',
  gridSize: 20,
  canvasColor: '',
  edges: [],
  searchMatch: null,
  searchActiveId: null,
  singleNote: false,
  idSeq: 1,
  toDelete: [],
};

export const world = byId('world');
export const stage = byId('stage');
export const freeEdgesSvg = byId<SVGSVGElement>('freeEdges');
export const freeEdgesHeldSvg = byId<SVGSVGElement>('freeEdgesHeld');

// Behind the cards: only the edges' click targets (see view/free-edges.ts).
export const freeEdgeHitsSvg = byId<SVGSVGElement>('freeEdgeHits');
export const togglesSvg = byId<SVGSVGElement>('toggles');

// The dragged cards are re-parented here so they composite as ONE translucent group.
export const dragLayer = byId('dragLayer');
const statusEl = byId('status');
const TOAST_BASE_MS = 1600;
const TOAST_MS_PER_CHAR = 60;

// A toast says what the canvas can't (a refusal, a result with nothing to see), never narrates.
let toastTimer = 0;
export const setStatus = (t: string): void => {
  statusEl.textContent = t;
  statusEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => statusEl.classList.remove('show'), TOAST_BASE_MS + TOAST_MS_PER_CHAR * t.length);
};

// The ONE gate on every path that adds or removes a node while a single note is open.
export function singleNoteRefuses(): boolean {
  if (!state.singleNote) {
    return false;
  }
  setStatus('This is a single note — open a folder to add or remove cards');
  return true;
}
