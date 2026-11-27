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

// An image card's floor is the icon it folds to; anything else only gets WIDER than its default.
export function minWOf(n: MindNode): number {
  return imageLook(n) ? IMAGE_FOLD : NODE_W;
}

// The shortest a CLIPPED card goes: about one line of text under its padding.
export const CLIP_MIN_H = 44;

export function minHOf(n: MindNode): number {
  return imageLook(n) ? IMAGE_FOLD : MIN_SECTION_H;
}

export const SECTION_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type SectionDir = typeof SECTION_DIRS[number];

export function ensureResizeHandles(n: MindNode): void {
  const el = n.el!;
  if (el.dataset.fhDirs) {
    return;
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
    return;   // skips the query: this runs every repaint
  }

  // `:scope >`: child cards are DOM-nested, and their handles are not ours.
  el.querySelectorAll(':scope > .fh').forEach(x => x.remove());
  delete el.dataset.fhDirs;
}

// The loaded image's ratio, else the box's, so a resize is stable before the blob URL loads.
export function imageAspect(n: MindNode): number {
  const img = n.el?.querySelector('img.md-img') as HTMLImageElement | null;
  if (img && img.naturalWidth && img.naturalHeight) {
    return img.naturalWidth / img.naturalHeight;
  }
  const w = n.w ?? IMAGE_W, h = n.h ?? IMAGE_H;
  return w / (h || 1);
}

// A card's text height at its current width (a clipped card's body cap is lifted to measure it).
export function naturalH(n: MindNode): number {
  const el = n.el!, body = el.querySelector(':scope > .body') as HTMLElement;
  const was = el.style.minHeight, wasMax = body.style.maxHeight;
  el.style.minHeight = ''; body.style.maxHeight = ''; const h = el.offsetHeight;
  el.style.minHeight = was; body.style.maxHeight = wasMax;
  return h;
}

// A PLAIN card drops any size it no longer needs to author; shorter than its text, it clips.
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

  // A BOX's height is exactly what's dragged; a card's is a minimum over its text. A FOLDED image card
  // is a box here (isBoxNode says no): scaling its icon back up is how it unfolds.
  const img = imageLook(n);
  const sizeH = isBoxNode(n) || img;
  const minW = minWOf(n);
  const natural0 = sizeH ? 0 : naturalH(n);
  const minH = sizeH ? minHOf(n) : Math.min(natural0, CLIP_MIN_H);
  const lockedAspect = img ? imageAspect(n) : null;

  // Live geometry: a plain card has no default box size to start from.
  const e0 = { left: n.x, top: n.y, right: n.x + nodeW(n), bottom: n.y + nodeH(n) };
  const sx = e.clientX, sy = e.clientY;
  ui.resizingId = n.id; n.el?.classList.add('resizing');
  const sides = sidesOf(dir);
  const { west, north, south } = sides;
  touch(n.id);
  let lastDx = 0, lastDy = 0;
  let subtreeRAF: number | null = null;
  const g = gridSnap();
  const snap = (v: number): number => snapTo(v, g);
  const resize = (round: (v: number) => number): void => {
    const d = { x: lastDx, y: lastDy };
    const probe = resizeProbe(e0, sides, d, lockedAspect);
    const pull = guideResize(n, probe.box, probe.edges);
    const { left, top, right, bottom } = resizeEdges(e0, sides, d, pull, { minW, minH, aspect: lockedAspect, round });

    // Folding keeps the authored w/h: the size it unfolds to.
    if (lockedAspect) {
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

    // A card being edited is held at its height (paintNode); the edge drag moves that hold.
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

    // A card re-wraps at its new width, changing its measured height.
    if (!sizeH && !subtreeRAF) {
      subtreeRAF = requestAnimationFrame(() => {
        subtreeRAF = null;
        relayout();
      });
    }

    // A north/west resize moves the content wrapper's origin, so every descendant repaints to stay put.
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
      ui.bodyEdit.ta.focus({ preventScroll: true });   // the press took the focus
    }
    if (subtreeRAF) { cancelAnimationFrame(subtreeRAF); subtreeRAF = null; }
    resize(snap);
    hideGuides();
    if (!sizeH) {
      settleCardSize(n);
    }
    paintNode(n);   // before anything measures it
    if (n.type === 'section') {
      settleSections([n.id]);
    }
    relayout(); scheduleSave(); commitStep();
    syncFloatBar();   // an authored height offers Fit
  };
  const stop = trackPointer({ move, up });
}
