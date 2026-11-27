// Every press, click and key a node's element answers, bound once when render.ts creates it.
import { type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { toggleTaskAt } from '../utils/markdown.js';
import { heldSummary, isLockedEffective } from '../utils/model.js';
import { isSectionFold } from '../view/geometry.js';
import { sectionLabelled, sectionName } from '../view/layout.js';
import { paintNode } from '../render.js';
import { focusByTitle } from '../nav/focus.js';
import { endTitleEdit, onTitleInput, onTitleKeydown, syncOpenEditor } from './inline-edit.js';
import { bindNodeDrag } from './node-press.js';
import { bindCardFileDrag } from './clipboard.js';
import { toggleSearchTag } from './search.js';
import { peekCard } from './peek.js';
import { onNodeDblClick, openImageAt } from './activate.js';
import { mutate } from './mutate.js';

export function bindNodeEvents(n: MindNode, el: HTMLElement): void {
  // Built on hover, not per paint: heldSummary walks the folder.
  el.addEventListener('pointerenter', () => {
    if (isSectionFold(n)) {
      el.title = (sectionLabelled(n) ? sectionName(n) + '\n' : '') + heldSummary(n);
    }
  });
  bindNodeDrag(n);
  bindCardFileDrag(n);
  // Tapping the "+4" badge peeks: touch has no hover.
  const foldMore = el.querySelector(':scope > .fold-more')!;
  foldMore.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  foldMore.addEventListener('click', (e)=>{ e.stopPropagation(); peekCard(el); });
  const bodyEl = el.querySelector('.body')!;
  // Clicks on links/tags/zoom must not bubble to the card and select it.
  bodyEl.addEventListener('click', (e)=>{
    const zoom = (e.target as HTMLElement).closest('.img-zoom') as HTMLElement | null;
    if (zoom){
      e.stopPropagation();
      const img = zoom.closest('.img-wrap')?.querySelector('img.md-img') as HTMLImageElement | null;
      openImageAt(n, img);
      return;
    }
    const tag = (e.target as HTMLElement).closest('.md-tag') as HTMLElement | null;
    if (tag){ e.stopPropagation(); toggleSearchTag(tag.dataset.tag!); return; }
    const a = (e.target as HTMLElement).closest('a.lk') as HTMLElement | null;
    if (!a) {
      return;
    }
    e.stopPropagation();
    if (a.classList.contains('wikilink')){
      e.preventDefault();
      focusByTitle(a.dataset.target ?? '', n);
    }
  });
  bodyEl.addEventListener('change', (e)=>{
    const cb = (e.target as HTMLElement).closest('input.taskbox') as HTMLInputElement | null;
    if (!cb) {
      return;
    }
    e.stopPropagation();
    toggleTask(n, +(cb.dataset.ti ?? 0));
  });
  const titleEl = el.querySelector('.title') as HTMLElement;
  titleEl.addEventListener('input',   ()  => onTitleInput(n));
  titleEl.addEventListener('keydown', (e) => onTitleKeydown(e as KeyboardEvent, n));
  titleEl.addEventListener('blur',    ()  => {
    if (ui.titleEdit && ui.titleEdit.id === n.id) {
      endTitleEdit();
    }
  });
  el.addEventListener('dblclick', (e) => onNodeDblClick(n, e));
}

function toggleTask(n: MindNode, idx: number): void {
  if (isLockedEffective(n)) {
    return;
  }
  mutate([n.id], () => {
    n.body = toggleTaskAt(n.body, idx);
    n.dirty = true;
    syncOpenEditor(n);
    paintNode(n);
  }, { reflow: 'none' });
}
