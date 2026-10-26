// Smart guides: where a dragged box would like to land among its neighbours. Pure geometry — boxes in,
// a correction and the lines to draw out — so tests/guides.test.ts pins it; features/guides.ts draws.
//
// Per axis, the box is pulled (within `tol`) to the NEAREST of:
//  - ALIGNMENT: one of its edges onto a neighbour's edge, or its centre onto a neighbour's centre;
//  - SPACING: the same gap as the pair it continues (a column of cards keeps its rhythm), or the
//    middle between the two neighbours it sits between.
// Nothing moves on its own: this only runs while the user drags, and only ever by a few pixels.
export interface Box { x: number; y: number; w: number; h: number; }
// axis 'x' = a VERTICAL line at x=`at` from y=`from` to y=`to`; axis 'y' = a horizontal one.
export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number; }
// A spacing marker: a gap along `axis` from `from` to `to`, drawn across at `at` on the other axis.
export interface Gap { axis: 'x' | 'y'; from: number; to: number; at: number; }
export interface Snap { dx: number; dy: number; guides: Guide[]; gaps: Gap[]; }

type Axis = 'x' | 'y';
const other = (a: Axis): Axis => a === 'x' ? 'y' : 'x';
const lo = (b: Box, a: Axis): number => a === 'x' ? b.x : b.y;
const len = (b: Box, a: Axis): number => a === 'x' ? b.w : b.h;
const hi = (b: Box, a: Axis): number => lo(b, a) + len(b, a);
const mid = (b: Box, a: Axis): number => lo(b, a) + len(b, a) / 2;
// Do the two boxes face each other across `a` — i.e. overlap on the OTHER axis?
const facing = (p: Box, q: Box, a: Axis): boolean => {
  const o = other(a);
  return lo(p, o) < hi(q, o) && lo(q, o) < hi(p, o);
};
const shift = (b: Box, a: Axis, d: number): Box => a === 'x' ? { ...b, x: b.x + d } : { ...b, y: b.y + d };

// The neighbour just BEFORE `b` along `a` (facing it, ending before its middle), and just AFTER.
function before(b: Box, all: Box[], a: Axis): Box | null {
  let best: Box | null = null;
  for (const o of all) if (o !== b && facing(o, b, a) && hi(o, a) <= mid(b, a)
    && (!best || hi(o, a) > hi(best, a))) best = o;
  return best;
}
function after(b: Box, all: Box[], a: Axis): Box | null {
  let best: Box | null = null;
  for (const o of all) if (o !== b && facing(o, b, a) && lo(o, a) >= mid(b, a)
    && (!best || lo(o, a) < lo(best, a))) best = o;
  return best;
}

interface Pull { d: number; gaps: (box: Box) => Gap[]; }
function bestPull(box: Box, others: Box[], a: Axis, tol: number): Pull | null {
  let best: Pull | null = null;
  const offer = (d: number, gaps: Pull['gaps'] = () => []): void => {
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, gaps };
  };
  for (const o of others) {
    for (const e of [lo(o, a), hi(o, a)]) { offer(e - lo(box, a)); offer(e - hi(box, a)); }
    offer(mid(o, a) - mid(box, a));
  }
  const o = other(a);
  // a gap marker between p and q, drawn across the middle of where they overlap
  const gap = (p: Box, q: Box): Gap => ({ axis: a, from: hi(p, a), to: lo(q, a),
    at: (Math.max(lo(p, o), lo(q, o)) + Math.min(hi(p, o), hi(q, o))) / 2 });
  const A = before(box, others, a), B = after(box, others, a);
  if (A) {
    const A2 = before(A, others, a);
    if (A2) { const g = lo(A, a) - hi(A2, a); offer(hi(A, a) + g - lo(box, a), bx => [gap(A2, A), gap(A, bx)]); }
  }
  if (B) {
    const B2 = after(B, others, a);
    if (B2) { const g = lo(B2, a) - hi(B, a); offer(lo(B, a) - g - hi(box, a), bx => [gap(bx, B), gap(B, B2)]); }
  }
  if (A && B && lo(B, a) - hi(A, a) >= len(box, a))
    offer((hi(A, a) + lo(B, a) - len(box, a)) / 2 - lo(box, a), bx => [gap(A, bx), gap(bx, B)]);
  return best;
}

// The alignment lines the (already snapped) box shows: every neighbour edge/centre it now sits on —
// ONE line per position, spanning every box that shares it, so a row of aligned cards reads as one rule.
function alignGuides(box: Box, others: Box[], a: Axis): Guide[] {
  const o = other(a), out = new Map<number, Guide>();
  const mine = [lo(box, a), mid(box, a), hi(box, a)];
  for (const n of others) {
    const theirs = [lo(n, a), mid(n, a), hi(n, a)];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if ((i === 1) !== (j === 1) || Math.abs(mine[i] - theirs[j]) > 0.5) continue;   // centre↔centre, edge↔edge
      const at = Math.round(theirs[j] * 2) / 2, g = out.get(at);
      const from = Math.min(lo(box, o), lo(n, o)), to = Math.max(hi(box, o), hi(n, o));
      if (g) { g.from = Math.min(g.from, from); g.to = Math.max(g.to, to); }
      else out.set(at, { axis: a, at, from, to });
    }
  }
  // Cards of one width share left, centre AND right — three rules through the text say no more than
  // two: the centre line only shows when no edge lines up.
  const edges = [...out.values()].filter(g => g.at !== Math.round(mid(box, a) * 2) / 2);
  return edges.length ? edges : [...out.values()];
}

export function snapBox(box: Box, others: Box[], tol: number): Snap {
  const px = bestPull(box, others, 'x', tol), py = bestPull(box, others, 'y', tol);
  const dx = px?.d ?? 0, dy = py?.d ?? 0;
  const fin = shift(shift(box, 'x', dx), 'y', dy);
  return {
    dx, dy,
    guides: [...alignGuides(fin, others, 'x'), ...alignGuides(fin, others, 'y')],
    gaps: [...(px?.gaps(fin) ?? []), ...(py?.gaps(fin) ?? [])],
  };
}
