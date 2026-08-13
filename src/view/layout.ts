// ---------- node layout: per-node free/line/fan ----------
// Computes node x/y. applyLayouts re-flows every node per
// its own type/layout after any change. The node itself stays put — only its children (and
// their subtrees) move. A child's SIDE (left/right/up/down) is STORED (MindNode.side, mm_side
// in frontmatter) — set explicitly by a drop, or backfilled once from position (see sideOf/
// deriveSide below) on load or first use, but never re-derived afterward. That avoids a fan's
// own placement (spreading same-side siblings wide) ever flipping a child's side purely as a
// side effect of laying it out. layoutH/NODE_W/subtreeIds come from main (render + tree
// helpers) — a runtime-only cycle.
import { state, isAnnotation, isLeafType, type MindNode, type LayoutSide } from '../core/state.js';
import type { Seg } from '../core/ui-state.js';
import { childrenOf, isHidden, isRoot, parentOf, ancestors } from '../utils/model.js';
import { isScopeRoot, pruneScope, scopeRect, scopeRootNode } from '../nav/scope.js';
import { subtreeIds, layoutH, nodeH, nodeW, NODE_W, gridSnap, paintNode, elTop, frameLabelW, FRAME_BORDER, FRAME_TAB_H, FRAME_TAB_DROP, STACK_HEADER, STACK_PAD, STACK_GAP } from '../main.js';
import { clamp } from '../utils/num.js';

// ---------- absolute <-> relative position ----------
// Two forms of a node's position: the WORKING form x/y (absolute world coords, what the layout
// and drag engines read and mutate) and the PERSISTED form rx/ry (offset from the parent, world
// origin for a root — what serializeMd writes as mm_position_x/y). commitRel() derives the
// persisted form from the working form; it's the only bridge, called just before every save
// (saveAll / exportZip). Load does the reverse — see data/persistence.ts loadFromDir.
// A node's persisted position is an OFFSET from its parent, so moving the PARENT restales every
// child's file even though nothing about the child moved on screen — dragging a frame's west edge
// (which shifts the frame's own x), or undoing such a resize, leaves each child's mm_position_x on
// disk describing the OLD offset. saveAll only writes nodes flagged dirty, so those files were
// silently skipped and the next load placed the children at the stale offset. Catching it here, in
// the one bridge every save goes through, covers every mover (resize, undo/redo, layout, drag)
// instead of asking each of them to remember. Compared ROUNDED, since that's what serializeMd
// writes — raw float noise would otherwise mark every node dirty on every save.
export function commitRel(): void {
  for (const n of state.nodes.values()) {
    const p = parentOf(n);
    const rx = n.x - (p ? p.x : 0), ry = n.y - (p ? p.y : 0);
    if (Math.round(rx) !== Math.round(n.rx) || Math.round(ry) !== Math.round(n.ry)) n.dirty = true;
    n.rx = rx; n.ry = ry;
  }
}

const LANDING_GAP = 40;   // gap below/beside the hovered card a drag-reparented child/sibling snaps to
// Where `dragged` will land if dropped onto `target` in the given mode — CHILD (edge zone of the
// card, attaching on whichever side the drop point is near) or SIBLING (centre zone, adopts
// target's parent and lands on target's side). Shared by the drop-target ghost preview
// (features/drag.ts) and the actual reparent commit, so what you see while dragging is exactly
// where the card ends up.
//
// The governing layout is TARGET's own (child mode) or TARGET's PARENT's (sibling mode) — note
// both cases resolve to the same node `dragged` would actually be re-parented onto. SIBLING mode
// also anchors the insertion: the dragged card slots in right after `target` in the governor's
// child order (not at the end), so dropping near the middle of a card among several siblings
// inserts it there, matching the centre-zone hover that triggered sibling mode in the first place.
//
// For a managed layout (line/fan) the only way to know the EXACT final spot is to run the real
// layout: applying it would also reflow target's other children (a fan re-centers, a chain
// re-packs), so a simple "just outside target's border" estimate drifts once there's more than
// one sibling on that side. So we temporarily re-parent `dragged` onto the governor (with `side`
// set — the drop resolved it, see drag.ts updateDropTarget) at the anchored order position, run
// the same layoutSubtree() the commit path uses, read off where it placed `dragged`, then revert
// every position/order/parent/side change — a dry run, no visible side effect. A free/unset
// governing layout never reflows on drop, so the cheap geometric estimate is exact there and a
// simulation would be wasted work (though `side` is still what the caller stores on commit).
// REORDER mode (in-parent, no hovered card): `target` IS dragged's current parent — always a
// line/fan governor (the caller checks), so it always takes the simulation path below.
// `afterId` is the explicit insertion anchor when the caller resolved one (`null` = front of
// the order, `undefined` = default: after `target` in sibling mode, append in child mode).
export function dropLanding(dragged: MindNode, target: MindNode, mode: 'child' | 'sibling' | 'reorder', side: LayoutSide, afterId?: string | null): { x: number; y: number } {
  const governor = mode === 'child' || mode === 'reorder' ? target : parentOf(target) ?? target;
  // Landing inside a stack's outliner: a row is `free` (the stack owns every position), so there's no
  // managed simulation to run — put it one indent under the governing row, below its current subtree.
  // Only an interim value: the drop commits, then applyLayouts re-runs the outline and owns the
  // final position. (When the governor IS the stack it's managed, so it simulates properly below.)
  {
    const h = hostFrame(governor);
    if (h && isStack(h)) return { x: governor.x + STACK_INDENT, y: subtreeBox(governor).y1 + STACK_GAP };
  }
  // A frame adopts the card where it's released, snapped to the grid RELATIVE to the frame's
  // origin (its children live in the frame's coordinate space) — containerBox, so a docked tab
  // snaps against the box its group lent it rather than its own label in the strip.
  if (isFrame(governor)) {
    const g = gridSnap();
    const box = containerBox(governor);
    const rel = (v: number, o: number): number => Math.round((v - o) / g) * g + o;
    return { x: rel(dragged.x, box.x), y: rel(dragged.y, box.y) };
  }
  if (!isManagedLayout(governor)) {
    // Nudge the cross-axis in child mode (a fresh attachment, offset from target) but keep it
    // aligned with target in sibling mode (it's slotting into target's own spot). `side` is the
    // side of TARGET the card is docking against — same geometry regardless of which side that is.
    const nudge = mode === 'child' ? LANDING_GAP : 0;
    switch (side) {
      case 'up':    return { x: target.x + nudge, y: target.y - nodeH(dragged) - LANDING_GAP };
      case 'left':  return { x: target.x - nodeW(dragged) - LANDING_GAP, y: target.y + nudge };
      case 'right': return { x: target.x + nodeW(target) + LANDING_GAP, y: target.y + nudge };
      default:      return { x: target.x + nudge, y: target.y + nodeH(target) + LANDING_GAP };
    }
  }
  return simulateLanding(dragged, governor, side, afterId !== undefined ? afterId : (mode === 'sibling' ? target.id : undefined));
}

// The order `governor`'s children would have if `draggedId` were inserted right after `afterId`
// (`null` = at the FRONT of the order; omitted/not a current child = appended at the end) —
// everyone else keeps their existing relative order. Shared by the ghost-preview dry run and the
// real reparent commit so both agree on where a sibling/reorder drop slots in. (Front-of-order is
// also front of dragged's own side bucket, since bucketing preserves the global relative order.)
export function insertedKidOrder(governor: MindNode, draggedId: string, afterId?: string | null): string[] {
  const kids = childrenOf(governor.id).filter(k => !isHidden(k) && k.id !== draggedId);
  const order = orderedKids(governor, kids).map(k => k.id);
  if (afterId === null) { order.unshift(draggedId); return order; }
  const idx = afterId ? order.indexOf(afterId) : -1;
  if (idx >= 0) order.splice(idx + 1, 0, draggedId);
  else order.push(draggedId);
  return order;
}

// Dry-run a reparent of `dragged` onto `governor` (inserted right after `afterId`, if given) with
// `side` set (so bucketing sees the drop's resolved side, not whatever `dragged` had before): re-
// parent, run the real layoutSubtree(), capture dragged's resulting position, then put every
// touched node/field back exactly as found.
function simulateLanding(dragged: MindNode, governor: MindNode, side: LayoutSide, afterId?: string | null): { x: number; y: number } {
  const prevParent = dragged.parent;
  const prevSide = dragged.side;
  const prevKidOrder = governor.kidOrder ? [...governor.kidOrder] : undefined;
  const snapIds = new Set<string>();
  for (const k of childrenOf(governor.id)) if (k.id !== dragged.id) for (const id of subtreeIds(k.id)) snapIds.add(id);
  for (const id of subtreeIds(dragged.id)) snapIds.add(id);
  const snap = new Map([...snapIds].map(id => {
    const n = state.nodes.get(id)!; return [id, { x: n.x, y: n.y }] as [string, { x: number; y: number }];
  }));

  governor.kidOrder = insertedKidOrder(governor, dragged.id, afterId);
  dragged.parent = governor.id;
  dragged.side = side;
  layoutSubtree(governor);
  const land = { x: dragged.x, y: dragged.y };

  dragged.parent = prevParent;
  dragged.side = prevSide;
  governor.kidOrder = prevKidOrder;
  for (const [id, p] of snap) { const n = state.nodes.get(id); if (n) { n.x = p.x; n.y = p.y; } }
  return land;
}

// ---------- per-node layout (free / line / fan) ----------
// Every node carries its own layout that decides how its CHILDREN sit relative to it:
//   · free — children keep wherever they're dragged (the default; direction ignored)
//   · line — children chained one after another ALONG the direction (e.g. a column going down)
//   · fan  — children spread ACROSS the direction at one distance (the classic mindmap branch)
// `layoutDir` (left/right/top/bottom) picks the side. Line/fan nodes OWN their children's
// positions, so layout re-runs after every structural or drag change (there's no manual Tidy).
const LAYOUT_MAIN  = 60;   // gap between a card and its children along the growth axis
const LAYOUT_CROSS = 22;   // gap between FANNED sibling subtrees (spread across the side)
// gap between CHAINED sibling subtrees (a line along the direction) — must clear a card's own
// tag row, which floats OUTSIDE the card's border and overhangs ~11px past its bottom edge (see
// .node .tag-row in styles.css): anything tighter and the next chained card's opaque background
// paints over the previous card's tag pills/add-emoji button, hiding them even though they're
// still very much in the DOM and clickable.
const LAYOUT_CHAIN = 22;
// Both are multiples of GRID_SNAP so flowed content stays grid-aligned: the frame's own x/y/w/h
// are already grid multiples (position/resize snap), and every child's w/h is too (NODE_W=200,
// heights rounded up to the grid in main.ts's snapCardHeights) — so keeping these constants (and
// the flow gap below) grid multiples means every computed cx/cy stays on the grid, with no
// runtime rounding needed.
const FRAME_PAD = 20;       // inset from a frame's border to its content area (flow arrange)
const FRAME_FLOW_GAP = 20;  // gap between flowed children — GRID_SNAP, not the line/fan LAYOUT_CHAIN
// Cross-axis tolerance for clustering a flow frame's children into rows/columns when (re)seeding
// order from raw position (kidsByPosition) — roughly half a default card's row pitch (40 height +
// 20 gap), so a genuinely different row/column always exceeds it while hand-placed jitter within
// an intended row doesn't fracture into singleton bands.
const FLOW_BAND_TOL = 30;
// Stack outliner: per-depth indent for a stack's descendant rows, and the smallest a deeply-indented
// row is ever squeezed to (so a deep outline never collapses to zero width).
const STACK_INDENT = 18;
const STACK_MIN_ROW_W = 90;
// Gap between two tabs in a group's strip. It was zero back when every tab carried a border and the two
// 2px rims met as the divider between them; an inactive tab is now fill-only (see the frame section in
// CLAUDE.md), so flush tabs would run their soft patches into one continuous band. A thin gap is what
// divides them instead — small enough that they still read as sheets in one folder rather than separate
// pills. A term in three places (tabSlots, tabDropTarget, the dock ghost); the insertion bar lands in the
// middle of the gap (`+ TAB_GAP / 2`).
export const TAB_GAP = 4;

// Bounding box over a node + its VISIBLE descendants (what the layout actually placed).
export function subtreeBox(node: MindNode){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // Union the visible subtree's boxes — but a FRAME is bounded by its OWN box (mm_w/mm_h): its
  // children live INSIDE it, so we count the frame's box and DON'T descend into its content.
  // Otherwise a fan/line/grid parent would size a frame child by its content and re-space it (and
  // shift the frame's children with it) whenever the frame is expanded or its content changes.
  const walk = (n: MindNode): void => {
    // annotations don't contribute to layout — they float on top and are sized/placed on their own,
    // so a fan/line parent or a frame's auto-fit must not count their extent.
    if (isHidden(n) || isAnnotation(n)) return;
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + nodeW(n)); y1 = Math.max(y1, n.y + layoutH(n));
    if (isContainer(n)) return;   // a frame/stack footprint = its own box; its children are contained within it
    for (const c of childrenOf(n.id)) walk(c);
  };
  walk(node);
  return { x0, y0, x1, y1 };
}
// A node whose children live freely inside a resizable container box (mm_w/mm_h). Unlike free, it
// draws that box (see main.ts paintNode) and adopts cards dropped inside / detaches cards dragged
// out (see features/drag.ts). Its children aren't repositioned by layout (they stay where placed).
// A COLLAPSED frame folds to an ordinary card (children hidden), so it isn't a frame while folded —
// its footprint and behaviour revert to a normal card, matching how it renders.
export function isFrame(node: MindNode): boolean { return node.type === 'frame' && !node.collapsed; }
// Is there a stack in this node's ancestry, with only card ancestors in between (a frame/image/query
// re-scopes and stops the search)? Uses the RAW `type` field so it never recurses through isStack.
// A stack that lives inside another stack is DEMOTED to a plain outline row: the outer stack outlines
// the whole subtree (all descendant layouts ignored), so a nested stack isn't a box of its own — it's
// just another indented node. The stack test comes FIRST: a stack ancestor's own type isn't 'card', so
// checking the re-scope condition before it would bail out before ever spotting the stack.
function insideStack(node: MindNode): boolean {
  for (let p = parentOf(node); p; p = parentOf(p)) {
    if (p.type === 'stack') return !p.collapsed;      // an expanded stack governs; folded, it hides us anyway
    if (p.type !== 'card') return false;              // a frame/image/query ancestor re-scopes
  }
  return false;
}
// A STACK: a node kind that frames its whole subtree as an OUTLINER (one full-width column, each
// level indented) inside an auto-sized, non-resizable box. Like a frame, it's a CONTAINER — its
// descendants live in its coordinate space, clip to its interior, and detach by leaving its bounds.
// A COLLAPSED stack folds to an ordinary card (children hidden), so it isn't a container while folded.
// A stack INSIDE another stack is demoted (insideStack) to a plain outline row — the outer stack owns
// the whole subtree and ignores every descendant's own arrangement.
export function isStack(node: MindNode): boolean {
  return node.type === 'stack' && !node.collapsed && !insideStack(node);
}
// ---------- tab groups: a frame whose child FRAMES are docked as tabs ----------
// A TABS frame (mm_layout: tabs): its child frames aren't content, they're TABS. Their title tabs
// flow along this frame's own top band (tabStripRect) and whichever tab is OPEN borrows the whole
// box for its children — so the group owns the geometry (x/y/w/h, colour, resize handles, border)
// and a tab owns only its contents. Keyed on the RAW type + layout rather than isFrame, so
// collapsing the group can't flip a hosted tab's identity mid-paint (same caution as frameInsetY).
export function isTabsFrame(node: MindNode): boolean { return node.type === 'frame' && node.layout === 'tabs'; }
// The group `node` is docked into as a tab, or null. A tab is always a FRAME child of a tabs frame:
// any other child kind is ordinary content (e.g. a card dropped into the box), never a tab.
export function tabGroupOf(node: MindNode): MindNode | null {
  if (node.type !== 'frame') return null;
  const p = parentOf(node);
  return p && isTabsFrame(p) ? p : null;
}
export function isDockedTab(node: MindNode): boolean { return !!tabGroupOf(node); }
// A group's tabs in strip order (left to right) — stored like any child order, i.e. seeded from the
// tabs' own positions along the strip (kidsByPosition) and only changed by dragging one.
export function tabsOf(g: MindNode): MindNode[] {
  return orderedKids(g, childrenOf(g.id).filter(k => k.type === 'frame'));
}
// The one OPEN tab. Exactly one tab is open at a time (normalizeTabs), which is what lets a tab
// reuse the plain collapse machinery: an open tab is an expanded frame that happens to render as
// just its label, a closed one is a folded frame, and a closed tab's contents hide themselves
// (isHidden — an ancestor is collapsed). No `mm_active` key, no second notion of visibility.
export function activeTab(g: MindNode): MindNode | null {
  return tabsOf(g).find(t => !t.collapsed) ?? null;
}
// What can be dropped on a frame's tab to become a tab of it. A frame already is one; a plain CARD is
// turned into a frame on the way in (crud.ts dockFrames), since that's what a tab is. The other kinds
// keep out: an annotation is a note pinned on top of something else and holds nothing, a stack's whole
// nature is its outliner box, and an image/query card is a leaf whose box IS its content.
export function canBeTab(n: MindNode): boolean { return n.type === 'frame' || n.type === 'card'; }
// The node a user-facing action on `n` should actually hit. A tab group doesn't exist from the outside:
// what you see, colour, rename or delete is the OPEN TAB, so those land there. The box-shaped actions
// stay on the group, because the box is the one thing it visibly owns — moving it, resizing it, its
// kind/layout (which is how you leave tabs mode) and its lock, all of which apply to every tab at once.
export function actionTarget(n: MindNode): MindNode {
  return isTabsFrame(n) && !n.collapsed ? (activeTab(n) ?? n) : n;
}
// Enforce "exactly one open tab" — the single invariant this feature adds. Run as a pre-pass in
// applyLayouts so every path that could break it (a tab click, collapse-all, expand-all, a
// hand-edited vault with none or three tabs open) is covered by ONE funnel instead of each having to
// remember. Marks what it changes dirty, so a vault that disagreed is healed on disk too.
export function normalizeTabs(g: MindNode): void {
  const tabs = tabsOf(g);
  if (!tabs.length) return;
  const keep = tabs.find(t => !t.collapsed) ?? tabs[0];   // first open wins; none open → open the first
  for (const t of tabs) {
    const want = t !== keep;
    if (t.collapsed !== want) { t.collapsed = want; t.dirty = true; t.dirtyLayout = true; }
  }
}
// The box a container actually holds its children in. Its own bounds for everything else — but a
// DOCKED TAB has no box: its bounds are just its label up in the strip, and its contents live in the
// interior its group lent it. The single spelling of that indirection, shared by frameInterior, the
// flow layout, the drop landing and the in-frame/out-of-frame rip test, so none of them has to know
// whether the frame it's given is docked.
export function containerBox(f: MindNode): { x: number; y: number; w: number; h: number } {
  // …or whether it's the OPEN one (nav/scope.ts), whose box is the VIEWPORT — that's what gives its
  // contents the whole window instead of a rectangle on the canvas. A DERIVED override: f.w/f.h are
  // neither read nor written here, which is what lets the frame come back out at its authored size.
  // Checked before the docked branch, or an open TAB would keep the interior its group lent it.
  if (isScopeRoot(f)) return scopeRect();
  const g = tabGroupOf(f);
  if (g) return frameInterior(g);
  return { x: f.x, y: f.y, w: nodeW(f), h: nodeH(f) };
}
// Where a group lays its tabs out: the band across the top of its BOUNDS — exactly where its own
// title tab hangs (styles.css `.node.frame > .title-row`), since the tabs are that tab's siblings in
// the same band. A DOCKED group has no band above it (it's a tab itself), so its strip takes the top
// of the interior it was lent instead; frameInterior reserves that room (see below).
export function tabStripRect(g: MindNode): { x: number; y: number; w: number; h: number } {
  const box = containerBox(g);
  return { x: box.x, y: box.y, w: box.w, h: FRAME_TAB_H };
}
// Where each tab sits along its group's strip, plus `next` — the slot PAST the last tab, where a newly
// docked one lands. The single spelling of the strip's arithmetic: the layout pass places tabs from it
// and the dock preview draws its ghost tab at `next`, so the preview can't disagree with the result.
// Reads measured label widths (frameLabelW), so callers must have painted the tabs first.
export function tabSlots(g: MindNode): { xs: number[]; next: number } {
  const strip = tabStripRect(g);
  // From the very left of the band: a group with tabs shows no tab of its own (styles.css
  // `.tabs.has-tabs > .title-row`), so there's nothing to start past — two docked frames must read as
  // two tabs, not three.
  let cx = strip.x;
  const xs: number[] = [];
  for (const t of tabsOf(g)) { xs.push(cx); cx += nodeW(t) + TAB_GAP; }
  return { xs, next: cx };
}
// Where a frame dropped on a group's strip slots in: the tab it lands AFTER (`null` = first), plus the
// insertion bar to draw in that gap. The strip's analogue of flowReorderTarget — one row of tabs, so
// it's a plain midpoint comparison along x, and dragging a tab sideways past its neighbour re-slots it.
// `skip` drops the dragged frames from the ordering, so a tab can't anchor against itself.
export function tabDropTarget(g: MindNode, wx: number, skip: Set<string>): { afterId: string | null; line: Seg } {
  const strip = tabStripRect(g);
  const tabs = tabsOf(g).filter(t => !skip.has(t.id));
  let afterId: string | null = null;
  let pos = strip.x;                      // the front slot, at the strip's left edge
  for (const t of tabs) {
    if (wx < t.x + nodeW(t) / 2) break;   // left of this tab's middle → it goes in front of it
    afterId = t.id; pos = t.x + nodeW(t) + TAB_GAP / 2;
  }
  return { afterId, line: { x0: pos, y0: strip.y, x1: pos, y1: strip.y + strip.h } };
}
// The band that counts as "on this frame's tab" — the DOCK zone, i.e. what a dragged frame has to be
// released over to become a tab of it. For a plain frame that's its own folder tab (its label in the
// top band of its bounds); for a GROUP it's the whole strip, so anywhere along the row of tabs docks.
export function tabBandRect(f: MindNode): { x: number; y: number; w: number; h: number } {
  if (isTabsFrame(f) && !f.collapsed) return tabStripRect(f);
  return { x: f.x, y: f.y, w: frameLabelW(f), h: FRAME_TAB_H };
}
// Either kind of child-containing box: a frame or a stack. Used at every touchpoint where the box
// behaves purely as "a container that holds & clips its children" (footprint, hosting, edge
// clipping, drag adopt/detach) — as opposed to frame-only behaviour (resize, free/flow placement).
export function isContainer(node: MindNode): boolean { return isFrame(node) || isStack(node); }
// The width an outline ROW is stretched to inside its stack, or null if this node isn't one. DERIVED,
// never stored: it's a pure function of the stack's own width and the row's indent depth — the same
// two inputs layoutSubtree's stack branch uses — so keeping it as a function is what stops a row's
// transient width from colliding with the AUTHORED `n.w` a card carries in from outside the stack
// (drop a 400px card into a stack and it must come back out at 400px, not at the row width). Mirrors
// the stack branch's own arithmetic; the two must agree, which is why they read the same constants.
export function stackRowW(node: MindNode): number | null {
  if (isAnnotation(node)) return null;   // stackOutline skips annotations — they float, they don't stack
  let depth = 0;
  for (let p = parentOf(node); p; p = parentOf(p)) {
    // isStack(p), not p.type — a stack nested in another stack is itself just a row of the outer one
    if (isStack(p)) return Math.max(STACK_MIN_ROW_W, stackInnerW(p) - depth * STACK_INDENT);
    if (isContainer(p) || p.collapsed) return null;   // a nearer frame governs, or we're folded away
    depth++;
  }
  return null;
}
// A stack's INNER width — its box less the border and padding on both sides. Row 0 spans all of it.
function stackInnerW(stack: MindNode): number { return nodeW(stack) - 2 * FRAME_BORDER - 2 * STACK_PAD; }
// The height a stack reserves above its first row for its OWN title-row — measured live, so a
// multi-line title pushes the rows down instead of being drawn over (STACK_HEADER is the pre-render
// fallback). Shared by the layout pass and the drop resolver so both agree where row 0 starts.
// Measures the title ROW *and* the BODY, because a stack's header is now its own rendered text (the row
// holds only the fold chip and the done checkbox, and collapses to nothing without them). `:scope >` on
// both: a stack's rows are cards with a .title-row and a .body of their own, and although they live in a
// sibling wrapper rather than inside the stack's element, an unscoped query here would be one refactor
// away from measuring a row's header instead of the stack's.
function stackHeaderH(stack: MindNode): number {
  const el = stack.el;
  const part = (sel: string): number =>
    (el?.querySelector(sel) as HTMLElement | null)?.offsetHeight ?? 0;
  const h = part(':scope > .title-row') + part(':scope > .body');
  return h ? FRAME_BORDER + STACK_PAD + h + STACK_GAP : STACK_HEADER;
}
// Size an EMPTY stack: its own title row, inset equally all round. The height is the zero-row
// reduction of the `node.h = …` line that closes the stack branch in layoutSubtree (with no rows, cy
// is just ay + stackHeaderH) — the two must stay in step. It can't be a constant: a stack's title
// WRAPS (unlike a frame's single-line tab), so a two-line title needs the measurement — hence paint
// first, then measure, the same rule the row loop below follows. That's exactly what went wrong
// before — a childless stack never reached the branch at all (layoutSubtree returns early with no
// children), so it kept nodeH's STACK_HEADER + STACK_PAD fallback and a wrapped title overflowed its
// box by the extra lines. Both empty paths (no children at all / no visible rows) call this.
function sizeEmptyStack(stack: MindNode): void {
  paintNode(stack);
  stack.h = stackHeaderH(stack) - STACK_GAP + STACK_PAD + FRAME_BORDER;
}
// NOTE — the two loops below call paintNode(k) BEFORE measuring the row, and must keep doing so: a
// stack is the one place where a card's height depends on layout output, in two ways.
//   · WIDTH — a row is stretched to the width its depth allows (stackRowW, which paintNode applies),
//     and text wraps differently at a different width. Measuring before the DOM knew the new width
//     laid a re-indented row out at its PREVIOUS width's height, so the rows below overlapped.
//   · EXISTENCE — a row added this tick has no element yet, and layoutH then falls back to 64px. A
//     fresh 27px row reserved 64, leaving a 45px hole under it (paintNode creates the element via
//     nodeEl, so painting there is also what makes it measurable at all).
// Either way the geometry used to settle only when some later interaction happened to run another
// pass. Painting first means one applyLayouts() converges regardless of the order a caller paints
// and lays out in — which matters because the ~20 relayout call sites don't agree on that order.
// paintNode leaves an open title/body/query editor alone, so this can't disturb typing.
// A stack's visible OUTLINE, in visual (top-to-bottom) order: every descendant that gets its own row,
// paired with the indent depth it renders at (the stack's direct children are depth 0). A nested
// container or a COLLAPSED card is one opaque row — its contents live in its own box/fold — so the
// walk doesn't descend into it. `skip` drops a whole subtree from the walk (the dragged cards, which
// must never act as their own drop anchors). The single source of "what rows does this stack show, in
// what order, at what depth" — shared by layoutSubtree and stackDropTarget.
export function stackOutline(stack: MindNode, skip?: Set<string>): { node: MindNode; depth: number }[] {
  const out: { node: MindNode; depth: number }[] = [];
  const walk = (parent: MindNode, depth: number): void => {
    const kids = childrenOf(parent.id).filter(k => !isHidden(k) && !isAnnotation(k) && !skip?.has(k.id));
    for (const k of orderedKids(parent, kids)) {
      out.push({ node: k, depth });
      if (!isContainer(k) && !k.collapsed) walk(k, depth + 1);
    }
  };
  walk(stack, 0);
  return out;
}
// Where a card dragged over a stack would land, resolved the way an OUTLINER does — the two axes
// carry different meaning, which is what makes one gesture do both reorder and re-nest:
//   · VERTICAL picks the GAP between two rows (never "onto" a row), so dragging straight down only
//     ever re-slots — it can't accidentally reparent, and the indicator always sits BETWEEN cards.
//   · HORIZONTAL picks the DEPTH at that gap, clamped to what the gap can legally express: at most
//     one level deeper than the row above (become its first child), at least the depth of the row
//     below (a gap can't outdent past a branch that continues underneath it). So nesting is a
//     deliberate sideways nudge of the card, exactly like indenting a line in an outline editor.
// Returns the resolved parent + insertion anchor (`afterId`, null = first child) and the indicator
// segment, drawn in the CURRENT gap and indented to the resolved depth so the preview shows the
// nesting the drop will produce. `skip` = the dragged subtree (see stackOutline).
export function stackDropTarget(stack: MindNode, dragged: MindNode, skip: Set<string>):
    { parentId: string; afterId: string | null; line: Seg; depth: number } {
  const rows = stackOutline(stack, skip);
  const innerLeft = stack.x + FRAME_BORDER + STACK_PAD;
  const innerRight = stack.x + nodeW(stack) - FRAME_BORDER - STACK_PAD;
  const midOf = (n: MindNode) => n.y + nodeH(n) / 2, botOf = (n: MindNode) => n.y + nodeH(n);
  // 1) the gap: how many rows sit above the dragged card's own midpoint
  const mid = dragged.y + nodeH(dragged) / 2;
  let i = 0;
  while (i < rows.length && midOf(rows[i].node) < mid) i++;
  const prev = i > 0 ? rows[i - 1] : null, next = rows[i] ?? null;
  // 2) the depth at that gap, from the dragged card's left edge. A leaf can't adopt children, so it
  //    never offers the deeper slot.
  const maxDepth = prev ? prev.depth + (isLeafType(prev.node) ? 0 : 1) : 0;
  const minDepth = next ? next.depth : 0;
  const depth = clamp(Math.round((dragged.x - innerLeft) / STACK_INDENT), minDepth, maxDepth);
  // 3) parent + anchor: one level deeper means "first child of the row above"; otherwise walk up from
  //    that row to the ancestor sitting AT this depth and slot in right after it.
  let parentId = stack.id, afterId: string | null = null;
  if (prev) {
    if (depth === prev.depth + 1) parentId = prev.node.id;
    else {
      let a = prev.node;
      for (let d = prev.depth; d > depth; d--) a = state.nodes.get(a.parent!) ?? a;
      parentId = a.parent ?? stack.id; afterId = a.id;
    }
  }
  // 4) the indicator, centred in the gap as it stands right now
  const y = prev && next ? (botOf(prev.node) + next.node.y) / 2
          : prev ? botOf(prev.node) + STACK_GAP / 2
          : next ? next.node.y - STACK_GAP / 2
          : stack.y + stackHeaderH(stack);
  return { parentId, afterId, line: { x0: innerLeft + depth * STACK_INDENT, y0: y, x1: innerRight, y1: y }, depth };
}
// Does this node live inside a frame (any frame ancestor)? Such nodes are positioned in the
// frame's coordinate space, so they must track the frame even while HIDDEN — else a collapsed
// frame moved by its own parent's layout leaves its (hidden, free) children behind, and they
// reappear misplaced on expand. Uses `type` (not isFrame) so a COLLAPSED frame still counts.
function insideFrame(node: MindNode): boolean {
  for (const p of ancestors(node)) if (p.type === 'frame') return true;
  return false;
}
// The nearest ANCESTOR frame actually hosting `node` right now — walking PAST non-frame ancestors
// (a grandchild inherits its parent's host), so it's the frame whose content wrapper `node`'s
// element lives inside, DOM-wise (main.ts frameContentEl/place). Unlike insideFrame this only
// counts EXPANDED frames (isFrame, not just type==='frame'), matching what actually renders a wrapper —
// a collapsed frame has no box/wrapper, so it can't host anything. Shared with edges.ts so an edge
// between two cards inside the same frame clips to it too, not just the cards themselves.
export function hostFrame(node: MindNode): MindNode | null {
  const h = containerHost(node);
  // The OPEN frame hosts NOTHING: its children are the top level now, so they go straight under
  // #world, unclipped, and the wrapper it would otherwise own is dropped by paintNode. That's what
  // makes "the frame's box isn't there any more" true of the DOM and not just of the paint — and
  // edges.ts shares this walk, so their connectors stop clipping to it in step.
  return h && isScopeRoot(h) ? null : h;
}
// …and the same walk WITHOUT that exception: the nearest container ancestor by TREE, wherever the
// node's element actually ended up. The two questions were one until a frame could be OPENED, and
// then they came apart: `hostFrame` answers "whose wrapper is my element inside" (a DOM fact, and the
// open frame has no wrapper), while this answers "whose fill do I sit on and step off" (a TONE fact,
// which the open frame still governs — more than ever, since the canvas now wears its colour). Used
// by main.ts's inStack/inFrame for exactly that.
export function containerHost(node: MindNode): MindNode | null {
  if (isAnnotation(node)) return null;   // annotations render on top, under #world — never hosted/clipped by a frame
  for (let p = parentOf(node); p; p = parentOf(p))
    if (isContainer(p)) return p;   // a frame OR a stack hosts/clips its children's elements + edges
  return null;
}
// How many ancestors `node` has (0 for a root). Used to pick the INNERMOST of several nested,
// overlapping frames — shared by drag.ts's pointerdown retarget (innermostFrameAt) and its
// pointer-hover hit-test (updateDropTarget), which both need "deepest wins" among frame hits.
export function ancestorDepth(node: MindNode): number {
  let d = 0;
  for (let p = parentOf(node); p; p = parentOf(p)) d++;
  return d;
}
// A frame's INTERIOR rect (absolute world coords, inside its border) — the single source of truth
// for "where does this frame's content go". Shared by main.ts's frameContentEl (the real DOM
// containment wrapper) and edges.ts's frameClipDefs (the SVG clip-path for edges/backgrounds,
// which can't be DOM-reparented into that wrapper) so the two containment mechanisms stay
// pixel-identical by construction instead of by two hand-synced copies of the same arithmetic.
export function frameInterior(f: MindNode): { x: number; y: number; w: number; h: number } {
  // The OPEN frame's interior IS the viewport, with no border and no tab to inset from. Spelled here
  // as well as in containerBox because a non-docked frame doesn't route through it — this function is
  // the one every hosted child, wrapper and edge clip-path reads.
  if (isScopeRoot(f)) return scopeRect();
  // A DOCKED TAB draws no box of its own — its group lends it the whole interior, which is the point
  // of docking (one box, several tabs). It reserves room at the top only when it is ITSELF a group:
  // a top-level group's strip hangs in the band above its box, but a docked one has nothing above it,
  // so its own tabs have to come off the interior it was lent.
  const g = tabGroupOf(f);
  if (g) {
    const lent = frameInterior(g);
    const strip = isTabsFrame(f) ? FRAME_TAB_H : 0;
    return { x: lent.x, y: lent.y + strip, w: lent.w, h: Math.max(0, lent.h - strip) };
  }
  return {
    x: f.x + FRAME_BORDER, y: f.y + frameInsetY(f),
    w: Math.max(0, nodeW(f) - FRAME_BORDER * 2),
    h: Math.max(0, nodeH(f) - frameInsetY(f) - FRAME_BORDER),
  };
}
// How far DOWN from a container's BOUNDS top its interior starts — the vertical counterpart of the
// plain FRAME_BORDER inset used on the other three sides, and the single spelling of it: shared by
// frameInterior and by everything that projects a hosted child into its host's content wrapper
// (main.ts's place/frameContentEl/followEdges). A FRAME's bounds also cover its title tab, which sits
// above the box (FRAME_TAB_DROP, main.ts); a stack has no tab. Keyed on `type`, not isFrame, so a paint
// landing mid-collapse can't flip the inset under a hosted child.
export function frameInsetY(f: MindNode): number {
  return FRAME_BORDER + (f.type === 'frame' ? FRAME_TAB_DROP : 0);
}
// Where a frame's content starts VERTICALLY: one uniform pad below its BOX's top edge (elTop), matching
// the `ax + FRAME_PAD` the other sides use from the box's outer edge. A nested frame's own tab lives
// inside ITS bounds (see frameInsetY), so this frame reserves no room for it. Shared by the flow layout
// and its insertion bar so the two can't disagree.
// (A docked tab's lent box already starts below its group's border, and has no tab band of its own
// above it, so the FRAME_PAD comes straight off it — hence containerBox rather than frame.y here.
// The OPEN frame is the same case for the same reason: its box is the viewport and it draws no tab.
// Fixed here rather than by making isFrameBox false for it, deliberately: isFrameBox feeds isBoxNode
// and nodeH, and nodeH would then fall through to offsetHeight on a display:none element and
// silently report a 64px frame. elTop is the one place that needs the exception.)
function frameContentTop(frame: MindNode): number {
  const box = containerBox(frame);
  return ((isDockedTab(frame) || isScopeRoot(frame)) ? box.y : elTop(frame, box.y)) + FRAME_PAD;
}
// Is `child`'s centre inside `frame`'s OUTER box? The single source of truth for "a frame child is
// still in its frame" — the trigger drag.ts uses in BOTH the rip PREVIEW (updateRip) and the detach
// COMMIT (dragPointerUp), so a child ripping out previews the detach exactly where it commits. Uses
// the full box (not frameInterior's inset) deliberately: a card counts as inside until its centre
// clears the frame edge.
// containerBox, not the frame's own bounds: a DOCKED TAB's child is "in" the box its group lent it,
// not in the tab's label up in the strip.
export function centreInFrame(child: MindNode, frame: MindNode): boolean {
  // The OPEN frame's interior is the whole canvas, so its children can never be ripped out of it —
  // there is nowhere visible to rip them TO. One guard, so the preview and the commit still agree.
  if (isScopeRoot(frame)) return true;
  const cx = child.x + nodeW(child)/2, cy = child.y + nodeH(child)/2;
  const b = containerBox(frame);
  return cx >= b.x && cx <= b.x + b.w
      && cy >= b.y && cy <= b.y + b.h;
}
// Move a node so its bounds top-left lands at (x,y), carrying its whole subtree with it — what a bare
// `n.x = …` assignment can't do (it would leave the children behind, outside the box for a frame).
export function moveSubtreeTo(node: MindNode, x: number, y: number): void { shiftSubtree(node, x - node.x, y - node.y); }
function shiftSubtree(node: MindNode, dx: number, dy: number): void {
  // Saved positions are integers; layout targets are floats. Ignore sub-pixel nudges so a
  // re-opened, already-laid-out map settles to zero movement (no spurious rewrites, no drift).
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  for (const id of subtreeIds(node.id)){
    const n = state.nodes.get(id); if (!n) continue;
    // Skip hidden nodes (a collapsed branch is re-laid on expand) — EXCEPT frame-contained ones,
    // which are free and must keep tracking their frame even while folded.
    if (isHidden(n) && !insideFrame(n)) continue;
    n.x += dx; n.y += dy; n.dirtyLayout = true;
  }
}
// A node's EFFECTIVE child-arrangement — one of free/line/fan. A card's `inherit` (the default)
// walks up its parents until an explicit free/line/fan is found; a root that never resolves falls
// back to free (children stay where dragged). A frame/image ancestor resolves to `free`: a frame
// arranges its children free or by flow (flow is handled separately by frameFlow), and never
// line/fan — so returning `free` here is behaviourally identical to before (layoutSubtree only
// acts on line/fan/flow, ignoring free).
export function effectiveLayout(node: MindNode): { type: string } {
  // A stack outlines its ENTIRE subtree (grandchildren indent under their parent), so the stack owns
  // the layout of every descendant. Resolve the stack node itself to `stack`; resolve any node that
  // lives inside a stack (before hitting a nearer frame) to `free`, so its own layoutSubtree is a
  // no-op and the stack's outline pass places it. Checked before the normal walk so an explicit
  // line/fan on a descendant doesn't override the outliner.
  if (isStack(node)) return { type: 'stack' };
  for (let p = parentOf(node); p; p = parentOf(p)) {
    if (isStack(p)) return { type: 'free' };   // governed by the stack's outliner
    if (p.type !== 'card') break;                 // a nearer frame/box governs instead — normal rules
  }
  let n: MindNode | null | undefined = node, guard = 0;
  while (n && guard++ < 4096){
    if (n.type !== 'card') return { type: 'free' };   // frame/image → free child placement
    if (n.layout !== 'inherit') return { type: n.layout };   // free | line | fan (stack handled above)
    n = parentOf(n);
  }
  return { type: 'free' };   // unresolved inherit → free
}
// How a FRAME arranges its children (flow-h/flow-v), or null when the node isn't an (expanded) frame
// with a flow arrangement. A flow frame auto-positions its children into a wrapping row/column; a
// free frame leaves them where placed. Shared by layout, drag, and the side-bucket drag previews
// (which flow frames opt out of, ordering by 2D position rather than a single side axis).
export function frameFlow(node: MindNode): 'flow-h' | 'flow-v' | null {
  if (!isFrame(node)) return null;
  // The OPEN frame lays nothing out: while you're standing inside it, its contents are FREE, like the
  // top level of the map (effectiveLayout already resolves a frame to `free`, so this is the only
  // branch that had to be told). Being inside a frame should feel like being on a canvas — a flow
  // repacking your cards into rows as you arrange them wouldn't. It also means opening and leaving
  // move nothing at all and so write nothing, whatever layout the frame carries.
  if (isScopeRoot(node)) return null;
  return node.layout === 'horizontal' ? 'flow-h' : node.layout === 'vertical' ? 'flow-v' : null;
}
// Whether a node's effective layout actively MANAGES its children's positions — line/fan (side-based)
// or a flow frame (box-flow) — vs free/free-frame, where children stay where dragged. The single
// spelling of "is this a managed governor?" shared by layout, drop-landing sim, and order reseeding.
export function isManagedLayout(node: MindNode): boolean {
  const t = effectiveLayout(node).type;
  // isTabsFrame: a group owns its tabs' positions (they're slots in its strip, not free placements),
  // so a dragged tab's order is reseeded from where it was dropped — like a flow frame's children.
  return t === 'line' || t === 'fan' || t === 'stack' || !!frameFlow(node) || !!stackOf(node) || isTabsFrame(node);
}
// The stack whose outline governs `node`'s CHILDREN: `node` itself when it's a stack box, otherwise
// the stack hosting it — a row inside an outline, whose children are rows too, so the stack owns
// their positions AND their order (stackOutline reads orderedKids at every level). null when no
// stack governs them. The single test for "is this node's child list stack-managed?" — which is what
// makes a row count as isManagedLayout, so a drop that re-nests under a row stores its insertion
// anchor (reparentOnly) instead of falling back to seeding order from raw positions.
export function stackOf(node: MindNode): MindNode | null {
  if (isStack(node)) return node;
  const h = hostFrame(node);
  return h && isStack(h) ? h : null;
}
// Which of the parent's 4 sides a child sits on, computed FRESH from its current position —
// dominant axis of the offset between the two centers, SCALED by the parent's own aspect ratio
// (a card is wide and short) rather than compared as raw pixels: a `fan` spreads same-side
// siblings wide across the cross axis, so a couple of siblings alone would put more raw pixels
// between a "down" child and its parent horizontally than vertically, misreading it as
// "left"/"right" purely from being laid out. Scaling each axis by the parent's own width/height
// first (comparing fractions of the parent's own size, not absolute px) gives a lot more
// headroom before a wide fan spuriously flips side. Used to BACKFILL `child.side` when it's
// unset (see sideOf) and to refresh it after a plain reposition with no explicit drop target.
export function deriveSide(parent: MindNode, child: MindNode): LayoutSide {
  const dx = (child.x + nodeW(child)/2) - (parent.x + nodeW(parent)/2);
  const dy = (child.y + nodeH(child)/2) - (parent.y + nodeH(parent)/2);
  const w = nodeW(parent) || 1, h = nodeH(parent) || 1;
  return Math.abs(dx) / w >= Math.abs(dy) / h ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
}
// A child's side, from the STORED field — backfilling (and caching) it via deriveSide the
// first time it's asked for a child that doesn't have one yet (a legacy note with no mm_side,
// or a freshly created child). Once set, a plain relayout never changes it — only an explicit
// drop (or a reposition with no drop target — see drag.ts) does. Shared by layout grouping/
// ordering and edge-exit-border selection (edges.ts).
export function sideOf(parent: MindNode, child: MindNode): LayoutSide {
  return child.side ?? (child.side = deriveSide(parent, child));
}
const SIDE_RANK: Record<LayoutSide, number> = { right: 0, down: 1, left: 2, up: 3 };
// Sibling order: group by each child's own derived side, then by the coordinate that side's
// layout treats as "along" (fan → cross axis, line → the growth axis). Ties break by filename
// so the seeded order is deterministic across reloads (folder iteration order is not stable).
// Whether ordering along `side` under this layout reads the X coordinate (else Y): a fan orders
// along the CROSS axis of the side, a line along the growth axis. Shared by the position sort
// below and the live reorder-anchor computation (reorderTarget).
// Exported: the outline view packs reordered siblings along this same axis (features/outline.ts).
export function orderAxisIsX(node: MindNode, side: LayoutSide): boolean {
  const horiz = side === 'left' || side === 'right';
  return effectiveLayout(node).type === 'fan' ? !horiz : horiz;
}
function kidsByPosition(node: MindNode, kids: MindNode[]): string[] {
  const tie = (n: MindNode) => n.file || n.title || n.id;
  const cmpTie = (a: MindNode, b: MindNode) => (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0);
  // The subtree box's TOP-LEFT and its MIDPOINT — both falling back to the card's own corner/centre
  // when the subtree is fully hidden (its governor is collapsed → empty box), so order still seeds
  // deterministically. Which of the two a branch below wants differs; the fallback must not.
  const boxTL = (k: MindNode): { x: number; y: number } => {
    const b = subtreeBox(k);
    return Number.isFinite(b.x0) ? { x: b.x0, y: b.y0 } : { x: k.x, y: k.y };
  };
  const midXY = (k: MindNode): { x: number; y: number } => {
    const b = subtreeBox(k);
    return Number.isFinite(b.x0)
      ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
      : { x: k.x + nodeW(k) / 2, y: k.y + nodeH(k) / 2 };
  };
  // FLOW frame: order by reading order along the flow axis. Read the subtree box's TOP-LEFT — NOT
  // its midpoint — because that's exactly what the flow layout aligns to a row/column line, so all
  // items in a row (flow-h) share the same box-top even when one has a tall subtree (a midpoint
  // would band that item into a later row and sort it to the end, losing its saved order on reload).
  // Cluster into bands by GAP (not exact equality): sort by the cross axis, then start a new band
  // whenever the jump from the previous item exceeds FLOW_BAND_TOL. Already flow-placed siblings
  // share an EXACT top per row, so this clusters them correctly too — but tolerant clustering is
  // what makes a FIRST-time conversion (a free frame's hand-placed cards, never pixel-aligned)
  // group into sensible rows/columns instead of every card landing in its own singleton band.
  // STACK: a single top→bottom column — order purely by vertical position (subtree box top), so a
  // child dragged up/down re-slots into the reseeded order at its new row. Applies at EVERY level of
  // an outline (stackOf, not just the stack itself): a row's own children are rows in the same
  // column, so they order by y as well — side/midpoint ranking is meaningless in an outline.
  if (stackOf(node))
    return kids.slice().sort((a, b) => boxTL(a).y - boxTL(b).y || cmpTie(a, b)).map(k => k.id);
  // TABS: one left→right strip, so order is purely the tab's own x — the slot it sits in, which is
  // what mm_position_x persists (no separate order key). The tab's OWN x, not its subtree box: an
  // open tab's contents sit in the box the group lent it, nowhere near its label in the strip.
  if (isTabsFrame(node)) return kids.slice().sort((a, b) => a.x - b.x || cmpTie(a, b)).map(k => k.id);
  const flow = frameFlow(node);
  if (flow) {
    const cross = (k: MindNode) => flow === 'flow-h' ? boxTL(k).y : boxTL(k).x;
    const along = (k: MindNode) => flow === 'flow-h' ? boxTL(k).x : boxTL(k).y;
    const byCross = kids.slice().sort((a, b) => cross(a) - cross(b) || cmpTie(a, b));
    let band = 0;
    const banded = byCross.map((k, i) => {
      if (i > 0 && cross(k) - cross(byCross[i - 1]) > FLOW_BAND_TOL) band++;
      return { k, band };
    });
    return banded
      .sort((a, b) => (a.band - b.band) || (along(a.k) - along(b.k)) || cmpTie(a.k, b.k))
      .map(x => x.k.id);
  }
  // Sort by the SUBTREE box's midpoint, not the card's own corner — a sibling with a big
  // subtree visually occupies its whole box, so that's the order the user perceives. Grouped by
  // each child's stored side, then by the coordinate that side's layout treats as "along".
  const coord = (k: MindNode): number => {
    const useX = orderAxisIsX(node, sideOf(node, k));
    const m = midXY(k);
    return useX ? m.x : m.y;
  };
  return kids.slice()
    .sort((a,b) => (SIDE_RANK[sideOf(node,a)] - SIDE_RANK[sideOf(node,b)]) || (coord(a)-coord(b)) || cmpTie(a, b))
    .map(k => k.id);
}
// A parent's child order is STORED (in memory) and only changes when a child is directly
// dragged — never on an incidental relayout. So moving a parent, editing text, or collapsing
// never reshuffles children; order is seeded from saved positions the first time it's needed.
// Exported: the outline view renders siblings in exactly this order (features/outline.ts).
export function orderedKids(node: MindNode, kids: MindNode[]): MindNode[] {
  const have = new Set(kids.map(k => k.id));
  let order = (node.kidOrder || []).filter(id => have.has(id));   // drop removed children
  const known = new Set(order);
  const fresh = kids.filter(k => !known.has(k.id));                // new children → append by position
  if (fresh.length) order = order.concat(kidsByPosition(node, fresh));
  node.kidOrder = order;
  const rank = new Map(order.map((id,i)=>[id,i]));
  return kids.slice().sort((a,b)=>rank.get(a.id)! - rank.get(b.id)!);
}
// Turn a live drag position into an insertion anchor among `parent`'s children: which side the
// dragged card is on right now (or `forcedSide`, e.g. the hovered sibling's stored side for a
// centre-zone drop) and which same-side sibling it should slot in AFTER (`null` = before them
// all). Compares the dragged CARD's midpoint against each sibling's SUBTREE-box midpoint along
// the side's ordering axis, so "between two siblings" means between their visible boxes — the
// order the user perceives — not between the cards' top-left corners. Stored bucket order equals
// visual order along the increasing coordinate on all four sides for both fan and line (lineSide
// reverses left/up iteration precisely to guarantee that), so no mapping is needed. The single
// source of the anchor for both the insertion-line preview and the drop commit.
//
// `line` is the world-space segment for the insertion indicator: it sits in the CURRENT gap
// between the two adjacent siblings' subtree boxes (perpendicular to the ordering axis, spanning
// the neighbours' cards) — i.e. relative to where the siblings are NOW, not where the post-drop
// layout would put things. `null` when there's no same-side sibling to slot against.
//
// `near` is the engage gate: whether the dragged card is close enough to the sibling band that a
// release should mean "re-slot" rather than rip/free-move. Between two neighbours the along-axis
// position is correct by construction (that's how afterId was picked), so only the CROSS-axis
// distance to the gap matters; past the first/last sibling the along-axis distance is bounded
// too, so pulling away off the end of the row/column still rips as before.
export function reorderTarget(parent: MindNode, dragged: MindNode, forcedSide?: LayoutSide): { side: LayoutSide; afterId: string | null; line: Seg | null; near: boolean } {
  const side = forcedSide ?? deriveSide(parent, dragged);
  const kids = childrenOf(parent.id).filter(k => !isHidden(k) && k.id !== dragged.id);
  const sibs = orderedKids(parent, kids).filter(k => sideOf(parent, k) === side);
  const useX = orderAxisIsX(parent, side);
  const mid = useX ? dragged.x + nodeW(dragged) / 2 : dragged.y + nodeH(dragged) / 2;
  let afterId: string | null = null;
  let idx = -1;   // index of the `afterId` sibling in sibs
  for (const s of sibs) {
    const b = subtreeBox(s);
    if ((useX ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2) <= mid) { afterId = s.id; idx++; }
    else break;
  }
  // The gap the card would slot into: between `prev` (the afterId sibling) and `next` — either
  // may be missing at the ends of the row/column, where the line sits just beyond the last box.
  const prev = idx >= 0 ? sibs[idx] : null, next = sibs[idx + 1] ?? null;
  let line: Seg | null = null;
  let near = false;
  if (prev || next) {
    const pb = prev ? subtreeBox(prev) : null, nb = next ? subtreeBox(next) : null;
    const END = LAYOUT_CHAIN;   // half-gap-ish offset past the first/last sibling's box
    if (useX) {
      const x = pb && nb ? (pb.x1 + nb.x0) / 2 : pb ? pb.x1 + END : nb!.x0 - END;
      const y0 = Math.min(prev?.y ?? Infinity, next?.y ?? Infinity);
      const y1 = Math.max(prev ? prev.y + nodeH(prev) : -Infinity, next ? next.y + nodeH(next) : -Infinity);
      line = { x0: x, y0, x1: x, y1 };
      const crossMid = dragged.y + nodeH(dragged) / 2;
      near = crossMid > y0 - (nodeH(dragged) + LANDING_GAP) && crossMid < y1 + (nodeH(dragged) + LANDING_GAP)
          && (!!(prev && next) || Math.abs(mid - x) < nodeW(dragged));
    } else {
      const y = pb && nb ? (pb.y1 + nb.y0) / 2 : pb ? pb.y1 + END : nb!.y0 - END;
      const x0 = Math.min(prev?.x ?? Infinity, next?.x ?? Infinity);
      const x1 = Math.max(prev ? prev.x + nodeW(prev) : -Infinity, next ? next.x + nodeW(next) : -Infinity);
      line = { x0, y0: y, x1, y1: y };
      const crossMid = dragged.x + nodeW(dragged) / 2;
      const tol = nodeW(dragged);
      near = crossMid > x0 - tol && crossMid < x1 + tol
          && (!!(prev && next) || Math.abs(mid - y) < nodeH(dragged) + LANDING_GAP);
    }
  }
  return { side, afterId, line, near };
}
// Where a card dragged inside a FLOW frame would be inserted: the sibling it lands AFTER in the flow
// reading order (`null` = front), plus the insertion bar to draw. flow-h reads row-major and draws a
// VERTICAL bar in the gap; flow-v reads column-major and draws a HORIZONTAL bar. The 2D analogue of
// reorderTarget — used for both the live preview and the drop commit so they agree.
//
// Two-step, like reading a grid: (1) which BAND (row for flow-h, column for flow-v) is the dragged
// card in — resolved by NEAREST band centre on the cross axis, not exact position matching, since
// the dragged card's live position rarely lands exactly on a row/column line (drag offset, no snap
// mid-drag); (2) where within that band, by comparing along-axis midpoints — same technique as
// reorderTarget. Bands are grouped from already-placed siblings, whose box-tops are EXACT per row
// (that's what the flow layout assigns), so grouping consecutive same-top siblings is reliable.
export function flowReorderTarget(frame: MindNode, dragged: MindNode): { afterId: string | null; line: Seg } {
  const flow = frameFlow(frame)!;                                   // caller ensures a flow frame
  const kids = childrenOf(frame.id).filter(k => !isHidden(k) && k.id !== dragged.id);
  const sibs = orderedKids(frame, kids);                            // flow reading order
  if (!sibs.length) return { afterId: null, line: flowLine(frame, null, null, flow) };

  type Band = { key: number; size: number; items: MindNode[] };
  const bands: Band[] = [];
  for (const s of sibs) {
    const b = subtreeBox(s);
    const key = Math.round(flow === 'flow-h' ? b.y0 : b.x0);
    const size = flow === 'flow-h' ? (b.y1 - b.y0) : (b.x1 - b.x0);
    const last = bands[bands.length - 1];
    if (last && last.key === key) { last.items.push(s); last.size = Math.max(last.size, size); }
    else bands.push({ key, size, items: [s] });
  }

  const dCross = flow === 'flow-h' ? dragged.y + nodeH(dragged) / 2 : dragged.x + nodeW(dragged) / 2;
  let bandIdx = 0, bestDist = Infinity;
  bands.forEach((b, i) => {
    const d = Math.abs(dCross - (b.key + b.size / 2));
    if (d < bestDist) { bestDist = d; bandIdx = i; }
  });
  const band = bands[bandIdx];

  const dAlong = flow === 'flow-h' ? dragged.x + nodeW(dragged) / 2 : dragged.y + nodeH(dragged) / 2;
  let afterInBand: MindNode | null = null;
  for (const s of band.items) {
    const b = subtreeBox(s);
    const mid = flow === 'flow-h' ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2;
    if (mid <= dAlong) afterInBand = s; else break;
  }
  const afterId = afterInBand ? afterInBand.id
    : bandIdx > 0 ? bands[bandIdx - 1].items[bands[bandIdx - 1].items.length - 1].id
    : null;

  const idxInSibs = afterId ? sibs.findIndex(s => s.id === afterId) : -1;
  const prev = idxInSibs >= 0 ? sibs[idxInSibs] : null;
  const next = sibs[idxInSibs + 1] ?? null;
  return { afterId, line: flowLine(frame, prev, next, flow) };
}
// The insertion bar between `prev` and `next` (either may be null at the ends) for a flow frame.
// flow-h draws a VERTICAL bar (positioned along x, spanning a y range); flow-v draws a HORIZONTAL
// bar (positioned along y, spanning an x range) — same along/cross-axis split as flowReorderTarget,
// so the two branches below differ only in which axis is "along" vs "cross", not in the logic.
function flowLine(frame: MindNode, prev: MindNode | null, next: MindNode | null, flow: 'flow-h' | 'flow-v'): Seg {
  const G = 6;
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const pb = prev ? subtreeBox(prev) : null, nb = next ? subtreeBox(next) : null;
  const alongLo = (b: Box) => flow === 'flow-h' ? b.x0 : b.y0, alongHi = (b: Box) => flow === 'flow-h' ? b.x1 : b.y1;
  const crossLo = (b: Box) => flow === 'flow-h' ? b.y0 : b.x0, crossHi = (b: Box) => flow === 'flow-h' ? b.y1 : b.x1;
  // same row (flow-h) / column (flow-v): the flow layout gives row-mates an identical box top.
  const sameBand = !!pb && !!nb && Math.round(crossLo(pb)) === Math.round(crossLo(nb));
  let pos: number, spanLo: number, spanHi: number;
  if (pb && nb && sameBand) { pos = (alongHi(pb) + alongLo(nb)) / 2; spanLo = Math.min(crossLo(pb), crossLo(nb)); spanHi = Math.max(crossHi(pb), crossHi(nb)); }
  else if (nb) { pos = alongLo(nb) - G; spanLo = crossLo(nb); spanHi = crossHi(nb); }
  else if (pb) { pos = alongHi(pb) + G; spanLo = crossLo(pb); spanHi = crossHi(pb); }
  else if (flow === 'flow-h') { pos = containerBox(frame).x + FRAME_PAD; spanLo = frameContentTop(frame); spanHi = spanLo + 40; }
  // empty frame: no sibling box to span, so the bar gets a nominal one-card length (like the 40 above)
  else { pos = frameContentTop(frame); spanLo = containerBox(frame).x + FRAME_PAD; spanHi = spanLo + NODE_W; }
  return flow === 'flow-h' ? { x0: pos, y0: spanLo, x1: pos, y1: spanHi } : { x0: spanLo, y0: pos, x1: spanHi, y1: pos };
}
// After a drag the dropped positions are authoritative (heights didn't change), so refresh the
// sibling order of every parent that had a child moved — this is the ONLY place order changes.
export function reorderDraggedParents(movedIds: Iterable<string>): void {
  const parents = new Set<string>();
  for (const id of movedIds){ const n = state.nodes.get(id); if (n && n.parent) parents.add(n.parent); }
  for (const pid of parents){
    const p = state.nodes.get(pid); if (!p) continue;
    if (isManagedLayout(p))
      p.kidOrder = kidsByPosition(p, childrenOf(p.id).filter(k => !isHidden(k)));
  }
}
// Arrange a node's children per its own effective layout (free/line/fan) or frame flow, then recurse.
// The node itself stays put — only its children (and their whole subtrees) move. A `free`
// node leaves its children wherever they are. Sibling ORDER is read from the children's
// CURRENT positions, so dragging a child past a sibling reorders them on the next pass.
function layoutSubtree(node: MindNode): void {
  if (node.collapsed) return;
  // annotations opt out of layout: never ordered, spaced, or flowed — they stay where dragged and
  // float on top (they still ride shiftSubtree when an ancestor moves, so they track their parent).
  const kids = childrenOf(node.id).filter(k => !isHidden(k) && !isAnnotation(k));
  // An empty STACK still owes itself a height — its box auto-fits its outline, and with no rows that
  // outline is just its own (possibly wrapped) title.
  if (!kids.length) { if (isStack(node)) sizeEmptyStack(node); return; }
  // lay out each child's own subtree first, so subtreeBox() reflects the grandchildren
  for (const k of kids) layoutSubtree(k);

  // TABS: the group's child frames are docked as tabs, so this pass places their LABELS along the
  // strip — a tab's bounds ARE its label (isFrameFold, main.ts) and its own contents are placed by its
  // own layoutSubtree (already run above) inside the interior the group lent it (containerBox). Which
  // is why a tab's label moves WITHOUT shiftSubtree: its contents aren't attached to the label, they
  // live in the box. (Their mm_position_x, being an offset from the tab, is rewritten when a tab
  // changes slot — harmless churn, and it reloads to the same absolute spot either way.)
  if (isTabsFrame(node)) {
    const tabs = tabsOf(node);
    // paint BEFORE measuring: a tab shrink-wraps its title, so both its own width and the slot maths
    // that follows are live measurements (nodeW → offsetWidth) that don't exist until it has been
    // rendered at all — the same paint-then-measure rule the stack outliner above follows.
    for (const t of tabs) paintNode(t);
    const y = tabStripRect(node).y;
    const { xs } = tabSlots(node);
    tabs.forEach((t, i) => { t.x = xs[i]; t.y = y; t.dirtyLayout = true; paintNode(t); });
    return;
  }

  const type = effectiveLayout(node).type;            // `none` inherits the parent's layout
  const flow = frameFlow(node);                       // flow-h / flow-v for a flow frame, else null
  if (type !== 'line' && type !== 'fan' && type !== 'stack' && !flow) return;  // free / free-frame / unset: manual

  const boxOf = new Map(kids.map(k => [k.id, subtreeBox(k)]));
  const ax = node.x, ay = node.y;

  const sorted = orderedKids(node, kids);   // stored order — only a direct child-drag changes it

  // STACK: a framed, auto-sized card that renders its whole subtree as an OUTLINER — a single
  // full-width column below the header, each level indented under its parent (like an outline tree).
  // The box's width is authored (n.w, defaulting to STACK_W — the one axis a stack can be resized on)
  // and its height is auto-fitted to the outline. A DFS lays out every visible descendant as a row: a
  // normal expanded card places its own card, then recurses (deeper indent); a nested container
  // (frame/stack) or a collapsed card is one opaque row (its box/fold owns its contents), moved as a
  // whole and not descended into. A row's WIDTH isn't set here — it's derived by stackRowW from this
  // box's width and the row's depth, which paintNode applies; that's what keeps a card's own authored
  // width intact while it sits in the outline, ready for when it's dragged back out.
  if (type === 'stack') {
    const innerLeft = ax + FRAME_BORDER + STACK_PAD;
    const rows = stackOutline(node);
    // no visible rows (every child hidden or an annotation) — same case as a childless stack above
    if (!rows.length) { sizeEmptyStack(node); return; }
    let cy = ay + stackHeaderH(node);
    // Walk the SHARED outline (stackOutline) rather than a private DFS, so the drop resolver
    // (stackDropTarget) and this layout pass can never disagree about a row's order or depth.
    for (const { node: k, depth } of rows) {
      const x = innerLeft + depth * STACK_INDENT;
      if (isContainer(k) || k.collapsed) {
        // one opaque row: its own box/fold owns its contents, so move the whole subtree with it
        paintNode(k);
        const b = subtreeBox(k);
        shiftSubtree(k, x - b.x0, cy - b.y0);
        cy += (b.y1 - b.y0) + STACK_GAP;
      } else {
        k.x = x; k.y = cy; k.dirtyLayout = true;
        paintNode(k);
        cy += layoutH(k) + STACK_GAP;
      }
    }
    // Drop the trailing gap, then inset the bottom by the SAME amount as the sides. A row's left edge
    // sits at FRAME_BORDER + STACK_PAD from the box's outer edge, and borders are inside the box
    // (box-sizing:border-box), so the bottom needs both terms too — with STACK_PAD alone the gap
    // under the last row read visibly tighter than the ones beside it.
    node.h = (cy - STACK_GAP) - ay + STACK_PAD + FRAME_BORDER;
    return;
  }

  // FLOW frame: fill the content area along the primary axis, wrapping to the next row/column when
  // the next child won't fit. flow-h fills rows left→right (wrap down); flow-v fills columns
  // top→bottom (wrap right). Reflows as the frame is resized (content width/height changes).
  if (flow) {
    const gap = FRAME_FLOW_GAP;
    // containerBox, so a flow frame docked as a TAB flows inside the box its group lent it
    const box = containerBox(node);
    const left = box.x + FRAME_PAD, top = frameContentTop(node);
    const right = box.x + box.w - FRAME_PAD, bottom = box.y + box.h - FRAME_PAD;
    let cx = left, cy = top, band = 0;   // band = tallest row (flow-h) / widest column (flow-v) so far
    for (const k of sorted) {
      const b = boxOf.get(k.id)!, w = b.x1 - b.x0, h = b.y1 - b.y0;
      if (flow === 'flow-h') {
        if (cx > left && cx + w > right) { cx = left; cy += band + gap; band = 0; }   // wrap to next row
        shiftSubtree(k, cx - b.x0, cy - b.y0);
        cx += w + gap; band = Math.max(band, h);
      } else {
        if (cy > top && cy + h > bottom) { cy = top; cx += band + gap; band = 0; }    // wrap to next column
        shiftSubtree(k, cx - b.x0, cy - b.y0);
        cy += h + gap; band = Math.max(band, w);
      }
    }
    return;
  }

  // FAN a set of children to ONE side: every child the same distance out, spread along the
  // cross axis and centred on the parent. Called once per occupied side (up to 4).
  const fanSide = (ids: MindNode[], sd: string) => {
    const hz = sd === 'left' || sd === 'right';
    const cross = ids.map(k => { const b=boxOf.get(k.id)!; return hz ? (b.y1-b.y0) : (b.x1-b.x0); });
    const total = cross.reduce((s,v)=>s+v,0) + LAYOUT_CROSS*Math.max(0, ids.length-1);
    let cur = (hz ? ay + layoutH(node)/2 : ax + nodeW(node)/2) - total/2;
    ids.forEach((k,i)=>{
      const b = boxOf.get(k.id)!; let dx=0, dy=0;
      if (hz){ dx = sd==='right' ? (ax+nodeW(node)+LAYOUT_MAIN - b.x0) : (ax-LAYOUT_MAIN - b.x1); dy = cur - b.y0; }
      else   { dy = sd==='down'  ? (ay+layoutH(node)+LAYOUT_MAIN - b.y0) : (ay-LAYOUT_MAIN - b.y1); dx = cur - b.x0; }
      shiftSubtree(k, dx, dy); cur += cross[i] + LAYOUT_CROSS;
    });
  };
  // LINE a set of children to ONE side: chained one after another ALONG the side, centred on
  // the cross axis. Called once per occupied side (up to 4). The chain grows in the side's
  // sign, so for left/up we walk the order in REVERSE — that way the first child in stored
  // order ends up at the visual top/left, not nearest the parent. (Otherwise dragging a child
  // to the top snaps it to the bottom.)
  const lineSide = (ids: MindNode[], sd: string) => {
    const hz = sd === 'left' || sd === 'right';
    let cur = hz ? (sd==='right' ? ax+nodeW(node)+LAYOUT_MAIN : ax-LAYOUT_MAIN)
                 : (sd==='down'  ? ay+layoutH(node)+LAYOUT_MAIN : ay-LAYOUT_MAIN);
    const seq = (sd==='left' || sd==='up') ? ids.slice().reverse() : ids;
    seq.forEach((k)=>{
      const b = boxOf.get(k.id)!; let dx=0, dy=0;
      if (hz){
        const w = b.x1 - b.x0;
        dx = sd==='right' ? (cur - b.x0) : (cur - b.x1);
        dy = (ay + layoutH(node)/2) - (k.y + layoutH(k)/2);   // centre child on the parent's y
        cur += sd==='right' ? (w+LAYOUT_CHAIN) : -(w+LAYOUT_CHAIN);
      } else {
        const h = b.y1 - b.y0;
        dy = sd==='down' ? (cur - b.y0) : (cur - b.y1);
        dx = (ax + nodeW(node)/2) - (k.x + nodeW(k)/2);   // centre child on the parent's x
        cur += sd==='down' ? (h+LAYOUT_CHAIN) : -(h+LAYOUT_CHAIN);
      }
      shiftSubtree(k, dx, dy);
    });
  };
  // Each child sits on whichever of the parent's 4 sides is STORED on it (see sideOf). Group
  // the stored order into up to 4 side-buckets, then lay out each occupied bucket independently
  // (generalizes the old two-sided balance to up to 4 sides).
  const buckets: Record<LayoutSide, MindNode[]> = { right: [], left: [], down: [], up: [] };
  for (const k of sorted) buckets[sideOf(node, k)].push(k);
  const place = type === 'fan' ? fanSide : lineSide;
  for (const side of ['right', 'left', 'down', 'up'] as const) {
    if (buckets[side].length) place(buckets[side], side);
  }
}

// Re-apply every node's layout across the whole forest. Free nodes keep their manual
// positions; line/fan nodes own their children's. Cheap enough to run after any change.
// Runs in read-only too (e.g. expanding a node must re-flow its children) — read-only just
// never persists: scheduleSave is a no-op there, so the in-memory positions are discarded
// when read-only is left and the map is reloaded from disk.
export function applyLayouts(): void {
  // Settle every tab group on exactly one open tab FIRST: the pass below (and the paints it triggers)
  // reads `collapsed` all over, so the invariant has to hold before any of it runs — and doing it
  // here covers every caller at once (~20 relayout sites) instead of per gesture.
  for (const n of state.nodes.values()) if (isTabsFrame(n)) normalizeTabs(n);
  // The open frame may have just been deleted / undone away / vanished on disk. Repaired here for
  // the same reason normalizeTabs is: this runs after every structural change, so one call covers
  // every path instead of each remembering.
  pruneScope();
  const open = scopeRootNode();
  if (open) {
    // …and while a frame is open it is never FOLDED — an invariant, kept beside normalizeTabs
    // because a reload or an undo can re-collapse it and layoutSubtree bails on a collapsed node,
    // which would leave the canvas blank.
    if (open.collapsed) { open.collapsed = false; open.dirty = true; open.dirtyLayout = true; }
    // Confined to the open frame, and that's what keeps the feature honest about disk: no
    // out-of-scope node's x/y is touched, so commitRel finds no changed offset and dirties no file
    // outside the scope. (It's also strictly less work than the forest walk below.)
    layoutSubtree(open);
    return;
  }
  for (const n of state.nodes.values()) if (isRoot(n)) layoutSubtree(n);
}

// ---------- auto-collapse deep branches ----------
// Fold every branch at a given depth. A collapsed node folds into a "+" stub on its
// parent's edge (hiding itself + its subtree), so collapsing all nodes at `depth` leaves
// the shallower levels on screen as expandable stubs. depth = 1 → root stays, each of its
// children becomes a collapsed section you click to open.
export function collapseAtDepth(depth = 1): void {
  for (const n of state.nodes.values()){
    n.collapsed = ancestorDepth(n) === depth && childrenOf(n.id).length > 0;
  }
}
