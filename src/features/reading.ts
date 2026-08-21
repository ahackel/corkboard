// ---------- reading view: an OPENED card IS its note ----------
// The other half of "you can open things". Opening a FRAME makes its interior the canvas
// (nav/scope.ts); opening a CARD keeps the card itself and draws it as one full-height strip, so the
// whole note is readable and scrolls like a page instead of being panned like a very tall card.
//
// There is no second view here, and that is the entire point of the module being this small. It is
// THE CARD: the same element paintNode already paints, with its own colour, ink, markdown, links,
// task boxes and — on a double-click — its own editor. All this file does is name the state; the
// strip's geometry is `.node.reading-root` in styles.css, and staying on the canvas at all is the one
// exception isReadingRoot spells in nav/scope.ts.
//
// It is also a scope LEVEL, not a panel: one entry on the same stack, one crumb, ↓ / a crumb / Esc to
// leave, the file path in the same `open=` hash term — so back/forward, reload and bookmarks work
// with no navigation state of its own. Reading is somewhere you GO.
import { state } from '../core/state.js';
import { scopeRootNode, canOpen, isScopeRoot } from '../nav/scope.js';
import { actionTarget } from '../view/layout.js';
import { openFrame, selectedIds } from '../main.js';
import { byId } from '../utils/dom.js';

const fbOpen = byId<HTMLButtonElement>('fbOpen');

// Read off the scope root rather than held here: "where am I" has exactly one home, and a second copy
// of it would be the thing that drifts.
export function readingActive(): boolean {
  const n = scopeRootNode();
  return !!n && n.type === 'card';
}

// Called from paintAll. The class is what the strip's CSS keys off for everything OUTSIDE the card —
// the canvas tools that have nothing to act on in here.
export function syncReading(): void {
  document.body.classList.toggle('reading', readingActive());
}

// ⤢ on the float bar: the touch-reachable twin of ↑, since the float bar is the one action surface
// identical on desktop and on a phone. Acts on the anchor, like ↑ does — you can only stand in one
// place — and hides on the card you are already standing in, which openFrame would refuse anyway.
export function canOpenSelection(): boolean {
  const ids = selectedIds();
  if (ids.length !== 1) return false;
  const n = state.nodes.get(ids[0]);
  return !!n && canOpen(actionTarget(n)) && !isScopeRoot(actionTarget(n));
}
fbOpen.addEventListener('click', (e) => {
  e.stopPropagation();
  const ids = selectedIds();
  if (ids.length === 1) openFrame(state.nodes.get(ids[0]));
});
