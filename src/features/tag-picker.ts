// ---------- the `#` field: tag the selection, or pick tags to filter by ----------
// `#` (or ⌘P "Tag…") with cards selected opens a small field beside the selection. One list answers
// what you type, from two places:
//   · tags already on the board, with how many cards carry each;
//   · emoji BY NAME (utils/emoji-names.ts) — `fi` offers 🔥 fire.
// Anything else typed is a NEW tag (utils/tags.ts cleanTag makes it one). Below the list, the
// selection's own tags, ticked: untick one to remove it. That is the ONLY way a tag comes off — a chip
// on a card filters (features/search.ts), so a stray click can't delete one; dragging one off removes it
// too (features/tag-drag.ts). Tags written in the
// note's text show here too, but can't be unticked: they're the text's (edit the note instead).
// Recently used tags lead an empty field (localStorage — a convenience, not map data).
import { state, setStatus } from '../core/state.js';
import { isLockedEffective, nodesOf } from '../utils/model.js';
import { esc } from '../utils/markdown.js';
import { placeInViewport } from '../utils/dom.js';
import { allTags, noteTags, cleanTag, tagKey, wearsTags } from '../utils/tags.js';
import { emojiByName } from '../utils/emoji-names.js';
import { taggableSelection } from '../main.js';
import { setTagOnNodes, tagText } from './tags.js';
import { readStrings, writeJSON } from '../utils/local-json.js';

const MRU_KEY = 'corkboard.tagMru';
export const loadMru = (): string[] => readStrings(MRU_KEY);
export function dropMru(tag: string): void { writeJSON(MRU_KEY, loadMru().filter(t => tagKey(t) !== tagKey(tag))); }
export function pushMru(tag: string): void {
  writeJSON(MRU_KEY, [tag, ...loadMru().filter(t => tagKey(t) !== tagKey(tag))].slice(0, 16));   // private window: no recents
}

// Every tag on the board, most used first.
export function boardTags(): Array<{ tag: string; count: number }> {
  const by = new Map<string, { tag: string; count: number }>();
  for (const n of state.nodes.values()) {
    if (!wearsTags(n)) continue;
    for (const t of allTags(n)) { const e = by.get(tagKey(t)); if (e) e.count++; else by.set(tagKey(t), { tag: t, count: 1 }); }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

type Act = 'add' | 'remove';
interface Row { act: Act | null; tag: string; name: string; meta: string; ticked: boolean; }
interface Section { title: string; rows: Row[]; }

const pop = document.createElement('div');
pop.id = 'tagPop';
pop.innerHTML = `<label class="tp-field"><span class="tp-hash">#</span><input type="text" autocomplete="off" spellcheck="false" aria-label="Tag"></label>
  <div class="tp-list" role="listbox"></div><div class="tp-hint"></div>`;
document.body.appendChild(pop);
const input = pop.querySelector('input')!;
const list = pop.querySelector<HTMLElement>('.tp-list')!;
const hint = pop.querySelector<HTMLElement>('.tp-hint')!;

let targets: string[] = [];
let rows: Row[] = [];       // the actionable rows, in screen order — what ↑↓ walk
let active = 0;

export const tagPickerOpen = (): boolean => pop.classList.contains('open');

const row = (act: Act | null, tag: string, meta = '', ticked = false, name = tagText(tag)): Row => ({ act, tag, name, meta, ticked });
const plural = (n: number): string => `${n} card${n === 1 ? '' : 's'}`;

function sections(): Section[] {
  const q = input.value.trim().replace(/^#+/, '');
  const qk = q.toLowerCase();
  const board = boardTags();
  const nodes = nodesOf(targets);
  // the selection's own tags: frontmatter ones can be unticked, the text's can't
  const mine = new Map<string, Row>();
  for (const n of nodes) for (const t of noteTags(n)) {
    const k = tagKey(t.tag), had = mine.get(k);
    if (!had || (had.act === null && !t.inText)) mine.set(k, row(t.inText ? null : 'remove', t.tag, t.inText ? 'in the text' : '', true));
  }
  const free = (t: string): boolean => !mine.has(tagKey(t));
  const out: Section[] = [];
  if (!qk) {
    const recent = loadMru().filter(free).slice(0, 5);
    const seen = new Set(recent.map(tagKey));
    const more = board.filter(b => free(b.tag) && !seen.has(tagKey(b.tag))).slice(0, 6);
    if (recent.length) out.push({ title: 'Recent', rows: recent.map(t => row('add', t)) });
    if (more.length) out.push({ title: 'On the board', rows: more.map(b => row('add', b.tag, plural(b.count))) });
  } else {
    const typed = cleanTag(q);
    const exact = board.some(b => tagKey(b.tag) === tagKey(typed)) || !free(typed);
    const starts = board.filter(b => free(b.tag) && tagKey(b.tag).startsWith(qk));
    const inside = board.filter(b => free(b.tag) && !tagKey(b.tag).startsWith(qk) && tagKey(b.tag).includes(qk));
    const emoji = emojiByName(qk).filter(e => free(e.emoji));
    const named = emoji.filter(e => e.name.startsWith(qk)), worded = emoji.filter(e => !e.name.startsWith(qk));
    const byBoard = new Map(board.map(b => [b.tag, b.count]));
    const em = (e: { emoji: string; name: string }): Row =>
      row('add', e.emoji, byBoard.has(e.emoji) ? plural(byBoard.get(e.emoji)!) : 'emoji', false, `${e.emoji}  ${e.name}`);
    const hits = [...starts.map(b => row('add', b.tag, plural(b.count))), ...named.map(em),
      ...(typed && !exact ? [row('add', typed, 'new tag')] : []), ...worded.map(em),
      ...inside.map(b => row('add', b.tag, plural(b.count)))].slice(0, 8);
    out.push({ title: 'Matches', rows: hits });
  }
  if (mine.size) out.push({ title: nodes.length > 1 ? 'On the selection' : 'On this card', rows: [...mine.values()] });
  return out;
}

function render(): void {
  const secs = sections();
  rows = [];
  let html = '';
  for (const s of secs) {
    if (!s.rows.length) continue;
    html += `<div class="tp-sec">${esc(s.title)}</div>`;
    for (const r of s.rows) {
      const i = r.act ? rows.push(r) - 1 : -1;
      html += `<button type="button" class="tp-row${r.ticked ? ' ticked' : ''}" role="option"${i < 0 ? ' disabled' : ` data-i="${i}"`}>` +
        `<span class="tp-tick" aria-hidden="true"></span><span class="tp-name">${esc(r.name)}</span><span class="tp-meta">${esc(r.meta)}</span></button>`;
    }
  }
  list.innerHTML = html || `<div class="tp-none">Type a tag, or an emoji’s name</div>`;
  active = Math.min(active, Math.max(0, rows.length - 1));
  markActive();
  hint.textContent = '↵ add · untick to remove · esc close';
}
function markActive(): void {
  list.querySelectorAll<HTMLElement>('.tp-row[data-i]').forEach(el => el.classList.toggle('active', +el.dataset.i! === active));
  list.querySelector('.tp-row.active')?.scrollIntoView({ block: 'nearest' });
}

function run(r: Row | undefined): void {
  if (!r?.act) return;
  setTagOnNodes(targets, r.tag, r.act === 'add');
  if (r.act === 'add') pushMru(r.tag);
  input.value = '';
  render();
  input.focus();
}

input.addEventListener('input', () => { active = 0; render(); });
input.addEventListener('keydown', (e) => {
  e.stopPropagation();   // the canvas shortcuts stay out of it
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (rows.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; markActive(); }
  } else if (e.key === 'Enter') { e.preventDefault(); run(rows[active]); }
  else if (e.key === 'Escape') { e.preventDefault(); closeTagPicker(); }
});
list.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the focus in the field
list.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('.tp-row[data-i]');
  if (b) run(rows[+b.dataset.i!]);
});
function onOutside(e: PointerEvent): void { if (!pop.contains(e.target as Node)) closeTagPicker(); }

export function closeTagPicker(): void {
  if (!tagPickerOpen()) return;
  pop.classList.remove('open');
  document.removeEventListener('pointerdown', onOutside, true);
  input.blur();
}
function open(place: () => void): void {
  active = 0; input.value = '';
  input.placeholder = 'Tag, or an emoji’s name';
  pop.classList.add('open');
  render();
  place();
  document.addEventListener('pointerdown', onOutside, true);
  input.focus();
}

// `#`: tag the selected cards. Beside the selection's anchor card, else the first selected one.
export function openTagPicker(): void {
  if (state.readOnly) return;
  const ids = taggableSelection();
  if (!ids.length) { setStatus(state.sel.size ? 'Tags go on cards, not frames' : 'Select a card to tag'); return; }
  const editable = ids.filter(id => !isLockedEffective(state.nodes.get(id)!));
  if (!editable.length) { setStatus('Locked — can’t change its tags'); return; }
  targets = editable;
  const anchor = state.nodes.get(state.selId && editable.includes(state.selId) ? state.selId : editable[0])!.el;
  open(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) { placeInViewport(pop, (window.innerWidth - pop.offsetWidth) / 2, 80); return; }
    const right = r.right + 14 + pop.offsetWidth <= window.innerWidth;
    placeInViewport(pop, right ? r.right + 14 : r.left - 14 - pop.offsetWidth, r.top - 8);
  });
}
