// ---------- a STACK's geometry: where its cards lie, in the pile and fanned out ----------
// A stack is a section drawn as a PILE (features/stacks.ts). Its cards don't sit where they were put: they
// lie on the pile, every one at the stack's own corner — or, while it's FANNED OUT (ui.fan), at their spot
// in the fan. Both are derived on every layout (layStacks), never authored, so nothing here is a choice
// the user made and lost.
import { state, isStack, type MindNode } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf } from '../utils/model.js';
import { orderedKids } from './layout.js';
import { nodeW, nodeH, NODE_W } from './geometry.js';

// Up to this many cards fan out in an ARC above the pile, the Dock's fan; more open as a GRID over it.
export const FAN_ARC_MAX = 8;
const FAN_GAP = 16;

// How far the arc's ends dip below its middle, and how far they tilt (degrees).
const ARC_DIP = 30, ARC_TILT = 6;

// A stack's cards, BOTTOM first: the pile's order is its child order (board.json `order`), the last on top.
export function pileKids(s: MindNode): MindNode[] {
  return orderedKids(s, childrenOf(s.id));
}

export function topOfPile(s: MindNode): MindNode | null {
  const kids = pileKids(s);
  return kids[kids.length - 1] ?? null;
}

// The pile's footprint is its TOP card's: that's the face you see and grab. Asked on every paint and drag
// frame (nodeW), so it reads the top off the stored order — the last id still a card of this stack — and only
// falls back to the full child scan when that order has nothing to say.
export function pileW(s: MindNode): number {
  const order = s.kidOrder ?? [];
  for (let i = order.length - 1; i >= 0; i--) {
    const k = state.nodes.get(order[i]);
    if (k?.parent === s.id) {
      return nodeW(k);
    }
  }
  const top = topOfPile(s);
  return top ? nodeW(top) : NODE_W;
}

// Cards in a GRID: ⌈√n⌉ columns as wide as the widest card, each row as tall as its tallest, `gap` apart.
// Each card's top-left as an offset from the grid's own, and the grid's size. Shared by the fan's grid and by
// Unstack / Turn into section (features/stacks.ts). Heights are measured, so the cards must be painted.
export function gridOf(cards: MindNode[], gap: number): { at: Pt[]; w: number; h: number } {
  const cols = Math.ceil(Math.sqrt(cards.length));
  const colW = Math.max(...cards.map(nodeW)) + gap;
  const at: Pt[] = [];
  let y = 0, w = 0;
  for (let i = 0; i < cards.length; i += cols) {
    const row = cards.slice(i, i + cols);
    row.forEach((_, j) => at.push({ x: j * colW, y }));
    w = Math.max(w, row.length * colW - gap);
    y += Math.max(...row.map(nodeH)) + gap;
  }
  return { at, w, h: Math.max(0, y - gap) };
}

// The tilt of each card in the open fan, in degrees — set as its `--tilt` by features/stacks.ts syncFan.
const fanTilts = new Map<string, number>();

export function fanTilt(id: string): number | undefined {
  return fanTilts.get(id);
}

// Every stack's cards to their places. Run by every layout (view/layout.ts applyLayouts). A position only
// changes when it has to, so a settled board flags nothing for the save.
export function layStacks(): void {
  fanTilts.clear();
  if (ui.fan && !isStack(state.nodes.get(ui.fan))) {
    ui.fan = null;   // the fanned stack is gone (dissolved, deleted, undone away)
  }
  for (const s of state.nodes.values()) {
    if (!isStack(s)) {
      continue;
    }
    const kids = pileKids(s);
    const spots = ui.fan === s.id ? fanSpots(s, kids) : null;
    for (const k of kids) {
      const at = spots?.get(k.id) ?? { x: s.x, y: s.y, tilt: 0 };
      if (Math.abs(k.x - at.x) >= 0.5 || Math.abs(k.y - at.y) >= 0.5) {
        k.x = at.x; k.y = at.y; k.dirtyLayout = true;
      }
      if (spots) {
        fanTilts.set(k.id, at.tilt);
      }
    }
  }
}

// Where each card of a FANNED stack shows, the top card first: an arc for a handful — a hand of cards held up
// over the pile, side by side so each reads whole, the middle highest — and a grid centred on the pile for
// more.
interface Spot extends Pt { tilt: number }

function fanSpots(s: MindNode, kids: MindNode[]): Map<string, Spot> {
  const shown = kids.slice().reverse();
  const out = new Map<string, Spot>();
  const cx = s.x + pileW(s) / 2;
  if (shown.length <= FAN_ARC_MAX) {
    const step = Math.max(...shown.map(nodeW)) + FAN_GAP;
    const last = shown.length - 1;
    shown.forEach((k, i) => {
      const t = last ? (i / last) * 2 - 1 : 0;   // -1 at the left end, +1 at the right
      out.set(k.id, {
        x: cx + (i - last / 2) * step - nodeW(k) / 2,
        y: s.y - FAN_GAP * 2 - nodeH(k) - (1 - t * t) * ARC_DIP,
        tilt: t * ARC_TILT,
      });
    });
    return out;
  }
  const g = gridOf(shown, FAN_GAP);
  const x0 = cx - g.w / 2, y0 = s.y + nodeH(s) / 2 - g.h / 2;
  shown.forEach((k, i) => out.set(k.id, { x: x0 + g.at[i].x, y: y0 + g.at[i].y, tilt: 0 }));
  return out;
}

// Where a card dragged within the fan would go: the GAP beside the fanned card nearest the pointer — before
// it or after it, by which half of it the pointer is over. `slot` is that place as an index into the pile
// without the dragged card (bottom first, what reorderPile splices at); `x`/`y`/`h` are the insertion line,
// down the middle of the gap. Null when the pointer is nowhere near the fan.
export interface FanInsert { slot: number; x: number; y: number; h: number }
export function fanSlotAt(s: MindNode, p: Pt, dragged: string): FanInsert | null {
  const order = pileKids(s).filter(k => k.id !== dragged);
  const shown = order.slice().reverse();   // as laid out: the top card first
  let best = -1, bestD = Infinity;
  shown.forEach((k, j) => {
    const inside = p.x >= k.x - FAN_GAP && p.x <= k.x + nodeW(k) + FAN_GAP && p.y >= k.y - FAN_GAP && p.y <= k.y + nodeH(k) + FAN_GAP;
    const d = Math.hypot(p.x - (k.x + nodeW(k) / 2), p.y - (k.y + nodeH(k) / 2));
    if (inside && d < bestD) { bestD = d; best = j; }
  });
  if (best < 0) {
    return null;
  }
  const c = shown[best];
  const after = p.x > c.x + nodeW(c) / 2;
  return {
    slot: order.length - (best + (after ? 1 : 0)),
    x: after ? c.x + nodeW(c) + FAN_GAP / 2 : c.x - FAN_GAP / 2,
    y: c.y, h: nodeH(c),
  };
}
