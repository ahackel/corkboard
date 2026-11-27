// Plain rectangle arithmetic: which box holds a point, which box lies inside another. Pure, and pinned by
// tests/rect.test.ts.
export interface Rect { x: number; y: number; w: number; h: number }

export interface Pt { x: number; y: number }

// Edges count as inside, so a card exactly on a section's border still belongs to it.
export function contains(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function encloses(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function centreOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

// The box round all of them (infinite extents when there are none).
export function unionRect(rects: Iterable<Rect>): Rect {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const q of rects) {
    l = Math.min(l, q.x); t = Math.min(t, q.y);
    r = Math.max(r, q.x + q.w); b = Math.max(b, q.y + q.h);
  }
  return { x: l, y: t, w: r - l, h: b - t };
}

// The DEEPEST of the items whose box holds `p` — nested sections overlap, and the innermost wins; on a tie,
// the first. `boxOf` returns null for an item that can't be hit at all.
export function deepestAt<T>(items: Iterable<T>, p: Pt, boxOf: (t: T) => Rect | null, depthOf: (t: T) => number): T | null {
  let best: T | null = null, bestDepth = -1;
  for (const t of items) {
    const b = boxOf(t);
    if (!b || !contains(b, p)) {
      continue;
    }
    const d = depthOf(t);
    if (d > bestDepth) {
      bestDepth = d;
      best = t;
    }
  }
  return best;
}
