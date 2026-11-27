// Live interaction state shared by the render core and the features. Mutate `ui`'s properties in
// place: an imported `let` would be read-only.
import type { EdgeSide, MindNode } from './state.js';

export interface Pt { x: number; y: number }

// `targets` follow the cursor (after a Shift-clone, just the clones).
export interface Drag {
  n: MindNode; active: MindNode; multi: boolean;
  sx: number; sy: number; cx: number; cy: number;
  start: Map<string, Pt>; targets: Map<string, Pt>; origins: Map<string, Pt>;
  selRoots: string[];              // the outermost dragged nodes; descendants ride along
  moved: boolean;
  dropTarget: string | null;       // the section a release would land in now; previews colour
  alt: boolean; shift: boolean; cloned: boolean;
  meta: boolean; touch: boolean;

  fromFrame?: boolean;             // pressed on the selection frame: a click keeps the selection
  reclick?: boolean;               // pressed on the sole selection: a click opens its editor
  clones?: MindNode[] | null;
  cardMerge?: string | null;       // ⌥ over a card: merge into it; dropTarget stays null
  chute?: Chute | null;            // over a folded pill or a crumb: file the cards there
  pile?: { id: string; make: boolean } | null;   // `make`: the target is a card, so wrap it in a stack
  pileHover?: { id: string; since: number } | null;
  fanSlot?: number | null;         // the slot within the fanned stack
}

// `beside`: the section the cards came out of, for a crumb; they land next to it.
export interface Chute { parent: string | null; beside?: string }

// A card's title is its text's first line, so ONE textarea holds the whole note. `holdH` pins the
// opening height so the card doesn't jump; `saved` is what the note holds now (after flushOpenEdit).
export interface BodyEdit { id: string; orig: string; saved: string; el: HTMLElement; ta: HTMLTextAreaElement; isNew?: boolean; holdH?: number; }

// A section's `.body` is display:none, so its label is edited ON its tab, in a contenteditable.
export interface TitleEdit { id: string; el: HTMLElement; isNew?: boolean; }
export interface PanState { sx: number; sy: number; ox: number; oy: number; }
export interface Marquee { sx: number; sy: number; add: boolean; base: Set<string>; moved: boolean;
  clickNode?: string | null;       // started on an unselected section: a no-move click selects it
  boxes?: Array<{ id: string; x0: number; y0: number; x1: number; y1: number }>;
  hits?: string; }
export interface Pinch { dist: number; cx: number; cy: number; }

// Safari-only pinch events (not in lib.dom).
export interface GestureEvt extends Event { clientX: number; clientY: number; scale: number; }

export const ui = {
  // Bumped by every paint/placement, so followers can tell whether anything moved.
  paintTick: 0,
  wheeling: false,
  extracting: false,
  drag: null as Drag | null,
  dragRAF: null as number | null,
  autoPanRAF: null as number | null,
  pan: null as PanState | null,
  marquee: null as Marquee | null,
  spaceHeld: false,
  spaceUsedForPan: false,
  pinch: null as Pinch | null,

  // A line being drawn or re-routed: `sourceId` is the fixed end, `edgeId`/`end` set only when moving
  // an existing end. `grabbedAt` lets a too-short drag count as a click.
  edgeDraw: null as { sourceId: string; to: Pt; grabbedAt: Pt; overId?: string; overSide?: EdgeSide; overAt?: number;
                      edgeId?: string; end?: 'from' | 'to'; side?: EdgeSide } | null,
  gestureStartK: 1,
  gestureMid: { x: 0, y: 0 } as Pt,
  resizingId: null as string | null,

  // At most one is set; either defers the file rename and disk reload.
  bodyEdit: null as BodyEdit | null,
  titleEdit: null as TitleEdit | null,
  fan: null as string | null,      // the fanned-out stack
  animToken: 0,

  // null until the mouse first moves (touch never sets it): callers fall back to the viewport centre.
  lastMouse: null as Pt | null,
};

export const gPointers = new Map<number, Pt>();

export function inPlaceEditActive(): boolean { return !!(ui.bodyEdit || ui.titleEdit); }

// The ONE spelling of "busy". canvasMoving hides the selection bars; isBusy (also a line being drawn,
// a picture being pulled) holds back a hover peek.
export function canvasMoving(): boolean {
  return !!(ui.drag || ui.pan || ui.pinch || ui.marquee) || inPlaceEditActive() || ui.wheeling;
}

export function isBusy(): boolean { return canvasMoving() || !!ui.edgeDraw || ui.extracting; }

export function inPlaceEditOn(id: string): boolean {
  return ui.bodyEdit?.id === id || ui.titleEdit?.id === id;
}

// Frozen while typing, so the folder isn't littered with M.md, Ma.md, Mag.md…; renamed on commit.
export function frozenFileNodeId(): string | null { return ui.bodyEdit?.id ?? ui.titleEdit?.id ?? null; }

// Must match the `@media (max-width:700px)` breakpoint in styles.css.
export const NARROW_MQ = matchMedia('(max-width: 700px)');
const COARSE_MQ = matchMedia('(pointer: coarse)');

// AND, not OR: an iPad is coarse but wide, a narrow desktop window keeps its fine pointer.
export function phoneMode(): boolean { return COARSE_MQ.matches && NARROW_MQ.matches; }

// Card/canvas shortcuts and the disk reload stand down while the user types in a field.
export function isTypingInField(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(a?.tagName ?? '') || !!a?.isContentEditable;
}
