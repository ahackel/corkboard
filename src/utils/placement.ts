// Where a new or resized thing GOES.
import { slidePast, type Box } from './guides.js';
import type { Pt, Rect } from './rect.js';

// Infinite when nothing shows.
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

// `pad` on every side, corners on the grid, no smaller than `min`; null when there's nothing to fit round.
export function fitAround(b: Bounds, pad: number, grid: number, min: { w: number; h: number }): Rect | null {
  if (!isFinite(b.x0)) {
    return null;
  }
  const snap = (v: number): number => Math.round(v / grid) * grid;
  const x = snap(b.x0 - pad), y = snap(b.y0 - pad);
  return { x, y, w: Math.max(min.w, snap(b.x1 + pad - x)), h: Math.max(min.h, snap(b.y1 + pad - y)) };
}

// Right of `src`, at the gap its row already keeps (else `gap`), slid past anything already there.
export function nextInRow(src: Box, others: Box[], gap: number): Pt {
  const inRow = (o: Box): boolean => o.y < src.y + src.h && o.y + o.h > src.y;
  const right = (o: Box): number => o.x + o.w;
  const left = others.filter(o => inRow(o) && right(o) <= src.x).sort((a, b) => right(b) - right(a))[0];
  const keep = left ? src.x - right(left) : gap;
  const { x } = slidePast({ x: src.x + src.w + keep, y: src.y, w: src.w, h: src.h }, others, 'x', keep);
  return { x, y: src.y };
}

// Under everything the section holds, so Tab, Tab, Tab fills it top to bottom.
export function belowContents(interior: Rect, kids: Box[], gap: number): Pt {
  const bottom = kids.reduce((y, k) => Math.max(y, k.y + k.h), -Infinity);
  return { x: interior.x + gap, y: kids.length ? bottom + gap : interior.y + gap };
}

// The nudge keeps a paste over its source from landing exactly on top of it.
export function pasteShift(target: Pt, saved: Array<{ x?: number | null; y?: number | null }>, nudge: number): Pt {
  let ax = Infinity, ay = Infinity;
  for (const p of saved) {
    if (p.x != null && p.y != null) {
      ax = Math.min(ax, p.x);
      ay = Math.min(ay, p.y);
    }
  }
  return { x: target.x - (ax === Infinity ? target.x : ax) + nudge, y: target.y - (ay === Infinity ? target.y : ay) + nudge };
}
