// Load-time migrations of older maps.
import { state, type MindNode } from '../core/state.js';
import { childrenOf, ancestors, parentOf } from '../utils/model.js';
import { makeEdge } from './board.js';
import { arrangeSections } from './arrange.js';

// A card that still holds cards on disk opens as a section holding them (only its `mm_type` changes), and
// the old outline rows are laid out once. A no-op once done; a failed save simply migrates again.
// See "Cards are flat; a SECTION is the only container" in docs/architecture.md.
export function foldCardsIntoSections(): number {
  const cards = [...state.nodes.values()].filter(n => n.type === 'card' && childrenOf(n.id).length);
  if (!cards.length) {
    return 0;
  }
  const was = new Set(cards.map(n => n.id));
  const arrange = [...state.nodes.values()].filter(n => childrenOf(n.id).length
    && (was.has(n.id) || [...ancestors(n)].some(a => was.has(a.id))));
  for (const n of cards) { n.type = 'section'; n.dirty = true; }
  arrangeSections(arrange);
  return cards.length;
}
// Pre-containment maps meant a card-to-card `mm_parent` as "beside it, joined by a line": each such child
// becomes a card in its nearest section (or top-level) where it already renders, plus a drawn edge.
// Anything this would visibly change stays nested: children of a legacy stack, of a section, or under a
// collapsed ancestor. See docs/archive/spec-edges-and-containment.md. Returns how many were converted.
export function flattenLegacyBranches(wasStack: Set<string>): number {
  // Read off `wasStack`: the stack kind has already folded to `card` (foldTypeLayout).
  const outlined = new Set<string>();
  const wasOutlined = (n: MindNode): boolean => {
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (wasStack.has(p.id)) {
        return true;
      }
      if (p.type !== 'card' && p.type !== 'section') {
        return false;
      }
    }
    return false;
  };
  for (const n of state.nodes.values()) {
    if (wasOutlined(n)) {
      outlined.add(n.id);
    }
  }
  const collapsedAbove = (n: MindNode): boolean => {
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (p.collapsed) {
        return true;
      }
    }
    return false;
  };
  const containerAbove = (n: MindNode): MindNode | null => {
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (p.type === 'section') {
        return p;
      }
    }
    return null;
  };
  let made = 0;
  for (const n of [...state.nodes.values()]) {
    const p = parentOf(n);
    if (!p || p.type !== 'card') {
      continue;
    }
    if (outlined.has(n.id) || collapsedAbove(n)) {
      continue;
    }
    const host = containerAbove(n);
    n.parent = host ? host.id : null;
    n.rx = n.x - (host ? host.x : 0);
    n.ry = n.y - (host ? host.y : 0);
    n.dirty = true;
    state.edges.push(makeEdge(p.id, n.id));
    made++;
  }
  return made;
}
