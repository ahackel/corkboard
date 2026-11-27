// Tags on cards: the one write path (retag) and the chips a card wears. A CLICK on a tag searches by it,
// so a stray click never deletes one.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { mutate } from './mutate.js';
import { esc } from '../utils/markdown.js';
import { isEmojiTag, tagKey, tagTilt, wearsTags, type ShownTag } from '../utils/tags.js';
import { searchTags, toggleSearchTag } from './search.js';
import { beginTagDrag } from './tag-drag.js';

export const tagText = (t: string): string => isEmojiTag(t) ? t : '#' + t;

function tagClass(t: string, inText = false): string {
  const lit = searchTags().some(f => tagKey(f) === tagKey(t));
  return `tag ${isEmojiTag(t) ? 'stamp' : 'label'}${inText ? ' in-text' : ''}${lit ? ' lit' : ''}`;
}

const tagAttrs = (t: string): string => ` data-tag="${esc(t)}" style="--tilt:${tagTilt(t)}deg"`;

export function tagFaceHTML(t: string): string {
  return `<span class="${tagClass(t)}"${tagAttrs(t)}>${esc(tagText(t))}</span>`;
}

export function tagChipHTML(t: ShownTag): string {
  return `<button type="button" class="${tagClass(t.tag, t.inText)}"${tagAttrs(t.tag)}${t.inText ? ' data-in-text="1"' : ''}` +
    ` title="${esc(tagText(t.tag))} · click to find its cards${t.inText ? '' : ', drag to move (⇧ copies) or remove'}">${esc(tagText(t.tag))}</button>`;
}

export interface TagChange { id: string; tag: string; on: boolean; }

// ONE undo step; skips locked cards and sections. Returns whether anything changed.
export function retag(changes: TagChange[]): boolean {
  const todo = changes.filter(c => {
    const n = state.nodes.get(c.id);
    return !!n && wearsTags(n) && !isLockedEffective(n) && n.tags.some(t => tagKey(t) === tagKey(c.tag)) !== c.on;
  });
  if (!todo.length) {
    return false;
  }
  mutate([...new Set(todo.map(c => c.id))], () => {
    for (const c of todo) {
      const n = state.nodes.get(c.id)!, k = tagKey(c.tag);
      if (n.tags.some(t => tagKey(t) === k) === c.on) {
        continue;
      }
      n.tags = c.on ? [...n.tags, c.tag] : n.tags.filter(t => tagKey(t) !== k);
      n.dirty = true;
    }
  }, { reflow: 'remeasure' });   // a tag row can change a card's height
  return true;
}

export function setTagOnNodes(ids: string[], tag: string, on: boolean): void {
  retag(ids.map(id => ({ id, tag, on })));
}

// Called by paintNode after rebuilding the row; a click searches even on a locked card.
export function bindCardTags(rowEl: HTMLElement, cardId: string): void {
  rowEl.querySelectorAll<HTMLElement>('.tag').forEach(chip => {
    chip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();   // not a card drag
      beginTagDrag(e, chip, chip.dataset.tag!, chip.dataset.inText ? null : cardId);
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSearchTag(chip.dataset.tag!);
    });
  });
}
