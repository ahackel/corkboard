// ---------- FIND: one field for text and tags (⌘F, or /) ----------
// The query is TAG CHIPS plus TEXT. A card matches when it carries every chip's tag (utils/tags.ts
// hasTag — Obsidian's rules, a parent matching its nested tags) and its title or body holds the text.
// Typing `#` suggests the board's tags (and its emoji, by name); picking one — or a space after a
// typed `#word` — makes it a chip. A click on a tag anywhere (a card's edge, its text, the tag tray)
// adds or removes that chip.
//
// Every non-match FADES (state.searchMatch, applied in paintNode): matches stay lit, and so do the
// sections holding them; a match tucked inside a FOLDED section lights that section, which says how many it
// holds (searchHitsIn). The match set is DERIVED on every paint (main.ts paintAll → refreshSearch), so
// tagging a card while searching takes effect at once. The dropdown lists the matching cards; ↓/Enter
// jump to one. "2/5" and its chevrons (FigJam's) step through every match, framing each on the canvas
// without ending the search. The field stays while a query is in it — a filter you can work under — and
// goes with Esc or its ×. A FOLDED section never read can't say what it holds, so a search reads them all
// (data/lazy.ts readAll) and keeps them while it is up (searchHolds).
import { state, isStack, type MindNode } from '../core/state.js';
import { esc } from '../utils/markdown.js';
import { nodeLabel, disambiguatedLabel, duplicateLabels, firstVisible, ancestors, parentOf } from '../utils/model.js';
import { allTags, hasTag, tagKey, cleanTag, wearsTags } from '../utils/tags.js';
import { emojiByName } from '../utils/emoji-names.js';
import { outOfScope, isScopeRoot } from '../nav/scope.js';
import { openSection, popScopeFor } from '../nav/sections.js';
import { paintAll } from '../main.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { byId } from '../utils/dom.js';
import { tagText, tagChipHTML } from './tags.js';
import { boardTags } from './tag-picker.js';
import { focusNode } from '../nav/focus.js';
import { frameBox } from '../view/camera.js';
import { afterReading } from '../data/lazy.js';
import { ui } from '../core/ui-state.js';
import { openFan } from './stacks.js';
import { setSelectionSet } from './selection.js';
import { clearEdgeSelection } from './edge-tools.js';

const searchBox = byId<HTMLInputElement>('searchBox');
const searchWrap = byId('searchWrap');
const searchResults = byId('searchResults');
const searchClear = byId<HTMLButtonElement>('searchClear');
const searchCount = byId('searchCount');
const searchPrev = byId<HTMLButtonElement>('searchPrev');
const searchNext = byId<HTMLButtonElement>('searchNext');
const chipsEl = document.createElement('span');
chipsEl.id = 'searchChips';
searchWrap.insertBefore(chipsEl, searchBox);

let chips: string[] = [];                 // the tags of the query
let cardHits: MindNode[] = [];            // every matching card, in the dropdown's order (it shows the first few)
let tagRows: string[] = [];               // …or, while a `#word` is being typed, its tag suggestions
let active = -1;
let hits = new Map<string, number>();     // a hidden match counted on the visible section holding it
let reading = false;                      // the unread folded sections are being read for this search

// While a search is up, no folded section lets go of its notes: they are what it searches.
export const searchHolds = (): boolean => searchActive();
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
  if (prefill == null) {
    searchBox.select();
  }
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
  if (b) {
    toggleSearchTag(b.dataset.tag!);
  }
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
    if (!matches(n, text)) {
      continue;
    }
    const rep = firstVisible(n);
    lit.add(rep.id);
    if (rep !== n) {
      held.set(rep.id, (held.get(rep.id) ?? 0) + 1);
    }
    for (const p of ancestors(rep)) {
      lit.add(p.id);   // the sections around a match stay lit around it
    }
  }
  state.searchMatch = lit;
  hits = held;
}
function matches(n: MindNode, text: string): boolean {
  if (outOfScope(n)) {
    return false;
  }
  if (chips.length && (!wearsTags(n) || !chips.every(c => hasTag(allTags(n), c)))) {
    return false;
  }
  return !text || nodeLabel(n).toLowerCase().includes(text) || (!!n.body && n.body.toLowerCase().includes(text));
}

// The query changed: recompute, and rebuild the dropdown (when the field has the focus).
function runSearch(showList = true): void {
  const { text, typing } = parts();
  if (!searchActive()) { clearResults(); paintAll(); scheduleUrlSync(); return; }
  if (!reading && afterReading(state.nodes.keys(), () => { reading = false; if (searchActive()) { runSearch(showList); } })) {
    reading = true;
  }
  paintAll();   // → refreshSearch
  tagRows = typing != null ? tagSuggestions(typing) : [];
  if (typing == null) {
    const found: Array<{ n: MindNode; label: string; onLabel: boolean }> = [];
    for (const n of state.nodes.values()) {
      if (!matches(n, text)) {
        continue;
      }
      const label = nodeLabel(n);
      found.push({ n, label, onLabel: !!text && label.toLowerCase().includes(text) });
    }
    // title matches first, then body-only matches, alphabetical within each
    found.sort((a, b) => a.onLabel !== b.onLabel ? (a.onLabel ? -1 : 1) : a.label.localeCompare(b.label));
    cardHits = found.map(f => f.n);
    active = cardHits.length ? 0 : -1;
    const dup = duplicateLabels();
    searchResults.innerHTML = `<div class="sr-count">${found.length} card${found.length === 1 ? '' : 's'}</div>` + (cardHits.length
      ? cardHits.slice(0, 12).map((n, i) => `<button class="sr-item${i === active ? ' active' : ''}" data-id="${n.id}">${esc(disambiguatedLabel(n, dup))}</button>`).join('')
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
  if (!k) {
    return board.slice(0, 10);
  }
  const emoji = new Set(emojiByName(k, 12).map(e => e.emoji));
  return [...board.filter(t => tagKey(t).startsWith(k)), ...board.filter(t => emoji.has(t)),
    ...board.filter(t => !tagKey(t).startsWith(k) && tagKey(t).includes(k))].filter((t, i, a) => a.indexOf(t) === i).slice(0, 10);
}
// Point state.searchActiveId at the active option's (visible) card so paintNode outlines it.
function markActive(): void {
  const nav = parts().typing == null && searchActive();
  searchWrap.classList.toggle('has-nav', nav);
  searchCount.textContent = nav ? `${active + 1}/${cardHits.length}` : '';
  searchPrev.disabled = searchNext.disabled = cardHits.length < 2;
  [...searchResults.querySelectorAll('.sr-item')].forEach((el, i) => el.classList.toggle('active', i === active));
  const hit = cardHits[active];
  const id = hit ? firstVisible(hit).id : null;
  if (state.searchActiveId !== id) { state.searchActiveId = id; paintAll(); }
}
function clearResults(): void {
  searchResults.classList.remove('open'); searchResults.innerHTML = '';
  cardHits = []; tagRows = []; active = -1;
  state.searchActiveId = null;
  searchWrap.classList.remove('has-nav');
}
// A chevron: on to the next (or previous) match, framed on the canvas — the search stays up.
function stepHit(by: number): void {
  if (!cardHits.length) {
    return;
  }
  active = (active + by + cardHits.length) % cardHits.length;
  searchResults.classList.remove('open');
  markActive();
  goTo(cardHits[active]!, false);
}
// Reach a hit the way Finder reaches a file: a folded section on the way is ENTERED, never unfolded,
// and a section hit is framed as it is. Only a folded CARD hit opens, on confirm.
// Not confirmed — stepping through the matches, FigJam's way — the camera just GLIDES to it: nothing is
// selected (the search let go of the selection), and the active match wears the search's white outline.
function goTo(n: MindNode, confirm: boolean): void {
  popScopeFor(n);
  let folded: MindNode | undefined;
  for (const p of ancestors(n)) {
    if (isScopeRoot(p)) {
      break;
    }
    if (p.collapsed && !folded) {
      folded = p;
    }
  }
  if (folded) {
    openSection(folded);
  }

  // …and a hit lying in a STACK fans that stack out, so the card is there to see.
  const pile = parentOf(n);
  if (isStack(pile) && ui.fan !== pile!.id) {
    openFan(pile!.id);
  }
  if (confirm) {
    focusNode(n, n.type !== 'section');
  } else {
    frameBox([firstVisible(n)]);
  }
}
// Make the `#word` being typed (or the suggestion picked for it) a chip.
function chipFromTyping(tag?: string): boolean {
  const { typing } = parts();
  const t = tag ?? (typing ? cleanTag(typing) : '');
  if (!t) {
    return false;
  }
  searchBox.value = searchBox.value.replace(/(?:^|\s)#\S*$/, '').trimEnd();
  if (!chips.some(c => tagKey(c) === tagKey(t))) {
    chips = [...chips, t];
  }
  renderChips();
  runSearch();
  return true;
}
function gotoHit(id: string): void {
  const n = state.nodes.get(id);
  if (!n) {
    return;
  }
  closeSearch();   // jumping to a card dismisses the search
  goTo(n, true);
}

searchBox.addEventListener('input', () => {
  // a space right after a `#word` makes it a chip, the way a tag field does
  if (/(?:^|\s)#\S+\s$/.test(searchBox.value)) {
    searchBox.value = searchBox.value.trimEnd();
    if (chipFromTyping()) {
      return;
    }
  }
  runSearch();
});
// Searching starts from a clean board: whatever was selected lets go, so its ring, its ports and the float
// bar don't sit over the hits being looked for. On focus, so every way in — ⌘F, the palette, a click in the
// field, a tag clicked — does it.
searchBox.addEventListener('focus', () => {
  if (state.sel.size || state.selEdges.size) {
    clearEdgeSelection();
    setSelectionSet([]);
  }
  if (searchActive()) {
    runSearch();
  }
});
searchBox.addEventListener('keydown', (e: KeyboardEvent) => {
  const rows = tagRows.length || parts().typing != null ? tagRows.length : cardHits.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if (!rows) {
      return;
    }
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows) % rows;
    markActive();
    // a card row: the camera goes to it as you go down the list (a tag row is just a word to pick)
    const hit = tagRows.length || parts().typing != null ? undefined : cardHits[active];
    if (hit) {
      goTo(hit, false);
    }
  } else if (e.key === 'Enter'){
    e.preventDefault();
    e.stopPropagation();   // don't let Enter reach the window handler (it would create a sibling)
    if (parts().typing != null) { chipFromTyping(tagRows[active]); return; }
    const hit = cardHits[active];
    if (hit) {
      gotoHit(hit.id);
    }
  } else if (e.key === 'Backspace' && !searchBox.value && chips.length){
    e.preventDefault();
    chips = chips.slice(0, -1); renderChips(); runSearch();
  } else if (e.key === 'Escape'){
    e.preventDefault();
    e.stopPropagation();
    // one step at a time: the text, then the chips, then the field
    if (searchBox.value) {
      searchBox.value = '';
      runSearch();
    } else if (chips.length) {
      chips = [];
      renderChips();
      runSearch();
    } else {
      closeSearch();
    }
  }
});
searchResults.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the focus in the field
byId('searchNav').addEventListener('pointerdown', (e) => e.preventDefault());
searchResults.addEventListener('click', (e: MouseEvent) => {
  const item = (e.target as Element).closest<HTMLElement>('.sr-item');
  if (!item) {
    return;
  }
  if (item.dataset.tag) {
    chipFromTyping(item.dataset.tag);
  } else {
    gotoHit(item.dataset.id!);
  }
});
searchPrev.addEventListener('click', () => stepHit(-1));
searchNext.addEventListener('click', () => stepHit(1));
// clear-or-close, exactly like Escape — but all at once: the × means "done searching".
searchClear.addEventListener('click', () => closeSearch());
// A click elsewhere: an EMPTY field closes; one with a query in it stays, its list folded away, so the
// board can be worked on under the filter.
document.addEventListener('pointerdown', (e: PointerEvent) => {
  if (!searchWrap.classList.contains('open')) {
    return;
  }
  if ((e.target as Element).closest('#searchWrap')) {
    return;
  }
  if (!searchActive()) {
    closeSearch();
  } else {
    searchResults.classList.remove('open');
    searchBox.blur();
  }
});
renderChips();
