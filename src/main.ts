// The entry and the RENDER CORE: paintNode/paintAll, where a card's element sits (placeSelf), the
// animated relayout, and effectiveColor. Everything interactive lives in features/ and shares live
// state via the `ui` holder; the keyboard and the ⌘P list are features/commands.ts. Its imports below
// also wire the features up, in order, before boot().
/* ============================================================
   Corkboard — hierarchy + collapse + add-child
   Storage: one .md per node, and a section is a FOLDER holding its cards (`_index.md` is its own
   note); arrangement lives in board.json — no ids on disk.
   The path IS the node's identity; in-memory ids are ephemeral, minted per load.
   ============================================================ */

import './utils/legacy-keys.js';   // FIRST: renames the pre-Corkboard localStorage keys on import
import './styles.css';   // app styles (Vite bundles + singlefile inlines into dist/index.html)
import { renderBodyHTML, taskProgress, toggleTaskAt } from './utils/markdown.js';
import { joinHeading, collapsedMarkdown, cardMarkdown, hiddenLineCount } from './utils/frontmatter.js';
import { isHidden, nodeLabel, isLockedEffective, parentOf, ancestors, descendantCount } from './utils/model.js';
import { state, world, dragLayer, isStack } from './core/state.js';
import { setupGrid } from './view/grid.js';
import { mountIcons, LOCK_BADGE_SVG } from './view/icons.js';
import { screenToWorld, labelScale } from './view/camera.js';
import { applyLayouts, hostSection, sectionInterior, isSection, sectionLabelled, sectionDescription } from './view/layout.js';
import { paintFreeEdges } from './view/free-edges.js';
import './features/gestures.js';   // registers the canvas pan/zoom/marquee gesture listeners
import './features/attachments.js';   // registers the OS image drag/drop listeners
import './features/text-drag.js';   // registers the drag-body-text-out-of-a-card listeners
import './features/context-menu.js';   // registers the custom right-click menu on the canvas
import './features/ghost-card.js';   // registers the drag-a-new-card-off-the-ghost gesture
import './features/commands.js';   // the keyboard shortcuts and the ⌘P palette's list of every action
import { startInlineEdit, startBodyEdit, endTitleEdit, onTitleInput, onTitleKeydown, syncOpenEditor } from './features/inline-edit.js';
import { addCardInside } from './features/crud.js';
import { bindNodeDrag } from './features/drag.js';
import { paintPile, syncFan } from './features/stacks.js';
import { fanTilt } from './view/pile.js';   // also registers the Alt/Shift drag-modifier listeners
import { refreshSearch, searchHitsIn, searchTags, toggleSearchTag } from './features/search.js';
import { syncFloatBar } from './features/float-bar.js';   // also registers the float bar's own listeners
import { setupCanvasColor } from './features/canvas-color.js';   // canvas colour button — imported HERE, see the note in setupCanvasColor's call below
import { bindCardFileDrag } from './features/clipboard.js';
import { bindCardTags, tagChipHTML } from './features/tags.js';
import { refreshTray } from './features/tag-tray.js';
import { noteTags, wearsTags } from './utils/tags.js';
import { record } from './features/history.js';
import { hydrateImages } from './features/images.js';
import { openImageViewer } from './features/image-viewer.js';
import { readOpenUnread } from './data/lazy.js';
import { showStart, boot } from './boot.js';
import { scopeActive, isScopeRoot, canOpen } from './nav/scope.js';
import type { MindNode } from './core/state.js';
import { installPeek, peekCard } from './features/peek.js';
import { installEdgeTools } from './features/edge-tools.js';
import { ui, inPlaceEditOn, inPlaceEditActive, type Pt } from './core/ui-state.js';
import { byId } from './utils/dom.js';
import { applyColorVars, colorClass } from './view/color.js';
import { canFold, isSectionFold, imageLook, heightIsDeclared, isBoxNode, nodeW, nodeH, isImageFold, NODE_W } from './view/geometry.js';
import { ensureResizeHandles, SECTION_DIRS, clearResizeHandles } from './features/resize.js';
import { toggleCollapse } from './features/fold.js';
import { openSection, syncScopeChrome } from './nav/sections.js';
import { focusByTitle } from './nav/focus.js';
import { applyReadOnly } from './features/read-only.js';
import { scheduleSave } from './data/save.js';

mountIcons();                         // fill [data-icon] placeholders with their SVG assets
setupGrid();
// Wiring only — it must not READ anything back out of main. Everything down here runs while main's
// own body is still evaluating, so main's top-level consts below are still in their temporal dead
// zone; touching one from a feature's setup is a TDZ crash that takes the whole boot with it.
setupCanvasColor();

// ---------- rendering ----------
function nodeEl(n: MindNode): HTMLElement {
  if (n.el) {
    return n.el;
  }
  const el = document.createElement('div');
  el.dataset.id = n.id;
  // `.fold-more` is the badge at the end of a FOLDED card's chip ("+4", "3/5" — paintNode). There is no
  // fold button on the card: folding is the float bar's (features/float-bar.ts fbFold), X, ←/→ and the
  // menus, and a double-click on anything folded unfolds it (activateNode).
  el.innerHTML = `<div class="title-row"><div class="title"></div></div><div class="body"></div>
    <div class="fold-more"></div>
    <div class="top-edge"><div class="tag-row"></div></div><div class="task-bar"></div>
    <span class="lock-badge" title="Locked">${LOCK_BADGE_SVG}</span>`;
  world.appendChild(el);
  n.el = el;
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
  // For a CARD the `.title` is a rendered label and nothing else — its name is the leading `# ` line of
  // its one text field, so there's no title editor to bind (which is what took the `.invalid` styling
  // with it). These listeners are for a SECTION's label, the one thing still renamed on itself
  // (ui-state.ts TitleEdit).
  const titleEl = el.querySelector('.title') as HTMLElement;
  titleEl.addEventListener('input',   ()  => onTitleInput(n));
  titleEl.addEventListener('keydown', (e) => onTitleKeydown(e as KeyboardEvent, n));
  titleEl.addEventListener('blur',    ()  => {
    if (ui.titleEdit && ui.titleEdit.id === n.id) {
      endTitleEdit();
    }
  });
  // Double-click OPENS the node — rename / edit its note / add a card inside it, dispatched by what
  // was hit (activateNode). Folding lives on the corner chip above.
  el.addEventListener('dblclick', (e)=>{
    // The INNERMOST card owns the gesture, whether or not it acts on it — child cards are DOM-nested,
    // so anything this handler DECLINES still bubbles to its host card, which reads it as a
    // double-click on itself. Hence the stopPropagation ahead of the two bails rather than after
    // them: double-clicking a word inside an open editor (the ordinary way to fix one word of a name)
    // reached the host and opened the HOST's editor, which closed this one and sent the rest of the
    // typing into the parent's note. A section's children are NOT nested (they live in its sibling
    // .section-content wrapper), so this is about the card's own controls.
    e.stopPropagation();
    // while editing this node, a double-click selects a word — don't take it over
    if (inPlaceEditOn(n.id)) {
      return;
    }
    // the card's own buttons keep their click — except a SECTION's resize zones, which lie over the rim
    // this gesture now writes on (onSectionRim / activateNode)
    if (isNodeControlAt(e.clientX, e.clientY) && !onSectionRim(n, e.clientX, e.clientY)) {
      return;
    }
    e.preventDefault();
    activateNode(n, e.clientX, e.clientY, { open: e.altKey });
  });
  return el;
}

// Open one of a card's images full-screen. The RESOLVED src comes off the rendered <img> (hydrateImages
// has already put it there), and `n` + the image's own path give the viewer its run: every image in the
// cards that share this card's parent, paged with ‹ / › (features/image-viewer.ts). Shared by the
// magnifier button and the Space tap below, so both open the same view of the same set.
export function openImageAt(n: MindNode, img: HTMLImageElement | null): boolean {
  if (!img || !img.src || img.classList.contains('md-img-missing')) {
    return false;
  }
  openImageViewer(img.src, img.alt, { nodeId: n.id, path: img.dataset.path ?? '' });
  return true;
}
// A node's own controls — each already acts on a single click, so a double one must not also be read
// as "open this card". `.fh` is a resize handle; the rest are the card's buttons, links and inputs.
const NODE_CONTROLS = '.fold-more, .taskbox, .lock-badge, .tag-row, .md-tag, .img-zoom, a.lk, .fh';
// What a gesture at these viewport coords actually hits. Deliberately NOT the event's own `target`:
// bindNodeDrag takes a POINTER CAPTURE on the node's element, and a capture retargets the click (and
// so the dblclick) that follows to the capturing element — so by the time a double-click arrives its
// `target` is always the whole `.node` and can no longer tell a title from a body. Hit-testing the
// point is the only reading of "what did they double-click" that survives the capture.
const hitAt = (cx: number, cy: number): Element | null => document.elementFromPoint(cx, cy);
export const isNodeControlAt = (cx: number, cy: number): boolean => !!hitAt(cx, cy)?.closest(NODE_CONTROLS);
// Is this point on a section's own BORDER rather than in its interior? Measured GEOMETRICALLY, not by
// what was hit: the content wrapper is click-through, so a hit anywhere inside the box comes back as the
// section's own element and can't tell the rim from the middle. The band is the border plus a little
// tolerance inside, and the reach of the resize zones outside — which is the same strip, and the reason
// this gesture has to be allowed past the NODE_CONTROLS bail: a double-click means nothing on a resize
// handle (it acts on a drag), so the rim is free to carry "write on this section".
// (spelled as numbers, not off SECTION_BORDER: this sits above that declaration, and it is a TOLERANCE
// around the border rather than the border itself — 4px of rim plus 4 of slack, 8px of handle outside.)
const RIM_IN = 8, RIM_OUT = 8;
function onSectionRim(n: MindNode, cx: number, cy: number): boolean {
  const el = n.el;
  if (!el) {
    return false;
  }
  const r = el.getBoundingClientRect();
  const k = state.view.k, inB = RIM_IN * k, outB = RIM_OUT * k;
  if (cx < r.left - outB || cx > r.right + outB || cy < r.top - outB || cy > r.bottom + outB) {
    return false;
  }
  return cx <= r.left + inB || cx >= r.right - inB || cy <= r.top + inB || cy >= r.bottom - inB;
}
// ---------- double-click / double-tap = OPEN this node ----------
// Folding lives on the float bar and X, which leaves the gesture free for
// what a double-click means nearly everywhere else: open the thing for editing. What it opens is
// decided by WHAT WAS HIT:
//   · the title (a card's title row, a section's tab), or a section's rim  → rename in place
//   · anywhere else on a card                                          → edit its note
//   · a SECTION's interior                                               → a new card THERE
// A FOLDED node is nothing but its title (its body is display:none), so every hit on it renames —
// otherwise a double-click would open an editor inside a hidden .body.
// Shared by nodeEl's dblclick and the touch double-tap in features/drag.ts.
export function activateNode(n: MindNode, cx: number, cy: number, { open = false }: { open?: boolean } = {}): void {
  // ⌥-DOUBLE-CLICK, or a two-finger double-tap on touch, on a SECTION: go IN. The one navigating gesture
  // on a node, held apart from the editing ones by the modifier rather than by which PART of the section
  // was hit. A FOLDED section is a folder icon, so a plain double-click goes in too, as in Finder. Ahead of
  // the read-only bail on purpose, the same exemption openSection itself takes: looking inside something
  // isn't changing it. A card has no inside, so on one it's a plain double-click.
  if ((open || n.collapsed) && canOpen(n)) { openSection(n); return; }

  // A STACK has nothing to type into but its name, on the tab it wears once it has one. A click already
  // fans it out (features/stacks.ts), so the rest of a double-click there means nothing more.
  if (isStack(n)) {
    if (hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el) {
      startInlineEdit(n);
    }
    return;
  }
  // Read-only (a map the user has locked down): there is nothing to edit, so the
  // gesture keeps its old meaning — fold/unfold, the one thing this mode still allows. Browsing a
  // read-only map is all expanding, so leaving the double-click inert there would just cost a gesture.
  if (state.readOnly) { toggleCollapse(n.id); return; }
  // `parentElement === n.el` keeps it to this node's OWN row: .title-row is always a direct child, so
  // a hit inside a DOM-nested child card can't be read as a hit on its host's title.
  const onTitle = hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el;
  // startInlineEdit is the single rename funnel: it refuses a locked node.
  // A FOLDED card unfolds: the chip is a summary, and the double-click asks to see what's in it.
  if (n.collapsed) { toggleCollapse(n.id); return; }
  if (onTitle) { startInlineEdit(n); return; }
  // A section's own RIM edits its text — the chrome a section has that isn't its interior or its tab
  // (which an unnamed section doesn't draw), so there's one way to write on a section whether it's named.
  if (isSection(n) && onSectionRim(n, cx, cy)) { startInlineEdit(n); return; }
  // A SECTION's interior gets a new card WHERE YOU POINTED. Going in is ⌥-double-click (above), ↑, the
  // float bar's Open (→]) or ⋯ → Open. isSection: a folded section has no interior on screen, so it falls through.
  if (isSection(n)) { addCardInside(n.id, screenToWorld(cx, cy)); return; }
  startBodyEdit(n, { x: cx, y: cy });
}
// A card's colour is its own, or — if unset — inherited from the nearest coloured ancestor (a section).
// While dragging, preview what that inherited colour is ABOUT TO become, so it doesn't wait for the
// drop: the walk continues from the section the dragged card will land in (drag.dropTarget, null = the
// top level) instead of its real, about-to-change parent. Only from the actively dragged node on, so
// a dragged section's contents preview with it (their own walk passes through it).
export function effectiveColor(n: MindNode): string {
  // A SECTION wears only its own colour: one nested in a blue section would otherwise turn blue too and
  // vanish into it. Uncoloured, it's the neutral surface below — a box you can see inside any other.
  if (n.type === 'section') {
    return n.color || 'white';
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
  for (let c: MindNode | null | undefined = n; c && guard++ < 4096; c = (c.id === previewId) ? previewParent : parentOf(c)) {
    if (c.color) {
      return c.color;
    }
  }
  // Nothing in the chain is coloured. A CARD is a sticky note, and a sticky note is yellow (docs/PRODUCT.md:
  // "a default card is a coloured sticky note") — derived here, never written, so a note on disk stays
  // uncoloured and picking a colour is still the user's own act. A SECTION is a surface cards sit ON, so it
  // keeps a neutral white (above).
  return 'amber';
}
// Notes that just ARRIVED from outside (a reload found them — the phone inbox, docs/inbox.md), each
// shown as the node you can see: itself, or the folded pill it's tucked in. They pulse once (styles.css
// .arrived). A class paintNode owns, since it rewrites className on every paint.
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
  const el = nodeEl(n);
  // Drop the content wrapper the moment it isn't holding anything — `hostsContent` is exactly the set
  // of cases the sizing chain below creates one for, so the two can't drift. ONE drop, and it sits
  // ahead of the isHidden return so it covers a hidden node too. A fold used to strand it — an empty overflow:hidden
  // div left at the box's old size, sitting over the canvas below the tab; same for a section converted
  // to a card. Its (hidden) children ride along
  // detached and are re-placed by place() the moment it holds again.
  // The OPEN section (nav/scope.ts) rides this same drop, which is how it stops hosting: it's isHidden
  // by the scope term, so hostsContent goes false and the wrapper goes with it — and hostSection then
  // hands its children #world instead, unclipped. No new lifecycle, no per-kind rule.
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
    // While this card's ONE text field is open, its rendered title row stands down — the name is the
    // `# ` line inside the textarea (styles.css .card-editing). Driven from here rather than toggled by
    // startCardEdit, because this very line reassigns className on every paint and would drop it: the
    // editor calls paintAll() itself right after opening.
    + (editingBody ? ' card-editing' : '')
    + (hasBody ? '' : ' no-body')
    + (tags.length ? '' : ' no-tags')
    + (ui.drag?.targets?.has(n.id) ? ' dragging' : '')   // float the dragged subtree above all cards
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '')
    + (state.searchActiveId === n.id ? ' search-active' : '');   // active dropdown option → white outline
  // Which section (if any) hosts this card's element — settled outside gestures (see settledHost).
  settledHost(n);
  // During drag: keep left/top frozen at the pre-drag origin and move via transform (compositor-
  // only) — the SAME scheme applyDragTransform (drag.ts) uses on every pointermove. Doing it here
  // too means a mid-drag repaint (e.g. drop-target / rip colour change) can't desync the card from
  // the cursor: if paintNode instead placed the card at its LIVE, already-moved n.x and cleared the
  // transform, the next pointermove would re-add translate(n.x-origin) on top of that moved left/top
  // and double-count the delta — the "offset jumps when a card touches its section's bounds" bug.
  // A dragged card lifts OUT of its section's overflow:hidden content wrapper into #world for the
  // duration of the gesture, so it's never masked by the section's bounds while being dragged (in
  // particular while being carried out of the box). It repaints in plain world coordinates — the
  // same as a top-level card. The one exception is a child CARRIED by its own host section's drag:
  // that child stays inside the section (the whole box moves together) and repaints at its live
  // host-relative position with no transform of its own (giving it one too would shift it twice —
  // mirrors applyDragTransform), so it keeps clipping to the section that carries it.
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
    // A child card is nested INSIDE its parent card's element, positioned by its offset from the
    // parent (n.x - parent.x — the live, staleness-proof form of rx/ry). So the parent carries its
    // whole subtree via the compositor: moving the parent's element moves every descendant with it,
    // no per-descendant left/top rewrite. Roots stay under #world; a direct section child stays in the
    // section's overflow:hidden wrapper (place()). isSection covers sections (image cards are leaves).
    const p = parentOf(n);
    const np = paintPos(n);   // live, or the frozen drag origin — see paintPos
    // (The OPEN section is the canvas even while folded: its children are top-level, never nested in its pill.)
    if (p && !isSection(p) && !isScopeRoot(p) && !isStack(p) && !isSection(n)) {
      const pEl = nodeEl(p);
      const pp = paintPos(p);
      el.style.left = (np.x - pp.x) + 'px';
      el.style.top  = (np.y - pp.y) + 'px';
      if (el.parentElement !== pEl) {
        pEl.appendChild(el);
      }
    } else {
      // root → #world; direct section child → its content wrapper. A SECTION's own box always takes
      // this branch: its content wrapper is placed by the very same place()/settledHost call
      // (sectionContentEl), and the two only stack correctly — wrapper above the box's own fill —
      // while they're SIBLINGS in one DOM parent.
      placeSelf(n, np.x, np.y);
    }
  }
  // Apply the node's size, and give it the resize hit-zones its kind supports. Every kind gets all 8.
  // A section / image card is its own 2D box. A card's height is a MINIMUM (min-height): drag it taller
  // and it stays that tall, but its text can always make it taller still — unless it was dragged SHORTER
  // than its text (n.clip), when the same n.h is exact and the body is capped (end of paintNode).
  // While its editor is open a card also holds the height it had (BodyEdit.holdH): the raw markdown
  // is a different height from the rendered note, and the card must not jump as editing starts.
  // FOLDED it's a 40px chip whatever height it was dragged to: n.h waits for the unfold.
  if (!heightIsDeclared(n) && !collapsed && !isStack(n)) {
    const hold = ui.bodyEdit?.id === n.id ? ui.bodyEdit.holdH ?? 0 : 0;
    const min = Math.max(n.h != null ? n.h : 0, hold);
    el.style.minHeight = min ? min + 'px' : '';
  } else if (el.style.minHeight) {
    el.style.minHeight = '';
  }
  if (isStack(n)) {
    // a pile: its top card's width, its height whatever the face measures, and nothing to resize
    el.style.width = nodeW(n) + 'px';
    el.style.height = ''; el.style.maxWidth = '';
    clearResizeHandles(el);
  } else if (isBoxNode(n)) {
    el.style.width = nodeW(n) + 'px';
    el.style.height = nodeH(n) + 'px';
    ensureResizeHandles(n, SECTION_DIRS);
    if (isSection(n)) {
      sectionContentEl(n);   // create/reposition/resize this section's overflow:hidden content wrapper
    }
  } else if (isSectionFold(n)) {
    // folded: the element is the bare pill, shrink-wrapped by CSS (.section-folded) — no inline size,
    // no resize zones (unfolding gives the box back at its authored size).
    if (el.style.width) { el.style.width = ''; el.style.height = ''; }
    clearResizeHandles(el);
  } else if (isImageFold(n)) {
    // folded: a fixed IMAGE_FOLD square of the picture itself (styles.css .image-card.collapsed), so
    // no inline size — nodeW/nodeH already declare it. It KEEPS its handles, though: scaling the icon
    // back up is how you unfold it (startNodeResize), the mirror of scaling a card down to fold it.
    // The authored w/h stay on the node untouched meanwhile, for the chip's own unfold.
    el.style.width = ''; el.style.height = '';
    ensureResizeHandles(n, SECTION_DIRS);
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
      ensureResizeHandles(n, SECTION_DIRS);
    }
  }
  // Don't clobber a SECTION's label while it's being renamed on itself (ui.titleEdit — the user is
  // typing into this very element). A card needs no such guard: its name is the leading `# ` line of its
  // one text field, and while that's open the whole row is hidden (`.card-editing`).
  if (!(ui.titleEdit && ui.titleEdit.id === n.id)) {
    const titleEl = el.querySelector('.title') as HTMLElement;
    // A CARD HAS NO LABEL OF ITS OWN, titled or not: it is its text, rendered as markdown, and a leading
    // `# ` line is therefore an H1 in that text exactly as `- item` is a bullet — one renderer, one set of
    // rules, nothing hoisted out of the note into a field of its own. So the slot stays empty (`no-title`
    // below collapses the row away, keeping only the fold chip that lives in it) and cardMarkdown feeds
    // the whole note to the body below.
    // A SECTION's label renders that same markdown, flattened to ONE inline line (styles.css) — so it
    // obeys the same rule while staying a label — plus one line of description under it when it has
    // one. It keeps a `.title` element rather than a body because it hangs OUTSIDE the box (a pill
    // above it, FigJam-style), and its own `.body` is display:none because the box holds cards, not a
    // note.
    if (isSection(n) || isSectionFold(n) || isStack(n)) {
      // …and under the name, on a second muted line, its DESCRIPTION (sectionDescription — the note
      // after the heading). The
      // label grows UPWARD from the box's top edge, so a description never moves the box. FOLDED, the
      // pill is one line: the name, then how many notes it holds (`.section-count`).
      const desc = isSection(n) ? sectionDescription(n) : '';
      const md = desc || isSectionFold(n) || isStack(n) ? joinHeading(n.title, '', false) || collapsedMarkdown(n) : cardMarkdown(n);
      // A folded section whose notes weren't read knows only HOW MANY there are (data/lazy.ts).
      const count = isSectionFold(n) ? n.lazy ?? descendantCount(n.id) : 0;
      // …and, while a search is on, how many of them match it (features/search.ts).
      const hits = isSectionFold(n) ? searchHitsIn(n.id) : 0;
      const full = nodeLabel(n) + (desc ? '\n' + desc : '');
      // Guarded on the source text, the way renderQueryResults keys on its result set: paintAll runs
      // once per animation FRAME for the length of a resize drag, and this arm re-parses HTML — which
      // destroys and rebuilds the tab's child nodes — where nothing about the label has changed. The
      // key carries the FALLBACK too, since a blank note renders nodeLabel instead (which can change
      // on its own, e.g. when the file is renamed) and `md` alone would never notice.
      // A section with no text of its own renders NOTHING here.
      const key = md + '\u0000' + desc + '\u0000' + (isSectionFold(n) ? count + '/' + hits : '');
      if (titleEl.dataset.md !== key){
        titleEl.dataset.md = key;
        titleEl.innerHTML = (md.trim() ? renderBodyHTML(md) : '')
          + (desc ? `<div class="section-desc">${renderBodyHTML(desc)}</div>` : '')
          + (isSectionFold(n) ? `<span class="section-count">${count}</span>` : '')
          + (hits ? `<span class="section-hits" title="${hits} matching the search">${hits} match${hits === 1 ? '' : 'es'}</span>` : '');
      }
      titleEl.title = full;   // ellipsised lines, so the full text lives in the tooltip
      // A section with nothing written on it shows NO TITLE: expanded, that means no label at all;
      // FOLDED, a bare stub of a pill. Either way its fold
      // CHIP stays visible (styles.css re-shows it inside the invisible row) — hiding that would leave a
      // nameless section with no way to open again. The rim is what you write on (onSectionRim).
      // Not while its own label editor is open, though: the row can't be invisible and be typed into.
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
    // Same guard as the section tab above, and this is the one that pays: every card on screen renders
    // its whole note per paint, i.e. per animation frame for the length of a resize or relayout — a
    // markdown parse, an HTML re-parse that replaces every child element, and hydrateImages' own
    // querySelectorAll, all to produce what is already there. Keyed on the source text, so a paint
    // that only MOVED cards skips the lot.
    const md = collapsed ? collapsedMarkdown(n) : cardMarkdown(n);
    if (bodyEl.dataset.md !== md){
      bodyEl.dataset.md = md;
      bodyEl.innerHTML = renderBodyHTML(md);
      hydrateImages(bodyEl);   // swap inline-image placeholders for resolved (blob/remote) URLs
    }
  }
  // Its TAGS, stuck along the top edge at the right — emoji as stamps, words as labels (styles.css
  // .tag-row), outside the text so they never move a line, and clear of the resize corner and the
  // ports. First tag rightmost, so adding one never moves the others. Keyed: rebuilt only when the
  // tags (or which of them the filter lights) change, so a repaint mid-drag can't destroy a chip
  // under the pointer.
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
  // A CLIPPED card (n.clip — dragged shorter than its text) is exactly n.h tall: the body is capped to
  // what's left under the padding and the rest is simply cut. Not while folded, opened as a page, or
  // edited — the editor shows the whole note, then it clips again.
  // A stack's FACE — its top cards drawn as a pile, the pin, the count — or the leftovers of one gone.
  paintPile(n, el);

  // A card of the open fan lies at a tilt (view/pile.ts fanTilt): the CSS `rotate`, which the drag's
  // `transform` leaves alone.
  const tilt = fanTilt(n.id);
  if (tilt != null) {
    el.style.setProperty('--tilt', tilt.toFixed(2) + 'deg');
  } else {
    el.style.removeProperty('--tilt');
  }
  const clipH = clipHeight(n, !!editingBody);
  if (clipH != null) {
    const cap = Math.max(0, clipH - bodyEl.offsetTop - parseFloat(getComputedStyle(el).paddingBottom));
    if (bodyEl.style.maxHeight !== cap + 'px') {
      bodyEl.style.maxHeight = cap + 'px';
    }
  } else if (bodyEl.style.maxHeight) {
    bodyEl.style.maxHeight = '';
  }
}
function clipHeight(n: MindNode, editing: boolean): number | null {
  return n.clip && n.h != null && !n.collapsed && !editing && !heightIsDeclared(n) ? n.h : null;
}
// Whether `n` currently holds its children in a content wrapper of its own (sectionContentEl) — the two
// case paintNode's sizing chain creates one for, spelled once so its cleanup can't drift from it: an
// expanded section BOX.
// Being HIDDEN (an ancestor folded) counts as holding nothing, which is what lets paintNode maintain
// "a wrapper exists iff hostsContent(n)" with ONE drop, ahead of its isHidden early return.
function hostsContent(n: MindNode): boolean {
  return isSection(n) && !isHidden(n);
}
// WHICH element carries this node's visible title. Its own `.title-row`, except for a section that
// renders as nothing but its tab (folded or docked), where the element IS the label. Exported because
// the float bar centres itself on the label rather than the box (features/float-bar.ts) and needs the
// same answer this does — so a kind whose label element differs is a change in one place, not two.
export function labelEl(n: MindNode): HTMLElement | null {
  if (!n.el) {
    return null;
  }
  return isSectionFold(n) ? n.el : (n.el.querySelector(':scope > .title-row') as HTMLElement | null);
}
// ---------- section content containment (real CSS clipping, not per-card math) ----------
// A card living inside a section must never visually spill past its box — dragging near a border, or
// shrinking the section below its content, shouldn't leave cards overhanging. Section children are flat
// DOM siblings under #world like everything else, so real containment means giving each section its
// own overflow:hidden wrapper and re-parenting whatever it hosts (cards AND nested sections) into it,
// rather than a per-card clip-path hack — that also makes nested sections and grandchildren clip for
// free, and respects the section's rounded corners.
//
// Which section `n`'s element is CURRENTLY, actually parented under, DOM-wise — settled outside any
// active gesture (drag / inline-edit / body-edit) so re-parenting can't drop a captured pointer or
// blur an open editor (same caution as the old orderSections pass this replaces). Mid-gesture callers
// just get back whatever was last settled; paintNode still repositions live using that fixed host,
// so a card mid-drag stays visually clipped to wherever it's actually hosted until the drop settles.
// `hostSection` (view/layout.ts) does the actual ancestor walk — shared with edges.ts so an edge
// between two cards inside the same section clips to it too, not just the cards themselves.
function settledHost(n: MindNode): MindNode | null {
  if (ui.drag || inPlaceEditActive()) {
    return n.hostSectionId ? (state.nodes.get(n.hostSectionId) ?? null) : null;
  }
  const want = hostSection(n);
  n.hostSectionId = want ? want.id : null;
  return want;
}
// Position + (re)parent `el` so its border-box top-left lands at absolute world (absX,absY) — either
// directly under #world, or inside `host`'s content wrapper (offset by the host's own border so
// content never draws under the section's border stroke). Shared by every hosted element: a plain
// card, a section's own box, and a nested section's own content wrapper.
// While a drag is live, dragged items live in #dragLayer (one opacity group) instead of directly
// under #world — so the whole dragged set composites translucently without shining through itself.
// Only DRAGGED nodes are painted mid-drag, so this only ever relocates them (and a dragged section's
// own content wrapper); resting content is untouched. On drop ui.drag is nulled → back to #world.
function dragRoot(): HTMLElement { return (ui.drag && ui.drag.moved) ? dragLayer : world; }
// Which coordinates a left/top write must use for `n` RIGHT NOW: its live position normally, but its
// PRE-DRAG origin while it's part of a live drag. A dragged element's left/top stay frozen at that
// origin and the movement is a compositor transform on top (see the dragOrig branch in paintNode and
// applyDragTransform in features/drag.ts) — so a repaint that lands MID-drag (updateRip's rip-preview
// repaint, a drop-target change, …) must write the origin too. Writing the live position there bakes
// the drag delta into left/top while the transform still adds it, putting the element twice as far
// out: that stranded a dragged container's content wrapper away from its own box, leaving the cards
// it holds spilling out from behind the box instead of riding inside it.
// Deliberately NOT excluding a carried child (one whose host is dragging too): for those, origin- and
// live-basis give the same host-relative offset, since host and child shift by the very same delta.
// `?? n` rather than `?? {x: n.x, y: n.y}`: a MindNode already IS a Pt structurally, and this runs
// 2-4× per node per repaint — the object literal was pure allocation on the paint path.
function paintPos(n: MindNode): Pt {
  return ui.drag?.origins?.get(n.id) ?? n;
}
// Place an element at absolute world coords, expressed relative to its container: #world (or the drag
// layer) for a root, else the host container's content wrapper — which sits at the host's INTERIOR, so
// the offset is the host's own inset (the border, plus a section's title tab — see sectionInsetY).
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
// Where a container's content wrapper sits in world coords, on the PAINT basis (its frozen origin
// mid-drag — see paintPos). Everything that has to agree on that point reads it here: place() offsets
// left/top by it, sectionContentEl() positions the wrapper at it, followEdges() projects back through
// it. Expressed as a delta off the host's own origin rather than re-spelling the insets.
function contentOrigin(host: MindNode): Pt {
  const box = sectionInterior(host);
  const bp = paintPos(host);
  return { x: bp.x + (box.x - host.x), y: bp.y + (box.y - host.y) };
}
// Put a node's OWN element where it belongs: its host container's content wrapper, or straight under
// #world. The single decision point, shared by paintNode and sectionContentEl's ordering guard.
function placeSelf(n: MindNode, absX: number, absY: number): void {
  place(nodeEl(n), absX, absY, settledHost(n));
  orderContentAfterBox(n);
}
// Keep a container's own box BEFORE its content wrapper among their shared siblings. The two paint in
// the same step (both z-index:auto — see .node.section in styles.css), so document order alone decides
// which is on top: the wrapper must FOLLOW the box, or the box's opaque fill paints straight over
// everything inside it that also sits at z-index:auto — a nested section. (Plain cards are z-index:2
// and survive either way.)
// Any re-append of the box moves it to the END of its container, inverting the pair whenever the
// wrapper got there first — which is routine, since Map iteration order isn't parent-before-child, so
// a child's paint reaches sectionContentEl before the container's own paintNode. The case that actually
// bit: dropping a dragged section returns box and wrapper from #dragLayer in whatever order the repaint
// visits them. So re-assert the order after every box placement; sectionContentEl's own creation guard
// covers the mirror case (a wrapper built before its box had ever been placed).
function orderContentAfterBox(n: MindNode): void {
  const w = n.sectionContentEl, el = n.el;
  if (!w || !el || w.parentElement !== el.parentElement) {
    return;
  }
  if (el.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_PRECEDING) {
    el.after(w);
  }
}
// A section's own clipping wrapper: a plain overflow:hidden box (styles.css .section-content) sized to
// its INTERIOR (inside the border), holding every card/section it hosts as flat DOM children. Created
// once and kept live (idempotent — safe to call from a child's paint before the section's own paint
// runs in the same pass, since Map iteration order isn't parent-before-child).
// Every section box paints at the same level (z-index:auto, styles.css), so a nested section's own box
// only ends up visually on top of its ancestor's fill because it sits LATER in DOM/tree order (same
// paint step ⇒ document order decides) — the two share one flattened stacking context since
// .section-content sets no z-index of its own. That invariant breaks if THIS wrapper gets appended to
// its container before the section's own box does, which happens whenever a child paints (and so
// calls this) before the section itself gets its first paintNode pass (Map iteration order isn't
// parent-before-child). Guard it here: force the section's own box to exist and be placed in the
// container FIRST, so it always precedes this wrapper as a sibling — paintNode's later place(el,…)
// on the same box is then a same-parent no-op that doesn't reorder anything.
function sectionContentEl(f: MindNode): HTMLElement {
  let w = f.sectionContentEl;
  if (!w) {
    placeSelf(f, f.x, f.y);
    w = document.createElement('div'); w.className = 'section-content'; f.sectionContentEl = w;
  }
  const box = sectionInterior(f);
  // Position from paintPos, not box.x/box.y: mid-drag the wrapper's left/top must stay frozen at the
  // section's origin, since applyDragTransform mirrors the box's own transform onto it. Its SIZE comes
  // from sectionInterior either way (a drag moves the box, it doesn't resize it).
  // …and its OFFSET comes from the same helper, as a delta off the section's own origin, rather than
  // re-spelling sectionInterior's insets here — otherwise a change to them resizes the wrapper without
  // moving it, sliding the clip off its own box.
  const o = contentOrigin(f);
  place(w, o.x, o.y, settledHost(f));
  w.style.width  = box.w + 'px';
  w.style.height = box.h + 'px';
  return w;
}
export function paintAll(): void {
  readOpenUnread();   // an open section whose notes are still on disk reads them (data/lazy.ts)
  refreshSearch();    // what the search lights, off the tags and text as they are now
  for (const n of state.nodes.values()) {
    paintNode(n);
  }
  refreshTray();      // the tag tray's stickers, when it's out
  syncFan();          // the scrim under a fanned-out stack (features/stacks.ts)
  paintFreeEdges();
  updateEmptyHints();
  syncScopeChrome();   // crumbs + reading class + the recovery when the section you were inside has gone
}
// The two shapes of "settle the canvas after a change", spelled once each. Nearly every mutation path
// in the app ends in one of them, and which one is correct turns on a single question: did the change
// alter a MEASURED size?
//   relayout()  — the open-section bookkeeping (applyLayouts), then paint. The default.
//   remeasure() — paint FIRST, then the same. For anything that changes a card's measured height (its
//                 text, its width, or a card so new it has no element yet), so whatever runs between
//                 the two paints reads a current DOM. Nothing flows cards any more, so the two differ
//                 only in that first paint — kept apart so callers still say which they mean.
export function relayout(): void { applyLayouts(); paintAll(); }
export function remeasure(): void { paintAll(); applyLayouts(); paintAll(); }

// The first-run hint ("Drag to create a card") shows only on an empty canvas.
// "Empty" means empty OF WHAT'S ON SCREEN, so an open section with nothing in it gets the hints too —
// opening an empty folder to start filling it is the whole point of being able to open one.
function updateEmptyHints(): void {
  const empty = scopeActive() ? ![...state.nodes.values()].some(n => !isHidden(n)) : state.nodes.size === 0;
  document.body.classList.toggle('empty-canvas', empty);
}

// ---------- animated relayout (expand / collapse) ----------
function prefersReducedMotion(): boolean { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
// The animation writes left/top itself (that's what it interpolates), so it must go through the SAME
// placement authority paintNode's own final branch uses — placeSelf, not a bare place() — so a hosted
// card stays in its container's wrapper for the duration.
// Newly revealed cards emanate from the nearest ancestor that was already on screen.
function ancestorStart(node: MindNode, before: Map<string, Pt>): Pt {
  for (const p of ancestors(node)){
    const b = before.get(p.id);
    if (b) {
      return b;
    }
  }
  return { x: node.x, y: node.y };
}
// Cards glide to new spots via a CSS transition; SVG edges can't transition, so for the duration
// we redraw them each section from the cards' live (animating) on-screen positions.
// Only a line's END cards (and the sections around them, which a hidden end is drawn to) are read: the
// computed-style read is the cost, and there are far fewer of those than cards. No lines, no loop.
function followEdges(tok: number, ms: number): void {
  if (!state.edges.length) {
    return;
  }
  const ends = new Set<MindNode>();
  for (const e of state.edges) {
    for (const id of [e.from, e.to]) {
      const n = state.nodes.get(id);
      if (!n) {
        continue;
      }
      ends.add(n);
      for (const a of ancestors(n)) {
        ends.add(a);
      }
    }
  }
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (tok !== ui.animToken) {
      return;                  // superseded by a newer animation
    }
    const saved: Array<[MindNode, number, number]> = [];
    for (const n of ends){
      if (!n.el || isHidden(n)) {
        continue;
      }
      const c = getComputedStyle(n.el);             // interpolated left/top while transitioning
      saved.push([n, n.x, n.y]);
      // left/top are HOST-relative for a hosted card — project back to absolute world coords, through
      // the same origin place() measured them from (contentOrigin, on its no-drag basis).
      const host = settledHost(n);
      const o = host ? sectionInterior(host) : null;
      const px = parseFloat(c.left), py = parseFloat(c.top);
      n.x = px ? (o ? px + o.x : px) : n.x;
      n.y = py ? (o ? py + o.y : py) : n.y;
    }
    paintFreeEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }   // restore logical (final) positions
    if (now - t0 < ms) {
      requestAnimationFrame(tick);
    } else {
      paintFreeEdges();
    }
  };
  requestAnimationFrame(tick);
}
// Snapshot the on-screen position of every visible card — the START section animateReflow
// glides away from. Take it BEFORE the structural change.
export function layoutSnapshot(): Map<string, Pt> {
  const before = new Map<string, Pt>();
  for (const m of state.nodes.values()) {
    if (m.el && !isHidden(m)) {
      before.set(m.id, { x:m.x, y:m.y });
    }
  }
  return before;
}
// Run a structural change (a collapse toggle, a tidy-up) and CSS-animate the resulting reflow.
export function animateLayout(mutate: () => void): void {
  const before = layoutSnapshot();
  const sizes = sizeSnapshot();
  mutate();
  paintAll();          // reveal/hide DOM and measure real heights
  applyLayouts();      // compute FINAL positions into n.x/n.y (DOM not updated yet)
  animateReflow(before);
  animateSizes(sizes);
}
// CSS-animate every visible card from its snapshotted `before` spot to its current (final)
// n.x/n.y. Just-revealed cards (absent from `before`) fade in from their nearest ancestor.
// …and the SIZES: a fold shrinks a card to its chip or a section to its pill, Fit hugs a section round its
// cards. The final size is already on screen (paintAll ran); each element that changed is played from
// its old box to its new one with the Web Animations API, which owns width/height only for LAYOUT_ANIM_MS and
// then hands them straight back to the inline/CSS sizing — nothing is written, nothing to clean up. The
// content is clipped meanwhile, so a card's text doesn't spill out of the box as it closes. A section's
// content wrapper (its interior clip) follows the box, else its cards would pop in or out at once.
interface Size { w: number; h: number }
function sizeSnapshot(): Map<HTMLElement, Size> {
  const out = new Map<HTMLElement, Size>();
  for (const m of state.nodes.values()) {
    if (!m.el || isHidden(m)) {
      continue;
    }
    out.set(m.el, { w: m.el.offsetWidth, h: m.el.offsetHeight });
    if (m.sectionContentEl) {
      out.set(m.sectionContentEl, { w: m.sectionContentEl.offsetWidth, h: m.sectionContentEl.offsetHeight });
    }
  }
  return out;
}
// An even ease-in-out, not a sharp ease-out: the old (.22,1,.36,1) did 75% of the move in the first fifth
// of the time, so a fold read as instant however long it nominally ran.
const SIZE_EASE = 'cubic-bezier(.45,0,.25,1)';
// How long a fold / Fit / reflow glides — one number for the sizes here, the positions (animateReflow) and
// `.lt-anim`'s left/top transition in styles.css, which must say the same.
const LAYOUT_ANIM_MS = 500;
function animateSizes(before: Map<HTMLElement, Size>): void {
  if (prefersReducedMotion()) {
    return;
  }
  // A section that has just UNFOLDED had no content wrapper to snapshot: it starts as small as the box
  // it grows out of (the pill, less the box's own border), so its cards stay clipped all the way open.
  for (const m of state.nodes.values()) {
    const w = m.sectionContentEl, a = m.el ? before.get(m.el) : undefined;
    if (!w || !a || before.has(w) || !m.el) {
      continue;
    }
    before.set(w, { w: Math.max(0, a.w - (m.el.offsetWidth - w.offsetWidth)), h: Math.max(0, a.h - (m.el.offsetHeight - w.offsetHeight)) });
  }
  for (const [el, a] of before) {
    if (!el.isConnected || el.style.display === 'none') {
      continue;
    }
    const b = { w: el.offsetWidth, h: el.offsetHeight };
    if (Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1) {
      continue;
    }
    el.animate([
      { width: a.w + 'px', height: a.h + 'px', minHeight: '0px', maxWidth: 'none', overflow: 'hidden' },
      { width: b.w + 'px', height: b.h + 'px', minHeight: '0px', maxWidth: 'none', overflow: 'hidden' },
    ], { duration: LAYOUT_ANIM_MS, easing: SIZE_EASE });
  }
}
export function animateReflow(before: Map<string, Pt>): void {
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++ui.animToken;                           // supersede any in-flight animation
  if (prefersReducedMotion()){ for (const m of visible){ m.el!.classList.remove('lt-anim'); placeSelf(m, m.x, m.y); } document.body.classList.remove('layout-anim'); paintFreeEdges(); return; }
  // While cards glide and change size (this and animateSizes), the ports and resize handles would sit at
  // stale spots and sizes: they stand down until the glide ends (styles.css body.layout-anim).
  document.body.classList.add('layout-anim');
  // 1) park every visible card at its STARTING spot with no transition; just-revealed cards
  //    also start invisible so they fade in (covers free layouts where nothing reflows).
  //    A card INSIDE a section doesn't glide when it's the section that changed (a fold, an unfold, a Fit):
  //    a revealed one fades in where it lands, and one whose place in its section is unchanged just rides
  //    along with it. Only a card that moved WITHIN its section (a tidy-up) glides.
  const stays = (m: MindNode): boolean => {
    const p = parentOf(m);
    if (!p || isScopeRoot(p)) {
      return false;
    }
    const bm = before.get(m.id), bp = before.get(p.id);
    if (!bm) {
      return true;
    }
    return !!bp && Math.abs((bm.x - bp.x) - (m.x - p.x)) < 0.5 && Math.abs((bm.y - bp.y) - (m.y - p.y)) < 0.5;
  };
  // A section's content wrapper (its CLIP) is a sibling of its box, not inside it, so it glides alongside:
  // parked at the same offset from its final spot as the box, then sent home with the same transition.
  // Otherwise the box would glide while the clip jumped, and the cards would hang outside it meanwhile.
  const clips: Array<[HTMLElement, string, string]> = [];
  for (const m of visible){
    m.el!.classList.remove('lt-anim');
    const s = stays(m) ? { x: m.x, y: m.y } : before.get(m.id) || ancestorStart(m, before);
    placeSelf(m, s.x, s.y);
    if (!before.has(m.id)) {
      m.el!.style.opacity = '0';
    }
    const w = m.sectionContentEl;
    if (w?.isConnected && (s.x !== m.x || s.y !== m.y)) {
      w.classList.remove('lt-anim');
      clips.push([w, w.style.left, w.style.top]);
      w.style.left = (parseFloat(w.style.left) + s.x - m.x) + 'px';
      w.style.top  = (parseFloat(w.style.top)  + s.y - m.y) + 'px';
    }
  }
  void document.body.offsetWidth;                    // commit the start positions before transitioning
  // 2) turn on the transition and move every card to its FINAL spot → the browser animates left/top
  const DUR = LAYOUT_ANIM_MS;
  for (const m of visible){
    if (!stays(m)) {
      m.el!.classList.add('lt-anim');
    }
    placeSelf(m, m.x, m.y);
    m.el!.style.opacity = '';
  }
  for (const [w, left, top] of clips){ w.classList.add('lt-anim'); w.style.left = left; w.style.top = top; }
  // 3) edges follow the moving cards; drop the transition class once it's done
  followEdges(tok, DUR + 20);
  setTimeout(() => {
    if (tok !== ui.animToken) {
      return;
    }
    for (const m of visible) {
      m.el && m.el.classList.remove('lt-anim');
    }
    for (const [w] of clips) {
      w.classList.remove('lt-anim');
    }
    document.body.classList.remove('layout-anim');
    paintFreeEdges();
  }, DUR + 60);
}


// Flip the idx-th task checkbox in a node's body and write the change back to disk.
function toggleTask(n: MindNode, idx: number): void {
  if (state.readOnly || isLockedEffective(n)) {
    return;
  }
  record([n.id], () => {
    n.body = toggleTaskAt(n.body, idx);
    n.dirty = true;
  });
  syncOpenEditor(n);
  paintNode(n); scheduleSave();
}

syncFloatBar();

applyReadOnly();


byId('homeBtn').onclick = showStart;   // icon + folder name → home screen



installEdgeTools();   // socket / handle / edge-hit grabs, claimed ahead of card-drag and canvas-pan
installPeek();        // hover a folded card to read it (features/peek.ts)

boot();   // local-first: open straight into the last map
