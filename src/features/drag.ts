// ---------- node dragging & reparent-by-drop ----------
// Per-node pointer gestures: drag moves the whole subtree (or the multi-selection, as one group);
// Shift clones while dragging, ⌥-dropping onto a card merges into it, and on release every true root
// of the drag (see selRoots/trueRoots) belongs to the frame its centre is in — or the top level. That
// is the whole drop rule (view/layout.ts frameAt), so a multi-selected group moves in and out of
// frames together in one gesture. Edge
// auto-pan keeps the dragged subtree glued under the cursor while the view scrolls. All transient
// drag state lives in `ui.drag`. Importing this module registers the global Alt/Shift modifier
// listeners; bindNodeDrag is called by the render core (nodeEl) for each card.
import { state, stage, setStatus, isImageCard, type MindNode } from '../core/state.js';
import { nodeLabel, isHidden, isAncestor, hasLockedAncestor, isLockedEffective, parentOf, childrenOf } from '../utils/model.js';
import { detachParentId } from '../nav/scope.js';
import { isFrame, collectsCards, frameAt, ancestorDepth, containerBox, centreInFrame } from '../view/layout.js';
import { cancelViewAnim, applyView } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { ui, inPlaceEditOn, type Pt, type Drag } from '../core/ui-state.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { snapTo } from '../utils/num.js';
import { beginMarqueeFromNode } from './gestures.js';
import { nodeW, nodeH, gridSnap, paintAll, paintNode, selectNode, setSelectionSet, toggleSel, subtreeIds, activateNode, isNodeControlAt, relayout, remeasure } from '../main.js';
import { endBodyEdit, endTitleEdit } from './inline-edit.js';
import { leaveClone, mergeCardsInto, canMerge } from './crud.js';
import { startImageExtractDrag } from './image-extract.js';
import { touch, commitStep } from './history.js';
import { bodyImageAt } from './images.js';
import { guidePull, hideGuides } from './guides.js';
import { growFramesToHold } from './float-bar.js';


// True roots of a drag-selection set: a member whose own parent is ALSO in the set rides along
// with it (it's already carried as part of that ancestor's subtree), so only the outermost
// members get individually re-parented on drop. Shared by drag-start and the clone-revert path
// (which needs to recompute the ORIGINAL roots after handing selRoots off to the clones).
function trueRoots(ids: string[]): string[] {
  const idSet = new Set(ids);
  return ids.filter(id => { const p = state.nodes.get(id)?.parent; return !p || !idSet.has(p); });
}

// Is a screen point outside the browser window? True once a drag has left for another app.
const outsideWindow = (x: number, y: number): boolean =>
  x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

// The drag delta with the GRID applied (utils/num.ts snapTo): the ANCHOR card's own position is what
// lands on the grid, and the correction it needs is applied to every card in the drag — so a
// multi-selection keeps its internal spacing exactly and moves as one piece. A card inside a frame
// snaps relative to that box's own corner, because that is the coordinate space its position
// lives in. Live, every move: the card is always ON a grid position and steps to the next as the
// pointer crosses the halfway line, so what you are looking at is always what a release would keep.
function snappedDelta(drag: Drag, dx: number, dy: number): Pt {
  // `active`, not `n`: with Shift held the drag switches to a CLONE of the card (applyDragClone), and
  // `drag.targets` is re-keyed to the clones — so keying this off the original found nothing, fell back
  // to the raw delta, and a Shift-drag was the one drag that ignored the grid. `active` is also what the
  // drop's own reparent path treats as the representative, so both ends of the gesture agree.
  const act = drag.active;
  const s = drag.targets.get(act.id);
  if (!s) return { x: dx, y: dy };
  const fp = parentOf(act);
  const inBox = !!(fp && isFrame(fp));
  const ax = inBox ? fp!.x : 0, ay = inBox ? fp!.y : 0;
  const g = gridSnap();
  const grid = { x: snapTo(s.x + dx - ax, g) + ax - s.x, y: snapTo(s.y + dy - ay, g) + ay - s.y };
  // Smart guides (features/guides.ts) win over the grid on an axis where something lines up with the
  // RAW pointer position — read before the grid rounds it, or a 20px step would jump right past a
  // 6px pull. Off while ⌥ is held: the card is going INTO another card's note then.
  if (drag.alt || drag.cardMerge) { hideGuides(); return grid; }
  const roots: Array<{ n: MindNode; s: Pt }> = [];
  for (const [id, st] of drag.targets) {
    const m = state.nodes.get(id);
    if (m && !(m.parent && drag.targets.has(m.parent))) roots.push({ n: m, s: st });
  }
  const pull = guidePull(act, roots, new Set(drag.targets.keys()), dx, dy);
  return { x: pull.x != null ? dx + pull.x : grid.x, y: pull.y != null ? dy + pull.y : grid.y };
}

// Move every dragged card to start + (dx,dy) in world space, mirroring it with a compositor-only
// transform (left/top stay frozen at the card's origin). Shared by the pointermove, auto-pan, and
// modifier-follow paths — all three apply the same offset to drag.targets.
function applyDragTransform(drag: Drag, dx: number, dy: number): void {
  ({ x: dx, y: dy } = snappedDelta(drag, dx, dy));
  for (const [id, s] of drag.targets){
    const m = state.nodes.get(id); if (!m) continue;
    m.x = s.x + dx; m.y = s.y + dy; m.dirtyLayout = true;
    if (m.el) {
      const orig = drag.origins.get(id);
      if (orig) {
        // A node hosted inside a frame that's ALSO part of this drag is already carried visually
        // by that frame's frameContentEl transform below (its left/top sit inside that container,
        // which itself is about to move) — giving it its own transform too would add the same
        // shift twice. Only "roots" of the dragged subtree(s) — no host, or a host that isn't
        // moving in this same gesture — need an explicit transform of their own.
        const carried = m.hostFrameId != null && drag.targets.has(m.hostFrameId);
        const t = carried ? '' : `translate(${m.x-orig.x}px,${m.y-orig.y}px)`;
        m.el.style.transform = t;
        // An expanded frame's overflow:hidden content wrapper (frameContentEl) is a second,
        // separately-positioned element (left/top only re-synced by a full paintNode) — mirror
        // the same compositor transform onto it (only when this frame itself is a root — a
        // carried frame's wrapper is already moving with its own host's transform) so the clip
        // window slides with the frame instead of staying stranded at its pre-drag position.
        if (m.frameContentEl) m.frameContentEl.style.transform = t;
      }
    }
  }
}

// While a node is dragged to the screen edge, pan the view so you can drop onto cards that are
// currently off-screen. The view pans toward the edge the cursor sits in, and the dragged subtree
// is shifted in world-space by the inverse so it stays glued under the (stationary) cursor.
// Drain the deferred drag paint: update drop-target highlight and redraw edges every frame.
function flushDragPaint(): void {
  ui.dragRAF = null;
  const drag = ui.drag;
  if (!drag) return;
  if (drag.moved) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  paintFreeEdges();   // n.x/y is current, so edges track the dragged nodes correctly
  if (drag.moved && !ui.autoPanRAF) ui.autoPanRAF = requestAnimationFrame(autoPanStep);
}
function stopAutoPan(): void { if (ui.autoPanRAF){ cancelAnimationFrame(ui.autoPanRAF); ui.autoPanRAF = null; } }
function autoPanStep(): void {
  ui.autoPanRAF = null;
  const drag = ui.drag;
  if (!drag || !drag.moved || state.readOnly) return;
  // Available canvas = the stage minus the toolbar (above it) and, on wide screens, the outline
  // drawer when it's open (the floating edit bar overlays the card itself rather than docking to
  // a screen edge, so it's not an obstruction here). Panning kicks in as the cursor reaches that
  // obstruction, so you can drag onto / past it — and so it doesn't start abruptly only once
  // the cursor slips BEHIND the outline drawer to the true window edge.
  const r = stage.getBoundingClientRect();
  const right = r.right;
  const M = 56, MAX = 16;   // edge band (px) and max pan speed (px/frame)
  let vx = 0, vy = 0;
  const x = drag.cx, y = drag.cy;
  // Pan only while the pointer is still INSIDE the browser window: once it crosses out
  // (e.g. a drag heading for another app), scrolling on would carry the map away under it.
  if (!outsideWindow(x, y)){
    if (x < r.left + M)     vx =  Math.min(1, (r.left + M - x) / M);
    else if (x > right - M) vx = -Math.min(1, (x - (right - M)) / M);
    if (y < r.top + M)        vy =  Math.min(1, (r.top + M - y) / M);
    else if (y > r.bottom - M) vy = -Math.min(1, (y - (r.bottom - M)) / M);
  }
  if (vx || vy){
    cancelViewAnim();
    vx *= MAX; vy *= MAX;
    state.view.x += vx; state.view.y += vy; applyView();
    // shift the dragged subtree's anchors opposite the pan so the cursor-to-card offset never
    // changes (only `targets` — `start` keeps its own positions for clone/reset).
    const wdx = -vx / state.view.k, wdy = -vy / state.view.k;
    for (const s of drag.targets.values()){ s.x += wdx; s.y += wdy; }
    applyDragTransform(drag, (drag.cx - drag.sx) / state.view.k, (drag.cy - drag.sy) / state.view.k);
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    paintFreeEdges();   // redraw edges every auto-pan frame so they follow the moving nodes
  }
  ui.autoPanRAF = requestAnimationFrame(autoPanStep);
}
// The INNERMOST (deepest-nested) expanded frame whose box contains the given screen point, or null.
// Nested frames overlap and stack by DOM order, so a press can't rely on the browser picking the
// innermost — this resolves it geometrically. Collapsed frames (rendered as cards) don't count.
function innermostFrameAt(clientX: number, clientY: number): MindNode | null {
  const wx = (clientX - state.view.x) / state.view.k, wy = (clientY - state.view.y) / state.view.k;
  let best: MindNode | null = null, bestDepth = -1;
  for (const m of state.nodes.values()) {
    if (!isFrame(m) || isHidden(m)) continue;
    if (wx < m.x || wx > m.x + nodeW(m) || wy < m.y || wy > m.y + nodeH(m)) continue;
    const depth = ancestorDepth(m);
    if (depth > bestDepth) { bestDepth = depth; best = m; }
  }
  return best;
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
  let lastTouchTap = 0, twoDown = 0, lastTwoTap = 0;
  el.addEventListener('touchend', () => {
    if (twoDown && performance.now() - twoDown < TWO_TAP_MS) lastTwoTap = performance.now();
    twoDown = 0;
  }, { passive: true });
  el.addEventListener('touchstart', (e) => {
    // The innermost card owns the tap, exactly as it owns the dblclick (main.ts nodeEl): child cards
    // are DOM-nested, so without this every ancestor's own counter sees the same two taps and a
    // double-tap on a child fired activateNode all the way up the chain — renaming the child, then
    // opening its parent's note editor on top of it.
    e.stopPropagation();
    // While editing this node, let the browser handle double-tap normally (word selection)
    if (inPlaceEditOn(n.id)) { lastTouchTap = 0; return; }
    // The card's own controls act on a single tap (main.ts isNodeControlAt): a tap there must not also
    // count toward a double-tap, or the second one would fire the button AND open the card.
    const t0 = e.touches[0];
    if (t0 && isNodeControlAt(t0.clientX, t0.clientY)) { lastTouchTap = 0; return; }
    const now = performance.now();
    // Two fingers never count toward the one-finger counter either way — otherwise letting go of a
    // pinch would leave a half-finished double-tap behind that the next single tap completed.
    if (e.touches.length === 2) {
      if (now - lastTwoTap < TWO_TAP_GAP_MS) {
        e.preventDefault();
        lastTwoTap = 0; twoDown = 0;
        activateNode(n, t0?.clientX ?? 0, t0?.clientY ?? 0, { open: true });
      } else twoDown = now;
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
    // A frame's title is a folder TAB hanging OUTSIDE its box, above the top border (styles.css).
    // A press there is a press on the frame ITSELF: it must take the ordinary card path below —
    // click selects, a double-click renames, a drag moves the frame — so both frame-specific
    // intercepts further down exempt it. `.node` scoping keeps it to this frame's OWN tab.
    const onOwnTitle = tgt.closest('.node') === el && !!tgt.closest('.title-row');
    if (tgt.closest('input.taskbox') && isLockedEffective(n)) { e.stopPropagation(); e.preventDefault(); return; }  // locked: no task toggling
    if (tgt.closest('a.lk, input.taskbox, .img-zoom')) { e.stopPropagation(); return; }  // let links/checkboxes/zoom click, not drag
    // Alt-press over an inline body image (on a plain card) rips THAT image out — extraction rides
    // its own preview (features/image-extract.ts), not the card drag. Image-only cards drag whole.
    if (e.altKey && e.button === 0 && !state.readOnly && !isImageCard(n) && !isFrame(n) && !isLockedEffective(n)) {
      const img = bodyImageAt(el, e.clientX, e.clientY);
      if (img && img.dataset.path) {
        e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        startImageExtractDrag(n, img, e.clientX, e.clientY);
        return;
      }
    }
    // Nested frames overlap and stack by DOM order (not nesting), so the frame that received this
    // press may be an OUTER one. Prefer the INNERMOST frame under the pointer: hand the gesture off
    // to it by re-firing the press on its element (its own handler then finds itself innermost and
    // proceeds). Only when the pressed node is an (expanded) frame — a card on top, or a collapsed
    // frame (which is just a card), is always taken as-is — and so is a press on this frame's own
    // title tab, which hangs outside its box (so innermostFrameAt, a pure box hit-test, would
    // otherwise hand every nested frame's tab press to the parent frame the tab overlaps).
    if (isFrame(n) && !onOwnTitle) {
      const inner = innermostFrameAt(e.clientX, e.clientY);
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
    if (ui.bodyEdit && ui.bodyEdit.id !== n.id) endBodyEdit();
    if (ui.titleEdit && ui.titleEdit.id !== n.id) endTitleEdit();
    // while this node is being edited, let clicks place the caret — don't start a drag
    if (inPlaceEditOn(n.id)) { e.stopPropagation(); return; }
    // A drag inside an UNSELECTED (expanded) frame rubber-band-selects the cards INSIDE it rather
    // than moving the frame — you move the frame from its interior only once it's selected. A
    // no-move click selects the frame (endMarquee). ⌘/Ctrl-click still falls through to the normal
    // add-to-selection toggle. Its title TAB is the exception (onOwnTitle): the tab is the frame's
    // own handle, so pressing it always takes the card path — a press there selects and drags the
    // frame itself, the way a card's title does, rather than rubber-banding its contents.
    if (isFrame(n) && !n.collapsed && !onOwnTitle && !state.sel.has(n.id) && e.button === 0 && !e.metaKey && !e.ctrlKey) {
      e.stopPropagation();
      beginMarqueeFromNode(e, n.id);
      return;
    }
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    // Dragging a card that's part of a multi-selection moves the WHOLE selection at once;
    // otherwise just this card's subtree. `active` is the node dragged/dropped; `targets`
    // are the nodes that follow the cursor (or, after a Shift-clone, just the clone).
    const multi = state.sel.has(n.id) && state.sel.size > 1;
    // A locked member of a multi-selection stays put — only its unlocked companions get dragged
    // (pressing directly ON a locked card is handled separately in dragPointerMove, which pins the
    // whole gesture since `n` itself owns it).
    const rootIds = (multi ? [...state.sel] : [n.id])
      .filter(id => id === n.id || !isLockedEffective(state.nodes.get(id)!));
    const selRoots = trueRoots(rootIds);
    const ids = [...new Set(rootIds.flatMap(id => subtreeIds(id)))];
    const start = new Map(ids.map(id => {
      const m = state.nodes.get(id)!; return [id, { x:m.x, y:m.y }] as [string, Pt];
    }));
    // targets gets its OWN {x,y} objects (not new Map(start), which shares the value refs) so the
    // edge auto-pan can shift the dragged anchors without also moving the pinned `start` positions.
    const targets = new Map([...start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    // Positions mutate live during the drag, so the undo pre-images must be captured NOW;
    // dragPointerUp commits the step (a no-move click nets out and is discarded).
    touch(...ids);
    // origins = the left/top CSS values frozen at drag start; transforms are relative to these
    const origins = new Map(ids.map(id => { const m2 = state.nodes.get(id)!; return [id, { x:m2.x, y:m2.y }] as [string, Pt]; }));
    ui.drag = { n, active:n, multi, sx:e.clientX, sy:e.clientY, cx:e.clientX, cy:e.clientY, start, targets, origins, selRoots,
             moved:false, dropTarget:n.parent, alt:e.altKey, shift:e.shiftKey, cloned:false,
             meta: e.metaKey || e.ctrlKey,     // ⌘/Ctrl-click toggles this card in the selection
             touch: e.pointerType === 'touch',  // higher move threshold for finger taps
             cardMerge: null };
    for (const id of ids) { const m2 = state.nodes.get(id); if (m2?.el){ m2.el.style.willChange = 'transform'; m2.el.classList.add('dragging'); } }
    // Continue/commit this drag on `window`, not `el` — pointer capture (above) is still requested
    // best-effort so the dragged card's own hover/other handlers stay quiet, but capture can be
    // lost across a mid-drag re-render (paintAll runs while dragging). A lost capture hands pointerup to whatever's actually under the cursor instead —
    // e.g. the frame it's dropped in — whose own pointerdown-scoped listener has nothing to do with
    // THIS gesture, so the event used to vanish, leaving the (Shift-cloned or moved) card invisible. `pointercancel` (tab switch, interrupted
    // touch) commits in place too, for the same reliability reason. Listeners are added/removed per
    // gesture (not left permanently on window) so they can't double-fire alongside the ghost-card
    // flow's own window listeners in main.ts, which drives its drag through the same dragPointerMove
    // /dragPointerUp via feedDragMove/commitDrag.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // Guard on `ui.drag.n === n` (not just truthiness): there's a single shared `ui.drag` slot, so
    // if a second card's pointerdown ever hijacks it before this gesture's up/cancel arrives (e.g.
    // true two-finger touch on two different cards at once), this stale pair must still remove
    // itself without touching the OTHER drag that's now live.
    function onMove(ev: PointerEvent): void { if (ui.drag && ui.drag.n === n) dragPointerMove(ev); }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (ui.drag && ui.drag.n === n) dragPointerUp();
    }
  });
}
// Body of a drag pointermove, operating on the live ui.drag (the node that owns the gesture is
// whatever drag.n is). Shared by the per-card handler and the ghost-card "drag a new note" flow.
function dragPointerMove(e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): void {
  const drag = ui.drag;
  if (!drag) return;
  if (state.readOnly) return;        // no moving/reparenting in read-only (click & dbl-click still work)
  // Pressing directly on a locked card: never treat it as a drag (click/double-click select/rename
  // still resolve normally on release since drag.moved stays false) — no move, no reparent.
  if (isLockedEffective(drag.n)) return;
  drag.alt = e.altKey; drag.shift = e.shiftKey;   // Shift = clone (live — release to cancel), Alt = detach
  drag.cx = e.clientX; drag.cy = e.clientY;   // remembered for edge auto-pan and RAF flush
  const dx = (e.clientX - drag.sx)/state.view.k, dy = (e.clientY - drag.sy)/state.view.k;
  const wasMoved = drag.moved;
  if (Math.abs(dx)+Math.abs(dy) > (drag.touch ? 8 : 2)){ drag.moved = true; document.body.classList.add('grabbing'); }
  // The instant a drag begins, repaint the dragged cards so any frame child lifts OUT of its
  // frame's overflow:hidden wrapper into #world (see paintNode) — otherwise it stays clipped to
  // the frame bounds until the next drop-target change, masking it while it's dragged out.
  if (drag.moved && !wasMoved)
    for (const id of drag.targets.keys()) { const m = state.nodes.get(id); if (m) paintNode(m); }
  // Below the threshold this gesture is still a CLICK, and a click never moves anything. It used to
  // fall through to applyDragTransform anyway, which snaps (snappedDelta) — so one pixel of jitter
  // while selecting a card was enough to land it on the next grid position and leave it there, since
  // the pointerup below only selects when `!drag.moved` and restores no position. Selecting is not a
  // placement: nothing may write x/y until the pointer has actually gone somewhere.
  if (!drag.moved) return;
  applyDragClone();   // Shift held -> leave a clone & drag the copy; Shift released -> undo it
  // Update world-space positions immediately (cheap) — visual render is deferred to rAF so that
  // multiple pointermove events arriving within one display frame collapse into a single paint.
  // (applyDragClone may have swapped drag.targets/origins for the clones — re-read via ui.drag.)
  applyDragTransform(ui.drag!, dx, dy);
  if (!ui.dragRAF) ui.dragRAF = requestAnimationFrame(flushDragPaint);
}
// Body of a drag pointerup: commit the move/reparent (or handle a plain click). Operates on the
// live ui.drag. Shared by the per-card handler and the ghost-card flow.
function dragPointerUp(): void {
    stopAutoPan();
    hideGuides();
    if (ui.dragRAF){ cancelAnimationFrame(ui.dragRAF); ui.dragRAF = null; }
    const drag = ui.drag;
    if (drag) {
      const n = drag.n;
      // Clear compositor transforms so paintAll()/paintNode() can commit final left/top cleanly.
      for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
        const m2 = state.nodes.get(id);
        if (m2?.el){ m2.el.style.transform = ''; m2.el.style.willChange = ''; m2.el.classList.remove('dragging'); }
        if (m2?.frameContentEl) m2.frameContentEl.style.transform = '';
      }
      const act = drag.active;
      // Released OUTSIDE the browser window → cancel the whole gesture, OS-style snap-back.
      // Committing here would strand the card far off-canvas (and rip-detach it), which reads
      // as "my card got deleted". Everything returns to where the drag started.
      if (drag.moved && outsideWindow(drag.cx, drag.cy)){
        cancelDragRestore();
        setStatus('Drag cancelled — released outside the window');
        return;
      }
      if (!drag.moved) {
        // A plain click (no move) = select/rename, not a drag. Clear ui.drag BEFORE selecting:
        // selectNode/toggleSel repaint via paintAll, and paintNode re-adds the `.dragging` class
        // (opacity .75) for any node still in ui.drag.targets — leaving the selected card
        // semi-transparent. Nulling here means the repaint sees no active drag.
        ui.drag = null;
        if (drag.meta) toggleSel(n.id);                 // ⌘/Ctrl-click: add/remove from selection
        else if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);   // reduce a multi-selection to this card
        // A click only ever SELECTS. Editing in place is the double-click's job (main.ts
        // activateNode) — the slow-second-click rename this used to schedule was a 260ms timer racing
        // that double-click, and every fresh interaction had to remember to cancel it.
      } else {
        // ⌥ over a card merges into it; otherwise every dragged root belongs to the frame its
        // centre is in, else the top level (frameAt — the same test the preview ran).
        const { cloned, targets, clones, selRoots, cardMerge } = drag;
        clearDropTarget();
        // Null drag NOW so every paint in the commit phase sees no active drag and draws all edges.
        ui.drag = null;
        document.body.classList.remove('grabbing');
        // ⌥-drop plain CARD(s) onto another card (cardMerge, resolved by updateDropTarget): fold
        // their notes into that card's body under `## Title` headings and let them go. The card you
        // dropped ONTO is the one that survives — it keeps its id, its file and everything on it.
        const fuseNode = cardMerge ? state.nodes.get(cardMerge) : null;
        if (fuseNode) {
          const merged = mergeCardsInto(fuseNode.id, selRoots);
          if (merged){
            setStatus(merged > 1
              ? `Merged ${merged} cards into “${nodeLabel(fuseNode)}”`
              : `Merged “${nodeLabel(act)}” into “${nodeLabel(fuseNode)}”`);
            remeasure();
            selectNode(fuseNode.id);
            scheduleSave(); commitStep();
            return;
          }
        }
        // THE drop rule. Per root, from its own centre, so a group straddling a frame's edge splits
        // the way it looks. Positions stay exactly where they were dropped — snappedDelta already put
        // them on the grid (or on a guide) on every move, so a release changes nothing about WHERE.
        const moving = new Set(targets.keys());
        for (const rootId of selRoots){
          const r = state.nodes.get(rootId); if (!r) continue;
          const f = frameAt(r.x + nodeW(r) / 2, r.y + nodeH(r) / 2, moving);
          const np = f?.id ?? detachParentId();
          if (np !== r.parent) reparentOnly(rootId, np);
        }
        // Paint first so freshly-created clone cards have real DOM heights, then let each frame that
        // now holds a dropped card grow to show all of it (it clips, so part of it would be lost).
        // A dropped FRAME also collects whatever it now covers (settleFrames).
        remeasure();
        const settled = settleFrames(selRoots.filter(id => state.nodes.get(id)?.type === 'frame'));
        if (growFramesToHold([...selRoots, ...settled]) || settled.length) relayout();
        // select the new clone(s) you just dragged out
        if (cloned){ if (clones && clones.length > 1) setSelectionSet(clones.map(c => c.id)); else selectNode(act.id); }
        scheduleSave();
        commitStep();   // the whole gesture (move/reparent/clone) = ONE undo step
        return;   // drag/grabbing already cleared above
      }
    }
    ui.drag = null;
    document.body.classList.remove('grabbing');
    commitStep();   // plain click / unmoved drag: nothing changed → step is discarded
}
// Begin a programmatic drag of an already-created node from a screen point, as if the user had
// pressed down on it there. Used by the ghost-card "drag a new note" flow so a freshly-made card
// rides the cursor through the exact same move/drop machinery as an existing
// card. `moved` starts true so even a release without motion commits the placement.
export function startNodeDrag(n: MindNode, clientX: number, clientY: number): void {
  const start = new Map<string, Pt>([[n.id, { x:n.x, y:n.y }]]);
  const targets = new Map<string, Pt>([[n.id, { x:n.x, y:n.y }]]);
  const origins = new Map<string, Pt>([[n.id, { x:n.x, y:n.y }]]);
  ui.drag = { n, active:n, multi:false, sx:clientX, sy:clientY, cx:clientX, cy:clientY,
    start, targets, origins, selRoots:[n.id], moved:true, dropTarget:n.parent,
    alt:false, shift:false, cloned:false, meta:false, touch:false, cardMerge:null };
  if (n.el){ n.el.style.willChange = 'transform'; n.el.classList.add('dragging'); }
  document.body.classList.add('grabbing');
}
// Forward a move/up from an external (ghost-card) drag into the shared drag machinery.
export function feedDragMove(clientX: number, clientY: number): void {
  dragPointerMove({ clientX, clientY, altKey:false, shiftKey:false });
}
export function commitDrag(): void { dragPointerUp(); }
// Abort the live drag with no commit: clear the drop highlight and any
// compositor transforms, then forget the gesture. The caller is responsible for the dragged node.
export function abortDrag(): void {
  stopAutoPan();
  if (ui.dragRAF){ cancelAnimationFrame(ui.dragRAF); ui.dragRAF = null; }
  const drag = ui.drag;
  if (!drag) return;
  clearDropTarget();
  hideGuides();
  for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
    const m = state.nodes.get(id);
    if (m?.el){ m.el.style.transform = ''; m.el.style.willChange = ''; m.el.classList.remove('dragging'); }
    if (m?.frameContentEl) m.frameContentEl.style.transform = '';
  }
  ui.drag = null;
  document.body.classList.remove('grabbing');
}
// Cancel the live drag AND put everything back where the gesture started, OS-style snap-back:
// Shift-clones are removed (they never existed), every dragged card returns to its start
// position, and the pending undo step nets out. Shared by the released-outside-the-window
// cancel and the ⌥-drag file-export takeover (clipboard.ts).
export function cancelDragRestore(): void {
  const drag = ui.drag;
  if (!drag) return;
  for (const clone of (drag.cloned && drag.clones) || []){
    state.nodes.delete(clone.id); clone.el?.remove();
  }
  for (const [id, s] of drag.start){
    const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = true; }
  }
  abortDrag();
  relayout();   // no new cards to measure — one layout + paint suffices
  commitStep();   // nothing changed → the pending step nets out and is discarded
}
// Bring the Shift-clone state in line with the live `drag.shift` flag. Shift down (and moved past
// the threshold) leaves a clone of each dragged card at its start spot and drags the COPIES away;
// Shift released before drop deletes the clones and reverts to plain-moving the originals.
function applyDragClone(): void {
  const drag = ui.drag;
  if (!drag || !drag.moved) return;
  if (drag.shift && !drag.cloned){
    drag.cloned = true;
    for (const [id, s] of drag.start){             // pin the original subtree(s) back to start
      const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; m.dirtyLayout = false; }
      // revert their compositor transforms — `drag.active` is about to switch to the clone
      if (m?.el) { m.el.style.transform = ''; }
      if (m?.frameContentEl) { m.frameContentEl.style.transform = ''; }
    }
    // clone each dragged ROOT (just the card, not its subtree) at its own start spot
    const rootIds = drag.selRoots;
    const clones = rootIds.map(id => leaveClone(state.nodes.get(id)!, drag!.start.get(id)!));
    drag.clones = clones;
    drag.active = clones[0];                        // representative (drives the landing snap)
    drag.selRoots = clones.map(c => c.id);           // reparent the clones on drop, not the originals
    drag.targets = new Map(rootIds.map((id, i) => { const sp = drag!.start.get(id)!; return [clones[i].id, { x:sp.x, y:sp.y }] as [string, Pt]; }));
    drag.origins = new Map([...drag.targets].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    paintAll();                                    // render + bind the new clone nodes
  } else if (!drag.shift && drag.cloned){
    for (const clone of (drag.clones || [])){
      if (clone.el){ clone.el.style.transform = ''; clone.el.style.willChange = ''; }
      if (clone.frameContentEl){ clone.frameContentEl.style.transform = ''; }
      state.nodes.delete(clone.id); clone.el?.remove();   // drop the clones we made
    }
    drag.clones = null;
    drag.cloned = false;
    drag.active = drag.n;                           // back to dragging the original
    drag.selRoots = trueRoots(drag.multi ? [...state.sel] : [drag.n.id]);   // clones are gone — back to the originals' roots
    drag.targets = new Map([...drag.start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    drag.origins = new Map([...drag.start]);         // restore origins for the original subtree
    setStatus(`Duplication cancelled — moving "${nodeLabel(drag.n)}"`);
    paintAll();
  }
}
// Snap the dragged subtree (and drop-target / edges) to the current cursor without a pointer move —
// used when a modifier toggles mid-drag, so the result is reflected instantly while the mouse is still.
function dragFollow(): void {
  const drag = ui.drag;
  if (!drag) return;
  applyDragTransform(drag, (drag.cx - drag.sx)/state.view.k, (drag.cy - drag.sy)/state.view.k);
  if (drag.moved) updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  paintFreeEdges();   // modifier changed mid-drag — always repaint (infrequent)
}
// Update the detach preview the instant Alt is pressed/released mid-drag, even if the pointer
// isn't moving: repaint the dragged subtree (its colour previews the detached result) and re-resolve
// the drop target — ⌥ doesn't only mean "detach", it's also what turns a drop onto a card into a
// MERGE (and an image drop into a fold), so the target's dashed outline has to appear the moment the
// key goes down rather than on the next mouse jiggle. dragFollow repaints the edges as well.
function paintDetachPreview(): void {
  if (ui.drag) for (const id of subtreeIds(ui.drag.active.id)){ const m = state.nodes.get(id); if (m) paintNode(m); }
  dragFollow();
}
window.addEventListener('keydown', (e) => {
  const drag = ui.drag;
  if (!drag) return;
  if (e.key === 'Alt'){ drag.alt = true;  paintDetachPreview(); }
  if (e.key === 'Shift'){ drag.shift = true;  applyDragClone(); dragFollow(); }
});
window.addEventListener('keyup',   (e) => {
  const drag = ui.drag;
  if (!drag) return;
  if (e.key === 'Alt'){ drag.alt = false; paintDetachPreview(); }
  if (e.key === 'Shift'){ drag.shift = false; applyDragClone(); dragFollow(); }
});

// ---------- the drop preview ----------
// What a release right now would do, shown while it's still a choice: with ⌥ held over a plain card,
// a MERGE into it (a dashed outline on that card); otherwise the frame the dragged card would land in
// lights up — only when that's a change, i.e. the card is about to go INTO a frame it isn't in yet.
// `drag.dropTarget` records the resolved new parent (null = the top level) for effectiveColor, so an
// inheriting card previews the colour it's about to take.
function updateDropTarget(dragged: MindNode, e: { clientX: number; clientY: number }): void {
  const drag = ui.drag; if (!drag) return;
  const sub = new Set(drag.targets.keys());
  clearDropTarget();
  let fuse: string | null = null;
  const mergeDrag = drag.alt && drag.selRoots.length > 0
    && drag.selRoots.every(id => { const m = state.nodes.get(id); return !!m && canMerge(m); });
  if (mergeDrag) {
    // the CARD under the pointer (frames never take a merge — canMerge), first hit wins
    const wx = (e.clientX - state.view.x) / state.view.k, wy = (e.clientY - state.view.y) / state.view.k;
    for (const [id, m] of state.nodes) {
      if (sub.has(id) || isHidden(m) || m.type !== 'card') continue;
      if (wx >= m.x && wx <= m.x + nodeW(m) && wy >= m.y && wy <= m.y + nodeH(m)) { if (canMerge(m)) fuse = id; break; }
    }
  }
  const f = fuse ? null : frameAt(dragged.x + nodeW(dragged) / 2, dragged.y + nodeH(dragged) / 2, sub);
  const target = fuse ? dragged.parent : (f?.id ?? detachParentId());
  const changed = drag.dropTarget !== target;
  drag.dropTarget = target; drag.cardMerge = fuse;
  if (changed) for (const id of sub) { const m = state.nodes.get(id); if (m) paintNode(m); }
  if (fuse) state.nodes.get(fuse)!.el?.classList.add('drop-merge');
  else if (f && f.id !== dragged.parent) f.el?.classList.add('drop-target');
}
function clearDropTarget(): void {
  document.querySelectorAll('.node.drop-target, .node.drop-merge')
    .forEach(el => el.classList.remove('drop-target', 'drop-merge'));
}
// A frame COLLECTS what it covers — the drop rule run from the frame's side, FigJam-style. After a frame
// is moved, resized or made, every card whose centre is now in it belongs to it (frameAt: the
// innermost frame wins, so a card sitting in a smaller frame inside it stays there), and every card of
// its own whose centre is now OUTSIDE it goes to whatever it's over instead (a shrink lets go of what
// it no longer covers, rather than hiding it under the clip). A FRAME is collected only when its whole
// box is inside — by its centre alone, a big frame could be swallowed by a small one laid across it.
// Locked and hidden things stay where they are. Returns the ids it reparented, for the caller to grow
// their new frames by (growFramesToHold) — or not, on a resize, where the user is setting the size.
export function settleFrames(frameIds: Iterable<string>): string[] {
  const moved: string[] = [];
  for (const id of frameIds) {
    const f = state.nodes.get(id);
    if (!f || !collectsCards(f)) continue;
    const b = containerBox(f);
    const inside = (m: MindNode): boolean => m.x >= b.x && m.y >= b.y && m.x + nodeW(m) <= b.x + b.w && m.y + nodeH(m) <= b.y + b.h;
    // let go of its own cards that left it…
    for (const k of childrenOf(f.id)) {
      if (isHidden(k) || isLockedEffective(k) || centreInFrame(k, f)) continue;
      const to = frameAt(k.x + nodeW(k) / 2, k.y + nodeH(k) / 2, new Set(subtreeIds(k.id)));
      if (reparentOnly(k.id, to?.id ?? detachParentId())) moved.push(k.id);
    }
    // …and take in what it now covers.
    for (const n of state.nodes.values()) {
      if (n === f || n.parent === f.id || isHidden(n) || isLockedEffective(n)) continue;
      if (isAncestor(n.id, f.id) || isAncestor(f.id, n.id)) continue;   // its own frames, or inside it already
      if (n.type === 'frame' ? !inside(n) : !centreInFrame(n, f)) continue;
      if (frameAt(n.x + nodeW(n) / 2, n.y + nodeH(n) / 2, new Set(subtreeIds(n.id))) !== f) continue;
      if (reparentOnly(n.id, f.id)) moved.push(n.id);
    }
  }
  return moved;
}
// Move one card into a frame, or out to the top level (null). Mutates the parent only — no paint or
// status; dragPointerUp settles the canvas once for the whole dragged group. Refuses a locked card or
// frame, and a frame into its own contents. Returns whether it moved.
function reparentOnly(childId: string, newParentId: string | null): boolean {
  if (state.readOnly) return false;
  const child = state.nodes.get(childId);
  const newParent = newParentId ? state.nodes.get(newParentId) : null;
  if (!child || childId === newParentId || (newParentId && !newParent)) return false;
  if (isLockedEffective(child) || (newParent && isLockedEffective(newParent))) return false;
  if (newParent && isAncestor(childId, newParent.id)) return false;   // would create a cycle
  touch(childId, child.parent, newParentId);
  child.parent = newParentId;
  // The parent is the note's FOLDER, so a reparent moves the file (the save works out where); the offset is the board's.
  child.dirty = true; child.dirtyLayout = true;
  return true;
}
