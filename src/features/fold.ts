// ---------- folding: a card to its chip, a frame to its pill ----------
import { state, setStatus, type MindNode } from '../core/state.js';
import { isLockedEffective, isHidden, nodesOf, nodeLabel, subtreeIds } from '../utils/model.js';
import { canFold, canToggleFold } from '../view/geometry.js';
import { setSelectionSet, animateLayout } from '../main.js';
import { afterReading } from '../data/lazy.js';
import { record } from './history.js';
import { syncFloatBar } from './float-bar.js';
import { scheduleSave } from '../data/persistence.js';
import { outOfScope } from '../nav/scope.js';

// Toggle one node's collapse: folds it down to just its title — hides its body and, if it has
// children, folds them (and everything below) too. A leaf with a body can fold its body alone.
export function toggleCollapse(id: string): void {
  const n = state.nodes.get(id);
  if (!n) {
    return;
  }
  if (isLockedEffective(n)) {
    setStatus('Locked — can’t collapse/expand');
    return;
  }
  if (canFold(n)) {
    applyCollapsed([n], !n.collapsed);
  }
}

// A frame folded around selected cards takes them off the canvas — and out of the selection, so no key
// or bar acts on cards you can't see.
function dropHiddenFromSelection(): void {
  const shown = [...state.sel].filter(id => {
    const m = state.nodes.get(id);
    return !m || !isHidden(m);
  });
  if (shown.length !== state.sel.size) {
    setSelectionSet(shown);
  }
}
// Fold/unfold a whole set of cards together (double-clicking one card of a multi-selection).
// Only foldable cards (children or a body) count; the group lands on one shared state — expand
// if they're all collapsed already, otherwise collapse them all.
// Which of `ids` can actually be folded — the one filter both the toggling and the directional paths
// below share, so the chip, X and ←/→ can't disagree about what counts.
function foldableSelection(ids: Iterable<string>): MindNode[] {
  return nodesOf(ids).filter(n => canFold(n) && !isLockedEffective(n));
}

// Apply one shared fold state to a whole set, as ONE undo step and one animated reflow. Unfolding a
// frame whose notes are still on disk reads them first (data/lazy.ts).
function applyCollapsed(cards: MindNode[], collapsed: boolean): void {
  if (!collapsed && afterReading(cards.map(n => n.id), () => applyCollapsed(cards, false), false)) return;
  record(cards.map(n => n.id),
    () => animateLayout(() => { for (const n of cards){ n.collapsed = collapsed; n.dirtyLayout = true; } }));
  dropHiddenFromSelection();
  syncFloatBar();   // its fold button shows the state a click would make
  scheduleSave();
  const what = cards.length > 1 ? `${cards.length} notes` : `“${nodeLabel(cards[0]!)}”`;
  setStatus(`${collapsed ? 'Collapsed' : 'Expanded'} ${what}`);
}
export function toggleCollapseSelection(ids: Iterable<string>): void {
  const cards = foldableSelection(ids);
  if (!cards.length) return;
  applyCollapsed(cards, !cards.every(n => n.collapsed));   // all collapsed → expand; else collapse all
}
// What "Collapse/Expand all" (⌘P) act on: the selected frames and everything inside them when frames
// are selected, else every frame and card in the place you're looking at (the open frame's interior, or
// the map) — cards tucked inside a folded frame included, so Expand all brings back the whole lot. Never
// the open node itself: it's the canvas.
export function foldScope(): MindNode[] {
  const frames = nodesOf(state.sel).filter(n => n.type === 'frame');
  const pool = frames.length
    ? frames.flatMap(f => nodesOf(subtreeIds(f.id)))
    : [...state.nodes.values()].filter(n => !outOfScope(n));
  return pool.filter(canToggleFold);
}
// Expand all brings back the WHOLE lot, so every folded frame in reach is read to the bottom first
// (data/lazy.ts) — and the set is taken again after, since what was read holds more to unfold.
export function expandAll(): void {
  const go = (): void => setCollapsedSelection(foldScope().map(n => n.id), false);
  if (!afterReading(foldScope().map(n => n.id), go)) go();
}
// The DIRECTIONAL form, for ←/→: fold (or unfold) every selected card that isn't already there, and
// leave the ones that are alone — so pressing → twice can't fold what it just unfolded, and a mixed
// selection lands on one state in a single press instead of needing two.
export function setCollapsedSelection(ids: Iterable<string>, collapsed: boolean): void {
  const cards = foldableSelection(ids).filter(n => !!n.collapsed !== collapsed);
  if (!cards.length) return;
  applyCollapsed(cards, collapsed);
}
