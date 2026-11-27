// How big each kind of node is, and the grid it snaps to.
import { state, type MindNode, isImageCard, isStack } from '../core/state.js';
import { type Pt, ui } from '../core/ui-state.js';
import { snapTo } from '../utils/num.js';
import type { Rect } from '../utils/rect.js';
import { hiddenLineCount } from '../utils/frontmatter.js';
import { isLockedEffective } from '../utils/model.js';
import { isScopeRoot } from '../nav/scope.js';
import { isSection } from './layout.js';
import { pileW } from './pile.js';

export const NODE_W = 200;

export function nodeRect(n: MindNode): Rect { return { x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) }; }

export const MIN_SECTION_W = NODE_W, MIN_SECTION_H = 120;
// Grid off (0) means no snapping, not everything collapsing to the origin.
export function gridSnap(): number { return state.gridSize || 1; }
// For places that PLACE a card rather than drag it (new, duplicate, paste, image drop).
export function snapPt(p: Pt): Pt { const g = gridSnap(); return { x: snapTo(p.x, g), y: snapTo(p.y, g) }; }
export const SECTION_BORDER = 2;   // must match .node.section's CSS `border` width (styles.css)
// A section's label hangs above its box and is no part of its geometry: renaming never moves anything.
export const SECTION_W = 360, SECTION_H = 260;
export const IMAGE_W = 240, IMAGE_H = 180;
// A folded section is its folder icon and label, measured.
export function isSectionFold(n: MindNode): boolean { return n.type === 'section' && !!n.collapsed && !isStack(n); }
const SECTION_TAB_H = 30;   // before it has painted
const UNPAINTED_CARD_H = 64;
// The one rule every fold control asks.
export function canFold(n: MindNode): boolean {
  return (n.type === 'section' && !isStack(n)) || isImageCard(n) || hiddenLineCount(n) > 0;
}
export const canToggleFold = (n: MindNode): boolean => canFold(n) && !isLockedEffective(n) && !isScopeRoot(n);
// While its editor is open an image card is markdown text, measured like any note.
export function imageLook(n: MindNode): boolean { return isImageCard(n) && ui.bodyEdit?.id !== n.id; }
function isImageBox(n: MindNode): boolean { return imageLook(n) && !n.collapsed; }
export const IMAGE_FOLD = 40;
export function isImageFold(n: MindNode): boolean { return imageLook(n) && n.collapsed; }
// Authors both axes: the full 8-handle set.
export function isBoxNode(n: MindNode): boolean { return isSection(n) || isImageBox(n); }

// Every kind whose height is not the card's authored min-height n.h.
export function heightIsDeclared(n: MindNode): boolean {
  return isBoxNode(n) || isImageFold(n) || isSectionFold(n);
}

function boxDefaultW(n: MindNode): number { return isImageBox(n) ? IMAGE_W : SECTION_W; }
function boxDefaultH(n: MindNode): number { return isImageBox(n) ? IMAGE_H : SECTION_H; }
export function nodeW(n: MindNode): number {
  if (isStack(n)) {
    return pileW(n);
  }
  if (isBoxNode(n)) {
    return n.w ?? boxDefaultW(n);
  }
  if (isImageFold(n)) {
    return IMAGE_FOLD;
  }
  if (isSectionFold(n)) {
    return (n.el && n.el.offsetWidth) || NODE_W;
  }
  if (n.collapsed && n.el && n.el.offsetWidth) {
    return n.el.offsetWidth;
  }
  return n.w ?? NODE_W;
}
export function nodeH(n: MindNode): number {
  if (isBoxNode(n)) {
    return n.h ?? boxDefaultH(n);
  }
  if (isImageFold(n)) {
    return IMAGE_FOLD;
  }
  if (isSectionFold(n)) {
    return (n.el && n.el.offsetHeight) || SECTION_TAB_H;
  }
  return (n.el && n.el.offsetHeight) || UNPAINTED_CARD_H;
}
// nodeH, except a measured card of zero height stays 0 rather than reading as unpainted.
export function layoutH(n: MindNode): number {
  if (heightIsDeclared(n)) {
    return nodeH(n);
  }
  return n.el ? n.el.offsetHeight : UNPAINTED_CARD_H;
}
