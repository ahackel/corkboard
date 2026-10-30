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

// The pile's footprint is its TOP card's: that's the face you see and grab.
export function pileW(s: MindNode): number {
  const top = topOfPile(s);
  return top ? nodeW(top) : NODE_W;
}

// A steady number in [-1, 1) for a card, from its PATH rather than its id (ids are minted afresh on every
// load): the pile's mess is part of how it looks, so it must not reshuffle each time the map opens.
export function jitter(n: MindNode, salt: number): number {
  let h = 2166136261 ^ salt;
  for (const ch of n.file ?? n.id) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  return ((h >>> 0) % 2000) / 1000 - 1;
}

// The tilt of each card in the open fan, in degrees — read by paintNode for the card's CSS `rotate`.
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
  const cols = Math.ceil(Math.sqrt(shown.length));
  const colW = Math.max(...shown.map(nodeW)) + FAN_GAP;
  const rows: MindNode[][] = [];
  for (let i = 0; i < shown.length; i += cols) {
    rows.push(shown.slice(i, i + cols));
  }
  const rowH = rows.map(r => Math.max(...r.map(nodeH)) + FAN_GAP);
  const total = rowH.reduce((a, b) => a + b, 0) - FAN_GAP;
  let y = s.y + nodeH(s) / 2 - total / 2;
  rows.forEach((r, ri) => {
    const x0 = cx - (cols * colW - FAN_GAP) / 2;
    r.forEach((k, i) => out.set(k.id, { x: x0 + i * colW, y, tilt: 0 }));
    y += rowH[ri];
  });
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
