// ---------- hierarchy helpers ----------
// The tree is DERIVED from each node's `parent` (no stored edge list). These queries
// walk that live structure in state.nodes.
import { state, type MindNode } from '../core/state.js';
import { firstLineLabel, fileStem } from './frontmatter.js';
import { scope } from '../nav/scope.js';

export function childrenOf(id: string | null): MindNode[] {
  return [...state.nodes.values()].filter(n => n.parent === id);
}
export function isRoot(n: MindNode): boolean { return !n.parent || !state.nodes.has(n.parent); }
// The top level in its ONE canonical order — canvas y, then x, with the filename as a stable
// tie-break so the sequence can't reshuffle between two reads of the same map. Roots have no parent
// to hold a kidOrder (unlike orderedKids), so this is what stands in for it: the outline's top-level
// list and the arrow-key walk (main.ts navSiblings) both read it, which is what makes them agree.
// `keep` narrows it — the outline drops annotations and the row being dragged.
export function rootsInOrder(keep?: (n: MindNode) => boolean): MindNode[] {
  return [...state.nodes.values()].filter(n => isRoot(n) && (!keep || keep(n)))
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.file ?? a.title).localeCompare(b.file ?? b.title));
}
// THE ONE VISIBILITY GATE, with two terms — one ancestor walk answering both.
//
//  1. FOLD (persisted, mm_collapsed): `collapsed` on a node hides its CHILDREN but keeps the node
//     itself visible (outliner model), so a node is hidden iff one of its ANCESTORS is collapsed.
//  2. SCOPE (ephemeral, nav/scope.ts): while a frame is OPEN, only what's inside it is on the
//     canvas. Reaching the open frame on the way up means we're inside it; running out of
//     ancestors without reaching it means we're somewhere else in the map — INCLUDING when `n` IS
//     the open frame, which is precisely what stops its box, border, tab and fill from being
//     painted. No per-kind CSS, no second predicate.
//
// Nothing writes through this function. That matters: term 1 is backed by a saved flag while term 2
// must never touch disk, and the only mover keyed on isHidden is layoutSubtree — which applyLayouts
// confines to the current scope, so opening a frame can't dirty a file outside it.
// The open frame is checked BEFORE its own fold: while it's open it IS the canvas, so neither its
// own collapsed flag nor anything above it can hide what's inside — which is also what lets a frame
// buried in a folded branch be opened from a URL and still show its contents.
export function isHidden(n: MindNode): boolean {
  const scopeId = scope.rootId;            // null in the overwhelmingly common case
  let p = n.parent ? state.nodes.get(n.parent) : undefined;
  while (p){
    if (p.id === scopeId) return false;
    if (p.collapsed) return true;
    p = p.parent ? state.nodes.get(p.parent) : undefined;
  }
  return scopeId !== null;
}
// The visible card standing in for n: n itself when it's shown, otherwise its nearest
// ancestor that is still visible. Search uses this to highlight the first visible parent
// containing a match that's buried inside a collapsed branch.
export function firstVisible(n: MindNode): MindNode {
  if (!isHidden(n)) return n;
  let p = n.parent ? state.nodes.get(n.parent) : undefined;
  while (p){
    if (!isHidden(p)) return p;
    p = p.parent ? state.nodes.get(p.parent) : undefined;
  }
  // A root is always visible, so the walk resolves — EXCEPT for a node outside the open frame,
  // whose ancestors are hidden all the way up. Search filters those out before it ever asks
  // (features/search.ts), so the fallback is only a backstop, not a case anyone relies on.
  return n;
}
export function descendantCount(id: string): number {
  let c = 0; for (const ch of childrenOf(id)) c += 1 + descendantCount(ch.id); return c;
}
// A node whose lock cascades down: any ANCESTOR (not itself) is locked. Such a node can't even be
// selected — only the locked card itself remains selectable (see isLockedEffective below).
export function hasLockedAncestor(n: MindNode): boolean {
  let p = n.parent ? state.nodes.get(n.parent) : undefined;
  while (p){
    if (p.locked) return true;
    p = p.parent ? state.nodes.get(p.parent) : undefined;
  }
  return false;
}
// A node protected from move/collapse-toggle/edit/delete: it's locked itself, or a descendant of a
// locked ancestor. Selection is a narrower check (hasLockedAncestor alone) — the locked card itself
// stays selectable, just not editable.
export function isLockedEffective(n: MindNode): boolean { return n.locked || hasLockedAncestor(n); }
// Locked somewhere in id's own subtree (itself or any descendant) — used to refuse deleting a whole
// branch that contains a locked card, even when the branch's root itself isn't locked.
export function subtreeHasLocked(id: string): boolean {
  const n = state.nodes.get(id);
  if (n?.locked) return true;
  return childrenOf(id).some(ch => subtreeHasLocked(ch.id));
}
// The set of titles already in use (lowercased + trimmed), optionally excluding one node.
// Filenames collide case-insensitively on macOS/Windows, so collision checks compare lowercased.
// Shared by the rename validator (inline-edit) and the unique-name minter (crud).
// The name to SHOW for a node ANYWHERE the card itself isn't — the outline, search results, a status
// line, a wikilink target, the move picker. A card may be untitled (no `# ` heading, see
// utils/frontmatter.ts splitHeading), and on the canvas that's the point: it shows its text and no
// title row. But a LIST row can't be blank, so it falls back through what it does have: its first line,
// then its FILENAME — which is where the title lived before this format, so a note nobody has migrated
// still reads correctly here. The literal "Untitled" is the end of that chain and should be unreachable
// in practice: a body-less note is seeded from its filename at load and a never-typed new card is
// discarded, so only a node with no text and no file yet — one that exists for a few milliseconds
// mid-create — can reach it. Purely for display: n.title stays '' throughout and nothing here is written.
export function nodeLabel(n: MindNode): string {
  return n.title.trim() || firstLineLabel(n.body).title || fileStem(n.file ?? '') || 'Untitled';
}
// …and the label with its PARENT appended, but only where the label alone is ambiguous. Two cards may
// share a title now, and in a FLAT list (search hits, a query card's results) two identical rows give
// you no way to tell which is which. The outline needs none of this: its indentation already says where
// a row sits. The suffix is the parent rather than the filename because "which one" is a question about
// the map, not about the disk — the file's ` 2` would answer it in bookkeeping nobody chose.
export function disambiguatedLabel(n: MindNode): string {
  const label = nodeLabel(n);
  for (const o of state.nodes.values()){
    if (o === n || nodeLabel(o) !== label) continue;
    const p = n.parent ? state.nodes.get(n.parent) : null;
    return p ? `${label} — ${nodeLabel(p)}` : label;
  }
  return label;
}
// guard against cycles when re-parenting
export function isAncestor(maybeAncestorId: string, nodeId: string): boolean {
  let p = state.nodes.get(nodeId);
  p = p && p.parent ? state.nodes.get(p.parent) : undefined;
  while (p){ if (p.id === maybeAncestorId) return true; p = p.parent ? state.nodes.get(p.parent) : undefined; }
  return false;
}
