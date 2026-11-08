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
import { state, freeEdgesSvg, freeEdgesHeldSvg, freeEdgeHitsSvg, togglesSvg, isStack, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { clamp } from '../utils/num.js';
import { isHidden, firstVisible, resolveWikilink } from '../utils/model.js';
import { ui, type Pt } from '../core/ui-state.js';
import { screenToWorld } from './camera.js';
import { inkFor } from '../utils/ink.js';
import { esc } from '../utils/markdown.js';
import { colorFill } from './color.js';
import { nodeW, nodeH } from './geometry.js';
import { canvasSurface } from '../features/canvas-color.js';
import { centre, rimPoint, polyline, routeFor, facePoint, OPPOSITE, type Rect, type Geometry } from '../utils/edge-route.js';

// Width of the invisible stroke that takes the clicks. Wider than the visible line because a thin
// target at 50% zoom is a pixel or two — and unlike a card, an edge has no interior to aim at.
const HIT_W = 18;
const HANDLE_R = 8;          // endpoint grab handles (FigJam's white disc, thick blue rim), one edge selected

// The four PORTS on a selected card you drag a new line from — FigJam's: a small blue dot in a white
// rim, floating SOCKET_OUT outside each side, that becomes a ⊕ under the pointer (styles.css).
const SOCKET_R = 5, SOCKET_HOVER_R = 11, SOCKET_HIT_R = 13;
const SOCKET_OUT = 18;
const DROP_PORT_R = 6;       // a target card's hollow port ring while a line end is dragged
const RIM_GAP_R = 3;         // the white notch a shifted end's rim outline shows at each port

// The rectangle a line meets: the node's bounds, grown by half the selection ring (so a line ends ON
// the rim the user reads as the card's edge). A section's label hangs outside its bounds, so a line meets
// the box it points at, not the label above it.
const RING_MID = 1;

function rimRect(n: MindNode): Rect {
  return { x: n.x - RING_MID, y: n.y - RING_MID, w: nodeW(n) + 2*RING_MID, h: nodeH(n) + 2*RING_MID };
}

// The four dots on a selected card — only where a NEW line starts from, floating a little OUTSIDE each
// side the way FigJam's do, clear of the resize handles. The finished line doesn't remember which one:
// it is routed from where the two cards are, like every other (`routeFor`).
function socketPoints(n: MindNode): Array<{ side: EdgeSide; p: Pt }> {
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

// The ONE place an edge's geometry is computed, so the painter, the label, the bar and the inline
// editor can never disagree about where the line is.
// A line to a card tucked inside a FOLDED section attaches to that section's pill instead (firstVisible), and
// its pinned port there is dropped — the pill's faces aren't the card's. Ends the open section hides map to null.
export function edgeEnd(id: string): MindNode | null {
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
  return polyline(routeFor(rimRect(from), pa, rimRect(to), pb, e.fromAt, e.toAt), trim(e.fromCap), trim(e.toCap));
}

// Where on a card a line end dropped at a world point pins (features/edge-tools.ts), if anywhere: within
// PORT_SNAP screen px of a floating port dot or the middle of a face, that face's MIDDLE — the port; else
// within PORT_SNAP of a face anywhere along it, THAT point of it (FigJam's shifted connection). There a
// shifted end is pulled, more weakly (STRAIGHT_SNAP), level with the line's fixed `anchor` end, so the line
// runs STRAIGHT. Further inside, the card's body: no pin at all.
const PORT_SNAP = 16, STRAIGHT_SNAP = 8;

// A line's fixed end while the other is dragged: its card, and the face (and point along it) it's pinned to.
export interface Anchor { n: MindNode; side?: EdgeSide; at?: number }

export function portAt(n: MindNode, p: Pt, anchor?: Anchor): { side: EdgeSide; at: number } | null {
  const snap = PORT_SNAP / (state.view.k || 1), r = rimRect(n);
  let best: { side: EdgeSide; at: number } | null = null, bestD = snap;
  for (const { side, p: dot } of socketPoints(n)) {
    const face = facePoint(r, side);
    const d = Math.min(Math.hypot(p.x - dot.x, p.y - dot.y), Math.hypot(p.x - face.x, p.y - face.y));
    if (d < bestD) { bestD = d; best = { side, at: 0.5 }; }
  }
  if (best) {
    return best;
  }
  const faces: Array<{ side: EdgeSide; off: number; along: number }> = [
    { side: 'up', off: p.y - r.y, along: (p.x - r.x) / r.w }, { side: 'down', off: p.y - r.y - r.h, along: (p.x - r.x) / r.w },
    { side: 'left', off: p.x - r.x, along: (p.y - r.y) / r.h }, { side: 'right', off: p.x - r.x - r.w, along: (p.y - r.y) / r.h },
  ];
  for (const { side, off, along } of faces) {
    if (along >= 0 && along <= 1 && Math.abs(off) < bestD) { bestD = Math.abs(off); best = { side, at: along }; }
  }
  // straight across means leaving the anchor by the face opposite this one (an unpinned anchor can pick it)
  const facing = best && OPPOSITE[best.side];
  if (best && facing && anchor && (!anchor.side || anchor.side === facing)) {
    const a = facePoint(rimRect(anchor.n), facing, anchor.side ? anchor.at : 0.5);
    const across = best.side === 'left' || best.side === 'right';
    const at = across ? (a.y - r.y) / r.h : (a.x - r.x) / r.w;
    if (at > 0 && at < 1 && Math.abs(across ? a.y - p.y : a.x - p.x) < STRAIGHT_SNAP / (state.view.k || 1)) {
      best.at = at;
    }
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
// A STACK takes no line: it's a pile you lift cards off, not a note a line can say anything about.
export function connectable(id: string): boolean {
  const n = state.nodes.get(id);
  return !!n && !isStack(n);
}

// An edge is drawn when both ENDS are on the canvas — a card itself, or the folded section standing in for
// it (edgeEnd) — and they aren't the same pill: a line between two cards of one folded section goes with them.
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
    const toRight = centre(rimRect(target)).x >= (p1.x + p2.x) / 2;
    const from = { x: toRight ? n.x + nodeW(n) : n.x, y };
    const s = polyline([from, rimPoint(rimRect(target), from)], 0, ARROW_INSET);
    out += `<path class="fe" style="stroke:${LINK_INK}" stroke-dasharray="1 7" d="${s.d}"/>`
         + endCap('arrow', s.b, s.tipTan, LINK_INK) + capDot(s.a, LINK_INK);
  }
  return out;
}

export function paintFreeEdges(): void {
  // Searching hides every line: dimmed cards are translucent, so lines behind them read as clutter.
  if (state.searchMatch){ freeEdgesSvg.innerHTML = ''; freeEdgesHeldSvg.innerHTML = ''; freeEdgeHitsSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '', held = '', hits = '', tools = '';
  // A line with an end in hand rides in #dragLayer, above the cards in hand, so a dragged section's box can't
  // cover the lines in it or leaving it — as resting lines are drawn above resting cards.
  const inHand = ui.drag?.moved ? ui.drag.origins : null;
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
    const start = svg.length;
    const ink = colorFill(e.color) ?? 'var(--edge)';
    const sel = state.selEdges.has(e.id);
    const dash = e.dashed ? ' stroke-dasharray="7 6"' : '';
    hits += `<path class="fe-hit" data-edge="${esc(e.id)}" d="${g.d}" stroke-width="${HIT_W}"/>`;
    // The selection ring, in the same language a card's is: the same line drawn thicker and SOLID
    // underneath, so a selected edge reads as outlined rather than merely recoloured.
    // With ONE edge selected its two end handles say so (FigJam); a multi-selection has no handles, so
    // there each line wears the ring instead.
    // A one-way arrow between cards nearly touching is just its head: a stub of line under it is noise.
    const headOnly = (e.toCap === 'arrow') !== (e.fromCap === 'arrow') && Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) < ARROW_LEN * 2;
    if (sel && state.selEdges.size > 1 && !headOnly) {
      svg += `<path class="fe-selring" d="${g.d}"/>`;
    }
    if (!headOnly) {
      svg += `<path class="fe" style="stroke:${ink}"${dash} d="${g.d}"/>`;
    }
    if (headOnly) {

      // …centred in the gap between the two ports rather than pressed against the target.
      const toArrow = e.toCap === 'arrow', dir = toArrow ? g.tipTan : g.tailTan;
      const tip = { x: (g.a.x + g.b.x) / 2 + dir.x * ARROW_LEN / 2, y: (g.a.y + g.b.y) / 2 + dir.y * ARROW_LEN / 2 };
      svg += arrowHead(tip, dir, ink) + (toArrow ? endCap(e.fromCap, g.a, g.tailTan, ink) : endCap(e.toCap, g.b, g.tipTan, ink));
    } else {
      svg += endCap(e.toCap, g.b, g.tipTan, ink) + endCap(e.fromCap, g.a, g.tailTan, ink);
    }
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
      tools += `<circle class="fe-handle" data-handle="from" data-edge="${esc(e.id)}" cx="${ha.x}" cy="${ha.y}" r="${HANDLE_R}"/>`;
      tools += `<circle class="fe-handle" data-handle="to" data-edge="${esc(e.id)}" cx="${hb.x}" cy="${hb.y}" r="${HANDLE_R}"/>`;
    }

    // Each line is one group, so a picture export (features/export-image.ts) can keep or drop it whole.
    svg = svg.slice(0, start) + `<g data-edge="${esc(e.id)}">` + svg.slice(start) + '</g>';
    if (inHand && (inHand.has(edgeEnd(e.from)!.id) || inHand.has(edgeEnd(e.to)!.id))) {
      held += svg.slice(start);
      svg = svg.slice(0, start);
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
    const rim = over ? rimRect(over) : null, sides = ['up', 'down', 'left', 'right'] as const;
    const shifted = !!draw.overSide && (draw.overAt ?? 0.5) !== 0.5;
    if (rim && shifted) {
      // FigJam's shifted end: no ports, the card's rim traced thick with a GAP where each port is (the
      // spots it would snap to), and the end's dot ON the face where it will sit
      tools += `<rect class="fe-rim" x="${rim.x}" y="${rim.y}" width="${rim.w}" height="${rim.h}" rx="4"/>`;
      for (const side of sides) {
        const m = facePoint(rim, side);
        tools += `<circle class="fe-rim-gap" cx="${m.x}" cy="${m.y}" r="${RIM_GAP_R}"/>`;
      }
      const q = facePoint(rim, draw.overSide!, draw.overAt);
      tools += `<circle class="fe-drop-port on" cx="${q.x}" cy="${q.y}" r="${SOCKET_HOVER_R - 3}"/>`;
    }
    const edge = draw.edgeId ? state.edges.find(x => x.id === draw.edgeId) : null;
    const ink = colorFill(edge?.color ?? '') ?? 'var(--edge)';
    // The draft runs from the end that STAYS to the end being moved, so when it's the `from` end that
    // moves, the edge's caps are read the other way round. A fresh edge has makeEdge's defaults.
    const movingFrom = draw.end === 'from';
    const anchorCap: EdgeCap = edge ? (movingFrom ? edge.toCap : edge.fromCap) : 'none';
    const movingCap: EdgeCap = edge ? (movingFrom ? edge.fromCap : edge.toCap) : 'arrow';
    const anchorPort = edge ? (movingFrom ? edge.toPort : edge.fromPort) : draw.side;
    const anchorAt = edge ? (movingFrom ? edge.toAt : edge.fromAt) : undefined;
    const s = polyline(routeFor(rimRect(src), anchorPort, over ? rimRect(over) : { ...draw.to, w: 0, h: 0 }, over ? draw.overSide : undefined,
      anchorAt, over ? draw.overAt : undefined), trim(anchorCap),
      over ? trim(movingCap) : movingCap === 'arrow' ? ARROW_INSET : 0);
    svg += `<path class="fe" style="stroke:${ink}"${edge?.dashed ? ' stroke-dasharray="7 6"' : ''} d="${s.d}"/>`
         + endCap(movingCap, s.b, s.tipTan, ink) + endCap(anchorCap, s.a, s.tailTan, ink);
    if (rim && !shifted) {
      // FigJam's ports while an end is aimed at a card: hollow rings ON its rim, no outline — the one the
      // line will meet filled blue (with no pin, the side the route chose: the face nearest its end)
      const near = (side: EdgeSide): number => { const f = facePoint(rim, side); return Math.hypot(f.x - s.b.x, f.y - s.b.y); };
      const pick = draw.overSide ?? sides.reduce((a, b) => near(b) < near(a) ? b : a);
      for (const side of sides) {
        const m = facePoint(rim, side), on = side === pick;
        tools += `<circle class="fe-drop-port${on ? ' on' : ''}" cx="${m.x}" cy="${m.y}" r="${on ? SOCKET_HOVER_R - 3 : DROP_PORT_R}"/>`;
      }
    }
  }
  freeEdgesSvg.innerHTML = svg;
  freeEdgesHeldSvg.innerHTML = held;
  freeEdgeHitsSvg.innerHTML = hits;
  togglesSvg.innerHTML = tools;
}
