// ---------- node layout ----------
// Computes node x/y. applyLayouts re-flows every node per its own type/layout after any change. The
// node itself stays put — only its children (and their subtrees) move.
//
// Children go INSIDE their parent, never beside it: a card with children is an OUTLINER (isStack)
// and a frame is a box. The four SIDES a child used to attach on, the mm_side that stored which one,
// and the line/fan arrangements that placed children around a parent all went with that change —
// see docs/spec-edges-and-containment.md.
//
// layoutH/NODE_W/subtreeIds come from main (render + tree helpers) — a runtime-only cycle.
import { state, isAnnotation, isLeafType, type MindNode } from '../core/state.js';
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
// child's stored position even though nothing about the child moved on screen — dragging a frame's
// west edge (which shifts the frame's own x), or undoing such a resize, leaves each child's saved
// offset describing the OLD one. Catching it here, in the one bridge every save goes through, covers
// every mover (resize, undo/redo, layout, drag) instead of asking each of them to remember. Compared
// ROUNDED, since that's the precision the board file stores — raw float noise would otherwise flag
// every node on every save.
// It flags `dirtyLayout`, NOT `dirty`: a position is board.json's business now (data/board.ts), and
// marking the NOTE dirty here would rewrite a .md on every drag to change nothing in it.
export function commitRel(): void {
  for (const n of state.nodes.values()) {
    const p = parentOf(n);
    const rx = n.x - (p ? p.x : 0), ry = n.y - (p ? p.y : 0);
    if (Math.round(rx) !== Math.round(n.rx) || Math.round(ry) !== Math.round(n.ry)) n.dirtyLayout = true;
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
export function dropLanding(dragged: MindNode, target: MindNode, mode: 'child' | 'sibling' | 'reorder', afterId?: string | null): { x: number; y: number } {
  // An ANNOTATION lands where you dropped it, full stop. It's a remark placed AGAINST a card at a
  // spot you chose by dragging — it takes no part in layout and has no side to dock against — so
  // re-pinning it must change its parent and nothing else. Every other kind gets a landing computed
  // from the target, which for an annotation would fling it below the card you aimed at.
  if (isAnnotation(dragged)) return { x: dragged.x, y: dragged.y };
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
  // Anything else is a CARD adopting a child, and a card with children OUTLINES them — so there is
  // no geometric shortcut left to take: simulate, and let the outliner say where the row lands. (The
  // governor may still be childless at this instant, which is exactly why the estimate can't be made
  // here: it only becomes a container once the dry run hands it the dragged card.)
  return simulateLanding(dragged, governor, afterId !== undefined ? afterId : (mode === 'sibling' ? target.id : undefined));
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

// Dry-run a reparent of `dragged` onto `governor` (inserted right after `afterId`, if given):
// reparent, run the real layoutSubtree(), capture dragged's resulting position, then put every
// touched node/field back exactly as found.
function simulateLanding(dragged: MindNode, governor: MindNode, afterId?: string | null): { x: number; y: number } {
  const prevParent = dragged.parent;
  const prevKidOrder = governor.kidOrder ? [...governor.kidOrder] : undefined;
  const snapIds = new Set<string>();
  for (const k of childrenOf(governor.id)) if (k.id !== dragged.id) for (const id of subtreeIds(k.id)) snapIds.add(id);
  for (const id of subtreeIds(dragged.id)) snapIds.add(id);
  const snap = new Map([...snapIds].map(id => {
    const n = state.nodes.get(id)!; return [id, { x: n.x, y: n.y }] as [string, { x: number; y: number }];
  }));

  governor.kidOrder = insertedKidOrder(governor, dragged.id, afterId);
  dragged.parent = governor.id;
  layoutSubtree(governor);
  const land = { x: dragged.x, y: dragged.y };

  dragged.parent = prevParent;
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
const LAYOUT_CROSS = 22;   // gap between FANNED sibling subtrees (spread across the side)
// gap between CHAINED sibling subtrees (a line along the direction) — must clear a card's own
// tag row, which floats OUTSIDE the card's border and overhangs ~11px past its bottom edge (see
// .node .tag-row in styles.css): anything tighter and the next chained card's opaque background
// paints over the previous card's tag pills/add-emoji button, hiding them even though they're
// still very much in the DOM and clickable.
// Both are multiples of GRID_SNAP so flowed content stays grid-aligned: the frame's own x/y/w/h
// are already grid multiples (position/resize snap), and every child's w/h is too (NODE_W=200,
// heights rounded up to the grid in main.ts's snapCardHeights) — so keeping these constants (and
// the flow gap below) grid multiples means every computed cx/cy stays on the grid, with no
// runtime rounding needed.
const FRAME_PAD = 20;       // inset from a frame's border to its content area (flow arrange)
const FRAME_FLOW_GAP = 20;  // gap between flowed children (GRID_SNAP)
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
// …and a frame INSIDE A STACK is demoted to a plain outline row, the same way a nested stack is
// (insideStack below): the outer stack outlines the whole subtree and ignores every descendant's own
// arrangement, so a frame in there isn't a box either — it's a row, and its children are the rows
// under it. Its mm_w/mm_h ride along untouched, so it comes back out of the stack as the box it was.
export function isFrame(node: MindNode): boolean {
  return node.type === 'frame' && !node.collapsed && !insideStack(node);
}
// Is there a stack in this node's ancestry? Then this node is one of its OUTLINE ROWS, whatever kind
// it is: the outer stack outlines the whole subtree and ignores every descendant's own arrangement, so
// a nested stack — and, since it reads the same way, a nested FRAME — is not a box of its own but just
// another indented row. Uses the RAW `type` field so it never recurses through isStack/isFrame.
// A frame ancestor no longer re-scopes: it can't govern its children's layout while it is itself a row
// (that's what "the stack owns the whole subtree" means), so the walk goes straight through it. Only a
// LEAF kind would stop the search, and a leaf never has children to begin with — the guard is there so
// a future kind that does must decide this question deliberately.
export function insideStack(node: MindNode): boolean {
  for (let p = parentOf(node); p; p = parentOf(p)) {
    // The first CARD ancestor outlines us — a card with children IS an outline, so being a card's
    // child is the whole test. hasRows guards the one case where it isn't trivially true: an
    // ANNOTATION child, which floats on top of its parent rather than stacking into it, and so
    // doesn't make its parent an outline (see hasRows).
    if (p.type === 'card') return !p.collapsed && hasRows(p);
    if (p.type !== 'frame') return false;
  }
  return false;
}
// Does this node have children that OUTLINE — i.e. any child that isn't an annotation? An annotation
// is pinned on top of its parent and takes no part in layout, so a card whose only child is one is
// still a plain card, not a container.
export function hasRows(node: MindNode): boolean {
  return childrenOf(node.id).some(k => !isAnnotation(k));
}
// A CARD WITH CHILDREN frames its whole subtree as an OUTLINER (one full-width column, each level
// indented) inside an auto-sized, non-resizable box. This is what replaced the branch line: a child
// is INSIDE its parent, never beside it, so you can see what belongs to what without a connector.
// There is no `stack` KIND any more — having children is the whole condition (docs/spec-edges-and-
// containment.md). Like a frame it's a CONTAINER: its descendants live in its coordinate space, clip
// to its interior, and detach by leaving its bounds. A COLLAPSED one folds to an ordinary card
// (children hidden), so it isn't a container while folded. One INSIDE another is demoted
// (insideStack) to a plain outline row — the outermost owns the whole subtree.
export function isStack(node: MindNode): boolean {
  return node.type === 'card' && !node.collapsed && !insideStack(node) && hasRows(node);
}
// ---------- tab groups: a frame whose child FRAMES are docked as tabs ----------
// A TABS frame (mm_layout: tabs): its child frames aren't content, they're TABS. Their title tabs
// flow along this frame's own top band (tabStripRect) and whichever tab is OPEN borrows the whole
// box for its children — so the group owns the geometry (x/y/w/h, colour, resize handles, border)
// and a tab owns only its contents. Keyed on the RAW type + layout rather than isFrame, so
// collapsing the group can't flip a hosted tab's identity mid-paint (same caution as frameInsetY).
export function isTabsFrame(node: MindNode): boolean {
  return node.type === 'frame' && node.layout === 'tabs' && !insideStack(node);
}
// The group `node` is docked into as a tab, or null. A tab is always a FRAME child of a tabs frame:
// any other child kind is ordinary content (e.g. a card dropped into the box), never a tab.
export function tabGroupOf(node: MindNode): MindNode | null {
  if (node.type !== 'frame') return null;
  const p = parentOf(node);
  return p && isTabsFrame(p) ? p : null;
}
// (tabGroupOf already returns null inside a stack — a demoted group is no longer a tabs frame — so a
// tab in there is an ordinary frame child, i.e. a row of the outline like every other descendant.)
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
  // NOTHING written at the top → reserve nothing for it: the rows start at the box's own inset. An
  // unnamed stack is a plain column of cards, and an empty strip above the first one reads as a
  // mistake rather than as a title waiting to be typed. (STACK_HEADER survives as nodeH's pre-render
  // fallback, for a stack that has no measured height yet.)
  return h ? FRAME_BORDER + STACK_PAD + h + STACK_GAP : FRAME_BORDER + STACK_PAD;
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
  // …floored at STACK_HEADER for the doubly-empty case — no rows AND no text — where the arithmetic
  // above would otherwise leave a ~20px sliver with nothing to grab, select or drop into. That's not
  // the "space reserved above the rows" the header question is about: there are no rows to be above.
  stack.h = Math.max(STACK_HEADER, stackHeaderH(stack) - STACK_GAP + STACK_PAD + FRAME_BORDER);
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
// Does this frame have anything to put ON its tab — its own text (title or note, which is what the tab
// renders, flattened to one line)? A frame that hasn't been named draws NO tab and reserves no strip for
// one: its bounds ARE its box (elTop / frameInsetY below), because a folder tab with nothing written on
// it is a label that says nothing while costing the box 39px. Read off the TEXT, so it can't flip under
// a hosted child mid-paint the way a collapse-state test could.
export function frameLabelled(f: MindNode): boolean { return !!(f.title.trim() || f.body.trim()); }
// How far DOWN from a container's BOUNDS top its interior starts — the vertical counterpart of the
// plain FRAME_BORDER inset used on the other three sides, and the single spelling of it: shared by
// frameInterior and by everything that projects a hosted child into its host's content wrapper
// (main.ts's place/frameContentEl/followEdges). A FRAME's bounds also cover its title tab, which sits
// above the box (FRAME_TAB_DROP, main.ts); a stack has no tab. Keyed on `type`, not isFrame, so a paint
// landing mid-collapse can't flip the inset under a hosted child.
export function frameInsetY(f: MindNode): number {
  return FRAME_BORDER + (f.type === 'frame' && frameLabelled(f) ? FRAME_TAB_DROP : 0);
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
  // Everything else — a FREE frame's children, which sit wherever they were dropped. Reading order
  // (top to bottom, then left to right) off the SUBTREE box's midpoint, not the card's own corner: a
  // sibling with a big subtree visually occupies its whole box, so that is the order a reader
  // perceives. This is what the four side buckets collapsed to once children moved INSIDE their
  // parent — with no sides left to group by, position in reading order is the only honest seed.
  return kids.slice()
    .sort((a,b) => (midXY(a).y - midXY(b).y) || (midXY(a).x - midXY(b).x) || cmpTie(a, b))
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

  // Nothing else places children: a card OUTLINES them (the stack branch above), a frame flows or
  // leaves them free, and the four side-buckets that line/fan used to fill went with `mm_side` when
  // children moved INSIDE their parent (docs/spec-edges-and-containment.md).
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
