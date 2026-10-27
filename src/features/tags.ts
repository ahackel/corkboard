// ---------- tags on cards: add / remove, and the chips a card wears ----------
// A tag is an Obsidian tag (utils/tags.ts). There's no registry: a card's own tags are MindNode.tags,
// round-tripped through its frontmatter `tags:` list, and the `#tags` written in its text are read off
// the text itself. The `#` field (features/tag-picker.ts) adds and removes the frontmatter ones; a
// chip on a card is a FILTER switch (features/tag-filter.ts), never a delete button.
import { state } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { record } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { remeasure } from '../main.js';
import { esc } from '../utils/markdown.js';
import { isEmojiTag, tagKey, tagTilt, type ShownTag } from '../utils/tags.js';
import { toggleTagFilter } from './tag-filter.js';

// How a tag is written for a person: an emoji as itself, a word with its `#`.
export const tagText = (t: string): string => isEmojiTag(t) ? t : '#' + t;

// One chip on a card, stuck to its top edge: an emoji is a round STAMP, a word a paper LABEL — at a
// small tilt that is the tag's own (tagTilt), so nothing about it is stored. A tag written in the
// note's text has a dashed edge: it's the text's, not something `#` put there. Lit when it is in the
// filter.
export function tagChipHTML(t: ShownTag): string {
  const lit = state.tagFilter.some(f => tagKey(f) === tagKey(t.tag));
  return `<button type="button" class="tag ${isEmojiTag(t.tag) ? 'stamp' : 'label'}${t.inText ? ' in-text' : ''}${lit ? ' lit' : ''}"` +
    ` data-tag="${esc(t.tag)}" style="--tilt:${tagTilt(t.tag)}deg" title="${esc(tagText(t.tag))} · click to filter by it">${esc(tagText(t.tag))}</button>`;
}

// ---- the one path that adds or removes a tag on a set of cards. Skips locked cards and frames (a
// frame wears no tags), like every other per-card mutation. Case is ignored: `Idea` is `idea`. ----
export function setTagOnNodes(ids: string[], tag: string, on: boolean): void {
  if (state.readOnly) return;
  const k = tagKey(tag);
  const targets = ids.filter(id => {
    const n = state.nodes.get(id);
    return !!n && n.type !== 'frame' && !isLockedEffective(n) && n.tags.some(t => tagKey(t) === k) !== on;
  });
  if (!targets.length) return;
  record(targets, () => {
    for (const id of targets) {
      const n = state.nodes.get(id); if (!n) continue;
      n.tags = on ? [...n.tags, tag] : n.tags.filter(t => tagKey(t) !== k);
      n.dirty = true;
    }
  });
  // paint first so each card's height is current, then reflow, then paint again.
  remeasure(); scheduleSave();
}

// ---- a card's chips (main.ts paintNode calls this after rebuilding the row): a click filters by
// that tag, or takes it back out of the filter. Allowed in read-only and on a locked card — the filter
// changes nothing on disk. ----
export function bindCardTags(rowEl: HTMLElement): void {
  rowEl.querySelectorAll<HTMLElement>('.tag').forEach(chip => {
    chip.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't start a card drag/select
    chip.addEventListener('click', (e) => { e.stopPropagation(); toggleTagFilter(chip.dataset.tag!); });
  });
}
