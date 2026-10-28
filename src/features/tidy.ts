// ---------- tidy-up of a selection: only when asked (docs/PRODUCT.md, principle 2) ----------
// Tidy up (FigJam's grid), the six aligns, the two distributes and "same width", applied to the
// selected cards and frames. The geometry is utils/tidy.ts; this module turns the selection into boxes,
// applies the answer as ONE undo step with the reflow glide, and lets frames grow to show the result.
// Nothing here runs on its own: the float bar's tidy menu, ⌘P and the ⌥ shortcuts are the only ways in.
import { state, setStatus, isImageCard, type MindNode } from '../core/state.js';
import { isLockedEffective, nodesOf, outermost, subtreeIds } from '../utils/model.js';
import { moveSubtreeTo, frameLabelH } from '../view/layout.js';
import { tidyGrid, align, distribute, type AlignEdge, type Box, type Pt } from '../utils/tidy.js';
import { SPACING } from '../utils/guides.js';
import { record } from './history.js';
import { growFramesToHold } from './float-bar.js';
import { relayout, remeasure, animateLayout } from '../main.js';
import { nodeW, nodeH, snapPt } from '../view/geometry.js';
import { scheduleSave } from '../data/save.js';

// What a tidy acts on: the selected nodes that aren't inside another selected one (a frame carries its
// own cards along) and aren't locked.
function targets(): MindNode[] {
  return outermost(nodesOf(state.sel)).filter(n => !isLockedEffective(n));
}
// A node's footprint: a frame's label hangs above its box, and it belongs to the frame's room.
function boxOf(n: MindNode): Box {
  const lh = n.type === 'frame' ? frameLabelH(n) : 0;
  return { id: n.id, x: n.x, y: n.y - lh, w: nodeW(n), h: nodeH(n) + lh };
}

export function canTidy(): boolean { return !state.readOnly && targets().length >= 2; }

function apply(what: string, place: (boxes: Box[]) => Map<string, Pt>, min = 2): void {
  if (state.readOnly) return;
  const nodes = targets();
  if (nodes.length < min) { setStatus(min > 2 ? 'Select three or more to distribute' : 'Select two or more to tidy'); return; }
  const boxes = nodes.map(boxOf);
  const pos = place(boxes);
  const ids = nodes.flatMap(n => subtreeIds(n.id));
  record(ids, () => animateLayout(() => {
    for (const n of nodes) {
      const p = pos.get(n.id); if (!p) continue;
      const lh = n.type === 'frame' ? frameLabelH(n) : 0;
      moveSubtreeTo(n, p.x, p.y + lh);
    }
    growFramesToHold(nodes.map(n => n.id));   // a frame holding them shows the new arrangement
  }));
  relayout();
  scheduleSave();
  setStatus(what);
}

function tidyUp(): void {
  // from the selection's top-left, on the grid, with the house spacing — the same one guides pull to
  apply('Tidied up', boxes => tidyGrid(boxes, SPACING,
    snapPt({ x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)) })));
}
const ALIGN_NAME: Record<AlignEdge, string> = { left: 'left', center: 'centres', right: 'right', top: 'top', middle: 'middles', bottom: 'bottom' };
function alignSelection(edge: AlignEdge): void { apply(`Aligned ${ALIGN_NAME[edge]}`, boxes => align(boxes, edge)); }
function distributeSelection(axis: 'x' | 'y'): void {
  apply(axis === 'x' ? 'Spaced evenly across' : 'Spaced evenly down', boxes => distribute(boxes, axis), 3);
}
// Same width: every selected plain CARD takes the widest one's width (frames and pictures size
// themselves; a card's text re-wraps, so its height is re-measured).
function sameWidth(): void {
  if (state.readOnly) return;
  const cards = targets().filter(n => n.type !== 'frame' && !isImageCard(n));
  if (cards.length < 2) { setStatus('Select two or more cards'); return; }
  const w = Math.max(...cards.map(nodeW));
  record(cards.map(n => n.id), () => { for (const n of cards) { n.w = w; n.dirtyLayout = true; } });
  remeasure();
  scheduleSave();
  setStatus('Same width');
}

// The float bar's tidy menu (and ⌘P's entries): FigJam's shortcuts, ⌥ for the aligns, ⌃⌥ for the rest.
export const TIDY_ACTIONS: Array<{ label: string; shortcut: string; run: () => void; min?: number }> = [
  { label: 'Tidy up', shortcut: '⌃⌥T', run: tidyUp },
  { label: 'Align left', shortcut: '⌥A', run: () => alignSelection('left') },
  { label: 'Align centres', shortcut: '⌥H', run: () => alignSelection('center') },
  { label: 'Align right', shortcut: '⌥D', run: () => alignSelection('right') },
  { label: 'Align top', shortcut: '⌥W', run: () => alignSelection('top') },
  { label: 'Align middles', shortcut: '⌥V', run: () => alignSelection('middle') },
  { label: 'Align bottom', shortcut: '⌥S', run: () => alignSelection('bottom') },
  { label: 'Space evenly across', shortcut: '⌃⌥H', run: () => distributeSelection('x'), min: 3 },
  { label: 'Space evenly down', shortcut: '⌃⌥V', run: () => distributeSelection('y'), min: 3 },
  { label: 'Same width', shortcut: '', run: sameWidth },
];
// The menu, grouped: tidy · align across · align down · space · size.
export function tidyMenuEntries(): Array<'sep' | { label: string; shortcut?: string; run: () => void; disabled?: boolean }> {
  const n = targets().length;
  const e = (i: number) => ({ ...TIDY_ACTIONS[i], disabled: n < (TIDY_ACTIONS[i].min ?? 2) });
  return [e(0), 'sep', e(1), e(2), e(3), 'sep', e(4), e(5), e(6), 'sep', e(7), e(8), 'sep', e(9)];
}
// ⌥ / ⌃⌥ + letter, by KEY CODE: ⌥ turns letters into other characters on a Mac, and on Windows/Linux
// Alt+D still reports `d` — which would otherwise fall through to Duplicate.
const ALT_KEYS: Record<string, number> = { KeyA: 1, KeyH: 2, KeyD: 3, KeyW: 4, KeyV: 5, KeyS: 6 };
const CTRL_ALT_KEYS: Record<string, number> = { KeyT: 0, KeyH: 7, KeyV: 8 };
export function tidyShortcut(e: KeyboardEvent): boolean {
  if (!e.altKey || e.metaKey || state.sel.size < 2) return false;
  const i = e.ctrlKey ? CTRL_ALT_KEYS[e.code] : (!e.shiftKey ? ALT_KEYS[e.code] : undefined);
  if (i === undefined) return false;
  e.preventDefault();
  TIDY_ACTIONS[i].run();
  return true;
}
