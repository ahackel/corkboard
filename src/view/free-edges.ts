// ---------- free-edge rendering ----------
// The lines the user DREW between cards (core/state.ts BoardEdge). A line says "these two belong
// together" and nothing more (docs/PRODUCT.md). It is drawn as FigJam's ELBOW connector: it leaves
// one card square to a side and enters the other square to a side, turning (with rounded corners) in
// the middle of the gap between them — or runs dead straight when the two cards face each other. It
// stores no side: the route is DERIVED from where the two cards are each time it is painted (`route`),
// so there is nothing on disk to go stale when a card moves.
//
// This module paints three layers, and which is which is the whole of how an edge behaves:
//   · #freeEdges — the lines, ABOVE the cards: a line is something the reader follows, and one that
//     dives under a card in its path loses them exactly where they were tracing it;
//   · #freeEdgeHits — the same lines as invisible 18px CLICK targets, BEHIND the cards, so the
//     stretch of a line that crosses a card is still the card's to press (see HIT_W);
//   · #toggles — the rings and endpoint handles, above every card so they are always grabbable.
import { state, freeEdgesSvg, freeEdgeHitsSvg, togglesSvg, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { clamp } from '../utils/num.js';
import { isHidden, firstVisible, resolveWikilink } from '../utils/model.js';
import { ui, type Pt } from '../core/ui-state.js';
import { screenToWorld } from './camera.js';
import { nodeW, nodeH, colorFill, canvasSurface } from '../main.js';
import { inkFor } from '../utils/ink.js';
import { esc } from '../utils/markdown.js';

// Width of the invisible stroke that takes the clicks. Wider than the visible line because a thin
// target at 50% zoom is a pixel or two — and unlike a card, an edge has no interior to aim at.
export const HIT_W = 18;
export const HANDLE_R = 8;          // endpoint grab handles (FigJam's white disc, thick blue rim), one edge selected
// The four PORTS on a selected card you drag a new line from — FigJam's: a small blue dot in a white
// rim, floating SOCKET_OUT outside each side, that becomes a ⊕ under the pointer (styles.css).
const SOCKET_R = 5, SOCKET_HOVER_R = 11, SOCKET_HIT_R = 13;
const SOCKET_OUT = 18;

// The rectangle a line meets: the node's bounds, grown by half the selection ring (so a line ends ON
// the rim the user reads as the card's edge). A frame's label hangs outside its bounds, so a line meets
// the box it points at, not the label above it.
const RING_MID = 1;
interface Rect { x: number; y: number; w: number; h: number }
function rimRect(n: MindNode): Rect {
  return { x: n.x - RING_MID, y: n.y - RING_MID, w: nodeW(n) + 2*RING_MID, h: nodeH(n) + 2*RING_MID };
}
function centre(n: MindNode | Rect): Pt {
  const r = 'id' in n ? rimRect(n) : n;
  return { x: r.x + r.w/2, y: r.y + r.h/2 };
}
// Where the segment from the box's centre toward `p` leaves its rim. Ray/box: the axis it reaches
// first decides.
function rimPoint(n: MindNode | Rect, p: Pt): Pt {
  const r = 'id' in n ? rimRect(n) : n, c = centre(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  if (!dx && !dy) {
    return c;
  }
  const tx = dx ? (r.w/2) / Math.abs(dx) : Infinity, ty = dy ? (r.h/2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// The four dots on a selected card — only where a NEW line starts from, floating a little OUTSIDE each
// side the way FigJam's do, clear of the resize handles. The finished line doesn't remember which one:
// it is routed from where the two cards are, like every other (`route`).
export function socketPoints(n: MindNode): Array<{ side: EdgeSide; p: Pt }> {
  const r = rimRect(n), o = SOCKET_OUT;
  return [
    { side: 'up',    p: { x: r.x + r.w/2,   y: r.y - o } },
    { side: 'down',  p: { x: r.x + r.w/2,   y: r.y + r.h + o } },
    { side: 'left',  p: { x: r.x - o,       y: r.y + r.h/2 } },
    { side: 'right', p: { x: r.x + r.w + o, y: r.y + r.h/2 } },
  ];
}

// A line stops short of the cards it joins (END_GAP), FigJam-style, so it reads as pointing AT a card
// rather than running under it. It is drawn with round caps and a round-joined head, so the paint
// reaches STROKE_W/2 beyond the geometric tip — an arrow end is pulled back by that overshoot too.
const STROKE_W = 3;                  // must match path.fe / path.fe-arrow in styles.css
const END_GAP = 6;
const ARROW_INSET = STROKE_W / 2;
const trim = (cap: EdgeCap): number => END_GAP + (cap === 'arrow' ? ARROW_INSET : 0);
function unit(p: Pt, q: Pt): Pt {
  const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}
// A path through `pts`, each end pulled in by its own trim along its own leg, as an SVG path plus what
// the caps and the label need. Two points is a straight segment; more is an elbow, its corners rounded
// (CORNER_R, shrunk to fit a short leg) the way FigJam's are.
// `box` bounds the whole route, its UNTRIMMED ends included — what the edge bar keeps clear of.
interface Geometry { a: Pt; b: Pt; d: string; mid: Pt; tipTan: Pt; tailTan: Pt; box: { x0: number; y0: number; x1: number; y1: number } }
const CORNER_R = 24;
// A corner never eats the END legs down to nothing: the cap needs a straight stretch to sit on, or an
// arrowhead lands on the bend and reads as a hook.
const END_STRAIGHT = 16;
function polyline(pts: Pt[], trimA: number, trimB: number): Geometry {
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
function segment(a: Pt, b: Pt, trimA: number, trimB: number): Geometry { return polyline([a, b], trimA, trimB); }

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
function facePoint(r: Rect, s: EdgeSide): Pt {
  return s === 'up' ? { x: r.x + r.w/2, y: r.y } : s === 'down' ? { x: r.x + r.w/2, y: r.y + r.h }
       : s === 'left' ? { x: r.x, y: r.y + r.h/2 } : { x: r.x + r.w, y: r.y + r.h/2 };
}
// Drop repeated points and the middle of three in a row; null if the path doubles back on itself.
function simplify(pts: Pt[]): Pt[] | null {
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
function crosses(p: Pt, q: Pt, r: Rect): boolean {
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
function routeFor(ra: Rect, sa: EdgeSide | undefined, rb: Rect, sb: EdgeSide | undefined): Pt[] {
  return sa || sb ? pinnedRoute(ra, sa, rb, sb) : route(ra, rb);
}
// The ONE place an edge's geometry is computed, so the painter, the label, the bar and the inline
// editor can never disagree about where the line is.
// A line to a card tucked inside a FOLDED frame attaches to that frame's pill instead (firstVisible), and
// its pinned port there is dropped — the pill's faces aren't the card's. Ends the open frame hides map to null.
function edgeEnd(id: string): MindNode | null {
  const n = state.nodes.get(id);
  if (!n) {
    return null;
  }
  const v = firstVisible(n);
  return isHidden(v) ? null : v;
}
export function edgeGeometry(e: BoardEdge): Geometry | null {
  const from = edgeEnd(e.from), to = edgeEnd(e.to);
  if (!from || !to) {
    return null;
  }
  const pa = from.id === e.from ? e.fromPort : undefined, pb = to.id === e.to ? e.toPort : undefined;
  return polyline(routeFor(rimRect(from), pa, rimRect(to), pb), trim(e.fromCap), trim(e.toCap));
}
// The port under a world point, if any: within PORT_SNAP screen px of a card's floating port dot OR of
// the middle of that face — what a line end dropped there pins to (features/edge-tools.ts).
const PORT_SNAP = 16;
export function portAt(n: MindNode, p: Pt): EdgeSide | null {
  const k = state.view.k || 1, r = rimRect(n);
  let best: EdgeSide | null = null, bestD = PORT_SNAP / k;
  for (const { side, p: dot } of socketPoints(n)) {
    const face = facePoint(r, side);
    const d = Math.min(Math.hypot(p.x - dot.x, p.y - dot.y), Math.hypot(p.x - face.x, p.y - face.y));
    if (d < bestD) { bestD = d; best = side; }
  }
  return best;
}

// An OPEN head — two strokes from the tip back to the corners, not a filled triangle: at the line's
// own weight it looks like the same pen drew it. Wide and shallow rather than a long thin dart.
const ARROW_LEN = 11;    // tip → base, along the line
const ARROW_W = 22;      // corner → corner, across it
function arrowHead(tip: Pt, dir: Pt, ink: string): string {
  const nx = -dir.y, ny = dir.x;
  const bx = tip.x - dir.x * ARROW_LEN, by = tip.y - dir.y * ARROW_LEN;
  const x1 = bx + nx * ARROW_W * 0.5, y1 = by + ny * ARROW_W * 0.5;
  const x2 = bx - nx * ARROW_W * 0.5, y2 = by - ny * ARROW_W * 0.5;
  return `<path class="fe-arrow" style="stroke:${ink}" d="M ${x1} ${y1} L ${tip.x} ${tip.y} L ${x2} ${y2}"/>`;
}
// The other terminator: a filled disc ON the rim — "attaches here", with no direction claimed.
const DOT_R = ARROW_W * 0.28;
function capDot(at: Pt, ink: string): string {
  return `<circle class="fe-dot" style="fill:${ink}" cx="${at.x}" cy="${at.y}" r="${DOT_R}"/>`;
}
// `dir` points INTO that end, which is what an arrowhead there needs; a dot ignores it.
function endCap(cap: EdgeCap, at: Pt, dir: Pt, ink: string): string {
  return cap === 'arrow' ? arrowHead(at, dir, ink) : cap === 'dot' ? capDot(at, ink) : '';
}

// Whether a card can be a line's end at all: one that exists.
export function connectable(id: string): boolean {
  return state.nodes.has(id);
}
// An edge is drawn when both ENDS are on the canvas — a card itself, or the folded frame standing in for
// it (edgeEnd) — and they aren't the same pill: a line between two cards of one folded frame goes with them.
export function edgeVisible(e: BoardEdge): boolean {
  const a = edgeEnd(e.from), b = edgeEnd(e.to);
  return !!a && !!b && a !== b;
}

// ---------- the links a card holds, drawn ----------
// A selected card's [[wikilinks]] ARE relations, and while that card is selected they are shown as
// lines. They are not drawn edges: nothing stores them and nothing selects them, so they wear a
// deliberately different pen — white and dotted, a DOT where the link is, an ARROW on the card it names.
// Each leaves the card's rim level with its own link text (read off the rendered anchor), so a card
// with four links sends four lines you can tell apart.
const LINK_INK = '#fff';
function linkEdges(n: MindNode): string {
  const links = n.el?.querySelectorAll<HTMLElement>('a.wikilink');
  if (!links?.length) {
    return '';
  }
  let out = '';
  for (const a of links) {
    const target = resolveWikilink(a.dataset.target ?? '')[0];
    if (!target || target.id === n.id || isHidden(target) || !connectable(target.id)) {
      continue;
    }
    const r = a.getBoundingClientRect();
    if (!r.width) {
      continue;
    }
    const p1 = screenToWorld(r.left, r.top), p2 = screenToWorld(r.right, r.bottom);
    const y = clamp((p1.y + p2.y) / 2, n.y, n.y + nodeH(n));
    const toRight = centre(target).x >= (p1.x + p2.x) / 2;
    const from = { x: toRight ? n.x + nodeW(n) : n.x, y };
    const s = segment(from, rimPoint(target, from), 0, ARROW_INSET);
    out += `<path class="fe" style="stroke:${LINK_INK}" stroke-dasharray="1 7" d="${s.d}"/>`
         + endCap('arrow', s.b, s.tipTan, LINK_INK) + capDot(s.a, LINK_INK);
  }
  return out;
}

export function paintFreeEdges(): void {
  // Searching hides every line: dimmed cards are translucent, so lines behind them read as clutter.
  if (state.searchMatch){ freeEdgesSvg.innerHTML = ''; freeEdgeHitsSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '', hits = '', tools = '';
  // A label is a small patch of the CANVAS laid over the line, so its ink is derived from the canvas
  // fill (inkFor).
  const plate = canvasSurface(), labelInk = inkFor(plate);
  // The edge whose end is being moved is not drawn in its OLD place — the draft below IS that edge.
  const moving = ui.edgeDraw?.edgeId;
  for (const e of state.edges) {
    if (e.id === moving || !edgeVisible(e)) {
      continue;
    }
    const g = edgeGeometry(e);
    if (!g) {
      continue;
    }
    const ink = colorFill(e.color) ?? 'var(--edge)';
    const sel = state.selEdges.has(e.id);
    const dash = e.dashed ? ' stroke-dasharray="7 6"' : '';
    hits += `<path class="fe-hit" data-edge="${e.id}" d="${g.d}" stroke-width="${HIT_W}"/>`;
    // The selection ring, in the same language a card's is: the same line drawn thicker and SOLID
    // underneath, so a selected edge reads as outlined rather than merely recoloured.
    // With ONE edge selected its two end handles say so (FigJam); a multi-selection has no handles, so
    // there each line wears the ring instead.
    if (sel && state.selEdges.size > 1) {
      svg += `<path class="fe-selring" d="${g.d}"/>`;
    }
    svg += `<path class="fe" style="stroke:${ink}"${dash} d="${g.d}"/>`;
    svg += endCap(e.toCap, g.b, g.tipTan, ink) + endCap(e.fromCap, g.a, g.tailTan, ink);
    // The label sits ON the line at its midpoint, on a plate so the line doesn't strike it through.
    // Width is estimated from the character count: a real measurement would cost a layout flush per
    // edge per frame.
    if (e.label) {
      const w = e.label.length * 8 + 12, h = 19;
      svg += `<rect class="fe-label-plate" style="fill:${plate}" x="${g.mid.x - w/2}" y="${g.mid.y - h/2}" width="${w}" height="${h}" rx="4"/>`
           + `<text class="fe-label" style="fill:${labelInk}" x="${g.mid.x}" y="${g.mid.y}">${esc(e.label)}</text>`;
    }
    // Handles to move either end onto another card — only when ONE edge is selected, since on a
    // multi-selection they'd be identical dots with no way to tell which line each belongs to.
    if (sel && state.selEdges.size === 1) {
      // ON the card's rim where the line attaches — the drawn ends stop END_GAP short of it, so step
      // each back along its own tangent by the trim it was given.
      const ta = trim(e.fromCap), tb = trim(e.toCap);
      const ha = { x: g.a.x + g.tailTan.x * ta, y: g.a.y + g.tailTan.y * ta };
      const hb = { x: g.b.x + g.tipTan.x * tb, y: g.b.y + g.tipTan.y * tb };
      tools += `<circle class="fe-handle" data-handle="from" data-edge="${e.id}" cx="${ha.x}" cy="${ha.y}" r="${HANDLE_R}"/>`;
      tools += `<circle class="fe-handle" data-handle="to" data-edge="${e.id}" cx="${hb.x}" cy="${hb.y}" r="${HANDLE_R}"/>`;
    }
  }
  // The four rings on the selected card. On SELECTION, never on hover: a ring that only appears once
  // you've said which card you mean can't be hit by accident while you drag past.
  const one = state.sel.size === 1 ? state.nodes.get(state.selId ?? '') : null;
  if (one && !isHidden(one)) {
    svg += linkEdges(one);
  }
  if (one && connectable(one.id) && !state.selEdges.size && !ui.drag && !isHidden(one)) {
    for (const { side, p } of socketPoints(one)) {
      tools += `<g class="fe-socket" data-socket="${side}" data-node="${one.id}">`
        + `<circle class="fe-port-hit" cx="${p.x}" cy="${p.y}" r="${SOCKET_HIT_R}"/>`
        + `<circle class="fe-port-dot" cx="${p.x}" cy="${p.y}" r="${SOCKET_R}"/>`
        + `<g class="fe-port-plus"><circle cx="${p.x}" cy="${p.y}" r="${SOCKET_HOVER_R}"/>`
        + `<path d="M ${p.x - 5} ${p.y} H ${p.x + 5} M ${p.x} ${p.y - 5} V ${p.y + 5}"/></g></g>`;
    }
  }
  // The edge being drawn right now, in its FINAL style and route: from the fixed card to the pointer,
  // or — once the pointer is over a card — all the way to that card, exactly where it will land.
  const draw = ui.edgeDraw;
  const src = draw ? state.nodes.get(draw.sourceId) : null;
  if (draw && src) {
    const over = draw.overId ? state.nodes.get(draw.overId) : null;
    if (over) {
      const r = rimRect(over);
      tools += `<rect class="fe-target" x="${r.x - 4}" y="${r.y - 4}" width="${r.w + 8}" height="${r.h + 8}" rx="12"/>`;
      // the target's ports, the one the end would pin to drawn as FigJam's filled blue dot
      for (const { side, p } of socketPoints(over)) {
        tools += `<circle class="fe-drop-port${side === draw.overSide ? ' on' : ''}" cx="${p.x}" cy="${p.y}" r="${side === draw.overSide ? SOCKET_HOVER_R - 3 : SOCKET_R}"/>`;
      }
    }
    const edge = draw.edgeId ? state.edges.find(x => x.id === draw.edgeId) : null;
    const ink = colorFill(edge?.color ?? '') ?? 'var(--edge)';
    // The draft runs from the end that STAYS to the end being moved, so when it's the `from` end that
    // moves, the edge's caps are read the other way round. A fresh edge has makeEdge's defaults.
    const movingFrom = draw.end === 'from';
    const anchorCap: EdgeCap = edge ? (movingFrom ? edge.toCap : edge.fromCap) : 'none';
    const movingCap: EdgeCap = edge ? (movingFrom ? edge.fromCap : edge.toCap) : 'arrow';
    const anchorPort = edge ? (movingFrom ? edge.toPort : edge.fromPort) : draw.side;
    const s = polyline(routeFor(rimRect(src), anchorPort, over ? rimRect(over) : { ...draw.to, w: 0, h: 0 }, over ? draw.overSide : undefined), trim(anchorCap),
      over ? trim(movingCap) : movingCap === 'arrow' ? ARROW_INSET : 0);
    svg += `<path class="fe" style="stroke:${ink}"${edge?.dashed ? ' stroke-dasharray="7 6"' : ''} d="${s.d}"/>`
         + endCap(movingCap, s.b, s.tipTan, ink) + endCap(anchorCap, s.a, s.tailTan, ink);
  }
  freeEdgesSvg.innerHTML = svg;
  freeEdgeHitsSvg.innerHTML = hits;
  togglesSvg.innerHTML = tools;
}
