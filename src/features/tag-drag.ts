// ---------- dragging a tag: the tactile way to tag ----------
// A tag is a sticker you can pick up (features/tags.ts draws them; utils/tags.ts says what one is):
//   · from the TAG TRAY onto a card — tags it (features/tag-tray.ts);
//   · from one card onto another — MOVES it there; hold ⇧ to copy instead, the way ⇧-drag clones a card
//     (the chip it came from stays put while ⇧ is held, so you see which it will be);
//   · from a card off onto the canvas — REMOVES it, with a little puff, the way the Dock lets go of an app;
//   · from the TRAY off onto the canvas — the tray decides (`offBoard`: it deletes the tag everywhere).
// Dropped on a card that is part of the selection, it lands on every selected card, like a colour does.
// A tag written in a note's TEXT can be dragged out as a copy, never moved or removed: it's the text's.
// Under 4px of movement it was a click, and the chip's own click handler searches by the tag instead.
import { state } from '../core/state.js';
import { wearsTags } from '../utils/tags.js';
import { retag, tagFaceHTML, type TagChange } from './tags.js';
import { pushMru } from './tag-picker.js';
import { classMarker, trackPointer } from '../utils/dom.js';
import { taggableSelection } from './selection.js';

const SLOP = 4;

function cardAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.node');
  const n = el?.dataset.id ? state.nodes.get(el.dataset.id) : undefined;
  return wearsTags(n) ? n!.id : null;
}
// The bare board — not a card, not a bar or panel over it — where a tag dropped off its card goes away.
function onCanvas(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return !!el?.closest('#stage') && !el.closest('.node:not(.frame)');
}

export function beginTagDrag(e: PointerEvent, chip: HTMLElement, tag: string, fromCard: string | null,
  offBoard?: (x: number, y: number) => void): void {
  if (e.button !== 0 || state.readOnly) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLElement | null = null;
  const markDrop = classMarker('tag-drop');
  const target = (on: string | null): void => {
    markDrop(on && on !== fromCard ? state.nodes.get(on)?.el ?? null : null);
  };
  const move = (ev: PointerEvent): void => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) return;
      ghost = document.createElement('div');
      ghost.className = 'tag-ghost';
      ghost.innerHTML = tagFaceHTML(tag);
      document.body.appendChild(ghost);
      document.body.classList.add('tag-dragging');
    }
    ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
    chip.classList.toggle('lifted', !!fromCard && !ev.shiftKey);   // a tray sticker never leaves the tray
    target(cardAt(ev.clientX, ev.clientY));
  };
  const end = (ev: PointerEvent | null): void => {
    stop();
    target(null);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove('tag-dragging');
    chip.classList.remove('lifted');
    // the click that follows a drag is not a click
    chip.dataset.dragged = '1';
    setTimeout(() => { delete chip.dataset.dragged; }, 0);
    if (ev) drop(ev);
  };
  const drop = (ev: PointerEvent): void => {
    const to = cardAt(ev.clientX, ev.clientY);
    if (to && to !== fromCard) {
      const ids = state.sel.has(to) ? taggableSelection() : [to];
      const changes: TagChange[] = ids.map(id => ({ id, tag, on: true }));
      if (fromCard && !ev.shiftKey && !ids.includes(fromCard)) changes.push({ id: fromCard, tag, on: false });
      if (retag(changes)) pushMru(tag);
    } else if (!to && fromCard && onCanvas(ev.clientX, ev.clientY)) {
      if (retag([{ id: fromCard, tag, on: false }])) puff(ev.clientX, ev.clientY);
    } else if (!to && offBoard && onCanvas(ev.clientX, ev.clientY)) {
      offBoard(ev.clientX, ev.clientY);
    }
  };
  const stop = trackPointer({ move, up: ev => end(ev), cancel: () => end(null) });
}

export function puff(x: number, y: number): void {
  const p = document.createElement('div');
  p.className = 'tag-puff';
  p.style.left = `${x}px`; p.style.top = `${y}px`;
  document.body.appendChild(p);
  setTimeout(() => p.remove(), 450);
}
