// The render core: painting nodes, where their elements sit, and settling the canvas after a change.
import { renderBodyHTML, taskProgress, toggleTaskAt } from './utils/markdown.js';
import { joinHeading, collapsedMarkdown, cardMarkdown, hiddenLineCount } from './utils/frontmatter.js';
import { isHidden, nodeLabel, isLockedEffective, parentOf, ancestors, heldSummary, withKids } from './utils/model.js';
import { state, world, dragLayer, isStack, type MindNode } from './core/state.js';
import { LOCK_BADGE_SVG, FOLDER_SVG } from './view/icons.js';
import { labelScale } from './view/camera.js';
import { applyLayouts, hostSection, sectionInterior, isSection, sectionLabelled, sectionName } from './view/layout.js';
import { paintFreeEdges } from './view/free-edges.js';
import { endTitleEdit, onTitleInput, onTitleKeydown, syncOpenEditor } from './features/inline-edit.js';
import { bindNodeDrag } from './features/node-press.js';
import { paintPile, syncFan, STACK_DEFAULT_COLOR } from './features/stacks.js';
import { refreshSearch, searchHitsIn, searchTags, toggleSearchTag } from './features/search.js';
import { bindCardFileDrag } from './features/clipboard.js';
import { bindCardTags, tagChipHTML } from './features/tags.js';
import { refreshTray } from './features/tag-tray.js';
import { noteTags, wearsTags } from './utils/tags.js';
import { mutate } from './features/mutate.js';
import { hydrateImages } from './features/images.js';
import { readOpenUnread } from './data/lazy.js';
import { store } from './data/active-store.js';
import { peekCard } from './features/peek.js';
import { ui, inPlaceEditActive, type Pt } from './core/ui-state.js';
import { applyColorVars, colorClass } from './view/color.js';
import { canFold, isSectionFold, imageLook, heightIsDeclared, isBoxNode, nodeW, nodeH, isImageFold, NODE_W } from './view/geometry.js';
import { ensureResizeHandles, clearResizeHandles } from './features/resize.js';
import { syncSelFrame } from './features/sel-frame.js';
import { syncScopeChrome } from './nav/sections.js';
import { focusByTitle } from './nav/focus.js';
import { onNodeDblClick, openImageAt } from './features/activate.js';

function nodeEl(n: MindNode): HTMLElement {
  if (n.el) {
    return n.el;
  }
  const el = document.createElement('div');
  el.dataset.id = n.id;
  el.innerHTML = `<div class="title-row"><div class="title"></div></div><div class="body"></div>
    <div class="fold-more"></div>
    <div class="top-edge"><div class="tag-row"></div></div><div class="task-bar"></div>
    <span class="lock-badge" title="Locked">${LOCK_BADGE_SVG}</span><span class="fold-icon">${FOLDER_SVG}</span>`;
  world.appendChild(el);
  n.el = el;
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
  return el;
}

// A card's colour is its own, else the nearest coloured ancestor's; mid-drag, the section it will land in.
export function effectiveColor(n: MindNode): string {
  // A section inheriting its parent's colour would vanish into it.
  if (n.type === 'section') {
    return n.color || (isStack(n) ? STACK_DEFAULT_COLOR : 'white');
  }
  const drag = ui.drag;
  let previewId: string | null = null;
  let previewParent: MindNode | null | undefined;
  // A drop target equal to the dragged card would make the walk below loop on itself.
  if (drag && drag.moved && !drag.shift) {
    previewId = drag.active.id;
    previewParent = drag.dropTarget && drag.dropTarget !== previewId ? state.nodes.get(drag.dropTarget) : null;
  }
  // A parent cycle in bad data must degrade to the fallback, not hang the tab. A stack's colour is its pin's only.
  let guard = 0;
  for (let c: MindNode | null | undefined = n; c && guard++ < 4096; c = (c.id === previewId) ? previewParent : parentOf(c)) {
    if (c.color && !isStack(c)) {
      return c.color;
    }
  }
  // Derived, never written: the note on disk stays uncoloured.
  return 'amber';
}

// Notes that just arrived from outside (the phone inbox) pulse once, or the folded pill they're tucked in.
const ARRIVED_PULSE_MS = 2400;
const arrivedIds = new Set<string>();

export function flashArrived(ids: Iterable<string>): void {
  const shown = new Set<string>();
  for (const id of ids) {
    const n = state.nodes.get(id);
    if (!n) {
      continue;
    }
    let at: MindNode = n;
    for (const a of ancestors(n)) {
      if (a.collapsed) {
        at = a;   // the outermost fold is what's on screen
      }
    }
    if (!isHidden(at)) {
      shown.add(at.id);
    }
  }
  for (const id of shown) {
    arrivedIds.add(id);
    const n = state.nodes.get(id);
    if (n) {
      paintNode(n);
    }
  }
  if (shown.size) {
    setTimeout(() => {
      for (const id of shown) {
        arrivedIds.delete(id);
        const n = state.nodes.get(id);
        if (n) {
          paintNode(n);
        }
      }
    }, ARRIVED_PULSE_MS);
  }
}

export function paintNode(n: MindNode): void {
  ui.paintTick++;
  const el = nodeEl(n);
  // Before the isHidden return, so a folded or opened section lets go of its wrapper too.
  if (n.sectionContentEl && !hostsContent(n)) { n.sectionContentEl.remove(); n.sectionContentEl = null; }
  if (isHidden(n)) { el.style.display = 'none'; return; }
  el.style.display = '';
  const editingBody = ui.bodyEdit && ui.bodyEdit.id === n.id;
  const hasBody = editingBody || !!(n.body && n.body.trim());
  const collapsed = n.collapsed && n.type !== 'section' && canFold(n);
  const tags = wearsTags(n) ? noteTags(n) : [];
  const col = effectiveColor(n);
  applyColorVars(el, col);
  el.className = 'node ' + colorClass(col)
    + (n.id === ui.resizingId ? ' resizing' : '')
    + (arrivedIds.has(n.id) ? ' arrived' : '')
    + (isSection(n) ? ' section' : '')
    + (isSectionFold(n) ? ' section-folded' : '')
    + (isStack(n) ? ' stack' + (ui.fan === n.id ? ' fan-open' : '') : '')
    + (ui.fan && n.parent === ui.fan ? ' fanned' : '')
    + (imageLook(n) ? ' image-card' : '')
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')
    + (collapsed ? ' collapsed' : '')
    + (n.type !== 'section' && n.title ? ' titled' : '')
    + (n.locked ? ' locked' : '')
    + (editingBody ? ' card-editing' : '')
    + (hasBody ? '' : ' no-body')
    + (tags.length ? '' : ' no-tags')
    + (ui.titleEdit?.id === n.id ? ' title-editing' : '')
    + (ui.drag?.targets?.has(n.id) ? (ui.drag.moved ? ' dragging grabbed' : ' dragging') : '')
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '')
    + (state.searchActiveId === n.id ? ' search-active' : '');
  settledHost(n);
  // Mid-drag left/top stay at the pre-drag origin and the move is a transform (as applyDragTransform), so a
  // repaint can't double-count the delta. A child carried by its own section's drag stays inside it.
  const drag = ui.drag;
  const carried = !!(drag && n.hostSectionId != null && drag.targets.has(n.hostSectionId));
  const dragOrig = !carried ? drag?.origins?.get(n.id) : undefined;
  if (dragOrig) {
    el.style.left = dragOrig.x + 'px'; el.style.top = dragOrig.y + 'px';
    el.style.transform = `translate(${n.x - dragOrig.x}px,${n.y - dragOrig.y}px)`;
    const root = dragRoot();
    if (el.parentElement !== root) {
      root.appendChild(el);
    }
  } else {
    if (el.style.transform) {
      el.style.transform = '';
    }
    const np = paintPos(n);
    placeSelf(n, np.x, np.y);
  }
  // A plain card's n.h is a MIN-height (unless n.clip); while edited it holds the height it opened at.
  if (!heightIsDeclared(n) && !collapsed && !isStack(n)) {
    const hold = ui.bodyEdit?.id === n.id ? ui.bodyEdit.holdH ?? 0 : 0;
    const min = Math.max(n.h != null ? n.h : 0, hold);
    el.style.minHeight = min ? min + 'px' : '';
  } else if (el.style.minHeight) {
    el.style.minHeight = '';
  }
  if (isStack(n)) {
    el.style.width = nodeW(n) + 'px';
    el.style.height = ''; el.style.maxWidth = '';
    clearResizeHandles(el);
  } else if (isBoxNode(n)) {
    el.style.width = nodeW(n) + 'px';
    el.style.height = nodeH(n) + 'px';
    ensureResizeHandles(n);
    if (isSection(n)) {
      sectionContentEl(n);
    }
  } else if (isSectionFold(n)) {
    if (el.style.width) { el.style.width = ''; el.style.height = ''; }
    clearResizeHandles(el);
  } else if (isImageFold(n)) {
    // Keeps its handles: scaling the folded icon up unfolds it.
    el.style.width = ''; el.style.height = '';
    ensureResizeHandles(n);
  } else {
    // Never an inline height: the authored one is the min-height above. Folded, the chip shrink-wraps its line.
    const authored = n.w != null && !collapsed;
    el.style.width = authored ? nodeW(n) + 'px' : '';
    const cap = collapsed ? (n.w ?? NODE_W) + 'px' : '';
    if (el.style.maxWidth !== cap) {
      el.style.maxWidth = cap;
    }
    if (el.style.height) {
      el.style.height = '';
    }
    if (collapsed) {
      clearResizeHandles(el);
    } else {
      ensureResizeHandles(n);
    }
  }
  // Don't clobber a section's label while the user is typing into this very element.
  if (!(ui.titleEdit && ui.titleEdit.id === n.id)) {
    const titleEl = el.querySelector('.title') as HTMLElement;
    // A card's title is the H1 in its body, so only sections and stacks fill this slot.
    if (isSection(n) || isSectionFold(n) || isStack(n)) {
      const sect = isSection(n) || isSectionFold(n);
      const md = sect ? joinHeading(sectionName(n), '') : joinHeading(n.title, '', false) || collapsedMarkdown(n);
      const hits = isSectionFold(n) ? searchHitsIn(n.id) : 0;
      const full = sect ? sectionName(n) : nodeLabel(n);
      // Keyed on the source text: paintAll runs per frame during a resize.
      const key = md + '\u0000' + hits;
      if (titleEl.dataset.md !== key){
        titleEl.dataset.md = key;
        titleEl.innerHTML = (md.trim() ? renderBodyHTML(md) : '')
          + (hits ? `<span class="section-hits" title="${hits} matching the search">${hits} match${hits === 1 ? '' : 'es'}</span>` : '');
      }
      // Ellipsised, so the full text lives in the tooltip; a folded one's is set on hover (nodeEl).
      if (isSectionFold(n)) {
        titleEl.removeAttribute('title');
      } else {
        titleEl.title = full;
        el.removeAttribute('title');
      }
      el.classList.toggle('no-title', !sectionLabelled(n) && ui.titleEdit?.id !== n.id);
      el.style.setProperty('--ls', String(labelScale()));
    } else {
      titleEl.textContent = '';
      titleEl.removeAttribute('title');
      delete titleEl.dataset.md;    // retyped away from a section: the stale key must not match later
      el.classList.toggle('no-title', true);
    }
  }
  const bodyEl = el.querySelector('.body') as HTMLElement;
  // The editor's textarea lives inside .body.
  if (!editingBody) {
    const md = collapsed ? collapsedMarkdown(n) : cardMarkdown(n);
    const fresh = bodyEl.dataset.md !== md;
    if (fresh){
      bodyEl.dataset.md = md;
      bodyEl.innerHTML = renderBodyHTML(md);
      hydrateImages(bodyEl, n.file);
    }
    const tw = String(nodeW(n));
    if ((fresh || bodyEl.dataset.tw !== tw) && md.includes('|')) {
      bodyEl.dataset.tw = tw;
      queueTableCheck(bodyEl);
    }
  }
  // Keyed, so a repaint mid-drag can't destroy a chip under the pointer.
  const tagRowEl = el.querySelector('.tag-row') as HTMLElement;
  const tagsKey = tags.map(t => (t.inText ? '~' : '') + t.tag).join(' ') + (tags.length && searchTags().length ? '\u0000' + searchTags().join(' ') : '');
  if (tagRowEl.dataset.tagsKey !== tagsKey) {
    tagRowEl.dataset.tagsKey = tagsKey;
    tagRowEl.innerHTML = tags.map(tagChipHTML).join('');
    bindCardTags(tagRowEl, n.id);
  }
  const more = el.querySelector(':scope > .fold-more') as HTMLElement;
  const hidden = collapsed && !imageLook(n) ? hiddenLineCount(n) : 0;
  const moreText = hidden ? `+${hidden}` : '';
  if (more.textContent !== moreText){
    more.textContent = moreText;
    more.title = hidden ? `${hidden} more line${hidden === 1 ? '' : 's'}` : '';
  }
  const bar = el.querySelector(':scope > .task-bar') as HTMLElement;
  const tp = n.type === 'section' || collapsed ? { done: 0, total: 0 } : taskProgress(n.body);
  const barTitle = tp.total ? `${tp.done}/${tp.total}` : '';
  el.classList.toggle('has-tasks', tp.total > 0);
  if (bar.title !== barTitle){
    bar.title = barTitle;
    bar.style.setProperty('--done', `${tp.total ? Math.round(tp.done / tp.total * 100) : 0}%`);
  }
  paintPile(n, el);

  // Typing never changes a card's height: an edited card scrolls inside the height it opened at.
  const clipH = editingBody && !n.collapsed && !heightIsDeclared(n) ? ui.bodyEdit!.holdH ?? null : clipHeight(n);
  if (clipH != null) {
    const cap = Math.max(0, clipH - bodyEl.offsetTop - parseFloat(getComputedStyle(el).paddingBottom));
    if (bodyEl.style.maxHeight !== cap + 'px') {
      bodyEl.style.maxHeight = cap + 'px';
    }
  } else if (bodyEl.style.maxHeight) {
    bodyEl.style.maxHeight = '';
  }
}

function clipHeight(n: MindNode): number | null {
  return n.clip && n.h != null && !n.collapsed && !heightIsDeclared(n) ? n.h : null;
}

function hostsContent(n: MindNode): boolean {
  return isSection(n) && !isHidden(n);
}

// The element carrying a node's visible title (the float bar centres on it).
export function labelEl(n: MindNode): HTMLElement | null {
  if (!n.el) {
    return null;
  }
  return isSectionFold(n) ? n.el : (n.el.querySelector(':scope > .title-row') as HTMLElement | null);
}

// Which section's content wrapper hosts `n`'s element. Settled only outside a gesture: re-parenting would
// drop a captured pointer or blur an open editor.
export function settledHost(n: MindNode): MindNode | null {
  if (ui.drag || inPlaceEditActive()) {
    return n.hostSectionId ? (state.nodes.get(n.hostSectionId) ?? null) : null;
  }
  const want = hostSection(n);
  n.hostSectionId = want ? want.id : null;
  return want;
}

function dragRoot(): HTMLElement { return (ui.drag && ui.drag.moved) ? dragLayer : world; }

// Mid-drag the move is a transform on top, so left/top must use the pre-drag origin.
function paintPos(n: MindNode): Pt {
  return ui.drag?.origins?.get(n.id) ?? n;
}

function place(el: HTMLElement, absX: number, absY: number, host: MindNode | null): void {
  if (!host) {
    return placeIn(el, absX, absY, dragRoot(), 0, 0);
  }
  const o = contentOrigin(host);
  placeIn(el, absX, absY, sectionContentEl(host), o.x, o.y);
}

function placeIn(el: HTMLElement, absX: number, absY: number, container: HTMLElement, ox: number, oy: number): void {
  el.style.left = (absX - ox) + 'px';
  el.style.top  = (absY - oy) + 'px';
  if (el.parentElement !== container) {
    container.appendChild(el);
  }
}

// The one point place(), sectionContentEl() and followEdges() must agree on.
function contentOrigin(host: MindNode): Pt {
  const box = sectionInterior(host);
  const bp = paintPos(host);
  return { x: bp.x + (box.x - host.x), y: bp.y + (box.y - host.y) };
}

export function placeSelf(n: MindNode, absX: number, absY: number): void {
  ui.paintTick++;
  place(nodeEl(n), absX, absY, settledHost(n));
  orderContentAfterBox(n);
}

// Both are z-index:auto, so document order decides: a box after its wrapper would cover a nested section.
function orderContentAfterBox(n: MindNode): void {
  const w = n.sectionContentEl, el = n.el;
  if (!w || !el || w.parentElement !== el.parentElement) {
    return;
  }
  if (el.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_PRECEDING) {
    el.after(w);
  }
}

// A child may paint before its section, so creating the wrapper places the section's own box first.
function sectionContentEl(f: MindNode): HTMLElement {
  let w = f.sectionContentEl;
  if (!w) {
    placeSelf(f, f.x, f.y);
    w = document.createElement('div'); w.className = 'section-content'; f.sectionContentEl = w;
  }
  const box = sectionInterior(f);
  const o = contentOrigin(f);
  place(w, o.x, o.y, settledHost(f));
  w.style.width  = box.w + 'px';
  w.style.height = box.h + 'px';
  return w;
}

// A table still wider than its card is squeezed (may break inside words). Every read, then every write,
// so a paint costs one extra layout at most.
const tablesToCheck = new Set<HTMLElement>();
let tableFrame = 0;

function queueTableCheck(body: HTMLElement): void {
  tablesToCheck.add(body);
  if (!tableFrame) {
    tableFrame = requestAnimationFrame(squeezeTables);
  }
}

function squeezeTables(): void {
  cancelAnimationFrame(tableFrame);
  tableFrame = 0;
  const tables = [...tablesToCheck].filter(b => b.isConnected).flatMap(b => [...b.querySelectorAll('table')]);
  tablesToCheck.clear();
  for (const t of tables) {
    t.classList.remove('squeezed');
  }
  const over = tables.filter(t => t.offsetWidth > (t.parentElement?.clientWidth ?? Infinity) + 1);
  for (const t of over) {
    t.classList.add('squeezed');
  }
}

export function paintAll(): void {
  readOpenUnread();
  refreshSearch();
  withKids(() => {
    for (const n of state.nodes.values()) {
      paintNode(n);
    }
  });
  squeezeTables();    // before anything measures a card's height
  refreshTray();
  syncFan();
  paintFreeEdges();
  syncSelFrame();
  syncScopeChrome();
  document.body.classList.toggle('empty-map', !state.nodes.size && store.isOpen && !state.singleNote);
}

// remeasure paints first: the layout pass reads offsetHeight (the paint-before-measure rule).
export function relayout(): void { applyLayouts(); paintAll(); }

export function remeasure(): void {
  paintAll();
  if (applyLayouts()) {
    paintAll();
  }
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

