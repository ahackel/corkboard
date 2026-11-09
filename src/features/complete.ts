// ---------- the card editor offers names: `[[` a card, `#` a tag ----------
// Typing `[[` in a note lists the map's cards, and `#word` its tags, in a small list under the caret — a
// link has to name its card exactly, and a tag is only worth having if it's spelt like the others. What
// counts as "typing a link/tag" is pure (utils/md-edit.ts completingAt); this is the list. It is not a
// toolbar: it exists only while a name is being typed, and Esc or typing on past it puts it away.
// ↑/↓ choose, Enter or Tab writes the choice, a click does too.
import { state } from '../core/state.js';
import { nodeLabel, parentOf } from '../utils/model.js';
import { esc } from '../utils/markdown.js';
import { completingAt, completeAt, type Completing, type TextEdit } from '../utils/md-edit.js';
import { boardTags } from './tag-picker.js';

interface Option { insert: string; label: string; hint: string }
const MAX = 8;

// What `[[` can link to: every card and section but the one being edited. Its TITLE when that names one
// card only, else its PATH (`Ideas/Plan`), the one name that can't be ambiguous (utils/model.ts resolveWikilink).
function linkOptions(query: string, selfId: string): Option[] {
  const titles = new Map<string, number>();
  for (const n of state.nodes.values()) {
    const t = n.title.trim().toLowerCase();
    if (t) {
      titles.set(t, (titles.get(t) ?? 0) + 1);
    }
  }
  const out: Option[] = [];
  for (const n of state.nodes.values()) {
    const title = n.title.trim(), path = n.file?.replace(/\.md$/i, '');
    const insert = title && (titles.get(title.toLowerCase()) === 1 || !path) ? title : path;
    if (n.id === selfId || !insert) {
      continue;
    }
    const p = parentOf(n);
    out.push({ insert, label: nodeLabel(n), hint: p ? nodeLabel(p) : '' });
  }
  return ranked(out, query);
}
function tagOptions(query: string): Option[] {
  return ranked(boardTags().map(t => ({ insert: t.tag, label: '#' + t.tag, hint: String(t.count) })), query);
}
// Those whose name holds the query, the ones it STARTS first, then shortest; at most MAX.
function ranked(all: Option[], query: string): Option[] {
  const q = query.trim().toLowerCase();
  const score = (o: Option): number => {
    const l = o.label.replace(/^#/, '').toLowerCase(), i = o.insert.toLowerCase();
    return l.startsWith(q) || i.startsWith(q) ? 0 : l.includes(q) || i.includes(q) ? 1 : -1;
  };
  return all.map(o => ({ o, s: score(o) })).filter(x => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.o.label.length - b.o.label.length || a.o.label.localeCompare(b.o.label))
    .slice(0, MAX).map(x => x.o);
}

const pop = document.createElement('div');
pop.className = 'md-complete';
pop.id = 'mdComplete';
pop.setAttribute('role', 'listbox');
document.body.appendChild(pop);
// A press on the list must not take focus from the textarea: a blur ends the edit.
pop.addEventListener('pointerdown', (e) => e.preventDefault());
pop.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.mc-row');
  if (row) {
    pick(+(row.dataset.i ?? 0));
  }
});

interface Open { ta: HTMLTextAreaElement; at: Completing; options: Option[]; active: number; apply: (r: TextEdit) => void }
let open: Open | null = null;
let picking = false;
// Esc puts the list away for the name being typed there; it comes back for the next one.
let dismissedFrom = -1;

export function closeCompletion(): void {
  if (open) {
    open.ta.removeAttribute('aria-activedescendant');
    open.ta.setAttribute('aria-expanded', 'false');
  }
  open = null;
  pop.classList.remove('open');
}
// Look at the caret again (after typing, or a caret move) and show, move or put away the list. `caretAt` is
// where the caret's line is on screen; `apply` writes an edit into the textarea the editor's own way.
export function updateCompletion(ta: HTMLTextAreaElement, selfId: string, caretAt: () => { left: number; bottom: number },
                                 apply: (r: TextEdit) => void): void {
  if (picking) {
    return;
  }
  const at = ta.selectionStart === ta.selectionEnd ? completingAt(ta.value, ta.selectionStart) : null;
  if (!at || at.from === dismissedFrom) {
    closeCompletion();
    return;
  }
  dismissedFrom = -1;
  const options = at.kind === 'link' ? linkOptions(at.query, selfId) : tagOptions(at.query);
  if (!options.length) {
    closeCompletion();
    return;
  }
  const keep = open && open.at.from === at.from ? Math.min(open.active, options.length - 1) : 0;
  open = { ta, at, options, active: keep, apply };
  ta.setAttribute('aria-autocomplete', 'list');
  ta.setAttribute('aria-controls', pop.id);
  ta.setAttribute('aria-expanded', 'true');
  render();
  const c = caretAt(), w = pop.offsetWidth, h = pop.offsetHeight;
  const below = c.bottom + 4 + h <= window.innerHeight - 8;
  pop.style.left = Math.max(8, Math.min(c.left - 8, window.innerWidth - w - 8)) + 'px';
  pop.style.top = (below ? c.bottom + 4 : Math.max(8, c.bottom - h - 28)) + 'px';
}
function render(): void {
  if (!open) {
    return;
  }
  const o = open;
  pop.innerHTML = o.options.map((x, i) =>
    `<div class="mc-row${i === o.active ? ' active' : ''}" role="option" id="mc-${i}" data-i="${i}" aria-selected="${i === o.active}">`
    + `<span class="mc-label">${esc(x.label)}</span>${x.hint ? `<span class="mc-hint">${esc(x.hint)}</span>` : ''}</div>`).join('');
  pop.classList.add('open');
  o.ta.setAttribute('aria-activedescendant', `mc-${o.active}`);
  pop.querySelector('.mc-row.active')?.scrollIntoView({ block: 'nearest' });
}
function pick(i: number): void {
  const o = open, choice = o?.options[i];
  if (!o || !choice) {
    return;
  }
  closeCompletion();
  picking = true;
  try {
    o.apply(completeAt(o.ta.value, o.at, o.ta.selectionStart, choice.insert));
  } finally {
    picking = false;
  }
}
// The list's keys, while it is up. True when the key was its, and the editor must not act on it too.
export function completionKey(e: KeyboardEvent): boolean {
  if (!open || e.metaKey || e.ctrlKey || e.altKey) {
    return false;
  }
  const n = open.options.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    open.active = (open.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    render();
  } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
    pick(open.active);
  } else if (e.key === 'Escape') {
    dismissedFrom = open.at.from;
    closeCompletion();
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}
