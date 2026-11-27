// Dragging a tag chip: onto a card tags it (⇧ copies from a card), off a card onto the canvas removes it.
// A tag written in a note's TEXT only drags out as a copy; under SLOP it was a click (search by the tag).
import { state } from '../core/state.js';
import { wearsTags } from '../utils/tags.js';
import { retag, tagFaceHTML, type TagChange } from './tags.js';
import { pushMru } from './tag-picker.js';
import { classMarker, trackPointer, swallowNextClick } from '../utils/dom.js';
import { taggableSelection } from './selection.js';

const SLOP = 4;
const PUFF_MS = 450;   // the .tag-puff animation

function cardAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.node');
  const n = el?.dataset.id ? state.nodes.get(el.dataset.id) : undefined;
  return wearsTags(n) ? n!.id : null;
}

// The bare board: not a card, nor a bar or panel over it.
function onCanvas(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return !!el?.closest('#stage') && !el.closest('.node:not(.section)');
}

export function beginTagDrag(e: PointerEvent, chip: HTMLElement, tag: string, fromCard: string | null,
  offBoard?: (x: number, y: number) => void): void {
  if (e.button !== 0) {
    return;
  }
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLElement | null = null;
  const markDrop = classMarker('tag-drop');
  const target = (on: string | null): void => {
    markDrop(on && on !== fromCard ? state.nodes.get(on)?.el ?? null : null);
  };
  const move = (ev: PointerEvent): void => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) {
        return;
      }
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
    if (!ghost) {
      return;
    }
    ghost.remove();
    document.body.classList.remove('tag-dragging');
    chip.classList.remove('lifted');
    swallowNextClick();
    if (ev) {
      drop(ev);
    }
  };
  const drop = (ev: PointerEvent): void => {
    const to = cardAt(ev.clientX, ev.clientY);
    if (to && to !== fromCard) {
      const ids = state.sel.has(to) ? taggableSelection() : [to];
      const changes: TagChange[] = ids.map(id => ({ id, tag, on: true }));
      if (fromCard && !ev.shiftKey && !ids.includes(fromCard)) {
        changes.push({ id: fromCard, tag, on: false });
      }
      if (retag(changes)) {
        pushMru(tag);
      }
    } else if (!to && fromCard && onCanvas(ev.clientX, ev.clientY)) {
      if (retag([{ id: fromCard, tag, on: false }])) {
        puff(ev.clientX, ev.clientY);
      }
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
  setTimeout(() => p.remove(), PUFF_MS);
}
