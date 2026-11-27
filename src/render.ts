// The RENDER CORE: paintNode/paintAll, where a node's element sits (placeSelf), effectiveColor, and the
// two ways to settle the canvas after a change (relayout/remeasure).
import { renderBodyHTML, taskProgress, toggleTaskAt } from './utils/markdown.js';
import { joinHeading, collapsedMarkdown, cardMarkdown, hiddenLineCount } from './utils/frontmatter.js';
import { isHidden, nodeLabel, isLockedEffective, parentOf, ancestors, heldSummary, withKids } from './utils/model.js';
import { state, world, dragLayer, isStack, type MindNode } from './core/state.js';
import { LOCK_BADGE_SVG, FOLDER_SVG } from './view/icons.js';
import { labelScale } from './view/camera.js';
import { applyLayouts, hostSection, sectionInterior, isSection, sectionLabelled, sectionName } from './view/layout.js';
import { paintFreeEdges } from './view/free-edges.js';
import { endTitleEdit, onTitleInput, onTitleKeydown, syncOpenEditor } from './features/inline-edit.js';
import { bindNodeDrag } from './features/drag.js';
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
  // `.fold-more`: the badge at the end of a FOLDED card's chip ("+4"). Folding itself is the float bar's, X, ←/→ and the menus.
  el.innerHTML = `<div class="title-row"><div class="title"></div></div><div class="body"></div>
    <div class="fold-more"></div>
    <div class="top-edge"><div class="tag-row"></div></div><div class="task-bar"></div>
    <span class="lock-badge" title="Locked">${LOCK_BADGE_SVG}</span><span class="fold-icon">${FOLDER_SVG}</span>`;
  world.appendChild(el);
  n.el = el;
  // A FOLDED section's tooltip: its name and what it holds — "10 Cards, 4 Sections" (utils/model.ts
  // heldSummary). Worked out when the pointer arrives rather than on every paint, since it walks the folder.
  el.addEventListener('pointerenter', () => {
    if (isSectionFold(n)) {
      el.title = (sectionLabelled(n) ? sectionName(n) + '\n' : '') + heldSummary(n);
    }
  });
  bindNodeDrag(n);
  bindCardFileDrag(n);   // ⌥-drag out of the window = save as .md file(s)
  // The badge on a folded card shows the whole note (features/peek.ts) — the tap for touch,
  // which has no hover to peek with.
  const foldMore = el.querySelector(':scope > .fold-more')!;
  foldMore.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  foldMore.addEventListener('click', (e)=>{ e.stopPropagation(); peekCard(el); });
  const bodyEl = el.querySelector('.body')!;
  // body links: open externally, or jump to a wikilink's node. Don't let the click bubble to
  // the card (which would select / toggle the panel); pointerdown is stopped in bindNodeDrag.
  bodyEl.addEventListener('click', (e)=>{
    const zoom = (e.target as HTMLElement).closest('.img-zoom') as HTMLElement | null;
    if (zoom){
      e.stopPropagation();
      const img = zoom.closest('.img-wrap')?.querySelector('img.md-img') as HTMLImageElement | null;
      openImageAt(n, img);
      return;
    }
    // a `#tag` written in the note filters by it, like the chip on the card's edge
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
  // task checkboxes: toggle the matching [ ]/[x] in the body and persist
  bodyEl.addEventListener('change', (e)=>{
    const cb = (e.target as HTMLElement).closest('input.taskbox') as HTMLInputElement | null;
    if (!cb) {
      return;
    }
    e.stopPropagation();
    toggleTask(n, +(cb.dataset.ti ?? 0));
  });
  // A section's label is renamed on itself (ui-state.ts TitleEdit); a card's name is the `# ` line of its one text.
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

// A card's colour is its own, else the nearest coloured ancestor's. Mid-drag the walk previews the section
// it will land in (drag.dropTarget) instead of its about-to-change parent.
export function effectiveColor(n: MindNode): string {
  // A SECTION wears only its own colour: one nested in a blue section would otherwise turn blue too and
  // vanish into it. Uncoloured, it's the neutral surface below — a box you can see inside any other.
  // A STACK's colour is its pin's, and an uncoloured pin is red.
  if (n.type === 'section') {
    return n.color || (isStack(n) ? STACK_DEFAULT_COLOR : 'white');
  }
  const drag = ui.drag;
  let previewId: string | null = null;
  let previewParent: MindNode | null | undefined;
  // …never substituting the dragged card for its OWN parent: the walk below would never leave it.
  if (drag && drag.moved && !drag.shift) {
    previewId = drag.active.id;
    previewParent = drag.dropTarget && drag.dropTarget !== previewId ? state.nodes.get(drag.dropTarget) : null;
  }
  // `guard`: a chain is only as trustworthy as the data behind it, and this
  // runs on every paint of every card — a cycle must degrade to a fallback colour, not hang the tab.
  let guard = 0;
  // A STACK's colour is its PIN's (features/stacks.ts paintPile), not something its cards wear: the walk
  // passes it by.
  for (let c: MindNode | null | undefined = n; c && guard++ < 4096; c = (c.id === previewId) ? previewParent : parentOf(c)) {
    if (c.color && !isStack(c)) {
      return c.color;
    }
  }
  // Nothing in the chain is coloured. A CARD is a sticky note, and a sticky note is yellow (docs/PRODUCT.md:
  // "a default card is a coloured sticky note") — derived here, never written, so a note on disk stays
  // uncoloured and picking a colour is still the user's own act. A SECTION is a surface cards sit ON, so it
  // keeps a neutral white (above).
  return 'amber';
}

// Notes that just ARRIVED from outside (the phone inbox, docs/inbox.md) pulse once (styles.css .arrived) —
// or the folded pill they're tucked in.
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
        at = a;   // the OUTERMOST fold is what's on screen
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
    }, 2400);
  }
}

export function paintNode(n: MindNode): void {
  ui.paintTick++;
  const el = nodeEl(n);
  // Drop the content wrapper as soon as it holds nothing (hostsContent) — ahead of the isHidden return, so a
  // fold, or the section being OPENED (hidden by the scope term), lets go of it too.
  if (n.sectionContentEl && !hostsContent(n)) { n.sectionContentEl.remove(); n.sectionContentEl = null; }
  if (isHidden(n)) { el.style.display = 'none'; return; }   // an ancestor is folded: nothing to paint
  el.style.display = '';
  const editingBody = ui.bodyEdit && ui.bodyEdit.id === n.id;    // body editor open on this card
  const hasBody = editingBody || !!(n.body && n.body.trim());  // keep the body slot while editing
  const collapsed = n.collapsed && n.type !== 'section' && canFold(n);   // a card folded to its one-line chip
  // The tags it wears on its top edge (features/tags.ts) — a section wears none.
  const tags = wearsTags(n) ? noteTags(n) : [];
  const col = effectiveColor(n);
  applyColorVars(el, col);   // a custom colour's --card/--ink/--scrim; removed again for a palette key
  el.className = 'node ' + colorClass(col)
    + (n.id === ui.resizingId ? ' resizing' : '')
    + (arrivedIds.has(n.id) ? ' arrived' : '')   // just came in from outside (flashArrived)   // its tags step aside while it's resized (styles.css)
    + (isSection(n) ? ' section' : '')
    + (isSectionFold(n) ? ' section-folded' : '')   // folded to its bare label pill (styles.css)
    + (isStack(n) ? ' stack' + (ui.fan === n.id ? ' fan-open' : '') : '')   // a pile of its cards (features/stacks.ts)
    + (ui.fan && n.parent === ui.fan ? ' fanned' : '')   // a card of the stack fanned out over the board
    + (imageLook(n) ? ' image-card' : '')   // expanded: the bare picture · folded: its 40px icon
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')   // lone selection → show +
    + (collapsed ? ' collapsed' : '')
    + (n.type !== 'section' && n.title ? ' titled' : '')   // its first line is a heading (the fold arrow's height)
    + (n.locked ? ' locked' : '')
    // While its text is open the rendered title row stands down (styles.css .card-editing); set here because
    // this line rewrites className on every paint.
    + (editingBody ? ' card-editing' : '')
    + (hasBody ? '' : ' no-body')
    + (tags.length ? '' : ' no-tags')
    + (ui.titleEdit?.id === n.id ? ' title-editing' : '')   // a section's label is being typed into
    // float the dragged subtree above all cards — and, once it has actually moved, give it the hand
    + (ui.drag?.targets?.has(n.id) ? (ui.drag.moved ? ' dragging grabbed' : ' dragging') : '')
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '')
    + (state.searchActiveId === n.id ? ' search-active' : '');   // active dropdown option → white outline
  // Which section (if any) hosts this card's element — settled outside gestures (see settledHost).
  settledHost(n);
  // Mid-drag: left/top stay frozen at the pre-drag origin and the move is a transform, the same scheme as
  // applyDragTransform (drag.ts), so a repaint can't double-count the delta. A dragged card leaves its section's
  // clip for the drag root; a child CARRIED by its own section's drag stays inside it, with no transform of its own.
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
    // root → #world; a section's child → its content wrapper. A section's box and its wrapper must stay SIBLINGS.
    const np = paintPos(n);   // live, or the frozen drag origin — see paintPos
    placeSelf(n, np.x, np.y);
  }
  // The size, and the resize zones its kind supports. A plain card's n.h is a MIN-height its text can exceed,
  // unless n.clip (dragged shorter: exact, body capped below). While edited it holds its height (BodyEdit.holdH);
  // folded it's a chip whatever its n.h.
  if (!heightIsDeclared(n) && !collapsed && !isStack(n)) {
    const hold = ui.bodyEdit?.id === n.id ? ui.bodyEdit.holdH ?? 0 : 0;
    const min = Math.max(n.h != null ? n.h : 0, hold);
    el.style.minHeight = min ? min + 'px' : '';
  } else if (el.style.minHeight) {
    el.style.minHeight = '';
  }
  if (isStack(n)) {
    // a pile: its bottom card's width, its height whatever the face measures, and nothing to resize
    el.style.width = nodeW(n) + 'px';
    el.style.height = ''; el.style.maxWidth = '';
    clearResizeHandles(el);
  } else if (isBoxNode(n)) {
    el.style.width = nodeW(n) + 'px';
    el.style.height = nodeH(n) + 'px';
    ensureResizeHandles(n);
    if (isSection(n)) {
      sectionContentEl(n);   // create/reposition/resize this section's overflow:hidden content wrapper
    }
  } else if (isSectionFold(n)) {
    // folded: the element is the bare pill, shrink-wrapped by CSS (.section-folded) — no inline size,
    // no resize zones (unfolding gives the box back at its authored size).
    if (el.style.width) { el.style.width = ''; el.style.height = ''; }
    clearResizeHandles(el);
  } else if (isImageFold(n)) {
    // folded: an IMAGE_FOLD square of the picture (styles.css). It keeps its handles: scaling it up unfolds it.
    el.style.width = ''; el.style.height = '';
    ensureResizeHandles(n);
  } else {
    // A plain card: an authored width if it has one (else back to the CSS-fixed card width), never an
    // inline height — its authored height is the min-height set above.
    // FOLDED it's a chip that shrink-wraps its one line (styles.css .collapsed), up to the width it has open.
    const authored = n.w != null && !collapsed;
    el.style.width = authored ? nodeW(n) + 'px' : '';
    const cap = collapsed ? (n.w ?? NODE_W) + 'px' : '';
    if (el.style.maxWidth !== cap) {
      el.style.maxWidth = cap;
    }
    if (el.style.height) {
      el.style.height = '';
    }
    // A FOLDED card is a chip sized by its one line: nothing to drag, so no handles (and no corner
    // squares on it when selected). Unfolding hands them back on the next paint.
    if (collapsed) {
      clearResizeHandles(el);
    } else {
      ensureResizeHandles(n);
    }
  }
  // Don't clobber a SECTION's label while it's being renamed on itself (ui.titleEdit — the user is
  // typing into this very element). A card needs no such guard: its name is the leading `# ` line of its
  // one text field, and while that's open the whole row is hidden (`.card-editing`).
  if (!(ui.titleEdit && ui.titleEdit.id === n.id)) {
    const titleEl = el.querySelector('.title') as HTMLElement;
    // A CARD has no label of its own: its `# ` line is an H1 in its markdown body, so the slot stays empty
    // (`no-title`). A SECTION's label is its NAME, rendered as one inline line of that same markdown.
    if (isSection(n) || isSectionFold(n) || isStack(n)) {
      // A section's label is its NAME and nothing else (sectionName). FOLDED, the section is a folder icon
      // and that same label beside it; what it holds is in the tooltip.
      const sect = isSection(n) || isSectionFold(n);
      const md = sect ? joinHeading(sectionName(n), '') : joinHeading(n.title, '', false) || collapsedMarkdown(n);
      // …and, while a search is on, how many of what a folded one holds match it (features/search.ts).
      const hits = isSectionFold(n) ? searchHitsIn(n.id) : 0;
      const full = sect ? sectionName(n) : nodeLabel(n);
      // Keyed on the source text: paintAll runs per frame during a resize, and re-parsing the tab every time is waste.
      const key = md + '\u0000' + hits;
      if (titleEl.dataset.md !== key){
        titleEl.dataset.md = key;
        titleEl.innerHTML = (md.trim() ? renderBodyHTML(md) : '')
          + (hits ? `<span class="section-hits" title="${hits} matching the search">${hits} match${hits === 1 ? '' : 'es'}</span>` : '');
      }
      // Ellipsised lines, so the full text lives in the tooltip — when folded, on the whole element (the icon
      // too) and written as the pointer comes in (nodeEl), since saying what the folder holds walks it.
      if (isSectionFold(n)) {
        titleEl.removeAttribute('title');
      } else {
        titleEl.title = full;
        el.removeAttribute('title');
      }
      // A nameless section shows no label (folded: a bare pill stub), but its fold chip stays (styles.css) —
      // except while its label editor is open.
      el.classList.toggle('no-title', !sectionLabelled(n) && ui.titleEdit?.id !== n.id);
      el.style.setProperty('--ls', String(labelScale()));   // a readable name at any zoom (camera.ts)
    } else {
      titleEl.textContent = '';
      titleEl.removeAttribute('title');
      delete titleEl.dataset.md;    // retyped away from a section: don't let the stale key match later
      el.classList.toggle('no-title', true);
    }
  }
  const bodyEl = el.querySelector('.body') as HTMLElement;
  // don't clobber the body while it's being edited in place (the textarea lives inside .body)
  if (!editingBody) {
    // Keyed on the source text, as the tab above: a paint that only MOVED cards skips the parse and re-render.
    const md = collapsed ? collapsedMarkdown(n) : cardMarkdown(n);
    const fresh = bodyEl.dataset.md !== md;
    if (fresh){
      bodyEl.dataset.md = md;
      bodyEl.innerHTML = renderBodyHTML(md);
      hydrateImages(bodyEl, n.file);   // swap inline-image placeholders for resolved (blob/remote) URLs
    }
    // a table's fit changes with the text and with the card's width (squeezeTables)
    const tw = String(nodeW(n));
    if ((fresh || bodyEl.dataset.tw !== tw) && md.includes('|')) {
      bodyEl.dataset.tw = tw;
      queueTableCheck(bodyEl);
    }
  }
  // Its TAGS along the top edge (styles.css .tag-row), first tag rightmost. Keyed, so a repaint mid-drag
  // can't destroy a chip under the pointer.
  const tagRowEl = el.querySelector('.tag-row') as HTMLElement;
  const tagsKey = tags.map(t => (t.inText ? '~' : '') + t.tag).join(' ') + (tags.length && searchTags().length ? '\u0000' + searchTags().join(' ') : '');
  if (tagRowEl.dataset.tagsKey !== tagsKey) {
    tagRowEl.dataset.tagsKey = tagsKey;
    tagRowEl.innerHTML = tags.map(tagChipHTML).join('');
    bindCardTags(tagRowEl, n.id);
  }
  // …and at the end of a folded card's chip, how much it's hiding: how many more lines ("+4"). Tapping it
  // peeks (features/peek.ts).
  const more = el.querySelector(':scope > .fold-more') as HTMLElement;
  const hidden = collapsed && !imageLook(n) ? hiddenLineCount(n) : 0;
  const moreText = hidden ? `+${hidden}` : '';
  if (more.textContent !== moreText){
    more.textContent = moreText;
    more.title = hidden ? `${hidden} more line${hidden === 1 ? '' : 's'}` : '';
  }
  // A checklist's progress: a green bar across the top of the card, inside it — open cards only. It fills left to right with the share done (--done); hovered, it says "3/5".
  const bar = el.querySelector(':scope > .task-bar') as HTMLElement;
  const tp = n.type === 'section' || collapsed ? { done: 0, total: 0 } : taskProgress(n.body);
  const barTitle = tp.total ? `${tp.done}/${tp.total}` : '';
  el.classList.toggle('has-tasks', tp.total > 0);
  if (bar.title !== barTitle){
    bar.title = barTitle;
    bar.style.setProperty('--done', `${tp.total ? Math.round(tp.done / tp.total * 100) : 0}%`);
  }
  // A stack's FACE — its top cards drawn as a pile and its pin — or the leftovers of one gone.
  paintPile(n, el);

  // A CLIPPED card (n.clip) is exactly n.h tall, its body capped and cut; an EDITED one is exactly the height
  // it opened at (holdH) and scrolls inside — typing never changes a card's height.
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

// Whether `n` holds its children in a content wrapper of its own: an expanded, visible section box.
function hostsContent(n: MindNode): boolean {
  return isSection(n) && !isHidden(n);
}

// WHICH element carries a node's visible title: its `.title-row`, or a folded section's whole element. The
// float bar centres on it.
export function labelEl(n: MindNode): HTMLElement | null {
  if (!n.el) {
    return null;
  }
  return isSectionFold(n) ? n.el : (n.el.querySelector(':scope > .title-row') as HTMLElement | null);
}

// ---------- section content containment ----------
// A section clips what it holds with a real overflow:hidden wrapper its cards and nested sections are re-parented into.
//
// Which section hosts `n`'s element, DOM-wise — settled only outside a gesture (drag / edit), so re-parenting
// can't drop a captured pointer or blur an open editor. Mid-gesture callers get what was last settled.
export function settledHost(n: MindNode): MindNode | null {
  if (ui.drag || inPlaceEditActive()) {
    return n.hostSectionId ? (state.nodes.get(n.hostSectionId) ?? null) : null;
  }
  const want = hostSection(n);
  n.hostSectionId = want ? want.id : null;
  return want;
}

// While a drag is live the dragged elements live in #dragLayer (one opacity group), not #world.
function dragRoot(): HTMLElement { return (ui.drag && ui.drag.moved) ? dragLayer : world; }

// The coordinates a left/top write must use: the live position, or the PRE-DRAG origin while dragged — the
// move is a transform on top (paintNode, applyDragTransform), so writing the live one counts the delta twice.
function paintPos(n: MindNode): Pt {
  return ui.drag?.origins?.get(n.id) ?? n;
}

// Place an element at absolute world coords, relative to its container: the drag root, or the host's content
// wrapper, which sits at the host's INTERIOR.
function place(el: HTMLElement, absX: number, absY: number, host: MindNode | null): void {
  if (!host) {
    return placeIn(el, absX, absY, dragRoot(), 0, 0);
  }
  const o = contentOrigin(host);
  placeIn(el, absX, absY, sectionContentEl(host), o.x, o.y);
}

// The mechanical half of place(): write absolute world (absX,absY) as an offset from `container`'s own
// world origin and (re)parent into it.
function placeIn(el: HTMLElement, absX: number, absY: number, container: HTMLElement, ox: number, oy: number): void {
  el.style.left = (absX - ox) + 'px';
  el.style.top  = (absY - oy) + 'px';
  if (el.parentElement !== container) {
    container.appendChild(el);
  }
}

// Where a container's content wrapper sits in world coords, on the paint basis (paintPos) — the one point
// place(), sectionContentEl() and followEdges() must agree on.
function contentOrigin(host: MindNode): Pt {
  const box = sectionInterior(host);
  const bp = paintPos(host);
  return { x: bp.x + (box.x - host.x), y: bp.y + (box.y - host.y) };
}

// Put a node's OWN element in its host's content wrapper, or straight under #world.
export function placeSelf(n: MindNode, absX: number, absY: number): void {
  ui.paintTick++;
  place(nodeEl(n), absX, absY, settledHost(n));
  orderContentAfterBox(n);
}

// Keep a section's box BEFORE its content wrapper among their siblings: both are z-index:auto, so document
// order decides, and the box's fill would cover a nested section. Any re-append of the box (e.g. a drop
// returning both from #dragLayer) can invert them.
function orderContentAfterBox(n: MindNode): void {
  const w = n.sectionContentEl, el = n.el;
  if (!w || !el || w.parentElement !== el.parentElement) {
    return;
  }
  if (el.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_PRECEDING) {
    el.after(w);
  }
}

// A section's clipping wrapper (styles.css .section-content), sized to its interior. Idempotent: a child may
// paint before its section, so creating it places the section's own box FIRST (see orderContentAfterBox).
function sectionContentEl(f: MindNode): HTMLElement {
  let w = f.sectionContentEl;
  if (!w) {
    placeSelf(f, f.x, f.y);
    w = document.createElement('div'); w.className = 'section-content'; f.sectionContentEl = w;
  }
  const box = sectionInterior(f);
  // Positioned on the paint basis (frozen mid-drag, like the box), sized to sectionInterior.
  const o = contentOrigin(f);
  place(w, o.x, o.y, settledHost(f));
  w.style.width  = box.w + 'px';
  w.style.height = box.h + 'px';
  return w;
}

// A table wraps between words (styles.css); one still wider than its card is SQUEEZED, its cells allowed to break
// inside a word. Batched — every read, then every write — so a paint costs one extra layout at most.
const tablesToCheck = new Set<HTMLElement>();
let tableFrame = 0;

function queueTableCheck(body: HTMLElement): void {
  tablesToCheck.add(body);
  if (!tableFrame) {
    tableFrame = requestAnimationFrame(squeezeTables);   // for a lone paintNode; paintAll settles sooner
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
  readOpenUnread();   // an open section whose notes are still on disk reads them (data/lazy.ts)
  refreshSearch();    // what the search lights, off the tags and text as they are now
  withKids(() => {
    for (const n of state.nodes.values()) {
      paintNode(n);
    }
  });
  squeezeTables();    // before anything measures a card's height
  refreshTray();      // the tag tray's stickers, when it's out
  syncFan();          // the scrim under a fanned-out stack (features/stacks.ts)
  paintFreeEdges();
  syncSelFrame();     // the frame round a multi-selection (features/sel-frame.ts)
  syncScopeChrome();   // crumbs + reading class + the recovery when the section you were inside has gone
  document.body.classList.toggle('empty-map', !state.nodes.size && store.isOpen && !state.singleNote);   // #emptyHint
}

// The two ways to settle the canvas after a change. relayout(): the open-section bookkeeping, then paint.
// remeasure(): paint FIRST, then the same — for anything that changes a card's measured height.
export function relayout(): void { applyLayouts(); paintAll(); }

export function remeasure(): void {
  paintAll();
  if (applyLayouts()) {
    paintAll();
  }
}

// Flip the idx-th task checkbox in a node's body and write the change back to disk.
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

