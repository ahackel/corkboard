// ---------- a press on a card: taps, double-taps, and which gesture a pointerdown starts ----------
// bindNodeDrag is called by the render core (nodeEl) for each card. A press becomes a drag (features/drag.ts
// beginDrag), a marquee inside an unselected section, a pile gesture on a stack, or an image ripped out.
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

// The INNERMOST (deepest-nested) expanded section whose box contains the given screen point, or null.
// Nested sections overlap and stack by DOM order, so a press can't rely on the browser picking the
// innermost — this resolves it geometrically. Collapsed sections (rendered as cards) don't count.
function innermostSectionAt(clientX: number, clientY: number): MindNode | null {
  const p = { x: (clientX - state.view.x) / state.view.k, y: (clientY - state.view.y) / state.view.k };
  return deepestAt(state.nodes.values(), p, m => isSection(m) && !isHidden(m) ? nodeRect(m) : null, ancestorDepth);
}

// A two-finger tap is at most this long (longer = a pinch, or a rest), and the two taps of the
// gesture at most this far apart. Both a shade more generous than the one-finger 300ms: two fingers
// land and lift less crisply than one.
const TWO_TAP_MS = 250, TWO_TAP_GAP_MS = 450;

export function bindNodeDrag(n: MindNode): void {
  const el = n.el!;
  // Double-tap on touch -> open the node for editing (mirrors dblclick on desktop, and prevents iOS
  // double-tap zoom). Folding is the corner chip's job on both — tap the card, tap the chip.
  // …and a TWO-FINGER double-tap goes IN — the touch spelling of ⌥-double-click, and the reason a
  // one-finger double-tap gets to keep meaning "edit". `twoDown` is what makes it a TAP rather than a
  // pinch: a two-finger touchstart is also how a zoom begins, so the gesture only registers once
  // touchend confirms it was short, and two confirmed taps in quick succession open the node.
  let lastTouchTap = 0, twoDown = 0, lastTwoTap = 0, tapAt = 0;
  el.addEventListener('touchend', (e) => {
    if (twoDown && performance.now() - twoDown < TWO_TAP_MS) {
      lastTwoTap = performance.now();
    }
    twoDown = 0;
    // A tap that just OPENED this card's editor (features/activate.ts editOnClick, at the pointerup before this) keeps
    // the browser's emulated mouse events that follow a tap from landing: their mousedown, on the card
    // rather than in the new textarea, would take the focus straight back out and close it.
    if (openedSince(n.id, tapAt)) {
      e.preventDefault();
    }
  });
  el.addEventListener('touchstart', (e) => {
    // The innermost card owns the tap, exactly as it owns the dblclick (render.ts nodeEl): child cards
    // are DOM-nested, so without this every ancestor's own counter sees the same two taps and a
    // double-tap on a child fired activateNode all the way up the chain — renaming the child, then
    // opening its parent's note editor on top of it.
    e.stopPropagation();
    // While editing this node, let the browser handle double-tap normally (word selection) — unless the
    // first tap is what opened the editor (features/activate.ts editOnClick): that's a double-tap on the card, which
    // selects ALL of its text, as the dblclick does.
    const now = performance.now();
    tapAt = now;
    if (inPlaceEditOn(n.id)) {
      if (e.touches.length === 1 && now - lastTouchTap < 300 && openedSince(n.id, lastTouchTap)) {
        e.preventDefault();
        selectAllInEditor();
      }
      lastTouchTap = 0;
      return;
    }
    // The card's own controls act on a single tap (features/activate.ts isNodeControlAt): a tap there must not also
    // count toward a double-tap, or the second one would fire the button AND open the card.
    const t0 = e.touches[0];
    if (t0 && isNodeControlAt(t0.clientX, t0.clientY)) { lastTouchTap = 0; return; }
    // Two fingers never count toward the one-finger counter either way — otherwise letting go of a
    // pinch would leave a half-finished double-tap behind that the next single tap completed.
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
    if (e.touches.length === 1 && now - lastTouchTap < 300) {
      e.preventDefault(); // stop double-tap zoom and synthetic dblclick
      activateNode(n, t0.clientX, t0.clientY);   // mirror the dblclick handler
      lastTouchTap = 0;
      return;
    }
    lastTouchTap = now;
  }, { passive: false });
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) { e.stopPropagation(); return; }   // right-click = context menu only: no drag/select/rename
    // A descendant of a locked card can't be selected or dragged at all — only the locked card
    // itself (checked further below) remains reachable this way.
    if (hasLockedAncestor(n)) { e.stopPropagation(); return; }
    const tgt = e.target as HTMLElement;
    // A section's title is a folder TAB hanging OUTSIDE its box, above the top border (styles.css).
    // A press there is a press on the section ITSELF: it must take the ordinary card path below —
    // click selects (and renames once it is selected), a drag moves the section — so both section-specific
    // intercepts further down exempt it. `.node` scoping keeps it to this section's OWN tab.
    const onOwnTitle = tgt.closest('.node') === el && !!tgt.closest('.title-row');
    if (tgt.closest('input.taskbox') && isLockedEffective(n)) { e.stopPropagation(); e.preventDefault(); return; }  // locked: no task toggling
    if (tgt.closest('a.lk, input.taskbox, .img-zoom')) { e.stopPropagation(); return; }  // let links/checkboxes/zoom click, not drag
    // Alt-press over an inline body image (on a plain card) rips THAT image out — extraction rides
    // its own preview (features/image-extract.ts), not the card drag. Image-only cards drag whole.
    if (e.altKey && e.button === 0 && !isImageCard(n) && !isSection(n) && !isLockedEffective(n)) {
      const img = bodyImageAt(el, e.clientX, e.clientY);
      if (img && img.dataset.path) {
        e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        startImageExtractDrag(n, img, e.clientX, e.clientY);
        return;
      }
    }
    // Nested sections overlap and stack by DOM order (not nesting), so the section that received this
    // press may be an OUTER one. Prefer the INNERMOST section under the pointer: hand the gesture off
    // to it by re-firing the press on its element (its own handler then finds itself innermost and
    // proceeds). Only when the pressed node is an (expanded) section — a card on top, or a collapsed
    // section (which is just a card), is always taken as-is — and so is a press on this section's own
    // title tab, which hangs outside its box (so innermostSectionAt, a pure box hit-test, would
    // otherwise hand every nested section's tab press to the parent section the tab overlaps).
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
    // Close an editor open on a DIFFERENT node (tap-outside on touch where blur may not fire)
    if (ui.bodyEdit && ui.bodyEdit.id !== n.id) {
      endBodyEdit();
    }
    if (ui.titleEdit && ui.titleEdit.id !== n.id) {
      endTitleEdit();
    }

    // A plain press on a STACK's pile fans it out or lifts its top card off (features/stacks.ts). Its pin and
    // its name tab are the stack's own handles, and take the ordinary path below: select, move it whole.
    if (isStack(n) && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        && !tgt.closest('.stack-pin, .title-row')) {
      e.stopPropagation();
      beginPileGesture(n, e);
      return;
    }
    // while this node is being edited, let clicks place the caret — don't start a drag
    if (inPlaceEditOn(n.id)) { e.stopPropagation(); return; }
    // A drag inside an UNSELECTED (expanded) section rubber-band-selects the cards INSIDE it rather
    // than moving the section — you move the section from its interior only once it's selected. A
    // no-move click selects the section (endMarquee). ⌘/Ctrl-click still falls through to the normal
    // add-to-selection toggle. Its title TAB is the exception (onOwnTitle): the tab is the section's
    // own handle, so pressing it always takes the card path — a press there selects and drags the
    // section itself, the way a card's title does, rather than rubber-banding its contents.
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
