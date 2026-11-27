// Where a drop lands, the live preview of what a release would do, and a section collecting what it covers.
import { state, setStatus, type MindNode } from '../core/state.js';
import { nodeLabel, isHidden, isAncestor, isLockedEffective, childrenOf, subtreeIds, takesDrop } from '../utils/model.js';
import { detachParentId, scope } from '../nav/scope.js';
import { collectsCards, sectionAt, containerBox, centreInSection, moveSubtreeTo } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { ui, type Drag, type Chute } from '../core/ui-state.js';
import { paintNode, relayout, remeasure, flashArrived } from '../render.js';
import { canMerge } from './crud.js';
import { touch, commitStep } from './history.js';
import { nodeW, nodeH, nodeRect } from '../view/geometry.js';
import { centreOf, contains, encloses } from '../utils/rect.js';
import { setSelectionSet } from './selection.js';
import { afterReading } from '../data/lazy.js';
import { arrangeSections } from '../data/arrange.js';
import { SPACING } from '../utils/guides.js';
import { scheduleSave } from '../data/save.js';
import type { FanInsert } from '../view/pile.js';
import { pileTarget, fanSlot, showFanInsert, PILE_HOVER_MS } from './stacks.js';

// A multi-selection goes by the POINTER, one card by its centre. Null: the top level.
export function dropSection(drag: NonNullable<typeof ui.drag>, dragged: MindNode): MindNode | null {
  const p = drag.selRoots.length > 1 ? screenToWorld(drag.cx, drag.cy) : centreOf(nodeRect(dragged));
  return sectionAt(p.x, p.y, new Set(drag.targets.keys()));
}

// `drag.dropTarget` is the would-be parent, so an inheriting card previews the colour it's about to take.
export function updateDropTarget(dragged: MindNode, e: { clientX: number; clientY: number }): void {
  const drag = ui.drag;
  if (!drag) {
    return;
  }
  const sub = new Set(drag.targets.keys());
  clearDropTarget();
  let fuse: string | null = null;
  const mergeDrag = drag.alt && drag.selRoots.length > 0
    && drag.selRoots.every(id => { const m = state.nodes.get(id); return !!m && canMerge(m); });
  if (mergeDrag) {
    const p = { x: (e.clientX - state.view.x) / state.view.k, y: (e.clientY - state.view.y) / state.view.k };
    for (const [id, m] of state.nodes) {
      if (sub.has(id) || isHidden(m) || m.type !== 'card') {
        continue;
      }
      if (contains(nodeRect(m), p)) {
        if (takesDrop(m)) {
          fuse = id;
        }
        break;
      }
    }
  }

  // The FIRST that applies wins.
  let insert: FanInsert | null = null, pile: Drag['pile'] = null, chute: ReturnType<typeof chuteAt> = null;
  let f: MindNode | null = null, target: string | null;
  if (fuse) {
    target = dragged.parent;
  } else if ((insert = fanSlot(drag, e.clientX, e.clientY))) {
    target = dragged.parent;
  } else if ((pile = pileTarget(drag, e.clientX, e.clientY, sub))) {
    target = pile.make ? state.nodes.get(pile.id)!.parent : pile.id;
  } else if ((chute = chuteAt(e.clientX, e.clientY, sub))) {
    target = chute.parent;
  } else {
    f = dropSection(drag, dragged);
    target = f?.id ?? detachParentId();
  }
  const changed = drag.dropTarget !== target;
  drag.dropTarget = target; drag.cardMerge = fuse; drag.chute = chute; drag.pile = pile; drag.fanSlot = insert?.slot ?? null;
  armPileHover(drag);
  if (changed) {
    for (const id of sub) {
      const m = state.nodes.get(id);
      if (m) {
        paintNode(m);
      }
    }
  }
  if (fuse) {
    markDrop(state.nodes.get(fuse)!.el, 'drop-merge');
  } else if (insert) {
    showFanInsert(insert);
  } else if (pile) {
    markDrop(state.nodes.get(pile.id)!.el, 'drop-pile');
  } else if (chute) {
    markDrop(chute.el, 'drop-target');
  } else if (f && f.id !== dragged.parent) {
    markDrop(f.el, 'drop-target');
  }
}

// Remembered so clearing it, every frame of a drag, is not a search of the whole document.
let dropMark: Element | null = null;

function markDrop(el: Element | null | undefined, cls: string): void {
  if (el) {
    el.classList.add(cls);
    dropMark = el;
  }
}

export function clearDropTarget(): void {
  dropMark?.classList.remove('drop-target', 'drop-merge', 'drop-pile');
  dropMark = null;
  showFanInsert(null);
}

// Re-ask once PILE_HOVER_MS is up, so the target lifts while the card is held still.
let pileTimer = 0;

function armPileHover(drag: Drag): void {
  window.clearTimeout(pileTimer);
  if (!drag.pileHover || drag.pile) {
    return;
  }
  const wait = PILE_HOVER_MS - (performance.now() - drag.pileHover.since);
  pileTimer = window.setTimeout(() => {
    if (ui.drag === drag && drag.moved) {
      updateDropTarget(drag.active, { clientX: drag.cx, clientY: drag.cy });
    }
  }, Math.max(0, wait) + 10);
}

// A path crumb (out to that level) or a folded section's pill (into it), by the POINTER: small targets.
function chuteAt(cx: number, cy: number, sub: Set<string>): (Chute & { el: HTMLElement }) | null {
  const over = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  };

  // The current crumb is where the cards already are; `…` has no single level.
  for (const el of document.querySelectorAll<HTMLElement>('#homeBar .sc-crumb[data-depth]:not(.sc-cur)')) {
    if (over(el)) {
      const d = Number(el.dataset.depth);
      const parent = d ? scope.stack[d - 1]?.rootId ?? null : null;
      const p = parent ? state.nodes.get(parent) : null;
      return p && isLockedEffective(p) ? null : { parent, beside: scope.stack[d]?.rootId, el };
    }
  }
  for (const m of state.nodes.values()) {
    if (m.type === 'section' && m.collapsed && m.el && !sub.has(m.id) && !isHidden(m) && !isLockedEffective(m) && over(m.el)) {
      return { parent: m.id, el: m.el };
    }
  }
  return null;
}

// The cards leave the canvas you're looking at, so the toast says where they went.
export function fileAway(roots: string[], chute: Chute): void {
  const p = chute.parent ? state.nodes.get(chute.parent) ?? null : null;
  const go = (): void => {
    const ids = roots.filter(id => {
      const r = state.nodes.get(id);
      return !!r && (r.parent === chute.parent || reparentOnly(id, chute.parent));
    });
    if (!ids.length) {
      remeasure(); commitStep();
      return;
    }
    const beside = chute.beside ? state.nodes.get(chute.beside) : null;
    if (p?.collapsed) {
      touch(p.id, ...ids.flatMap(id => subtreeIds(id)));
      arrangeSections([p], new Set(ids));
    } else if (beside) {
      // A column right of the section they came out of; it may overlap what's there.
      let y = beside.y;
      for (const id of ids) {
        const r = state.nodes.get(id)!;
        moveSubtreeTo(r, beside.x + nodeW(beside) + SPACING, y);
        y += nodeH(r) + SPACING;
      }
    }
    setSelectionSet([]);
    setStatus(`Moved ${ids.length > 1 ? `${ids.length} cards` : `“${nodeLabel(state.nodes.get(ids[0])!)}”`} to “${p ? nodeLabel(p) : 'the top level'}”`);
    relayout();
    flashArrived(ids);
    scheduleSave(); commitStep();
  };
  if (!(p && afterReading([p.id], go, false))) {
    go();
  }
}

// See "A section COLLECTS what it covers" in docs/architecture.md. Returns the ids it reparented.
export function settleSections(sectionIds: Iterable<string>): string[] {
  const moved: string[] = [];
  for (const id of sectionIds) {
    const f = state.nodes.get(id);
    if (!f || !collectsCards(f)) {
      continue;
    }
    const b = containerBox(f);
    for (const k of childrenOf(f.id)) {
      if (isHidden(k) || isLockedEffective(k) || centreInSection(k, f)) {
        continue;
      }
      const c = centreOf(nodeRect(k));
      const to = sectionAt(c.x, c.y, new Set(subtreeIds(k.id)));
      if (reparentOnly(k.id, to?.id ?? detachParentId())) {
        moved.push(k.id);
      }
    }
    for (const n of state.nodes.values()) {
      if (n === f || n.parent === f.id || isHidden(n) || isLockedEffective(n)) {
        continue;
      }
      if (isAncestor(n.id, f.id) || isAncestor(f.id, n.id)) {
        continue;
      }

      // A section only whole: by its centre, a big one could be swallowed by a small one laid across it.
      if (n.type === 'section' ? !encloses(b, nodeRect(n)) : !centreInSection(n, f)) {
        continue;
      }
      const c = centreOf(nodeRect(n));
      if (sectionAt(c.x, c.y, new Set(subtreeIds(n.id))) !== f) {
        continue;
      }
      if (reparentOnly(n.id, f.id)) {
        moved.push(n.id);
      }
    }
  }
  return moved;
}

// The parent only, no paint: the caller settles the canvas once for the whole group.
export function reparentOnly(childId: string, newParentId: string | null): boolean {
  const child = state.nodes.get(childId);
  const newParent = newParentId ? state.nodes.get(newParentId) : null;
  if (!child || childId === newParentId || (newParentId && !newParent)) {
    return false;
  }
  if (isLockedEffective(child) || (newParent && isLockedEffective(newParent))) {
    return false;
  }
  if (newParent && isAncestor(childId, newParent.id)) {
    return false;
  }
  touch(childId, child.parent, newParentId);
  child.parent = newParentId;
  // The parent is the note's FOLDER, so the save moves the file.
  child.dirty = true;
  return true;
}

