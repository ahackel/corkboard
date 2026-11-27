// Folding: a card to its chip, a section to its pill.
import { state, setStatus, type MindNode } from '../core/state.js';
import { isLockedEffective, isHidden, nodesOf, subtreeIds } from '../utils/model.js';
import { canFold, canToggleFold } from '../view/geometry.js';
import { animateLayout } from '../layout-anim.js';
import { afterReading } from '../data/lazy.js';
import { record } from './history.js';
import { syncFloatBar } from './float-bar.js';
import { outOfScope } from '../nav/scope.js';
import { setSelectionSet } from './selection.js';
import { scheduleSave } from '../data/save.js';

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

// No key or bar may act on cards a fold just took off the canvas.
function dropHiddenFromSelection(): void {
  const shown = [...state.sel].filter(id => {
    const m = state.nodes.get(id);
    return !m || !isHidden(m);
  });
  if (shown.length !== state.sel.size) {
    setSelectionSet(shown);
  }
}

// Shared by the toggle and the ←/→ paths, so the chip, X and the arrows agree on what counts.
function foldableSelection(ids: Iterable<string>): MindNode[] {
  return nodesOf(ids).filter(n => canFold(n) && !isLockedEffective(n));
}

// One undo step and one animated reflow; unfolding reads a lazy section's notes first.
function applyCollapsed(cards: MindNode[], collapsed: boolean): void {
  if (!collapsed && afterReading(cards.map(n => n.id), () => applyCollapsed(cards, false), false)) {
    return;
  }
  record(cards.map(n => n.id),
    () => animateLayout(() => { for (const n of cards){ n.collapsed = collapsed; } }));
  dropHiddenFromSelection();
  syncFloatBar();
  scheduleSave();
}

export function toggleCollapseSelection(ids: Iterable<string>): void {
  const cards = foldableSelection(ids);
  if (!cards.length) {
    return;
  }
  const allCollapsed = cards.every(n => n.collapsed);
  applyCollapsed(cards, !allCollapsed);
}

// What "Collapse/Expand all" act on: the selected sections' subtrees, else everything in scope —
// folded contents included, never the open section itself.
export function foldScope(): MindNode[] {
  const sections = nodesOf(state.sel).filter(n => n.type === 'section');
  const pool = sections.length
    ? sections.flatMap(f => nodesOf(subtreeIds(f.id)))
    : [...state.nodes.values()].filter(n => !outOfScope(n));
  return pool.filter(canToggleFold);
}

// The scope is taken again after reading, since what was read holds more to unfold.
export function expandAll(): void {
  const go = (): void => setCollapsedSelection(foldScope().map(n => n.id), false);
  if (!afterReading(foldScope().map(n => n.id), go)) {
    go();
  }
}

// Directional (←/→): only the cards not already there, so pressing twice can't undo itself.
export function setCollapsedSelection(ids: Iterable<string>, collapsed: boolean): void {
  const cards = foldableSelection(ids).filter(n => !!n.collapsed !== collapsed);
  if (!cards.length) {
    return;
  }
  applyCollapsed(cards, collapsed);
}
