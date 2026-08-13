// ---------- the open-frame path ----------
// The one way back out of an open frame (see nav/scope.ts), and the only thing on screen that says
// which one you're in — an open frame draws no box, no border and no tab. Owns the segments inside
// #homeBar and its one delegated listener, the way features/search.ts owns #searchWrap; the actions
// themselves live in main.ts.
//
// ONE PILL, not a pill per level. That's #toolbar's pattern — a single --panel capsule holding
// borderless items that highlight only on hover — and it's what Finder, VS Code, Explorer and Notion
// all do with a path. #homeBar IS that pill (styles.css); the home button and every segment sit
// inside it, so the map name reads as the first segment of the path rather than as loose text beside
// it, and going into a frame just adds segments instead of swapping one kind of chrome for another.
// The pill matters rather than being decoration: the canvas can now be any colour (syncCanvasBackground),
// so a path drawn straight onto it would have no dependable contrast.
//
// A DEEP path folds its middle into one `…` that opens a menu of the levels it swallowed. That bounds
// the segment COUNT, which is the only thing that actually stops a long path running under the centred
// #toolbar — capping the pill's width can't, because the folder icons and separators are flex:none and
// simply overflow it. Same behaviour as Explorer's and Notion's paths.
import { state } from '../core/state.js';
import { nodeLabel } from '../utils/model.js';
import { store } from '../data/persistence.js';
import { scope, scopeActive } from '../nav/scope.js';
import { goToScopeDepth } from '../main.js';
import { openMenu, type MenuEntry } from './context-menu.js';
import { esc } from '../utils/markdown.js';

const homeBar = document.getElementById('homeBar') as HTMLElement;
const mapCrumb = document.getElementById('folderName') as HTMLElement;
const bar = document.getElementById('scopeBar') as HTMLElement;

// How many frame levels are spelled out in full. Beyond this the middle folds into `…`, keeping the
// deepest TAIL — where you are and what you're about to step back into is worth more than the top of
// the path, which the map segment already stands in for.
const TAIL = 2;

// A level's own segment: the name alone, no folder glyph — the `›` separators already say this is a
// path, and every segment but the map is a frame, so an icon on each of them is repeated with no
// information in it. `depth` is what goToScopeDepth takes: the crumb for scope.stack[i] carries i + 1,
// i.e. "leave the level below me", which lands you IN this one.
// The CURRENT level is inert — you are already there, so there is nothing for a click to do and a
// hover highlight would promise one (styles.css takes its pointer-events away).
function crumb(depth: number, label: string, current: boolean): string {
  return `<span class="sc-sep" aria-hidden="true">›</span>`
    + `<button type="button" class="sc-crumb${current ? ' sc-cur' : ''}" data-depth="${depth}"`
    + `${current ? ' aria-current="page"' : ''} title="${esc(label)}">`
    + `<span class="sc-name">${esc(label)}</span></button>`;
}
const levelTitle = (i: number): string => state.nodes.get(scope.stack[i]!.rootId) ? nodeLabel(state.nodes.get(scope.stack[i]!.rootId)!) : '…';
// The levels `…` stands for, outermost first — everything before the tail.
const foldedLevels = (): number[] =>
  scope.stack.length > TAIL ? [...Array(scope.stack.length - TAIL).keys()] : [];

// Driven from paintAll — the same argument renderOutline makes there: every mutation path (a rename, a
// delete, an undo, a reload) keeps the path in step with no extra wiring. Which is also why it needs
// the signature guard: paintAll runs once per animation FRAME for the length of a resize drag, and
// rebuilding this innerHTML per frame would be pure waste (cf. queryKey in main.ts).
export function renderCrumbs(): void {
  const sig = !scopeActive() ? store.name
    : store.name + '|' + scope.stack.map(l => l.rootId + ':' + (() => { const p = state.nodes.get(l.rootId); return p ? nodeLabel(p) : ''; })()).join('/');
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  document.body.classList.toggle('scoped', scopeActive());
  // The map is the first segment either way — it's just the CURRENT one (and so inert) when there's
  // nothing open above it.
  mapCrumb.classList.toggle('sc-cur', !scopeActive());
  mapCrumb.dataset.depth = '0';
  if (!scopeActive()) { bar.innerHTML = ''; return; }
  const folded = foldedLevels();
  const html = folded.length
    ? `<span class="sc-sep" aria-hidden="true">›</span>`
      + `<button type="button" class="sc-crumb sc-more" data-more="1"`
      + ` title="${esc(folded.map(i => levelTitle(i)).join(' › '))}">…</button>`
    : '';
  bar.innerHTML = html + scope.stack.slice(folded.length)
    .map((_, k) => {
      const i = folded.length + k;
      return crumb(i + 1, levelTitle(i), i === scope.stack.length - 1);
    }).join('');
}

// One listener for the whole pill, so the map segment (#folderName, a sibling of #scopeBar) and the
// frame segments share it.
homeBar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.sc-crumb');
  if (!btn) return;
  // `…` → a menu of the levels it swallowed, reusing the canvas/card menu's own chrome.
  if (btn.dataset.more) {
    const r = btn.getBoundingClientRect();
    const entries: MenuEntry[] = foldedLevels().map(i => ({ label: levelTitle(i), run: () => goToScopeDepth(i + 1) }));
    if (entries.length) openMenu(entries, r.left, r.bottom + 4);
    return;
  }
  // …and the CURRENT level can't get here at all: it's inert (styles.css takes its pointer-events),
  // because you're already standing in it. F re-frames if that's what you wanted.
  goToScopeDepth(Number(btn.dataset.depth));
});
