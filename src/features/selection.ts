import { state, setStatus, world } from '../core/state.js';
import { isHidden, hasLockedAncestor } from '../utils/model.js';
import { wearsTags } from '../utils/tags.js';
import { clearEdgeSelection } from './edge-tools.js';
import { paintNode } from '../render.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { syncFloatBar } from './float-bar.js';
import { syncSelFrame } from './sel-frame.js';
import { scheduleUrlSync, updateDocumentTitle } from '../nav/url-state.js';
import { outOfScope } from '../nav/scope.js';

// See "`⌘A` selects everything ON THE CANVAS" in docs/architecture.md.
export function selectAll(): void {
  setSelectionSet([...state.nodes.values()].filter(n => !isHidden(n)).map(n => n.id));
  if (!state.sel.size) {
    setStatus('Nothing to select');
  }
}

export function selectedIds(): string[] { return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }

export const taggableSelection = (): string[] => selectedIds().filter(id => wearsTags(state.nodes.get(id)));

// The one funnel every card-selection path runs through: card and edge selections never coexist.
export function applySelection(): void {
  if (state.sel.size && state.selEdges.size) {
    clearEdgeSelection();
  }

  // Only the rings that change repaint: the new selection, and whatever wears `.sel` in the DOM now.
  const ids = new Set(state.sel);
  world.querySelectorAll<HTMLElement>('.node.sel').forEach(el => {
    if (el.dataset.id) {
      ids.add(el.dataset.id);
    }
  });
  for (const id of ids) {
    const n = state.nodes.get(id);
    if (n) {
      paintNode(n);
    }
  }
  paintFreeEdges(); syncSelFrame(); syncFloatBar(); scheduleUrlSync(); updateDocumentTitle();
}

// Not a locked card's descendant, nor outside the open section (unscoped jumps popScopeFor first).
function isSelectable(id: string): boolean {
  const n = state.nodes.get(id); return !n || (!hasLockedAncestor(n) && !outOfScope(n));
}

// Replace the whole selection with `ids` (a Set or array), recomputing the primary.
export function setSelectionSet(ids: Iterable<string>): void {
  state.sel = new Set([...ids].filter(isSelectable));
  if (state.sel.size === 0) {
    state.selId = null;
  } else if (state.sel.size === 1) {
    state.selId = [...state.sel][0];
  } else if (!state.selId || !state.sel.has(state.selId)) {
    state.selId = [...state.sel].pop() ?? null;
  }
  applySelection();
}

// ⌘/Ctrl-click: add or remove one card from the selection.
export function toggleSel(id: string): void {
  if (state.sel.has(id)){
    state.sel.delete(id);
    if (state.selId === id) {
      state.selId = state.sel.size ? ([...state.sel].pop() ?? null) : null;
    }
  } else {
    if (!isSelectable(id)) {
      return;
    }
    state.sel.add(id); state.selId = id;
  }
  applySelection();
}

// Select exactly one node (or clear with null), replacing any multi-selection.
export function selectNode(id: string | null): void {
  if (id == null){ state.sel.clear(); state.selId = null; }
  else {
    if (!isSelectable(id)) {
      return;
    }
    state.sel = new Set([id]); state.selId = id;
  }
  applySelection();
}
