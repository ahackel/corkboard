// Where a new or resized thing GOES: a section fitted round its cards, the smart duplicate's next slot, a
// card added under a section's contents, a paste's offset. Pure, and pinned by tests/placement.test.ts.
import { slidePast, type Box } from './guides.js';
import type { Pt, Rect } from './rect.js';

// The bounds of what a section holds (view/layout.ts subtreesBox): infinite when nothing shows.
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

// A section's box round `b`: `pad` on every side, its corners on the grid, no smaller than `min`. Null when
// there is nothing to fit round.
export function fitAround(b: Bounds, pad: number, grid: number, min: { w: number; h: number }): Rect | null {
  if (!isFinite(b.x0)) {
    return null;
  }
  const snap = (v: number): number => Math.round(v / grid) * grid;
  const x = snap(b.x0 - pad), y = snap(b.y0 - pad);
  return { x, y, w: Math.max(min.w, snap(b.x1 + pad - x)), h: Math.max(min.h, snap(b.y1 + pad - y)) };
}

// The SMART duplicate's slot: right of `src` in its row, at the gap the row already keeps from its left
// neighbour (else `gap`), slid past anything already there.
export function nextInRow(src: Box, others: Box[], gap: number): Pt {
  const inRow = (o: Box): boolean => o.y < src.y + src.h && o.y + o.h > src.y;
  const right = (o: Box): number => o.x + o.w;
  const left = others.filter(o => inRow(o) && right(o) <= src.x).sort((a, b) => right(b) - right(a))[0];
  const keep = left ? src.x - right(left) : gap;
  const { x } = slidePast({ x: src.x + src.w + keep, y: src.y, w: src.w, h: src.h }, others, 'x', keep);
  return { x, y: src.y };
}

// A new card in a section, asked for without a point: under everything it holds, at the interior's left
// edge — so Tab, Tab, Tab fills it top to bottom.
export function belowContents(interior: Rect, kids: Box[], gap: number): Pt {
  const bottom = kids.reduce((y, k) => Math.max(y, k.y + k.h), -Infinity);
  return { x: interior.x + gap, y: kids.length ? bottom + gap : interior.y + gap };
}

// The shift that puts pasted cards' top-left (their saved positions, where they have them) at `target`,
// plus a nudge so a paste over its source never lands exactly on top of it.
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
