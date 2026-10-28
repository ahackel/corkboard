// ---------- tags on cards: add / remove / move, and the chips a card wears ----------
// A tag is an Obsidian tag (utils/tags.ts). There's no registry: a card's own tags are MindNode.tags,
// round-tripped through its frontmatter `tags:` list, and the `#tags` written in its text are read off
// the text itself. They are changed three ways — the `#` field (features/tag-picker.ts), dragging a
// sticker from the tag tray onto a card, and dragging one card's tag onto another or off onto the
// canvas (features/tag-drag.ts) — and a CLICK on a tag searches by it (features/search.ts), so a
// stray click never deletes one.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { remeasure } from '../main.js';
import { esc } from '../utils/markdown.js';
import { isEmojiTag, tagKey, tagTilt, wearsTags, type ShownTag } from '../utils/tags.js';
import { searchTags, toggleSearchTag } from './search.js';
import { beginTagDrag } from './tag-drag.js';

// How a tag is written for a person: an emoji as itself, a word with its `#`.
export const tagText = (t: string): string => isEmojiTag(t) ? t : '#' + t;

// A tag's FACE, wherever one is drawn (a card's edge, the tray, the search field's suggestions): an emoji
// is a round STAMP, a word a paper LABEL, at a small tilt that is the tag's own (tagTilt) — nothing about
// it is stored. A tag written in the note's text has a dashed edge: it's the text's. Lit while it is in
// the search.
function tagClass(t: string, inText = false): string {
  const lit = searchTags().some(f => tagKey(f) === tagKey(t));
  return `tag ${isEmojiTag(t) ? 'stamp' : 'label'}${inText ? ' in-text' : ''}${lit ? ' lit' : ''}`;
}
const tagAttrs = (t: string): string => ` data-tag="${esc(t)}" style="--tilt:${tagTilt(t)}deg"`;
export function tagFaceHTML(t: string): string {
  return `<span class="${tagClass(t)}"${tagAttrs(t)}>${esc(tagText(t))}</span>`;
}
// …and one on a card, which is a button: click to search by it, drag to move or remove it.
export function tagChipHTML(t: ShownTag): string {
  return `<button type="button" class="${tagClass(t.tag, t.inText)}"${tagAttrs(t.tag)}${t.inText ? ' data-in-text="1"' : ''}` +
    ` title="${esc(tagText(t.tag))} · click to find its cards${t.inText ? '' : ', drag to move (⇧ copies) or remove'}">${esc(tagText(t.tag))}</button>`;
}

// ---- the one path that changes tags: each change adds or removes a tag on one card, all of them ONE
// undo step (a move is a remove plus adds). Skips locked cards and frames (a frame wears no tags), like
// every other per-card mutation. Case is ignored: `Idea` is `idea`. Returns whether anything changed. ----
export interface TagChange { id: string; tag: string; on: boolean; }
export function retag(changes: TagChange[]): boolean {
  if (state.readOnly) return false;
  const todo = changes.filter(c => {
    const n = state.nodes.get(c.id);
    return !!n && wearsTags(n) && !isLockedEffective(n) && n.tags.some(t => tagKey(t) === tagKey(c.tag)) !== c.on;
  });
  if (!todo.length) return false;
  record([...new Set(todo.map(c => c.id))], () => {
    for (const c of todo) {
      const n = state.nodes.get(c.id)!, k = tagKey(c.tag);
      if (n.tags.some(t => tagKey(t) === k) === c.on) continue;
      n.tags = c.on ? [...n.tags, c.tag] : n.tags.filter(t => tagKey(t) !== k);
      n.dirty = true;
    }
  });
  // paint first so each card's height is current, then reflow, then paint again.
  remeasure(); scheduleSave();
  return true;
}
export function setTagOnNodes(ids: string[], tag: string, on: boolean): void {
  retag(ids.map(id => ({ id, tag, on })));
}

// ---- a card's chips (main.ts paintNode calls this after rebuilding the row). Clicking searches by the
// tag — allowed in read-only and on a locked card, since the search changes nothing on disk; a drag
// moves or removes it (features/tag-drag.ts), which a click that went nowhere doesn't. ----
export function bindCardTags(rowEl: HTMLElement, cardId: string): void {
  rowEl.querySelectorAll<HTMLElement>('.tag').forEach(chip => {
    chip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();   // don't start a card drag/select
      beginTagDrag(e, chip, chip.dataset.tag!, chip.dataset.inText ? null : cardId);
    });
    chip.addEventListener('click', (e) => { e.stopPropagation(); if (!chip.dataset.dragged) toggleSearchTag(chip.dataset.tag!); });
  });
}
