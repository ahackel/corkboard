// ---------- the ROUTE of a drawn line, as pure geometry ----------
// Where an elbow line between two boxes runs, and the SVG path that draws it. Nothing here knows about
// nodes, the DOM or the camera: view/free-edges.ts turns cards into Rects and paints what comes back,
// which is what lets tests/edge-route.test.ts pin the router down without a browser.
import type { EdgeSide } from '../core/state.js';
import type { Pt } from '../core/ui-state.js';
import type { Box } from './guides.js';

// The rectangle a line meets (view/free-edges.ts rimRect builds it from a node).
export type Rect = Box;

export function centre(r: Rect): Pt {
  return { x: r.x + r.w/2, y: r.y + r.h/2 };
}

// Where the segment from the box's centre toward `p` leaves its rim. Ray/box: the axis it reaches
// first decides.
export function rimPoint(r: Rect, p: Pt): Pt {
  const c = centre(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  if (!dx && !dy) {
    return c;
  }
  const tx = dx ? (r.w/2) / Math.abs(dx) : Infinity, ty = dy ? (r.h/2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function unit(p: Pt, q: Pt): Pt {
  const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}

// A path through `pts`, each end pulled in by its own trim along its own leg, as an SVG path plus what
// the caps and the label need. Two points is a straight segment; more is an elbow, its corners rounded
// (CORNER_R, shrunk to fit a short leg) the way FigJam's are.
// `box` bounds the whole route, its UNTRIMMED ends included — what the edge bar keeps clear of.
export interface Geometry { a: Pt; b: Pt; d: string; mid: Pt; tipTan: Pt; tailTan: Pt; box: { x0: number; y0: number; x1: number; y1: number } }
const CORNER_R = 24;

// A corner never eats the END legs down to nothing: the cap needs a straight stretch to sit on, or an
// arrowhead lands on the bend and reads as a hook.
const END_STRAIGHT = 16;

export function polyline(pts: Pt[], trimA: number, trimB: number): Geometry {
  const box = { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)),
                x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
  pts = pts.map(p => ({ ...p }));
  const n = pts.length;
  const lenOf = (i: number): number => Math.hypot(pts[i+1].x - pts[i].x, pts[i+1].y - pts[i].y);
  const tailU = unit(pts[1], pts[0]), tipU = unit(pts[n-2], pts[n-1]);
  // A leg too short to give up its trim keeps it (two cards nearly touching): a line that turned
  // inside out would be worse than one that touches.
  const trimTail = n === 2 ? lenOf(0) > (trimA + trimB) * 1.5 : lenOf(0) > trimA * 1.5;
  const trimTip = n === 2 ? trimTail : lenOf(n-2) > trimB * 1.5;
  if (trimTail) {
    pts[0] = { x: pts[0].x - tailU.x * trimA, y: pts[0].y - tailU.y * trimA };
  }
  if (trimTip) {
    pts[n-1] = { x: pts[n-1].x - tipU.x * trimB, y: pts[n-1].y - tipU.y * trimB };
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i], uin = unit(pts[i-1], p), uout = unit(p, pts[i+1]);
    const fit = (j: number): number => (j === 0 || j === n - 2) ? lenOf(j) - END_STRAIGHT : lenOf(j) / 2;
    const r = Math.max(0, Math.min(CORNER_R, fit(i-1), fit(i)));
    d += ` L ${p.x - uin.x * r} ${p.y - uin.y * r} Q ${p.x} ${p.y} ${p.x + uout.x * r} ${p.y + uout.y * r}`;
  }
  d += ` L ${pts[n-1].x} ${pts[n-1].y}`;
  // The label's spot: halfway along the line, which on an elbow is the middle of its middle leg.
  let half = 0;
  for (let i = 0; i < n - 1; i++) {
    half += lenOf(i);
  }
  half /= 2;
  let mid = pts[0];
  for (let i = 0; i < n - 1; i++) {
    const L = lenOf(i);
    if (half <= L) { const u = unit(pts[i], pts[i+1]); mid = { x: pts[i].x + u.x * half, y: pts[i].y + u.y * half }; break; }
    half -= L;
  }
  return { a: pts[0], b: pts[n-1], d, mid, tipTan: tipU, tailTan: tailU, box };
}

// The elbow between two boxes (`to` may be a bare point — the pointer, while a line is being drawn).
// The AXIS is the one the boxes are further apart along: side by side → it leaves a left/right side,
// one above the other → top/bottom. Facing each other across that axis (their spans overlap), it runs
// straight across the middle of the overlap; otherwise it leaves from the middle of one side, turns
// halfway across the gap, and enters the middle of the other — a Z. Two boxes that overlap outright
// have no gap to route through, so they get the plain centre-to-centre line.
function route(ra: Rect, rb: Rect): Pt[] {
  const ca = centre(ra), cb = centre(rb);
  const gapX = Math.max(rb.x - (ra.x + ra.w), ra.x - (rb.x + rb.w));
  const gapY = Math.max(rb.y - (ra.y + ra.h), ra.y - (rb.y + rb.h));
  if (gapX < 0 && gapY < 0) {
    return [rimPoint(ra, cb), rimPoint(rb, ca)];
  }
  if (gapX >= gapY) {
    const right = cb.x > ca.x;
    const ax = right ? ra.x + ra.w : ra.x, bx = right ? rb.x : rb.x + rb.w;
    const lo = Math.max(ra.y, rb.y), hi = Math.min(ra.y + ra.h, rb.y + rb.h);
    if (hi >= lo) { const y = (lo + hi) / 2; return [{ x: ax, y }, { x: bx, y }]; }
    const mx = (ax + bx) / 2;
    return [{ x: ax, y: ca.y }, { x: mx, y: ca.y }, { x: mx, y: cb.y }, { x: bx, y: cb.y }];
  }
  const down = cb.y > ca.y;
  const ay = down ? ra.y + ra.h : ra.y, by = down ? rb.y : rb.y + rb.h;
  const lo = Math.max(ra.x, rb.x), hi = Math.min(ra.x + ra.w, rb.x + rb.w);
  if (hi >= lo) { const x = (lo + hi) / 2; return [{ x, y: ay }, { x, y: by }]; }
  const my = (ay + by) / 2;
  return [{ x: ca.x, y: ay }, { x: ca.x, y: my }, { x: cb.x, y: my }, { x: cb.x, y: by }];
}

// ---------- a line with a PINNED end (dropped on a port) ----------
// Each pinned end leaves its face square, from the face's midpoint; an unpinned end may use whichever
// face routes best. The router tries a handful of orthogonal shapes for every allowed pair of faces —
// straight, one bend, a Z through the middle, and the detours that step out STUB from each face and go
// round either box — keeps those that leave and enter square and cross neither card, and takes the
// shortest, each bend costing BEND_COST. Small enough to run per paint; nothing is stored but the faces.
const DIR: Record<EdgeSide, Pt> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const SIDES: EdgeSide[] = ['up', 'down', 'left', 'right'];
const STUB = 44, BEND_COST = 40;   // a detour clears the card by STUB — room for a round corner and the cap

export function facePoint(r: Rect, s: EdgeSide): Pt {
  return s === 'up' ? { x: r.x + r.w/2, y: r.y } : s === 'down' ? { x: r.x + r.w/2, y: r.y + r.h }
       : s === 'left' ? { x: r.x, y: r.y + r.h/2 } : { x: r.x + r.w, y: r.y + r.h/2 };
}

// Drop repeated points and the middle of three in a row; null if the path doubles back on itself.
export function simplify(pts: Pt[]): Pt[] | null {
  const out: Pt[] = [];
  for (const p of pts) {
    if (!out.length || Math.hypot(p.x - out[out.length-1].x, p.y - out[out.length-1].y) > 0.5) {
      out.push(p);
    }
  }
  for (let i = 1; i < out.length - 1;) {
    const a = out[i-1], b = out[i], c = out[i+1];
    if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) {
      if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) {
        return null;
      }
      out.splice(i, 1);
    } else {
      i++;
    }
  }
  return out.length >= 2 ? out : null;
}

// Does the axis-aligned segment p→q pass through the INSIDE of r (touching its rim is fine)?
export function crosses(p: Pt, q: Pt, r: Rect): boolean {
  if (r.w < 2 || r.h < 2) {
    return false;
  }
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
  return x1 > r.x + 1 && x0 < r.x + r.w - 1 && y1 > r.y + 1 && y0 < r.y + r.h - 1;
}

function pinnedRoute(ra: Rect, sa: EdgeSide | undefined, rb: Rect, sb: EdgeSide | undefined): Pt[] {
  let best: Pt[] | null = null, bestScore = Infinity;
  for (const a of sa ? [sa] : SIDES) {
    for (const b of sb ? [sb] : SIDES) {
      const pa = facePoint(ra, a), pb = facePoint(rb, b), da = DIR[a], db = DIR[b];
      const qa = { x: pa.x + da.x * STUB, y: pa.y + da.y * STUB }, qb = { x: pb.x + db.x * STUB, y: pb.y + db.y * STUB };
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      const xs = [qa.x, qb.x, Math.min(ra.x, rb.x) - STUB, Math.max(ra.x + ra.w, rb.x + rb.w) + STUB];
      const ys = [qa.y, qb.y, Math.min(ra.y, rb.y) - STUB, Math.max(ra.y + ra.h, rb.y + rb.h) + STUB];
      const shapes: Pt[][] = [[pa, pb], [pa, { x: pb.x, y: pa.y }, pb], [pa, { x: pa.x, y: pb.y }, pb],
        [pa, { x: mx, y: pa.y }, { x: mx, y: pb.y }, pb], [pa, { x: pa.x, y: my }, { x: pb.x, y: my }, pb]];
      for (const X of xs) {
        shapes.push([pa, qa, { x: X, y: qa.y }, { x: X, y: qb.y }, qb, pb]);
      }
      for (const Y of ys) {
        shapes.push([pa, qa, { x: qa.x, y: Y }, { x: qb.x, y: Y }, qb, pb]);
      }
      for (const raw of shapes) {
        const pts = simplify(raw);
        if (!pts) {
          continue;
        }
        let ok = true, len = 0;
        for (let i = 0; i < pts.length - 1 && ok; i++) {
          const p = pts[i], q = pts[i+1];
          if (Math.abs(p.x - q.x) > 0.5 && Math.abs(p.y - q.y) > 0.5) {
            ok = false;   // not orthogonal
          } else if (crosses(p, q, ra) || crosses(p, q, rb)) {
            ok = false;
          }
          len += Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
        }
        if (!ok) {
          continue;
        }
        // leaves A along its face's normal, and arrives at B moving INTO it
        const u0 = unit(pts[0], pts[1]), u1 = unit(pts[pts.length-2], pts[pts.length-1]);
        if (u0.x * da.x + u0.y * da.y < 0.99 || u1.x * db.x + u1.y * db.y > -0.99) {
          continue;
        }
        const score = len + (pts.length - 2) * BEND_COST;
        // A tie goes to the shape tried FIRST — the Z through the middle of the gap is listed before the
        // detours, so equal-length routes turn halfway across rather than hugging one card.
        if (score < bestScore - 0.5) { bestScore = score; best = pts; }
      }
    }
  }
  return best ?? [facePoint(ra, sa ?? 'right'), facePoint(rb, sb ?? 'left')];
}

// The route for two boxes and their pins: the plain elbow when neither end is pinned, else the router.
export function routeFor(ra: Rect, sa: EdgeSide | undefined, rb: Rect, sb: EdgeSide | undefined): Pt[] {
  return sa || sb ? pinnedRoute(ra, sa, rb, sb) : route(ra, rb);
}
