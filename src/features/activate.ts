// What a click or double-click on a NODE does, decided by which part of it was hit.

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

export function openImageAt(n: MindNode, img: HTMLImageElement | null): boolean {
  if (!img || !img.src || img.classList.contains('md-img-missing')) {
    return false;
  }
  openImageViewer(img.src, img.alt, { nodeId: n.id, path: img.dataset.path ?? '' });
  return true;
}

// Each already acts on a single click, so a double one must not also open the card. `.fh`: a resize handle.
const NODE_CONTROLS = '.fold-more, .taskbox, .lock-badge, .tag-row, .md-tag, .img-zoom, a.lk, .fh';

// Not the event's `target`: bindNodeDrag's pointer capture retargets the click and dblclick to the whole `.node`.
const hitAt = (cx: number, cy: number): Element | null => document.elementFromPoint(cx, cy);

export const isNodeControlAt = (cx: number, cy: number): boolean => !!hitAt(cx, cy)?.closest(NODE_CONTROLS);

// Measured geometrically: the click-through content wrapper makes any hit inside the box the section.
// The band reaches out as far as the resize zones.
const RIM_IN = 8, RIM_OUT = 8;

// This node's OWN tab, not a nested section's.
function hitsOwnTab(n: MindNode, cx: number, cy: number): boolean {
  return hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el;
}

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

// See "A click on the SELECTED node writes on it" in docs/architecture.md. `touch`: a tap's double is its own gesture.
let opened: { id: string; at: number } | null = null;

export function editOnClick(n: MindNode, cx: number, cy: number, touch: boolean): void {
  if (n.collapsed || isImageCard(n) || isLockedEffective(n) || isNodeControlAt(cx, cy)) {
    return;
  }
  const all = !touch && pressCount >= 2;
  if (n.type !== 'section') {
    startBodyEdit(n, all ? 'all' : { x: cx, y: cy });
  } else if (hitsOwnTab(n, cx, cy)) {
    startInlineEdit(n, all ? {} : { at: { x: cx, y: cy } });
  }
  if (inPlaceEditOn(n.id)) {
    opened = { id: n.id, at: performance.now() };
  }
}

// With `t` the first press of a double-click (or tap): was the editor opened by part of that gesture?
export const openedSince = (id: string, t: number): boolean => opened?.id === id && opened.at >= t;

let pressCount = 0, doubleClickStartedAt = 0;

export function installClickCount(): void {
  window.addEventListener('mousedown', (e) => {
    pressCount = e.detail;
    if (e.detail === 1) {
      doubleClickStartedAt = performance.now();
    }
  }, true);
}

// Shared by nodeEl's dblclick and the touch double-tap (features/drag.ts).
export function activateNode(n: MindNode, cx: number, cy: number, { open = false }: { open?: boolean } = {}): void {
  if ((open || n.collapsed) && canOpen(n)) { openSection(n); return; }

  // A click already fanned the stack out; only its name is left to type into.
  if (isStack(n)) {
    if (hitsOwnTab(n, cx, cy)) {
      startInlineEdit(n);
    }
    return;
  }
  if (n.collapsed) { toggleCollapse(n.id); return; }
  if (!isSection(n)) { startBodyEdit(n, 'all'); return; }
  if (hitsOwnTab(n, cx, cy) || onSectionRim(n, cx, cy)) {
    startInlineEdit(n);
    return;
  }
  addCardInside(n.id, screenToWorld(cx, cy));
}

export function onNodeDblClick(n: MindNode, e: MouseEvent): void {
  // Nodes are DOM-nested: a declined double-click bubbling up would open the HOST's editor.
  e.stopPropagation();

  // A double-click that OPENED the editor selects all, not just a word.
  if (inPlaceEditOn(n.id)) {
    if (openedSince(n.id, doubleClickStartedAt)) {
      e.preventDefault();
      selectAllInEditor();
    }
    return;
  }

  // A section's resize zones lie over its rim.
  if (isNodeControlAt(e.clientX, e.clientY) && !onSectionRim(n, e.clientX, e.clientY)) {
    return;
  }
  e.preventDefault();
  activateNode(n, e.clientX, e.clientY, { open: e.altKey });
}
