// ---------- laying out the cards of sections that arrived without positions ----------
import { type MindNode, state } from '../core/state.js';
import { MIN_SECTION_W, nodeW, SECTION_BORDER, nodeH, snapPt } from '../view/geometry.js';
import { childrenOf, ancestors } from '../utils/model.js';
import { scope } from '../nav/scope.js';
import { dataHooks } from './hooks.js';
import { ancestorDepth, orderedKids, sectionLabelH, moveSubtreeTo } from '../view/layout.js';
import { SPACING } from '../utils/guides.js';

// Lay each section's cards out ONCE, in a column in their stored order (kidOrder), with the house spacing,
// and size the section around them. Deepest first, so an inner section has its final size before its parent
// stacks it. That needs MEASURED heights, so every affected node is unfolded and painted for the
// duration (scope set aside too: on a reload its ids are still the previous load's, and it would hide
// everything), then folded back exactly as it was.
// With `fresh` (the notes that arrived with no position), a section that ALSO holds placed cards keeps
// them where they are — nothing moves on its own — and its new arrivals stack in a column of their own
// just right of them (or from its top-left corner when it holds nothing yet), the section growing to hold it. That is how a note saved into the Inbox folder from
// the phone shows up (docs/inbox.md).
export function arrangeSections(sections: MindNode[], fresh?: Set<string>): void {
  if (!sections.length) {
    return;
  }
  const unfolded = new Set<MindNode>();
  for (const f of sections) {
    for (const a of [f, ...ancestors(f)]) {
      if (a.collapsed) { a.collapsed = false; unfolded.add(a); }
    }
  }
  const keepScope = scope.rootId; scope.rootId = null;
  for (const n of state.nodes.values()) {
    dataHooks.paintNode(n);
  }
  for (const f of sections.sort((a, b) => ancestorDepth(b) - ancestorDepth(a))) {
    // A section that was already placed (an Inbox you made) is never resized: what arrives in it stacks
    // inside its box from the top-left, over its cards if need be. One that arrived with its notes is
    // sized around them.
    const keep = !!fresh && !fresh.has(f.id);
    const kids = orderedKids(f, childrenOf(f.id));
    const x = f.x + SECTION_BORDER + SPACING;
    let y = f.y + SECTION_BORDER + SPACING, w = 0;
    for (const k of keep ? kids.filter(k => fresh.has(k.id)) : kids) {
      y += sectionLabelH(k);   // a section's label hangs above its box — leave it room
      moveSubtreeTo(k, x, y);
      y += nodeH(k) + SPACING;
      w = Math.max(w, nodeW(k));
    }
    if (!keep) {
      const end = snapPt({ x: x + w + SPACING + SECTION_BORDER, y: y + SECTION_BORDER });
      f.w = Math.max(MIN_SECTION_W, end.x - f.x);
      f.h = end.y - f.y;
      dataHooks.paintNode(f);
    }
  }
  scope.rootId = keepScope;
  for (const a of unfolded) {
    a.collapsed = true;
  }
}
