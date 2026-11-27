// Tidy up, align, distribute and same width over the selection, as ONE undo step; only when asked.
// The geometry is utils/tidy.ts.
import { state, setStatus, isImageCard, type MindNode } from '../core/state.js';
import { childrenOf, isLockedEffective, nodesOf, outermost, subtreeIds } from '../utils/model.js';
import { isSection, moveSubtreeTo, sectionLabelH } from '../view/layout.js';
import { tidyGrid, align, distribute, type AlignEdge, type Box, type Pt } from '../utils/tidy.js';
import { SPACING } from '../utils/guides.js';
import { mutate } from './mutate.js';
import { animateLayout } from '../layout-anim.js';
import { nodeW, nodeH, snapPt } from '../view/geometry.js';
import { SECTION_FIT_PAD } from './float-bar.js';

function targets(): MindNode[] {
  return outermost(nodesOf(state.sel)).filter(n => !isLockedEffective(n));
}

// A section's label hangs above its box and belongs to its footprint.
function boxOf(n: MindNode): Box {
  const lh = n.type === 'section' ? sectionLabelH(n) : 0;
  return { id: n.id, x: n.x, y: n.y - lh, w: nodeW(n), h: nodeH(n) + lh };
}

export function canTidy(): boolean { return targets().length >= 2; }

function apply(what: string, place: (boxes: Box[]) => Map<string, Pt>, min = 2, nodes = targets()): void {
  if (nodes.length < min) { setStatus(min > 2 ? 'Select three or more to distribute' : 'Select two or more to tidy'); return; }
  const boxes = nodes.map(boxOf);
  const pos = place(boxes);
  const ids = nodes.flatMap(n => subtreeIds(n.id));
  mutate(ids, () => animateLayout(() => {
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) {
        continue;
      }
      const lh = n.type === 'section' ? sectionLabelH(n) : 0;
      moveSubtreeTo(n, p.x, p.y + lh);
    }
  }), { reflow: 'relayout', status: what });
}

function tidyUp(): void {
  apply('Tidied up', boxes => tidyGrid(boxes, SPACING,
    snapPt({ x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)) })));
}

function sectionKids(s: MindNode): MindNode[] {
  return childrenOf(s.id).filter(n => !isLockedEffective(n));
}

export function canTidySection(s: MindNode | undefined): s is MindNode {
  return !!s && isSection(s) && !isLockedEffective(s) && sectionKids(s).length >= 2;
}

// The box keeps its size: only you resize a section.
export function tidySection(s: MindNode): void {
  apply('Tidied up', boxes => tidyGrid(boxes, SPACING, snapPt({ x: s.x + SECTION_FIT_PAD, y: s.y + SECTION_FIT_PAD })),
    2, sectionKids(s));
}

const ALIGN_NAME: Record<AlignEdge, string> = { left: 'left', center: 'centres', right: 'right', top: 'top', middle: 'middles', bottom: 'bottom' };
function alignSelection(edge: AlignEdge): void { apply(`Aligned ${ALIGN_NAME[edge]}`, boxes => align(boxes, edge)); }

function distributeSelection(axis: 'x' | 'y'): void {
  apply(axis === 'x' ? 'Spaced evenly across' : 'Spaced evenly down', boxes => distribute(boxes, axis), 3);
}

// Every selected plain CARD takes the widest one's width (sections and pictures size themselves).
function sameWidth(): void {
  const cards = targets().filter(n => n.type !== 'section' && !isImageCard(n));
  if (cards.length < 2) { setStatus('Select two or more cards'); return; }
  const w = Math.max(...cards.map(nodeW));
  mutate(cards.map(n => n.id), () => { for (const n of cards) { n.w = w; } },
    { reflow: 'remeasure', status: 'Same width' });
}

// FigJam's shortcuts.
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

// Grouped: tidy · align across · align down · space · size.
export function tidyMenuEntries(): Array<'sep' | { label: string; shortcut?: string; run: () => void; disabled?: boolean }> {
  const n = targets().length;
  const e = (i: number) => ({ ...TIDY_ACTIONS[i], disabled: n < (TIDY_ACTIONS[i].min ?? 2) });
  return [e(0), 'sep', e(1), e(2), e(3), 'sep', e(4), e(5), e(6), 'sep', e(7), e(8), 'sep', e(9)];
}

// By KEY CODE: ⌥ changes the character on a Mac, and elsewhere Alt+D reports `d` (Duplicate).
const ALT_KEYS: Record<string, number> = { KeyA: 1, KeyH: 2, KeyD: 3, KeyW: 4, KeyV: 5, KeyS: 6 };
const CTRL_ALT_KEYS: Record<string, number> = { KeyT: 0, KeyH: 7, KeyV: 8 };

export function tidyShortcut(e: KeyboardEvent): boolean {
  if (!e.altKey || e.metaKey || state.sel.size < 2) {
    return false;
  }
  const i = e.ctrlKey ? CTRL_ALT_KEYS[e.code] : (!e.shiftKey ? ALT_KEYS[e.code] : undefined);
  if (i === undefined) {
    return false;
  }
  e.preventDefault();
  TIDY_ACTIONS[i].run();
  return true;
}
