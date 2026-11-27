// Section geometry (box, interior, which section a point falls in) and the absolute ↔ relative position
// bridge. Nothing here places cards: they sit where they were put.
import { state, isStack, type MindNode } from '../core/state.js';
import { childrenOf, isHidden, parentOf, ancestors, isLockedEffective, subtreeIds } from '../utils/model.js';
import { isScopeRoot, pruneScope, scopeRect } from '../nav/scope.js';
import { layoutH, nodeH, nodeRect, nodeW, SECTION_BORDER } from './geometry.js';
import { centreOf, contains, deepestAt } from '../utils/rect.js';
import { layStacks } from './pile.js';
import { firstLineLabel } from '../utils/frontmatter.js';

// x/y (absolute) → rx/ry (offset from the parent, what board.json stores). Run before every save, so any
// mover of a parent restales its children's offsets without having to remember to.
export function commitRel(): void {
  for (const n of state.nodes.values()) {
    const p = parentOf(n);
    n.rx = n.x - (p ? p.x : 0); n.ry = n.y - (p ? p.y : 0);
  }
}

// A section's children are inside its box, so it isn't descended into; its label above it counts.
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
// Infinite when none of them shows.
export function subtreesBox(nodes: Iterable<MindNode>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const b = subtreeBox(n);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}
// An expanded section box: not folded to its pill, not drawn as a stack.
export function isSection(node: MindNode): boolean {
  return node.type === 'section' && !node.collapsed && !isStack(node);
}
// The open section's box is the viewport, derived without touching its authored f.w/f.h.
export function containerBox(f: MindNode): { x: number; y: number; w: number; h: number } {
  if (isScopeRoot(f)) {
    return scopeRect();
  }
  return { x: f.x, y: f.y, w: nodeW(f), h: nodeH(f) };
}
// A folded section counts too: its hidden contents must move with it.
function insideSection(node: MindNode): boolean {
  for (const p of ancestors(node)) {
    if (p.type === 'section') {
      return true;
    }
  }
  return false;
}
// The section whose content wrapper holds `node`'s element. The open section hosts nothing: its children
// are the top level.
export function hostSection(node: MindNode): MindNode | null {
  const h = containerHost(node);
  return h && isScopeRoot(h) ? null : h;
}
// The open section counts even folded (it is the canvas). A stack's cards show only fanned out, unclipped.
function containerHost(node: MindNode): MindNode | null {
  for (let p = parentOf(node); p; p = parentOf(p)) {
    if (isStack(p)) {
      return null;
    }
    if (isSection(p) || isScopeRoot(p)) {
      return p;
    }
  }
  return null;
}
// "Deepest wins" in every section hit-test.
export function ancestorDepth(node: MindNode): number {
  let d = 0;
  for (let p = parentOf(node); p; p = parentOf(p)) {
    d++;
  }
  return d;
}
// Where a new card asked to go "in" `id` lands: cards never hold cards, so the nearest section or the top level.
export function holderOf(id: string | null | undefined): string | null {
  for (let n = id ? state.nodes.get(id) : undefined; n; n = parentOf(n) ?? undefined) {
    if (n.type === 'section') {
      return n.id;
    }
  }
  return null;
}
export function collectsCards(m: MindNode): boolean {
  return isSection(m) && !isHidden(m) && !isScopeRoot(m) && !isLockedEffective(m);
}

// THE drop rule, shared by the drag preview and the commit. `skip`: the dragged cards.
export function sectionAt(x: number, y: number, skip: Set<string>): MindNode | null {
  return deepestAt(state.nodes.values(), { x, y }, m => skip.has(m.id) || !collectsCards(m) ? null : containerBox(m), ancestorDepth);
}
// Inside the border. The single source for the DOM clipping wrapper and the edge clip-path alike.
export function sectionInterior(f: MindNode): { x: number; y: number; w: number; h: number } {
  if (isScopeRoot(f)) {
    return scopeRect();
  }
  return {
    x: f.x + SECTION_BORDER, y: f.y + SECTION_BORDER,
    w: Math.max(0, nodeW(f) - SECTION_BORDER * 2),
    h: Math.max(0, nodeH(f) - SECTION_BORDER * 2),
  };
}
export function sectionLabelled(f: MindNode): boolean { return !!(f.title.trim() || f.body.trim()); }
// How far an expanded section's label reaches above its box.
const SECTION_LABEL_GAP = 7;   // styles.css `.node.section > .title-row`
const ONE_LINE_LABEL_H = 28;
export function sectionLabelH(f: MindNode): number {
  if (!isSection(f) || !sectionLabelled(f)) {
    return 0;
  }
  const row = f.el?.querySelector(':scope > .title-row') as HTMLElement | null;
  return (row?.offsetHeight || ONE_LINE_LABEL_H) + SECTION_LABEL_GAP;
}
// The `# ` title, else the first line; the rest of the note is kept but unshown.
export function sectionName(f: MindNode): string { return f.title.trim() || firstLineLabel(f.body); }
export function centreInSection(child: MindNode, section: MindNode): boolean {
  if (isScopeRoot(section)) {
    return true;
  }
  return contains(containerBox(section), centreOf(nodeRect(child)));
}
// A bare `n.x = …` would leave a section's children behind.
export function moveSubtreeTo(node: MindNode, x: number, y: number): void {
  const dx = x - node.x, dy = y - node.y;
  // Saved positions are integers: a sub-pixel nudge would rewrite for nothing.
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
    n.x += dx; n.y += dy;
  }
}
// Children not yet in the stored order join it top-to-bottom, then left-to-right. Only the arrow keys and
// the load migration read the order; nothing on the canvas does.
function readingOrder(kids: MindNode[]): string[] {
  const tie = (n: MindNode) => n.file || n.title || n.id;
  return kids.slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0))
    .map(k => k.id);
}
export function orderedKids(node: MindNode, kids: MindNode[]): MindNode[] {
  const have = new Set(kids.map(k => k.id));
  let order = (node.kidOrder || []).filter(id => have.has(id));
  const known = new Set(order);
  const fresh = kids.filter(k => !known.has(k.id));
  if (fresh.length) {
    order = order.concat(readingOrder(fresh));
  }
  node.kidOrder = order;
  const rank = new Map(order.map((id,i)=>[id,i]));
  return kids.slice().sort((a,b)=>rank.get(a.id)! - rank.get(b.id)!);
}

// Bookkeeping every structural change ends in. Returns whether it can have changed what is drawn, so
// remeasure knows whether its second paint is needed.
export function applyLayouts(): boolean {
  const pruned = pruneScope();   // the open section may have just gone
  const stacks = layStacks();
  return pruned || stacks;
}

