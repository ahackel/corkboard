// ============================================================
// Central mutable app state + the shared DOM handles every module renders into.
// `state` is a single object whose PROPERTIES are mutated in place (never reassign the
// binding) so the live view is shared across modules. DOM nodes live under #world /
// #stage; edges in the #edges SVG, collapse toggles in #toggles.
// ============================================================
import { byId } from '../utils/dom.js';
import { soleImage } from '../utils/markdown.js';

// A node's KIND — the whole of it (docs/PRODUCT.md, "cards are flat, frames are the only container"):
//   · card  — a note. It never has children: structure inside a thought is written into the note.
//   · frame — a resizable box (mm_w/mm_h) with a title and a description; the cards dropped inside it
//             are its children, and they sit wherever they were put. Frames nest.
// Persisted as `mm_type` (omitted for the `card` default).
export type NodeType = 'card' | 'frame';
// Node kinds that carry their own resizable box size (w/h persisted as mm_w/mm_h) rather than
// sizing from title/body content — a frame. An IMAGE card authors a height too, but
// it isn't a kind: it's a card that happens to hold nothing but a picture, so the height gate that
// reads this asks isImageCard beside it (utils/frontmatter.ts serializeMd).
export const isBoxType = (t: NodeType): boolean => t === 'frame';
export type GridStyle = 'none' | 'dot' | 'mesh' | 'line';
export type GridSize = 0 | 20 | 40 | 80 | 160 | 320;
// The grid button's cycle order (least ink → most) and the size picker's choices, kept here beside
// their types because they're also the lists data/persistence.ts validates settings.json against —
// two copies of either would drift the moment a style or step is added.
export const GRID_STYLES: GridStyle[] = ['none', 'dot', 'mesh', 'line'];
export const GRID_SIZES: GridSize[] = [0, 20, 40, 80, 160, 320];

// One ordered frontmatter entry: a top-level `key:` line plus its continuation lines.
// `key` is null for leading content with no key (preserved verbatim on save).
export interface FmEntry {
  key: string | null;
  lines: string[];
}

// A board node. One .md file per node; the filename is its identity on disk. In-memory
// `id`s are ephemeral (minted per load). Edges are DERIVED from `parent` — no edge list.
export interface MindNode {
  id: string;
  file: string | null;             // relative path on disk; null until first save
  // Position, two forms. x/y is the WORKING form (absolute world coords) — the layout and drag
  // engines read and mutate this. rx/ry is the PERSISTED form (offset from the parent, world
  // origin for a root), written as mm_position_x/y. commitRel() (view/layout.ts) derives rx/ry
  // from x/y just before a save; loadFromDir does the reverse. Between those, rx/ry may be stale.
  x: number;
  y: number;
  rx: number;                      // persisted as mm_position_x/y
  ry: number;
  parent: string | null;           // parent node id (resolved from mm_parent path at load)
  _parentPath?: string;            // transient: the mm_parent path, resolved to `parent` post-load
  collapsed: boolean;
  locked: boolean;                 // this card can be selected but not moved, (un)collapsed, or
                                    // edited (rename/body/color/delete); the
                                    // lock cascades to every descendant, which additionally can't
                                    // even be selected — see utils/model.ts hasLockedAncestor.
                                    // Persisted as mm_locked.
  type: NodeType;                  // card | frame (persisted as mm_type)
  // Resizable box size (world px). `w` is authored by every kind; `h` only by a frame (the box
  // whose interior adopts cards dropped in) and an IMAGE card — a card holding nothing but one `![alt](src)`,
  // which is its picture and so owns both axes (isImageCard above). Persisted as mm_w/mm_h.
  w?: number;
  h?: number;
  title: string;
  color: string;                   // palette key, e.g. 'blue', or '' for none
  keepStatus: string;              // preserved `status:` frontmatter value
  tags: string[];
  body: string;
  titleGap?: boolean;              // false = the note's first line sits directly under the `# ` line,
                                    // with no blank line between (utils/frontmatter.ts splitHeading).
                                    // NOT a frontmatter key — it's implicit in the file's own text,
                                    // and read back by joinHeading so a round-trip invents nothing.
                                    // Absent means the default, spaced form.
  fmEntries?: FmEntry[];           // original frontmatter, preserved verbatim on save
  dirty: boolean;                  // needs a disk write
  dirtyLayout: boolean;            // needs (re)positioning by applyLayouts
  kidOrder?: string[];             // this parent's child ORDER — seeded from position the first time
                                    // it's needed, spliced by a drag, and persisted to board.json as
                                    // paths (data/board.ts). Reconciled by orderedKids, which drops
                                    // unknown ids and appends unlisted children: the stored list is a
                                    // sort HINT, never a record of membership — mm_parent is that.
  el?: HTMLElement | null;         // the rendered card (added during paint)
  frameContentEl?: HTMLElement | null;   // this frame's overflow:hidden content wrapper (frames only)
  hostFrameId?: string | null;     // which frame's content wrapper el/frameContentEl currently live
                                    // in, DOM-wise (null = directly under #world) — transient render
                                    // bookkeeping, settled outside gestures (see main.ts settledHost)
}

// An IMAGE card is a card that IS its picture: untitled, and its whole note is one `![alt](src)`.
// DERIVED from the note, not a kind of its own — there is no `mm_type: image` any more (the legacy
// value folds to `card`, utils/frontmatter.ts foldType). So it's an ordinary card in every
// other respect: it renames, merges, sits in frames. What it gets for being one is
// the render (no padding, the picture flush to its corners), an authored HEIGHT as well as a width,
// and an aspect-locked resize — see isImageBox in main.ts, which adds "…and isn't folded or open in
// an editor", the two states where a card shows something other than its picture.
export function isImageCard(n: MindNode | null | undefined): boolean {
  return !!n && n.type === 'card' && !n.title.trim() && !!soleImage(n.body);
}

export interface View { x: number; y: number; k: number; }

// A free EDGE between two nodes — an object the user drew, not a rendering of `parent`.
// It means nothing structural: it moves nothing, collapses nothing, places no file. Stored (as
// pure data, not a node) in the vault's board.json — see data/board.ts.
//
// Its `id` is PERSISTED, unlike a node's — a node's identity is its file path, and an edge has no
// file to be identified by. Its ENDPOINTS are node ids at runtime but paths on disk, for exactly
// the reason `mm_parent` is a path: in-memory ids are minted fresh every load. `fromPath`/`toPath`
// are the transient carriers between reading the file and resolving them (data/board.ts
// resolveEdges), mirroring MindNode's `_parentPath`.
// What each END of an edge WEARS. Two independent caps rather than one three-way direction setting:
// "an arrow at this end, a dot at that one" is an ordinary thing to want to say, and a single
// `none|to|both` axis can't say it at all. `dot` is the terminator a diagram uses for "attaches
// here, no direction implied" — it marks the endpoint without claiming a flow.
export type EdgeCap = 'none' | 'dot' | 'arrow';
// One of a card's four faces — where its PORTS sit (view/free-edges.ts). A line end dropped on a port is
// PINNED to that face (BoardEdge.fromPort/toPort); an end dropped on the card's body has none, and its
// face is chosen afresh on every paint from where the two cards are.
export type EdgeSide = 'up' | 'down' | 'left' | 'right';
export interface BoardEdge {
  id: string;
  from: string;                    // node id (resolved from fromPath at load)
  to: string;
  fromPath?: string;               // transient: the on-disk path, resolved to `from` post-load
  toPath?: string;
  color: string;                   // palette key, an authored '#rrggbb', or '' for the default ink
  dashed: boolean;
  fromCap: EdgeCap;                // the cap at each end — see EdgeCap above
  toCap: EdgeCap;
  fromPort?: EdgeSide;             // the face each end is pinned to; absent = auto (see EdgeSide)
  toPort?: EdgeSide;
  label: string;
}

export interface AppState {
  dir: unknown;
  nodes: Map<string, MindNode>;    // id -> node
  view: View;                      // pan/zoom
  selId: string | null;            // primary selection — drives the single-node editor fields
  // The selected free EDGES — a SET, like `sel`, so several lines can be restyled in one go. Never
  // non-empty at the same time as a card selection: an edge and a card can't share the one floating
  // bar, so selecting either clears the other (features/edge-tools.ts).
  selEdges: Set<string>;
  sel: Set<string>;                // full selection set (⌘-click / marquee)
  gridStyle: GridStyle;            // restored per-map from settings.json — see data/persistence.ts
  gridSize: GridSize;               // pattern cell size in world px — restored per-map from settings.json
  // The MAP's own canvas colour — a colour VALUE like a node's (a palette key or an authored hex,
  // '' = the theme's background), restored per-map from settings.json. Only the TOP level: inside an
  // open frame the canvas wears that frame's fill instead. See main.ts's canvasFill, the one resolver.
  canvasColor: string;
  edges: BoardEdge[];              // free edges the user drew (loaded from / saved to board.json)
  searchMatch: Set<string> | null; // ids to highlight for the find query (matches' visible reps), or null when not searching
  searchActiveId: string | null;   // visible rep of the active dropdown option → gets a white outline
  readOnly: boolean;               // read-only mode: no saves, no edits; collapse/expand only
  idSeq: number;
  toDelete: string[];
  lastSelfWrite?: number;          // guards the external-change reload against our own writes
}

export const state: AppState = {
  dir: null,
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
  readOnly: false,
  idSeq: 1,
  toDelete: [],
};

export const world = byId('world');
export const stage = byId('stage');
// The free edges the user drew — see BoardEdge above and view/free-edges.ts.
export const freeEdgesSvg = byId<SVGSVGElement>('freeEdges');
// …and the layer BEHIND the cards that holds nothing but those edges' click targets — see index.html
// and view/free-edges.ts for why the two halves of one edge live on opposite sides of the cards.
export const freeEdgeHitsSvg = byId<SVGSVGElement>('freeEdgeHits');
export const togglesSvg = byId<SVGSVGElement>('toggles');
// Group-opacity layer for the CURRENTLY DRAGGED items: while a drag is live the dragged cards are
// re-parented in here so the whole set composites as one translucent group
// (see #dragLayer in styles.css / dragRoot() in main.ts).
export const dragLayer = byId('dragLayer');
export const statusEl = byId('status');
// What NOT to show. A toast is for what the canvas can't say itself — a refusal ("Locked — can't
// delete"), the result of an action with nothing to see (Copied, Exported, Nothing to undo), a
// warning. These messages only narrate what just happened on screen, or the save loop's heartbeat;
// they are simply dropped.
const QUIET = /^(Saving…|Saved \d|Collapsed|Expanded|Editing enabled|Selected \d|Opened “|Moved |Reordered|Re-parented|Detached|Adding image…|Image (moved|extracted|removed)$|Edge (moved|deleted)$|\d+ edges deleted|Drop to save|Pasted “|Pasted \d|Deleted \d|Cloned|Duplicated|Created “|Grouped|Extracted|Connected \d|Merged)|(is now a root|is now a top-level card|left the frame)$/;
let toastTimer = 0;
export const setStatus = (t: string): void => {
  if (QUIET.test(t)) return;
  statusEl.textContent = t;
  statusEl.classList.add('show');
  window.clearTimeout(toastTimer);
  // long enough to read: ~2s, plus a beat per extra word for the longer warnings
  toastTimer = window.setTimeout(() => statusEl.classList.remove('show'), 1600 + 60 * t.length);
};
