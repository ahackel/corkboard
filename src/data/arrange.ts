// Laying out the cards of sections that arrived without positions.
import { type MindNode, state } from '../core/state.js';
import { MIN_SECTION_W, nodeW, SECTION_BORDER, nodeH, snapPt } from '../view/geometry.js';
import { childrenOf, ancestors } from '../utils/model.js';
import { scope } from '../nav/scope.js';
import { dataHooks } from './hooks.js';
import { ancestorDepth, orderedKids, sectionLabelH, moveSubtreeTo } from '../view/layout.js';
import { SPACING } from '../utils/guides.js';

// Each section's cards in one column, sized around them, deepest section first. Needs measured heights, so
// everything is unfolded and painted meanwhile (scope set aside: on a reload it holds stale ids). With
// `fresh`, an already-placed section keeps its cards and only the arrivals stack (the phone inbox).
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
    // An already-placed section is never resized.
    const keep = !!fresh && !fresh.has(f.id);
    const kids = orderedKids(f, childrenOf(f.id));
    const x = f.x + SECTION_BORDER + SPACING;
    let y = f.y + SECTION_BORDER + SPACING, w = 0;
    for (const k of keep ? kids.filter(k => fresh.has(k.id)) : kids) {
      y += sectionLabelH(k);
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
