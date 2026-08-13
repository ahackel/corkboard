// ---------- find a card (toolbar search box + dropdown) ----------
// Filters on title OR body. Every match is highlighted by dimming the non-matching cards
// (state.searchMatch, applied in paintAll); a match buried in a collapsed branch highlights
// the first visible parent containing it instead. The active dropdown option's card gets an
// extra white outline (state.searchActiveId). searchBox is exported so the global "/"
// shortcut can focus it.
import { state, type MindNode } from '../core/state.js';
import { esc } from '../utils/markdown.js';
import { nodeLabel, disambiguatedLabel, duplicateLabels, firstVisible } from '../utils/model.js';
import { outOfScope } from '../nav/scope.js';
import { paintAll, focusNode } from '../main.js';
import { outlineActive, revealInOutline } from './outline.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { byId } from '../utils/dom.js';

export const searchBox = byId<HTMLInputElement>('searchBox');
const searchWrap = byId('searchWrap');
const searchBtn = byId<HTMLButtonElement>('searchBtn');
const searchResults = byId('searchResults');
const searchClear = byId<HTMLButtonElement>('searchClear');
let searchHits: MindNode[] = [], searchActive = -1;
// Open the search bar and focus the box (also the "/" shortcut entry point). The bar sits where
// the main toolbar does and hides it for as long as it's open (styles.css keys off `.open`).
export function openSearch(): void {
  searchWrap.classList.add('open');
  searchBtn.classList.add('active');
  searchBox.focus(); searchBox.select();
}
// Close the bar and drop any active highlight.
function closeSearch(): void {
  searchBox.value = ''; clearSearch();   // clearSearch() also drops q from the hash
  searchWrap.classList.remove('open');
  searchBtn.classList.remove('active');
}
export function runSearch(): void {
  const q = searchBox.value.trim().toLowerCase();
  searchBox.classList.toggle('has-value', !!searchBox.value);
  if (!q){ clearSearch(); return; }
  // match on title OR body content — within the frame you're standing in, if any (nav/scope.ts):
  // search finds what's on the canvas, so a hit is always something you can be shown and select.
  // The way back OUT of a frame is the breadcrumbs, not a search result that teleports you.
  // Each node's label is derived ONCE here and carried through the filter, the sort and the ranking —
  // a label off an untitled card means scanning its first line, and asking for it again per sort
  // COMPARISON put that on an n·log n path that reruns on every keystroke.
  const matches: { n: MindNode; label: string; onLabel: boolean }[] = [];
  for (const n of state.nodes.values()){
    if (outOfScope(n)) continue;
    const label = nodeLabel(n);
    const onLabel = label.toLowerCase().includes(q);
    if (onLabel || (n.body && n.body.toLowerCase().includes(q))) matches.push({ n, label, onLabel });
  }
  // highlight every match — surfacing a hidden match through its first visible parent
  state.searchMatch = new Set(matches.map(m => firstVisible(m.n).id));
  // dropdown: title matches first, then body-only matches, alphabetical within each
  searchHits = matches.sort((a,b) =>
    a.onLabel !== b.onLabel ? (a.onLabel ? -1 : 1) : a.label.localeCompare(b.label)
  ).slice(0, 12).map(m => m.n);
  searchActive = searchHits.length ? 0 : -1;
  const dup = duplicateLabels();
  searchResults.innerHTML = searchHits.length
    ? searchHits.map((n,i) => `<button class="sr-item${i===searchActive?' active':''}" data-id="${n.id}">${esc(disambiguatedLabel(n, dup))}</button>`).join('')
    : '<div class="sr-none">No card matches</div>';
  searchResults.classList.add('open');
  markActive();   // white outline on the active option's (visible) card
  paintAll();
  scheduleUrlSync();
}
// Point state.searchActiveId at the active dropdown option's card (or the first visible
// parent containing it when it's collapsed away) so paintNode gives it a white outline.
function markActive(): void {
  const hit = searchHits[searchActive];
  state.searchActiveId = hit ? firstVisible(hit).id : null;
}
function clearSearch(): void {
  searchResults.classList.remove('open'); searchResults.innerHTML = '';
  searchHits = [];
  searchBox.classList.toggle('has-value', !!searchBox.value);
  if (state.searchMatch){ state.searchMatch = null; state.searchActiveId = null; paintAll(); }   // un-dim
  scheduleUrlSync();   // drop q from the hash now that there's no active query
}
function gotoHit(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  closeSearch();   // jumping to a card dismisses the search bar
  if (outlineActive()) revealInOutline(id);   // unfold ancestors + scroll the row into view
  else focusNode(n, true);   // reveal ancestors level by level AND open the hit itself
}
searchBox.addEventListener('input', runSearch);
searchBox.addEventListener('focus', () => { if (searchBox.value.trim()) runSearch(); });
searchBox.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if (!searchHits.length) return;
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
    [...searchResults.children].forEach((el,i) => el.classList.toggle('active', i === searchActive));
    markActive(); paintAll();   // move the white outline to the newly-active option
  } else if (e.key === 'Enter'){
    e.preventDefault();
    e.stopPropagation();   // gotoHit blurs the box, so don't let Enter reach the window handler (it would create a sibling)
    const hit = searchHits[searchActive];
    if (hit) gotoHit(hit.id);
  } else if (e.key === 'Escape'){
    e.preventDefault();
    if (searchBox.value){ searchBox.value = ''; runSearch(); } else closeSearch();
  }
});
searchResults.addEventListener('click', (e: MouseEvent) => {
  const item = (e.target as Element).closest('.sr-item');
  if (item) gotoHit((item as HTMLElement).dataset.id!);
});
// clear-or-close, exactly like Escape: with the toolbar hidden behind the bar, this is the only
// visible way out, so an empty box makes the × dismiss the whole mode instead of doing nothing.
searchClear.addEventListener('click', () => {
  if (searchBox.value){ searchBox.value = ''; runSearch(); searchBox.focus(); } else closeSearch();
});
searchBtn.addEventListener('click', () => {   // toolbar icon toggles the floating bar
  if (searchWrap.classList.contains('open')) closeSearch(); else openSearch();
});
document.addEventListener('pointerdown', (e: PointerEvent) => {           // click-away closes the bar
  if (!searchWrap.classList.contains('open')) return;
  const t = e.target as Element;
  if (!t.closest('#searchWrap') && !t.closest('#searchBtn')) closeSearch();
});
