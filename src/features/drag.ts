// ---------- node dragging ----------
// Drag moves the whole subtree (or the multi-selection, as one group); Shift clones while dragging; edge
// auto-pan keeps the dragged cards glued under the cursor while the view scrolls. Where a release lands is
// features/drop.ts; which gesture a press starts is features/node-press.ts. All transient drag state lives in
// `ui.drag`; `installDragModifiers` registers the global Alt/Shift listeners.
import { state, stage, setStatus, type MindNode } from '../core/state.js';
import { nodeLabel, isLockedEffective, parentOf, subtreeIds, withKids } from '../utils/model.js';
import { detachParentId } from '../nav/scope.js';
import { isSection, sectionAt } from '../view/layout.js';
import { cancelViewAnim, applyView } from '../view/camera.js';
import { ui, type Pt, type Drag } from '../core/ui-state.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { gridDelta, edgePanVelocity } from '../utils/drag-geometry.js';
import { centreOf } from '../utils/rect.js';
import { paintAll, paintNode, relayout, remeasure } from '../render.js';
import { editOnClick } from './activate.js';
import { leaveClone, mergeCardsInto } from './crud.js';
import { touch, commitStep } from './history.js';
import { guidePull, hideGuides } from './guides.js';
import { trackPointer } from '../utils/dom.js';
import { nodeRect, gridSnap } from '../view/geometry.js';
import { selectNode, setSelectionSet, toggleSel } from './selection.js';
import { scheduleSave } from '../data/save.js';
import { pileInto, reorderPile, settleStacks } from './stacks.js';
import { syncSelFrame } from './sel-frame.js';
import { dropSection, updateDropTarget, clearDropTarget, fileAway, reparentOnly, settleSections } from './drop.js';

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
// multi-selection keeps its internal spacing exactly and moves as one piece. A card inside a section
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
  if (!s) {
    return { x: dx, y: dy };
  }
  const fp = parentOf(act);
  const inBox = !!(fp && isSection(fp));
  const grid = gridDelta(s, { x: dx, y: dy }, inBox ? fp! : { x: 0, y: 0 }, gridSnap());
  // Smart guides (features/guides.ts) win over the grid on an axis where something lines up with the
  // RAW pointer position — read before the grid rounds it, or a 20px step would jump right past a
  // 6px pull. Off while ⌥ is held, over a pile or within an open fan: the card is going INTO another
  // card's note, onto the pile, or to a place in the pile, then.
  if (drag.alt || drag.cardMerge || drag.pile || drag.fanSlot != null) { hideGuides(); return grid; }
  const roots: Array<{ n: MindNode; s: Pt }> = [];
  for (const [id, st] of drag.targets) {
    const m = state.nodes.get(id);
    if (m && !(m.parent && drag.targets.has(m.parent))) {
      roots.push({ n: m, s: st });
    }
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
    const m = state.nodes.get(id);
    if (!m) {
      continue;
    }
    m.x = s.x + dx; m.y = s.y + dy;
    if (m.el) {
      const orig = drag.origins.get(id);
      if (orig) {
        // A node hosted inside a section that's ALSO part of this drag is already carried visually
        // by that section's sectionContentEl transform below (its left/top sit inside that container,
        // which itself is about to move) — giving it its own transform too would add the same
        // shift twice. Only "roots" of the dragged subtree(s) — no host, or a host that isn't
        // moving in this same gesture — need an explicit transform of their own.
        const carried = m.hostSectionId != null && drag.targets.has(m.hostSectionId);
        const t = carried ? '' : `translate(${m.x-orig.x}px,${m.y-orig.y}px)`;
        m.el.style.transform = t;
        // An expanded section's overflow:hidden content wrapper (sectionContentEl) is a second,
        // separately-positioned element (left/top only re-synced by a full paintNode) — mirror
        // the same compositor transform onto it (only when this section itself is a root — a
        // carried section's wrapper is already moving with its own host's transform) so the clip
        // window slides with the section instead of staying stranded at its pre-drag position.
        if (m.sectionContentEl) {
          m.sectionContentEl.style.transform = t;
        }
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
  if (!drag) {
    return;
  }
  if (drag.moved) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  paintFreeEdges();   // n.x/y is current, so edges track the dragged nodes correctly
  syncSelFrame();     // …and so does the frame round a multi-selection
  if (drag.moved && !ui.autoPanRAF) {
    ui.autoPanRAF = requestAnimationFrame(autoPanStep);
  }
}

// The edge band (px) where auto-pan ramps in, and its top speed (px per frame).
const PAN_BAND = 56, PAN_MAX = 16;

function stopAutoPan(): void { if (ui.autoPanRAF){ cancelAnimationFrame(ui.autoPanRAF); ui.autoPanRAF = null; } }

function autoPanStep(): void {
  ui.autoPanRAF = null;
  const drag = ui.drag;
  if (!drag || !drag.moved) {
    return;
  }
  // Available canvas = the stage. Panning kicks in as the cursor nears its edge, so you can drag a card
  // to somewhere that isn't on screen yet.
  const r = stage.getBoundingClientRect();
  let vx = 0, vy = 0;
  // Pan only while the pointer is still INSIDE the browser window: once it crosses out
  // (e.g. a drag heading for another app), scrolling on would carry the map away under it. Nor while it
  // rests on a path crumb in the corner: that is a drop target, not a push against the edge.
  if (!outsideWindow(drag.cx, drag.cy) && !document.querySelector('#homeBar .drop-target')){
    ({ x: vx, y: vy } = edgePanVelocity({ x: drag.cx, y: drag.cy }, r, PAN_BAND, PAN_MAX));
  }
  if (vx || vy){
    cancelViewAnim();
    state.view.x += vx; state.view.y += vy; applyView();
    // shift the dragged subtree's anchors opposite the pan so the cursor-to-card offset never
    // changes (only `targets` — `start` keeps its own positions for clone/reset).
    const wdx = -vx / state.view.k, wdy = -vy / state.view.k;
    for (const s of drag.targets.values()){ s.x += wdx; s.y += wdy; }
    applyDragTransform(drag, (drag.cx - drag.sx) / state.view.k, (drag.cy - drag.sy) / state.view.k);
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    paintFreeEdges();   // redraw edges every auto-pan section so they follow the moving nodes
  }
  ui.autoPanRAF = requestAnimationFrame(autoPanStep);
}

// Press-and-hold the whole multi-selection from the frame's empty interior (features/sel-frame.ts): the
// same gesture as pressing one of its cards, anchored on the primary (else any) unlocked member — that
// card is what the grid snaps and the drop rule follows, exactly as if it had been pressed.
export function startSelectionDrag(e: PointerEvent): void {
  const ids = [state.selId, ...state.sel].filter((id): id is string => !!id && state.sel.has(id));
  const n = ids.map(id => state.nodes.get(id)).find(m => m && !isLockedEffective(m));
  if (!n || state.sel.size < 2) {
    return;
  }
  e.stopPropagation();
  beginDrag(n, e, true);
}

// Open a drag gesture on `n` from a press. Dragging a card that's part of a multi-selection moves the
// WHOLE selection at once; otherwise just this card's subtree. `active` is the node dragged/dropped;
// `targets` are the nodes that follow the cursor (or, after a Shift-clone, just the clone).
export function beginDrag(n: MindNode, e: PointerEvent, fromFrame = false): void {
  const multi = state.sel.has(n.id) && state.sel.size > 1;
  // A locked member of a multi-selection stays put — only its unlocked companions get dragged
  // (pressing directly ON a locked card is handled separately in dragPointerMove, which pins the
  // whole gesture since `n` itself owns it).
  const rootIds = (multi ? [...state.sel] : [n.id])
    .filter(id => id === n.id || !isLockedEffective(state.nodes.get(id)!));
  const selRoots = trueRoots(rootIds);
  const ids = withKids(() => [...new Set(rootIds.flatMap(id => subtreeIds(id)))]);
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
           meta: e.metaKey || e.ctrlKey || e.shiftKey,   // ⇧- or ⌘/Ctrl-click toggles this card in the selection
           touch: e.pointerType === 'touch',  // higher move threshold for finger taps
           cardMerge: null, fromFrame,
           reclick: !fromFrame && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
             && state.selId === n.id && state.sel.size === 1 };
  for (const id of ids) { const m2 = state.nodes.get(id); if (m2?.el){ m2.el.style.willChange = 'transform'; m2.el.classList.add('dragging'); } }
  // Continue/commit this drag on `window`, not `el` — pointer capture (above) is still requested
  // best-effort so the dragged card's own hover/other handlers stay quiet, but capture can be
  // lost across a mid-drag re-render (paintAll runs while dragging). A lost capture hands pointerup to whatever's actually under the cursor instead —
  // e.g. the section it's dropped in — whose own pointerdown-scoped listener has nothing to do with
  // THIS gesture, so the event used to vanish, leaving the (Shift-cloned or moved) card invisible. `pointercancel` (tab switch, interrupted
  // touch) commits in place too, for the same reliability reason. Listeners are added/removed per
  // gesture (not left permanently on window) so they can't double-fire alongside the ghost-card
  // flow's own window listeners (features/ghost-card.ts), which drives its drag through the same dragPointerMove
  // /dragPointerUp via feedDragMove/commitDrag.
  const stop = trackPointer({ move: onMove, up: onUp, cancel: onUp });
  // Guard on `ui.drag.n === n` (not just truthiness): there's a single shared `ui.drag` slot, so
  // if a second card's pointerdown ever hijacks it before this gesture's up/cancel arrives (e.g.
  // true two-finger touch on two different cards at once), this stale pair must still remove
  // itself without touching the OTHER drag that's now live.
  function onMove(ev: PointerEvent): void {
    if (ui.drag && ui.drag.n === n) {
      dragPointerMove(ev);
    }
  }
  function onUp(): void {
    stop();
    if (ui.drag && ui.drag.n === n) {
      dragPointerUp();
    }
  }
}

// Body of a drag pointermove, operating on the live ui.drag (the node that owns the gesture is
// whatever drag.n is). Shared by the per-card handler and the ghost-card "drag a new note" flow.
function dragPointerMove(e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): void {
  const drag = ui.drag;
  if (!drag) {
    return;
  }
  // Pressing directly on a locked card: never treat it as a drag (click/double-click select/rename
  // still resolve normally on release since drag.moved stays false) — no move, no reparent.
  if (isLockedEffective(drag.n)) {
    return;
  }
  drag.alt = e.altKey; drag.shift = e.shiftKey;   // Shift = clone (live — release to cancel), Alt = detach
  drag.cx = e.clientX; drag.cy = e.clientY;   // remembered for edge auto-pan and RAF flush
  const dx = (e.clientX - drag.sx)/state.view.k, dy = (e.clientY - drag.sy)/state.view.k;
  const wasMoved = drag.moved;
  if (Math.abs(dx)+Math.abs(dy) > (drag.touch ? 8 : 2)){ drag.moved = true; document.body.classList.add('grabbing'); }
  // The instant a drag begins, repaint the dragged cards so any section child lifts OUT of its
  // section's overflow:hidden wrapper into #world (see paintNode) — otherwise it stays clipped to
  // the section bounds until the next drop-target change, masking it while it's dragged out.
  if (drag.moved && !wasMoved) {
    for (const id of drag.targets.keys()) {
      const m = state.nodes.get(id);
      if (m) {
        paintNode(m);
      }
    }
  }
  // Below the threshold this gesture is still a CLICK, and a click never moves anything. It used to
  // fall through to applyDragTransform anyway, which snaps (snappedDelta) — so one pixel of jitter
  // while selecting a card was enough to land it on the next grid position and leave it there, since
  // the pointerup below only selects when `!drag.moved` and restores no position. Selecting is not a
  // placement: nothing may write x/y until the pointer has actually gone somewhere.
  if (!drag.moved) {
    return;
  }
  applyDragClone();   // Shift held -> leave a clone & drag the copy; Shift released -> undo it
  // Update world-space positions immediately (cheap) — visual render is deferred to rAF so that
  // multiple pointermove events arriving within one display section collapse into a single paint.
  // (applyDragClone may have swapped drag.targets/origins for the clones — re-read via ui.drag.)
  applyDragTransform(ui.drag!, dx, dy);
  if (!ui.dragRAF) {
    ui.dragRAF = requestAnimationFrame(flushDragPaint);
  }
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
        if (m2?.el){ m2.el.style.transform = ''; m2.el.style.willChange = ''; m2.el.classList.remove('dragging', 'grabbed'); }
        if (m2?.sectionContentEl) {
          m2.sectionContentEl.style.transform = '';
        }
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
        // (A click inside the frame, between cards, leaves the selection standing.)
        if (drag.meta) {
          toggleSel(n.id);                 // ⇧- or ⌘/Ctrl-click: add/remove from selection
        } else if (!drag.fromFrame && (state.selId !== n.id || state.sel.size !== 1)) {
          selectNode(n.id);   // reduce a multi-selection to this card
        }
      } else {
        // ⌥ over a card merges into it; otherwise the drop rule (dropSection — the same test the preview ran).
        const { cloned, targets, clones, selRoots, cardMerge, chute, pile, fanSlot: slot } = drag;
        const group = selRoots.length > 1 ? dropSection(drag, act) : undefined;
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
            remeasure();
            selectNode(fuseNode.id);
            scheduleSave(); commitStep();
            return;
          }
        }
        if (chute) {
          fileAway(selRoots, chute);
          return;
        }

        // Within the open fan: the card takes another place in its pile (features/stacks.ts).
        if (slot != null && reorderPile(selRoots[0], slot)) {
          relayout();
          scheduleSave(); commitStep();
          return;
        }

        // Onto a stack, or held over a card until it lifted: the cards go on that pile.
        const onto = pile ? pileInto(pile.id, pile.make, selRoots) : null;
        if (onto) {
          remeasure();
          selectNode(onto.id);
          scheduleSave(); commitStep();
          return;
        }
        // THE drop rule: a group goes together, into the section under the pointer; a lone root by its
        // own centre. Positions stay exactly where they were dropped — snappedDelta already put them on
        // the grid (or on a guide) on every move, so a release changes nothing about WHERE.
        const moving = new Set(targets.keys());
        for (const rootId of selRoots){
          const r = state.nodes.get(rootId);
          if (!r) {
            continue;
          }
          const c = centreOf(nodeRect(r));
          const f = group !== undefined ? group : sectionAt(c.x, c.y, moving);
          const np = f?.id ?? detachParentId();
          if (np !== r.parent) {
            reparentOnly(rootId, np);
          }
        }
        settleStacks();   // a card dragged off a pile of two leaves the other lying where the pile was
        // Paint first so freshly-created clone cards have real DOM heights. A dropped SECTION collects
        // whatever it now covers (settleSections); no section is resized to fit a drop.
        remeasure();
        if (settleSections(selRoots.filter(id => state.nodes.get(id)?.type === 'section')).length) {
          relayout();
        }
        // select the new clone(s) you just dragged out
        if (cloned){
          if (clones && clones.length > 1) {
            setSelectionSet(clones.map(c => c.id));
          } else {
            selectNode(act.id);
          }
        }
        scheduleSave();
        commitStep();   // the whole gesture (move/reparent/clone) = ONE undo step
        return;   // drag/grabbing already cleared above
      }
    }
    ui.drag = null;
    document.body.classList.remove('grabbing');
    commitStep();   // plain click / unmoved drag: nothing changed → step is discarded
    // A plain click on the card that was ALREADY the selection writes on it (features/activate.ts editOnClick) —
    // after the commit, since the editor opens a step of its own that the click's would swallow.
    if (drag && !drag.moved && drag.reclick) {
      editOnClick(drag.n, drag.cx, drag.cy, drag.touch);
    }
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
  if (n.el){ n.el.style.willChange = 'transform'; n.el.classList.add('dragging', 'grabbed'); }
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
  if (!drag) {
    return;
  }
  clearDropTarget();
  hideGuides();
  for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
    const m = state.nodes.get(id);
    if (m?.el){ m.el.style.transform = ''; m.el.style.willChange = ''; m.el.classList.remove('dragging', 'grabbed'); }
    if (m?.sectionContentEl) {
      m.sectionContentEl.style.transform = '';
    }
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
  if (!drag) {
    return;
  }
  for (const clone of (drag.cloned && drag.clones) || []){
    state.nodes.delete(clone.id); clone.el?.remove();
  }
  for (const [id, s] of drag.start){
    const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; }
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
  if (!drag || !drag.moved) {
    return;
  }
  // A single note has nowhere to put a copy (core/state.ts singleNoteRefuses): Shift drags it like any move.
  if (drag.shift && !drag.cloned && !state.singleNote){
    drag.cloned = true;
    for (const [id, s] of drag.start){             // pin the original subtree(s) back to start
      const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; }
      // revert their compositor transforms — `drag.active` is about to switch to the clone
      if (m?.el) { m.el.style.transform = ''; }
      if (m?.sectionContentEl) { m.sectionContentEl.style.transform = ''; }
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
      if (clone.sectionContentEl){ clone.sectionContentEl.style.transform = ''; }
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
  if (!drag) {
    return;
  }
  applyDragTransform(drag, (drag.cx - drag.sx)/state.view.k, (drag.cy - drag.sy)/state.view.k);
  if (drag.moved) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  paintFreeEdges();   // modifier changed mid-drag — always repaint (infrequent)
}

// Update the detach preview the instant Alt is pressed/released mid-drag, even if the pointer
// isn't moving: repaint the dragged subtree (its colour previews the detached result) and re-resolve
// the drop target — ⌥ doesn't only mean "detach", it's also what turns a drop onto a card into a
// MERGE (and an image drop into a fold), so the target's dashed outline has to appear the moment the
// key goes down rather than on the next mouse jiggle. dragFollow repaints the edges as well.
function paintDetachPreview(): void {
  if (ui.drag) {
    for (const id of subtreeIds(ui.drag.active.id)){
      const m = state.nodes.get(id);
      if (m) {
        paintNode(m);
      }
    }
  }
  dragFollow();
}

export function installDragModifiers(): void {
  window.addEventListener('keydown', (e) => {
    const drag = ui.drag;
    if (!drag) {
      return;
    }
    if (e.key === 'Alt'){ drag.alt = true;  paintDetachPreview(); }
    if (e.key === 'Shift'){ drag.shift = true;  applyDragClone(); dragFollow(); }
  });
  window.addEventListener('keyup',   (e) => {
    const drag = ui.drag;
    if (!drag) {
      return;
    }
    if (e.key === 'Alt'){ drag.alt = false; paintDetachPreview(); }
    if (e.key === 'Shift'){ drag.shift = false; applyDragClone(); dragFollow(); }
  });
}
