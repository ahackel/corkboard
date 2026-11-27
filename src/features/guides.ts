// Smart guides for a drag or resize: the pull (utils/guides.ts) and the lines that show it.
// The lines live in #world; their thickness is divided by the zoom to stay one screen pixel.
import { state, world, type MindNode } from '../core/state.js';
import { isHidden, parentOf } from '../utils/model.js';
import { snapBox, snapEdges, type Box, type Snap, type Side } from '../utils/guides.js';
import { screenToWorld } from '../view/camera.js';
import { nodeW, nodeH } from '../view/geometry.js';

const PULL_TOLERANCE_PX = 6;
const GAP_TICK_PX = 6;

let layer: HTMLElement | null = null;

function guideLayer(): HTMLElement {
  if (layer) {
    return layer;
  }
  layer = document.createElement('div');
  layer.id = 'guides';
  world.appendChild(layer);
  return layer;
}

export function hideGuides(): void {
  seen = null;
  if (layer) {
    layer.replaceChildren();
  }
}

export const boxOf = (n: MindNode, x = n.x, y = n.y): Box => ({ x, y, w: nodeW(n), h: nodeH(n) });

// On-screen siblings not in the drag, cached per gesture and view (nothing else moves meanwhile);
// hideGuides, which ends every gesture, forgets them.
let seen: { key: string; boxes: Box[] } | null = null;

function neighbours(act: MindNode, moving: Set<string>): Box[] {
  const key = `${act.id}|${moving.size}|${state.view.x},${state.view.y},${state.view.k}`;
  if (seen?.key === key) {
    return seen.boxes;
  }
  const space = parentOf(act);
  const a = screenToWorld(0, 0), z = screenToWorld(window.innerWidth, window.innerHeight);
  const view = { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
  const out: Box[] = [];
  for (const n of state.nodes.values()) {
    if (moving.has(n.id) || parentOf(n) !== space || isHidden(n)) {
      continue;
    }
    const b = boxOf(n);
    if (b.x > view.x + view.w || b.x + b.w < view.x || b.y > view.y + view.h || b.y + b.h < view.y) {
      continue;
    }
    out.push(b);
  }
  seen = { key, boxes: out };
  return out;
}

// The roots' union box, at their drag-start positions plus the raw pointer delta, snapped among the
// neighbours. Returns the per-axis correction, or null on an axis the grid should have.
export function guidePull(act: MindNode, roots: Array<{ n: MindNode; s: { x: number; y: number } }>, moving: Set<string>,
                          dx: number, dy: number): { x: number | null; y: number | null } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { n, s } of roots) {
    const b = boxOf(n, s.x + dx, s.y + dy);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 === Infinity) { hideGuides(); return { x: null, y: null }; }
  const snap = snapBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, neighbours(act, moving), PULL_TOLERANCE_PX / state.view.k);
  draw(snap);
  return pullPerAxis(snap);
}

// `box` is the live, unsnapped footprint, `edges` the edge dragged per axis; same contract as guidePull.
export function guideResize(act: MindNode, box: Box, edges: { x?: Side; y?: Side }): { x: number | null; y: number | null } {
  const snap = snapEdges(box, edges, neighbours(act, new Set([act.id])), PULL_TOLERANCE_PX / state.view.k);
  draw(snap);
  return pullPerAxis(snap);
}

// An axis where something lines up belongs to the guides even with no pull, so the grid can't knock
// an exact alignment off.
function pullPerAxis(snap: Snap): { x: number | null; y: number | null } {
  const aligned = (a: 'x' | 'y'): boolean => snap.guides.some(g => g.axis === a) || snap.gaps.some(g => g.axis === a);
  return { x: aligned('x') ? snap.dx : null, y: aligned('y') ? snap.dy : null };
}

function draw(snap: Snap): void {
  const el = guideLayer(), t = 1 / state.view.k;
  const line = (x: number, y: number, w: number, h: number, cls: string): HTMLElement => {
    const d = document.createElement('div');
    d.className = cls;
    d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    return d;
  };
  const parts: HTMLElement[] = [];
  for (const g of snap.guides) {
    parts.push(g.axis === 'x' ? line(g.at - t / 2, g.from, t, g.to - g.from, 'guide')
                              : line(g.from, g.at - t / 2, g.to - g.from, t, 'guide'));
  }
  // An equal-gap marker: a bar with a tick at each end.
  const tick = GAP_TICK_PX * t;
  for (const g of snap.gaps) {
    if (g.to - g.from < 1) {
      continue;
    }
    if (g.axis === 'y') {
      parts.push(line(g.at - t / 2, g.from, t, g.to - g.from, 'guide gap'));
      parts.push(line(g.at - tick / 2, g.from, tick, t, 'guide gap'), line(g.at - tick / 2, g.to - t, tick, t, 'guide gap'));
    } else {
      parts.push(line(g.from, g.at - t / 2, g.to - g.from, t, 'guide gap'));
      parts.push(line(g.from, g.at - tick / 2, t, tick, 'guide gap'), line(g.to - t, g.at - tick / 2, t, tick, 'guide gap'));
    }
  }
  el.replaceChildren(...parts);
}
