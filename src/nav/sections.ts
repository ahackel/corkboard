import { type MindNode, state, setStatus } from '../core/state.js';
import { containerBox } from '../view/layout.js';
import { stageSize, cancelViewAnim, jumpViewTo } from '../view/camera.js';
import { scope, type ScopeBack, type ScopeLevel, openPathTo, isScopeRoot, outOfScope, canOpen, scopeActive, scopeRootNode } from './scope.js';
import { growSectionsToHold } from '../features/float-bar.js';
import { childrenOf, nodeLabel, nodeByFile } from '../utils/model.js';
import { endInPlaceEdit } from '../features/inline-edit.js';
import { remeasure } from '../main.js';
import { record } from '../features/history.js';
import { syncUrl } from './url-state.js';
import { afterReading } from '../data/lazy.js';
import { renderCrumbs } from '../features/breadcrumbs.js';
import { syncCanvasBackground } from '../features/canvas-color.js';
import { focusScope } from './focus.js';
import { setSelectionSet, selectNode } from '../features/selection.js';
import { scheduleSave } from '../data/save.js';

// ---------- OPENING a section: the scoped canvas ----------
// The ACTIONS; nav/scope.ts holds the model and the reasoning. They sit beside focusNode because
// that's their template (reveal → select → glide), but this is a separate feature: focusNode frames
// a card WITHIN the map, opening replaces what the map is for as long as you're inside.

// The viewport rect the open section lays its contents out in — read back through containerBox /
// sectionInterior. A SNAPSHOT, taken here and refreshed only on a window resize:
//  · not LIVE: the drop test reads it on every move, and a rect that moved with every pan would
//    make where a card lands depend on how you got there.
//  · sized at k = 1 (the app's canonical 1 world px = 1 screen px), not at the current zoom: the
//    camera is about to change, since opening fits the contents, so reading the live k is circular.
//    frameBox clamps k ≤ 1.0 anyway, so the fitted result lands near 1 and the contents do fill it.
//  · bottomInset() is deliberately NOT subtracted. It's nonzero only while the float bar is docked
//    AND open, i.e. it tracks the SELECTION — folding it in would reflow the section on every click.
//    It belongs to the camera moves (frameBox/revealInView) and stays there. Same for the crumb bar,
//    which is floating chrome over the canvas like #toolbar.
//  · anchored at the section's own content origin, so opening a section moves nothing at all (and so
//    dirties nothing).
function scopeRectFor(t: MindNode): { x: number; y: number; w: number; h: number } {
  const home = containerBox(t);   // read before the level is pushed, so it's the section's real bounds
  const s = stageSize();
  return { x: home.x, y: home.y, w: s.width, h: s.height };
}
// Re-measure the open level after a window resize; the anchor is kept, since the open section can't
// move (it isn't selectable and nothing lays it out). Returns whether anything actually changed.
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

// Rebuild the stack so its last level is `target` (null = the whole map). The stack IS the crumb
// path — the openable ancestor chain, not just what the user happened to click through — so opening
// a deep section from the ⋯ menu still reads `Map › A › B › C`. Levels that survive the rebuild keep
// their remembered camera and rect, which is what makes `open A → open B → leave` cut back to the
// camera A really had; levels nobody stepped through get no `back` and are re-fitted instead.
function setScopeStack(target: MindNode | null, back: ScopeBack | null): void {
  if (!target) { scope.stack = []; scope.rootId = null; return; }
  const keep = new Map(scope.stack.map(l => [l.rootId, l]));
  const next: ScopeLevel[] = [];
  for (const n of [...openPathTo(target), target]) {
    next.push(keep.get(n.id) ?? { rootId: n.id, file: n.file ?? null, rect: scopeRectFor(n), back: null });
  }
  const top = next[next.length - 1]!;
  if (!keep.has(top.rootId)) {
    top.back = back;   // only a level you're newly entering records a way back
  }
  scope.stack = next;
  scope.rootId = target.id;
}

// A FREE section you were INSIDE had the whole viewport to arrange things in, so a card can easily end
// up outside the box it goes back to being on the way out — where its wrapper's overflow:hidden would
// clip it clean away. So grow the box to hold what's in it as you leave (growSectionsToHold), and only
// when something really does stick out, so a visit that moved nothing still writes nothing.
// A locked section is out: it refuses to be resized at all.
// A FOLDED section is measured as the box it unfolds to, not its pill: unfolded for the measurement
// only, and folded straight back, so leaving it moves nothing unless a card really sticks out.
function growToFitContents(f: MindNode): void {
  if (state.readOnly || f.type !== 'section') {
    return;
  }
  const folded = f.collapsed;
  f.collapsed = false;
  try { growSectionsToHold(childrenOf(f.id).map(k => k.id)); }
  finally { f.collapsed = folded; }
}

interface ScopeOpts { back?: ScopeBack | null; restore?: ScopeBack | null; exiting?: boolean; camera?: boolean; }
function applyScope(target: MindNode | null, opts: ScopeOpts = {}): void {
  // A scope change re-parents elements (a child moves between #world and a wrapper), which would
  // drop a captured pointer or blur an open editor.
  endInPlaceEdit();
  cancelViewAnim();
  const before = scope.rootId;
  const left = before ? state.nodes.get(before) : undefined;
  // No layout glide: the cards of the level you step into are simply THERE, where they sit — played from
  // where they were, they fly in from their ancestor and the canvas visibly builds itself up.
  setScopeStack(target, opts.back ?? null);
  // settledHost caches which wrapper each element sits in (hostSectionId), and the scope just
  // changed which wrapper that IS. Drop the cache or the children keep being placed into a
  // wrapper paintNode is about to remove.
  for (const n of state.nodes.values()) {
    n.hostSectionId = undefined;
  }
  refreshScopeRect();
  // Now that the stack is settled, containerBox reports the section we just left at its real size
  // again — so this is the moment to check nothing it holds got stranded outside it. Its own undo
  // step: ⌘Z undoes the resize without teleporting you between scopes.
  // `type === 'section'` and not a scope predicate: the scope stack has already moved above this line.
  if (left && left.type === 'section' && !isScopeRoot(left)) {
    record([left.id], () => growToFitContents(left));
  }
  remeasure();
  if (opts.exiting) {
    // Leaving: select the section you came out of — that's what makes a crumb read as a back button —
    // and cut back to the camera you left. A level nobody stepped through has none, so it re-fits.
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
    selectNode(null);            // the section itself is off the canvas now, so nothing is selected
    if (opts.camera !== false) {
      focusScope(true);
    }
  }
  syncUrl();                     // a discrete navigation step, like selecting a node → a history entry
  if (before !== scope.rootId) {
    scheduleSave();
  }
}

// Open a section. Allowed in read-only and on a LOCKED section: looking inside the box isn't changing it.
export function openSection(target: MindNode | undefined): void {
  const t = target;
  if (!t || !canOpen(t)) { setStatus('Only a section can be opened'); return; }
  if (afterReading([t.id], () => openSection(t), false)) {
    return;   // its notes are the canvas you open onto
  }
  const back = currentBack();
  // Opening is pure navigation, in the same class as revealInView: it writes no node field. A FOLDED
  // section stays folded — while you stand in it its interior is the canvas whatever its fold says
  // (isHidden asks about the open section before the fold), and you come back out to the same pill.
  if (isScopeRoot(t)) {
    return;                  // already standing in it
  }
  applyScope(t, { back });
  setStatus(`Opened “${nodeLabel(t)}”`);
}
// Leave the innermost level.
export function exitScope(): void {
  // Leave the level you're standing in — AND every SYNTHESIZED level beneath it. A level with no
  // `back` is one nobody stepped through (setScopeStack): opening a card that lives three sections deep
  // pushes those sections as crumbs, and leaving one at a time would walk you out through folders you
  // were never in. Coming out of a card therefore lands you where you were when you went into it,
  // which is what "close" means. A level you DID open by hand keeps its own back and stops the walk,
  // so `open A → open B → leave` still lands in A exactly as before.
  let d = scope.stack.length - 1;
  while (d > 0 && scope.stack[d - 1]!.back === null) {
    d--;
  }
  goToScopeDepth(d);
}
// Leave the level AT `depth`, landing in the one above it — so depth 0 is "back to the whole map".
// A crumb click is exactly this, which is why the crumbs need no logic of their own.
export function goToScopeDepth(depth: number): void {
  if (depth < 0 || depth >= scope.stack.length) {
    return;   // ↓ at the top level: silently inert
  }
  const leaving = scope.stack[depth]!;
  const upId = depth > 0 ? scope.stack[depth - 1]!.rootId : null;
  // Several levels can be left at once — exitScope pops the synthesized ones, a crumb click jumps out
  // of many. The camera to go back to belongs to the OUTERMOST level being left, or, when that one
  // was synthesized and never recorded a camera, to the innermost that did: that is the state the user
  // was actually in before the whole excursion.
  let back = leaving.back;
  for (let i = scope.stack.length - 1; i > depth && !back; i--) {
    back = scope.stack[i]!.back;
  }
  applyScope(upId ? state.nodes.get(upId) ?? null : null, { restore: back, exiting: true });
}
// Restore the scope a URL hash asked for (nav/url-state.ts). No fit: the hash carries its own camera
// and must win. The hash is AUTHORITATIVE, so a path that's absent, gone, or no longer a section all
// mean the same thing — the whole map — rather than quietly leaving you wherever you were: that
// distinction only shows up on a back/forward step, where honouring the URL is the entire point.
// No error either way; a shared link to a since-deleted section should just open the map.
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
// The canvas colour must LAND, not fade in, whenever the scope comes from the URL rather than from
// something the user just did. On a reload there is nothing to transition FROM — the map has only just
// appeared — so the fade reads as the app flashing the wrong background before settling on the right
// one; on a back/forward step the camera and selection jump too, so a sliding background would be the
// only thing still catching up. Suppressed for two sections (long enough for the paint that sets
// --canvas-bg to land), after which every real open/leave fades again.
function withoutScopeFade(): void {
  document.body.classList.add('scope-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('scope-instant')));
}
// Bring `t` into reach from ANYWHERE: leave as many levels as it takes for it to be inside the scope
// we land in. The deliberately UNSCOPED jumps (a [[wikilink]], an undo that
// resurrects a node elsewhere) all go through here, so none of them can select a card that isn't on
// the canvas — isSelectable refuses an out-of-scope id.
export function popScopeFor(t: MindNode): void {
  for (let guard = 0; scopeActive() && outOfScope(t) && guard < 64; guard++) {
    exitScope();
  }
}
// Keep the crumb bar in step, and recover from the open section having been deleted / undone away /
// removed on disk. pruneScope (view/layout.ts's applyLayouts) already truncated the stack; the
// camera half has to live here, and without it you'd be staring at the parent scope through the
// departed child's camera. Driven from paintAll, so every mutation path gets it.
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
// Keep the rect honest across a window resize. Nothing to re-lay-out — an open section's contents sit
// where they were put; what still reads the rect is the drop test (sectionAt / containerBox), which a
// stale rect would confine to the old window. Debounced, and a no-op when the size didn't really change.
let scopeResizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  if (!scopeActive()) {
    return;
  }
  clearTimeout(scopeResizeTimer);
  scopeResizeTimer = setTimeout(refreshScopeRect, 200);
});
