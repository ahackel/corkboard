// Smart guides while dragging: the pull (utils/guides.ts snapBox) and the pink lines that show it.
// drag.ts asks `guidePull` for the correction on every move, a resize (main.ts) asks `guideResize`,
// and both call `hideGuides` when the gesture ends. The lines live in #world, so they pan and zoom with the cards; their thickness is divided by
// the zoom so they stay one screen pixel.
import { state, world, type MindNode } from '../core/state.js';
import { isHidden, parentOf } from '../utils/model.js';
import { snapBox, snapEdges, type Box, type Snap, type Side } from '../utils/guides.js';
import { screenToWorld } from '../view/camera.js';
import { nodeW, nodeH } from '../view/geometry.js';

const TOL = 6;   // screen px: close enough to pull

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
  if (layer) {
    layer.replaceChildren();
  }
}

export const boxOf = (n: MindNode, x = n.x, y = n.y): Box => ({ x, y, w: nodeW(n), h: nodeH(n) });

// The cards a dragged one lines up against: its siblings in the same space (the top level, or the
// same frame), on screen, and not part of the drag.
function neighbours(act: MindNode, moving: Set<string>): Box[] {
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
  return out;
}

// The pull for a drag whose roots sit at `starts` (their positions when the drag began) moved by the
// RAW pointer delta (dx,dy): the union box is snapped among the neighbours, and the lines drawn.
// Returns the per-axis correction, or null on an axis nothing pulls (the grid has it then).
export function guidePull(act: MindNode, roots: Array<{ n: MindNode; s: { x: number; y: number } }>, moving: Set<string>,
                          dx: number, dy: number): { x: number | null; y: number | null } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { n, s } of roots) {
    const b = boxOf(n, s.x + dx, s.y + dy);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 === Infinity) { hideGuides(); return { x: null, y: null }; }
  const snap = snapBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, neighbours(act, moving), TOL / state.view.k);
  draw(snap);
  // an axis is the guides' when something lines up on it — even with no pull, so an exact alignment
  // isn't then knocked off by the grid
  const has = (a: 'x' | 'y'): boolean => snap.guides.some(g => g.axis === a) || snap.gaps.some(g => g.axis === a);
  return { x: has('x') ? snap.dx : null, y: has('y') ? snap.dy : null };
}

// The pull for a box being RESIZED (features/resize.ts startNodeResize): `box` is its live, unsnapped footprint
// and `edges` the edge dragged on each axis. Returns how far each dragged edge moves, or null on an axis
// nothing pulls (the grid has it then) — the same contract as guidePull.
export function guideResize(act: MindNode, box: Box, edges: { x?: Side; y?: Side }): { x: number | null; y: number | null } {
  const snap = snapEdges(box, edges, neighbours(act, new Set([act.id])), TOL / state.view.k);
  draw(snap);
  const has = (a: 'x' | 'y'): boolean => snap.guides.some(g => g.axis === a) || snap.gaps.some(g => g.axis === a);
  return { x: has('x') ? snap.dx : null, y: has('y') ? snap.dy : null };
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
  // a gap: a bar along the gap with a tick at each end — "these two spaces are the same"
  const tick = 6 * t;
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
