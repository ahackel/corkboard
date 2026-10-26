// ---------- free-edge rendering ----------
// The lines the user DREW between cards (core/state.ts BoardEdge). A line says "these two belong
// together" and nothing more (docs/PRODUCT.md), so it is the simplest shape that can say it: a STRAIGHT
// segment aimed at the two cards' centres, clipped to each card's rim. It stores no face and never
// routes, so moving a card can't make a line jump to another side or take a detour — the line just
// pivots to keep pointing at the card.
//
// This module paints three layers, and which is which is the whole of how an edge behaves:
//   · #freeEdges — the lines, ABOVE the cards: a line is something the reader follows, and one that
//     dives under a card in its path loses them exactly where they were tracing it;
//   · #freeEdgeHits — the same lines as invisible 18px CLICK targets, BEHIND the cards, so the
//     stretch of a line that crosses a card is still the card's to press (see HIT_W);
//   · #toggles — the rings and endpoint handles, above every card so they are always grabbable.
import { state, freeEdgesSvg, freeEdgeHitsSvg, togglesSvg, type BoardEdge, type EdgeCap, type EdgeSide, type MindNode } from '../core/state.js';
import { clamp } from '../utils/num.js';
import { isHidden, resolveWikilink } from '../utils/model.js';
import { isReadingRoot } from '../nav/scope.js';
import { ui, type Pt } from '../core/ui-state.js';
import { screenToWorld } from './camera.js';
import { nodeW, nodeH, colorFill, canvasSurface } from '../main.js';
import { inkFor } from '../utils/ink.js';
import { esc } from '../utils/markdown.js';

// Width of the invisible stroke that takes the clicks. Wider than the visible line because a thin
// target at 50% zoom is a pixel or two — and unlike a card, an edge has no interior to aim at.
export const HIT_W = 18;
export const HANDLE_R = 7;          // endpoint grab handles, shown while one edge is selected
export const SOCKET_R = 6;          // the four rings on a selected card you drag a new edge from

// The rectangle a line meets: the node's bounds, grown by half the selection ring (so a line ends ON
// the rim the user reads as the card's edge). A frame's label hangs outside its bounds, so a line meets
// the box it points at, not the label above it.
const RING_MID = 1;
function rimRect(n: MindNode): { x: number; y: number; w: number; h: number } {
  return { x: n.x - RING_MID, y: n.y - RING_MID, w: nodeW(n) + 2*RING_MID, h: nodeH(n) + 2*RING_MID };
}
function centre(n: MindNode): Pt {
  const r = rimRect(n);
  return { x: r.x + r.w/2, y: r.y + r.h/2 };
}
// Where the segment from the card's centre toward `p` leaves its rim. Ray/box: the axis it reaches
// first decides.
function rimPoint(n: MindNode, p: Pt): Pt {
  const r = rimRect(n), c = centre(n);
  const dx = p.x - c.x, dy = p.y - c.y;
  if (!dx && !dy) return c;
  const tx = dx ? (r.w/2) / Math.abs(dx) : Infinity, ty = dy ? (r.h/2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// The four rings on a selected card — only where a NEW line starts from. The finished line doesn't
// remember which one: it runs centre to centre like every other.
export function socketPoints(n: MindNode): { side: EdgeSide; p: Pt }[] {
  const r = rimRect(n);
  return [
    { side: 'up',    p: { x: r.x + r.w/2, y: r.y } },
    { side: 'down',  p: { x: r.x + r.w/2, y: r.y + r.h } },
    { side: 'left',  p: { x: r.x,         y: r.y + r.h/2 } },
    { side: 'right', p: { x: r.x + r.w,   y: r.y + r.h/2 } },
  ];
}

// The line is drawn with round caps and a round-joined head, so the paint reaches STROKE_W/2 beyond the
// geometric tip — land that tip ON a card's rim and the head's point sinks into the border it should be
// pointing at. Pulling an arrow end back by exactly that overshoot puts the painted tip on the rim.
const STROKE_W = 4;                  // must match path.fe / path.fe-arrow in styles.css
const ARROW_INSET = STROKE_W / 2;
function unit(p: Pt, q: Pt): Pt {
  const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}
// A straight segment a→b, each end pulled in by its own trim, as a path plus what the caps need.
function segment(a: Pt, b: Pt, trimA: number, trimB: number): { a: Pt; b: Pt; d: string; mid: Pt; tipTan: Pt; tailTan: Pt } {
  const u = unit(a, b), len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len > (trimA + trimB) * 1.5) {
    a = { x: a.x + u.x * trimA, y: a.y + u.y * trimA };
    b = { x: b.x - u.x * trimB, y: b.y - u.y * trimB };
  }
  return { a, b, d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, mid: { x: (a.x + b.x)/2, y: (a.y + b.y)/2 },
           tipTan: u, tailTan: { x: -u.x, y: -u.y } };
}
// The ONE place an edge's geometry is computed, so the painter, the label, the bar and the inline
// editor can never disagree about where the line is.
export function edgeGeometry(e: BoardEdge): ReturnType<typeof segment> | null {
  const from = state.nodes.get(e.from), to = state.nodes.get(e.to);
  if (!from || !to) return null;
  return segment(rimPoint(from, centre(to)), rimPoint(to, centre(from)),
    e.fromCap === 'arrow' ? ARROW_INSET : 0, e.toCap === 'arrow' ? ARROW_INSET : 0);
}

// An OPEN head — two strokes from the tip back to the corners, not a filled triangle: at the line's
// own weight it looks like the same pen drew it. Wide and shallow rather than a long thin dart.
const ARROW_LEN = 9;     // tip → base, along the line
const ARROW_W = 18;      // corner → corner, across it
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

// Whether a card can be a line's end at all. Not the card you are standing INSIDE: everything outside
// it is out of scope and off the canvas, so there is nothing left to draw a line to.
export function connectable(id: string): boolean {
  const n = state.nodes.get(id);
  return !!n && !isReadingRoot(n);
}
// An edge is drawn only when BOTH ends are visible — the same one gate everything else asks
// (utils/model.ts isHidden: a collapsed ancestor, or the open-frame scope).
export function edgeVisible(e: BoardEdge): boolean {
  const a = state.nodes.get(e.from), b = state.nodes.get(e.to);
  return !!a && !!b && !isHidden(a) && !isHidden(b);
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
  if (!links?.length) return '';
  let out = '';
  for (const a of links) {
    const target = resolveWikilink(a.dataset.target ?? '')[0];
    if (!target || target.id === n.id || isHidden(target) || !connectable(target.id)) continue;
    const r = a.getBoundingClientRect();
    if (!r.width) continue;
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
  // Filtering hides every line: dimmed cards are translucent, so lines behind them read as clutter.
  if (state.searchMatch){ freeEdgesSvg.innerHTML = ''; freeEdgeHitsSvg.innerHTML = ''; togglesSvg.innerHTML = ''; return; }
  let svg = '', hits = '', tools = '';
  // A label is a small patch of the CANVAS laid over the line, so its ink is derived from the canvas
  // fill (inkFor).
  const plate = canvasSurface(), labelInk = inkFor(plate);
  // The edge whose end is being moved is not drawn in its OLD place — the draft below IS that edge.
  const moving = ui.edgeDraw?.edgeId;
  for (const e of state.edges) {
    if (e.id === moving || !edgeVisible(e)) continue;
    const g = edgeGeometry(e); if (!g) continue;
    const ink = colorFill(e.color) ?? 'var(--edge)';
    const sel = state.selEdges.has(e.id);
    const dash = e.dashed ? ' stroke-dasharray="7 6"' : '';
    hits += `<path class="fe-hit" data-edge="${e.id}" d="${g.d}" stroke-width="${HIT_W}"/>`;
    // The selection ring, in the same language a card's is: the same line drawn thicker and SOLID
    // underneath, so a selected edge reads as outlined rather than merely recoloured.
    if (sel) svg += `<path class="fe-selring" d="${g.d}"/>`;
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
      tools += `<circle class="fe-handle" data-handle="from" data-edge="${e.id}" cx="${g.a.x}" cy="${g.a.y}" r="${HANDLE_R}"/>`;
      tools += `<circle class="fe-handle" data-handle="to" data-edge="${e.id}" cx="${g.b.x}" cy="${g.b.y}" r="${HANDLE_R}"/>`;
    }
  }
  // The four rings on the selected card. On SELECTION, never on hover: a ring that only appears once
  // you've said which card you mean can't be hit by accident while you drag past.
  const one = state.sel.size === 1 ? state.nodes.get(state.selId ?? '') : null;
  if (one && !isHidden(one)) svg += linkEdges(one);
  if (one && connectable(one.id) && !state.selEdges.size && !ui.drag && !isHidden(one))
    for (const { side, p } of socketPoints(one))
      tools += `<circle class="fe-socket" data-socket="${side}" data-node="${one.id}" cx="${p.x}" cy="${p.y}" r="${SOCKET_R}"/>`;
  // The edge being drawn right now, in its FINAL style: from the fixed card toward the pointer, or —
  // once the pointer is over a card — all the way to that card's rim, exactly where it will land.
  const draw = ui.edgeDraw;
  const src = draw ? state.nodes.get(draw.sourceId) : null;
  if (draw && src) {
    const over = draw.overId ? state.nodes.get(draw.overId) : null;
    const end = over ? rimPoint(over, centre(src)) : draw.to;
    if (over) { const r = rimRect(over); tools += `<rect class="fe-target" x="${r.x - 4}" y="${r.y - 4}" width="${r.w + 8}" height="${r.h + 8}" rx="12"/>`; }
    const edge = draw.edgeId ? state.edges.find(x => x.id === draw.edgeId) : null;
    const ink = colorFill(edge?.color ?? '') ?? 'var(--edge)';
    // The draft runs from the end that STAYS to the end being moved, so when it's the `from` end that
    // moves, the edge's caps are read the other way round. A fresh edge has makeEdge's defaults.
    const movingFrom = draw.end === 'from';
    const anchorCap: EdgeCap = edge ? (movingFrom ? edge.toCap : edge.fromCap) : 'none';
    const movingCap: EdgeCap = edge ? (movingFrom ? edge.fromCap : edge.toCap) : 'arrow';
    const s = segment(rimPoint(src, end), end, anchorCap === 'arrow' ? ARROW_INSET : 0, movingCap === 'arrow' ? ARROW_INSET : 0);
    svg += `<path class="fe" style="stroke:${ink}"${edge?.dashed ? ' stroke-dasharray="7 6"' : ''} d="${s.d}"/>`
         + endCap(movingCap, s.b, s.tipTan, ink) + endCap(anchorCap, s.a, s.tailTan, ink);
  }
  freeEdgesSvg.innerHTML = svg;
  freeEdgeHitsSvg.innerHTML = hits;
  togglesSvg.innerHTML = tools;
}
