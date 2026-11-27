// ---------- a STACK's geometry: where its cards lie, in the pile and fanned out ----------
// A stack is a section drawn as a PILE (features/stacks.ts). Its cards don't sit where they were put: they
// lie on the pile, centred over its bottom card (pileX) — or, while it's FANNED OUT (ui.fan), at their spot
// in the fan. Both are derived on every layout (layStacks), never authored, so nothing here is a choice
// the user made and lost.
import { state, isStack, type MindNode } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf } from '../utils/model.js';
import { orderedKids } from './layout.js';
import { nodeW, nodeH, NODE_W } from './geometry.js';
import { gridCells, fanArc, fanInsertAt, type FanInsert, type Size, type Spot } from '../utils/fan.js';

export type { FanInsert };

// Up to this many cards fan out in an ARC over the pile, the Dock's fan; more open as a GRID over it.
export const FAN_ARC_MAX = 8;
const FAN_GAP = 16;

// The arc sits a little above the pile (lift), its ends dipping and tilting out (degrees).
const FAN_ARC = { gap: FAN_GAP, lift: 20, dip: 18, tilt: 6 };

// A stack's cards, BOTTOM first: the pile's order is its child order (board.json `order`), the last on top.
export function pileKids(s: MindNode): MindNode[] {
  return orderedKids(s, childrenOf(s.id));
}

export function topOfPile(s: MindNode): MindNode | null {
  const kids = pileKids(s);
  return kids[kids.length - 1] ?? null;
}

// The pile's footprint is its BOTTOM card's: the card the pile was made on, which every card piled on top
// is centred over — so piling a wider card on a narrow one never moves the narrow one. Asked on every paint
// and drag frame (nodeW), so it reads the bottom off the stored order — the first id still a card of this
// stack — and only falls back to the full child scan when that order has nothing to say.
export function pileW(s: MindNode): number {
  for (const id of s.kidOrder ?? []) {
    const k = state.nodes.get(id);
    if (k?.parent === s.id) {
      return nodeW(k);
    }
  }
  const bottom = pileKids(s)[0];
  return bottom ? nodeW(bottom) : NODE_W;
}

// Where a card lies on its pile: centred over the bottom card, top edges level.
export function pileX(s: MindNode, k: MindNode): number {
  return s.x + (pileW(s) - nodeW(k)) / 2;
}

// Cards in a GRID (utils/fan.ts gridCells), shared by the fan's grid and by Unstack / Turn into section
// (features/stacks.ts). Heights are measured, so the cards must be painted.
const sizeOf = (k: MindNode): Size => ({ w: nodeW(k), h: nodeH(k) });

export function gridOf(cards: MindNode[], gap: number): { at: Pt[]; w: number; h: number } {
  return gridCells(cards.map(sizeOf), gap);
}

// The tilt of each card in the open fan, in degrees — set as its `--tilt` by features/stacks.ts syncFan.
const fanTilts = new Map<string, number>();

export function fanTilt(id: string): number | undefined {
  return fanTilts.get(id);
}

// Every stack's cards to their places. Run by every layout (view/layout.ts applyLayouts). A position only
// changes when it has to, so a settled board flags nothing for the save. Says whether the board HAS a stack.
export function layStacks(): boolean {
  let stacks = false;
  fanTilts.clear();
  if (ui.fan && !isStack(state.nodes.get(ui.fan))) {
    ui.fan = null;   // the fanned stack is gone (dissolved, deleted, undone away)
  }
  for (const s of state.nodes.values()) {
    if (!isStack(s)) {
      continue;
    }
    stacks = true;
    const kids = pileKids(s);
    const spots = ui.fan === s.id ? fanSpots(s, kids) : null;
    for (const k of kids) {
      const at = spots?.get(k.id) ?? { x: pileX(s, k), y: s.y, tilt: 0 };
      if (Math.abs(k.x - at.x) >= 0.5 || Math.abs(k.y - at.y) >= 0.5) {
        k.x = at.x; k.y = at.y;
      }
      if (spots) {
        fanTilts.set(k.id, at.tilt);
      }
    }
  }
  return stacks;
}

// Where each card of a FANNED stack shows, the top card first: an arc for a handful, a grid centred on the
// pile for more.
function fanSpots(s: MindNode, kids: MindNode[]): Map<string, Spot> {
  const shown = kids.slice().reverse();
  const out = new Map<string, Spot>();
  const cx = s.x + pileW(s) / 2;
  if (shown.length <= FAN_ARC_MAX) {
    const arc = fanArc(shown.map(nodeW), cx, s.y, FAN_ARC);
    shown.forEach((k, i) => out.set(k.id, arc[i]));
    return out;
  }
  const g = gridOf(shown, FAN_GAP);
  const x0 = cx - g.w / 2, y0 = s.y + nodeH(s) / 2 - g.h / 2;
  shown.forEach((k, i) => out.set(k.id, { x: x0 + g.at[i].x, y: y0 + g.at[i].y, tilt: 0 }));
  return out;
}

// Where a card dragged within the fan would go (utils/fan.ts fanInsertAt). Null when the pointer is nowhere
// near the fan.
export function fanSlotAt(s: MindNode, p: Pt, dragged: string): FanInsert | null {
  const shown = pileKids(s).filter(k => k.id !== dragged).reverse();
  return fanInsertAt(shown.map(k => ({ x: k.x, y: k.y, ...sizeOf(k) })), p, FAN_GAP);
}
