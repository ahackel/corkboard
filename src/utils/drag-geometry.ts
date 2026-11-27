// The arithmetic of a card drag: grid snapping and edge auto-pan.
import { snapTo } from './num.js';
import type { Pt } from './rect.js';

// The ANCHOR card's correction is applied to every card in the drag, so a group keeps its spacing.
export function gridDelta(start: Pt, delta: Pt, origin: Pt, grid: number): Pt {
  return {
    x: snapTo(start.x + delta.x - origin.x, grid) + origin.x - start.x,
    y: snapTo(start.y + delta.y - origin.y, grid) + origin.y - start.y,
  };
}

export interface Edges { left: number; top: number; right: number; bottom: number }

// Up to `max` px per frame, ramping in over a `band`-px strip at the stage's edge.
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
