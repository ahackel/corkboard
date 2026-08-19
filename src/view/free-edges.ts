// ---------- free-edge rendering ----------
// The edges the user DREW (core/state.ts BoardEdge), as opposed to view/edges.ts's connectors, which
// are derived from `parent` and are structure. The two are deliberately different SHAPES so nobody
// has to be told which is which: a parent connector is a solid, branch-tinted orthogonal elbow that
// converges on a shared side socket; a free edge is a thin bowed curve with an arrowhead, in its own
// colour, that meets each card's border wherever the line happens to arrive.
//
// This module paints three layers, and which is which is the whole of how an edge behaves:
//   · #freeEdges — the curves, ABOVE the cards: a line is something the reader follows, and one that
//     dives under a card in its path loses them exactly where they were tracing it;
//   · #freeEdgeHits — the same curves as invisible 18px CLICK targets, BEHIND the cards, so the
//     stretch of a line that crosses a card is still the card's to press (see HIT_W);
//   · #toggles — the ports and endpoint handles, BETWEEN the two: above every card, so a ring shows on
//     whatever it is fitted to, and under the lines, so an edge runs onto its port rather than ending
//     at the ring drawn over it.
import { state, freeEdgesSvg, freeEdgeHitsSvg, togglesSvg, type BoardEdge, type EdgeCap, type EdgeSide, type Junction, type MindNode } from '../core/state.js';
import { junctionOf } from '../data/board.js';
import { clamp } from '../utils/num.js';
import { isHidden } from '../utils/model.js';
import { isStack, insideStack, isDockedTab } from './layout.js';
import { ui, type Pt } from '../core/ui-state.js';
import { nodeW, nodeH, colorFill, elTop, canvasSurface, snapPt } from '../main.js';
import { inkFor } from '../utils/ink.js';
import { esc } from '../utils/markdown.js';

// Half-width of the invisible stroke that takes the clicks. Wider than the visible 2px line because
// a 2px target at 50% zoom is 1 screen pixel — and unlike a card, an edge has no interior to aim at.
// It rides its own layer BEHIND the cards for that reason: 18 world px of invisible stroke drawn OVER
// a card would take that card's own press wherever a line crossed it.
export const HIT_W = 18;
export const HANDLE_R = 7;          // endpoint grab handles, shown while an edge is selected
export const SOCKET_R = 6;          // the four rings on a selected card you drag a new edge from

// WHICH faces a given node offers, and the ONE place that question is answered — socketPoints (the
// rings), portPoint (where a line docks) and nearestSide (what a drop picks) all read it, so a ring,
// its line and the side chosen for it can never disagree. Not every kind carries all four: a shape
// whose own layout already speaks along one axis keeps only the faces that don't contradict it.
//   · a DOCKED TAB is a label in a strip, with its siblings pressed against it left and right and its
//     own box below — the top of the pill is the only face that is free to be pointed at;
//   · an OUTLINE ROW is a full-width band in a column, stacked directly on the rows above and below,
//     so up/down would leave a port buried in the neighbouring row: it takes left and right;
//   · a STACK, being that column, is entered and left along it — top and bottom.
// Everything else keeps the full set.
const ALL_SIDES: EdgeSide[] = ['up', 'down', 'left', 'right'];
export function portSides(n: MindNode): EdgeSide[] {
  if (isDockedTab(n)) return ['up'];
  if (insideStack(n)) return ['left', 'right'];
  if (isStack(n)) return ['up', 'down'];
  return ALL_SIDES;
}
// The face an edge stored on `side` actually docks to NOW. A node's kind (and so its port set) can
// change under an edge that was already drawn — dock a frame as a tab, drop a card into an outline —
// and this keeps every line on a face that still exists rather than on the memory of one: the stored
// side if it survives, else its opposite, else whatever the node does offer. Nothing is written back;
// the edge keeps the side it was drawn with and comes back with it if the node leaves the container.
export function resolveSide(n: MindNode, side: EdgeSide): EdgeSide {
  const sides = portSides(n);
  if (sides.includes(side)) return side;
  return sides.includes(OPPOSITE[side]) ? OPPOSITE[side] : sides[0];
}

// The points on a card's border a free edge can leave from: the centre of each face it offers. Same
// anchors the derived connectors use, which is deliberate — one visual vocabulary for "an edge meets
// a card here".
export function socketPoints(n: MindNode): { side: EdgeSide; p: Pt }[] {
  return portSides(n).map(side => ({ side, p: portPoint(n, side) }));
}

// How far OUTSIDE a node's bounds the SELECTION RING's centre line runs — the line a port must sit on,
// since the ring is what the user reads as the card's edge (the port is a fitting ON that rim, and one
// drawn a ring-width inside it looks like it missed). Every ring in styles.css is 2px wide and drawn
// OUTSIDE the border box, so its centre is half its width out:
//   · `.node.sel` — box-shadow 0 0 0 2px, i.e. the band [0,2] outside → +1, and that's every card,
//     every frame BOX and a folded frame's pill;
//   · an OPEN docked tab — its own ::before ring, inset -4px with a 2px border → the band [4,6] → +5;
//   · a CLOSED docked tab — the same ::before at inset -2px → the band [2,4] → +3.
// A frame's own title tab has a ring of its own too (inset -2px), but no port sits on it: a frame's
// ports are on its BOX (portRect below drops the tab from the rect), whose ring is the plain +1.
const RING_MID = 1;
function ringMid(n: MindNode): number {
  if (isDockedTab(n)) return n.collapsed ? 3 : 5;
  return RING_MID;
}

// The rectangle the ports sit on: the selection ring's centre line, all the way round (ringMid). Or,
// put the other way, a node's bounds grown by half a ring — EXCEPT for a frame with a title tab: its
// bounds include that tab, which is a separate shape hanging above the box (elTop / FRAME_TAB_DROP),
// so a port on the bounds' top edge would sit up on the tab — or in the empty gap beside it — rather
// than on the box the edge is pointing at. elTop shifts nothing for everything else, a FOLDED frame
// and a docked tab included: there the tab IS the body. Same reasoning as the annotation tethers'
// anchor (view/edges.ts), and the one place the port geometry is spelled — portPoint, socketPoints
// and nearestSide all read it, so a port, its ring and the side a drop picks can't disagree.
function portRect(n: MindNode): { x: number; y: number; w: number; h: number } {
  const top = elTop(n, n.y);
  const m = ringMid(n);
  return { x: n.x - m, y: top - m, w: nodeW(n) + 2*m, h: (n.y + nodeH(n) - top) + 2*m };
}

// The point an edge docks at on one face — the face's CENTRE, the same anchor the socket rings sit
// on, so a line always meets a card exactly where the ring that made it was.
export function portPoint(n: MindNode, side: EdgeSide): Pt {
  const r = portRect(n);
  side = resolveSide(n, side);
  if (side === 'up')    return { x: r.x + r.w/2, y: r.y };
  if (side === 'down')  return { x: r.x + r.w/2, y: r.y + r.h };
  if (side === 'left')  return { x: r.x,         y: r.y + r.h/2 };
  return { x: r.x + r.w, y: r.y + r.h/2 };
}
const NORMAL: Record<EdgeSide, Pt> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};
// Which face of `n` a point is nearest, by the DOMINANT axis of the offset scaled by the card's own
// proportions — comparing fractions of the card's size rather than raw pixels, so a wide short card
// doesn't read as "left/right" from everywhere. Used only when a port is being CHOSEN (a drop, a
// backfill); never to re-derive one that already exists.
export function nearestSide(n: MindNode, p: Pt): EdgeSide {
  const r = portRect(n);
  const w = r.w || 1, h = r.h || 1;
  const dx = p.x - (r.x + w/2), dy = p.y - (r.y + h/2);
  const want: EdgeSide = Math.abs(dx) / w >= Math.abs(dy) / h ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
  // …then onto a face this node actually offers: the nearest side of a card that has only two is one
  // of those two, never the one the geometry alone would have picked.
  return resolveSide(n, want);
}
// The two facing ports for a pair of cards, for an edge that hasn't chosen yet (⌘L, or the backfill
// of an edge stored before ports were).
export function facingSides(a: MindNode, b: MindNode): { from: EdgeSide; to: EdgeSide } {
  const ca = { x: a.x + nodeW(a)/2, y: a.y + nodeH(a)/2 };
  const cb = { x: b.x + nodeW(b)/2, y: b.y + nodeH(b)/2 };
  const from = nearestSide(a, cb);
  // The facing port, except on a card that doesn't offer it (portSides) — there the line takes the
  // face of `b` that points back at `a` instead, which is the same intent expressed in what it has.
  const to = resolveSide(b, OPPOSITE[from]);
  return { from, to };
}
export const OPPOSITE: Record<EdgeSide, EdgeSide> = { up: 'down', down: 'up', left: 'right', right: 'left' };

// How far a line runs straight out of a port before it is allowed to turn. Without it an edge
// leaving a card's right face could immediately bend back across the card it just left.
const STUB = 28;
// …but only when there IS that much room. A fixed stub longer than the gap it has to cross makes the
// two stub ends overshoot each other, and then EVERY candidate route below doubles back — so the
// no-reversal search fell through to its last resort, which sends the line out and around in a
// rectangular detour. That is the loop a short edge used to turn into. Half the distance the other end
// lies AHEAD of this one is the most a stub may take: at exactly half, two ports facing each other
// meet in the middle and the route collapses to the straight line it always wanted to be. An end the
// other one sits behind keeps the full stub — it has to come out and go round, and there is no
// overshoot to cause.
function stubFor(from: Pt, normal: Pt, other: Pt): number {
  const ahead = (other.x - from.x) * normal.x + (other.y - from.y) * normal.y;
  return ahead > 0 ? Math.min(STUB, ahead / 2) : STUB;
}
const CORNER = 44;   // how round an elbow gets — clamped per corner to half its shortest leg

// polyline → path `d` with ROUND corners: a cubic at each interior vertex whose handles sit 55% of
// the way back toward the vertex, which is what makes the bend read as an arc rather than the flat
// pinch a quadratic gives. One radius per corner (the smaller of the two legs' halves), so the curve
// comes in and leaves at the same distance — an asymmetric pair kinks.
function roundedPath(pts: Pt[], r: number): string {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
  const K = 0.55;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], prev = pts[i-1], next = pts[i+1];
    const lp = Math.hypot(p.x-prev.x, p.y-prev.y), ln = Math.hypot(p.x-next.x, p.y-next.y);
    const rad = Math.min(r, lp/2, ln/2);
    const toward = (q: Pt): Pt => {
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
      return { x: p.x + dx/L*rad, y: p.y + dy/L*rad };
    };
    const e1 = toward(prev), e2 = toward(next);
    const h1 = { x: e1.x + (p.x - e1.x) * K, y: e1.y + (p.y - e1.y) * K };
    const h2 = { x: e2.x + (p.x - e2.x) * K, y: e2.y + (p.y - e2.y) * K };
    d += ` L ${e1.x} ${e1.y} C ${h1.x} ${h1.y} ${h2.x} ${h2.y} ${e2.x} ${e2.y}`;
  }
  const last = pts[pts.length-1];
  return d + ` L ${last.x} ${last.y}`;
}

// The route between two docked ports, as a POLYLINE — which is what lets everything downstream agree
// with the drawing: the arrowheads take their direction from its last/first leg, and the label and
// the edge bar sit at its midpoint BY ARC LENGTH rather than at some separately-guessed point.
//
// There is ONE shape, and the reason is the ports: once a line leaves a named face it has a
// direction to respect, and right angles are what make "this leaves the right side and enters the
// top" legible. The corners are drawn generously round, so the route stays orthogonal in what it
// SAYS while looking hand-drawn rather than plotted.
export function routeFor(a: Pt, aSide: EdgeSide, b: Pt, bSide: EdgeSide): { d: string; pts: Pt[]; mid?: Pt } {
  const na = NORMAL[aSide], nb = NORMAL[bSide];
  const sa = stubFor(a, na, b), sb = stubFor(b, nb, a);
  const a1 = { x: a.x + na.x * sa, y: a.y + na.y * sa };
  const b1 = { x: b.x + nb.x * sb, y: b.y + nb.y * sb };
  // Prefer an L — ONE turn — whenever the two ports can be joined by one: the corner at (b.x, a.y)
  // or (a.x, b.y) is the only bend, and the line arrives at each port already travelling along that
  // port's normal. Only possible when the two ports face different AXES (two ports on the same axis
  // always need a dog-leg), and only when the corner lies far enough AHEAD of both — a leg shorter
  // than the stub would put the bend right against a card's face, which reads worse than the Z.
  const horizA = aSide === 'left' || aSide === 'right';
  const horizB = bSide === 'left' || bSide === 'right';
  if (horizA !== horizB) {
    const corner = horizA ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const outA = (corner.x - a.x) * na.x + (corner.y - a.y) * na.y;
    const intoB = (corner.x - b.x) * nb.x + (corner.y - b.y) * nb.y;
    if (outA >= sa && intoB >= sb) return { d: roundedPath([a, corner, b], CORNER), pts: [a, corner, b] };
  }
  // Otherwise the two stub ends have to be joined, and there is more than one way to do it. Every
  // candidate below leaves `a` along its normal and enters `b` along its own, so they differ only in
  // the corridor between — but most of them DOUBLE BACK for some pair of ports, and a line that
  // turns 180° onto itself reads as broken however prettily the corner is rounded. So: list them
  // best-looking first, and take the first one that never reverses. The last two run the corridor
  // clear PAST both stubs, which is the only shape that works for two ports facing the same way on
  // the same line — every shorter route there has to come back on itself.
  const mx = (a1.x + b1.x) / 2, my = (a1.y + b1.y) / 2;
  const outx = a1.x < b1.x ? Math.min(a1.x, b1.x) - STUB : Math.max(a1.x, b1.x) + STUB;
  const outy = a1.y < b1.y ? Math.min(a1.y, b1.y) - STUB : Math.max(a1.y, b1.y) + STUB;
  const zx = (x: number): Pt[] => [a, a1, { x, y: a1.y }, { x, y: b1.y }, b1, b];
  const zy = (y: number): Pt[] => [a, a1, { x: a1.x, y }, { x: b1.x, y }, b1, b];
  const candidates: Pt[][] = horizA
    ? [zx(mx), [a, a1, { x: b1.x, y: a1.y }, b1, b], zy(my), [a, a1, { x: a1.x, y: b1.y }, b1, b], zx(outx), zy(outy)]
    : [zy(my), [a, a1, { x: a1.x, y: b1.y }, b1, b], zx(mx), [a, a1, { x: b1.x, y: a1.y }, b1, b], zy(outy), zx(outx)];
  const clean = candidates.map(dedupe).find(noReversal) ?? dedupe(candidates[candidates.length - 1]);
  return { d: roundedPath(clean, CORNER), pts: clean };
}
// Drop any zero-length leg, so a straight run doesn't pick up a phantom corner — and so the
// reversal test below sees the route's real turns rather than a degenerate vertex.
function dedupe(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i-1].x, p.y - pts[i-1].y) > 0.5);
}
// Does the polyline ever turn back on itself? Anything past a right angle counts: at exactly 90° the
// dot of two consecutive leg directions is 0, and only a fold makes it negative.
function noReversal(pts: Pt[]): boolean {
  for (let i = 2; i < pts.length; i++) {
    const d1 = legDir(pts[i-2], pts[i-1]), d2 = legDir(pts[i-1], pts[i]);
    if (d1.x * d2.x + d1.y * d2.y < -0.01) return false;
  }
  return true;
}
// The point half way ALONG a polyline, plus the direction of the leg it falls on.
function midOfPolyline(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
  let want = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    if (want <= L) {
      const t = L ? want / L : 0;
      return { x: pts[i-1].x + (pts[i].x - pts[i-1].x) * t, y: pts[i-1].y + (pts[i].y - pts[i-1].y) * t };
    }
    want -= L;
  }
  return pts[pts.length - 1];
}
// Unit direction of the last leg (pointing INTO the target) and of the first (pointing out of the
// source) — the two arrowheads' orientations.
function legDir(p: Pt, q: Pt): Pt {
  const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}

// An OPEN head — two strokes from the tip back to the corners, not a filled triangle: at the line's
// own weight it looks like the same pen drew it, because it is the same stroke.
// The two axes are separate on purpose. WIDTH is what makes a head readable at a glance; LENGTH past
// a certain point just makes it look like a dart. Half as long as it is wide gives a wide, shallow
// chevron rather than a long thin spike.
const ARROW_LEN = 9;     // tip → base, along the line
const ARROW_W = 18;      // corner → corner, across it
// The line runs ALL THE WAY TO THE TIP. With a filled head it had to stop at the head's centre or it
// poked out through the point; an open head has no interior to poke out of, and the shaft meeting
// the tip is what makes the two read as one arrow instead of a line near a chevron.
function arrowHead(tip: Pt, dir: Pt, ink: string): string {
  const nx = -dir.y, ny = dir.x;                                 // normal to the direction of travel
  const bx = tip.x - dir.x * ARROW_LEN, by = tip.y - dir.y * ARROW_LEN;
  const x1 = bx + nx * ARROW_W * 0.5, y1 = by + ny * ARROW_W * 0.5;
  const x2 = bx - nx * ARROW_W * 0.5, y2 = by - ny * ARROW_W * 0.5;
  // One open V: corner → tip → corner, so the join at the tip is a single mitre the renderer rounds
  // off, rather than two strokes meeting at a seam.
  return `<path class="fe-arrow" style="stroke:${ink}" d="M ${x1} ${y1} L ${tip.x} ${tip.y} L ${x2} ${y2}"/>`;
}
// The other terminator: a filled disc ON the port. It says "this end attaches HERE" without claiming
// a direction, which is the whole reason it exists beside the arrow. Sized off the arrow's width so
// the two read as one set.
const DOT_R = ARROW_W * 0.28;
function capDot(at: Pt, ink: string): string {
  return `<circle class="fe-dot" style="fill:${ink}" cx="${at.x}" cy="${at.y}" r="${DOT_R}"/>`;
}
// One end's terminator, whichever it wears. `dir` points INTO that end, which is what an arrowhead
// there needs; a dot ignores it.
function endCap(cap: EdgeCap, at: Pt, dir: Pt, ink: string): string {
  return cap === 'arrow' ? arrowHead(at, dir, ink) : cap === 'dot' ? capDot(at, ink) : '';
}

// The nearest point ON a polyline to p, and how far away it is. Used to ask "is the pointer on this
// edge?" and, when it is, to put the junction exactly ON the line rather than wherever inside the hit
// band the pointer happened to be — a dot a few px off its own line reads as a mistake.
export function nearestOnPolyline(pts: Pt[], p: Pt): { d: number; at: Pt } {
  let best = { d: Infinity, at: pts[0] ?? p };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i+1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy;
    const t = len2 ? clamp(((p.x - a.x)*dx + (p.y - a.y)*dy) / len2, 0, 1) : 0;
    const at = { x: a.x + t*dx, y: a.y + t*dy };
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d < best.d) best = { d, at };
  }
  return best;
}

// ---------- endpoints: a card's port, or a JUNCTION ----------
// An edge end holds an id, and that id names either a node or a junction (core/state.ts Junction).
// These three are the whole of the difference, and every consumer goes through them rather than
// reaching for state.nodes: a junction has no rect, no faces and no file, so a line docks AT it
// rather than on a face of it.
// What an endpoint id names: a node, a junction, or nothing. THE one place the duality is decided —
// nodes FIRST, because state.nodes is a Map and the vast majority of ends are cards, where the junction
// list would otherwise be scanned end to end for every one of them, several times per edge per paint.
type End = { n: MindNode; j?: undefined } | { j: Junction; n?: undefined };
export function endOf(id: string): End | null {
  const n = state.nodes.get(id);
  if (n) return { n };
  const j = junctionOf(id);
  return j ? { j } : null;
}
// Where the end sits. A port is the centre of the face the edge stored; a junction IS the point.
export function endPoint(id: string, side: EdgeSide): Pt | null {
  const e = endOf(id);
  return !e ? null : e.j ? { x: e.j.x, y: e.j.y } : portPoint(e.n, side);
}
// Which direction the route leaves that end by. A card's is STORED (core/state.ts EdgeSide) so the
// line keeps the face it was drawn on; a junction's is derived from where the other end is, every
// paint. Nothing slides when it changes: the dock point is the point either way, and only the
// direction of the first STUB depends on it — so a bare dot always sends its line the sensible way
// round as the far end moves, rather than remembering a face it doesn't have.
export function endSide(id: string, stored: EdgeSide, other: Pt): EdgeSide {
  const e = endOf(id);
  if (!e) return stored;
  return e.j ? sideToward({ x: e.j.x, y: e.j.y }, other) : resolveSide(e.n, stored);
}
// The dominant axis from one point to another, as a face.
function sideToward(from: Pt, to: Pt): EdgeSide {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
}

// Both ends of an edge and the whole geometry around them. ONE place, so the painter, the label, the
// bar and the inline editor can never disagree about where the line is — or about what it ends on.
function edgeEnds(e: BoardEdge): { a: Pt; b: Pt; aSide: EdgeSide; bSide: EdgeSide } | null {
  // The POINTS first: neither depends on the other end, so this terminates even when both ends are
  // junctions (whose sides do).
  const a = endPoint(e.from, e.fromSide), b = endPoint(e.to, e.toSide);
  if (!a || !b) return null;
  return { a, b, aSide: endSide(e.from, e.fromSide, b), bSide: endSide(e.to, e.toSide, a) };
}
export function edgeGeometry(e: BoardEdge): { a: Pt; b: Pt; d: string; pts: Pt[]; mid: Pt; tipTan: Pt; tailTan: Pt } | null {
  const ends = edgeEnds(e); if (!ends) return null;
  const { a, b, aSide, bSide } = ends;
  const { d, pts, mid } = routeFor(a, aSide, b, bSide);
  return {
    a, b, d, pts,
    // Halfway ALONG the route as it is actually drawn — the polyline's arc-length midpoint. The
    // label, the bar and the inline editor all hang off this one point.
    mid: mid ?? midOfPolyline(pts),
    tipTan: legDir(pts[pts.length - 2] ?? a, pts[pts.length - 1] ?? b),
    tailTan: legDir(pts[1] ?? b, pts[0] ?? a),
  };
}

// An edge is drawn only when BOTH ends are visible — the same one gate everything else asks
// (utils/model.ts isHidden: a collapsed ancestor, or the open-frame scope). An edge whose other end
// is inside a collapsed branch simply isn't there; nothing counts it, and the hidden-count chip on a
// card keeps counting CARDS, which is the only thing a reader can go looking for.
// Whether a node can be a free edge's endpoint at all. An ANNOTATION cannot: it is a note pinned to
// one card and its single dashed tether to that card (view/edges.ts) is the whole of what it says.
// Giving it ports as well would offer two different ways to attach the same sticky note, one of them
// structural and one not — the exact confusion the containment model exists to remove. So an
// annotation shows no rings, refuses a drop, and any edge already touching one stays hidden.
export function connectable(id: string): boolean {
  const e = endOf(id);
  return !!e && (!!e.j || e.n.type !== 'annotation');   // a meeting point is nothing BUT somewhere to end
}
// Whether a junction is on screen — DERIVED from the edges', not a second gate of its own: a point is
// only ever the place some lines meet, so it is visible exactly while one of them is (a collapsed
// ancestor or the open-frame scope can hide all three, and an orphan dot with no lines would still have
// been grabbable). Also what the drop's own snapper asks, so the targets are exactly the painted set.
export function junctionShown(id: string): boolean {
  return state.edges.some(e => (e.from === id || e.to === id) && edgeVisible(e));
}
export function edgeVisible(e: BoardEdge): boolean {
  // An annotation is never a free edge's endpoint (connectable, just above), so an edge that
  // touches one is a leftover — from before that rule, or from a card RETYPED into an annotation.
  // Hiding it is what makes "an annotation has exactly one line, to its parent" true on every map.
  // A JUNCTION end passes on its own: it exists or it doesn't (there is no fold to be inside of, and
  // the open-frame scope is about cards). Resolved ONCE per end — asking endOf and then connectable
  // would put the same id through the same lookup twice.
  const shown = (id: string): boolean => {
    const x = endOf(id);
    return !!x && (!!x.j || (!isHidden(x.n) && x.n.type !== 'annotation'));
  };
  return shown(e.from) && shown(e.to);
}

export function paintFreeEdges(): void {
  // Filtering hides every line, for the same reason paintEdges does it: dimmed cards are
  // translucent, so lines behind them read as clutter.
  // …and with them the overlay: it carries the junction dots now, and a dot left hanging over a
  // filtered canvas would be the one piece of an edge still showing (the sockets and handles it also
  // holds were already stale here for the same reason).
  if (state.searchMatch){ freeEdgesSvg.innerHTML = ''; freeEdgeHitsSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '', hits = '', tools = '';
  // A label is a small patch of the CANVAS laid over the line, so its ink is derived from the canvas
  // fill exactly as a frame title's is from the surface behind it (main.ts behindFill → inkFor): black
  // or white, whichever that fill can carry. The theme's own --fg was fine only while the canvas wore
  // the theme's own --bg; on a coloured map or inside a coloured open frame it was ink chosen against
  // a surface that isn't there.
  const plate = canvasSurface(), labelInk = inkFor(plate);
  // The edge being re-routed is not drawn in its OLD place — the draft below IS that edge, moved.
  // Showing both made it look as though a second edge were being created.
  const rerouting = ui.edgeDraw?.edgeId;
  for (const e of state.edges) {
    if (e.id === rerouting) continue;
    if (!edgeVisible(e)) continue;
    const g = edgeGeometry(e); if (!g) continue;
    const { a, b, d, mid, tipTan, tailTan } = g;
    const ink = colorFill(e.color) ?? 'var(--edge)';
    const sel = state.selEdges.has(e.id);
    const dash = e.dashed ? ' stroke-dasharray="7 6"' : '';
    hits += `<path class="fe-hit" data-edge="${e.id}" d="${d}" stroke-width="${HIT_W}"/>`;
    // The selection ring, in the same language a card's is: the SAME shape, drawn thicker and SOLID
    // underneath the line itself, so a selected edge reads as outlined rather than merely recoloured
    // (and a dashed edge still shows a continuous ring through its gaps).
    if (sel) svg += `<path class="fe-selring" d="${d}"/>`;
    svg += `<path class="fe" style="stroke:${ink}"${dash} d="${d}"/>`;
    // Both terminators go with the line. A DOT used to be lifted onto the overlay above the cards,
    // because it is centred ON a card's border and a line drawn BEHIND the cards had half of every dot
    // eaten by the card it landed on. The line is above the cards now, so the whole edge — shaft, head
    // and dot — is one drawing on one layer again.
    const capTo = endCap(e.toCap, b, tipTan, ink), capFrom = endCap(e.fromCap, a, tailTan, ink);
    svg += capTo + capFrom;
    // The label sits ON the line, at its midpoint BY ARC LENGTH, on a plate so the line running
    // under it doesn't strike the text through. Width is estimated from the character count rather
    // than measured: this is one string in an SVG rebuilt on every paint, and a real measurement
    // would cost a layout flush per edge per frame.
    if (e.label) {
      const mx = mid.x, my = mid.y;
      const w = e.label.length * 8 + 12, h = 19;
      svg += `<rect class="fe-label-plate" style="fill:${plate}" x="${mx - w/2}" y="${my - h/2}" width="${w}" height="${h}" rx="4"/>`
           + `<text class="fe-label" style="fill:${labelInk}" x="${mx}" y="${my}">${esc(e.label)}</text>`;
    }
    // Handles ride the overlay above the cards so an endpoint sitting on a card's border is still
    // grabbable — drag one onto another card to re-route, or onto empty canvas to detach. Only when
    // ONE edge is selected: on a multi-selection they are eight identical dots with no way to tell
    // which line each belongs to, and the gesture they offer (re-route THIS end) is single-edge by
    // nature. The ring still marks every selected line.
    if (sel && state.selEdges.size === 1) {
      tools += `<circle class="fe-handle" data-handle="from" data-edge="${e.id}" cx="${a.x}" cy="${a.y}" r="${HANDLE_R}"/>`;
      tools += `<circle class="fe-handle" data-handle="to" data-edge="${e.id}" cx="${b.x}" cy="${b.y}" r="${HANDLE_R}"/>`;
    }
  }
  // The four sockets on the selected card. On SELECTION, never on hover: Miro's always-live dots are
  // the one thing its users complain about steadily, and a ring that only appears once you've said
  // which card you mean can't be hit by accident while you're dragging past.
  const one = state.sel.size === 1 ? state.nodes.get(state.selId ?? '') : null;
  if (one && connectable(one.id) && !state.selEdges.size && !ui.drag && !isHidden(one))
    for (const { side, p } of socketPoints(one)) {
      // A ring already carrying an edge is FILLED — the same fill the draw preview uses for the port
      // it is about to take, and for the same reason: filled means "a line is on this one". So the
      // card tells you at a glance which of its four faces are already spoken for, which is what you
      // want to know before you drag a second line off the same side.
      // Against the side each edge RESOLVES to (resolveSide), not the one on disk: on a card whose
      // port set has shrunk, several stored sides fold onto one ring, and that ring is taken.
      const taken = state.edges.some(x => edgeVisible(x)
        && ((x.from === one.id && resolveSide(one, x.fromSide) === side)
         || (x.to === one.id && resolveSide(one, x.toSide) === side)));
      tools += `<circle class="fe-socket${taken ? ' taken' : ''}" data-socket="${side}" data-node="${one.id}" cx="${p.x}" cy="${p.y}" r="${SOCKET_R}"/>`;
    }
  // The edge being drawn right now, following the pointer.
  if (ui.edgeDraw) {
    const { from, to, fromSide, hintId, overId, overSide } = ui.edgeDraw;
    // The nearby card's four ports, so there is something to aim AT. The one the pointer has
    // actually reached is filled — that, and only that, is where the drop will land.
    const hint = hintId ? state.nodes.get(hintId) : null;
    if (hint && !isHidden(hint))
      for (const { side, p } of socketPoints(hint))
        tools += `<circle class="fe-port${hintId === overId && side === overSide ? ' on' : ''}" cx="${p.x}" cy="${p.y}" r="${SOCKET_R}"/>`;
    // Drawn in the edge's FINAL style, not a ghost: the same stroke, colour, dash and arrowhead the
    // finished edge will have. A preview in a costume of its own asks the user to translate; this
    // one simply IS the edge, already where they are putting it.
    const over = overId ? state.nodes.get(overId) : null;
    // Snapped to a card's port or to an existing junction. Released in mid-air the line lands nothing at
    // all (features/edge-tools.ts finishDraw), so the draft simply follows the pointer there.
    const overJ = ui.edgeDraw.overJunction ? junctionOf(ui.edgeDraw.overJunction) : null;
    // …or an EDGE, which a drop splits at the point stored with it (already projected onto that line and
    // put on the grid by edgeSnapAt) — so the draft ends, and the ghost sits, exactly where the junction
    // is about to be, with no route re-derived to find out.
    const onEdge = ui.edgeDraw.overEdgeAt ?? null;
    const snapped = overJ ? { x: overJ.x, y: overJ.y }
                  : onEdge ?? (over && overSide ? portPoint(over, overSide) : null);
    const endPt = snapped ?? to;
    const endFace = (overJ || onEdge) ? sideToward(endPt, from) : (snapped && overSide) ? overSide : OPPOSITE[fromSide];
    // A GHOST of the junction, exactly where the drop would insert it — the answer to "what will
    // this do?" in the shape of the thing it is about to make. Marking the whole target line instead
    // said only WHICH line, and said it by making a second line look selected.
    const edge = ui.edgeDraw.edgeId ? state.edges.find(x => x.id === ui.edgeDraw!.edgeId) : null;
    const ink = colorFill(edge?.color ?? '') ?? 'var(--edge)';
    // The caps, on the ends they actually belong to. The draft is drawn from the end that is STAYING
    // to the end being dragged, so when the FROM end is the one moving, the draft runs the edge
    // backwards: the anchor is the edge's `to` and the pointer is its `from`. Reading the caps in
    // draft order rather than edge order is what used to put the arrowhead on the wrong end for
    // exactly that half of the gesture. A brand-new edge has makeEdge's own defaults, since that is
    // what the drop is about to create.
    const movingFrom = ui.edgeDraw.end === 'from';
    const anchorCap: EdgeCap = edge ? (movingFrom ? edge.toCap : edge.fromCap) : 'none';
    const movingCap: EdgeCap = edge ? (movingFrom ? edge.fromCap : edge.toCap) : 'arrow';
    // The draft goes on the LINE layer, not the port overlay: it is a line, and drawing it a layer
    // down would put the edge you are making underneath the edges that are already there.
    const { d, pts } = routeFor(from, fromSide, endPt, endFace);
    svg += `<path class="fe" style="stroke:${ink}"${edge?.dashed ? ' stroke-dasharray="7 6"' : ''} d="${d}"/>`;
    // BOTH terminators, always — the draft is the edge, so it wears the ends the finished edge will
    // wear, wherever the pointer currently is. (Landing on a junction no longer strips them: only a
    // SPLIT does that, and only to the halves of the line being split — see splitEdgeAt.)
    svg += endCap(movingCap, endPt, legDir(pts[pts.length-2], pts[pts.length-1]), ink);
    svg += endCap(anchorCap, from, legDir(pts[1], pts[0]), ink);
    if (onEdge) tools += `<circle class="fe-junction ghost" cx="${onEdge.x}" cy="${onEdge.y}" r="${SOCKET_R}"/>`;
  }
  // The meeting points, on the same overlay the ports and handles ride: above every card, so a dot
  // sitting over one is still grabbable, and under the lines, so the edges run ONTO it rather than
  // stopping at a ring drawn over them. Always drawn, unlike a card's sockets — a junction is an
  // object in its own right, not an affordance that appears once you've said which card you mean,
  // and it is the only thing marking where those lines meet. The transparent stroke (styles.css) is
  // what makes a 6px dot a fingertip-sized target without drawing a 20px blob.
  //
  // FIRST in the overlay, so it sits UNDER the endpoint handles: an end docked to a junction puts a
  // handle at the same point as the dot, and there the handle has to win — dragging it is how you take
  // that one line off the junction, while the dot underneath moves all of them at once. With no edge
  // selected there is no handle and the dot is what you grab.
  let dots = '';
  for (const j of state.junctions) {
    if (!junctionShown(j.id)) continue;
    const hot = ui.edgeDraw?.overJunction === j.id;
    dots += `<circle class="fe-junction${hot ? ' on' : ''}" data-junction="${j.id}" cx="${j.x}" cy="${j.y}" r="${SOCKET_R}"/>`;
  }
  freeEdgesSvg.innerHTML = svg;
  freeEdgeHitsSvg.innerHTML = hits;
  togglesSvg.innerHTML = dots + tools;
}
