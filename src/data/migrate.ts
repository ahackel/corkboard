// ---------- load-time migrations of older maps ----------
import { state, type MindNode } from '../core/state.js';
import { childrenOf, ancestors, parentOf } from '../utils/model.js';
import { makeEdge } from './board.js';
import { arrangeFrames } from './load.js';

// ---------- cards that hold cards become frames (runs on every load; a no-op once done) ----------
// A card used to OUTLINE its children inside its own box — rows, indented by depth, with checklist
// ticks. That model is gone (docs/PRODUCT.md: cards are flat, frames are the only container), so a
// card that still has children on disk opens as a FRAME holding them: its title is the frame's tab,
// its note the frame's description, its children cards inside it. Nothing is lost or re-parented —
// only `mm_type` changes, on the card itself.
// Where its children SIT has to be decided, though: their saved positions were the outliner's rows,
// laid out by the app, and a frame shows its children where they are. So each converted frame — and
// any frame that was itself drawn as a row inside one — lays its cards out ONCE, in a column in their
// old order (kidOrder), with the house spacing, and sizes itself around them. Deepest first, so an
// inner frame has its final size before its parent stacks it. That needs MEASURED heights, so every
// affected node is unfolded and painted for the duration (scope set aside too: on a reload its ids
// are still the previous load's, and it would hide everything), then folded back exactly as it was.
// Pure function of what's on disk, so a failed save simply migrates again next time.
export function foldCardsIntoFrames(): number {
  const cards = [...state.nodes.values()].filter(n => n.type === 'card' && childrenOf(n.id).length);
  if (!cards.length) return 0;
  const was = new Set(cards.map(n => n.id));
  const arrange = [...state.nodes.values()].filter(n => childrenOf(n.id).length
    && (was.has(n.id) || [...ancestors(n)].some(a => was.has(a.id))));
  for (const n of cards) { n.type = 'frame'; n.dirty = true; n.dirtyLayout = true; }
  arrangeFrames(arrange);
  return cards.length;
}
// ---------- the containment migration (runs once per map) ----------
// A map written before containment (board.json missing, or its `model` below BOARD_MODEL) holds
// card-to-card `mm_parent` links that meant "this card sits BESIDE that one, joined by a branch
// line". Under containment the same link means "inside it, as an outline row" — so loading such a
// map unchanged would re-flow it into nested boxes and nothing would be where the user left it.
//
// So convert instead: each of those children becomes a TOP-LEVEL card at the absolute position it
// already renders at, and the branch it used to have becomes a drawn edge. The map looks IDENTICAL
// on first open; what it loses is collapse on those groups, which the user gets back deliberately by
// nesting a group again. See docs/spec-edges-and-containment.md.
//
// Four things are deliberately NOT flattened, each because flattening it would CHANGE what you see:
//   · a child of a legacy STACK (or of anything inside one) — it was already drawn inside its parent.
//   · a child of a FRAME — the frame is a container in both models, and pulling its contents out
//     would empty the box. A card flattened out of a branch INSIDE a frame re-anchors to that frame,
//     not to the world, for the same reason.
//   · anything under a COLLAPSED ancestor — those children are invisible right now, and making them
//     top-level would pop the whole hidden subtree onto the canvas. Left nested, a collapsed branch
//     looks exactly as it did, and expanding it simply reveals the new outline.
// Returns how many branches were converted.
export function flattenLegacyBranches(wasStack: Set<string>): number {
  // Which nodes were OUTLINED by a legacy stack — the old insideStack, read off `wasStack` because
  // the kind itself has already folded to `card` by now (utils/frontmatter.ts foldTypeLayout).
  const outlined = new Set<string>();
  const wasOutlined = (n: MindNode): boolean => {
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (wasStack.has(p.id)) return true;
      if (p.type !== 'card' && p.type !== 'frame') return false;
    }
    return false;
  };
  for (const n of state.nodes.values()) if (wasOutlined(n)) outlined.add(n.id);
  const collapsedAbove = (n: MindNode): boolean => {
    for (let p = parentOf(n); p; p = parentOf(p)) if (p.collapsed) return true;
    return false;
  };
  // The container this card should belong to once its branch is cut: the nearest FRAME above it, or
  // the world. Never a card — that is the whole point of the migration.
  const containerAbove = (n: MindNode): MindNode | null => {
    for (let p = parentOf(n); p; p = parentOf(p)) if (p.type === 'frame') return p;
    return null;
  };
  let made = 0;
  for (const n of [...state.nodes.values()]) {
    const p = parentOf(n);
    if (!p || p.type !== 'card') continue;          // roots, and frame children, stay as they are
    if (outlined.has(n.id) || collapsedAbove(n)) continue;
    const host = containerAbove(n);
    n.parent = host ? host.id : null;
    // x/y are already absolute and final; re-derive the stored offset against the NEW anchor so the
    // card writes back exactly where it renders.
    n.rx = n.x - (host ? host.x : 0);
    n.ry = n.y - (host ? host.y : 0);
    n.dirty = true; n.dirtyLayout = true;
    state.edges.push(makeEdge(p.id, n.id));
    made++;
  }
  return made;
}
