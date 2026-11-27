// The ghost card: drag a new card off the corner of the canvas, through the ordinary drag machinery.
import { byId, trackPointer } from '../utils/dom.js';
import { type MindNode } from '../core/state.js';
import { feedDragMove, abortDrag, commitDrag, startNodeDrag } from './drag.js';
import { deleteNode, createDetachedNode } from './crud.js';
import { commitStep } from './history.js';
import { startInlineEdit, endInPlaceEdit } from './inline-edit.js';
import { screenToWorld } from '../view/camera.js';

const ghost = byId('ghostCard');
let newNode: MindNode | null = null;

// Move/up listen on `window`: pointer capture can be lost in mid-drag re-renders.
let stopGhostDrag: (() => void) | null = null;

function endGhostDrag(): MindNode | null {
  const n = newNode;
  newNode = null;
  stopGhostDrag?.();
  stopGhostDrag = null;
  return n;
}

function onMove(e: PointerEvent): void {
  if (newNode) {
    feedDragMove(e.clientX, e.clientY);
  }
}

// Deleting inside the open step nets null→null, so the step is discarded.
function discardNewCard(n: MindNode): void {
  abortDrag();
  deleteNode(n.id);
  commitStep();
}

function onUp(e: PointerEvent): void {
  const n = endGhostDrag();
  if (!n) {
    return;
  }
  const r = ghost.getBoundingClientRect();
  const releasedOnGhost = e.clientX >= r.left && e.clientX <= r.right &&
                          e.clientY >= r.top  && e.clientY <= r.bottom;
  if (releasedOnGhost) {
    discardNewCard(n);
    return;
  }
  commitDrag();
  startInlineEdit(n, { isNew: true });
}

function onCancel(): void {
  const n = endGhostDrag();
  if (n) {
    discardNewCard(n);
  }
}

export function installGhostCard(): void {
  ghost.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    endInPlaceEdit();
    const r = ghost.getBoundingClientRect();
    const ghostTopLeft = screenToWorld(r.left, r.top);
    newNode = createDetachedNode(ghostTopLeft.x, ghostTopLeft.y) ?? null;
    if (!newNode) {
      return;
    }
    try { ghost.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    startNodeDrag(newNode, e.clientX, e.clientY);
    stopGhostDrag = trackPointer({ move: onMove, up: onUp, cancel: onCancel });
  });
}
