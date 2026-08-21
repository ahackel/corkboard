// ---------- reading view: an OPENED card IS its note ----------
// The other half of "you can open things". Opening a FRAME makes its interior the canvas
// (nav/scope.ts); opening a CARD makes its NOTE the window — the whole text, at reading width and
// reading size, scrolling like a page instead of being panned like a very tall card.
//
// Deliberately NOT a panel beside the canvas. It is a scope LEVEL: one entry on the same stack, one
// crumb, ↓ / a crumb click to leave, the file path in the hash so back/forward and reload work. That
// is what keeps it one app — there is never a page and a canvas showing the same note at once, you
// simply went somewhere. (Scrintal does the same thing: a card "goes full screen to focus".)
//
// The renderer is the CARD's: `.node .body`'s whole markdown cascade, borrowed by wearing `.node`,
// with four variables restated for reading size. The editor is the card's too (startCardEditIn), so
// a note edited here and the same note edited on the canvas are the same code, the same undo step
// and the same file rename.
import { state, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { scopeRootNode } from '../nav/scope.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { isLockedEffective } from '../utils/model.js';
import { cardMarkdown, focusByTitle, openFrame, selectedIds } from '../main.js';
import { hydrateImages } from './images.js';
import { startCardEditIn } from './inline-edit.js';
import { byId } from '../utils/dom.js';

const page = byId('page');
const pgText = byId('pgBody').querySelector('.body') as HTMLElement;
const fbOpen = byId<HTMLButtonElement>('fbOpen');

// The open node, when it is one we READ rather than one we stand inside. Read off the scope root
// rather than held here: "where am I" has exactly one home (nav/scope.ts), and a second copy of it
// would be the thing that drifts.
function readingNode(): MindNode | null {
  const n = scopeRootNode();
  return n && n.type === 'card' ? n : null;
}
export function readingActive(): boolean { return !!readingNode(); }

// Called from paintAll, so an edit anywhere — here, on the canvas, an undo — refreshes the page.
export function syncReading(): void {
  const n = readingNode();
  document.body.classList.toggle('reading', !!n);
  if (!n) return;
  if (ui.bodyEdit?.el === pgText) return;   // the editor is IN here — the same bail paintNode makes
  const md = cardMarkdown(n);
  if (pgText.dataset.md === md) return;     // same source-text guard paintNode uses
  pgText.dataset.md = md;
  pgText.innerHTML = md.trim() ? renderBodyHTML(md)
    : '<p class="pg-empty">This note is empty. Double-click to write.</p>';
  hydrateImages(pgText);
}

// Double-click the page edits it — the same gesture as on the card, so the two sides agree about what
// a double-click means. Not on a link: that's a jump.
pgText.addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('a.lk')) return;
  const n = readingNode();
  if (!n || state.readOnly || isLockedEffective(n)) return;
  startCardEditIn(n, pgText);
});
// Links. The card's own handler is bound per card in paintNode and can't reach here; it's the same
// two cases — a wikilink jumps (and comes out of this scope on the way, popScopeFor), anything else
// is a plain external link the browser opens itself.
pgText.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a.lk') as HTMLElement | null;
  if (!a || !a.classList.contains('wikilink')) return;
  e.preventDefault();
  focusByTitle(a.dataset.target ?? '');
});
// ⤢ on the float bar: the touch-reachable twin of ↑. Acts on the anchor, like ↑ does — you can only
// stand in one place, so a multi-selection has nothing to open.
fbOpen.addEventListener('click', (e) => {
  e.stopPropagation();
  const ids = selectedIds();
  if (ids.length !== 1) return;
  openFrame(state.nodes.get(ids[0]));
});
