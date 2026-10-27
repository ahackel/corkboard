// ---------- FIND: one field for text and tags (⌘F, or /) ----------
// The query is TAG CHIPS plus TEXT. A card matches when it carries every chip's tag (utils/tags.ts
// hasTag — Obsidian's rules, a parent matching its nested tags) and its title or body holds the text.
// Typing `#` suggests the board's tags (and its emoji, by name); picking one — or a space after a
// typed `#word` — makes it a chip. A click on a tag anywhere (a card's edge, its text, the tag tray)
// adds or removes that chip.
//
// Every non-match FADES (state.searchMatch, applied in paintNode): matches stay lit, and so do the
// frames holding them; a match tucked inside a FOLDED frame lights that frame, which says how many it
// holds (searchHitsIn). The match set is DERIVED on every paint (main.ts paintAll → refreshSearch), so
// tagging a card while searching takes effect at once. The dropdown lists the matching cards; ↓/Enter
// jump to one. The field stays while a query is in it — a filter you can work under — and goes with
// Esc or its ×.
import { state, type MindNode } from '../core/state.js';
import { esc } from '../utils/markdown.js';
import { nodeLabel, disambiguatedLabel, duplicateLabels, firstVisible, ancestors } from '../utils/model.js';
import { allTags, hasTag, tagKey, cleanTag, wearsTags } from '../utils/tags.js';
import { emojiByName } from '../utils/emoji-names.js';
import { outOfScope } from '../nav/scope.js';
import { paintAll, focusNode } from '../main.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { byId } from '../utils/dom.js';
import { tagText, tagChipHTML } from './tags.js';
import { boardTags } from './tag-picker.js';

export const searchBox = byId<HTMLInputElement>('searchBox');
const searchWrap = byId('searchWrap');
const searchResults = byId('searchResults');
const searchClear = byId<HTMLButtonElement>('searchClear');
const chipsEl = document.createElement('span');
chipsEl.id = 'searchChips';
searchWrap.insertBefore(chipsEl, searchBox);

let chips: string[] = [];                 // the tags of the query
let cardHits: MindNode[] = [];            // the dropdown's cards
let tagRows: string[] = [];               // …or, while a `#word` is being typed, its tag suggestions
let active = -1;
let hits = new Map<string, number>();     // a hidden match counted on the visible frame holding it

// Does the open result list point at this node? Nothing a result points at may be let go of.
export function searchHolds(id: string): boolean { return cardHits.some(h => h.id === id); }
export const searchTags = (): readonly string[] => chips;
export const searchActive = (): boolean => chips.length > 0 || !!searchBox.value.trim();
export const searchHitsIn = (id: string): number => hits.get(id) ?? 0;

// The whole query as one line — chips as `#tag` — for the URL (nav/url-state.ts); and back.
export function searchQuery(): string {
  return [...chips.map(t => '#' + t), searchBox.value.trim()].filter(Boolean).join(' ');
}
export function setSearchQuery(q: string): void {
  const words = q.trim().split(/\s+/);
  chips = words.filter(w => w.length > 1 && w.startsWith('#')).map(w => cleanTag(w)).filter(Boolean);
  searchBox.value = words.filter(w => !(w.length > 1 && w.startsWith('#'))).join(' ');
  openSearch();
  runSearch();
}

// Open the bar and focus the field — `prefill` lands in it (`#` from the `#` key with nothing selected).
export function openSearch(prefill?: string): void {
  searchWrap.classList.add('open');
  if (prefill != null) { searchBox.value = prefill; runSearch(); }
  searchBox.focus();
  if (prefill == null) searchBox.select();
}
export function closeSearch(): void {
  searchBox.value = ''; chips = [];
  renderChips();
  clearResults();
  searchWrap.classList.remove('open');
  paintAll();
  scheduleUrlSync();
}
// A tag clicked anywhere: into the query, or back out of it.
export function toggleSearchTag(tag: string): void {
  const k = tagKey(tag);
  chips = chips.some(t => tagKey(t) === k) ? chips.filter(t => tagKey(t) !== k) : [...chips, tag];
  if (!searchActive()) { closeSearch(); return; }
  searchWrap.classList.add('open');
  renderChips();
  runSearch(false);
}

function renderChips(): void {
  chipsEl.innerHTML = chips.map(t => `<button type="button" class="sc-tag" data-tag="${esc(t)}" title="Take ${esc(tagText(t))} out of the search">` +
    `${esc(tagText(t))}<span class="sc-x" aria-hidden="true">✕</span></button>`).join('');
  searchWrap.classList.toggle('has-chips', chips.length > 0);
  searchBox.placeholder = chips.length ? 'and text…' : 'Find a card, or #tag…';
}
chipsEl.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the focus where it is
chipsEl.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('.sc-tag');
  if (b) toggleSearchTag(b.dataset.tag!);
});

// The text part of the query, and a `#word` being typed at its end (null when there isn't one).
function parts(): { text: string; typing: string | null } {
  const v = searchBox.value;
  const m = v.match(/(?:^|\s)#(\S*)$/);
  return { text: (m ? v.slice(0, m.index) : v).trim().toLowerCase(), typing: m ? m[1] : null };
}

// What the query lights — derived from the tags and text as they are NOW. Cheap with no query.
export function refreshSearch(): void {
  const { text } = parts();
  if (!chips.length && !text) { state.searchMatch = null; hits = new Map(); return; }
  const lit = new Set<string>(), held = new Map<string, number>();
  for (const n of state.nodes.values()) {
    if (!matches(n, text)) continue;
    const rep = firstVisible(n);
    lit.add(rep.id);
    if (rep !== n) held.set(rep.id, (held.get(rep.id) ?? 0) + 1);
    for (const p of ancestors(rep)) lit.add(p.id);   // the frames around a match stay lit around it
  }
  state.searchMatch = lit;
  hits = held;
}
function matches(n: MindNode, text: string): boolean {
  if (outOfScope(n)) return false;
  if (chips.length && (!wearsTags(n) || !chips.every(c => hasTag(allTags(n), c)))) return false;
  return !text || nodeLabel(n).toLowerCase().includes(text) || (!!n.body && n.body.toLowerCase().includes(text));
}

// The query changed: recompute, and rebuild the dropdown (when the field has the focus).
export function runSearch(showList = true): void {
  searchBox.classList.toggle('has-value', !!searchBox.value);
  const { text, typing } = parts();
  if (!searchActive()) { clearResults(); paintAll(); scheduleUrlSync(); return; }
  paintAll();   // → refreshSearch
  tagRows = typing != null ? tagSuggestions(typing) : [];
  if (typing == null) {
    const found: { n: MindNode; label: string; onLabel: boolean }[] = [];
    for (const n of state.nodes.values()) {
      if (!matches(n, text)) continue;
      const label = nodeLabel(n);
      found.push({ n, label, onLabel: !!text && label.toLowerCase().includes(text) });
    }
    // title matches first, then body-only matches, alphabetical within each
    found.sort((a, b) => a.onLabel !== b.onLabel ? (a.onLabel ? -1 : 1) : a.label.localeCompare(b.label));
    cardHits = found.slice(0, 12).map(f => f.n);
    active = cardHits.length ? 0 : -1;
    const dup = duplicateLabels();
    searchResults.innerHTML = `<div class="sr-count">${found.length} card${found.length === 1 ? '' : 's'}</div>` + (cardHits.length
      ? cardHits.map((n, i) => `<button class="sr-item${i === active ? ' active' : ''}" data-id="${n.id}">${esc(disambiguatedLabel(n, dup))}</button>`).join('')
      : '<div class="sr-none">No card matches</div>');
  } else {
    cardHits = [];
    active = tagRows.length ? 0 : -1;
    searchResults.innerHTML = tagRows.length
      ? tagRows.map((t, i) => `<button class="sr-item sr-tag${i === active ? ' active' : ''}" data-tag="${esc(t)}">${tagChipHTML({ tag: t, inText: false })}<span class="sr-meta">${countOf(t)}</span></button>`).join('')
      : '<div class="sr-none">No tag like that on the board</div>';
  }
  searchResults.classList.toggle('open', showList && document.activeElement === searchBox);
  markActive();
  scheduleUrlSync();
}
const countOf = (t: string): string => { const b = boardTags().find(x => tagKey(x.tag) === tagKey(t)); return b ? `${b.count}` : ''; };
// The board's tags for a `#word` being typed: those starting with it, then its emoji by name, then the rest
// holding it. Only tags some card carries — a filter on any other would light nothing.
function tagSuggestions(q: string): string[] {
  const k = q.toLowerCase(), on = new Set(chips.map(tagKey));
  const board = boardTags().filter(b => !on.has(tagKey(b.tag))).map(b => b.tag);
  if (!k) return board.slice(0, 10);
  const emoji = new Set(emojiByName(k, 12).map(e => e.emoji));
  return [...board.filter(t => tagKey(t).startsWith(k)), ...board.filter(t => emoji.has(t)),
    ...board.filter(t => !tagKey(t).startsWith(k) && tagKey(t).includes(k))].filter((t, i, a) => a.indexOf(t) === i).slice(0, 10);
}
// Point state.searchActiveId at the active option's (visible) card so paintNode outlines it.
function markActive(): void {
  [...searchResults.querySelectorAll('.sr-item')].forEach((el, i) => el.classList.toggle('active', i === active));
  const hit = cardHits[active];
  const id = hit ? firstVisible(hit).id : null;
  if (state.searchActiveId !== id) { state.searchActiveId = id; paintAll(); }
}
function clearResults(): void {
  searchResults.classList.remove('open'); searchResults.innerHTML = '';
  cardHits = []; tagRows = []; active = -1;
  searchBox.classList.toggle('has-value', !!searchBox.value);
  state.searchActiveId = null;
}
// Make the `#word` being typed (or the suggestion picked for it) a chip.
function chipFromTyping(tag?: string): boolean {
  const { typing } = parts();
  const t = tag ?? (typing ? cleanTag(typing) : '');
  if (!t) return false;
  searchBox.value = searchBox.value.replace(/(?:^|\s)#\S*$/, '').trimEnd();
  if (!chips.some(c => tagKey(c) === tagKey(t))) chips = [...chips, t];
  renderChips();
  runSearch();
  return true;
}
function gotoHit(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  closeSearch();   // jumping to a card dismisses the search
  focusNode(n, true);   // reveal ancestors level by level AND open the hit itself
}

searchBox.addEventListener('input', () => {
  // a space right after a `#word` makes it a chip, the way a tag field does
  if (/(?:^|\s)#\S+\s$/.test(searchBox.value)) { searchBox.value = searchBox.value.trimEnd(); if (chipFromTyping()) return; }
  runSearch();
});
searchBox.addEventListener('focus', () => { if (searchActive()) runSearch(); });
searchBox.addEventListener('keydown', (e: KeyboardEvent) => {
  const rows = tagRows.length || parts().typing != null ? tagRows.length : cardHits.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if (!rows) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows) % rows;
    markActive();
  } else if (e.key === 'Enter'){
    e.preventDefault();
    e.stopPropagation();   // don't let Enter reach the window handler (it would create a sibling)
    if (parts().typing != null) { chipFromTyping(tagRows[active]); return; }
    const hit = cardHits[active];
    if (hit) gotoHit(hit.id);
  } else if (e.key === 'Backspace' && !searchBox.value && chips.length){
    e.preventDefault();
    chips = chips.slice(0, -1); renderChips(); runSearch();
  } else if (e.key === 'Escape'){
    e.preventDefault();
    e.stopPropagation();
    // one step at a time: the text, then the chips, then the field
    if (searchBox.value){ searchBox.value = ''; runSearch(); }
    else if (chips.length){ chips = []; renderChips(); runSearch(); }
    else closeSearch();
  }
});
searchResults.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the focus in the field
searchResults.addEventListener('click', (e: MouseEvent) => {
  const item = (e.target as Element).closest<HTMLElement>('.sr-item');
  if (!item) return;
  if (item.dataset.tag) chipFromTyping(item.dataset.tag);
  else gotoHit(item.dataset.id!);
});
// clear-or-close, exactly like Escape — but all at once: the × means "done searching".
searchClear.addEventListener('click', () => closeSearch());
// A click elsewhere: an EMPTY field closes; one with a query in it stays, its list folded away, so the
// board can be worked on under the filter.
document.addEventListener('pointerdown', (e: PointerEvent) => {
  if (!searchWrap.classList.contains('open')) return;
  if ((e.target as Element).closest('#searchWrap')) return;
  if (!searchActive()) closeSearch();
  else { searchResults.classList.remove('open'); searchBox.blur(); }
});
renderChips();
