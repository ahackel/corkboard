// ---------- focus: bring a card (or everything on the canvas) into view ----------
import { type MindNode, state, setStatus } from '../core/state.js';
import { layoutSnapshot, relayout, animateReflow } from '../main.js';
import { ancestors, subtreeIds, resolveWikilink } from '../utils/model.js';
import { record } from '../features/history.js';
import { frameBox } from '../view/camera.js';
import { store } from '../data/persistence.js';
import { snapPt, nodeW } from '../view/geometry.js';
import { createNode } from '../features/crud.js';
import { popScopeFor } from './frames.js';
import { selectNode } from '../features/selection.js';
import { scheduleSave } from '../data/save.js';

// Focus a card: unfold it when openTarget, select it, frame it + all its visible descendants.
export function focusNode(target: MindNode | undefined, openTarget = false): void {
  if (!target) {
    return;
  }
  const before = layoutSnapshot();             // pre-reveal frame to glide away from
  // Unfold the frames it's tucked inside (and, when openTarget, the card itself) so it's on the canvas.
  const toReveal = [...ancestors(target)].filter(p => p.collapsed);
  if (openTarget && target.collapsed) {
    toReveal.push(target);
  }
  let revealed = false;
  if (toReveal.length) {
    record(toReveal.map(m => m.id), () => { for (const m of toReveal){ m.collapsed = false; m.dirtyLayout = true; } revealed = true; });
  }
  selectNode(target.id);                       // select → the card shows its full body (grows)
  relayout();                  // reflow siblings around the now-taller selection
  animateReflow(before);                       // one glide from the pre-reveal frame to the final
  frameBox(subtreeIds(target.id).map(id => state.nodes.get(id)));
  if (revealed && store.isOpen) {
    scheduleSave();
  }
}
// Follow a [[wikilink]] and focus its target. Map-wide, on purpose — a link that only worked inside the
// frame you happened to be in would be a broken link — so it comes out of as many scope levels as it
// takes to show the target (popScopeFor).
//
// Two cards may now share a title, so a bare `[[Notes]]` can be AMBIGUOUS. It resolves to the first
// match either way (a link has to go somewhere, and refusing to move would read as a dead link), but it
// SAYS so, since the alternative — picking silently and looking like a bug — is the worse of the two.
// The way to be exact is the PATH form, `[[Frames/Notes]]` or `[[Notes 2]]`, matched against the node's
// file: that's the one name in this app guaranteed unique, which is exactly why the disambiguator lives
// there rather than in some new syntax.
export function focusByTitle(title: string, from?: MindNode): void {
  const hits = resolveWikilink(title);
  const target = hits[0];
  // A link to a card that isn't there yet WRITES it (Obsidian's gesture): the new card lands beside
  // the one you clicked from, free-standing — a wikilink is a relation, never containment. Only the
  // TITLE form can be created: the PATH form names a folder nothing here chooses.
  if (!target){
    if (!from || state.readOnly || title.includes('/')){
      setStatus(`No node titled “${title}” in this map`); return;
    }
    const at = snapPt({ x: from.x + nodeW(from) + 40, y: from.y });
    if (createNode({ x: at.x, y: at.y, title, edit: false })) {
      setStatus(`Created “${title}”`);
    }
    return;
  }
  popScopeFor(target);
  focusNode(target);
  if (hits.length > 1) {
    setStatus(`${hits.length} cards are titled “${title}” — went to the one in ${target.file ?? 'this map'}`);
  }
}
// The "focus" command (toolbar button + F): frame the selected card (+ its subtree), or
// frame the whole map when nothing is selected — both glide with the same easing. While a frame is
// OPEN, "the whole map" means its contents: frameBox filters isHidden, so the scope comes for free.
export function focusOrFit(): void {
  if (state.selId && state.nodes.has(state.selId)) {
    focusNode(state.nodes.get(state.selId));
  } else {
    focusScope();
  }
}
// Re-frame whatever is ON the canvas right now: the open frame's contents while scoped (isHidden
// does the filtering), the whole map plus its ink otherwise. The single spelling of "frame all of
// this", shared by F-with-nothing-selected, every open/exit and the current crumb.
export function focusScope(): void { frameBox([...state.nodes.values()]); }
