// A press on a card: taps, double-taps, and which gesture a pointerdown starts.
import { state, isImageCard, isStack, type MindNode } from '../core/state.js';
import { isHidden, hasLockedAncestor, isLockedEffective } from '../utils/model.js';
import { isSection, ancestorDepth } from '../view/layout.js';
import { ui, inPlaceEditOn } from '../core/ui-state.js';
import { beginMarqueeFromNode } from './gestures.js';
import { activateNode, openedSince, isNodeControlAt } from './activate.js';
import { endBodyEdit, endTitleEdit, selectAllInEditor } from './inline-edit.js';
import { startImageExtractDrag } from './image-extract.js';
import { bodyImageAt } from './images.js';
import { nodeRect } from '../view/geometry.js';
import { deepestAt } from '../utils/rect.js';
import { beginPileGesture } from './stacks.js';
import { beginDrag } from './drag.js';

// Nested sections stack by DOM order, not nesting, so the browser's hit can be an outer one.
function innermostSectionAt(clientX: number, clientY: number): MindNode | null {
  const p = { x: (clientX - state.view.x) / state.view.k, y: (clientY - state.view.y) / state.view.k };
  return deepestAt(state.nodes.values(), p, m => isSection(m) && !isHidden(m) ? nodeRect(m) : null, ancestorDepth);
}

const DOUBLE_TAP_MS = 300;

// Longer is a pinch. Two fingers land and lift less crisply than one, hence the wider gap.
const TWO_TAP_MS = 250, TWO_TAP_GAP_MS = 450;

export function bindNodeDrag(n: MindNode): void {
  const el = n.el!;
  // A double-tap edits (as dblclick); a TWO-FINGER double-tap opens (as ⌥-dblclick). A two-finger tap
  // only counts once touchend confirms it was short, since a pinch starts the same way.
  let lastTouchTap = 0, twoDown = 0, lastTwoTap = 0, tapAt = 0;
  el.addEventListener('touchend', (e) => {
    if (twoDown && performance.now() - twoDown < TWO_TAP_MS) {
      lastTwoTap = performance.now();
    }
    twoDown = 0;
    // A tap that just opened the editor blocks the emulated mousedown, which would steal its focus.
    if (openedSince(n.id, tapAt)) {
      e.preventDefault();
    }
  });
  el.addEventListener('touchstart', (e) => {
    // Cards are DOM-nested: without this, every ancestor's counter would see the same double-tap.
    e.stopPropagation();
    // While editing, a double-tap selects a word natively, unless its first tap opened the editor.
    const now = performance.now();
    tapAt = now;
    if (inPlaceEditOn(n.id)) {
      if (e.touches.length === 1 && now - lastTouchTap < DOUBLE_TAP_MS && openedSince(n.id, lastTouchTap)) {
        e.preventDefault();
        selectAllInEditor();
      }
      lastTouchTap = 0;
      return;
    }
    // A tap on a card control must not count toward a double-tap.
    const t0 = e.touches[0];
    if (t0 && isNodeControlAt(t0.clientX, t0.clientY)) { lastTouchTap = 0; return; }
    // Two fingers never count toward the one-finger double-tap, or a pinch would leave half of one.
    if (e.touches.length === 2) {
      if (now - lastTwoTap < TWO_TAP_GAP_MS) {
        e.preventDefault();
        lastTwoTap = 0; twoDown = 0;
        activateNode(n, t0?.clientX ?? 0, t0?.clientY ?? 0, { open: true });
      } else {
        twoDown = now;
      }
      return;
    }
    if (e.touches.length === 1 && now - lastTouchTap < DOUBLE_TAP_MS) {
      e.preventDefault(); // stop double-tap zoom and synthetic dblclick
      activateNode(n, t0.clientX, t0.clientY);
      lastTouchTap = 0;
      return;
    }
    lastTouchTap = now;
  }, { passive: false });
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) { e.stopPropagation(); return; }
    if (hasLockedAncestor(n)) { e.stopPropagation(); return; }
    const tgt = e.target as HTMLElement;
    // A section's title tab hangs OUTSIDE its box; a press there is on the section itself, so the
    // section-specific intercepts below exempt it.
    const onOwnTitle = tgt.closest('.node') === el && !!tgt.closest('.title-row');
    if (tgt.closest('input.taskbox') && isLockedEffective(n)) { e.stopPropagation(); e.preventDefault(); return; }
    if (tgt.closest('a.lk, input.taskbox, .img-zoom')) { e.stopPropagation(); return; }
    if (e.altKey && e.button === 0 && !isImageCard(n) && !isSection(n) && !isLockedEffective(n)) {
      const img = bodyImageAt(el, e.clientX, e.clientY);
      if (img && img.dataset.path) {
        e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        startImageExtractDrag(n, img, e.clientX, e.clientY);
        return;
      }
    }
    // Hand the press to the innermost section under the pointer by re-firing it there.
    if (isSection(n) && !onOwnTitle) {
      const inner = innermostSectionAt(e.clientX, e.clientY);
      if (inner && inner !== n && inner.el) {
        e.stopPropagation();
        inner.el.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
          button: e.button, buttons: e.buttons, pointerId: e.pointerId, pointerType: e.pointerType,
          isPrimary: e.isPrimary, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }));
        return;
      }
    }
    // On touch, blur may not fire when tapping another node.
    if (ui.bodyEdit && ui.bodyEdit.id !== n.id) {
      endBodyEdit();
    }
    if (ui.titleEdit && ui.titleEdit.id !== n.id) {
      endTitleEdit();
    }

    // The stack's pin and name tab are its handles; a press elsewhere on the pile is a pile gesture.
    if (isStack(n) && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        && !tgt.closest('.stack-pin, .title-row')) {
      e.stopPropagation();
      beginPileGesture(n, e);
      return;
    }
    if (inPlaceEditOn(n.id)) { e.stopPropagation(); return; }
    // Inside an UNSELECTED section a drag rubber-bands its cards; it moves only once selected.
    if (isSection(n) && !n.collapsed && !onOwnTitle && !state.sel.has(n.id) && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.stopPropagation();
      beginMarqueeFromNode(e, n.id);
      return;
    }
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    beginDrag(n, e);
  });
}
