// A frame drawn as GOO: one soft bubble around its children (docs/spec-goo-groups.md). The shape is
// a closed spline through the convex hull of the children's padded corners, sampled at fixed angles
// around its centre and drawn as a closed Catmull-Rom curve. Every sample rides a SPRING toward where it should be, so a
// hull that changes — a card joins, leaves, or is dragged about inside — overshoots and settles like
// something wet. Computed on paint from the children's rects, never stored; the frame's box
// (layout.ts fitFrame) pads to the same distance so the rim is what you press to move it.
import { state, hullsSvg, isAnnotation, type MindNode } from '../core/state.js';
import { childrenOf, isHidden, parentOf } from '../utils/model.js';
import { isFrame, isDockedTab } from './layout.js';
import { boxIsViewport } from '../nav/scope.js';
import { nodeW, nodeH, colorFill, effectiveColor, canvasSurface } from '../main.js';
import { inkFor } from '../utils/ink.js';
import { esc } from '../utils/markdown.js';
import { ui } from '../core/ui-state.js';

export const HULL_PAD = 20;   // hull padding around each child (layout's fitFrame pads the box to match)
const PAD = HULL_PAD;
const N = 64;                 // boundary samples per hull, one per angle
const STIFF = 260, DAMP = 18; // per-sample spring: ω≈16/s, ζ≈0.56 → ~12% overshoot, settled in ~½s

type Rect = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
const f1 = (v: number): string => v.toFixed(1);
const P = (p: Pt): string => `${f1(p.x)} ${f1(p.y)}`;

// The ONE proximity rule, read off the cards' EDGES: the distance between two rects, the same all the
// way round (Euclidean, so a corner counts like a side). A card touching a frame's bubble — within
// HULL_PAD of a card inside it — joins; it has to pull a little further clear to leave, so the edge
// doesn't flicker. Two loose cards group at the same distance.
export const JOIN_DIST = HULL_PAD, LEAVE_DIST = HULL_PAD + 20;
const rect = (k: MindNode): Rect => ({ x: k.x, y: k.y, w: nodeW(k), h: nodeH(k) });
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}
export function near(a: MindNode, b: MindNode, dist: number): boolean { return gap(rect(a), rect(b)) <= dist; }
// Is `card` within `dist` of anything ELSE the frame holds? `skip` = the cards riding the same drag.
export function touchesFrame(card: MindNode, f: MindNode, dist: number, skip: Set<string>): boolean {
  return childrenOf(f.id).some(k => k !== card && !skip.has(k.id) && !isHidden(k) && !isAnnotation(k) && near(card, k, dist));
}

// The four corners of every card, pushed out by PAD: the points the bubble is built from.
function cornerPoints(kids: MindNode[]): Pt[] {
  const pts: Pt[] = [];
  for (const k of kids) {
    const x0 = k.x - PAD, y0 = k.y - PAD, x1 = k.x + nodeW(k) + PAD, y1 = k.y + nodeH(k) + PAD;
    pts.push({ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 });
  }
  return pts;
}
// Convex hull (Andrew's monotone chain): the outermost of the points, in order.
function convexHull(pts: Pt[]): Pt[] {
  pts = [...pts].sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
// Drop hull vertices that sit almost on the line between their neighbours: a spline through a run of
// near-collinear points wiggles, and a vertex within COLLINEAR px of the chord is padding anyway.
const COLLINEAR = 8;
function simplify(v: Pt[]): Pt[] {
  for (let changed = true; changed && v.length > 3;) {
    changed = false;
    for (let i = 0; i < v.length && v.length > 3; i++) {
      const a = v[(i - 1 + v.length) % v.length], b = v[i], c = v[(i + 1) % v.length];
      const ex = c.x - a.x, ey = c.y - a.y, len = Math.hypot(ex, ey) || 1;
      if (Math.abs((b.x - a.x) * ey - (b.y - a.y) * ex) / len < COLLINEAR) { v.splice(i, 1); i--; changed = true; }
    }
  }
  return v;
}
// A closed CENTRIPETAL Catmull-Rom spline through the hull's vertices (Barry–Goldman form), densely
// sampled. It passes through every padded corner and bows outward between them, so the bubble is
// round where the hull turns and never cuts into a card; centripetal knots keep a long run next to
// a short edge from overshooting into a loop.
const SPLINE_STEPS = 10, ALPHA = 0.5;
function spline(v: Pt[]): Pt[] {
  const n = v.length;
  if (n < 3) return v;
  const out: Pt[] = [];
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 0; i < n; i++) {
    const p0 = v[(i - 1 + n) % n], p1 = v[i], p2 = v[(i + 1) % n], p3 = v[(i + 2) % n];
    const d = (a: Pt, b: Pt): number => Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y) ** ALPHA);
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let k = 0; k < SPLINE_STEPS; k++) {
      const t = t1 + (t2 - t1) * k / SPLINE_STEPS;
      const a1 = lerp(p0, p1, (t - t0) / (t1 - t0)), a2 = lerp(p1, p2, (t - t1) / (t2 - t1)), a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerp(a1, a2, (t - t0) / (t2 - t0)), b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
      out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  return out;
}
const centre = (pts: Pt[]): Pt => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

// The hull re-sampled at N fixed angles around its centre, so two hulls' points correspond by
// direction and a change morphs instead of swirling.
function sample(hull: Pt[]): Pt[] {
  const c = centre(hull), out: Pt[] = [];
  for (let i = 0; i < N; i++) {
    const a = 2 * Math.PI * i / N, dx = Math.cos(a), dy = Math.sin(a);
    let best = 0;
    for (let j = 0; j < hull.length; j++) {
      const p = hull[j], q = hull[(j + 1) % hull.length];
      const ex = q.x - p.x, ey = q.y - p.y, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((p.x - c.x) * ey - (p.y - c.y) * ex) / den;
      const u = ((p.x - c.x) * dy - (p.y - c.y) * dx) / den;
      if (t > best && u >= -1e-6 && u <= 1 + 1e-6) best = t;
    }
    out.push({ x: c.x + dx * best, y: c.y + dy * best });
  }
  return out;
}

// Closed Catmull-Rom curve through the samples, as cubic Béziers.
function curve(p: Pt[]): string {
  const n = p.length;
  let d = `M ${P(p[0])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    d += ` C ${P({ x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 })} ${P({ x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 })} ${P(p2)}`;
  }
  return d + ' Z';
}

// ---------- the springs ----------
// One per hull, keyed by frame id: `d` is what's drawn, `t` where it should be. A new hull pops out
// of its centre. paintHulls only updates targets and draws; tick() steps the physics between paints.
type Spring = { d: Pt[]; v: Pt[]; t: Pt[] };
const springs = new Map<string, Spring>();
let raf = 0, lastTick = 0;

// `rigid`: the whole frame is in hand, so the drawn shape moves with it as one piece — the springs
// carry only the wobble of a CHANGE in shape, never a lag behind the pointer.
function shape(id: string, target: Pt[], rigid: boolean): Pt[] {
  let s = springs.get(id);
  if (!s) {
    const c = centre(target);
    s = { d: target.map(() => ({ ...c })), v: target.map(() => ({ x: 0, y: 0 })), t: target };
    springs.set(id, s);
  } else {
    if (rigid) {
      const a = centre(s.t), b = centre(target), dx = b.x - a.x, dy = b.y - a.y;
      for (const p of s.d) { p.x += dx; p.y += dy; }
    }
    s.t = target;
  }
  return s.d;
}
function settled(s: Spring): boolean {
  return s.d.every((p, i) => Math.abs(p.x - s.t[i].x) < 0.3 && Math.abs(p.y - s.t[i].y) < 0.3 && Math.abs(s.v[i].x) < 2 && Math.abs(s.v[i].y) < 2);
}
function tick(now: number): void {
  raf = 0;
  const dt = Math.min(0.04, lastTick ? (now - lastTick) / 1000 : 1 / 60);
  lastTick = now;
  for (const s of springs.values()) {
    if (settled(s)) { s.d = s.t.map(p => ({ ...p })); s.v.forEach(v => { v.x = 0; v.y = 0; }); continue; }
    for (let i = 0; i < s.d.length; i++) {
      const d = s.d[i], v = s.v[i], t = s.t[i];
      v.x += ((t.x - d.x) * STIFF - v.x * DAMP) * dt; v.y += ((t.y - d.y) * STIFF - v.y * DAMP) * dt;
      d.x += v.x * dt; d.y += v.y * dt;
    }
  }
  paintHulls();
}

// The children a frame's hull is drawn around — empty when this node draws no hull at all. While a
// drag is poised to drop INTO this frame its cards already count, and one about to rip OUT no longer
// does, so the hull previews the release.
function hullKids(f: MindNode): MindNode[] {
  if (!(isFrame(f) && !isDockedTab(f) && !boxIsViewport(f) && !isHidden(f))) return [];
  let kids = childrenOf(f.id).filter(k => !isHidden(k) && !isAnnotation(k));
  const d = ui.drag;
  if (d?.moved && !d.cloned) {
    if (d.rip) kids = kids.filter(k => !d.targets.has(k.id));
    if (d.dropTarget === f.id && d.dropMode === 'child' && !d.cardMerge)
      for (const id of d.selRoots) { const m = state.nodes.get(id); if (m && !kids.includes(m) && !isAnnotation(m)) kids.push(m); }
  }
  return kids;
}
// Does this node render as a hull rather than a box? Its box chrome (ring, tab, ports) stands down.
export function hasHull(n: MindNode): boolean { return hullKids(n).length > 0; }

function authored(f: MindNode): boolean {
  for (let c: MindNode | null = f; c; c = parentOf(c)) if (c.color && c.color !== 'none') return true;
  return false;
}

export function paintHulls(): void {
  const surface = canvasSurface();
  const neutral = `color-mix(in srgb, ${inkFor(surface)} 9%, ${surface})`;
  const seen = new Set<string>();
  let svg = '';
  const draw = (id: string, kids: MindNode[], wash: string, ring: boolean, label: string, rigid = false): void => {
    seen.add(id);
    const d = curve(shape(id, sample(spline(simplify(convexHull(cornerPoints(kids))))), rigid));
    svg += `${ring ? `<path class="hull-ring" d="${d}"/>` : ''}<path class="hull" style="fill:${wash}" d="${d}"/>${label}`;
  };
  for (const f of state.nodes.values()) {
    const kids = hullKids(f);
    f.el?.classList.toggle('hulled', kids.length > 0);
    if (!kids.length) continue;
    const title = f.title.trim() || f.body.trim().split('\n')[0] || '';
    let label = '';
    if (title) {
      // The title sits in the padding above the top-left child.
      const top = kids.reduce((m, k) => k.y < m.y || (k.y === m.y && k.x < m.x) ? k : m);
      label = `<text class="hull-label" x="${f1(top.x + 2)}" y="${f1(top.y - 6)}">${esc(title)}</text>`;
    }
    const fill = colorFill(effectiveColor(f));
    const wash = fill && authored(f) ? `color-mix(in srgb, ${fill} 42%, ${surface})` : neutral;
    draw(f.id, kids, wash, state.sel.has(f.id), label, !!ui.drag?.targets.has(f.id));
  }
  // Two loose cards about to become a group: the frame they would make, previewed in the neutral wash.
  const dg = ui.drag, nb = dg?.near ? state.nodes.get(dg.near) : null;
  if (dg && nb) draw(`near:${dg.active.id}:${nb.id}`, [dg.active, nb], neutral, false, '');
  hullsSvg.innerHTML = svg;
  for (const id of springs.keys()) if (!seen.has(id)) springs.delete(id);
  const live = [...springs.values()].some(s => !settled(s));
  if (live && !raf) { lastTick = 0; raf = requestAnimationFrame(tick); }
}
