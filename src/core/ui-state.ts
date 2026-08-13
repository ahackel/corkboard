// ============================================================
// Shared mutable UI state for the interactive canvas subsystem (drag, in-place editing,
// pan/zoom gestures, image-drop). Like `state`, this is ONE object whose PROPERTIES are
// mutated in place (never reassign `ui`) so the live interaction state is shared across the
// render core (main.ts) and the feature modules split out of it (drag / inline-edit / gestures
// / attachments). Imported `let` bindings are read-only, hence the holder-object pattern.
// ============================================================
import type { MindNode, LayoutSide } from './state.js';

export type Pt = { x: number; y: number };
// World-space line segment (axis-aligned for the insertion indicator).
export type Seg = { x0: number; y0: number; x1: number; y1: number };

// A live node drag (moves a whole subtree, or the multi-selection). `active` is the card being
// dragged/dropped; `targets` follow the cursor (or, after a Shift-clone, just the clones).
export interface Drag {
  n: MindNode; active: MindNode; multi: boolean;
  sx: number; sy: number; cx: number; cy: number;
  start: Map<string, Pt>; targets: Map<string, Pt>; origins: Map<string, Pt>;
  // Top-level roots of the drag (a single-node drag's [n.id], or a multi-selection's members
  // whose own parent isn't ALSO selected — descendants ride along with their selected ancestor
  // rather than getting re-parented independently). Reparented as a group on drop.
  selRoots: string[];
  // dropMode 'reorder' = no card hovered but the drag is sliding along its OWN parent's
  // line/fan sibling band — dropTarget is the parent itself, the drop just re-slots the order.
  moved: boolean; dropTarget: string | null; dropMode: 'child' | 'sibling' | 'reorder';
  // Side the drop resolved to (edge zone -> that edge; centre zone -> the sibling target's own
  // side), set explicitly on every reparented root on commit — see features/drag.ts.
  dropSide: LayoutSide | null;
  // Insertion anchor for sibling/reorder drops: slot in right after this sibling in the parent's
  // order (`null` = at the front, `undefined` = default — after the hovered card / appended).
  dropAfter: string | null | undefined;
  // World-space gap segment of the insertion-line preview, when one is showing (managed governor
  // with children on the resolved side). The line REPLACES the landing ghost and the dashed
  // would-be-edge preview — they never show together (see features/drag.ts, view/edges.ts).
  dropLine: Seg | null;
  alt: boolean; shift: boolean; cloned: boolean; rip: boolean;
  meta: boolean; touch: boolean;
  clones?: MindNode[] | null;
  // Alt-dragging image CARD(s) over a plain body card: the target card's id to fold the image(s)
  // into on drop (instead of reparenting). Set by updateDropTarget, consumed by dragPointerUp.
  imageMerge?: string | null;
  // Alt-dragging plain CARD(s)/annotation(s) over another card: the target card's id to fold their
  // notes into on drop (crud.ts mergeCardsInto) instead of reparenting. Same shape as imageMerge —
  // the two are the same gesture on different content, and neither is a reparent-with-a-landing.
  cardMerge?: string | null;
  // The frame whose TAB the dragged frame(s) are poised over: releasing DOCKS them there as tabs
  // (features/drag.ts tabZoneAt → crud.ts dockFrames). Its own resolution, not a dropMode, because it
  // isn't a reparent-with-a-landing: dropTarget/dropSide stay null, so every other preview stands
  // down — same shape as imageMerge above.
  dock?: string | null;
  // …and the slot it would take in that frame's strip: the tab it lands AFTER (`null` = first).
  dockAfter?: string | null;
}
// A card's editing session. ONE per card and one field: a card's title is the leading `# ` line of
// its text (utils/frontmatter.ts splitHeading), so there is no separate title editor to hold — the
// textarea holds the whole note, heading and all. `isNew` marks a just-created card, where Escape
// cancels the CREATION rather than just the edit (it used to live on the title editor).
export interface BodyEdit { id: string; orig: string; el: HTMLElement; ta: HTMLTextAreaElement; isNew?: boolean; }
// A CONTAINER's label being renamed in place — a frame's folder tab, a docked tab, a stack's header.
// A card has no session of its own kind: its name is the leading `# ` line of the one text field above.
// A container can't do that, and the reason is structural rather than stylistic — its `.body` is
// `display:none` (styles.css: a frame's box holds child cards, not its own note), and an editor inside a
// hidden element can't be focused or typed into. So its label is edited ON itself, one line, in a
// contenteditable. Same contract as BodyEdit otherwise: while set, persistence freezes this node's
// filename and skips the focus-reload.
// No `orig`: unlike a card's editor there is nothing to compare against on commit — an empty label
// falls back to what the node had, and the element's own text is the only value read.
export interface TitleEdit { id: string; el: HTMLElement; isNew?: boolean; }
// A query card's search-field editing session (main.ts nodeEl/onQueryInput/endQueryEdit) — mirrors
// InlineEdit/BodyEdit's touch-once-on-focus, commit-on-blur shape so the whole typing session is one
// undo step instead of one per keystroke.
export interface QueryEdit { id: string; orig: string; }
// A full-screen editor-sheet session (features/editor-sheet.ts) — the phone/outline replacement
// for the in-card editors. Same contract: while set, persistence defers the file rename and the
// focus-reload (the sheet holds uncommitted text even when the field itself is blurred on iOS).
export interface SheetEdit { id: string; origTitle: string; origBody: string; isNew?: boolean; }
// A panel title/body editing session (outline mode edits in the right/left edit panel, not the
// full-screen sheet) — same shape as SheetEdit and the same contract: while set, persistence
// freezes the node's filename (rename lands on blur) and skips the focus-reload so live typing
// isn't clobbered.
export interface PanState { sx: number; sy: number; ox: number; oy: number; }
export interface Marquee { sx: number; sy: number; add: boolean; base: Set<string>; moved: boolean;
  // When a marquee is started from an unselected FRAME (drag inside it rubber-band-selects its
  // contents), a no-move click should SELECT that frame instead of deselecting — this holds its id.
  clickNode?: string | null; }
export interface Pinch { dist: number; cx: number; cy: number; }
// Safari-only pinch events (not in lib.dom): clientX/Y + a scale factor.
export interface GestureEvt extends Event { clientX: number; clientY: number; scale: number; }

export const ui = {
  // ---- node drag (features/drag.ts) ----
  drag: null as Drag | null,
  dragRAF: null as number | null,   // pending rAF for drag paint; coalesces moves per frame
  autoPanRAF: null as number | null,
  // ---- pan / zoom gestures (features/gestures.ts) ----
  pan: null as PanState | null,
  marquee: null as Marquee | null,
  spaceHeld: false,
  spaceUsedForPan: false,
  pinch: null as Pinch | null,                    // active two-finger gesture
  gestureStartK: 1,
  gestureMid: { x: 0, y: 0 } as Pt,
  // ---- in-place card editing (features/inline-edit.ts) ----
  // Either open defers the file rename / disk-reload while typing. A CARD gets `bodyEdit`: one field
  // holding its title and its note together. A CONTAINER gets `titleEdit`: its label alone (see above).
  // At most one of the two is ever set — each opener closes the other.
  bodyEdit: null as BodyEdit | null,
  titleEdit: null as TitleEdit | null,
  queryEdit: null as QueryEdit | null,
  // ---- full-screen editor sheet (features/editor-sheet.ts) ----
  sheetEdit: null as SheetEdit | null,
  // ---- panel title/body editing (outline mode; wired in main.ts) ----
  panelEdit: null as SheetEdit | null,
  // ---- sketch / freehand drawing (features/sketch.ts) ----
  sketchOn: false,                                // sketch mode active: canvas pointers draw, not select
  // A stroke (pen) or erase gesture in progress; gestures.ts checks its truthiness to route
  // single-pointer input to sketch.ts and to skip the disk-reload while mid-draw. The active
  // stroke/path themselves live in features/sketch.ts module scope.
  sketchDraw: null as { tool: 'pen' | 'eraser' } | null,
  // ---- animated relayout (main) ----
  animToken: 0,
  // ---- last known mouse position (window pointermove, main) ----
  // Lets keyboard/clipboard actions (Space-tap new card, paste) land AT the cursor; null until
  // the mouse first moves (touch never sets it) → callers fall back to the viewport centre.
  lastMouse: null as Pt | null,
};

// pointerId -> position, for the multi-touch gesture layer (a const Map, mutated in place).
export const gPointers = new Map<number, Pt>();

// ---- edit-session predicates (shared by persistence.ts) ----
// One source of truth for "is some editor holding uncommitted text", so the save loop and the
// disk-reload guard can't drift as editors are added (in-card title/body + the full-screen sheet).
export function editSessionActive(): boolean { return !!(ui.bodyEdit || ui.titleEdit || ui.sheetEdit || ui.panelEdit); }
// "Is an IN-PLACE editor open" — the two on-canvas sessions only (a card's one text field, a
// container's label), as against editSessionActive's four. Named here rather than spelled out as
// `ui.bodyEdit || ui.titleEdit` at each of its call sites — the render core, drag's tap/pointerdown
// bails, the float bar's busy test, a canvas tap — because that pair is exactly what had to be found
// and rewritten by hand when the single inlineEdit session split in two.
export function inPlaceEditActive(): boolean { return !!(ui.bodyEdit || ui.titleEdit); }
// …and the same question about ONE node: is this the card/label currently being typed into.
export function inPlaceEditOn(id: string): boolean {
  return ui.bodyEdit?.id === id || ui.titleEdit?.id === id;
}
// The node whose filename must stay frozen while its title is being typed (the rename lands on
// commit, so the folder isn't littered with M.md, Ma.md, Mag.md…). The in-card editor is IN here now:
// it used to be excluded because a body edit couldn't touch the title, and now the title is the first
// line of the very text it holds. null → nothing frozen. Every arm names its OWN node, so the
// selection has nothing to say about it.
export function frozenFileNodeId(): string | null {
  if (ui.bodyEdit) return ui.bodyEdit.id;
  if (ui.titleEdit) return ui.titleEdit.id;
  if (ui.sheetEdit) return ui.sheetEdit.id;
  if (ui.panelEdit) return ui.panelEdit.id;
  return null;
}

// ---- responsive mode predicates ----
// 700px MUST match the `@media (max-width:700px)` breakpoint in styles.css (bottom-sheet panel).
export const NARROW_MQ = matchMedia('(max-width: 700px)');
const COARSE_MQ = matchMedia('(pointer: coarse)');
// "Phone" = coarse pointer AND narrow screen. Deliberately AND, not OR: an iPad is coarse but
// wide (inline editing works there), and a narrow desktop window keeps its fine pointer. On a
// phone all title/body editing routes to the full-screen editor sheet instead of the in-card
// editors (see features/inline-edit.ts).
export function phoneMode(): boolean { return COARSE_MQ.matches && NARROW_MQ.matches; }

// "Phone", orientation-independent (features/outline.ts's canvas/outline split): coarse pointer
// AND a SHORT axis — either dimension at or under the 700px breakpoint, so an iPhone reads as a
// phone in both portrait AND landscape (it's still short sideways), while a tablet (large in both
// dimensions) or a narrowed desktop window (fine pointer) stay excluded. The two `max-*` clauses
// MUST match NARROW_MQ's own 700px breakpoint.
export const PHONE_MQ = matchMedia(
  '(pointer: coarse) and (max-width: 700px), (pointer: coarse) and (max-height: 700px)'
);
export const PORTRAIT_MQ = matchMedia('(orientation: portrait)');

// True when focus is in a text field (sidebar input/textarea) or a contenteditable (the in-card
// title rename) — i.e. the user is typing, so card/canvas shortcuts and disk-reload should stand down.
export function isTypingInField(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(a?.tagName ?? '') || !!a?.isContentEditable;
}
