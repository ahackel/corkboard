// ---------- resize: the handles on a selected card or section, and dragging them ----------
import { NODE_W, MIN_SECTION_H, imageLook, IMAGE_FOLD, IMAGE_W, IMAGE_H, isBoxNode, nodeW, nodeH, gridSnap } from '../view/geometry.js';
import { type MindNode, state } from '../core/state.js';
import { isLockedEffective, subtreeIds } from '../utils/model.js';
import { ui } from '../core/ui-state.js';
import { touch, commitStep } from './history.js';
import { snapTo } from '../utils/num.js';
import { guideResize, hideGuides } from './guides.js';
import { sidesOf, resizeProbe, resizeEdges, foldsToIcon } from '../utils/resize-geometry.js';
import { paintNode, relayout } from '../render.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { settleSections } from './drop.js';
import { syncFloatBar } from './float-bar.js';
import { syncSelFrame, memberEdgeResize } from './sel-frame.js';
import { trackPointer } from '../utils/dom.js';
import { scheduleSave } from '../data/save.js';

// An image card's floor is the ICON it becomes: drag either axis to IMAGE_FOLD and the card folds
// (startNodeResize below), so there is no smaller expanded size to clamp at.
// A width-only kind can only ever get WIDER than the width it has by default — the whole point is
// trading height for width on a card whose text wraps badly, so its natural size is the floor. That
// floor is NODE_W for a plain card and a section alike, so they share the one fall-through.
export function minWOf(n: MindNode): number {
  return imageLook(n) ? IMAGE_FOLD : NODE_W;
}
// The shortest a CLIPPED card goes: about one line of text under its padding.
export const CLIP_MIN_H = 44;

export function minHOf(n: MindNode): number {
  return imageLook(n) ? IMAGE_FOLD : MIN_SECTION_H;
}
// 8 resize handles: 4 edges (one axis) + 4 corners (two axes). A `w`/`n` component moves that edge,
// which shifts the section's x/y (the opposite edge stays put); `e`/`s` just grow width/height.
export const SECTION_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type SectionDir = typeof SECTION_DIRS[number];
// Ensure the node has exactly the resize hit-zones its kind wants — one per edge/corner, added once
// and reused. The corners of a lone selection draw FigJam's square handles (styles.css); the edges
// have no grip, their resize cursor is the affordance.
// `:scope >` throughout, NOT a descendant query: child cards are DOM-nested inside their parent
// (see place/settledHost), so a plain card containing a nested image card would otherwise see the
// CHILD's handles, conclude it already had its own, and never get any.
export function ensureResizeHandles(n: MindNode): void {
  const el = n.el!;
  if (el.dataset.fhDirs) {
    return;   // it has them: every kind takes the same eight
  }
  for (const dir of SECTION_DIRS) {
    const h = document.createElement('div');
    h.className = 'fh fh-' + dir;
    h.addEventListener('pointerdown', (e) => startNodeResize(e as PointerEvent, n, dir));
    el.appendChild(h);
  }
  el.dataset.fhDirs = '1';
}
export function clearResizeHandles(el: HTMLElement): void {
  if (!el.dataset.fhDirs) {
    return;   // no handles to remove — skip the query, this runs every repaint
  }
  el.querySelectorAll(':scope > .fh').forEach(x => x.remove());
  delete el.dataset.fhDirs;
}
// Drag an edge/corner to resize. Work in edge coordinates (left/top/right/bottom) so the edges NOT
// being dragged stay fixed; the dragged edges snap to the grid and clamp to the min size. Top/left
// edges moving means the section's x/y move too. Children inside are free, so only the parent's own
// layout reflows around the section — done once on release, not every move.
// An image card's aspect ratio (width/height): the actual loaded image if hydrateImages has
// resolved it, else whatever the box currently shows (so an in-progress resize is stable even
// before the blob URL loads).
export function imageAspect(n: MindNode): number {
  const img = n.el?.querySelector('img.md-img') as HTMLImageElement | null;
  if (img && img.naturalWidth && img.naturalHeight) {
    return img.naturalWidth / img.naturalHeight;
  }
  const w = n.w ?? IMAGE_W, h = n.h ?? IMAGE_H;
  return w / (h || 1);
}
// A card's text height at its current width: where its min-height stops and its clip starts.
// (A clipped card's body cap is lifted too, or it would measure as its own clip.)
export function naturalH(n: MindNode): number {
  const el = n.el!, body = el.querySelector(':scope > .body') as HTMLElement;
  const was = el.style.minHeight, wasMax = body.style.maxHeight;
  el.style.minHeight = ''; body.style.maxHeight = ''; const h = el.offsetHeight;
  el.style.minHeight = was; body.style.maxHeight = wasMax;
  return h;
}

// A PLAIN card's size after a resize lets go of whatever it no longer needs to author. Back at (or
// under) the natural width → no mm_w, rather than a redundant one on every card the user so much as
// nudges; no taller than its text → no authored height. Shorter than its text (at the width it ended
// at) → it clips; else its height is a minimum again.
export function settleCardSize(n: MindNode): void {
  if (n.w != null && Math.round(n.w) <= minWOf(n)) {
    n.w = undefined;
  }
  if (n.h == null) {
    return;
  }
  paintNode(n);
  const nat = naturalH(n);
  if (Math.round(n.h) < nat - 1) {
    n.clip = true;
  } else {
    n.clip = undefined;
    if (Math.round(n.h) <= nat + 1) {
      n.h = undefined;
    }
  }
}

function startNodeResize(e: PointerEvent, n: MindNode, dir: SectionDir): void {
  if (isLockedEffective(n)) {
    return;
  }

  // In a multi-selection, an edge that is also the selection frame's edge scales the whole group.
  if (memberEdgeResize(e, n, dir)) {
    return;
  }
  e.stopPropagation(); e.preventDefault();
  // Is this a BOX (its size is exactly what's dragged) or a card (its height is a minimum over what
  // its text measures)? A FOLDED image card counts as a box here even though isBoxNode says no: its
  // 40px icon is the small end of its own size range, and scaling it back up is how you unfold it.
  const img = imageLook(n);
  const sizeH = isBoxNode(n) || img;
  const minW = minWOf(n);
  // A card CAN be dragged shorter than its text (naturalH), down to a line: then it CLIPS (n.clip) instead of growing.
  const natural0 = sizeH ? 0 : naturalH(n);
  const minH = sizeH ? minHOf(n) : Math.min(natural0, CLIP_MIN_H);
  const aspect = img ? imageAspect(n) : null;   // width/height — locked while dragging an image card
  // Live geometry, not (n.w ?? boxDefaultW): boxDefaultH falls back to SECTION_H for anything that
  // isn't an image/query, so a plain card would start from a bogus 279px-tall box.
  const e0 = { left: n.x, top: n.y, right: n.x + nodeW(n), bottom: n.y + nodeH(n) };
  const sx = e.clientX, sy = e.clientY;
  ui.resizingId = n.id; n.el?.classList.add('resizing');   // its tags step aside while its edge moves (paintNode keeps it)
  const sides = sidesOf(dir);
  const { west, north, south } = sides;
  touch(n.id);
  let lastDx = 0, lastDy = 0;
  let subtreeRAF: number | null = null;
  const g = gridSnap();
  // The grid on the SIZE — the same snap a dragged card gets (utils/num.ts), live
  // on every move, so the box steps between grid sizes under the pointer instead of taking one up at
  // the end. One snapping rule for everything the pointer moves.
  const snap = (v: number): number => snapTo(v, g);
  // The SIZE snaps (not the edges), so a box's w/h stay grid multiples (utils/resize-geometry.ts).
  const resize = (round: (v: number) => number): void => {
    const d = { x: lastDx, y: lastDy };
    const probe = resizeProbe(e0, sides, d, aspect);
    const pull = guideResize(n, probe.box, probe.edges);
    const { left, top, right, bottom } = resizeEdges(e0, sides, d, pull, { minW, minH, aspect, round });
    // An image card scaled down to icon size FOLDS, live; its authored w/h stay the size it unfolds to.
    if (aspect) {
      const fold = foldsToIcon({ left, top, right, bottom }, IMAGE_FOLD);
      if (fold !== n.collapsed) {
        n.collapsed = fold;
      }
      if (fold) { n.dirty = true; return; }
    }
    n.x = left; n.w = right - left;
    if (sizeH || north || south) {
      n.y = top;
      n.h = bottom - top;
      if (!sizeH) {
        n.clip = n.h < natural0 - 1 || undefined;
      }
    }

    // A card being edited is held at its height (render.ts paintNode): the edge drag is what moves that.
    if (!sizeH && ui.bodyEdit?.id === n.id && (north || south)) {
      ui.bodyEdit.holdH = n.h;
    }
    n.dirty = true;
  };
  const move = (ev: PointerEvent): void => {
    lastDx = (ev.clientX - sx) / state.view.k; lastDy = (ev.clientY - sy) / state.view.k;
    resize(snap);
    paintNode(n);
    paintFreeEdges();
    syncSelFrame();
    // A width-only kind re-wraps its text at the new width, which changes its measured HEIGHT — let
    // everything that reads it (edges, the selection bar) settle as the drag goes, once per section.
    if (!sizeH && !subtreeRAF) {
      subtreeRAF = requestAnimationFrame(() => {
        subtreeRAF = null;
        relayout();
      });
    }
    // A north/west resize shifts the section's own x/y, which shifts its content wrapper's origin —
    // repaint the whole subtree (not just direct children) so every hosted descendant's live,
    // wrapper-relative position compensates and stays put in absolute space as the box resizes
    // around it (an east/south-only resize doesn't move the origin, so this is skipped entirely).
    // subtreeIds walks the whole node map, so coalesce it to once per animation frame rather than
    // once per raw pointermove (which can fire far faster than the screen repaints).
    else if ((north || west) && !subtreeRAF) {
      subtreeRAF = requestAnimationFrame(() => {
        subtreeRAF = null;
        for (const id of subtreeIds(n.id)) {
          const k = state.nodes.get(id);
          if (k) {
            paintNode(k);
          }
        }
      });
    }
  };
  const up = (): void => {
    stop();
    ui.resizingId = null; n.el?.classList.remove('resizing');
    if (ui.bodyEdit?.id === n.id) {
      ui.bodyEdit.ta.focus({ preventScroll: true });   // the press took the focus; the editor stays open (inline-edit.ts)
    }
    if (subtreeRAF) { cancelAnimationFrame(subtreeRAF); subtreeRAF = null; }
    resize(snap);   // the final delta; the size was already on the grid throughout
    hideGuides();
    if (!sizeH) {
      settleCardSize(n);
    }
    // paint BEFORE anything reads it: a width-only node's height only matches the snapped width once
    // the DOM has it.
    paintNode(n);
    // NB a west/north drag also moves this node's own x/y, which restales every CHILD's persisted
    // offset — commitRel handles that centrally for every mover, so there's nothing to do here.
    // A resized SECTION takes in what it now covers and lets go of what it no longer does (settleSections).
    if (n.type === 'section') {
      settleSections([n.id]);
    }
    relayout(); scheduleSave(); commitStep();
    syncFloatBar();   // a card that now has an authored height offers Fit (↔)
  };
  const stop = trackPointer({ move, up });
}
