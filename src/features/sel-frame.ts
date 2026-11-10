// ---------- the SELECTION FRAME: one box round a multi-selection, and scaling the lot by its corners ----------
// FigJam's: select two or more and a single frame is drawn round all of them, with the same square
// corner handles a lone selection wears. Its interior is not a target (a press there still lands on
// the card under it, which drags the whole selection — drag.ts); only its handles take the pointer.
import { type MindNode, state, world } from '../core/state.js';
import { isStack } from '../core/state.js';
import { isHidden, isLockedEffective, outermost, childrenOf } from '../utils/model.js';
import { isBoxNode, imageLook, isImageFold, isSectionFold, nodeW, nodeH, gridSnap } from '../view/geometry.js';
import { isSection } from '../view/layout.js';
import { snapTo } from '../utils/num.js';
import { touch, commitStep } from './history.js';
import { paintNode, relayout } from '../main.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { settleSections } from './drag.js';
import { syncFloatBar } from './float-bar.js';
import { trackPointer } from '../utils/dom.js';
import { scheduleSave } from '../data/save.js';
import { minWOf, minHOf, CLIP_MIN_H, imageAspect, naturalH, settleCardSize } from './resize.js';

// Corners only: the frame's edges run along its members' own edges, where a card's tags, its resize
// band and a section's tab already live — a grip there would steal their presses.
const DIRS = ['ne', 'nw', 'se', 'sw'] as const;
type Dir = typeof DIRS[number];
interface Rect { x: number; y: number; w: number; h: number }

let frame: HTMLElement | null = null;

function frameEl(): HTMLElement {
  if (frame) {
    return frame;
  }
  frame = document.createElement('div');
  frame.id = 'selFrame';
  for (const dir of DIRS) {
    const h = document.createElement('div');
    h.className = 'sf-h sf-' + dir;
    h.addEventListener('pointerdown', (e) => startGroupResize(e, dir));
    frame.appendChild(h);
  }
  world.appendChild(frame);
  return frame;
}

// The selected nodes actually on the canvas — a frame round an invisible card would point at nothing.
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
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const n of ns) {
    l = Math.min(l, n.x); t = Math.min(t, n.y);
    r = Math.max(r, n.x + nodeW(n)); b = Math.max(b, n.y + nodeH(n));
  }
  return { x: l, y: t, w: r - l, h: b - t };
}

// Redraw the frame round the selection as it is now. Called wherever the selection or the geometry of
// what's in it changes: the selection funnel, every full paint, a drag frame, a resize step.
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

// How one node follows the frame. A node with a size of its own to scale (an open section, a card, a
// picture) maps its whole rect through the frame and its contents follow the same mapping; anything
// sized by what it SHOWS (a folded chip or pill, a pile, a folded picture) keeps its size and is only
// carried, its subtree with it, by the shift of its own top-left corner.
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

// Drag a frame corner: every selected node (and everything inside a selected section) scales with the
// frame, the opposite corner held still. The frame stops shrinking where its tightest member reaches its
// minimum, so the arrangement keeps its proportions instead of piling up at the floor. Shift scales
// both axes alike. The dragged corner lands on the grid, as a resized box's does.
function startGroupResize(e: PointerEvent, dir: Dir): void {
  const ns = members();
  if (state.readOnly || ns.length < 2 || ns.some(isLockedEffective)) {
    return;
  }
  e.stopPropagation(); e.preventDefault();
  const plans: Plan[] = [];
  for (const r of outermost(ns)) {
    planFor(r, plans, null);
  }
  touch(...plans.map(p => p.n.id));
  const f0 = boundsOf(ns);
  const west = dir.includes('w'), north = dir.includes('n');
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
    const l0 = f0.x, t0 = f0.y, r0 = f0.x + f0.w, b0 = f0.y + f0.h;
    let sx = west ? (r0 - snapTo(l0 + dx, g)) / f0.w : (snapTo(r0 + dx, g) - l0) / f0.w;
    let sy = north ? (b0 - snapTo(t0 + dy, g)) / f0.h : (snapTo(b0 + dy, g) - t0) / f0.h;
    sx = Math.max(sx, minSx); sy = Math.max(sy, minSy);
    if (ev.shiftKey) {
      sx = sy = Math.max(sx, sy);
    }

    // The fixed corner: the edges NOT being dragged.
    const ax = west ? r0 : l0, ay = north ? b0 : t0;
    const mapX = (x: number): number => ax + (x - ax) * sx, mapY = (y: number): number => ay + (y - ay) * sy;
    for (const p of plans) {
      const n = p.n;
      if (p.mode === 'move') {
        n.x = p.x + mapX(p.ax) - p.ax; n.y = p.y + mapY(p.ay) - p.ay;
      } else if (p.mode === 'image') {
        // A picture keeps its own aspect: it scales by the smaller of the two, centred on where its
        // centre maps to.
        const w = Math.max(minWOf(n), p.w * Math.min(sx, sy)), h = Math.max(p.minH, w / p.aspect);
        n.x = mapX(p.x + p.w / 2) - w / 2; n.y = mapY(p.y + p.h / 2) - h / 2;
        n.w = w; n.h = h;
      } else {
        n.x = mapX(p.x); n.y = mapY(p.y);
        n.w = Math.max(minWOf(n), p.w * sx);
        n.h = Math.max(p.minH, p.h * sy);
        if (p.mode === 'card') {
          n.clip = n.h < p.natural - 1 || undefined;
        }
        scaled.add(n);
      }
      n.dirty = true; n.dirtyLayout = true;
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

    // A resized SECTION takes in what it now covers and lets go of what it no longer does.
    settleSections([...scaled].filter(isSection).map(n => n.id));
    relayout(); scheduleSave(); commitStep();
    syncFloatBar();
  };
  const stop = trackPointer({ move, up });
}
