import { type MindNode, state, setStatus } from '../core/state.js';
import { containerBox } from '../view/layout.js';
import { stageSize, cancelViewAnim, jumpViewTo } from '../view/camera.js';
import { scope, type ScopeBack, type ScopeLevel, openPathTo, isScopeRoot, outOfScope, canOpen, scopeActive, scopeRootNode } from './scope.js';
import { nodeLabel, nodeByFile } from '../utils/model.js';
import { endInPlaceEdit } from '../features/inline-edit.js';
import { remeasure } from '../render.js';
import { syncUrl } from './url-state.js';
import { afterReading } from '../data/lazy.js';
import { renderCrumbs } from '../features/breadcrumbs.js';
import { syncCanvasBackground } from '../features/canvas-color.js';
import { focusScope } from './focus.js';
import { setSelectionSet, selectNode } from '../features/selection.js';
import { scheduleSave } from '../data/save.js';

// Opening and leaving sections; nav/scope.ts holds the model.

// A SNAPSHOT of the viewport at k = 1, anchored at the section's origin so opening moves nothing. Not live
// (where a drop lands mustn't depend on panning); no bottomInset (it tracks the selection).
function scopeRectFor(t: MindNode): { x: number; y: number; w: number; h: number } {
  const home = containerBox(t);   // read before the level is pushed: the section's real bounds
  const s = stageSize();
  return { x: home.x, y: home.y, w: s.width, h: s.height };
}
// The anchor is kept: the open section can't move.
function refreshScopeRect(): boolean {
  const top = scope.stack[scope.stack.length - 1];
  if (!top) {
    return false;
  }
  const s = stageSize();
  if (Math.round(top.rect.w) === Math.round(s.width) && Math.round(top.rect.h) === Math.round(s.height)) {
    return false;
  }
  top.rect = { x: top.rect.x, y: top.rect.y, w: s.width, h: s.height };
  return true;
}
function currentBack(): ScopeBack { return { view: { ...state.view }, sel: [...state.sel], selId: state.selId }; }

// The stack IS the crumb path: the whole openable ancestor chain. Surviving levels keep their camera;
// levels nobody stepped through get no `back` and are re-fitted.
function setScopeStack(target: MindNode | null, back: ScopeBack | null): void {
  if (!target) { scope.stack = []; scope.rootId = null; return; }
  const keep = new Map(scope.stack.map(l => [l.rootId, l]));
  const next: ScopeLevel[] = [];
  for (const n of [...openPathTo(target), target]) {
    next.push(keep.get(n.id) ?? { rootId: n.id, file: n.file ?? null, rect: scopeRectFor(n), back: null });
  }
  const top = next[next.length - 1]!;
  if (!keep.has(top.rootId)) {
    top.back = back;
  }
  scope.stack = next;
  scope.rootId = target.id;
}

interface ScopeOpts { back?: ScopeBack | null; restore?: ScopeBack | null; exiting?: boolean; camera?: boolean; }
function applyScope(target: MindNode | null, opts: ScopeOpts = {}): void {
  // Re-parenting elements would drop a captured pointer or blur an open editor.
  endInPlaceEdit();
  cancelViewAnim();
  const before = scope.rootId;
  setScopeStack(target, opts.back ?? null);
  // The cached host wrapper may be the one paintNode is about to remove.
  for (const n of state.nodes.values()) {
    n.hostSectionId = undefined;
  }
  refreshScopeRect();
  remeasure();
  if (opts.exiting) {
    // Selecting the section you came out of is what makes a crumb read as a back button.
    const came = before ? state.nodes.get(before) : undefined;
    const ids = came && !outOfScope(came) ? [came.id]
      : (opts.restore?.sel ?? []).filter(id => { const n = state.nodes.get(id); return !!n && !outOfScope(n); });
    setSelectionSet(ids);
    if (opts.restore) {
      jumpViewTo(opts.restore.view.x, opts.restore.view.y, opts.restore.view.k);
    } else if (opts.camera !== false) {
      focusScope(true);
    }
  } else {
    selectNode(null);            // the section itself is off the canvas now
    if (opts.camera !== false) {
      focusScope(true);
    }
  }
  syncUrl();
  if (before !== scope.rootId) {
    scheduleSave();
  }
}

// Allowed on a locked section: looking inside isn't changing it.
export function openSection(target: MindNode | undefined): void {
  const t = target;
  if (!t || !canOpen(t)) { setStatus('Only a section can be opened'); return; }
  if (afterReading([t.id], () => openSection(t), false)) {
    return;
  }
  const back = currentBack();
  // Pure navigation: writes no node field, so a folded section stays folded.
  if (isScopeRoot(t)) {
    return;
  }
  applyScope(t, { back });
}
// Leaves the innermost level and every synthesized level (no `back`) beneath it: you were never in those.
export function exitScope(): void {
  let d = scope.stack.length - 1;
  while (d > 0 && scope.stack[d - 1]!.back === null) {
    d--;
  }
  goToScopeDepth(d);
}
// Leaves the level AT `depth`: depth 0 is the whole map. A crumb click is exactly this.
export function goToScopeDepth(depth: number): void {
  if (depth < 0 || depth >= scope.stack.length) {
    return;
  }
  const leaving = scope.stack[depth]!;
  const upId = depth > 0 ? scope.stack[depth - 1]!.rootId : null;
  // The outermost level left that recorded a camera: where the user was before the whole excursion.
  let back = leaving.back;
  for (let i = scope.stack.length - 1; i > depth && !back; i--) {
    back = scope.stack[i]!.back;
  }
  applyScope(upId ? state.nodes.get(upId) ?? null : null, { restore: back, exiting: true });
}
// The hash is authoritative and carries its own camera: a path that's gone or not a section means the map.
export function restoreScopeFromFile(file: string | null): void {
  const t = file ? nodeByFile(file) : undefined;
  const want = t && canOpen(t) ? t : null;
  if (!want) { if (scopeActive()) { withoutScopeFade(); applyScope(null, { exiting: true, camera: false }); } return; }
  if (isScopeRoot(want)) {
    return;
  }
  withoutScopeFade();
  applyScope(want, { camera: false });
}
// A scope from the URL lands its canvas colour instantly (for two frames) instead of fading in.
function withoutScopeFade(): void {
  document.body.classList.add('scope-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('scope-instant')));
}
// For unscoped jumps (a wikilink, an undo elsewhere): leave levels until `t` is in scope.
export function popScopeFor(t: MindNode): void {
  for (let guard = 0; scopeActive() && outOfScope(t) && guard < 64; guard++) {
    exitScope();
  }
}
// Driven from paintAll. When pruneScope dropped the open section, this moves the camera off it.
export function syncScopeChrome(): void {
  renderCrumbs();
  syncCanvasBackground();
  if (!scope.pruned) {
    return;
  }
  scope.pruned = false;
  if (state.sel.size || state.selId) {
    setSelectionSet([]);
  }
  focusScope();
  const open = scopeRootNode();
  setStatus(open ? `That section is gone — back to “${nodeLabel(open)}”` : 'That section is gone — back to the whole map');
}
// A stale rect would confine the drop test to the old window size.
let scopeResizeTimer: ReturnType<typeof setTimeout> | undefined;

export function installScopeResize(): void {
  window.addEventListener('resize', () => {
    if (!scopeActive()) {
      return;
    }
    clearTimeout(scopeResizeTimer);
    scopeResizeTimer = setTimeout(refreshScopeRect, 200);
  });
}
