// ---------- the TAG FILTER: light up the cards carrying a tag ----------
// Click a tag on any card and every card without it fades — the same dimming search uses (paintNode's
// `search-dim`). Click more tags to narrow: a card must carry ALL of them (a parent tag matches its
// nested ones, utils/tags.ts hasTag). A dark bar at the top names them; Esc, or its ×s, clear it.
// Ephemeral, like the search: nothing here touches disk, so it works in read-only too.
//
// state.tagMatch is DERIVED, on every paint (main.ts paintAll → refreshTagMatch): the matching cards
// plus every frame holding one, so a frame stays lit around what it holds and a FOLDED frame can say
// how many matches are tucked inside it (tagHits). A folded frame whose notes were never read
// (data/lazy.ts) knows no tags, so it simply fades.
import { state } from '../core/state.js';
import { allTags, hasTag, tagKey } from '../utils/tags.js';
import { ancestors } from '../utils/model.js';
import { outOfScope } from '../nav/scope.js';
import { esc } from '../utils/markdown.js';
import { paintAll } from '../main.js';
import { tagText } from './tags.js';

const bar = document.createElement('div');
bar.id = 'tagFilterBar';
bar.setAttribute('role', 'status');
document.body.appendChild(bar);
bar.addEventListener('pointerdown', (e) => e.stopPropagation());
bar.addEventListener('click', (e) => {
  const x = (e.target as Element).closest<HTMLElement>('.tf-x');
  if (x) toggleTagFilter(x.dataset.tag!);
});

let hits = new Map<string, number>();
// How many matching cards a frame holds (0 when no filter is on).
export function tagHits(id: string): number { return hits.get(id) ?? 0; }

export function refreshTagMatch(): void {
  const want = state.tagFilter;
  if (!want.length) { state.tagMatch = null; hits = new Map(); renderBar(0); return; }
  const lit = new Set<string>(), held = new Map<string, number>();
  let count = 0;
  for (const n of state.nodes.values()) {
    if (n.type === 'frame') continue;   // a frame wears no tags: it is lit by what it holds
    const tags = allTags(n);
    if (!want.every(w => hasTag(tags, w))) continue;
    lit.add(n.id);
    if (!outOfScope(n)) count++;
    for (const p of ancestors(n)) { lit.add(p.id); held.set(p.id, (held.get(p.id) ?? 0) + 1); }
  }
  state.tagMatch = lit;
  hits = held;
  renderBar(count);
}

let barKey = '';
function renderBar(count: number): void {
  const key = state.tagFilter.join('\u0000') + '\u0000' + count;
  if (key === barKey) return;
  barKey = key;
  bar.classList.toggle('open', state.tagFilter.length > 0);
  bar.innerHTML = state.tagFilter.length ? `<span class="tf-muted">Showing</span>` +
    state.tagFilter.map(t => `<span class="tf-chip">${esc(tagText(t))}<button type="button" class="tf-x" data-tag="${esc(t)}"` +
      ` aria-label="Take ${esc(tagText(t))} out of the filter" title="Take it out of the filter">✕</button></span>`).join('') +
    `<span class="tf-muted">${count} card${count === 1 ? '' : 's'} · esc clears</span>` : '';
}

export function toggleTagFilter(tag: string): void {
  const k = tagKey(tag);
  state.tagFilter = state.tagFilter.some(t => tagKey(t) === k)
    ? state.tagFilter.filter(t => tagKey(t) !== k) : [...state.tagFilter, tag];
  paintAll();
}
export function clearTagFilter(): void {
  if (!state.tagFilter.length) return;
  state.tagFilter = [];
  paintAll();
}
