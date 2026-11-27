// Bringing a card, or everything on the canvas, into view.
import { type MindNode, state, setStatus } from '../core/state.js';
import { layoutSnapshot, animateReflow } from '../layout-anim.js';
import { relayout } from '../render.js';
import { ancestors, subtreeIds, resolveWikilink, linkName } from '../utils/model.js';
import { record } from '../features/history.js';
import { frameBox } from '../view/camera.js';
import { store } from '../data/active-store.js';
import { snapPt, nodeW } from '../view/geometry.js';
import { createNode } from '../features/crud.js';
import { popScopeFor } from './sections.js';
import { isScopeRoot } from './scope.js';
import { selectNode } from '../features/selection.js';
import { scheduleSave } from '../data/save.js';
import { afterReading } from '../data/lazy.js';

const NEW_LINK_CARD_GAP = 40;

// Unfolds its sections (and itself when openTarget), selects it and frames it with its descendants.
export function focusNode(target: MindNode | undefined, openTarget = false): void {
  if (!target) {
    return;
  }
  const before = layoutSnapshot();
  // Only up to the open section: what's above it is off the canvas anyway.
  const toReveal: MindNode[] = [];
  for (const p of ancestors(target)) {
    if (isScopeRoot(p)) {
      break;
    }
    if (p.collapsed) {
      toReveal.push(p);
    }
  }
  if (openTarget && target.collapsed) {
    toReveal.push(target);
  }
  let revealed = false;
  if (toReveal.length) {
    record(toReveal.map(m => m.id), () => { for (const m of toReveal){ m.collapsed = false; } revealed = true; });
  }
  selectNode(target.id);
  relayout();
  animateReflow(before);
  frameBox(subtreeIds(target.id).map(id => state.nodes.get(id)));
  if (revealed && store.isOpen) {
    scheduleSave();
  }
}
// Follows a [[wikilink]] map-wide, leaving scope levels as needed. An ambiguous bare title goes to the
// first match and says so; the PATH form (`[[Sections/Notes]]`) is exact.
export function focusByTitle(link: string, from?: MindNode, readFolded = false): void {
  const hits = resolveWikilink(link), title = linkName(link);
  const target = hits[0];
  // The target may be in an unread folded section: read first, rather than write a duplicate card.
  if (!target && !readFolded && afterReading([...state.nodes.keys()], () => focusByTitle(link, from, true))) {
    return;
  }
  // A missing target is written beside the card you clicked from (Obsidian's gesture), title form only.
  if (!target){
    if (!from || title.includes('/')){
      setStatus(`No node titled “${title}” in this map`); return;
    }
    const at = snapPt({ x: from.x + nodeW(from) + NEW_LINK_CARD_GAP, y: from.y });
    createNode({ x: at.x, y: at.y, title, edit: false });
    return;
  }
  popScopeFor(target);
  focusNode(target);
  if (hits.length > 1) {
    setStatus(`${hits.length} cards are titled “${title}” — went to the one in ${target.file ?? 'this map'}`);
  }
}
// The F command: the selection, else everything on the canvas.
export function focusOrFit(): void {
  if (state.selId && state.nodes.has(state.selId)) {
    focusNode(state.nodes.get(state.selId));
  } else {
    focusScope();
  }
}
// frameBox filters isHidden, so while scoped this is the open section's contents.
export function focusScope(instant = false): void { frameBox([...state.nodes.values()], instant); }
