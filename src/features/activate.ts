// What a click or double-click on a NODE does: write on the selected one (editOnClick), open it
// (activateNode), and which part of it was hit.

import { isLockedEffective } from '../utils/model.js';
import { state, isStack, isImageCard, type MindNode } from '../core/state.js';
import { screenToWorld } from '../view/camera.js';
import { isSection } from '../view/layout.js';
import { startInlineEdit, startBodyEdit, selectAllInEditor } from './inline-edit.js';
import { addCardInside } from './crud.js';
import { openImageViewer } from './image-viewer.js';
import { canOpen } from '../nav/scope.js';
import { inPlaceEditOn } from '../core/ui-state.js';
import { toggleCollapse } from './fold.js';
import { openSection } from '../nav/sections.js';

// Open one of a card's images full-screen, paged through the images of the cards beside it
// (features/image-viewer.ts). The magnifier button and the Space tap share it.
export function openImageAt(n: MindNode, img: HTMLImageElement | null): boolean {
  if (!img || !img.src || img.classList.contains('md-img-missing')) {
    return false;
  }
  openImageViewer(img.src, img.alt, { nodeId: n.id, path: img.dataset.path ?? '' });
  return true;
}

// A node's own controls — each already acts on a single click, so a double one must not also be read
// as "open this card". `.fh` is a resize handle; the rest are the card's buttons, links and inputs.
const NODE_CONTROLS = '.fold-more, .taskbox, .lock-badge, .tag-row, .md-tag, .img-zoom, a.lk, .fh';

// What is under these viewport coords. Not the event's `target`: bindNodeDrag's pointer capture retargets the
// click and dblclick that follow to the whole `.node`.
const hitAt = (cx: number, cy: number): Element | null => document.elementFromPoint(cx, cy);

export const isNodeControlAt = (cx: number, cy: number): boolean => !!hitAt(cx, cy)?.closest(NODE_CONTROLS);

// Is this point on a section's BORDER (its rim, which carries "write on this section") rather than its
// interior? Measured geometrically: the click-through content wrapper makes any hit inside the box the section.
// The band reaches as far as the resize zones outside.
const RIM_IN = 8, RIM_OUT = 8;

function onSectionRim(n: MindNode, cx: number, cy: number): boolean {
  const el = n.el;
  if (!el) {
    return false;
  }
  const r = el.getBoundingClientRect();
  const k = state.view.k, inB = RIM_IN * k, outB = RIM_OUT * k;
  if (cx < r.left - outB || cx > r.right + outB || cy < r.top - outB || cy > r.bottom + outB) {
    return false;
  }
  return cx <= r.left + inB || cx >= r.right - inB || cy <= r.top + inB || cy >= r.bottom - inB;
}

// FigJam's two steps: the first click selects, a click on what is ALREADY the only selection opens its text with
// the caret where you clicked. Decided at the release (Drag.reclick, features/drag.ts), so no timer. A
// double-click selects all of it (`mousedown.detail` 2, or openedSince). `touch`: a tap's double is its own gesture.
let opened: { id: string; at: number } | null = null;

export function editOnClick(n: MindNode, cx: number, cy: number, touch: boolean): void {
  if (n.collapsed || isImageCard(n) || isLockedEffective(n) || isNodeControlAt(cx, cy)) {
    return;
  }
  const all = !touch && downDetail >= 2;
  if (n.type !== 'section') {
    startBodyEdit(n, all ? 'all' : { x: cx, y: cy });
  } else if (hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el) {
    startInlineEdit(n, all ? {} : { at: { x: cx, y: cy } });
  }
  if (inPlaceEditOn(n.id)) {
    opened = { id: n.id, at: performance.now() };
  }
}

// Was `id`'s editor opened by a click after time `t`? With `t` the first press of a double-click (or
// tap), that click was part of the gesture.
export const openedSince = (id: string, t: number): boolean => opened?.id === id && opened.at >= t;

// The latest press's click count, and when the latest double-click began: its first press, `detail` 1.
let downDetail = 0, firstDownAt = 0;

export function installClickCount(): void {
  window.addEventListener('mousedown', (e) => {
    downDetail = e.detail;
    if (e.detail === 1) {
      firstDownAt = performance.now();
    }
  }, true);
}

// Shared by nodeEl's dblclick and the touch double-tap (features/drag.ts), decided by WHAT WAS HIT:
//   · a card                     → edit its note, all of it selected
//   · a section's tab or its rim → rename in place
//   · a SECTION's interior       → a new card THERE
export function activateNode(n: MindNode, cx: number, cy: number, { open = false }: { open?: boolean } = {}): void {
  // ⌥-double-click (or a two-finger double-tap) on a section goes IN; so does a plain one on a FOLDED section.
  if ((open || n.collapsed) && canOpen(n)) { openSection(n); return; }

  // A STACK has nothing to type into but its name on its tab; a click already fanned it out.
  if (isStack(n)) {
    if (hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el) {
      startInlineEdit(n);
    }
    return;
  }
  // A FOLDED card unfolds: the chip is a summary, and the double-click asks to see what's in it.
  if (n.collapsed) { toggleCollapse(n.id); return; }
  // A card has ONE text, its note — the title is its first line — so wherever it was hit, that is what opens.
  if (!isSection(n)) { startBodyEdit(n, 'all'); return; }
  // startInlineEdit refuses a locked node. `parentElement === n.el`: this section's OWN tab, not a nested one's.
  if (hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el || onSectionRim(n, cx, cy)) {
    startInlineEdit(n);
    return;
  }
  // A SECTION's interior gets a new card where you pointed.
  addCardInside(n.id, screenToWorld(cx, cy));
}

// Double-click OPENS the node (activateNode).
export function onNodeDblClick(n: MindNode, e: MouseEvent): void {
  // The innermost card owns the gesture even when it declines it: child cards are DOM-nested, and a
  // declined double-click bubbling to the host would open the HOST's editor.
  e.stopPropagation();

  // While editing, a double-click selects a word — unless its first click OPENED the editor: then it selects all.
  if (inPlaceEditOn(n.id)) {
    if (openedSince(n.id, firstDownAt)) {
      e.preventDefault();
      selectAllInEditor();
    }
    return;
  }

  // the card's own buttons keep their click — except a section's resize zones, which lie over its rim
  if (isNodeControlAt(e.clientX, e.clientY) && !onSectionRim(n, e.clientX, e.clientY)) {
    return;
  }
  e.preventDefault();
  activateNode(n, e.clientX, e.clientY, { open: e.altKey });
}
