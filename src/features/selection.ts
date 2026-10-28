// ---------- selection: which cards are selected, and the one funnel that repaints it ----------
import { state, setStatus, world } from '../core/state.js';
import { isHidden, hasLockedAncestor } from '../utils/model.js';
import { wearsTags } from '../utils/tags.js';
import { clearEdgeSelection } from './edge-tools.js';
import { paintNode } from '../main.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { syncFloatBar } from './float-bar.js';
import { syncUrl, updateDocumentTitle } from '../nav/url-state.js';
import { outOfScope } from '../nav/scope.js';

// Select everything ON THE CANVAS — which, inside an open frame, is that frame's contents and nothing
// else. It needs no scope test of its own: isHidden already means "on the canvas right now", covering
// both the open frame and folded branches, and setSelectionSet drops whatever isn't selectable (a
// locked card's descendants). Shared by ⌘A and the canvas context menu, so the two can't diverge.
export function selectAll(): void {
  setSelectionSet([...state.nodes.values()].filter(n => !isHidden(n)).map(n => n.id));
  setStatus(state.sel.size ? `Selected ${state.sel.size} card${state.sel.size > 1 ? 's' : ''}` : 'Nothing to select');
}
// the ids currently being edited (one or many) — colour and lock apply to all of them
export function selectedIds(): string[] { return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }
// …the ones of them that can wear tags (no frames).
export const taggableSelection = (): string[] => selectedIds().filter(id => wearsTags(state.nodes.get(id)));
// reflect state.sel in the canvas + the floating edit bar (features/float-bar.ts)
// Selecting a CARD ends any edge selection — the two never coexist (core/state.ts selEdges). Enforced
// here, at the one funnel every card-selection path runs through, rather than at each of them.
// Only the cards whose ring changes repaint — the ones wearing it now (`.sel` in the DOM, so it can't go
// stale) and the new selection. A click used to repaint the whole map. A mutation that also selects
// still ends in its own relayout()/remeasure().
export function applySelection(): void {
  if (state.sel.size && state.selEdges.size) {
    clearEdgeSelection();
  }
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
  paintFreeEdges(); syncFloatBar(); syncUrl(); updateDocumentTitle();
}
// A descendant of a locked card can't be selected at all — the locked card itself still can be
// (see utils/model.ts hasLockedAncestor). Nor can anything outside the frame you're standing in:
// it isn't on the canvas, so a selection ring would be invisible and every action on it would look
// dead. The deliberately unscoped jumps (wikilinks, query results, undo) come out of their scope
// first — see popScopeFor. Shared by every selection entry point below.
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
