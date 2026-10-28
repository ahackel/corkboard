// ---------- the TAG TRAY: a sheet of stickers above the dock ----------
// Toggled from the dock's tag button or with T; whether it's out is remembered (localStorage — a
// convenience, not map data). It holds every tag on the board, most used first, then recently used ones
// no card carries any more, then any made here. Its last slot MAKES one: type a word, or an emoji's NAME
// (`fire` offers 🔥, utils/emoji-names.ts — a list pops up above the slot, as in the `#` field), or paste an
// emoji; it becomes a sticker, ready to drag onto a card — it lives only until the page reloads, unless a
// card takes it. Drag a sticker onto a card to tag it (features/tag-drag.ts); click one to find its cards
// (features/search.ts); drag one off onto the bare board to DELETE the tag — from every card that carries
// it, after asking when any does (one undo step). Repainted from main.ts paintAll, keyed so an unchanged
// tray isn't rebuilt.
import { esc } from '../utils/markdown.js';
import { cleanTag, tagKey, isEmojiTag, noteTags, wearsTags, uniqueTags } from '../utils/tags.js';
import { emojiByName } from '../utils/emoji-names.js';
import { state, type MindNode } from '../core/state.js';
import { byId } from '../utils/dom.js';
import { paintAll } from '../main.js';
import { boardTags, loadMru, pushMru, dropMru } from './tag-picker.js';
import { tagFaceHTML, tagText, retag } from './tags.js';
import { searchTags, toggleSearchTag } from './search.js';
import { beginTagDrag, puff } from './tag-drag.js';

const KEY = 'corkboard.tagTray';
const btn = byId<HTMLButtonElement>('trayBtn');
const tray = document.createElement('div');
tray.id = 'tagTray';
tray.setAttribute('role', 'toolbar');
tray.setAttribute('aria-label', 'Tags');
tray.innerHTML = `<div class="tray-tags"></div><span class="tray-make"><input class="tray-new" type="text" placeholder="+ tag or emoji"` +
  ` aria-label="New tag: a word, or an emoji’s name" autocomplete="off" spellcheck="false"><span class="tray-suggest" role="listbox"></span></span>`;
document.body.appendChild(tray);
const list = tray.querySelector<HTMLElement>('.tray-tags')!;
const input = tray.querySelector<HTMLInputElement>('.tray-new')!;
const suggest = tray.querySelector<HTMLElement>('.tray-suggest')!;

let made: string[] = [];   // stickers made here that no card carries yet
let key = '';

export const trayOpen = (): boolean => tray.classList.contains('open');
export function toggleTray(on = !trayOpen()): void {
  tray.classList.toggle('open', on);
  btn.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(KEY, on ? '1' : ''); } catch { /* nothing lost */ }
  key = '';
  refreshTray();
}

export function refreshTray(): void {
  if (!trayOpen()) {
    return;
  }
  const board = boardTags();
  const counts = new Map(board.map(b => [tagKey(b.tag), b.count]));
  const tags = uniqueTags([...board.map(b => b.tag), ...loadMru().slice(0, 8), ...made]);
  const k = tags.join('\u0000') + '\u0001' + board.map(b => b.count).join(',') + '\u0001' + searchTags().join('\u0000');
  if (k === key) {
    return;
  }
  key = k;
  list.innerHTML = tags.length ? tags.map(t => {
    const c = counts.get(tagKey(t)) ?? 0;
    return `<span class="tray-item" title="${esc(tagText(t))} · ${c} card${c === 1 ? '' : 's'} · drag onto a card, click to find">${tagFaceHTML(t)}</span>`;
  }).join('') : `<span class="tray-none">No tags yet — make one here, then drag it onto a card</span>`;
  list.querySelectorAll<HTMLElement>('.tag').forEach(el => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); beginTagDrag(e, el, el.dataset.tag!, null, (x, y) => deleteTag(el.dataset.tag!, x, y)); });
    el.addEventListener('click', () => {
      if (!el.dataset.dragged) {
        toggleSearchTag(el.dataset.tag!);
      }
    });
  });
}

// ---- making a sticker: a word, or an emoji found by its name ----
let options: string[] = [], active = 0;
function makeOptions(): void {
  const q = input.value.trim().replace(/^#+/, ''), k = q.toLowerCase();
  const typed = cleanTag(q);
  if (!typed) { options = []; renderSuggest(); return; }
  const found = emojiByName(k, 8);
  const named = found.filter(e => e.name.startsWith(k)).map(e => e.emoji), worded = found.filter(e => !e.name.startsWith(k)).map(e => e.emoji);
  // an emoji whose NAME starts with what's typed comes first (`fi` → 🔥); then the word itself
  options = [...new Set([...named, typed, ...worded])];
  active = 0;
  renderSuggest();
}
function renderSuggest(): void {
  const names = new Map(emojiByName(input.value.trim().toLowerCase(), 8).map(e => [e.emoji, e.name]));
  suggest.innerHTML = options.map((t, i) => `<button type="button" class="tp-row${i === active ? ' active' : ''}" data-i="${i}">` +
    `<span class="tp-name">${esc(tagText(t))}${isEmojiTag(t) && names.has(t) ? `  ${esc(names.get(t)!)}` : ''}</span>` +
    `<span class="tp-meta">${isEmojiTag(t) ? 'emoji' : 'new tag'}</span></button>`).join('');
  suggest.classList.toggle('open', options.length > 0);
}
function make(t: string | undefined): void {
  if (!t) {
    return;
  }
  if (!made.some(m => tagKey(m) === tagKey(t))) {
    made = [...made, t];
  }
  pushMru(t);
  input.value = ''; options = []; renderSuggest();
  paintAll();
}
input.addEventListener('input', makeOptions);
input.addEventListener('keydown', (e) => {
  e.stopPropagation();   // the canvas shortcuts stay out of it
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    renderSuggest();
  } else if (e.key === 'Enter') { e.preventDefault(); make(options[active]); }
  else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; options = []; renderSuggest(); input.blur(); }
});
input.addEventListener('blur', () => { options = []; renderSuggest(); });
suggest.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the focus in the slot
suggest.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('.tp-row');
  if (b) {
    make(options[+b.dataset.i!]);
  }
});

// ---- a sticker dragged off onto the board: the tag is DELETED — off the tray, and off every card whose
// frontmatter carries it, after asking when any does. Tags written in a note's text stay: they're the
// text's (the tray then keeps showing it, for those cards). ----
function deleteTag(tag: string, x: number, y: number): void {
  const k = tagKey(tag);
  const own: MindNode[] = [], inText: MindNode[] = [];
  for (const n of state.nodes.values()) {
    if (!wearsTags(n)) {
      continue;
    }
    const t = noteTags(n).find(s => tagKey(s.tag) === k);
    if (t) {
      (t.inText ? inText : own).push(n);
    }
  }
  if (own.length) {
    const msg = `Remove ${tagText(tag)} from ${own.length} card${own.length === 1 ? '' : 's'}?` +
      (inText.length ? `\n${inText.length} more ha${inText.length === 1 ? 's' : 've'} it written in the text — those stay.` : '') +
      `\n⌘Z puts it back.`;
    if (state.readOnly || !confirm(msg)) {
      return;
    }
    retag(own.map(n => ({ id: n.id, tag, on: false })));
  }
  made = made.filter(m => tagKey(m) !== k);
  dropMru(tag);
  puff(x, y);
  key = '';
  paintAll();
}

tray.addEventListener('pointerdown', (e) => e.stopPropagation());   // not a canvas pan or marquee
btn.addEventListener('click', () => toggleTray());

// after every module has loaded: the tray reads the search and the board
setTimeout(() => { try {
  if (localStorage.getItem(KEY)) {
    toggleTray(true);
  }
} catch { /* closed, then */ } });
