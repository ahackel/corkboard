// Dragging cards: the subtree or the whole multi-selection, Shift to clone, edge auto-pan. Where a release
// lands is drop.ts; which gesture a press starts is node-press.ts.
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

// A member whose parent is also in the set rides along with it, so only these get re-parented on drop.
function trueRoots(ids: string[]): string[] {
  const idSet = new Set(ids);
  return ids.filter(id => { const p = state.nodes.get(id)?.parent; return !p || !idSet.has(p); });
}

const outsideWindow = (x: number, y: number): boolean =>
  x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

// The ANCHOR card lands on the grid (relative to its section's corner) and every card in the drag
// takes the same correction, so a group keeps its spacing. See "The grid QUANTISES" in docs/architecture.md.
function snappedDelta(drag: Drag, dx: number, dy: number): Pt {
  // `active`, not `n`: a Shift-drag re-keys `drag.targets` to the clones.
  const act = drag.active;
  const s = drag.targets.get(act.id);
  if (!s) {
    return { x: dx, y: dy };
  }
  const fp = parentOf(act);
  const inBox = !!(fp && isSection(fp));
  const grid = gridDelta(s, { x: dx, y: dy }, inBox ? fp! : { x: 0, y: 0 }, gridSnap());
  // Guides win over the grid, read off the RAW delta, or a grid step would jump past a guide's pull.
  // Off while the card is going into a note, onto a pile or to a place in one.
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

// A compositor-only transform: left/top stay frozen at the card's origin until the drop.
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
        // Inside a section that is also dragged, its wrapper's transform already carries it.
        const carried = m.hostSectionId != null && drag.targets.has(m.hostSectionId);
        const t = carried ? '' : `translate(${m.x-orig.x}px,${m.y-orig.y}px)`;
        m.el.style.transform = t;
        // The section's clipping wrapper is a separate element, and must slide with it.
        if (m.sectionContentEl) {
          m.sectionContentEl.style.transform = t;
        }
      }
    }
  }
}

function flushDragPaint(): void {
  ui.dragRAF = null;
  const drag = ui.drag;
  if (!drag) {
    return;
  }
  if (drag.moved) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  paintFreeEdges();
  syncSelFrame();
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
  const r = stage.getBoundingClientRect();
  let vx = 0, vy = 0;
  // Not once the pointer has left the window (for another app), nor over a path crumb, a drop target.
  if (!outsideWindow(drag.cx, drag.cy) && !document.querySelector('#homeBar .drop-target')){
    ({ x: vx, y: vy } = edgePanVelocity({ x: drag.cx, y: drag.cy }, r, PAN_BAND, PAN_MAX));
  }
  if (vx || vy){
    cancelViewAnim();
    state.view.x += vx; state.view.y += vy; applyView();
    // Keeps the cards glued under the cursor; `start` stays put for clone/reset.
    const wdx = -vx / state.view.k, wdy = -vy / state.view.k;
    for (const s of drag.targets.values()){ s.x += wdx; s.y += wdy; }
    applyDragTransform(drag, (drag.cx - drag.sx) / state.view.k, (drag.cy - drag.sy) / state.view.k);
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    paintFreeEdges();
  }
  ui.autoPanRAF = requestAnimationFrame(autoPanStep);
}

// A press in the selection frame's empty interior, anchored on the primary (else any) unlocked member.
export function startSelectionDrag(e: PointerEvent): void {
  const ids = [state.selId, ...state.sel].filter((id): id is string => !!id && state.sel.has(id));
  const n = ids.map(id => state.nodes.get(id)).find(m => m && !isLockedEffective(m));
  if (!n || state.sel.size < 2) {
    return;
  }
  e.stopPropagation();
  beginDrag(n, e, true);
}

export function beginDrag(n: MindNode, e: PointerEvent, fromFrame = false): void {
  const multi = state.sel.has(n.id) && state.sel.size > 1;

  // A locked member of a multi-selection stays put; a press ON a locked card is dragPointerMove's.
  const rootIds = (multi ? [...state.sel] : [n.id])
    .filter(id => id === n.id || !isLockedEffective(state.nodes.get(id)!));
  const selRoots = trueRoots(rootIds);
  const ids = withKids(() => [...new Set(rootIds.flatMap(id => subtreeIds(id)))]);
  const start = new Map(ids.map(id => {
    const m = state.nodes.get(id)!; return [id, { x:m.x, y:m.y }] as [string, Pt];
  }));
  // Its OWN {x,y} objects: auto-pan shifts these and must not move `start`'s.
  const targets = new Map([...start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
  touch(...ids);

  // The left/top frozen at drag start, which transforms are relative to.
  const origins = new Map(ids.map(id => { const m2 = state.nodes.get(id)!; return [id, { x:m2.x, y:m2.y }] as [string, Pt]; }));
  ui.drag = { n, active:n, multi, sx:e.clientX, sy:e.clientY, cx:e.clientX, cy:e.clientY, start, targets, origins, selRoots,
           moved:false, dropTarget:n.parent, alt:e.altKey, shift:e.shiftKey, cloned:false,
           meta: e.metaKey || e.ctrlKey || e.shiftKey,
           touch: e.pointerType === 'touch',
           cardMerge: null, fromFrame,
           reclick: !fromFrame && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
             && state.selId === n.id && state.sel.size === 1 };
  for (const id of ids) { const m2 = state.nodes.get(id); if (m2?.el){ m2.el.style.willChange = 'transform'; m2.el.classList.add('dragging'); } }
  // On `window`, not the card: a mid-drag repaint can lose pointer capture, and the pointerup with it.
  // Per gesture, so they can't double-fire beside the ghost card's own listeners.
  const stop = trackPointer({ move: onMove, up: onUp, cancel: onUp });
  // `ui.drag.n === n`: a second finger on another card may have taken the one shared drag slot.
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

// Mouse and touch need different jitter allowances before a press becomes a drag.
const MOUSE_SLOP = 2, TOUCH_SLOP = 8;

// Shared by the per-card handler and the ghost-card flow.
function dragPointerMove(e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): void {
  const drag = ui.drag;
  if (!drag) {
    return;
  }
  // A locked card never moves; its click still resolves on release.
  if (isLockedEffective(drag.n)) {
    return;
  }
  drag.alt = e.altKey; drag.shift = e.shiftKey;
  drag.cx = e.clientX; drag.cy = e.clientY;
  const dx = (e.clientX - drag.sx)/state.view.k, dy = (e.clientY - drag.sy)/state.view.k;
  const wasMoved = drag.moved;
  if (Math.abs(dx)+Math.abs(dy) > (drag.touch ? TOUCH_SLOP : MOUSE_SLOP)){ drag.moved = true; document.body.classList.add('grabbing'); }
  // Repaint at once, so a section's child lifts out of its clipping wrapper (paintNode).
  if (drag.moved && !wasMoved) {
    for (const id of drag.targets.keys()) {
      const m = state.nodes.get(id);
      if (m) {
        paintNode(m);
      }
    }
  }
  // Still a click: transforming would snap a card to the next grid position on a pixel of jitter.
  if (!drag.moved) {
    return;
  }
  applyDragClone();

  // Re-read ui.drag: applyDragClone may have swapped targets/origins for the clones.
  applyDragTransform(ui.drag!, dx, dy);
  if (!ui.dragRAF) {
    ui.dragRAF = requestAnimationFrame(flushDragPaint);
  }
}

// Shared by the per-card handler and the ghost-card flow.
function dragPointerUp(): void {
    stopAutoPan();
    hideGuides();
    if (ui.dragRAF){ cancelAnimationFrame(ui.dragRAF); ui.dragRAF = null; }
    const drag = ui.drag;
    if (drag) {
      const n = drag.n;
      for (const id of new Set([...drag.targets.keys(), ...drag.start.keys()])){
        const m2 = state.nodes.get(id);
        if (m2?.el){ m2.el.style.transform = ''; m2.el.style.willChange = ''; m2.el.classList.remove('dragging', 'grabbed'); }
        if (m2?.sectionContentEl) {
          m2.sectionContentEl.style.transform = '';
        }
      }
      const act = drag.active;
      // Committing would strand the card far off-canvas, so it snaps back.
      if (drag.moved && outsideWindow(drag.cx, drag.cy)){
        cancelDragRestore();
        setStatus('Drag cancelled — released outside the window');
        return;
      }
      if (!drag.moved) {
        // Before selecting, whose repaint would otherwise draw the card still `.dragging`.
        ui.drag = null;
        if (drag.meta) {
          toggleSel(n.id);
        } else if (!drag.fromFrame && (state.selId !== n.id || state.sel.size !== 1)) {
          selectNode(n.id);
        }
      } else {
        const { cloned, targets, clones, selRoots, cardMerge, chute, pile, fanSlot: slot } = drag;
        const group = selRoots.length > 1 ? dropSection(drag, act) : undefined;
        clearDropTarget();
        // So every paint in the commit sees no active drag.
        ui.drag = null;
        document.body.classList.remove('grabbing');
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

        if (slot != null && reorderPile(selRoots[0], slot)) {
          relayout();
          scheduleSave(); commitStep();
          return;
        }

        const onto = pile ? pileInto(pile.id, pile.make, selRoots) : null;
        if (onto) {
          remeasure();
          selectNode(onto.id);
          scheduleSave(); commitStep();
          return;
        }
        // A group lands together in the section under the pointer; a lone root goes by its own centre.
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
        settleStacks();

        // Paint first, so fresh clones have real heights.
        remeasure();
        if (settleSections(selRoots.filter(id => state.nodes.get(id)?.type === 'section')).length) {
          relayout();
        }
        if (cloned){
          if (clones && clones.length > 1) {
            setSelectionSet(clones.map(c => c.id));
          } else {
            selectNode(act.id);
          }
        }
        scheduleSave();
        commitStep();
        return;
      }
    }
    ui.drag = null;
    document.body.classList.remove('grabbing');
    commitStep();

    // After the commit: the editor opens a step of its own, which the click's would swallow.
    if (drag && !drag.moved && drag.reclick) {
      editOnClick(drag.n, drag.cx, drag.cy, drag.touch);
    }
}

// The ghost card's drag. `moved` starts true, so even a release without motion commits the placement.
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

export function feedDragMove(clientX: number, clientY: number): void {
  dragPointerMove({ clientX, clientY, altKey:false, shiftKey:false });
}

export function commitDrag(): void { dragPointerUp(); }

// No commit; the caller is responsible for the dragged node.
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

// OS-style snap-back: clones removed, cards back at their start, and the pending step nets out.
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
  relayout();
  commitStep();
}

// Shift held leaves a clone of each dragged root at its start and drags the COPIES; released, it undoes that.
function applyDragClone(): void {
  const drag = ui.drag;
  if (!drag || !drag.moved) {
    return;
  }
  if (drag.shift && !drag.cloned && !state.singleNote){
    drag.cloned = true;
    for (const [id, s] of drag.start){
      const m = state.nodes.get(id); if (m){ m.x = s.x; m.y = s.y; }
      if (m?.el) { m.el.style.transform = ''; }
      if (m?.sectionContentEl) { m.sectionContentEl.style.transform = ''; }
    }
    const rootIds = drag.selRoots;
    const clones = rootIds.map(id => leaveClone(state.nodes.get(id)!, drag!.start.get(id)!));
    drag.clones = clones;
    drag.active = clones[0];
    drag.selRoots = clones.map(c => c.id);
    drag.targets = new Map(rootIds.map((id, i) => { const sp = drag!.start.get(id)!; return [clones[i].id, { x:sp.x, y:sp.y }] as [string, Pt]; }));
    drag.origins = new Map([...drag.targets].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    paintAll();
  } else if (!drag.shift && drag.cloned){
    for (const clone of (drag.clones || [])){
      if (clone.el){ clone.el.style.transform = ''; clone.el.style.willChange = ''; }
      if (clone.sectionContentEl){ clone.sectionContentEl.style.transform = ''; }
      state.nodes.delete(clone.id); clone.el?.remove();
    }
    drag.clones = null;
    drag.cloned = false;
    drag.active = drag.n;
    drag.selRoots = trueRoots(drag.multi ? [...state.sel] : [drag.n.id]);
    drag.targets = new Map([...drag.start].map(([id, s]) => [id, { x:s.x, y:s.y }] as [string, Pt]));
    drag.origins = new Map([...drag.start]);
    setStatus(`Duplication cancelled — moving "${nodeLabel(drag.n)}"`);
    paintAll();
  }
}

// A modifier toggled mid-drag shows at once, without waiting for a pointer move.
function dragFollow(): void {
  const drag = ui.drag;
  if (!drag) {
    return;
  }
  applyDragTransform(drag, (drag.cx - drag.sx)/state.view.k, (drag.cy - drag.sy)/state.view.k);
  if (drag.moved) {
    updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
  }
  paintFreeEdges();
}

// ⌥ also turns a drop onto a card into a MERGE, so the target outline must show the moment it goes down.
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
