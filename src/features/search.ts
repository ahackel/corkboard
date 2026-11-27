// Find (⌘F or /): the query is TAG CHIPS (hasTag, Obsidian's rules) plus TEXT; non-matches FADE.
// The match set is derived on every paint (refreshSearch), and unread folded sections are read for it.
import { state, isStack, type MindNode } from '../core/state.js';
import { esc } from '../utils/markdown.js';
import { nodeLabel, disambiguatedLabel, duplicateLabels, firstVisible, ancestors, parentOf } from '../utils/model.js';
import { allTags, hasTag, tagKey, cleanTag, wearsTags } from '../utils/tags.js';
import { emojiByName } from '../utils/emoji-names.js';
import { outOfScope, isScopeRoot } from '../nav/scope.js';
import { openSection, popScopeFor } from '../nav/sections.js';
import { paintAll } from '../render.js';
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
const chipsEl = Object.assign(document.createElement('span'), { id: 'searchChips' });

const LISTED_MAX = 12;
const SUGGESTIONS_MAX = 10;

let chips: string[] = [];
let cardHits: MindNode[] = [];            // in the dropdown's order
let tagRows: string[] = [];               // while a `#word` is being typed
let active = -1;
let hiddenHitsBySection = new Map<string, number>();
let readingFolded = false;

// While a search is up, no folded section lets go of its notes: they are what it searches.
export const searchHolds = (): boolean => searchActive();
export const searchTags = (): readonly string[] => chips;
export const searchActive = (): boolean => chips.length > 0 || !!searchBox.value.trim();
export const searchHitsIn = (id: string): number => hiddenHitsBySection.get(id) ?? 0;

const isTagWord = (w: string): boolean => w.length > 1 && w.startsWith('#');

// The whole query as one line, for the URL; and back.
export function searchQuery(): string {
  return [...chips.map(t => '#' + t), searchBox.value.trim()].filter(Boolean).join(' ');
}

export function setSearchQuery(q: string): void {
  const words = q.trim().split(/\s+/);
  chips = words.filter(isTagWord).map(w => cleanTag(w)).filter(Boolean);
  searchBox.value = words.filter(w => !isTagWord(w)).join(' ');
  openSearch();
  runSearch();
}

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

// The text part of the query, and a `#word` being typed at its end (null when there isn't one).
function parts(): { text: string; typing: string | null } {
  const v = searchBox.value;
  const m = v.match(/(?:^|\s)#(\S*)$/);
  return { text: (m ? v.slice(0, m.index) : v).trim().toLowerCase(), typing: m ? m[1] : null };
}

export function refreshSearch(): void {
  const { text } = parts();
  if (!chips.length && !text) { state.searchMatch = null; hiddenHitsBySection = new Map(); return; }
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
      lit.add(p.id);
    }
  }
  state.searchMatch = lit;
  hiddenHitsBySection = held;
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

// Typing is debounced (each run repaints the board); whatever acts on the results flushes it first.
const TYPE_PAUSE = 90;
let typed = 0;

function runSoon(): void {
  window.clearTimeout(typed);
  typed = window.setTimeout(() => { typed = 0; runSearch(); }, TYPE_PAUSE);
}

function runPending(): void {
  if (typed) {
    runSearch();
  }
}

function runSearch(showList = true): void {
  window.clearTimeout(typed);
  typed = 0;
  const { text, typing } = parts();
  if (!searchActive()) { clearResults(); paintAll(); scheduleUrlSync(); return; }
  if (!readingFolded && afterReading(state.nodes.keys(), () => { readingFolded = false; if (searchActive()) { runSearch(showList); } })) {
    readingFolded = true;
  }
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
    found.sort((a, b) => a.onLabel !== b.onLabel ? (a.onLabel ? -1 : 1) : a.label.localeCompare(b.label));
    cardHits = found.map(f => f.n);
    active = cardHits.length ? 0 : -1;
    const dup = duplicateLabels();
    searchResults.innerHTML = `<div class="sr-count">${found.length} card${found.length === 1 ? '' : 's'}</div>` + (cardHits.length
      ? cardHits.slice(0, LISTED_MAX).map((n, i) => `<button class="sr-item${i === active ? ' active' : ''}" data-id="${n.id}">${esc(disambiguatedLabel(n, dup))}</button>`).join('')
      : '<div class="sr-none">No card matches</div>');
  } else {
    cardHits = [];
    active = tagRows.length ? 0 : -1;
    searchResults.innerHTML = tagRows.length
      ? tagRows.map((t, i) => `<button class="sr-item sr-tag${i === active ? ' active' : ''}" data-tag="${esc(t)}">${tagChipHTML({ tag: t, inText: false })}<span class="sr-meta">${countOf(t)}</span></button>`).join('')
      : '<div class="sr-none">No tag like that on the map</div>';
  }
  searchResults.classList.toggle('open', showList && document.activeElement === searchBox);

  // Settled before the ONE paint, so markActive finds nothing left to repaint.
  const hit = cardHits[active];
  state.searchActiveId = hit && parts().typing == null ? firstVisible(hit).id : null;
  paintAll();   // → refreshSearch
  markActive();
  scheduleUrlSync();
}

const countOf = (t: string): string => { const b = boardTags().find(x => tagKey(x.tag) === tagKey(t)); return b ? `${b.count}` : ''; };

// Only tags some card carries: a filter on any other would light nothing.
function tagSuggestions(q: string): string[] {
  const k = q.toLowerCase(), on = new Set(chips.map(tagKey));
  const board = boardTags().filter(b => !on.has(tagKey(b.tag))).map(b => b.tag);
  if (!k) {
    return board.slice(0, SUGGESTIONS_MAX);
  }
  const emoji = new Set(emojiByName(k, 12).map(e => e.emoji));
  return [...board.filter(t => tagKey(t).startsWith(k)), ...board.filter(t => emoji.has(t)),
    ...board.filter(t => !tagKey(t).startsWith(k) && tagKey(t).includes(k))].filter((t, i, a) => a.indexOf(t) === i).slice(0, SUGGESTIONS_MAX);
}

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

function stepHit(by: number): void {
  if (!cardHits.length) {
    return;
  }
  active = (active + by + cardHits.length) % cardHits.length;
  searchResults.classList.remove('open');
  markActive();
  goTo(cardHits[active]!, false);
}

// A folded section on the way is ENTERED, never unfolded; unconfirmed, the camera just glides to it.
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
  closeSearch();
  goTo(n, true);
}

export function installSearch(): void {
  searchWrap.insertBefore(chipsEl, searchBox);
  chipsEl.addEventListener('pointerdown', (e) => e.preventDefault());
  chipsEl.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.sc-tag');
    if (b) {
      toggleSearchTag(b.dataset.tag!);
    }
  });
  searchBox.addEventListener('input', () => {

    // A space right after a `#word` makes it a chip.
    if (/(?:^|\s)#\S+\s$/.test(searchBox.value)) {
      searchBox.value = searchBox.value.trimEnd();
      if (chipFromTyping()) {
        return;
      }
    }
    runSoon();
  });

  // On focus, so every way in drops the selection (its ring and float bar would sit over the hits).
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
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      runPending();
    }
    const rows = tagRows.length || parts().typing != null ? tagRows.length : cardHits.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if (!rows) {
        return;
      }
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows) % rows;
      markActive();
      const hit = tagRows.length || parts().typing != null ? undefined : cardHits[active];
      if (hit) {
        goTo(hit, false);
      }
    } else if (e.key === 'Enter'){
      e.preventDefault();
      e.stopPropagation();   // the window handler would create a sibling
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
  searchResults.addEventListener('pointerdown', (e) => e.preventDefault());
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
  searchClear.addEventListener('click', () => closeSearch());

  // A click elsewhere closes an EMPTY field; a query stays up as a filter to work under.
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
}
