// ---------- card geometry: how big each kind of node is, and the grid it snaps to ----------
import { state, type MindNode, isImageCard } from '../core/state.js';
import { type Pt, ui } from '../core/ui-state.js';
import { snapTo } from '../utils/num.js';
import { hiddenLineCount } from '../utils/frontmatter.js';
import { isLockedEffective } from '../utils/model.js';
import { isScopeRoot } from '../nav/scope.js';
import { isFrame } from './layout.js';

export const NODE_W = 200;
// world-px grid dragged positions AND frame/image-card sizes snap to — tracks the visible grid's
// own cell size (state.gridSize, view/grid.ts); 0 (grid off) disables snapping rather than
// collapsing every position to the origin.
export function gridSnap(): number { return state.gridSize || 1; }
// A POINT on the grid — the same rounding a dragged card gets, for the places that PLACE a card rather
// than drag it: a new card at the pointer, a duplicate, a paste, an image dropped or pulled out of a
// note. Anything the user positions ends up on the grid, however it got there.
export function snapPt(p: Pt): Pt { const g = gridSnap(); return { x: snapTo(p.x, g), y: snapTo(p.y, g) }; }
export const FRAME_BORDER = 2;   // must match .node.frame's CSS `border` width (styles.css)
// A frame's label is not part of its geometry at all: it hangs ABOVE the box, outside the frame's
// bounds (styles.css `.node.frame > .title-row`), the way a FigJam section's name does — so naming,
// renaming or un-naming a frame never moves its box or the cards in it, and n.y/n.h are the box itself.
// Default frame container size (world px).
export const FRAME_W = 360, FRAME_H = 260;
export const IMAGE_W = 240, IMAGE_H = 180;   // default image-card size (world px)
// A FOLDED frame renders as nothing but its label — a pill at the box's top-left
// corner (n.x, n.y), its cards hidden (utils/model.ts isHidden). Its element shrink-wraps the label,
// so its width is measured (nodeW) and its height is the FRAME_TAB_H constant.
export function isFrameFold(n: MindNode): boolean { return n.type === 'frame' && !!n.collapsed; }
// Height of a folded frame's pill (styles.css .frame-folded: 20px line + 9px padding + 1px border, top
// and bottom). A constant, so the pill is one ellipsised line and never measured.
const FRAME_TAB_H = 40;
// What CAN fold: every FRAME (to its label pill), a card with something below its first line to tuck
// away (to a one-line chip), or an image card (to a 40px icon of itself). The one rule the arrow, X,
// ←/→, the menus and ⌘P's Collapse all ask.
export function canFold(n: MindNode): boolean {
  return n.type === 'frame' || isImageCard(n) || hiddenLineCount(n) > 0;
}
// …and may be folded or unfolded by the user right now: not locked, and not the open frame (it's the canvas).
export const canToggleFold = (n: MindNode): boolean => canFold(n) && !isLockedEffective(n) && !isScopeRoot(n);
// An image card rendering AS its picture: no padding, both axes authored, aspect-locked resize.
// isImageCard (core/state.ts) is the content test — untitled, and the whole note is one `![](…)`;
// this adds the two states where the card shows something ELSE and so goes back to being an ordinary
// card: FOLDED (it's the 40px icon below) and while its editor is open (it's the markdown, which has
// to wrap and measure like any text). Both are transient, and neither touches what's on disk.
// …and the one state where an image card is NOT drawn as its picture: its own editor is open, where
// the card holds markdown text that has to wrap and measure like any note's. Both halves below read
// this, so the class, the sizing and the resize handles can't disagree about what's on screen.
export function imageLook(n: MindNode): boolean { return isImageCard(n) && ui.bodyEdit?.id !== n.id; }
function isImageBox(n: MindNode): boolean { return imageLook(n) && !n.collapsed; }
// …and folded, an image card is a small square of the picture itself — the icon a folded card with no
// title would otherwise have nothing to show.
export const IMAGE_FOLD = 40;
export function isImageFold(n: MindNode): boolean { return imageLook(n) && n.collapsed; }
// Any 2D box — authors BOTH axes, so it gets the full 8-handle set and shares the sizing plumbing
// below.
export function isBoxNode(n: MindNode): boolean { return isFrame(n) || isImageBox(n); }

// Every kind whose height is set rather than measured: a box, and anything folded to a fixed size.
export function heightIsDeclared(n: MindNode): boolean {
  return isBoxNode(n) || isImageFold(n) || isFrameFold(n);
}

function boxDefaultW(n: MindNode): number { return isImageBox(n) ? IMAGE_W : FRAME_W; }
function boxDefaultH(n: MindNode): number { return isImageBox(n) ? IMAGE_H : FRAME_H; }
// A node's footprint WIDTH. `n.w` is the AUTHORED width — dragged with a resize handle, persisted as
// mm_w — and every kind can carry one: a frame/image card sizes its whole box with it, while a card
// authors only this axis (its height comes from its content). A folded frame's tab shrink-wraps its
// title instead.
export function nodeW(n: MindNode): number {
  if (isBoxNode(n)) {
    return n.w ?? boxDefaultW(n);
  }
  if (isImageFold(n)) {
    return IMAGE_FOLD;   // folded to its icon — a fixed square, never measured
  }
  if (isFrameFold(n)) {
    return (n.el && n.el.offsetWidth) || NODE_W;   // the pill shrink-wraps its label
  }
  if (n.collapsed && n.el && n.el.offsetWidth) {
    return n.el.offsetWidth;   // a folded card's chip, likewise
  }
  return n.w ?? NODE_W;
}
// live height (falls back pre-render). An expanded frame/image card's height is its box (n.h).
export function nodeH(n: MindNode): number {
  if (isBoxNode(n)) {
    return n.h ?? boxDefaultH(n);
  }
  if (isImageFold(n)) {
    return IMAGE_FOLD;
  }
  if (isFrameFold(n)) {
    return FRAME_TAB_H;   // just the pill — one fixed line, never measured
  }
  return (n.el && n.el.offsetHeight) || 64;
}
// Height used for LAYOUT geometry. Identical to nodeH for every kind whose height is DECLARED
// (box / folded frame / folded image), so it defers to it rather than restating the ladder — a new kind
// added to nodeH must not have to be remembered here too. The two differ only for a MEASURED card:
// nodeH treats a zero-height element as unrendered and falls back to 64, while layout wants the real
// 0 (the tags on the top edge are absolutely positioned and
// overhang, so they never inflate the measurement either way).
export function layoutH(n: MindNode): number {
  if (heightIsDeclared(n)) {
    return nodeH(n);
  }
  return n.el ? n.el.offsetHeight : 64;
}
