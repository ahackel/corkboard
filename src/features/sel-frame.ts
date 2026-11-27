// One frame round a multi-selection: its interior drags the group, its corners and edges scale it.
// Interior and edge bands sit BELOW every card (styles.css), so cards keep their own presses.
import { type MindNode, state, world, isStack } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isHidden, isLockedEffective, outermost, childrenOf } from '../utils/model.js';
import { isBoxNode, imageLook, isImageFold, isSectionFold, nodeW, nodeH, nodeRect, gridSnap } from '../view/geometry.js';
import { isSection } from '../view/layout.js';
import { unionRect, type Rect } from '../utils/rect.js';
import { sidesOf, frameEdgeDir, frameScale } from '../utils/resize-geometry.js';
import { touch, commitStep } from './history.js';
import { paintNode, relayout } from '../render.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { startSelectionDrag } from './drag.js';
import { settleSections } from './drop.js';
import { syncFloatBar } from './float-bar.js';
import { trackPointer } from '../utils/dom.js';
import { scheduleSave } from '../data/save.js';
import { SECTION_DIRS, minWOf, minHOf, CLIP_MIN_H, imageAspect, naturalH, settleCardSize } from './resize.js';

type Dir = typeof SECTION_DIRS[number];

let frame: HTMLElement | null = null;

function frameEl(): HTMLElement {
  if (frame) {
    return frame;
  }
  frame = document.createElement('div');
  frame.id = 'selFrame';
  const fill = document.createElement('div');
  fill.className = 'sf-fill';

  // A plain press only: Space/middle-button pans and ⌘/Ctrl starts an adding marquee.
  fill.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && !ui.spaceHeld && !e.metaKey && !e.ctrlKey) {
      startSelectionDrag(e);
    }
  });
  const box = document.createElement('div');
  box.className = 'sf-box';
  frame.append(fill, box);
  for (const dir of SECTION_DIRS) {
    const h = document.createElement('div');
    h.className = 'sf-h sf-' + dir;
    h.addEventListener('pointerdown', (e) => { startGroupResize(e, dir); });
    frame.appendChild(h);
  }
  world.appendChild(frame);
  return frame;
}

function members(): MindNode[] {
  const out: MindNode[] = [];
  for (const id of state.sel) {
    const n = state.nodes.get(id);
    if (n?.el && !isHidden(n)) {
      out.push(n);
    }
  }
  return out;
}

function boundsOf(ns: MindNode[]): Rect {
  return unionRect(ns.map(nodeRect));
}

export function syncSelFrame(): void {
  const ns = state.sel.size > 1 ? members() : [];
  if (ns.length < 2) {
    if (frame) {
      frame.style.display = 'none';
    }
    return;
  }
  const el = frameEl();
  const r = boundsOf(ns);
  el.style.display = '';
  el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
  el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
  el.classList.toggle('locked', ns.some(isLockedEffective));
}

// A node sized by what it SHOWS (chip, pill, pile, folded picture) is only carried by its corner's shift,
// its subtree with it; anything else maps its whole rect through the frame.
type Plan =
  | { n: MindNode; mode: 'move'; x: number; y: number; ax: number; ay: number }
  | { n: MindNode; mode: 'box' | 'card' | 'image'; x: number; y: number; w: number; h: number; minH: number; natural: number; aspect: number };

function isFixedSize(n: MindNode): boolean {
  return isStack(n) || isSectionFold(n) || isImageFold(n) || (!!n.collapsed && !isSection(n));
}

function planFor(n: MindNode, out: Plan[], anchor: MindNode | null): void {
  if (anchor || isFixedSize(n)) {
    const a = anchor ?? n;
    out.push({ n, mode: 'move', x: n.x, y: n.y, ax: a.x, ay: a.y });
    for (const c of childrenOf(n.id)) {
      planFor(c, out, a);
    }
    return;
  }
  const img = imageLook(n);
  const mode = img ? 'image' : isBoxNode(n) ? 'box' : 'card';
  const natural = mode === 'card' ? naturalH(n) : 0;
  const minH = mode === 'card' ? Math.min(natural, CLIP_MIN_H) : minHOf(n);
  out.push({ n, mode, x: n.x, y: n.y, w: nodeW(n), h: nodeH(n), minH, natural, aspect: img ? imageAspect(n) : 1 });
  for (const c of childrenOf(n.id)) {
    planFor(c, out, null);
  }
}

// A member's edge that lies ON the frame scales the whole group. Returns whether the group took the press.
export function memberEdgeResize(e: PointerEvent, n: MindNode, dir: Dir): boolean {
  if (state.sel.size < 2 || !state.sel.has(n.id)) {
    return false;
  }
  const ns = members();
  if (ns.length < 2) {
    return false;
  }
  const groupDir = frameEdgeDir(nodeRect(n), boundsOf(ns), dir) as Dir | '';
  if (!groupDir) {
    return false;
  }
  return startGroupResize(e, groupDir);
}

// The frame stops shrinking at its tightest member's minimum, so the arrangement keeps its proportions.
function startGroupResize(e: PointerEvent, dir: Dir): boolean {
  const ns = members();
  if (ns.length < 2 || ns.some(isLockedEffective)) {
    return false;
  }
  e.stopPropagation(); e.preventDefault();
  const plans: Plan[] = [];
  for (const r of outermost(ns)) {
    planFor(r, plans, null);
  }
  touch(...plans.map(p => p.n.id));
  const f0 = boundsOf(ns);
  const sides = sidesOf(dir);
  const hasX = sides.east || sides.west, hasY = sides.north || sides.south;
  let minSx = 0, minSy = 0;
  for (const p of plans) {
    if (p.mode !== 'move') {
      minSx = Math.max(minSx, minWOf(p.n) / p.w);
      minSy = Math.max(minSy, p.minH / p.h);
    }
  }
  const g = gridSnap();
  const sx0 = e.clientX, sy0 = e.clientY;
  const scaled = new Set<MindNode>();
  let raf: number | null = null, moved = false;

  const apply = (ev: PointerEvent): void => {
    const dx = (ev.clientX - sx0) / state.view.k, dy = (ev.clientY - sy0) / state.view.k;
    const { sx, sy, anchor: { x: ax, y: ay } } = frameScale(f0, sides, { x: dx, y: dy }, g, { x: minSx, y: minSy }, ev.shiftKey);
    const mapX = (x: number): number => ax + (x - ax) * sx, mapY = (y: number): number => ay + (y - ay) * sy;
    for (const p of plans) {
      const n = p.n;
      if (p.mode === 'move') {
        n.x = p.x + mapX(p.ax) - p.ax; n.y = p.y + mapY(p.ay) - p.ay;
      } else if (p.mode === 'image') {

        // A picture keeps its aspect, scaled by the dragged axis (the smaller on a corner) about its centre.
        const s = hasX && hasY ? Math.min(sx, sy) : hasX ? sx : sy;
        const w = Math.max(minWOf(n), p.w * s), h = Math.max(p.minH, w / p.aspect);
        n.x = mapX(p.x + p.w / 2) - w / 2; n.y = mapY(p.y + p.h / 2) - h / 2;
        n.w = w; n.h = h;
      } else {
        n.x = mapX(p.x); n.y = mapY(p.y);
        if (hasX) {
          n.w = Math.max(minWOf(n), p.w * sx);
        }
        if (hasY) {
          n.h = Math.max(p.minH, p.h * sy);
          if (p.mode === 'card') {
            n.clip = n.h < p.natural - 1 || undefined;
          }
        }
        scaled.add(n);
      }
      n.dirty = true;
    }
    for (const p of plans) {
      paintNode(p.n);
    }
  };
  const move = (ev: PointerEvent): void => {
    moved = true;
    apply(ev);
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = null;
        paintFreeEdges();
        syncSelFrame();
      });
    }
  };
  const up = (ev: PointerEvent): void => {
    stop();
    if (raf) {
      cancelAnimationFrame(raf); raf = null;
    }

    // A press that never moved changes nothing (the grid would otherwise nudge an off-grid frame).
    if (!moved) {
      commitStep();
      return;
    }
    apply(ev);
    for (const n of scaled) {
      if (!isBoxNode(n)) {
        settleCardSize(n);
      }
      paintNode(n);
    }
    settleSections([...scaled].filter(isSection).map(n => n.id));
    relayout(); scheduleSave(); commitStep();
    syncFloatBar();
  };
  const stop = trackPointer({ move, up });
  return true;
}
