// ---------- the TAG TRAY: a sheet of stickers above the dock ----------
// Toggled from the dock's tag button or with T; whether it's out is remembered (localStorage — a
// convenience, not map data). It holds every tag on the board, most used first, then recently used ones
// no card carries any more, then any made here: type a word (or an emoji) into its last slot and it
// becomes a sticker, ready to drag onto a card — it lives only until the page reloads, unless a card
// takes it. Drag a sticker onto a card to tag it (features/tag-drag.ts); click one to find its cards
// (features/search.ts). Repainted from main.ts paintAll, keyed so an unchanged tray isn't rebuilt.
import { esc } from '../utils/markdown.js';
import { cleanTag, tagKey } from '../utils/tags.js';
import { byId } from '../utils/dom.js';
import { paintAll } from '../main.js';
import { boardTags, loadMru, pushMru } from './tag-picker.js';
import { tagFaceHTML, tagText } from './tags.js';
import { searchTags, toggleSearchTag } from './search.js';
import { beginTagDrag } from './tag-drag.js';

const KEY = 'corkboard.tagTray';
const btn = byId<HTMLButtonElement>('trayBtn');
const tray = document.createElement('div');
tray.id = 'tagTray';
tray.setAttribute('role', 'toolbar');
tray.setAttribute('aria-label', 'Tags');
tray.innerHTML = `<div class="tray-tags"></div><input class="tray-new" type="text" placeholder="+ new tag" aria-label="New tag" autocomplete="off" spellcheck="false">`;
document.body.appendChild(tray);
const list = tray.querySelector<HTMLElement>('.tray-tags')!;
const input = tray.querySelector<HTMLInputElement>('.tray-new')!;

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
  if (!trayOpen()) return;
  const board = boardTags();
  const counts = new Map(board.map(b => [tagKey(b.tag), b.count]));
  const tags: string[] = [];
  const add = (t: string): void => { if (!tags.some(x => tagKey(x) === tagKey(t))) tags.push(t); };
  board.forEach(b => add(b.tag)); loadMru().slice(0, 8).forEach(add); made.forEach(add);
  const k = tags.join('\u0000') + '\u0001' + board.map(b => b.count).join(',') + '\u0001' + searchTags().join('\u0000');
  if (k === key) return;
  key = k;
  list.innerHTML = tags.length ? tags.map(t => {
    const c = counts.get(tagKey(t)) ?? 0;
    return `<span class="tray-item" title="${esc(tagText(t))} · ${c} card${c === 1 ? '' : 's'} · drag onto a card, click to find">${tagFaceHTML(t)}</span>`;
  }).join('') : `<span class="tray-none">No tags yet — make one here, then drag it onto a card</span>`;
  list.querySelectorAll<HTMLElement>('.tag').forEach(el => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); beginTagDrag(e, el, el.dataset.tag!, null); });
    el.addEventListener('click', () => { if (!el.dataset.dragged) toggleSearchTag(el.dataset.tag!); });
  });
}

input.addEventListener('keydown', (e) => {
  e.stopPropagation();   // the canvas shortcuts stay out of it
  if (e.key === 'Enter') {
    e.preventDefault();
    const t = cleanTag(input.value);
    if (t) { if (!made.some(m => tagKey(m) === tagKey(t))) made = [...made, t]; pushMru(t); input.value = ''; paintAll(); }
  } else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; input.blur(); }
});
tray.addEventListener('pointerdown', (e) => e.stopPropagation());   // not a canvas pan or marquee
btn.addEventListener('click', () => toggleTray());

// after every module has loaded: the tray reads the search and the board
setTimeout(() => { try { if (localStorage.getItem(KEY)) toggleTray(true); } catch { /* closed, then */ } });
