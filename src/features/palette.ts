// ============================================================
// The ⌘P command palette: the ONE place every action is listed, with its shortcut beside it, so the
// canvas can carry no permanent toolbar (docs/PRODUCT.md, principle 1) without anything becoming
// unreachable — and so a shortcut is learned by seeing it, every time the action is run from here.
//
// The palette only DISPLAYS commands; main.ts builds the list (paletteCommands), since that is where
// every action function is already in scope. A command's `when` hides it while it can't apply
// (nothing selected, read-only), rather than listing it disabled: a list of things you can't do is
// noise in a box you type into.
// ============================================================
import { byId } from '../utils/dom.js';
import { esc } from '../utils/markdown.js';

export interface Command {
  label: string;
  shortcut?: string;
  keywords?: string;           // extra words the filter matches, e.g. 'dark light' for the theme
  when?: () => boolean;
  run: () => void;
}

const root = byId('palette');
const input = byId<HTMLInputElement>('palInput');
const list = byId('palList');
let source: () => Command[] = () => [];
let shown: Command[] = [];
let active = 0;
let returnFocus: HTMLElement | null = null;

export function setPaletteSource(fn: () => Command[]): void { source = fn; }
export function paletteOpen(): boolean { return !root.hidden; }

export function openPalette(): void {
  if (paletteOpen()) { input.select(); return; }
  returnFocus = document.activeElement as HTMLElement | null;
  root.hidden = false;
  input.value = '';
  render();
  input.focus();
}
export function closePalette(): void {
  if (!paletteOpen()) return;
  root.hidden = true;
  returnFocus?.focus?.();
  returnFocus = null;
}

// Every query word must appear in the label or keywords; a label that STARTS with the query ranks
// first, so "un" puts Undo above "Collapse / unfold".
function matches(q: string): Command[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = source().filter(c => !c.when || c.when());
  if (!words.length) return all;
  const hay = (c: Command) => (c.label + ' ' + (c.keywords ?? '')).toLowerCase();
  const hits = all.filter(c => words.every(w => hay(c).includes(w)));
  const lead = q.trim().toLowerCase();
  return hits.sort((a, b) => Number(b.label.toLowerCase().startsWith(lead)) - Number(a.label.toLowerCase().startsWith(lead)));
}

function render(): void {
  shown = matches(input.value);
  active = Math.min(active, Math.max(0, shown.length - 1));
  if (!input.value) active = 0;
  list.innerHTML = shown.length
    ? shown.map((c, i) => `<div class="pal-item${i === active ? ' active' : ''}" role="option" data-i="${i}">`
        + `<span>${esc(c.label)}</span>${c.shortcut ? `<kbd>${esc(c.shortcut)}</kbd>` : ''}</div>`).join('')
    : '<div class="pal-empty">No matching command</div>';
  list.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' });
}
function run(i: number): void {
  const c = shown[i]; if (!c) return;
  closePalette();          // first, so the command acts on the canvas rather than on the palette's input
  c.run();
}

input.addEventListener('input', () => { active = 0; render(); });
input.addEventListener('keydown', (e) => {
  e.stopPropagation();     // the canvas shortcuts must not see what is typed here
  if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, shown.length); render(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); render(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
list.addEventListener('pointermove', (e) => {
  const item = (e.target as Element).closest('.pal-item') as HTMLElement | null;
  if (item && +item.dataset.i! !== active) { active = +item.dataset.i!; render(); }
});
list.addEventListener('click', (e) => {
  const item = (e.target as Element).closest('.pal-item') as HTMLElement | null;
  if (item) run(+item.dataset.i!);
});
// A press on the dimmed backdrop (not the box) closes it.
root.addEventListener('pointerdown', (e) => { if (e.target === root) closePalette(); });
