// ---------- dragging a card's text OUT of it ----------
// The inverse of the ⌥-drop card merge (features/drag.ts): select part of a card's note — or of its
// TITLE — in its in-place editor and drag the selection out. Dropped on another CARD the text is
// appended to that card's note; dropped anywhere else it becomes a card of its own at the drop point.
// Either way it's a MOVE: the text leaves the card it came from (crud.ts dropCardText owns every
// landing, and cutTitleRange is the one that can REFUSE — a title is a filename, so it can't be cut
// to nothing).
//
// This rides the browser's NATIVE text drag — a selection inside a textarea or a contenteditable is
// draggable for free — rather than the pointer-driven node drag in features/drag.ts, which is what
// keeps it out of that file's gesture vocabulary entirely. The cost is that it's a desktop gesture:
// dragging a selection isn't a thing on iPad Safari, where ⌘⇧E (extract to a child) stays the way to
// break a note apart.
// Registers its listeners on import, like features/attachments.ts and features/gestures.ts.
import { state, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { isContainer } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { centredAt, contentParent, dropCardText, cardText, splitTitleText, canMerge,
         type TextSource } from './crud.js';
import { effectiveColor, colorClass, applyColorVars, NODE_W } from '../main.js';

// The selection as it stood when the drag began (crud.ts TextSource — which card, which half of it,
// which range). Captured here because it's read at DROP time, by when the editor may have lost the
// selection to the drop, and the range is what the cut is made from.
let pending: TextSource | null = null;

// Where a release right now would put the text. `null` = not a drop we handle (anywhere on the card
// it came FROM, or over something locked), which leaves the browser its native behaviour — dragging
// the selection back into its own note must stay a plain in-textarea move.
type Dest = { into: MindNode } | { container: MindNode | null };
function destAt(t: EventTarget | null, sourceId: string): Dest | null {
  const el = t instanceof Element ? t : null;
  // A card's own element is what a drop hits: .frame-content is pointer-events:none, so the empty
  // interior of a frame resolves to the FRAME, and a card inside it to that card.
  const nodeEl = el?.closest?.('#world [data-id]') as HTMLElement | null;
  const n = nodeEl ? state.nodes.get(nodeEl.dataset.id ?? '') ?? null : null;
  if (n?.id === sourceId) return null;                   // its own card (editor or not): a native move
  if (!n) return { container: null };                    // open canvas → a sibling of the source
  if (isLockedEffective(n)) return null;                 // locked: no drop, no hint
  if (canMerge(n)) return { into: n };                    // a card or annotation swallows the text
  if (isContainer(n)) return { container: contentParent(n) };   // a frame/stack takes a card of its own
  // Anything else under the cursor (an image or query card, a folded frame or a docked tab) has no
  // note to take the text and no interior to hold a card, so it counts as canvas — the new card
  // simply lands over it.
  return { container: null };
}

// The drop hint: the same dashed outline the ⌥ card merge uses when the text lands IN a card, and
// the frame-drop outline when it lands inside a container.
let hintEl: Element | null = null;
let hintCls = '';
function setHint(el: Element | null, cls = ''): void {
  if (hintEl === el && hintCls === cls) return;
  if (hintEl) hintEl.classList.remove(hintCls);
  hintEl = el; hintCls = cls;
  if (hintEl && hintCls) hintEl.classList.add(hintCls);
}
function showHint(dest: Dest | null): void {
  if (!dest) { setHint(null); return; }
  if ('into' in dest) setHint(dest.into.el ?? null, 'drop-merge');
  else setHint(dest.container?.el ?? null, 'drop-target');
}

// A contenteditable's selection isn't an index pair like a textarea's, so a title range has to be
// measured: the length of the text BEFORE the selection start, within this element, then the
// selection's own length. Both are taken off the rendered text, which is what the cut works on.
function selectedRangeIn(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.commonAncestorContainer)) return null;
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  const text = r.toString();
  return text ? { start, end: start + text.length } : null;
}
// What a native drag beginning on `target` is dragging, if it's THIS gesture: a range of the note or
// of the TITLE, whichever editor is open on the card the drag started on. Exported because a card
// element is `draggable` and its own dragstart (the ⌥ card-file export, features/clipboard.ts)
// cancels every native drag it doesn't own — it has to stand aside for this one, and both sides must
// agree on what "this one" is. The card test is what keeps them honest: an editor left open on
// ANOTHER card must not make that card's export (or an ⌥ image extract) stand down, and a pointerdown
// elsewhere doesn't always close it first (drag.ts's image-extract branch returns before it gets that
// far). Only one editor is ever open (each opener closes the other), so the two arms can't collide.
export function cardTextDrag(target: EventTarget | null): TextSource | null {
  if (state.readOnly || !(target instanceof Element)) return null;
  const startedOn = (id: string): HTMLElement | null => {
    const n = state.nodes.get(id);
    return n && n.el && !isLockedEffective(n) && n.el.contains(target) ? n.el : null;
  };
  const be = ui.bodyEdit;
  if (be && startedOn(be.id) && be.ta.selectionStart !== be.ta.selectionEnd)
    return { id: be.id, part: 'body', start: be.ta.selectionStart, end: be.ta.selectionEnd };
  const ie = ui.inlineEdit;
  if (ie && startedOn(ie.id)){
    const r = selectedRangeIn(ie.el);
    if (r) return { id: ie.id, part: 'title', ...r };
  }
  return null;
}

// What rides the cursor: a CARD, not the browser's snapshot of the dragged text. The gesture's whole
// point is that a card comes out of this, and the default drag image — a translucent slice of the
// textarea — reads as "moving some letters around". So the ghost is a real `.node` with the title the
// new card would get (splitTitleText, the same reading dropCardText will make of the text) over the
// rest of it, tinted with the SOURCE card's resolved colour, since a sibling is what the text becomes
// on the open canvas and it would inherit exactly that.
// Lives off-screen for one tick: the browser snapshots it during dragstart, so it must be in the
// document and rendered (display:none / visibility:hidden snapshot as nothing) — and only `left` is
// moved off-screen, so the snapshot keeps the card's true width. Removed on the next tick, since
// removing it inside the handler can beat the snapshot.
function buildGhost(source: MindNode, text: string): HTMLElement {
  const col = effectiveColor(source);
  const el = document.createElement('div');
  el.className = 'node drag-ghost ' + colorClass(col);
  applyColorVars(el, col);
  el.style.width = NODE_W + 'px';
  const { title, body } = splitTitleText(text);
  const row = document.createElement('div'); row.className = 'title-row';
  const t = document.createElement('div'); t.className = 'title';
  t.textContent = title || 'New Card';
  row.appendChild(t); el.appendChild(row);
  if (body){
    const b = document.createElement('div'); b.className = 'body';
    b.textContent = body;
    el.appendChild(b);
  }
  document.body.appendChild(el);
  return el;
}
// The drag DATA is left to the browser: a textarea selection already carries its text/plain (which is
// what lets the same gesture drop into another app), and touching the store here could only disturb
// the one drop we DON'T handle — the selection dragged back into its own note.
document.addEventListener('dragstart', (e) => {
  pending = cardTextDrag(e.target);
  if (!pending) return;
  const source = state.nodes.get(pending.id);
  const text = cardText(pending);
  if (!e.dataTransfer || !source || !text) return;
  const ghost = buildGhost(source, text);
  e.dataTransfer.setDragImage(ghost, 28, 22);   // cursor near the ghost's title, as if held by it
  setTimeout(() => ghost.remove(), 0);
});
document.addEventListener('dragover', (e) => {
  if (!pending) return;
  const dest = destAt(e.target, pending.id);
  showHint(dest);
  if (!dest) return;              // no preventDefault → the browser keeps the drop (or refuses it)
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});
document.addEventListener('drop', (e) => {
  const p = pending;
  if (!p) return;
  pending = null;
  const dest = destAt(e.target, p.id);
  setHint(null);
  if (!dest) return;
  e.preventDefault();
  dropCardText(p,
    'into' in dest ? dest : { container: dest.container, at: centredAt(screenToWorld(e.clientX, e.clientY)) });
});
// Cancelled (Esc, released outside the window) or finished: nothing to clean up but the hint.
document.addEventListener('dragend', () => { pending = null; setHint(null); });
