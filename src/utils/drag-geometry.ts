// The arithmetic of a card drag: how the grid bends the pointer's delta, and how fast the view pans at the
// window's edge. Pure, and pinned by tests/drag-geometry.test.ts.
import { snapTo } from './num.js';
import type { Pt } from './rect.js';

// The delta that puts the anchor card ON the grid, measured from `origin` (its section's corner, or the
// world's): the same correction is applied to every card in the drag, so a group keeps its spacing.
export function gridDelta(start: Pt, delta: Pt, origin: Pt, grid: number): Pt {
  return {
    x: snapTo(start.x + delta.x - origin.x, grid) + origin.x - start.x,
    y: snapTo(start.y + delta.y - origin.y, grid) + origin.y - start.y,
  };
}

export interface Edges { left: number; top: number; right: number; bottom: number }

// The view's pan per frame for a pointer near the stage's edge: up to `max` px, ramping in over a `band`
// px wide strip, toward the edge the pointer is in (the view moves the other way to bring that side in).
export function edgePanVelocity(p: Pt, stage: Edges, band: number, max: number): Pt {
  let vx = 0, vy = 0;
  if (p.x < stage.left + band) {
    vx = Math.min(1, (stage.left + band - p.x) / band);
  } else if (p.x > stage.right - band) {
    vx = -Math.min(1, (p.x - (stage.right - band)) / band);
  }
  if (p.y < stage.top + band) {
    vy = Math.min(1, (stage.top + band - p.y) / band);
  } else if (p.y > stage.bottom - band) {
    vy = -Math.min(1, (p.y - (stage.bottom - band)) / band);
  }
  return { x: vx * max, y: vy * max };
}
