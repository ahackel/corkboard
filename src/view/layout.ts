// ---------- node layout ----------
// Nothing here PLACES cards any more. A card sits where it was put, and a section's children sit where
// they were dropped inside it (docs/PRODUCT.md: "you arrange; the app assists"). What's left is the
// geometry of a section — its box, its interior, which section a point falls in — and the absolute <->
// relative bridge every save goes through. The outliner, the flow sections, the line/fan arrangements
// and the drop simulation that previewed them are gone with the nesting they served.
//
// nodeH/nodeW/subtreeIds come from main (render + tree helpers) — a runtime-only cycle.
import { state, type MindNode } from '../core/state.js';
import { childrenOf, isHidden, parentOf, ancestors, isLockedEffective, subtreeIds } from '../utils/model.js';
import { isScopeRoot, pruneScope, scopeRect } from '../nav/scope.js';
import { layoutH, nodeH, nodeW, SECTION_BORDER } from './geometry.js';

// ---------- absolute <-> relative position ----------
// Two forms of a node's position: the WORKING form x/y (absolute world coords, what the drag engine
// reads and mutates) and the PERSISTED form rx/ry (offset from the parent, world origin for a root —
// what board.json stores). commitRel() derives the persisted form from the working form; it's the
// only bridge, called just before every save (saveAll / exportZip). Load does the reverse — see
// data/load.ts loadFromDir.
// A node's persisted position is an OFFSET from its parent, so moving the PARENT restales every
// child's stored position even though nothing about the child moved on screen — dragging a section's
// west edge (which shifts the section's own x), or undoing such a resize, leaves each child's saved
// offset describing the OLD one. Catching it here, in the one bridge every save goes through, covers
// every mover (resize, undo/redo, drag) instead of asking each of them to remember. Compared ROUNDED,
// since that's the precision the board file stores — raw float noise would otherwise flag every node
// on every save.
// It flags `dirtyLayout`, NOT `dirty`: a position is board.json's business (data/board.ts), and
// marking the NOTE dirty here would rewrite a .md on every drag to change nothing in it.
export function commitRel(): void {
  for (const n of state.nodes.values()) {
    const p = parentOf(n);
    const rx = n.x - (p ? p.x : 0), ry = n.y - (p ? p.y : 0);
    if (Math.round(rx) !== Math.round(n.rx) || Math.round(ry) !== Math.round(n.ry)) {
      n.dirtyLayout = true;
    }
    n.rx = rx; n.ry = ry;
  }
}

// Bounding box over a node + its VISIBLE descendants. A SECTION is bounded by its OWN box (mm_w/mm_h):
// its children live INSIDE it, so we count the section's box and don't descend into its content — plus
// the label hanging above it (sectionLabelH), so a section fitted around one leaves its name room.
function subtreeBox(node: MindNode){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (n: MindNode): void => {
    if (isHidden(n)) {
      return;
    }
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - sectionLabelH(n));
    x1 = Math.max(x1, n.x + nodeW(n)); y1 = Math.max(y1, n.y + layoutH(n));
    if (isSection(n)) {
      return;
    }
    for (const c of childrenOf(n.id)) {
      walk(c);
    }
  };
  walk(node);
  return { x0, y0, x1, y1 };
}
// …and the box around SEVERAL subtrees (infinite when none of them shows).
export function subtreesBox(nodes: Iterable<MindNode>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const b = subtreeBox(n);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}
// An EXPANDED section: a box that holds the cards dropped inside it. A COLLAPSED section folds to its bare
// title tab (children hidden), so it isn't a box while folded — its footprint is the tab.
export function isSection(node: MindNode): boolean {
  return node.type === 'section' && !node.collapsed;
}
// The box a section actually holds its children in: its own bounds. The single spelling, shared by
// sectionInterior, the in-section test and the open section's canvas.
export function containerBox(f: MindNode): { x: number; y: number; w: number; h: number } {
  // …or, for the OPEN one (nav/scope.ts), the VIEWPORT — that's what gives its contents the whole
  // window instead of a rectangle on the canvas. A DERIVED override: f.w/f.h are neither read nor
  // written here, which is what lets the section come back out at its authored size.
  if (isScopeRoot(f)) {
    return scopeRect();
  }
  return { x: f.x, y: f.y, w: nodeW(f), h: nodeH(f) };
}
// Does this node live inside a section (any section ancestor)? Such nodes track their section even while
// HIDDEN, so a folded section that moves doesn't leave its contents behind. Uses `type` (not isSection)
// so a COLLAPSED section still counts.
function insideSection(node: MindNode): boolean {
  for (const p of ancestors(node)) {
    if (p.type === 'section') {
      return true;
    }
  }
  return false;
}
// The nearest ANCESTOR section actually hosting `node` right now — the section whose content wrapper
// `node`'s element lives inside, DOM-wise (main.ts sectionContentEl/place). Only EXPANDED sections count
// (isSection): a collapsed section has no box/wrapper, so it can't host anything. Shared with the edge
// painter so an edge between two cards inside the same section clips to it too.
export function hostSection(node: MindNode): MindNode | null {
  const h = containerHost(node);
  // The OPEN section hosts NOTHING: its children are the top level now, so they go straight under
  // #world, unclipped, and the wrapper it would otherwise own is dropped by paintNode.
  return h && isScopeRoot(h) ? null : h;
}
// …and the same walk WITHOUT that exception: the nearest expanded section ancestor by TREE, wherever the
// node's element actually ended up.
// The OPEN section counts even FOLDED: it is the canvas, and its fold must not hand its cards to a section
// further up.
function containerHost(node: MindNode): MindNode | null {
  for (let p = parentOf(node); p; p = parentOf(p)) {
    if (isSection(p) || isScopeRoot(p)) {
      return p;
    }
  }
  return null;
}
// How many ancestors `node` has (0 for a root). Picks the INNERMOST of several nested, overlapping
// sections — "deepest wins" in every section hit-test (sectionAt below, drag.ts innermostSectionAt).
export function ancestorDepth(node: MindNode): number {
  let d = 0;
  for (let p = parentOf(node); p; p = parentOf(p)) {
    d++;
  }
  return d;
}
// What would HOLD a new card asked to go "in" `id`: that node if it's a section, else the section the node
// sits in — or null (the top level). Cards never hold cards; every create/paste path asks this, so a
// card can't end up with children however the request was phrased.
export function holderOf(id: string | null | undefined): string | null {
  for (let n = id ? state.nodes.get(id) : undefined; n; n = parentOf(n) ?? undefined) {
    if (n.type === 'section') {
      return n.id;
    }
  }
  return null;
}
// The innermost expanded, visible, UNLOCKED section whose box contains the world point (x,y), skipping
// `skip` (the cards being dragged — a section can't be dropped into itself). A locked section takes no
// cards, so a drop over one falls through to the section around it. THE drop
// rule (docs/PRODUCT.md): a card belongs to the section its centre is in, else the top level. Shared by
// the drag preview and the commit, so what lights up is where the card goes.
// A section that takes cards in: expanded, on the canvas, not the open section itself, not locked. Asked by
// the drop test below and by a section settling over what it covers (features/drag.ts settleSections).
export function collectsCards(m: MindNode): boolean {
  return isSection(m) && !isHidden(m) && !isScopeRoot(m) && !isLockedEffective(m);
}
export function sectionAt(x: number, y: number, skip: Set<string>): MindNode | null {
  let best: MindNode | null = null, bestDepth = -1;
  for (const m of state.nodes.values()) {
    if (skip.has(m.id) || !collectsCards(m)) {
      continue;
    }
    const b = containerBox(m);
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) {
      continue;
    }
    const d = ancestorDepth(m);
    if (d > bestDepth) { bestDepth = d; best = m; }
  }
  return best;
}
// A section's INTERIOR rect (absolute world coords, inside its border — its label hangs outside, above) — the single source of truth for "where does this section's content go". Shared by
// main.ts's sectionContentEl (the real DOM clipping wrapper) and the edge painter's clip-path, so the
// two containment mechanisms stay pixel-identical by construction.
export function sectionInterior(f: MindNode): { x: number; y: number; w: number; h: number } {
  // The OPEN section's interior IS the viewport, with no border and no tab to inset from.
  if (isScopeRoot(f)) {
    return scopeRect();
  }
  return {
    x: f.x + SECTION_BORDER, y: f.y + SECTION_BORDER,
    w: Math.max(0, nodeW(f) - SECTION_BORDER * 2),
    h: Math.max(0, nodeH(f) - SECTION_BORDER * 2),
  };
}
// Does this section have anything to put on its label — its own text? A section that hasn't been named
// shows NO label (FigJam's untitled section): its text was deleted, or never written.
export function sectionLabelled(f: MindNode): boolean { return !!(f.title.trim() || f.body.trim()); }
// How far an expanded section's label reaches ABOVE its box (0 for anything else): the pill's measured
// height plus its 7px gap (styles.css `.node.section > .title-row`), or a one-line pill's before paint.
const SECTION_LABEL_GAP = 7;
export function sectionLabelH(f: MindNode): number {
  if (!isSection(f) || !sectionLabelled(f)) {
    return 0;
  }
  const row = f.el?.querySelector(':scope > .title-row') as HTMLElement | null;
  return (row?.offsetHeight || 28) + SECTION_LABEL_GAP;
}
// A section's DESCRIPTION: its note under its name — the text after the `# ` heading, shown as one muted
// line under the title on its label. Only a NAMED section has one: an untitled section's label shows the
// first line of its text, which is its name in all but form, so splitting that again would repeat it.
export function sectionDescription(f: MindNode): string { return f.title.trim() ? f.body.trim() : ''; }
// Is `child`'s centre inside `section`'s OUTER box? The test for "a section child is still in its section",
// the same centre sectionAt is asked about on drop.
export function centreInSection(child: MindNode, section: MindNode): boolean {
  // The OPEN section's interior is the whole canvas, so its children can never leave it.
  if (isScopeRoot(section)) {
    return true;
  }
  const cx = child.x + nodeW(child)/2, cy = child.y + nodeH(child)/2;
  const b = containerBox(section);
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}
// Move a node so its bounds top-left lands at (x,y), carrying its whole subtree with it — what a bare
// `n.x = …` assignment can't do (it would leave a section's children behind, outside the box).
export function moveSubtreeTo(node: MindNode, x: number, y: number): void {
  const dx = x - node.x, dy = y - node.y;
  // Saved positions are integers; ignore sub-pixel nudges so nothing is rewritten for nothing.
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    return;
  }
  for (const id of subtreeIds(node.id)){
    const n = state.nodes.get(id);
    if (!n) {
      continue;
    }
    if (isHidden(n) && !insideSection(n)) {
      continue;
    }
    n.x += dx; n.y += dy; n.dirtyLayout = true;
  }
}
// A parent's child ORDER: STORED (board.json), seeded from reading order (top to bottom, then left to
// right) the first time it's needed, and kept from then on. Nothing on the canvas depends on it — the
// children sit where they were put — but the arrow keys walk siblings in it and the load migration
// lays a former outline out in it (data/migrate.ts foldCardsIntoSections).
function readingOrder(kids: MindNode[]): string[] {
  const tie = (n: MindNode) => n.file || n.title || n.id;
  return kids.slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0))
    .map(k => k.id);
}
export function orderedKids(node: MindNode, kids: MindNode[]): MindNode[] {
  const have = new Set(kids.map(k => k.id));
  let order = (node.kidOrder || []).filter(id => have.has(id));   // drop removed children
  const known = new Set(order);
  const fresh = kids.filter(k => !known.has(k.id));                // new children → append in reading order
  if (fresh.length) {
    order = order.concat(readingOrder(fresh));
  }
  node.kidOrder = order;
  const rank = new Map(order.map((id,i)=>[id,i]));
  return kids.slice().sort((a,b)=>rank.get(a.id)! - rank.get(b.id)!);
}

// What used to re-flow the forest after every change. Nothing is flowed now, so all that's left is
// the open-section bookkeeping, and it stays here because every structural change already ends in this
// call (main.ts relayout/remeasure) — one call covers every path instead of each remembering.
export function applyLayouts(): void {
  // The open section may have just been deleted / undone away / vanished on disk. (An open section keeps
  // its fold: its interior is the canvas either way.)
  pruneScope();
}

