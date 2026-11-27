// Where a stack's cards lie, on the pile or fanned out: derived on every layout, never authored.
import { state, isStack, type MindNode } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf } from '../utils/model.js';
import { orderedKids } from './layout.js';
import { nodeW, nodeH, NODE_W } from './geometry.js';
import { gridCells, fanArc, fanInsertAt, type FanInsert, type Size, type Spot } from '../utils/fan.js';

export type { FanInsert };

// More cards than this fan out as a grid instead of an arc.
export const FAN_ARC_MAX = 8;
const FAN_GAP = 16;

const FAN_ARC = { gap: FAN_GAP, lift: 20, dip: 18, tilt: 6 };

// Bottom first.
export function pileKids(s: MindNode): MindNode[] {
  return orderedKids(s, childrenOf(s.id));
}

export function topOfPile(s: MindNode): MindNode | null {
  const kids = pileKids(s);
  return kids[kids.length - 1] ?? null;
}

// The bottom card's width, so piling a wider card on never moves it. Read off the stored order first:
// it's asked on every paint and drag frame.
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

export function pileX(s: MindNode, k: MindNode): number {
  return s.x + (pileW(s) - nodeW(k)) / 2;
}

// Heights are measured, so the cards must be painted.
const sizeOf = (k: MindNode): Size => ({ w: nodeW(k), h: nodeH(k) });

export function gridOf(cards: MindNode[], gap: number): { at: Pt[]; w: number; h: number } {
  return gridCells(cards.map(sizeOf), gap);
}

// Degrees.
const fanTilts = new Map<string, number>();

export function fanTilt(id: string): number | undefined {
  return fanTilts.get(id);
}

// Returns whether the board has a stack.
export function layStacks(): boolean {
  let stacks = false;
  fanTilts.clear();
  if (ui.fan && !isStack(state.nodes.get(ui.fan))) {
    ui.fan = null;
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

export function fanSlotAt(s: MindNode, p: Pt, dragged: string): FanInsert | null {
  const shown = pileKids(s).filter(k => k.id !== dragged).reverse();
  return fanInsertAt(shown.map(k => ({ x: k.x, y: k.y, ...sizeOf(k) })), p, FAN_GAP);
}
