// ---------- the ghost card: drag a new card off the corner of the canvas ----------
import { byId, trackPointer } from '../utils/dom.js';
import { type MindNode, state } from '../core/state.js';
import { feedDragMove, abortDrag, commitDrag, startNodeDrag } from './drag.js';
import { deleteNode, createDetachedNode } from './crud.js';
import { commitStep } from './history.js';
import { startInlineEdit, endInPlaceEdit } from './inline-edit.js';
import { screenToWorld } from '../view/camera.js';

// Ghost-card drag: grab the corner card to spawn a new note that rides the cursor through the same
// move/drop machinery as dragging an existing card — so the guides and the drop-into-a-frame rule
// behave identically. Releasing back on the ghost cancels.
const ghost = byId('ghostCard');
let newNode: MindNode | null = null;

// Move/up are handled on `window`, not the ghost, so the drop commits no matter where the pointer
// is released or whether pointer-capture survived the mid-drag re-renders (a lost capture used to
// deliver pointerup to the card underneath, whose handler ignores it — leaving the ghost stuck and
// nothing created). setPointerCapture is still requested (best-effort) so the dragged card's own
// handlers stay quiet; capture events bubble to window regardless.
let stopGhostDrag: (() => void) | null = null;
function endGhostDrag(): MindNode | null {
  const n = newNode;
  newNode = null;
  stopGhostDrag?.();
  stopGhostDrag = null;
  return n;
}
function onMove(e: PointerEvent): void { if (newNode) feedDragMove(e.clientX, e.clientY); }
function onUp(e: PointerEvent): void {
  const n = endGhostDrag();
  if (!n) return;
  // released back on the ghost card itself -> cancel: discard the new card, create nothing
  const r = ghost.getBoundingClientRect();
  const onGhost = e.clientX >= r.left && e.clientX <= r.right &&
                  e.clientY >= r.top  && e.clientY <= r.bottom;
  if (onGhost) { abortDrag(); deleteNode(n.id); commitStep(); return; }   // nets null→null, discarded
  commitDrag();                          // land / reparent exactly where the preview showed
  startInlineEdit(n, { isNew: true });   // drop straight into renaming; Esc cancels creation
}
function onCancel(): void {
  const n = endGhostDrag();
  if (n) { abortDrag(); deleteNode(n.id); commitStep(); }   // nets null→null, discarded
}

ghost.addEventListener('pointerdown', (e: PointerEvent) => {
  if (state.readOnly) return;
  e.preventDefault();
  endInPlaceEdit();                       // grabbing the ghost commits any in-progress edit
  // anchor the new card at the grab offset within the ghost (i.e. the ghost's own top-left in
  // world space), then drive it with the real drag so it rides the cursor at that same offset
  const r = ghost.getBoundingClientRect();
  const w = screenToWorld(r.left, r.top);
  newNode = createDetachedNode(w.x, w.y) ?? null;
  if (!newNode) return;
  try { ghost.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
  startNodeDrag(newNode, e.clientX, e.clientY);
  stopGhostDrag = trackPointer({ move: onMove, up: onUp, cancel: onCancel });
});
