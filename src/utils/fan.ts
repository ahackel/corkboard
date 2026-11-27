// A stack's geometry: its cards in a grid, fanned in an arc, and where a card dragged within the fan drops.
import type { Box } from './guides.js';
import type { Pt } from './rect.js';

export interface Size { w: number; h: number }

export interface Spot extends Pt { tilt: number }

// ⌈√n⌉ columns as wide as the widest card; each row as tall as its tallest. Offsets from the grid's top-left.
export function gridCells(cards: Size[], gap: number): { at: Pt[]; w: number; h: number } {
  const cols = Math.ceil(Math.sqrt(cards.length));
  const colW = Math.max(...cards.map(c => c.w)) + gap;
  const at: Pt[] = [];
  let y = 0, w = 0;
  for (let i = 0; i < cards.length; i += cols) {
    const row = cards.slice(i, i + cols);
    row.forEach((_, j) => at.push({ x: j * colW, y }));
    w = Math.max(w, row.length * colW - gap);
    y += Math.max(...row.map(c => c.h)) + gap;
  }
  return { at, w, h: Math.max(0, y - gap) };
}

export interface ArcStyle { gap: number; lift: number; dip: number; tilt: number }

// Side by side so each reads whole: the middle `lift` above `top`, the ends `dip` lower, tilting to ±`tilt`°.
export function fanArc(widths: number[], cx: number, top: number, a: ArcStyle): Spot[] {
  const step = Math.max(...widths) + a.gap;
  const last = widths.length - 1;
  return widths.map((w, i) => {
    const t = last ? (i / last) * 2 - 1 : 0;   // -1 at the left end, +1 at the right
    return { x: cx + (i - last / 2) * step - w / 2, y: top - a.lift + t * t * a.dip, tilt: t * a.tilt };
  });
}

// The gap beside the nearest fanned card within `reach`. `shown` is top card first; `slot` counts from the
// BOTTOM of the pile; `x`/`y`/`h` is the insertion line.
export interface FanInsert { slot: number; x: number; y: number; h: number }

export function fanInsertAt(shown: Box[], p: Pt, reach: number): FanInsert | null {
  let best = -1, bestD = Infinity;
  shown.forEach((k, j) => {
    const inside = p.x >= k.x - reach && p.x <= k.x + k.w + reach && p.y >= k.y - reach && p.y <= k.y + k.h + reach;
    const d = Math.hypot(p.x - (k.x + k.w / 2), p.y - (k.y + k.h / 2));
    if (inside && d < bestD) {
      bestD = d;
      best = j;
    }
  });
  if (best < 0) {
    return null;
  }
  const c = shown[best];
  const after = p.x > c.x + c.w / 2;
  return {
    slot: shown.length - (best + (after ? 1 : 0)),
    x: after ? c.x + c.w + reach / 2 : c.x - reach / 2,
    y: c.y, h: c.h,
  };
}

// Bottom first.
export function reorderedPile(order: string[], id: string, slot: number): string[] {
  const out = order.filter(x => x !== id);
  out.splice(Math.min(slot, out.length), 0, id);
  return out;
}
