// The lines the user drew, as FigJam elbow connectors whose route is derived on every paint. Three layers:
// #freeEdges (lines, above the cards), #freeEdgeHits (click targets, BEHIND the cards, so a line crossing a
// card doesn't steal its presses) and #toggles (handles and ports, above everything).
import { state, freeEdgesSvg, freeEdgesHeldSvg, freeEdgeHitsSvg, togglesSvg, isStack, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { clamp } from '../utils/num.js';
import { isHidden, firstVisible, resolveWikilink } from '../utils/model.js';
import { ui, type Pt } from '../core/ui-state.js';
import { screenToWorld } from './camera.js';
import { inkFor } from '../utils/ink.js';
import { esc } from '../utils/markdown.js';
import { colorFill, THEME_BG } from './color.js';
import { nodeW, nodeH } from './geometry.js';
import { centre, rimPoint, polyline, routeFor, facePoint, OPPOSITE, type Rect, type Geometry } from '../utils/edge-route.js';

// The invisible click stroke: an edge has no interior to aim at.
const HIT_W = 18;
const ENDPOINT_HANDLE_R = 8;

// The new-line ports floating outside a selected card's sides.
const SOCKET_R = 5, SOCKET_HOVER_R = 11, SOCKET_HIT_R = 13;
const SOCKET_OUT = 18;
const DROP_PORT_R = 6;
const RIM_GAP_R = 3;

// Half the selection ring: a line ends ON the rim the user reads as the card's edge.
const RING_MID = 1;

function rimRect(n: MindNode): Rect {
  return { x: n.x - RING_MID, y: n.y - RING_MID, w: nodeW(n) + 2*RING_MID, h: nodeH(n) + 2*RING_MID };
}

function socketPoints(n: MindNode): Array<{ side: EdgeSide; p: Pt }> {
  const r = rimRect(n), o = SOCKET_OUT;
  return [
    { side: 'up',    p: { x: r.x + r.w/2,   y: r.y - o } },
    { side: 'down',  p: { x: r.x + r.w/2,   y: r.y + r.h + o } },
    { side: 'left',  p: { x: r.x - o,       y: r.y + r.h/2 } },
    { side: 'right', p: { x: r.x + r.w + o, y: r.y + r.h/2 } },
  ];
}

// A line stops END_GAP short of its cards; an arrow also by its round cap's overshoot.
const STROKE_W = 3;                  // must match path.fe / path.fe-arrow in styles.css
const END_GAP = 6;
const ARROW_INSET = STROKE_W / 2;
const trim = (cap: EdgeCap): number => END_GAP + (cap === 'arrow' ? ARROW_INSET : 0);

// A card inside a folded section is stood in for by its pill; an end the open section hides is null.
export function edgeEnd(id: string): MindNode | null {
  const n = state.nodes.get(id);
  if (!n) {
    return null;
  }
  const v = firstVisible(n);
  return isHidden(v) ? null : v;
}

// The ONE place an edge's geometry is computed, so painter, label, bar and editor agree.
export function edgeGeometry(e: BoardEdge): Geometry | null {
  const from = edgeEnd(e.from), to = edgeEnd(e.to);
  if (!from || !to) {
    return null;
  }
  // A pill's faces aren't the card's, so a stood-in end drops its pinned port.
  const pa = from.id === e.from ? e.fromPort : undefined, pb = to.id === e.to ? e.toPort : undefined;
  return polyline(routeFor(rimRect(from), pa, rimRect(to), pb, e.fromAt, e.toAt), trim(e.fromCap), trim(e.toCap));
}

// Screen px. Near a port or face middle → the port; near a face → that point of it, pulled level with the
// anchor when close (a straight line); deeper inside → no pin.
const PORT_SNAP = 16, STRAIGHT_SNAP = 8;

// A line's fixed end while the other is dragged.
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

// An open head of two strokes, wide and shallow.
const ARROW_LEN = 11;    // tip → base, along the line
const ARROW_W = 22;      // corner → corner, across it

function arrowHead(tip: Pt, dir: Pt, ink: string): string {
  const nx = -dir.y, ny = dir.x;
  const bx = tip.x - dir.x * ARROW_LEN, by = tip.y - dir.y * ARROW_LEN;
  const x1 = bx + nx * ARROW_W * 0.5, y1 = by + ny * ARROW_W * 0.5;
  const x2 = bx - nx * ARROW_W * 0.5, y2 = by - ny * ARROW_W * 0.5;
  return `<path class="fe-arrow" style="stroke:${ink}" d="M ${x1} ${y1} L ${tip.x} ${tip.y} L ${x2} ${y2}"/>`;
}

const DOT_R = ARROW_W * 0.28;

function capDot(at: Pt, ink: string): string {
  return `<circle class="fe-dot" style="fill:${ink}" cx="${at.x}" cy="${at.y}" r="${DOT_R}"/>`;
}

// `dir` points INTO that end.
function endCap(cap: EdgeCap, at: Pt, dir: Pt, ink: string): string {
  return cap === 'arrow' ? arrowHead(at, dir, ink) : cap === 'dot' ? capDot(at, ink) : '';
}

export function connectable(id: string): boolean {
  const n = state.nodes.get(id);
  return !!n && !isStack(n);
}

// A line between two cards of one folded section folds away with them.
export function edgeVisible(e: BoardEdge): boolean {
  const a = edgeEnd(e.from), b = edgeEnd(e.to);
  return !!a && !!b && a !== b;
}

// A selected card's [[wikilinks]], drawn in a deliberately different pen: they aren't stored or selectable.
// Each leaves the rim level with its own link text.
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

// Set by features/canvas-color.ts.
let canvasSurface: () => string = () => THEME_BG;

export function useCanvasSurface(surface: () => string): void {
  canvasSurface = surface;
}

export function paintFreeEdges(): void {
  // Dimmed cards are translucent, so lines behind them would read as clutter.
  if (state.searchMatch){ freeEdgesSvg.innerHTML = ''; freeEdgesHeldSvg.innerHTML = ''; freeEdgeHitsSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '', held = '', hits = '', tools = '';
  // A line with an end in hand rides in #dragLayer, or the dragged section's box would cover it.
  const inHand = ui.drag?.moved ? ui.drag.origins : null;
  const plate = canvasSurface(), labelInk = inkFor(plate);
  // The draft below IS the edge whose end is being moved.
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
    // A one-way arrow between cards nearly touching is just its head.
    const headOnly = (e.toCap === 'arrow') !== (e.fromCap === 'arrow') && Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) < ARROW_LEN * 2;
    // One selected edge shows end handles instead of the ring.
    if (sel && state.selEdges.size > 1 && !headOnly) {
      svg += `<path class="fe-selring" d="${g.d}"/>`;
    }
    if (!headOnly) {
      svg += `<path class="fe" style="stroke:${ink}"${dash} d="${g.d}"/>`;
    }
    if (headOnly) {
      const toArrow = e.toCap === 'arrow', dir = toArrow ? g.tipTan : g.tailTan;
      const tip = { x: (g.a.x + g.b.x) / 2 + dir.x * ARROW_LEN / 2, y: (g.a.y + g.b.y) / 2 + dir.y * ARROW_LEN / 2 };
      svg += arrowHead(tip, dir, ink) + (toArrow ? endCap(e.fromCap, g.a, g.tailTan, ink) : endCap(e.toCap, g.b, g.tipTan, ink));
    } else {
      svg += endCap(e.toCap, g.b, g.tipTan, ink) + endCap(e.fromCap, g.a, g.tailTan, ink);
    }
    // Width estimated from the character count: measuring would cost a layout flush per edge per frame.
    if (e.label) {
      const w = e.label.length * 8 + 12, h = 19;
      svg += `<rect class="fe-label-plate" style="fill:${plate}" x="${g.mid.x - w/2}" y="${g.mid.y - h/2}" width="${w}" height="${h}" rx="4"/>`
           + `<text class="fe-label" style="fill:${labelInk}" x="${g.mid.x}" y="${g.mid.y}">${esc(e.label)}</text>`;
    }
    if (sel && state.selEdges.size === 1) {
      // On the rim: step each drawn end back by its trim.
      const ta = trim(e.fromCap), tb = trim(e.toCap);
      const ha = { x: g.a.x + g.tailTan.x * ta, y: g.a.y + g.tailTan.y * ta };
      const hb = { x: g.b.x + g.tipTan.x * tb, y: g.b.y + g.tipTan.y * tb };
      tools += `<circle class="fe-handle" data-handle="from" data-edge="${esc(e.id)}" cx="${ha.x}" cy="${ha.y}" r="${ENDPOINT_HANDLE_R}"/>`;
      tools += `<circle class="fe-handle" data-handle="to" data-edge="${esc(e.id)}" cx="${hb.x}" cy="${hb.y}" r="${ENDPOINT_HANDLE_R}"/>`;
    }

    // One group per line, so a picture export can keep or drop it whole.
    svg = svg.slice(0, start) + `<g data-edge="${esc(e.id)}">` + svg.slice(start) + '</g>';
    if (inHand && (inHand.has(edgeEnd(e.from)!.id) || inHand.has(edgeEnd(e.to)!.id))) {
      held += svg.slice(start);
      svg = svg.slice(0, start);
    }
  }
  // Ports on selection, never on hover: they can't be hit by accident while dragging past.
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
  // The edge being drawn, in its final style and route.
  const draw = ui.edgeDraw;
  const src = draw ? state.nodes.get(draw.sourceId) : null;
  if (draw && src) {
    const over = draw.overId ? state.nodes.get(draw.overId) : null;
    const rim = over ? rimRect(over) : null, sides = ['up', 'down', 'left', 'right'] as const;
    const shifted = !!draw.overSide && (draw.overAt ?? 0.5) !== 0.5;
    if (rim && shifted) {
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
    // The draft runs from the end that stays; a fresh edge has makeEdge's defaults.
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
