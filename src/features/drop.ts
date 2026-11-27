// ---------- where a drop LANDS, and what it does there ----------
// The drop rule (view/layout.ts sectionAt): one dragged card belongs to the section its centre is in, a
// multi-selection ALL to the section under the POINTER — or the top level. Also the live preview of what a
// release would do (merge, pile, file away through a crumb or pill), and a section collecting what it covers.
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

// The section a drop lands in: for a MULTI-selection the one under the pointer, so the whole group goes
// where you aim it; for one card the one its centre is in. Null = the top level (or the open section).
export function dropSection(drag: NonNullable<typeof ui.drag>, dragged: MindNode): MindNode | null {
  const p = drag.selRoots.length > 1 ? screenToWorld(drag.cx, drag.cy) : centreOf(nodeRect(dragged));
  return sectionAt(p.x, p.y, new Set(drag.targets.keys()));
}

// ---------- the drop preview ----------
// What a release right now would do, shown while it's still a choice: with ⌥ held over a plain card,
// a MERGE into it (a dashed outline on that card); otherwise the section the dragged card would land in
// lights up — only when that's a change, i.e. the card is about to go INTO a section it isn't in yet.
// `drag.dropTarget` records the resolved new parent (null = the top level) for effectiveColor, so an
// inheriting card previews the colour it's about to take.
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
    // the CARD under the pointer (what may take a merge: utils/model.ts takesDrop), first hit wins
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

  // What else a release right now would do — the FIRST of these that applies: a card of the open fan dragged
  // within it takes another place in the pile; over a stack, or held over a card long enough, the cards go
  // onto a pile (features/stacks.ts); over a crumb or a folded pill they're filed (chuteAt); else they land by the
  // drop rule (dropSection).
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

// The ONE element wearing a drop hint, remembered so that clearing it — which every frame of a drag
// does first — is not a search of the whole document.
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

// The pointer resting on a card ARMS a stack after PILE_HOVER_MS, whether or not the mouse moves again in
// the meantime: re-ask then, so the target lifts while the card is simply held there.
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

// What the POINTER is over that files a drop somewhere off the canvas: a crumb of the open-section path
// (out to that level, beside the section you came out of) or a folded section's pill (into it). The
// pointer decides rather than the card's centre: both are small targets you aim at.
function chuteAt(cx: number, cy: number, sub: Set<string>): (Chute & { el: HTMLElement }) | null {
  const over = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  };

  // the CURRENT crumb is where the cards already are; `…` has no single level
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

// File the dragged roots into a chute's section (or the top level). Into a folded section they join its
// cards in a column of their own beside them (arrange.ts arrangeSections, the inbox's rule) — reading its
// folder first if it was never read; out through a crumb they land in a column right of the section they
// came out of. Either way they leave the canvas you're looking at, so the toast says where they went.
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
      // shortcut: the column may overlap whatever already sits right of that section; ⌃⌥T tidies it.
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

// A section COLLECTS what it covers — the drop rule run from the section's side, FigJam-style. After a section
// is moved, resized or made, every card whose centre is now in it belongs to it (sectionAt: the
// innermost section wins, so a card sitting in a smaller section inside it stays there), and every card of
// its own whose centre is now OUTSIDE it goes to whatever it's over instead (a shrink lets go of what
// it no longer covers, rather than hiding it under the clip). A SECTION is collected only when its whole
// box is inside — by its centre alone, a big section could be swallowed by a small one laid across it.
// Locked and hidden things stay where they are. Returns the ids it reparented. It never resizes a section.
export function settleSections(sectionIds: Iterable<string>): string[] {
  const moved: string[] = [];
  for (const id of sectionIds) {
    const f = state.nodes.get(id);
    if (!f || !collectsCards(f)) {
      continue;
    }
    const b = containerBox(f);
    // let go of its own cards that left it…
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
    // …and take in what it now covers.
    for (const n of state.nodes.values()) {
      if (n === f || n.parent === f.id || isHidden(n) || isLockedEffective(n)) {
        continue;
      }
      if (isAncestor(n.id, f.id) || isAncestor(f.id, n.id)) {
        continue;   // its own sections, or inside it already
      }
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

// Move one card into a section, or out to the top level (null). Mutates the parent only — no paint or
// status; dragPointerUp settles the canvas once for the whole dragged group. Refuses a locked card or
// section, and a section into its own contents. Returns whether it moved.
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
    return false;   // would create a cycle
  }
  touch(childId, child.parent, newParentId);
  child.parent = newParentId;
  // The parent is the note's FOLDER, so a reparent moves the file (the save works out where); the offset is the board's.
  child.dirty = true;
  return true;
}

