// The render + selection core. The interactive subsystems (drag / inline-edit / crud / gestures /
// attachments) live in features/ and share live state via the `ui` holder; this file owns the
// render pipeline (paintNode/paintAll/paintEdges), selection + edit-panel, read-only mode, focus,
// and the global keyboard/toolbar wiring. It exports the render kernels the feature modules call
// back into. Fully strict-typed and covered by `npm run typecheck`.
/* ============================================================
   Corkboard — hierarchy + collapse + add-child
   Storage: one .md per node, and a frame is a FOLDER holding its cards (`_index.md` is its own
   note); arrangement lives in board.json — no ids on disk.
   The path IS the node's identity; in-memory ids are ephemeral, minted per load.
   ============================================================ */

import './utils/legacy-keys.js';   // FIRST: renames the pre-Corkboard localStorage keys on import
import './styles.css';   // app styles (Vite bundles + singlefile inlines into dist/index.html)
import { renderBodyHTML, taskProgress } from './utils/markdown.js';
import { joinHeading, firstTextLine } from './utils/frontmatter.js';
import { inkFor, scrimFor, isHexColor, paleFill } from './utils/ink.js';
import { childrenOf, isHidden, nodeLabel, hasLockedAncestor, isLockedEffective, parentOf, ancestors, resolveWikilink, descendantCount, nodesOf, nodeByFile } from './utils/model.js';
import { state, world, dragLayer, stage, setStatus, isImageCard } from './core/state.js';
import { setupGrid, openGridMenu } from './view/grid.js';
import { mountIcons } from './view/icons.js';
import { zoomAt, frameBox, screenToWorld, stageSize, animateViewTo, cancelViewAnim, labelScale } from './view/camera.js';
import { applyLayouts, hostFrame, frameInterior, containerBox, isFrame, frameLabelled, frameDescription } from './view/layout.js';
import { paintFreeEdges } from './view/free-edges.js';
import './features/gestures.js';   // registers the canvas pan/zoom/marquee gesture listeners
import './features/attachments.js';   // registers the OS image drag/drop listeners
import './features/text-drag.js';   // registers the drag-body-text-out-of-a-card listeners
import './features/context-menu.js';   // registers the custom right-click menu on the canvas
import { startInlineEdit, startBodyEdit, endTitleEdit, endInPlaceEdit, onTitleInput, onTitleKeydown } from './features/inline-edit.js';
import { createNode, createDetachedNode, createSibling, addCardInside, newFrameAt, duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, centredAt } from './features/crud.js';
import { bindNodeDrag, startNodeDrag, feedDragMove, commitDrag, abortDrag, settleFrames } from './features/drag.js';   // also registers the Alt/Shift drag-modifier listeners
import { openSearch, closeSearch, refreshSearch, searchActive, searchHitsIn, searchTags, toggleSearchTag } from './features/search.js';
import { syncFloatBar, autoSizeSelection, growFramesToHold, groupSelectionIntoFrame } from './features/float-bar.js';   // also registers the float bar's own listeners
import { setupCanvasColor, markCanvasColorBtn } from './features/canvas-color.js';   // canvas colour button — imported HERE, see the note in setupCanvasColor's call below
import { copySelection, cutSelection, bindCardFileDrag } from './features/clipboard.js';
import { bindCardTags, tagChipHTML } from './features/tags.js';
import { openTagPicker } from './features/tag-picker.js';
import { refreshTray, toggleTray, trayOpen } from './features/tag-tray.js';
import { noteTags, wearsTags } from './utils/tags.js';
import { commitStep, record, touch, undo, redo } from './features/history.js';
import { hydrateImages } from './features/images.js';
import { openImageViewer } from './features/image-viewer.js';
import { store, scheduleSave, flushSave, loadFromDir, exportZip } from './data/persistence.js';
import { FRAME_NOTE } from './utils/filenames.js';
import { afterReading, readOpenUnread } from './data/lazy.js';
import { showStart, boot } from './boot.js';
import { syncUrl, scheduleUrlSync, updateDocumentTitle } from './nav/url-state.js';
import { scope, scopeActive, scopeRootNode, isScopeRoot, canOpen, canEnter, outOfScope, openPathTo, type ScopeBack, type ScopeLevel } from './nav/scope.js';
import { renderCrumbs } from './features/breadcrumbs.js';
import type { MindNode } from './core/state.js';
import { installPeek, peekCard } from './features/peek.js';
import { tidyShortcut, TIDY_ACTIONS } from './features/tidy.js';
import { installEdgeTools, connectSelection, deleteSelectedEdge, clearEdgeSelection } from './features/edge-tools.js';
import { ui, isTypingInField, inPlaceEditOn, inPlaceEditActive, type Pt } from './core/ui-state.js';
import { byId } from './utils/dom.js';
import { snapTo } from './utils/num.js';
import { openPalette, closePalette, paletteOpen, setPaletteSource, type Command } from './features/palette.js';

mountIcons();                         // fill [data-icon] placeholders with their SVG assets
setupGrid();
// Wiring only — it must not READ anything back out of main. Everything down here runs while main's
// own body is still evaluating, so main's top-level consts below (SWATCH_BG, PALETTE, …) are still in
// their temporal dead zone; touching one from a feature's setup is a TDZ crash that takes the whole
// boot with it, blank canvas and all. Same reason float-bar defers createProperties to first use.
setupCanvasColor();




// ---------- rendering ----------
// small closed-padlock badge shown at a locked card's upper-left corner; exported for the
// float bar's lock toggle (features/float-bar.ts), which shares this one glyph.
export const LOCK_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
function nodeEl(n: MindNode): HTMLElement {
  if (n.el) return n.el;
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
    const a = (e.target as HTMLElement).closest('a.lk') as HTMLElement | null; if (!a) return;
    e.stopPropagation();
    if (a.classList.contains('wikilink')){
      e.preventDefault();
      focusByTitle(a.dataset.target ?? '', n);
    }
  });
  // task checkboxes: toggle the matching [ ]/[x] in the body and persist
  bodyEl.addEventListener('change', (e)=>{
    const cb = (e.target as HTMLElement).closest('input.taskbox') as HTMLInputElement | null; if (!cb) return;
    e.stopPropagation();
    toggleTask(n, +(cb.dataset.ti ?? 0));
  });
  // For a CARD the `.title` is a rendered label and nothing else — its name is the leading `# ` line of
  // its one text field, so there's no title editor to bind (which is what took the `.invalid` styling
  // with it). These listeners are for a FRAME's label, the one thing still renamed on itself
  // (ui-state.ts TitleEdit).
  const titleEl = el.querySelector('.title') as HTMLElement;
  titleEl.addEventListener('input',   ()  => onTitleInput(n));
  titleEl.addEventListener('keydown', (e) => onTitleKeydown(e as KeyboardEvent, n));
  titleEl.addEventListener('blur',    ()  => { if (ui.titleEdit && ui.titleEdit.id === n.id) endTitleEdit(); });
  // Double-click OPENS the node — rename / edit its note / add a card inside it, dispatched by what
  // was hit (activateNode). Folding lives on the corner chip above.
  el.addEventListener('dblclick', (e)=>{
    // The INNERMOST card owns the gesture, whether or not it acts on it — child cards are DOM-nested,
    // so anything this handler DECLINES still bubbles to its host card, which reads it as a
    // double-click on itself. Hence the stopPropagation ahead of the two bails rather than after
    // them: double-clicking a word inside an open editor (the ordinary way to fix one word of a name)
    // reached the host and opened the HOST's editor, which closed this one and sent the rest of the
    // typing into the parent's note. A frame's children are NOT nested (they live in its sibling
    // .frame-content wrapper), so this is about the card's own controls.
    e.stopPropagation();
    // while editing this node, a double-click selects a word — don't take it over
    if (inPlaceEditOn(n.id)) return;
    // the card's own buttons keep their click — except a FRAME's resize zones, which lie over the rim
    // this gesture now writes on (onFrameRim / activateNode)
    if (isNodeControlAt(e.clientX, e.clientY) && !onFrameRim(n, e.clientX, e.clientY)) return;
    e.preventDefault();
    activateNode(n, e.clientX, e.clientY, { open: e.altKey });
  });
  return el;
}
// A new card AT THE POINTER (the viewport centre before the mouse has moved) — what `N`/⌘N do, and
// what a Space tap used to.
function newCardAtPointer(): void {
  if (ui.lastMouse) createNode(centredAt(screenToWorld(ui.lastMouse.x, ui.lastMouse.y)));
  else createNode();
}
// …and an empty FRAME there, named on the spot — the palette's "New frame".
function newFrameAtPointer(): void {
  const m = ui.lastMouse ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  newFrameAt(screenToWorld(m.x, m.y));
}
// The phone INBOX (docs/inbox.md) is the top-level frame whose folder is `Inbox/`: a note saved into
// that folder from elsewhere shows up on the next reload (data/persistence.ts reloadFromDisk). The
// palette's "Inbox" goes to it, unfolded, and makes it first — to the left of the board's top-level
// content, so it never lands on anything — when there is none.
const INBOX_NOTE = 'inbox/' + FRAME_NOTE;
const inboxFrame = (): MindNode | undefined =>
  [...state.nodes.values()].find(n => n.type === 'frame' && n.file?.toLowerCase() === INBOX_NOTE);
function goToInbox(): void {
  const f = inboxFrame();
  if (f) {
    if (f.collapsed && !isLockedEffective(f) && afterReading([f.id], goToInbox, false)) return;
    popScopeFor(f);
    focusNode(f, true);
    return;
  }
  if (state.readOnly || !store.isOpen) { setStatus('This map has no Inbox frame'); return; }
  while (scopeActive()) exitScope();
  const tops = [...state.nodes.values()].filter(n => !n.parent);
  const left = tops.reduce((x, n) => Math.min(x, n.x), Infinity), top = tops.reduce((y, n) => Math.min(y, n.y), Infinity);
  const at = tops.length ? snapPt({ x: left - FRAME_W - 80, y: top }) : centredAt(screenToWorld(window.innerWidth / 2, window.innerHeight / 2));
  const n = createNode({ ...at, type: 'frame', w: FRAME_W, h: FRAME_H, title: 'Inbox', parent: null, edit: false });
  if (!n) return;
  focusNode(n);
  setStatus('Made the Inbox — notes saved into its folder show up here (docs/inbox.md)');
}
// Open one of a card's images full-screen. The RESOLVED src comes off the rendered <img> (hydrateImages
// has already put it there), and `n` + the image's own path give the viewer its run: every image in the
// cards that share this card's parent, paged with ‹ / › (features/image-viewer.ts). Shared by the
// magnifier button and the Space tap below, so both open the same view of the same set.
function openImageAt(n: MindNode, img: HTMLImageElement | null): boolean {
  if (!img || !img.src || img.classList.contains('md-img-missing')) return false;
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
// Is this point on a frame's own BORDER rather than in its interior? Measured GEOMETRICALLY, not by
// what was hit: the content wrapper is click-through, so a hit anywhere inside the box comes back as the
// frame's own element and can't tell the rim from the middle. The band is the border plus a little
// tolerance inside, and the reach of the resize zones outside — which is the same strip, and the reason
// this gesture has to be allowed past the NODE_CONTROLS bail: a double-click means nothing on a resize
// handle (it acts on a drag), so the rim is free to carry "write on this frame".
// (spelled as numbers, not off FRAME_BORDER: this sits above that declaration, and it is a TOLERANCE
// around the border rather than the border itself — 4px of rim plus 4 of slack, 8px of handle outside.)
const RIM_IN = 8, RIM_OUT = 8;
export function onFrameRim(n: MindNode, cx: number, cy: number): boolean {
  const el = n.el; if (!el) return false;
  const r = el.getBoundingClientRect();
  const k = state.view.k, inB = RIM_IN * k, outB = RIM_OUT * k;
  if (cx < r.left - outB || cx > r.right + outB || cy < r.top - outB || cy > r.bottom + outB) return false;
  return cx <= r.left + inB || cx >= r.right - inB || cy <= r.top + inB || cy >= r.bottom - inB;
}
// ---------- double-click / double-tap = OPEN this node ----------
// Folding lives on the float bar and X, which leaves the gesture free for
// what a double-click means nearly everywhere else: open the thing for editing. What it opens is
// decided by WHAT WAS HIT:
//   · the title (a card's title row, a frame's tab), or a frame's rim  → rename in place
//   · anywhere else on a card                                          → edit its note
//   · a FRAME's interior                                               → a new card THERE
// A FOLDED node is nothing but its title (its body is display:none), so every hit on it renames —
// otherwise a double-click would open an editor inside a hidden .body.
// Shared by nodeEl's dblclick and the touch double-tap in features/drag.ts.
export function activateNode(n: MindNode, cx: number, cy: number, { open = false }: { open?: boolean } = {}): void {
  // ⌥-DOUBLE-CLICK, or a two-finger double-tap on touch, on a FRAME: go IN. The one navigating gesture
  // on a node, held apart from the editing ones by the modifier rather than by which PART of the frame
  // was hit. Ahead of the read-only bail on purpose, the same exemption openFrame itself takes: looking
  // inside something isn't changing it. A card has no inside, so on one it's a plain double-click.
  if (open && canOpen(n)) { openFrame(n); return; }
  // Read-only (a map the user has locked down): there is nothing to edit, so the
  // gesture keeps its old meaning — fold/unfold, the one thing this mode still allows. Browsing a
  // read-only map is all expanding, so leaving the double-click inert there would just cost a gesture.
  if (state.readOnly) { toggleCollapse(n.id); return; }
  // `parentElement === n.el` keeps it to this node's OWN row: .title-row is always a direct child, so
  // a hit inside a DOM-nested child card can't be read as a hit on its host's title.
  const onTitle = hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el;
  // startInlineEdit is the single rename funnel: it refuses a locked node.
  // A FOLDED card or frame unfolds: the pill is a summary, and the double-click asks to see what's in it.
  if (n.collapsed) { toggleCollapse(n.id); return; }
  if (onTitle) { startInlineEdit(n); return; }
  // A frame's own RIM edits its text — the chrome a frame has that isn't its interior or its tab
  // (which an unnamed frame doesn't draw), so there's one way to write on a frame whether it's named.
  if (isFrame(n) && onFrameRim(n, cx, cy)) { startInlineEdit(n); return; }
  // A FRAME's interior gets a new card WHERE YOU POINTED. Going in is ⌥-double-click (above), ↑, the
  // float bar's Open (→]) or ⋯ → Open. isFrame: a folded frame has no interior on screen, so it falls through.
  if (isFrame(n)) { addCardInside(n.id, screenToWorld(cx, cy)); return; }
  startBodyEdit(n, { x: cx, y: cy });
}
// A card's colour is its own, or — if unset — inherited from the nearest coloured ancestor (a frame).
// While dragging, preview what that inherited colour is ABOUT TO become, so it doesn't wait for the
// drop: the walk continues from the frame the dragged card will land in (drag.dropTarget, null = the
// top level) instead of its real, about-to-change parent. Only from the actively dragged node on, so
// a dragged frame's contents preview with it (their own walk passes through it).
export function effectiveColor(n: MindNode): string {
  // A FRAME wears only its own colour: one nested in a blue frame would otherwise turn blue too and
  // vanish into it. Uncoloured, it's the neutral surface below — a box you can see inside any other.
  if (n.type === 'frame') return n.color || 'white';
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
  for (let c: MindNode | null | undefined = n; c && guard++ < 4096; c = (c.id === previewId) ? previewParent : parentOf(c))
    if (c.color) return c.color;
  // Nothing in the chain is coloured. A CARD is a sticky note, and a sticky note is yellow (docs/PRODUCT.md:
  // "a default card is a coloured sticky note") — derived here, never written, so a note on disk stays
  // uncoloured and picking a colour is still the user's own act. A FRAME is a surface cards sit ON, so it
  // keeps a neutral white (above).
  return 'amber';
}
// The card whose edge is being dragged right now (startNodeResize). Declared ahead of paintNode, which
// reads it, so no paint can reach it before it exists.
let resizingId: string | null = null;
// Notes that just ARRIVED from outside (a reload found them — the phone inbox, docs/inbox.md), each
// shown as the node you can see: itself, or the folded pill it's tucked in. They pulse once (styles.css
// .arrived). A class paintNode owns, since it rewrites className on every paint.
const arrivedIds = new Set<string>();
export function flashArrived(ids: Iterable<string>): void {
  const shown = new Set<string>();
  for (const id of ids) {
    const n = state.nodes.get(id); if (!n) continue;
    let at: MindNode = n;
    for (const a of ancestors(n)) if (a.collapsed) at = a;   // the OUTERMOST fold is what's on screen
    if (!isHidden(at)) shown.add(at.id);
  }
  for (const id of shown) { arrivedIds.add(id); const n = state.nodes.get(id); if (n) paintNode(n); }
  if (shown.size) setTimeout(() => {
    for (const id of shown) { arrivedIds.delete(id); const n = state.nodes.get(id); if (n) paintNode(n); }
  }, 2400);
}
export function paintNode(n: MindNode): void {
  const el = nodeEl(n);
  // Drop the content wrapper the moment it isn't holding anything — `hostsContent` is exactly the set
  // of cases the sizing chain below creates one for, so the two can't drift. ONE drop, and it sits
  // ahead of the isHidden return so it covers a hidden node too. A fold used to strand it — an empty overflow:hidden
  // div left at the box's old size, sitting over the canvas below the tab; same for a frame converted
  // to a card. Its (hidden) children ride along
  // detached and are re-placed by place() the moment it holds again.
  // The OPEN frame (nav/scope.ts) rides this same drop, which is how it stops hosting: it's isHidden
  // by the scope term, so hostsContent goes false and the wrapper goes with it — and hostFrame then
  // hands its children #world instead, unclipped. No new lifecycle, no per-kind rule.
  if (n.frameContentEl && !hostsContent(n)) { n.frameContentEl.remove(); n.frameContentEl = null; }
  if (isHidden(n)) { el.style.display = 'none'; return; }   // an ancestor is folded: nothing to paint
  el.style.display = '';
  const editingBody = ui.bodyEdit && ui.bodyEdit.id === n.id;    // body editor open on this card
  const hasBody = editingBody || !!(n.body && n.body.trim());  // keep the body slot while editing
  const collapsed = n.collapsed && n.type !== 'frame' && canFold(n);   // a card folded to its one-line chip
  // The tags it wears on its top edge (features/tags.ts) — a frame wears none.
  const tags = wearsTags(n) ? noteTags(n) : [];
  const col = effectiveColor(n);
  applyColorVars(el, col);   // a custom colour's --card/--ink/--scrim; removed again for a palette key
  el.className = 'node ' + colorClass(col)
    + (n.id === resizingId ? ' resizing' : '')
    + (arrivedIds.has(n.id) ? ' arrived' : '')   // just came in from outside (flashArrived)   // its tags step aside while it's resized (styles.css)
    + (isFrame(n) ? ' frame' : '')
    + (isFrameFold(n) ? ' frame-folded' : '')   // folded to its bare label pill (styles.css)
    + (imageLook(n) ? ' image-card' : '')   // expanded: the bare picture · folded: its 40px icon
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')   // lone selection → show +
    + (collapsed ? ' collapsed' : '')
    + (n.type !== 'frame' && n.title ? ' titled' : '')   // its first line is a heading (the fold arrow's height)
    + (n.locked ? ' locked' : '')
    // While this card's ONE text field is open, its rendered title row stands down — the name is the
    // `# ` line inside the textarea (styles.css .card-editing). Driven from here rather than toggled by
    // startCardEdit, because this very line reassigns className on every paint and would drop it: the
    // editor calls paintAll() itself right after opening.
    + (editingBody ? ' card-editing' : '')
    + (hasBody ? '' : ' no-body')
    + (tags.length ? '' : ' no-tags')
    + (ui.drag?.targets?.has(n.id) ? ' dragging' : '')   // float the dragged subtree above all cards
    + (ui.drag && n.hostFrameId != null && ui.drag.targets.has(n.hostFrameId) ? ' carried' : '')   // riding a dragged frame
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '')
    + (state.searchActiveId === n.id ? ' search-active' : '');   // active dropdown option → white outline
  // Which frame (if any) hosts this card's element — settled outside gestures (see settledHost).
  settledHost(n);
  // During drag: keep left/top frozen at the pre-drag origin and move via transform (compositor-
  // only) — the SAME scheme applyDragTransform (drag.ts) uses on every pointermove. Doing it here
  // too means a mid-drag repaint (e.g. drop-target / rip colour change) can't desync the card from
  // the cursor: if paintNode instead placed the card at its LIVE, already-moved n.x and cleared the
  // transform, the next pointermove would re-add translate(n.x-origin) on top of that moved left/top
  // and double-count the delta — the "offset jumps when a card touches its frame's bounds" bug.
  // A dragged card lifts OUT of its frame's overflow:hidden content wrapper into #world for the
  // duration of the gesture, so it's never masked by the frame's bounds while being dragged (in
  // particular while being carried out of the box). It repaints in plain world coordinates — the
  // same as a top-level card. The one exception is a child CARRIED by its own host frame's drag:
  // that child stays inside the frame (the whole box moves together) and repaints at its live
  // host-relative position with no transform of its own (giving it one too would shift it twice —
  // mirrors applyDragTransform), so it keeps clipping to the frame that carries it.
  const drag = ui.drag;
  const carried = !!(drag && n.hostFrameId != null && drag.targets.has(n.hostFrameId));
  const dragOrig = !carried ? drag?.origins?.get(n.id) : undefined;
  if (dragOrig) {
    el.style.left = dragOrig.x + 'px'; el.style.top = dragOrig.y + 'px';
    el.style.transform = `translate(${n.x - dragOrig.x}px,${n.y - dragOrig.y}px)`;
    const root = dragRoot();
    if (el.parentElement !== root) root.appendChild(el);
  } else {
    if (el.style.transform) el.style.transform = '';
    // A child card is nested INSIDE its parent card's element, positioned by its offset from the
    // parent (n.x - parent.x — the live, staleness-proof form of rx/ry). So the parent carries its
    // whole subtree via the compositor: moving the parent's element moves every descendant with it,
    // no per-descendant left/top rewrite. Roots stay under #world; a direct frame child stays in the
    // frame's overflow:hidden wrapper (place()). isFrame covers frames (image cards are leaves).
    const p = parentOf(n);
    const np = paintPos(n);   // live, or the frozen drag origin — see paintPos
    // (The OPEN frame is the canvas even while folded: its children are top-level, never nested in its pill.)
    if (p && !isFrame(p) && !isScopeRoot(p) && !isFrame(n)) {
      const pEl = nodeEl(p);
      const pp = paintPos(p);
      el.style.left = (np.x - pp.x) + 'px';
      el.style.top  = (np.y - pp.y) + 'px';
      if (el.parentElement !== pEl) pEl.appendChild(el);
    } else {
      // root → #world; direct frame child → its content wrapper. A FRAME's own box always takes
      // this branch: its content wrapper is placed by the very same place()/settledHost call
      // (frameContentEl), and the two only stack correctly — wrapper above the box's own fill —
      // while they're SIBLINGS in one DOM parent.
      placeSelf(n, np.x, np.y);
    }
  }
  // Apply the node's size, and give it the resize hit-zones its kind supports. Every kind gets all 8.
  // A frame / image card is its own 2D box. A card's height is a MINIMUM (min-height): drag it taller
  // and it stays that tall, but its text can always make it taller still — unless it was dragged SHORTER
  // than its text (n.clip), when the same n.h is exact and the body is capped (end of paintNode).
  // While its editor is open a card also holds the height it had (BodyEdit.holdH): the raw markdown
  // is a different height from the rendered note, and the card must not jump as editing starts.
  // FOLDED it's a 40px chip whatever height it was dragged to: n.h waits for the unfold.
  if (!isBoxNode(n) && !isImageFold(n) && !isFrameFold(n) && !collapsed) {
    const hold = ui.bodyEdit?.id === n.id ? ui.bodyEdit.holdH ?? 0 : 0;
    const min = Math.max(n.h != null ? n.h : 0, hold);
    el.style.minHeight = min ? min + 'px' : '';
  }
  else if (el.style.minHeight) el.style.minHeight = '';
  if (isBoxNode(n)) {
    el.style.width = nodeW(n) + 'px';
    el.style.height = nodeH(n) + 'px';
    ensureResizeHandles(n, FRAME_DIRS);
    if (isFrame(n)) frameContentEl(n);   // create/reposition/resize this frame's overflow:hidden content wrapper
  } else if (isFrameFold(n)) {
    // folded: the element is the bare pill, shrink-wrapped by CSS (.frame-folded) — no inline size,
    // no resize zones (unfolding gives the box back at its authored size).
    if (el.style.width) { el.style.width = ''; el.style.height = ''; }
    clearResizeHandles(el);
  } else if (isImageFold(n)) {
    // folded: a fixed IMAGE_FOLD square of the picture itself (styles.css .image-card.collapsed), so
    // no inline size — nodeW/nodeH already declare it. It KEEPS its handles, though: scaling the icon
    // back up is how you unfold it (startNodeResize), the mirror of scaling a card down to fold it.
    // The authored w/h stay on the node untouched meanwhile, for the chip's own unfold.
    el.style.width = ''; el.style.height = '';
    ensureResizeHandles(n, FRAME_DIRS);
  } else {
    // A plain card: an authored width if it has one (else back to the CSS-fixed card width), never an
    // inline height — its authored height is the min-height set above.
    // FOLDED it's a chip that shrink-wraps its one line (styles.css .collapsed), up to the width it has open.
    const authored = n.w != null && !collapsed;
    el.style.width = authored ? nodeW(n) + 'px' : '';
    const cap = collapsed ? (n.w ?? NODE_W) + 'px' : '';
    if (el.style.maxWidth !== cap) el.style.maxWidth = cap;
    if (el.style.height) el.style.height = '';
    // A FOLDED card is a chip sized by its one line: nothing to drag, so no handles (and no corner
    // squares on it when selected). Unfolding hands them back on the next paint.
    if (collapsed) clearResizeHandles(el); else ensureResizeHandles(n, FRAME_DIRS);
  }
  // Don't clobber a FRAME's label while it's being renamed on itself (ui.titleEdit — the user is
  // typing into this very element). A card needs no such guard: its name is the leading `# ` line of its
  // one text field, and while that's open the whole row is hidden (`.card-editing`).
  if (!(ui.titleEdit && ui.titleEdit.id === n.id)) {
    const titleEl = el.querySelector('.title') as HTMLElement;
    // A CARD HAS NO LABEL OF ITS OWN, titled or not: it is its text, rendered as markdown, and a leading
    // `# ` line is therefore an H1 in that text exactly as `- item` is a bullet — one renderer, one set of
    // rules, nothing hoisted out of the note into a field of its own. So the slot stays empty (`no-title`
    // below collapses the row away, keeping only the fold chip that lives in it) and cardMarkdown feeds
    // the whole note to the body below.
    // A FRAME's label renders that same markdown, flattened to ONE inline line (styles.css) — so it
    // obeys the same rule while staying a label — plus one line of description under it when it has
    // one. It keeps a `.title` element rather than a body because it hangs OUTSIDE the box (a pill
    // above it, FigJam-style), and its own `.body` is display:none because the box holds cards, not a
    // note.
    if (isFrame(n) || isFrameFold(n)) {
      // …and under the name, on a second muted line, its DESCRIPTION (frameDescription — the note
      // after the heading). The
      // label grows UPWARD from the box's top edge, so a description never moves the box. FOLDED, the
      // pill is one line: the name, then how many notes it holds (`.frame-count`).
      const desc = isFrame(n) ? frameDescription(n) : '';
      const md = desc || isFrameFold(n) ? joinHeading(n.title, '', false) || collapsedMarkdown(n) : cardMarkdown(n);
      // A folded frame whose notes weren't read knows only HOW MANY there are (data/lazy.ts).
      const count = isFrameFold(n) ? n.lazy ?? descendantCount(n.id) : 0;
      // …and, while a search is on, how many of them match it (features/search.ts).
      const hits = isFrameFold(n) ? searchHitsIn(n.id) : 0;
      const full = nodeLabel(n) + (desc ? '\n' + desc : '');
      // Guarded on the source text, the way renderQueryResults keys on its result set: paintAll runs
      // once per animation FRAME for the length of a resize drag, and this arm re-parses HTML — which
      // destroys and rebuilds the tab's child nodes — where nothing about the label has changed. The
      // key carries the FALLBACK too, since a blank note renders nodeLabel instead (which can change
      // on its own, e.g. when the file is renamed) and `md` alone would never notice.
      // A frame with no text of its own renders NOTHING here.
      const key = md + '\u0000' + desc + '\u0000' + (isFrameFold(n) ? count + '/' + hits : '');
      if (titleEl.dataset.md !== key){
        titleEl.dataset.md = key;
        titleEl.innerHTML = (md.trim() ? renderBodyHTML(md) : '')
          + (desc ? `<div class="frame-desc">${renderBodyHTML(desc)}</div>` : '')
          + (isFrameFold(n) ? `<span class="frame-count">${count}</span>` : '')
          + (hits ? `<span class="frame-hits" title="${hits} matching the search">${hits} match${hits === 1 ? '' : 'es'}</span>` : '');
      }
      titleEl.title = full;   // ellipsised lines, so the full text lives in the tooltip
      // A frame with nothing written on it shows NO TITLE: expanded, that means no label at all;
      // FOLDED, a bare stub of a pill. Either way its fold
      // CHIP stays visible (styles.css re-shows it inside the invisible row) — hiding that would leave a
      // nameless frame with no way to open again. The rim is what you write on (onFrameRim).
      // Not while its own label editor is open, though: the row can't be invisible and be typed into.
      el.classList.toggle('no-title', !frameLabelled(n) && ui.titleEdit?.id !== n.id);
      el.style.setProperty('--ls', String(labelScale()));   // a readable name at any zoom (camera.ts)
    } else {
      titleEl.textContent = '';
      titleEl.removeAttribute('title');
      delete titleEl.dataset.md;    // retyped away from a frame: don't let the stale key match later
      el.classList.toggle('no-title', true);
    }
  }
  const bodyEl = el.querySelector('.body') as HTMLElement;
  // don't clobber the body while it's being edited in place (the textarea lives inside .body)
  if (!editingBody) {
    // Same guard as the frame tab above, and this is the one that pays: every card on screen renders
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
  const tp = n.type === 'frame' || collapsed ? { done: 0, total: 0 } : taskProgress(n.body);
  const barTitle = tp.total ? `${tp.done}/${tp.total}` : '';
  el.classList.toggle('has-tasks', tp.total > 0);
  if (bar.title !== barTitle){
    bar.title = barTitle;
    bar.style.setProperty('--done', `${tp.total ? Math.round(tp.done / tp.total * 100) : 0}%`);
  }
  // A CLIPPED card (n.clip — dragged shorter than its text) is exactly n.h tall: the body is capped to
  // what's left under the padding and the rest is simply cut. Not while folded, opened as a page, or
  // edited — the editor shows the whole note, then it clips again.
  const clipH = clipHeight(n, !!editingBody);
  if (clipH != null){
    const cap = Math.max(0, clipH - bodyEl.offsetTop - parseFloat(getComputedStyle(el).paddingBottom));
    if (bodyEl.style.maxHeight !== cap + 'px') bodyEl.style.maxHeight = cap + 'px';
  } else if (bodyEl.style.maxHeight) bodyEl.style.maxHeight = '';
}
function clipHeight(n: MindNode, editing: boolean): number | null {
  return n.clip && n.h != null && !n.collapsed && !editing && !isBoxNode(n) && !isImageFold(n) ? n.h : null;
}
// The markdown a node RENDERS — its whole note, title included.
//
// For a plain card that's `joinHeading(title, body)`: the title is the leading `# ` line of the text, and
// putting it back means renderBodyHTML makes it an H1 the same way it makes `- item` a bullet. There is no
// title element on a card any more, so this is the only place its name is drawn, and a card can't end up
// showing its name in one typeface in the row and another in the note.
// (An image card needs no arm of its own — it is untitled by definition, so joinHeading hands back the
// picture markdown unchanged.)
function cardMarkdown(n: MindNode): string {
  return joinHeading(n.title, n.body, n.titleGap !== false);
}
// …and what a COLLAPSED node renders: the first line of that markdown, with `…` appended when anything
// follows it. Still MARKDOWN, fed to the same renderer, which is the whole point — `# Name` folds to a
// heading, `- milk` to a bullet, plain text to plain text, nothing restyled and nothing made bold.
//
// The `…` has to be put here rather than left to CSS, and the reason is a hard limit rather than a
// preference: `text-overflow` and `-webkit-line-clamp` can only ellipsise WITHIN one element. The text
// that a fold hides usually isn't in the same element — a heading followed by a paragraph, or several
// short lines that markdown makes into separate `<p>`s, are SIBLING blocks, and hiding a sibling
// truncates nothing the browser will mark. So CSS showed an ellipsis only when a single line happened to
// be too wide, which is the one case that needed it least. CSS still handles exactly that case (see
// styles.css) — this handles "there is more".
function collapsedMarkdown(n: MindNode): string {
  const lines = cardMarkdown(n).split('\n');
  const i = firstTextLine(lines);
  return i < 0 ? '' : lines[i];
}
// How many non-blank lines a fold tucks away below the first one — the "N more lines" under it.
function hiddenLineCount(n: MindNode): number {
  const lines = cardMarkdown(n).split('\n');
  const i = firstTextLine(lines);
  return i < 0 ? 0 : lines.slice(i + 1).filter(l => l.trim()).length;
}
export const NODE_W = 200;
// world-px grid dragged positions AND frame/image-card sizes snap to — tracks the visible grid's
// own cell size (state.gridSize, view/grid.ts); 0 (grid off) disables snapping rather than
// collapsing every position to the origin.
export function gridSnap(): number { return state.gridSize || 1; }
// A POINT on the grid — the same rounding a dragged card gets, for the places that PLACE a card rather
// than drag it: a new card at the pointer, a duplicate, a paste, an image dropped or pulled out of a
// note. Anything the user positions ends up on the grid, however it got there.
export function snapPt(p: Pt): Pt { const g = gridSnap(); return { x: snapTo(p.x, g), y: snapTo(p.y, g) }; }
export const FRAME_BORDER = 2;   // must match .node.frame's CSS `border` width (styles.css)
// A frame's label is not part of its geometry at all: it hangs ABOVE the box, outside the frame's
// bounds (styles.css `.node.frame > .title-row`), the way a FigJam section's name does — so naming,
// renaming or un-naming a frame never moves its box or the cards in it, and n.y/n.h are the box itself.
// Default frame container size (world px).
export const FRAME_W = 360, FRAME_H = 260;
export const IMAGE_W = 240, IMAGE_H = 180;   // default image-card size (world px)
// A FOLDED frame renders as nothing but its label — a pill at the box's top-left
// corner (n.x, n.y), its cards hidden (utils/model.ts isHidden). Its element shrink-wraps the label,
// so its width is measured (nodeW) and its height is the FRAME_TAB_H constant.
function isFrameFold(n: MindNode): boolean { return n.type === 'frame' && !!n.collapsed; }
// Height of a folded frame's pill (styles.css .frame-folded: 20px line + 9px padding + 1px border, top
// and bottom). A constant, so the pill is one ellipsised line and never measured.
export const FRAME_TAB_H = 40;
// What CAN fold: every FRAME (to its label pill), a card with something below its first line to tuck
// away (to a one-line chip), or an image card (to a 40px icon of itself). The one rule the arrow, X,
// ←/→, the menus and ⌘P's Collapse all ask.
export function canFold(n: MindNode): boolean {
  return n.type === 'frame' || isImageCard(n) || hiddenLineCount(n) > 0;
}
// …and may be folded or unfolded by the user right now: not locked, and not the open frame (it's the canvas).
export const canToggleFold = (n: MindNode): boolean => canFold(n) && !isLockedEffective(n) && !isScopeRoot(n);
// Whether `n` currently holds its children in a content wrapper of its own (frameContentEl) — the two
// case paintNode's sizing chain creates one for, spelled once so its cleanup can't drift from it: an
// expanded frame BOX.
// Being HIDDEN (an ancestor folded) counts as holding nothing, which is what lets paintNode maintain
// "a wrapper exists iff hostsContent(n)" with ONE drop, ahead of its isHidden early return.
function hostsContent(n: MindNode): boolean {
  if (isHidden(n)) return false;
  return isFrame(n);
}
// WHICH element carries this node's visible title. Its own `.title-row`, except for a frame that
// renders as nothing but its tab (folded or docked), where the element IS the label. Exported because
// the float bar centres itself on the label rather than the box (features/float-bar.ts) and needs the
// same answer this does — so a kind whose label element differs is a change in one place, not two.
export function labelEl(n: MindNode): HTMLElement | null {
  if (!n.el) return null;
  return isFrameFold(n) ? n.el : (n.el.querySelector(':scope > .title-row') as HTMLElement | null);
}
// An image card rendering AS its picture: no padding, both axes authored, aspect-locked resize.
// isImageCard (core/state.ts) is the content test — untitled, and the whole note is one `![](…)`;
// this adds the two states where the card shows something ELSE and so goes back to being an ordinary
// card: FOLDED (it's the 40px icon below) and while its editor is open (it's the markdown, which has
// to wrap and measure like any text). Both are transient, and neither touches what's on disk.
// …and the one state where an image card is NOT drawn as its picture: its own editor is open, where
// the card holds markdown text that has to wrap and measure like any note's. Both halves below read
// this, so the class, the sizing and the resize handles can't disagree about what's on screen.
function imageLook(n: MindNode): boolean { return isImageCard(n) && ui.bodyEdit?.id !== n.id; }
function isImageBox(n: MindNode): boolean { return imageLook(n) && !n.collapsed; }
// …and folded, an image card is a small square of the picture itself — the icon a folded card with no
// title would otherwise have nothing to show.
export const IMAGE_FOLD = 40;
function isImageFold(n: MindNode): boolean { return imageLook(n) && n.collapsed; }
// Any 2D box — authors BOTH axes, so it gets the full 8-handle set and shares the sizing plumbing
// below.
function isBoxNode(n: MindNode): boolean { return isFrame(n) || isImageBox(n); }
function boxDefaultW(n: MindNode): number { return isImageBox(n) ? IMAGE_W : FRAME_W; }
function boxDefaultH(n: MindNode): number { return isImageBox(n) ? IMAGE_H : FRAME_H; }
// A node's footprint WIDTH. `n.w` is the AUTHORED width — dragged with a resize handle, persisted as
// mm_w — and every kind can carry one: a frame/image card sizes its whole box with it, while a card
// authors only this axis (its height comes from its content). A folded frame's tab shrink-wraps its
// title instead.
export function nodeW(n: MindNode): number {
  if (isBoxNode(n)) return n.w ?? boxDefaultW(n);
  if (isImageFold(n)) return IMAGE_FOLD;   // folded to its icon — a fixed square, never measured
  if (isFrameFold(n)) return (n.el && n.el.offsetWidth) || NODE_W;   // the pill shrink-wraps its label
  if (n.collapsed && n.el && n.el.offsetWidth) return n.el.offsetWidth;   // a folded card's chip, likewise
  return n.w ?? NODE_W;
}
// live height (falls back pre-render). An expanded frame/image card's height is its box (n.h).
export function nodeH(n: MindNode): number {
  if (isBoxNode(n)) return n.h ?? boxDefaultH(n);
  if (isImageFold(n)) return IMAGE_FOLD;
  if (isFrameFold(n)) return FRAME_TAB_H;   // just the pill — one fixed line, never measured
  return (n.el && n.el.offsetHeight) || 64;
}
// Height used for LAYOUT geometry. Identical to nodeH for every kind whose height is DECLARED
// (box / folded frame / folded image), so it defers to it rather than restating the ladder — a new kind
// added to nodeH must not have to be remembered here too. The two differ only for a MEASURED card:
// nodeH treats a zero-height element as unrendered and falls back to 64, while layout wants the real
// 0 (the tags on the top edge are absolutely positioned and
// overhang, so they never inflate the measurement either way).
export function layoutH(n: MindNode): number {
  if (isBoxNode(n) || isImageFold(n) || isFrameFold(n)) return nodeH(n);
  const el = n.el; if (!el) return 64;
  return el.offsetHeight;
}
// ---------- frame content containment (real CSS clipping, not per-card math) ----------
// A card living inside a frame must never visually spill past its box — dragging near a border, or
// shrinking the frame below its content, shouldn't leave cards overhanging. Frame children are flat
// DOM siblings under #world like everything else, so real containment means giving each frame its
// own overflow:hidden wrapper and re-parenting whatever it hosts (cards AND nested frames) into it,
// rather than a per-card clip-path hack — that also makes nested frames and grandchildren clip for
// free, and respects the frame's rounded corners.
//
// Which frame `n`'s element is CURRENTLY, actually parented under, DOM-wise — settled outside any
// active gesture (drag / inline-edit / body-edit) so re-parenting can't drop a captured pointer or
// blur an open editor (same caution as the old orderFrames pass this replaces). Mid-gesture callers
// just get back whatever was last settled; paintNode still repositions live using that fixed host,
// so a card mid-drag stays visually clipped to wherever it's actually hosted until the drop settles.
// `hostFrame` (view/layout.ts) does the actual ancestor walk — shared with edges.ts so an edge
// between two cards inside the same frame clips to it too, not just the cards themselves.
function settledHost(n: MindNode): MindNode | null {
  if (ui.drag || inPlaceEditActive()) return n.hostFrameId ? (state.nodes.get(n.hostFrameId) ?? null) : null;
  const want = hostFrame(n);
  n.hostFrameId = want ? want.id : null;
  return want;
}
// Position + (re)parent `el` so its border-box top-left lands at absolute world (absX,absY) — either
// directly under #world, or inside `host`'s content wrapper (offset by the host's own border so
// content never draws under the frame's border stroke). Shared by every hosted element: a plain
// card, a frame's own box, and a nested frame's own content wrapper.
// While a drag is live, dragged items live in #dragLayer (one opacity group) instead of directly
// under #world — so the whole dragged set composites translucently without shining through itself.
// Only DRAGGED nodes are painted mid-drag, so this only ever relocates them (and a dragged frame's
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
// the offset is the host's own inset (the border, plus a frame's title tab — see frameInsetY).
function place(el: HTMLElement, absX: number, absY: number, host: MindNode | null): void {
  if (!host) return placeIn(el, absX, absY, dragRoot(), 0, 0);
  const o = contentOrigin(host);
  placeIn(el, absX, absY, frameContentEl(host), o.x, o.y);
}
// The mechanical half of place(): write absolute world (absX,absY) as an offset from `container`'s own
// world origin and (re)parent into it.
function placeIn(el: HTMLElement, absX: number, absY: number, container: HTMLElement, ox: number, oy: number): void {
  el.style.left = (absX - ox) + 'px';
  el.style.top  = (absY - oy) + 'px';
  if (el.parentElement !== container) container.appendChild(el);
}
// Where a container's content wrapper sits in world coords, on the PAINT basis (its frozen origin
// mid-drag — see paintPos). Everything that has to agree on that point reads it here: place() offsets
// left/top by it, frameContentEl() positions the wrapper at it, followEdges() projects back through
// it. Expressed as a delta off the host's own origin rather than re-spelling the insets.
function contentOrigin(host: MindNode): Pt {
  const box = frameInterior(host);
  const bp = paintPos(host);
  return { x: bp.x + (box.x - host.x), y: bp.y + (box.y - host.y) };
}
// Put a node's OWN element where it belongs: its host container's content wrapper, or straight under
// #world. The single decision point, shared by paintNode and frameContentEl's ordering guard.
function placeSelf(n: MindNode, absX: number, absY: number): void {
  place(nodeEl(n), absX, absY, settledHost(n));
  orderContentAfterBox(n);
}
// Keep a container's own box BEFORE its content wrapper among their shared siblings. The two paint in
// the same step (both z-index:auto — see .node.frame in styles.css), so document order alone decides
// which is on top: the wrapper must FOLLOW the box, or the box's opaque fill paints straight over
// everything inside it that also sits at z-index:auto — a nested frame. (Plain cards are z-index:2
// and survive either way.)
// Any re-append of the box moves it to the END of its container, inverting the pair whenever the
// wrapper got there first — which is routine, since Map iteration order isn't parent-before-child, so
// a child's paint reaches frameContentEl before the container's own paintNode. The case that actually
// bit: dropping a dragged frame returns box and wrapper from #dragLayer in whatever order the repaint
// visits them. So re-assert the order after every box placement; frameContentEl's own creation guard
// covers the mirror case (a wrapper built before its box had ever been placed).
function orderContentAfterBox(n: MindNode): void {
  const w = n.frameContentEl, el = n.el;
  if (!w || !el || w.parentElement !== el.parentElement) return;
  if (el.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_PRECEDING) el.after(w);
}
// A frame's own clipping wrapper: a plain overflow:hidden box (styles.css .frame-content) sized to
// its INTERIOR (inside the border), holding every card/frame it hosts as flat DOM children. Created
// once and kept live (idempotent — safe to call from a child's paint before the frame's own paint
// runs in the same pass, since Map iteration order isn't parent-before-child).
// Every frame box paints at the same level (z-index:auto, styles.css), so a nested frame's own box
// only ends up visually on top of its ancestor's fill because it sits LATER in DOM/tree order (same
// paint step ⇒ document order decides) — the two share one flattened stacking context since
// .frame-content sets no z-index of its own. That invariant breaks if THIS wrapper gets appended to
// its container before the frame's own box does, which happens whenever a child paints (and so
// calls this) before the frame itself gets its first paintNode pass (Map iteration order isn't
// parent-before-child). Guard it here: force the frame's own box to exist and be placed in the
// container FIRST, so it always precedes this wrapper as a sibling — paintNode's later place(el,…)
// on the same box is then a same-parent no-op that doesn't reorder anything.
function frameContentEl(f: MindNode): HTMLElement {
  let w = f.frameContentEl;
  if (!w) {
    placeSelf(f, f.x, f.y);
    w = document.createElement('div'); w.className = 'frame-content'; f.frameContentEl = w;
  }
  const box = frameInterior(f);
  // Position from paintPos, not box.x/box.y: mid-drag the wrapper's left/top must stay frozen at the
  // frame's origin, since applyDragTransform mirrors the box's own transform onto it. Its SIZE comes
  // from frameInterior either way (a drag moves the box, it doesn't resize it).
  // …and its OFFSET comes from the same helper, as a delta off the frame's own origin, rather than
  // re-spelling frameInterior's insets here — otherwise a change to them resizes the wrapper without
  // moving it, sliding the clip off its own box.
  const o = contentOrigin(f);
  place(w, o.x, o.y, settledHost(f));
  w.style.width  = box.w + 'px';
  w.style.height = box.h + 'px';
  return w;
}
// ---------- resize ----------
// a frame is never narrower than a normal card
export const MIN_FRAME_W = NODE_W, MIN_FRAME_H = 120;
// An image card's floor is the ICON it becomes: drag either axis to IMAGE_FOLD and the card folds
// (startNodeResize below), so there is no smaller expanded size to clamp at.
// A width-only kind can only ever get WIDER than the width it has by default — the whole point is
// trading height for width on a card whose text wraps badly, so its natural size is the floor. That
// floor is NODE_W for a plain card and a frame alike, so they share the one fall-through.
function minWOf(n: MindNode): number {
  if (isImageBox(n) || isImageFold(n)) return IMAGE_FOLD;
  return NODE_W;
}
// The shortest a CLIPPED card goes: about one line of text under its padding.
const CLIP_MIN_H = 44;
function minHOf(n: MindNode): number { return (isImageBox(n) || isImageFold(n)) ? IMAGE_FOLD : MIN_FRAME_H; }
// 8 resize handles: 4 edges (one axis) + 4 corners (two axes). A `w`/`n` component moves that edge,
// which shifts the frame's x/y (the opposite edge stays put); `e`/`s` just grow width/height.
const FRAME_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type FrameDir = typeof FRAME_DIRS[number];
// Ensure the node has exactly the resize hit-zones its kind wants — one per edge/corner, added once
// and reused. The corners of a lone selection draw FigJam's square handles (styles.css); the edges
// have no grip, their resize cursor is the affordance.
// `:scope >` throughout, NOT a descendant query: child cards are DOM-nested inside their parent
// (see place/settledHost), so a plain card containing a nested image card would otherwise see the
// CHILD's handles, conclude it already had its own, and never get any.
function ensureResizeHandles(n: MindNode, dirs: readonly FrameDir[]): void {
  const el = n.el!;
  const key = dirs.join('');
  if (el.dataset.fhDirs === key) return;   // keyed by the direction SET, so a type flip rebuilds
  clearResizeHandles(el);
  for (const dir of dirs) {
    const h = document.createElement('div');
    h.className = 'fh fh-' + dir;
    h.addEventListener('pointerdown', (e) => startNodeResize(e as PointerEvent, n, dir));
    el.appendChild(h);
  }
  el.dataset.fhDirs = key;
}
function clearResizeHandles(el: HTMLElement): void {
  if (!el.dataset.fhDirs) return;   // no handles to remove — skip the query, this runs every repaint
  el.querySelectorAll(':scope > .fh').forEach(x => x.remove());
  delete el.dataset.fhDirs;
}
// Drag an edge/corner to resize. Work in edge coordinates (left/top/right/bottom) so the edges NOT
// being dragged stay fixed; the dragged edges snap to the grid and clamp to the min size. Top/left
// edges moving means the frame's x/y move too. Children inside are free, so only the parent's own
// layout reflows around the frame — done once on release, not every move.
// An image card's aspect ratio (width/height): the actual loaded image if hydrateImages has
// resolved it, else whatever the box currently shows (so an in-progress resize is stable even
// before the blob URL loads).
function imageAspect(n: MindNode): number {
  const img = n.el?.querySelector('img.md-img') as HTMLImageElement | null;
  if (img && img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  const w = n.w ?? IMAGE_W, h = n.h ?? IMAGE_H;
  return w / (h || 1);
}
function startNodeResize(e: PointerEvent, n: MindNode, dir: FrameDir): void {
  if (state.readOnly || isLockedEffective(n)) return;
  e.stopPropagation(); e.preventDefault();
  // Is this a BOX (its size is exactly what's dragged) or a card (its height is a minimum over what
  // its text measures)? A FOLDED image card counts as a box here even though isBoxNode says no: its
  // 40px icon is the small end of its own size range, and scaling it back up is how you unfold it.
  const img = isImageBox(n) || isImageFold(n);
  const sizeH = isBoxNode(n) || img;
  const minW = minWOf(n);
  // A card's text height at the width it starts from is where its min-height stops and its clip starts.
  // (A clipped card's body cap is lifted too, or it would measure as its own clip.)
  const natural = (): number => {
    const el = n.el!, body = el.querySelector(':scope > .body') as HTMLElement;
    const was = el.style.minHeight, wasMax = body.style.maxHeight;
    el.style.minHeight = ''; body.style.maxHeight = ''; const h = el.offsetHeight;
    el.style.minHeight = was; body.style.maxHeight = wasMax;
    return h;
  };
  // …but it CAN be dragged shorter than that, down to a line: then it CLIPS (n.clip) instead of growing.
  const natural0 = sizeH ? 0 : natural();
  const minH = sizeH ? minHOf(n) : Math.min(natural0, CLIP_MIN_H);
  const aspect = img ? imageAspect(n) : null;   // width/height — locked while dragging an image card
  // Live geometry, not (n.w ?? boxDefaultW): boxDefaultH falls back to FRAME_H for anything that
  // isn't an image/query, so a plain card would start from a bogus 279px-tall box.
  const left0 = n.x, top0 = n.y, right0 = n.x + nodeW(n), bottom0 = n.y + nodeH(n);
  const sx = e.clientX, sy = e.clientY;
  resizingId = n.id; n.el?.classList.add('resizing');   // its tags step aside while its edge moves (paintNode keeps it)
  const west = dir.includes('w'), east = dir.includes('e'), north = dir.includes('n'), south = dir.includes('s');
  touch(n.id);
  let lastDx = 0, lastDy = 0;
  let subtreeRAF: number | null = null;
  const g = gridSnap();
  // The grid on the SIZE — the same snap a dragged card gets (utils/num.ts), live
  // on every move, so the box steps between grid sizes under the pointer instead of taking one up at
  // the end. One snapping rule for everything the pointer moves.
  const snap = (v: number): number => snapTo(v, g);
  // Apply the current drag delta, keeping the non-dragged edges fixed. We snap the SIZE (not the
  // edges) to the grid so a box's w/h are always multiples of the snap — the moving edge derives
  // from the fixed opposite edge minus the snapped size. Free (unsnapped) while dragging; snapped
  // on release. Clamped to the min size (also grid multiples).
  const resize = (round: (v: number) => number): void => {
    let left = left0, right = right0, top = top0, bottom = bottom0;
    if (aspect) {
      // Image card: whichever axis the user is actually dragging drives the size (grid-snapped);
      // the other axis is DERIVED from the image's own aspect ratio rather than dragged/snapped
      // independently. A corner drags both — drive by whichever axis implies the bigger relative
      // change, so the drag feels proportionate regardless of which corner is grabbed.
      const w0 = right0 - left0, h0 = bottom0 - top0;
      const hasX = east || west, hasY = north || south;
      let w = w0, h = h0;
      if (hasX && hasY) {
        const wCand = Math.max(minW, round(w0 + (east ? lastDx : -lastDx)));
        const hCand = Math.max(minH, round(h0 + (south ? lastDy : -lastDy)));
        if (Math.abs(wCand - w0) * h0 >= Math.abs(hCand - h0) * w0) { w = wCand; h = Math.max(minH, w / aspect); }
        else { h = hCand; w = Math.max(minW, h * aspect); }
      } else if (hasX) {
        w = Math.max(minW, round(w0 + (east ? lastDx : -lastDx)));
        h = Math.max(minH, w / aspect);
      } else if (hasY) {
        h = Math.max(minH, round(h0 + (south ? lastDy : -lastDy)));
        w = Math.max(minW, h * aspect);
      }
      left = west ? right0 - w : left0;  right = left + w;
      top  = north ? bottom0 - h : top0; bottom = top + h;
    } else {
      if (east)  { const w = Math.max(minW, round(right0 + lastDx - left0));  right = left0 + w; }
      if (west)  { const w = Math.max(minW, round(right0 - (left0 + lastDx))); left = right0 - w; }
      if (south) { const h = Math.max(minH, round(bottom0 + lastDy - top0));   bottom = top0 + h; }
      if (north) { const h = Math.max(minH, round(bottom0 - (top0 + lastDy))); top = bottom0 - h; }
    }
    // An image card FOLDS by being scaled down and unfolds by being scaled up — the third fold
    // control beside the chip and `X`, and the only one that is also a size. The threshold is the icon
    // itself: once the SHORT axis is down to IMAGE_FOLD the card is icon-sized, so it becomes one, and
    // dragging back out past that restores it. Live, so the icon appears and goes under the cursor.
    // While folded the authored w/h are left ALONE — they're the size it comes back to, whether that's
    // this same drag reversing or the chip unfolding it tomorrow.
    if (aspect) {
      const fold = Math.min(right - left, bottom - top) <= IMAGE_FOLD;
      if (fold !== n.collapsed) n.collapsed = fold;
      if (fold) { n.dirty = true; return; }
    }
    n.x = left; n.w = right - left;
    if (sizeH || north || south) { n.y = top; n.h = bottom - top; if (!sizeH) n.clip = n.h < natural0 - 1 || undefined; }
    n.dirty = true;
  };
  const move = (ev: PointerEvent): void => {
    lastDx = (ev.clientX - sx) / state.view.k; lastDy = (ev.clientY - sy) / state.view.k;
    resize(snap);
    paintNode(n);
    paintFreeEdges();
    // A width-only kind re-wraps its text at the new width, which changes its measured HEIGHT — let
    // everything that reads it (edges, the selection bar) settle as the drag goes, once per frame.
    if (!sizeH && !subtreeRAF) subtreeRAF = requestAnimationFrame(() => {
      subtreeRAF = null;
      relayout();
    });
    // A north/west resize shifts the frame's own x/y, which shifts its content wrapper's origin —
    // repaint the whole subtree (not just direct children) so every hosted descendant's live,
    // wrapper-relative position compensates and stays put in absolute space as the box resizes
    // around it (an east/south-only resize doesn't move the origin, so this is skipped entirely).
    // subtreeIds walks the whole node map, so coalesce it to once per animation frame rather than
    // once per raw pointermove (which can fire far faster than the screen repaints).
    else if ((north || west) && !subtreeRAF) subtreeRAF = requestAnimationFrame(() => {
      subtreeRAF = null;
      for (const id of subtreeIds(n.id)) { const k = state.nodes.get(id); if (k) paintNode(k); }
    });
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    resizingId = null; n.el?.classList.remove('resizing');
    if (subtreeRAF) { cancelAnimationFrame(subtreeRAF); subtreeRAF = null; }
    resize(snap);   // the final delta; the size was already on the grid throughout
    // Back at (or under) the natural width → drop the authored width entirely rather than persisting
    // a redundant mm_w on every card the user so much as nudges.
    if (!sizeH && n.w != null && Math.round(n.w) <= minW) n.w = undefined;
    // …and the same for a card's height: no taller than its text → it has no authored height.
    // Shorter than its text (at the width it ended at) → it clips; else it's a minimum again.
    if (!sizeH && n.h != null) {
      paintNode(n);
      const nat = natural();
      if (Math.round(n.h) < nat - 1) n.clip = true;
      else { n.clip = undefined; if (Math.round(n.h) <= nat + 1) n.h = undefined; }
    }
    // paint BEFORE anything reads it: a width-only node's height only matches the snapped width once
    // the DOM has it.
    paintNode(n);
    // NB a west/north drag also moves this node's own x/y, which restales every CHILD's persisted
    // offset — commitRel handles that centrally for every mover, so there's nothing to do here.
    // A resized FRAME takes in what it now covers and lets go of what it no longer does
    // (settleFrames). It isn't grown back around what it took in — the user just chose its size —
    // but a card it let go of grows the frame it landed in, as any drop does.
    if (n.type === 'frame') {
      const released = settleFrames([n.id]).filter(id => state.nodes.get(id)?.parent !== n.id);
      growFramesToHold(released);
    }
    relayout(); scheduleSave(); commitStep();
    syncFloatBar();   // a card that now has an authored height offers Fit (↔)
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
export function paintAll(): void {
  readOpenUnread();   // an open frame whose notes are still on disk reads them (data/lazy.ts)
  refreshSearch();    // what the search lights, off the tags and text as they are now
  for (const n of state.nodes.values()) paintNode(n);
  refreshTray();      // the tag tray's stickers, when it's out
  paintFreeEdges();
  updateEmptyHints();
  syncScopeChrome();   // crumbs + reading class + the recovery when the frame you were inside has gone
}
// The two shapes of "settle the canvas after a change", spelled once each. Nearly every mutation path
// in the app ends in one of them, and which one is correct turns on a single question: did the change
// alter a MEASURED size?
//   relayout()  — the open-frame bookkeeping (applyLayouts), then paint. The default.
//   remeasure() — paint FIRST, then the same. For anything that changes a card's measured height (its
//                 text, its width, or a card so new it has no element yet), so whatever runs between
//                 the two paints reads a current DOM. Nothing flows cards any more, so the two differ
//                 only in that first paint — kept apart so callers still say which they mean.
export function relayout(): void { applyLayouts(); paintAll(); }
export function remeasure(): void { paintAll(); applyLayouts(); paintAll(); }

// The first-run hint ("Drag to create a card") shows only on an empty canvas.
// "Empty" means empty OF WHAT'S ON SCREEN, so an open frame with nothing in it gets the hints too —
// opening an empty folder to start filling it is the whole point of being able to open one.
export function updateEmptyHints(): void {
  const empty = scopeActive() ? ![...state.nodes.values()].some(n => !isHidden(n)) : state.nodes.size === 0;
  document.body.classList.toggle('empty-canvas', empty);
}

// ---------- animated relayout (expand / collapse) ----------
function prefersReducedMotion(): boolean { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
// The animation writes left/top itself (that's what it interpolates), so it must go through the SAME
// placement authority paintNode's own final branch uses — placeSelf, not a bare place() — so a hosted
// card stays in its container's wrapper for the duration.
function placeNodeEl(n: MindNode): void { if (n.el) placeSelf(n, n.x, n.y); }
function setNodeElXY(n: MindNode, x: number, y: number): void { if (n.el) placeSelf(n, x, y); }
// Newly revealed cards emanate from the nearest ancestor that was already on screen.
function ancestorStart(node: MindNode, before: Map<string, Pt>): Pt {
  for (const p of ancestors(node)){ const b = before.get(p.id); if (b) return b; }
  return { x: node.x, y: node.y };
}
// Cards glide to new spots via a CSS transition; SVG edges can't transition, so for the duration
// we redraw them each frame from the cards' live (animating) on-screen positions.
// Only a line's END cards (and the frames around them, which a hidden end is drawn to) are read: the
// computed-style read is the cost, and there are far fewer of those than cards. No lines, no loop.
function followEdges(tok: number, ms: number): void {
  if (!state.edges.length) return;
  const ends = new Set<MindNode>();
  for (const e of state.edges) for (const id of [e.from, e.to]) {
    const n = state.nodes.get(id); if (!n) continue;
    ends.add(n); for (const a of ancestors(n)) ends.add(a);
  }
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (tok !== ui.animToken) return;                  // superseded by a newer animation
    const saved: [MindNode, number, number][] = [];
    for (const n of ends){
      if (!n.el || isHidden(n)) continue;
      const c = getComputedStyle(n.el);             // interpolated left/top while transitioning
      saved.push([n, n.x, n.y]);
      // left/top are HOST-relative for a hosted card — project back to absolute world coords, through
      // the same origin place() measured them from (contentOrigin, on its no-drag basis).
      const host = settledHost(n);
      const o = host ? frameInterior(host) : null;
      const px = parseFloat(c.left), py = parseFloat(c.top);
      n.x = px ? (o ? px + o.x : px) : n.x;
      n.y = py ? (o ? py + o.y : py) : n.y;
    }
    paintFreeEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }   // restore logical (final) positions
    if (now - t0 < ms) requestAnimationFrame(tick); else paintFreeEdges();
  };
  requestAnimationFrame(tick);
}
// Snapshot the on-screen position of every visible card — the START frame animateReflow
// glides away from. Take it BEFORE the structural change.
function layoutSnapshot(): Map<string, Pt> {
  const before = new Map<string, Pt>();
  for (const m of state.nodes.values()) if (m.el && !isHidden(m)) before.set(m.id, { x:m.x, y:m.y });
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
// …and the SIZES: a fold shrinks a card to its chip or a frame to its pill, Fit hugs a frame round its
// cards. The final size is already on screen (paintAll ran); each element that changed is played from
// its old box to its new one with the Web Animations API, which owns width/height only for LAYOUT_ANIM_MS and
// then hands them straight back to the inline/CSS sizing — nothing is written, nothing to clean up. The
// content is clipped meanwhile, so a card's text doesn't spill out of the box as it closes. A frame's
// content wrapper (its interior clip) follows the box, else its cards would pop in or out at once.
type Size = { w: number; h: number };
function sizeSnapshot(): Map<HTMLElement, Size> {
  const out = new Map<HTMLElement, Size>();
  for (const m of state.nodes.values()) {
    if (!m.el || isHidden(m)) continue;
    out.set(m.el, { w: m.el.offsetWidth, h: m.el.offsetHeight });
    if (m.frameContentEl) out.set(m.frameContentEl, { w: m.frameContentEl.offsetWidth, h: m.frameContentEl.offsetHeight });
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
  if (prefersReducedMotion()) return;
  // A frame that has just UNFOLDED had no content wrapper to snapshot: it starts as small as the box
  // it grows out of (the pill, less the box's own border), so its cards stay clipped all the way open.
  for (const m of state.nodes.values()) {
    const w = m.frameContentEl, a = m.el ? before.get(m.el) : undefined;
    if (!w || !a || before.has(w) || !m.el) continue;
    before.set(w, { w: Math.max(0, a.w - (m.el.offsetWidth - w.offsetWidth)), h: Math.max(0, a.h - (m.el.offsetHeight - w.offsetHeight)) });
  }
  for (const [el, a] of before) {
    if (!el.isConnected || el.style.display === 'none') continue;
    const b = { w: el.offsetWidth, h: el.offsetHeight };
    if (Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1) continue;
    el.animate([
      { width: a.w + 'px', height: a.h + 'px', minHeight: '0px', maxWidth: 'none', overflow: 'hidden' },
      { width: b.w + 'px', height: b.h + 'px', minHeight: '0px', maxWidth: 'none', overflow: 'hidden' },
    ], { duration: LAYOUT_ANIM_MS, easing: SIZE_EASE });
  }
}
function animateReflow(before: Map<string, Pt>): void {
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++ui.animToken;                           // supersede any in-flight animation
  if (prefersReducedMotion()){ for (const m of visible){ m.el!.classList.remove('lt-anim'); placeNodeEl(m); } document.body.classList.remove('layout-anim'); paintFreeEdges(); return; }
  // While cards glide and change size (this and animateSizes), the ports and resize handles would sit at
  // stale spots and sizes: they stand down until the glide ends (styles.css body.layout-anim).
  document.body.classList.add('layout-anim');
  // 1) park every visible card at its STARTING spot with no transition; just-revealed cards
  //    also start invisible so they fade in (covers free layouts where nothing reflows).
  //    A card INSIDE a frame doesn't glide when it's the frame that changed (a fold, an unfold, a Fit):
  //    a revealed one fades in where it lands, and one whose place in its frame is unchanged just rides
  //    along with it. Only a card that moved WITHIN its frame (a tidy-up) glides.
  const stays = (m: MindNode): boolean => {
    const p = parentOf(m);
    if (!p || isScopeRoot(p)) return false;
    const bm = before.get(m.id), bp = before.get(p.id);
    if (!bm) return true;
    return !!bp && Math.abs((bm.x - bp.x) - (m.x - p.x)) < 0.5 && Math.abs((bm.y - bp.y) - (m.y - p.y)) < 0.5;
  };
  // A frame's content wrapper (its CLIP) is a sibling of its box, not inside it, so it glides alongside:
  // parked at the same offset from its final spot as the box, then sent home with the same transition.
  // Otherwise the box would glide while the clip jumped, and the cards would hang outside it meanwhile.
  const clips: [HTMLElement, string, string][] = [];
  for (const m of visible){
    m.el!.classList.remove('lt-anim');
    const s = stays(m) ? { x: m.x, y: m.y } : before.get(m.id) || ancestorStart(m, before);
    setNodeElXY(m, s.x, s.y);
    if (!before.has(m.id)) m.el!.style.opacity = '0';
    const w = m.frameContentEl;
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
  for (const m of visible){ if (!stays(m)) m.el!.classList.add('lt-anim'); placeNodeEl(m); m.el!.style.opacity = ''; }
  for (const [w, left, top] of clips){ w.classList.add('lt-anim'); w.style.left = left; w.style.top = top; }
  // 3) edges follow the moving cards; drop the transition class once it's done
  followEdges(tok, DUR + 20);
  setTimeout(() => {
    if (tok !== ui.animToken) return;
    for (const m of visible) m.el && m.el.classList.remove('lt-anim');
    for (const [w] of clips) w.classList.remove('lt-anim');
    document.body.classList.remove('layout-anim');
    paintFreeEdges();
  }, DUR + 60);
}


// Toggle one node's collapse: folds it down to just its title — hides its body and, if it has
// children, folds them (and everything below) too. A leaf with a body can fold its body alone.
export function toggleCollapse(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  if (isLockedEffective(n)) { setStatus('Locked — can’t collapse/expand'); return; }
  if (!canFold(n)) return;   // a card with nothing to tuck away
  // Unfolding a frame whose notes are still on disk reads them first (data/lazy.ts), then unfolds.
  if (n.collapsed && afterReading([id], () => toggleCollapse(id), false)) return;
  // animate the reflow; animateLayout paints, measures heights, and lays out the children
  record([id], () => animateLayout(() => { n.collapsed = !n.collapsed; n.dirtyLayout = true; }));
  dropHiddenFromSelection();
  syncFloatBar();   // its fold button shows the state a click would make
  scheduleSave();
  setStatus(n.collapsed ? `Collapsed “${nodeLabel(n)}”` : `Expanded “${nodeLabel(n)}”`);
}
// A frame folded around selected cards takes them off the canvas — and out of the selection, so no key
// or bar acts on cards you can't see.
function dropHiddenFromSelection(): void {
  if ([...state.sel].some(id => { const m = state.nodes.get(id); return !!m && isHidden(m); }))
    setSelectionSet([...state.sel].filter(id => { const m = state.nodes.get(id); return !m || !isHidden(m); }));
}
// Fold/unfold a whole set of cards together (double-clicking one card of a multi-selection).
// Only foldable cards (children or a body) count; the group lands on one shared state — expand
// if they're all collapsed already, otherwise collapse them all.
// Which of `ids` can actually be folded — the one filter both the toggling and the directional paths
// below share, so the chip, X and ←/→ can't disagree about what counts.
function foldableSelection(ids: Iterable<string>): MindNode[] {
  return nodesOf(ids)
    .filter(n => !isLockedEffective(n))
    .filter(canFold);
}
// Apply one shared fold state to a whole set, as ONE undo step and one animated reflow.
function applyCollapsed(cards: MindNode[], collapsed: boolean): void {
  if (!collapsed && afterReading(cards.map(n => n.id), () => applyCollapsed(cards, false), false)) return;
  record(cards.map(n => n.id),
    () => animateLayout(() => { for (const n of cards){ n.collapsed = collapsed; n.dirtyLayout = true; } }));
  dropHiddenFromSelection();
  syncFloatBar();   // its fold button shows the state a click would make
  scheduleSave();
  const what = cards.length > 1 ? `${cards.length} notes` : `“${nodeLabel(cards[0]!)}”`;
  setStatus(`${collapsed ? 'Collapsed' : 'Expanded'} ${what}`);
}
export function toggleCollapseSelection(ids: Iterable<string>): void {
  const cards = foldableSelection(ids);
  if (!cards.length) return;
  applyCollapsed(cards, !cards.every(n => n.collapsed));   // all collapsed → expand; else collapse all
}
// What "Collapse/Expand all" (⌘P) act on: the selected frames and everything inside them when frames
// are selected, else every frame and card in the place you're looking at (the open frame's interior, or
// the map) — cards tucked inside a folded frame included, so Expand all brings back the whole lot. Never
// the open node itself: it's the canvas.
export function foldScope(): MindNode[] {
  const frames = [...state.sel].map(id => state.nodes.get(id)).filter((n): n is MindNode => n?.type === 'frame');
  const pool = frames.length
    ? frames.flatMap(f => subtreeIds(f.id).map(id => state.nodes.get(id)!))
    : [...state.nodes.values()].filter(n => !outOfScope(n));
  return pool.filter(canToggleFold);
}
// Expand all brings back the WHOLE lot, so every folded frame in reach is read to the bottom first
// (data/lazy.ts) — and the set is taken again after, since what was read holds more to unfold.
function expandAll(): void {
  const go = (): void => setCollapsedSelection(foldScope().map(n => n.id), false);
  if (!afterReading(foldScope().map(n => n.id), go)) go();
}
// The DIRECTIONAL form, for ←/→: fold (or unfold) every selected card that isn't already there, and
// leave the ones that are alone — so pressing → twice can't fold what it just unfolded, and a mixed
// selection lands on one state in a single press instead of needing two.
export function setCollapsedSelection(ids: Iterable<string>, collapsed: boolean): void {
  const cards = foldableSelection(ids).filter(n => !!n.collapsed !== collapsed);
  if (!cards.length) return;
  applyCollapsed(cards, collapsed);
}
// ---------- arrow keys: go IN and OUT of frames, fold and unfold branches ----------
//   ↑  open the selected frame (nav/scope.ts)        ↓  leave the open one
//   →  unfold                                        ←  fold
// The four keys are about DEPTH, in the two senses this map has: which folder you're standing in,
// and whether a branch is showing. Walking siblings and stepping onto a child lost their keys to
// that, deliberately — opening a frame is now the primary way to navigate a big map, and clicking
// covers moving between siblings.
// They were never geometric and still aren't — a child now lives INSIDE its parent, so there is no
// direction from one to the other for an arrow key to mean.
// ←/→ are DIRECTIONAL, unlike the chip / X / the ⋯ menu, which all toggle: pressing → twice can't
// fold what it just unfolded. They act on the WHOLE selection (setCollapsedSelection), like the chip
// and X do — a fold is something you do to cards, and there's no reason a keyboard fold should reach
// fewer of them than a click does.
function navArrow(key: string): void {
  // ↓ reads the SCOPE, not the selection, so it still works right after clicking empty space to
  // deselect — which is exactly when you want to go back up. Inert at the top level, silently: a
  // status line there would nag on every repeat press.
  if (key === 'ArrowDown') { exitScope(); return; }
  const n = state.selId ? state.nodes.get(state.selId) : null;
  if (key === 'ArrowUp') {
    // ↑ stays single: you can only stand in one place, so it acts on the anchor.
    if (!n) { setStatus('Select a frame to open it'); return; }
    openFrame(n);          // reports its own refusal for the kinds that can't be opened
    return;
  }
  if (!n) return;          // ←/→ have nothing to fold
  // → unfolds, ← folds — every selected card that isn't already there.
  setCollapsedSelection(selectedIds(), key === 'ArrowLeft');
}
// Lock/unlock every selected card (the float bar's lock toggle / L). Locking freezes that card in place — no move,
// (un)collapse, rename/body/color/type/layout edit, add-child, or delete — and cascades so its
// whole subtree becomes unselectable too (see utils/model.ts). Unlocking never touches descendants
// (lock is per-card, not stored on them). A descendant of a locked ancestor can't be selected, so
// it never reaches this function as a target; only cards actually selectable can be (un)locked.
// Does a selection count as LOCKED for toggle purposes? A mixed selection does, so the toggle
// unlocks all. Lives next to the mutator because both the L shortcut and the float bar's lock
// button need it, and the two must never disagree on the mixed-selection rule — that button is the
// only escape hatch out of a locked selection.
export function anyLocked(ids: Iterable<string>): boolean {
  return [...ids].some(id => { const n = state.nodes.get(id); return !!n && isLockedEffective(n); });
}
export function setLockedSelection(ids: Iterable<string>, locked: boolean): void {
  if (state.readOnly) return;
  const cards = [...ids].map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n && n.locked !== locked);
  if (!cards.length) return;
  record(cards.map(n => n.id), () => { for (const n of cards){ n.locked = locked; n.dirty = true; } });
  paintAll();
  syncFloatBar();   // the bar collapses to just its lock toggle while the selection is locked
  scheduleSave();
  setStatus(`${locked ? 'Locked' : 'Unlocked'} ${cards.length} card${cards.length===1?'':'s'}`);
}
// Flip the idx-th task checkbox in a node's body and write the change back to disk.
function toggleTask(n: MindNode, idx: number): void {
  if (state.readOnly || isLockedEffective(n)) return;
  let i = 0;
  record([n.id], () => {
    n.body = n.body.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (m, pre, mark) =>
      i++ === idx ? pre + (mark === ' ' ? '[x]' : '[ ]') : m);
    n.dirty = true;
  });
  if (ui.bodyEdit && ui.bodyEdit.id === n.id) ui.bodyEdit.ta.value = n.body;   // keep an open in-card editor in sync
  paintNode(n); scheduleSave();
}

// ---------- node dragging + reparent-by-drop live in features/drag.ts ----------
export function subtreeIds(id: string): string[] {
  // id + every descendant
  const out = [id];
  for (const ch of childrenOf(id)) out.push(...subtreeIds(ch.id));
  return out;
}
// ---------- pan / zoom / marquee-select gestures live in features/gestures.ts ----------


// Focus a card: unfold it when openTarget, select it, frame it + all its visible descendants.
export function focusNode(target: MindNode | undefined, openTarget = false): void {
  if (!target) return;
  const before = layoutSnapshot();             // pre-reveal frame to glide away from
  // Unfold the frames it's tucked inside (and, when openTarget, the card itself) so it's on the canvas.
  const toReveal = [...ancestors(target)].filter(p => p.collapsed);
  if (openTarget && target.collapsed) toReveal.push(target);
  let revealed = false;
  if (toReveal.length)
    record(toReveal.map(m => m.id), () => { for (const m of toReveal){ m.collapsed = false; m.dirtyLayout = true; } revealed = true; });
  selectNode(target.id);                       // select → the card shows its full body (grows)
  relayout();                  // reflow siblings around the now-taller selection
  animateReflow(before);                       // one glide from the pre-reveal frame to the final
  frameBox(subtreeIds(target.id).map(id => state.nodes.get(id)));
  if (revealed && store.isOpen) scheduleSave();
}
// Follow a [[wikilink]] and focus its target. Map-wide, on purpose — a link that only worked inside the
// frame you happened to be in would be a broken link — so it comes out of as many scope levels as it
// takes to show the target (popScopeFor).
//
// Two cards may now share a title, so a bare `[[Notes]]` can be AMBIGUOUS. It resolves to the first
// match either way (a link has to go somewhere, and refusing to move would read as a dead link), but it
// SAYS so, since the alternative — picking silently and looking like a bug — is the worse of the two.
// The way to be exact is the PATH form, `[[Frames/Notes]]` or `[[Notes 2]]`, matched against the node's
// file: that's the one name in this app guaranteed unique, which is exactly why the disambiguator lives
// there rather than in some new syntax.
function focusByTitle(title: string, from?: MindNode): void {
  const hits = resolveWikilink(title);
  const target = hits[0];
  // A link to a card that isn't there yet WRITES it (Obsidian's gesture): the new card lands beside
  // the one you clicked from, free-standing — a wikilink is a relation, never containment. Only the
  // TITLE form can be created: the PATH form names a folder nothing here chooses.
  if (!target){
    if (!from || state.readOnly || title.includes('/')){
      setStatus(`No node titled “${title}” in this map`); return;
    }
    const at = snapPt({ x: from.x + nodeW(from) + 40, y: from.y });
    if (createNode({ x: at.x, y: at.y, title, edit: false })) setStatus(`Created “${title}”`);
    return;
  }
  popScopeFor(target);
  focusNode(target);
  if (hits.length > 1)
    setStatus(`${hits.length} cards are titled “${title}” — went to the one in ${target.file ?? 'this map'}`);
}
// The "focus" command (toolbar button + F): frame the selected card (+ its subtree), or
// frame the whole map when nothing is selected — both glide with the same easing. While a frame is
// OPEN, "the whole map" means its contents: frameBox filters isHidden, so the scope comes for free.
function focusOrFit(): void {
  if (state.selId && state.nodes.has(state.selId)) focusNode(state.nodes.get(state.selId));
  else focusScope();
}
// Re-frame whatever is ON the canvas right now: the open frame's contents while scoped (isHidden
// does the filtering), the whole map plus its ink otherwise. The single spelling of "frame all of
// this", shared by F-with-nothing-selected, every open/exit and the current crumb.
export function focusScope(): void { frameBox([...state.nodes.values()]); }

// ---------- OPENING a frame: the scoped canvas ----------
// The ACTIONS; nav/scope.ts holds the model and the reasoning. They sit beside focusNode because
// that's their template (reveal → select → glide), but this is a separate feature: focusNode frames
// a card WITHIN the map, opening replaces what the map is for as long as you're inside.

// The viewport rect the open frame lays its contents out in — read back through containerBox /
// frameInterior. A SNAPSHOT, taken here and refreshed only on a window resize:
//  · not LIVE: the drop test reads it on every move, and a rect that moved with every pan would
//    make where a card lands depend on how you got there.
//  · sized at k = 1 (the app's canonical 1 world px = 1 screen px), not at the current zoom: the
//    camera is about to change, since opening fits the contents, so reading the live k is circular.
//    frameBox clamps k ≤ 1.0 anyway, so the fitted result lands near 1 and the contents do fill it.
//  · bottomInset() is deliberately NOT subtracted. It's nonzero only while the float bar is docked
//    AND open, i.e. it tracks the SELECTION — folding it in would reflow the frame on every click.
//    It belongs to the camera moves (frameBox/revealInView) and stays there. Same for the crumb bar,
//    which is floating chrome over the canvas like #toolbar.
//  · anchored at the frame's own content origin, so opening a frame moves nothing at all (and so
//    dirties nothing).
function scopeRectFor(t: MindNode): { x: number; y: number; w: number; h: number } {
  const home = containerBox(t);   // read before the level is pushed, so it's the frame's real bounds
  const s = stageSize();
  return { x: home.x, y: home.y, w: s.width, h: s.height };
}
// Re-measure the open level after a window resize; the anchor is kept, since the open frame can't
// move (it isn't selectable and nothing lays it out). Returns whether anything actually changed.
function refreshScopeRect(): boolean {
  const top = scope.stack[scope.stack.length - 1];
  if (!top) return false;
  const s = stageSize();
  if (Math.round(top.rect.w) === Math.round(s.width) && Math.round(top.rect.h) === Math.round(s.height)) return false;
  top.rect = { x: top.rect.x, y: top.rect.y, w: s.width, h: s.height };
  return true;
}
function currentBack(): ScopeBack { return { view: { ...state.view }, sel: [...state.sel], selId: state.selId }; }

// Rebuild the stack so its last level is `target` (null = the whole map). The stack IS the crumb
// path — the openable ancestor chain, not just what the user happened to click through — so opening
// a deep frame from the ⋯ menu still reads `Map › A › B › C`. Levels that survive the rebuild keep
// their remembered camera and rect, which is what makes `open A → open B → leave` glide back to the
// camera A really had; levels nobody stepped through get no `back` and are re-fitted instead.
function setScopeStack(target: MindNode | null, back: ScopeBack | null): void {
  if (!target) { scope.stack = []; scope.rootId = null; return; }
  const keep = new Map(scope.stack.map(l => [l.rootId, l]));
  const next: ScopeLevel[] = [];
  for (const n of [...openPathTo(target), target])
    next.push(keep.get(n.id) ?? { rootId: n.id, file: n.file ?? null, rect: scopeRectFor(n), back: null });
  const top = next[next.length - 1]!;
  if (!keep.has(top.rootId)) top.back = back;   // only a level you're newly entering records a way back
  scope.stack = next;
  scope.rootId = target.id;
}

// A FREE frame you were INSIDE had the whole viewport to arrange things in, so a card can easily end
// up outside the box it goes back to being on the way out — where its wrapper's overflow:hidden would
// clip it clean away. So grow the box to hold what's in it as you leave (growFramesToHold), and only
// when something really does stick out, so a visit that moved nothing still writes nothing.
// A locked frame is out: it refuses to be resized at all.
// A FOLDED frame is measured as the box it unfolds to, not its pill: unfolded for the measurement
// only, and folded straight back, so leaving it moves nothing unless a card really sticks out.
function growToFitContents(f: MindNode): void {
  if (state.readOnly || f.type !== 'frame') return;
  const folded = f.collapsed;
  f.collapsed = false;
  try { growFramesToHold(childrenOf(f.id).map(k => k.id)); }
  finally { f.collapsed = folded; }
}

interface ScopeOpts { back?: ScopeBack | null; restore?: ScopeBack | null; exiting?: boolean; camera?: boolean; }
function applyScope(target: MindNode | null, opts: ScopeOpts = {}): void {
  // A scope change re-parents elements (a child moves between #world and a wrapper), which would
  // drop a captured pointer or blur an open editor.
  endInPlaceEdit();
  cancelViewAnim();
  const before = scope.rootId;
  const left = before ? state.nodes.get(before) : undefined;
  animateLayout(() => {
    setScopeStack(target, opts.back ?? null);
    // settledHost caches which wrapper each element sits in (hostFrameId), and the scope just
    // changed which wrapper that IS. Drop the cache or the children keep being placed into a
    // wrapper paintNode is about to remove.
    for (const n of state.nodes.values()) n.hostFrameId = undefined;
    refreshScopeRect();
    // Now that the stack is settled, containerBox reports the frame we just left at its real size
    // again — so this is the moment to check nothing it holds got stranded outside it. Its own undo
    // step: ⌘Z undoes the resize without teleporting you between scopes.
    // `type === 'frame'` and not a scope predicate: the scope stack has already moved above this line.
    if (left && left.type === 'frame' && !isScopeRoot(left)) record([left.id], () => growToFitContents(left));
  });
  if (opts.exiting) {
    // Leaving: select the frame you came out of — that's what makes a crumb read as a back button —
    // and glide to the camera you left. A level nobody stepped through has none, so it re-fits.
    const came = before ? state.nodes.get(before) : undefined;
    const ids = came && !outOfScope(came) ? [came.id]
      : (opts.restore?.sel ?? []).filter(id => { const n = state.nodes.get(id); return !!n && !outOfScope(n); });
    setSelectionSet(ids);
    if (opts.restore) animateViewTo(opts.restore.view.x, opts.restore.view.y, opts.restore.view.k);
    else if (opts.camera !== false) focusScope();
  } else {
    selectNode(null);            // the frame itself is off the canvas now, so nothing is selected
    if (opts.camera !== false) focusScope();
  }
  syncUrl();                     // a discrete navigation step, like selecting a node → a history entry
  if (before !== scope.rootId) scheduleSave();
}

// Open a frame. Allowed in read-only and on a LOCKED frame: looking inside the box isn't changing it.
export function openFrame(target: MindNode | undefined): void {
  const t = target;
  if (!t || !canOpen(t)) { setStatus('Only a frame can be opened'); return; }
  if (afterReading([t.id], () => openFrame(t), false)) return;   // its notes are the canvas you open onto
  const back = currentBack();
  // Opening is pure navigation, in the same class as revealInView: it writes no node field. A FOLDED
  // frame stays folded — while you stand in it its interior is the canvas whatever its fold says
  // (isHidden asks about the open frame before the fold), and you come back out to the same pill.
  if (isScopeRoot(t)) return;                  // already standing in it
  applyScope(t, { back });
  setStatus(`Opened “${nodeLabel(t)}”`);
}
// Leave the innermost level.
export function exitScope(): void {
  // Leave the level you're standing in — AND every SYNTHESIZED level beneath it. A level with no
  // `back` is one nobody stepped through (setScopeStack): opening a card that lives three frames deep
  // pushes those frames as crumbs, and leaving one at a time would walk you out through folders you
  // were never in. Coming out of a card therefore lands you where you were when you went into it,
  // which is what "close" means. A level you DID open by hand keeps its own back and stops the walk,
  // so `open A → open B → leave` still lands in A exactly as before.
  let d = scope.stack.length - 1;
  while (d > 0 && scope.stack[d - 1]!.back === null) d--;
  goToScopeDepth(d);
}
// Leave the level AT `depth`, landing in the one above it — so depth 0 is "back to the whole map".
// A crumb click is exactly this, which is why the crumbs need no logic of their own.
export function goToScopeDepth(depth: number): void {
  if (depth < 0 || depth >= scope.stack.length) return;   // ↓ at the top level: silently inert
  const leaving = scope.stack[depth]!;
  const upId = depth > 0 ? scope.stack[depth - 1]!.rootId : null;
  // Several levels can be left at once — exitScope pops the synthesized ones, a crumb click jumps out
  // of many. The camera to glide back to belongs to the OUTERMOST level being left, or, when that one
  // was synthesized and never recorded a camera, to the innermost that did: that is the state the user
  // was actually in before the whole excursion.
  let back = leaving.back;
  for (let i = scope.stack.length - 1; i > depth && !back; i--) back = scope.stack[i]!.back;
  applyScope(upId ? state.nodes.get(upId) ?? null : null, { restore: back, exiting: true });
}
// Restore the scope a URL hash asked for (nav/url-state.ts). No fit: the hash carries its own camera
// and must win. The hash is AUTHORITATIVE, so a path that's absent, gone, or no longer a frame all
// mean the same thing — the whole map — rather than quietly leaving you wherever you were: that
// distinction only shows up on a back/forward step, where honouring the URL is the entire point.
// No error either way; a shared link to a since-deleted frame should just open the map.
export function restoreScopeFromFile(file: string | null): void {
  const t = file ? nodeByFile(file) : undefined;
  const want = t && canOpen(t) ? t : null;
  if (!want) { if (scopeActive()) { withoutScopeFade(); applyScope(null, { exiting: true, camera: false }); } return; }
  if (isScopeRoot(want)) return;
  withoutScopeFade();
  applyScope(want, { camera: false });
}
// The canvas colour must LAND, not fade in, whenever the scope comes from the URL rather than from
// something the user just did. On a reload there is nothing to transition FROM — the map has only just
// appeared — so the fade reads as the app flashing the wrong background before settling on the right
// one; on a back/forward step the camera and selection jump too, so a sliding background would be the
// only thing still catching up. Suppressed for two frames (long enough for the paint that sets
// --canvas-bg to land), after which every real open/leave fades again.
function withoutScopeFade(): void {
  document.body.classList.add('scope-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('scope-instant')));
}
// Bring `t` into reach from ANYWHERE: leave as many levels as it takes for it to be inside the scope
// we land in. The deliberately UNSCOPED jumps (a [[wikilink]], an undo that
// resurrects a node elsewhere) all go through here, so none of them can select a card that isn't on
// the canvas — isSelectable refuses an out-of-scope id.
export function popScopeFor(t: MindNode): void {
  for (let guard = 0; scopeActive() && outOfScope(t) && guard < 64; guard++) exitScope();
}
// Keep the crumb bar in step, and recover from the open frame having been deleted / undone away /
// removed on disk. pruneScope (view/layout.ts's applyLayouts) already truncated the stack; the
// camera half has to live here, and without it you'd be staring at the parent scope through the
// departed child's camera. Driven from paintAll, so every mutation path gets it.
// While a frame is OPEN the canvas IS its interior, so the canvas takes the frame's own fill — the
// very colour its box was wearing a moment before, through the same resolver its box used
// (effectiveColor → colorFill), so the two can't drift. At the TOP level there is no frame and the
// canvas wears the MAP's own colour instead (state.canvasColor, per-map in settings.json). Written on
// #stage, not <body>, so the theme's own --bg is left completely alone; #stage sits under #grid, so
// the grid still draws over it.
// A FRAME's fill is the PALE one its box wears (paleFill — the same wash styles.css gives the box), so
// the cards in it, which take its full colour, read on it the same as they did inside the box.
// …and, for a frame, only when that colour is AUTHORED somewhere up the chain. effectiveColor
// deliberately falls back to the theme's neutral card fill for a frame nobody has coloured, and
// painting the whole canvas THAT would be both a lie (there's no colour to show) and a real problem in
// the light theme, where the near-white fill swallows the floating chrome sitting on the canvas — the
// ghost-card pill, the status line. The test is authorship, not the hex, so a frame explicitly
// coloured white still tints. state.canvasColor needs no such test: it's authored by definition.
function hasAuthoredColor(n: MindNode): boolean {
  if (n.color) return true;
  for (const a of ancestors(n)) if (a.color) return true;
  return false;
}
// WHOSE colour the canvas shows, and therefore what the canvas-colour button edits: the frame you're
// standing IN, or nothing (= the map itself) at the top level. ONE resolver, read by the paint below
// and by the picker (features/canvas-color.ts), so the colour you can see and the colour the button
// writes can't become two different things.
export const canvasOwner = (): MindNode | null => scopeRootNode();
// The fill actually behind the cards right now — the one input both the background and the grid ink
// are derived from. null = none, and the theme's own background shows through as before.
//
// An owner with NO authored colour anywhere up its chain falls through to the MAP's own canvas colour
// rather than to nothing: what's behind an uncoloured frame is whatever is behind IT. Standing inside a frame nobody coloured
// used to discard the canvas colour the map itself was painted in — so
// going in turned a teal board grey, and coming out turned it teal again.
export function canvasFill(): string | null {
  const owner = canvasOwner();
  if (!owner || !hasAuthoredColor(owner)) return colorFill(state.canvasColor);
  const fill = colorFill(effectiveColor(owner));
  return fill && paleFill(fill);
}
// The fill a thing drawn ON THE CANVAS is sitting on: the canvas's own colour, else the theme's. What a
// free edge's label plate is painted in — a label is a small
// patch of the canvas laid over the line, so its ink is measured against exactly this.
export function canvasSurface(): string { return canvasFill() ?? THEME_BG; }
// The grid ink is derived from the THEME (--grid/--text in styles.css), which on a coloured canvas
// leaves it either invisible or harsh. So re-derive --grid-pat from the fill that's really behind it,
// by the theme's own 55/45 recipe with the fill standing in for --grid and, for --text, the direction
// that HAS contrast against that fill — inkFor, the same call a card's own ink goes through, so an
// arbitrary picked colour needs no special case. Written on #stage, which is where the fill is set;
// #grid is its child and declares --grid-ink from it, so one write covers both grid levels.
export function syncCanvasBackground(): void {
  const fill = canvasFill();
  if (fill) {
    stage.style.setProperty('--canvas-bg', fill);
    stage.style.setProperty('--grid-pat', `color-mix(in srgb, ${fill} 55%, ${inkFor(fill)} 45%)`);
  } else {
    stage.style.removeProperty('--canvas-bg');
    stage.style.removeProperty('--grid-pat');
  }
  markCanvasColorBtn();   // the button's own chip mirrors whatever it would edit
  syncThemeColor(fill);
}
// The browser's theme colour (Safari's bars, an installed app's title bar) is the canvas you're standing
// on, so the chrome around the board reads as part of it; the board's own grey when it has no colour. A
// fill can be a palette VARIABLE, which a meta tag can't read, so it is resolved to rgb on a hidden probe
// — not off #stage, whose background is mid-transition right after a change.
const themeMeta = document.querySelector('meta[name="theme-color"]');
let themeProbe: HTMLElement | null = null;
function syncThemeColor(fill: string | null | undefined): void {
  if (!themeMeta) return;
  if (!themeProbe) { themeProbe = document.createElement('i'); themeProbe.hidden = true; document.body.append(themeProbe); }
  themeProbe.style.color = fill || 'var(--bg)';
  const rgb = getComputedStyle(themeProbe).color;
  if (themeMeta.getAttribute('content') !== rgb) themeMeta.setAttribute('content', rgb);
}
function syncScopeChrome(): void {
  renderCrumbs();
  syncCanvasBackground();
  if (!scope.pruned) return;
  scope.pruned = false;
  if (state.sel.size || state.selId) setSelectionSet([]);
  focusScope();
  const open = scopeRootNode();
  setStatus(open ? `That frame is gone — back to “${nodeLabel(open)}”` : 'That frame is gone — back to the whole map');
}
// Keep the rect honest across a window resize. Nothing to re-lay-out — an open frame's contents sit
// where they were put; what still reads the rect is the drop test (frameAt / containerBox), which a
// stale rect would confine to the old window. Debounced, and a no-op when the size didn't really change.
let scopeResizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  if (!scopeActive()) return;
  clearTimeout(scopeResizeTimer);
  scopeResizeTimer = setTimeout(refreshScopeRect, 200);
});

// ---------- selection + editor ----------
// Selection and the edit panel are decoupled: a node can stay selected while the
// panel is closed (press Esc). That closed-but-selected state is when Delete works.

// colour palette (keys match the .c-* CSS classes); 'grey' is the old neutral "none" look.
// The hexes themselves live in ONE place — the --pal-* custom properties in styles.css's
// :root — so CSS (.c-*, #ghostCard) and JS (edges/backgrounds fills, swatch dots below) can never
// drift apart.
// Every key a note may carry. `slate` predates FigJam's palette: it still paints, but the picker no
// longer offers it.
export const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey','white','black',
  'orange','silver','stone','bold-red','bold-orange','bold-yellow','bold-green','bold-teal','bold-blue','bold-violet','bold-pink'];
// …and what the picker OFFERS, FigJam's two rows of eleven: the strong hues framed by black and white,
// then the pastels — the sticky colours — framed by two greys (the custom chip ends that row).
export const PICKER_ROWS: string[][] = [
  ['black','stone','bold-red','bold-orange','bold-yellow','bold-green','bold-teal','bold-blue','bold-violet','bold-pink','white'],
  ['silver','grey','red','orange','amber','green','teal','blue','violet','pink'],
];
const pal = (name: string): string => getComputedStyle(document.body).getPropertyValue(`--pal-${name}`).trim();
export const SWATCH_BG: Record<string, string> = Object.fromEntries(PALETTE.map(c => [c, pal(c)]));
// The canvas's own THEME fill, read and cached exactly like the palette above. It's canvasSurface's last
// resort, when the map has no colour of its own. Cached rather than read live because it runs on every
// edge paint.
const themeBg = (): string => getComputedStyle(document.body).getPropertyValue('--bg').trim();
const THEME_BG = themeBg();
// ---------- ink: the text colour each palette fill demands ----------
// Ink is COMPUTED from the fill (utils/ink.ts — WCAG contrast, biased toward the map's default
// light ink), never authored, which is the point: the old scheme spelled out per-colour text
// exceptions ("white is too bright for white text; in the light theme everything except grey and
// black flips to black") and had to repeat that list on every surface that wears a .c-* class —
// four copies to keep in step, and no answer at all for a colour outside the palette.
// The computed values reach CSS as --pal-ink-*/--pal-scrim-* custom properties on :root, injected
// here rather than written in styles.css because only JS can measure a colour; the .c-* rules there
// hand them to each card as --ink/--scrim, so ONE `color: var(--ink)` per surface now covers every
// colour in both themes. Injecting a <style> (not a per-node inline style) keeps this off the paint
// path entirely — it's 11 rules written twice per session, not per card per frame.
const inkStyle = document.createElement('style');
document.head.appendChild(inkStyle);
// …and the `.c-<key>` class each key is worn by, generated here beside its ink rather than listed by
// hand in styles.css, so adding a key to PALETTE (and its --pal-* hex) is the whole job.
function deriveInk(): void {
  inkStyle.textContent = ':root{' + PALETTE.map(c => {
    const bg = SWATCH_BG[c] ?? '';
    return `--pal-ink-${c}:${inkFor(bg)};--pal-scrim-${c}:${scrimFor(bg)};`;
  }).join('') + '}' + PALETTE.map(c =>
    `.c-${c}{--card:var(--pal-${c});--ink:var(--pal-ink-${c});--scrim:var(--pal-scrim-${c})}`).join('');
}
deriveInk();
// ---------- a colour VALUE: a palette key, or an authored hex ----------
// `n.color` (and so effectiveColor's result) is one of: '' (inherit), 'none', a PALETTE KEY, or a
// custom '#rrggbb' picked from the colour popover. These three resolve any of them, and every
// consumer goes through them so "custom" never needs a branch of its own:
//   colorFill  — the hex it paints as, for the things JS tints itself (edges, the canvas).
//                null for 'none'/inherit/unknown, which callers already fall back to --edge for.
//   colorClass — the CSS class to hang on the element. A hex can't be a class name (and there'd be
//                nowhere to put its hexes), so a custom colour gets .c-custom + inline variables…
//   applyColorVars — …which are those variables: the same --card/--ink/--scrim triple a .c-* class
//                provides, just computed per node instead of once per palette key. Everything
//                downstream keys off the variables alone, so a custom colour behaves exactly like a
//                palette one — including the :not(.c-none) tests.
// One inline declaration per coloured node is affordable where a generated stylesheet isn't: the set
// of custom colours in a map is open-ended, and a node's own style attribute is already written on
// every paint.
export function colorFill(c: string): string | null { return SWATCH_BG[c] ?? (isHexColor(c) ? c : null); }
export function colorClass(c: string): string { return isHexColor(c) ? 'c-custom' : 'c-' + c; }
// SET for a custom colour, REMOVED otherwise. Removing matters —
// recolouring a custom card back to a palette key has to drop the inline triple, or it would keep
// overriding the .c-* class that now owns the colour (an inline custom property beats any selector).
export function applyColorVars(el: HTMLElement, c: string): void {
  if (isHexColor(c)) {
    el.style.setProperty('--card', c);
    el.style.setProperty('--ink', inkFor(c));
    el.style.setProperty('--scrim', scrimFor(c));
  } else {
    for (const prop of ['--card', '--ink', '--scrim']) el.style.removeProperty(prop);
  }
}
// Select everything ON THE CANVAS — which, inside an open frame, is that frame's contents and nothing
// else. It needs no scope test of its own: isHidden already means "on the canvas right now", covering
// both the open frame and folded branches, and setSelectionSet drops whatever isn't selectable (a
// locked card's descendants). Shared by ⌘A and the canvas context menu, so the two can't diverge.
export function selectAll(): void {
  setSelectionSet([...state.nodes.values()].filter(n => !isHidden(n)).map(n => n.id));
  setStatus(state.sel.size ? `Selected ${state.sel.size} card${state.sel.size > 1 ? 's' : ''}` : 'Nothing to select');
}
// the ids currently being edited (one or many) — colour and lock apply to all of them
export function selectedIds(): string[] { return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }
// …the ones of them that can wear tags (no frames).
export const taggableSelection = (): string[] => selectedIds().filter(id => wearsTags(state.nodes.get(id)));
// reflect state.sel in the canvas + the floating edit bar (features/float-bar.ts)
// Selecting a CARD ends any edge selection — the two never coexist (core/state.ts selEdges). Enforced
// here, at the one funnel every card-selection path runs through, rather than at each of them.
// Only the cards whose ring changes repaint — the ones wearing it now (`.sel` in the DOM, so it can't go
// stale) and the new selection. A click used to repaint the whole map. A mutation that also selects
// still ends in its own relayout()/remeasure().
export function applySelection(): void {
  if (state.sel.size && state.selEdges.size) clearEdgeSelection();
  const ids = new Set(state.sel);
  world.querySelectorAll<HTMLElement>('.node.sel').forEach(el => { if (el.dataset.id) ids.add(el.dataset.id); });
  for (const id of ids) { const n = state.nodes.get(id); if (n) paintNode(n); }
  paintFreeEdges(); syncFloatBar(); syncUrl(); updateDocumentTitle();
}
// A descendant of a locked card can't be selected at all — the locked card itself still can be
// (see utils/model.ts hasLockedAncestor). Nor can anything outside the frame you're standing in:
// it isn't on the canvas, so a selection ring would be invisible and every action on it would look
// dead. The deliberately unscoped jumps (wikilinks, query results, undo) come out of their scope
// first — see popScopeFor. Shared by every selection entry point below.
function isSelectable(id: string): boolean {
  const n = state.nodes.get(id); return !n || (!hasLockedAncestor(n) && !outOfScope(n));
}
// Replace the whole selection with `ids` (a Set or array), recomputing the primary.
export function setSelectionSet(ids: Iterable<string>): void {
  state.sel = new Set([...ids].filter(isSelectable));
  if (state.sel.size === 0) state.selId = null;
  else if (state.sel.size === 1) state.selId = [...state.sel][0];
  else if (!state.selId || !state.sel.has(state.selId)) state.selId = [...state.sel].pop() ?? null;
  applySelection();
}
// ⌘/Ctrl-click: add or remove one card from the selection.
export function toggleSel(id: string): void {
  if (state.sel.has(id)){
    state.sel.delete(id);
    if (state.selId === id) state.selId = state.sel.size ? ([...state.sel].pop() ?? null) : null;
  } else {
    if (!isSelectable(id)) return;
    state.sel.add(id); state.selId = id;
  }
  applySelection();
}

syncFloatBar();

// ---------- read-only mode ----------
// View & collapse only: nothing saves, the sidebar hides, editing icons grey out, and the
// add-child + is hidden. Collapsing is allowed but in-memory only — leaving read-only reloads
// from disk so the saved collapse state is restored.
const roBadge = byId<HTMLButtonElement>('roBadge');
// open padlock (unlocked); the closed one is LOCK_BADGE_SVG up top — one glyph shared by the
// locked-card badge and the float bar's lock toggle (features/float-bar.ts).
export const ICON_LOCK_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;
export function applyReadOnly(): void {
  const ro = state.readOnly;
  document.body.classList.toggle('readonly', ro);
  roBadge.hidden = !ro;
  // ghost card visibility is driven by body.readonly CSS rule
  syncFloatBar();
  setStatus(ro ? 'Read-only — nothing is saved' : 'Editing enabled');
  scheduleUrlSync();
}
applyReadOnly();
async function setReadOnly(on: boolean): Promise<void> {
  if (on === state.readOnly) return;
  if (on){
    await flushSave();                                   // persist anything pending before locking (clears the save timer)
    state.readOnly = true;
    selectNode(null);                                    // close any open edit
  } else {
    state.readOnly = false;
    if (store.isOpen) await loadFromDir({ keepView:true }); // discard in-memory collapses, restore disk state
  }
  applyReadOnly();
}
roBadge.onclick = () => setReadOnly(false);

// Select exactly one node (or clear with null), replacing any multi-selection.
export function selectNode(id: string | null): void {
  if (id == null){ state.sel.clear(); state.selId = null; }
  else {
    if (!isSelectable(id)) return;
    state.sel = new Set([id]); state.selId = id;
  }
  applySelection();
}
// Colour and lock apply live via the floating bar (features/float-bar.ts). The TITLE and BODY are edited on the canvas (F2 / double-click → inline edit).


// ---------- image attachments live in features/attachments.ts ----------
// ---------- in-place card editing lives in features/inline-edit.ts ----------
// While a card is being edited, the save loop defers the file rename until editing ends (so the folder
// isn't littered with M.md, Ma.md, Mag.md…) — it keys off `ui.bodyEdit` directly, which now holds the
// title too: the card is one text field whose first `# ` line IS its name.

// keyboard:
//  · N / ⌘N        → new node at the pointer   (Space: hand-pan; on an image card, open the picture)
//  · Enter          → a new card below the selected one, in the same place
//  · Tab            → a new card inside the selected frame
//  · F2             → rename the selected node in place (also: double-click its title)
//  · X              → collapse/eXpand the selected node(s) (also: the corner chip)
//  · ← → ↑ ↓        → ↑/↓ open/leave a frame, →/← unfold/fold
//  · E              → edit the selected node's note/body in place (also: double-click the body)
//  · #              → tag the selected cards (features/tag-picker.ts), or with none find by tag
//  · ⌘F or /        → find, by text and #tags (features/search.ts); Esc ends a standing search first
//  · T              → the tag tray (features/tag-tray.ts)
//  · Delete/Backspace → delete the selected node (only when the edit panel is closed)
// A focused title editor (the sidebar field OR an in-card inline rename) counts as "typing",
// so these card shortcuts stay out of the way while you're naming something.
window.addEventListener('keydown', (e) => {
  // The letter shortcuts below are case-INSENSITIVE (Caps Lock, or a held ⇧ that means something of
  // its own like ⇧A), so a single printable character is folded down once here rather than tested
  // twice per line. Named keys keep their own spelling — 'F2' must not become 'f2', nor 'ArrowUp'
  // 'arrowup' — hence the length test rather than a blanket toLowerCase.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.metaKey || e.ctrlKey;
  const del = key === 'Delete' || key === 'Backspace';

  // Intercept browser zoom shortcuts (Cmd/Ctrl +/-/0) so they drive the canvas, not the viewport.
  // Must be checked before the `typing` guard so they work even while a text field is focused.
  if (mod) {
    if (key === '=' || key === '+') { e.preventDefault(); zoomAt(window.innerWidth/2, window.innerHeight/2, 1.2); return; }
    if (key === '-')                { e.preventDefault(); zoomAt(window.innerWidth/2, window.innerHeight/2, 1/1.2); return; }
    if (key === '0')                { e.preventDefault(); focusOrFit(); return; }
    // ⌘F is FIND here, the way it is on every canvas app — not the browser's find-in-page
    if (key === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); openSearch(); return; }
  }

  const active = document.activeElement as HTMLElement | null;
  const typing = isTypingInField();
  // Esc blurs the active field (so Delete works next), or deselects when not typing.
  if (key === 'Escape'){
    e.preventDefault();
    if (typing) { active?.blur?.(); }
    else if (state.selEdges.size) clearEdgeSelection();
    else if (searchActive()) closeSearch();   // a search left standing over the board, before the selection
    else if (state.sel.size) selectNode(null);
    return;
  }
  if (typing) return;
  if (tidyShortcut(e)) return;   // ⌥A/H/D/W/V/S align, ⌃⌥T/H/V tidy and distribute (features/tidy.ts)
  // ←→↑↓ walk / fold the tree (navArrow). No modifiers — ⇧/⌘
  // arrow combinations are left free for the browser and for later (extend-selection).
  if (key.startsWith('Arrow') && !e.shiftKey && !mod && !e.altKey){
    e.preventDefault(); navArrow(key); return;
  }
  if (key === 'r'){ e.preventDefault(); setReadOnly(!state.readOnly); return; }
  if (key === '/'){ e.preventDefault(); openSearch(); return; }   // find a card
  // #: tag the selected cards (features/tag-picker.ts) — or, with none, find by tag
  if (key === '#' && !mod){ e.preventDefault(); if (taggableSelection().length) openTagPicker(); else openSearch('#'); return; }
  if (key === 't' && !mod && !e.altKey && !e.shiftKey){ e.preventDefault(); toggleTray(); return; }   // the tag tray
  // NEW CARD, at the pointer. ⌘N is the name everyone knows it by — but on macOS Chrome/Safari it is an
  // application-menu accelerator (File ▸ New Window) and never reaches the page, so plain `N` carries the
  // shortcut in practice and sits in the same family as the app's other bare letters (A/E/X/D/F/O/S).
  // Both are bound: whichever the browser lets through does the same thing.
  if (key === 'n' && !e.shiftKey && !e.altKey){ e.preventDefault(); newCardAtPointer(); return; }
  // Space = hand-tool to pan while held (a tap on a selected image card opens it — see the keyup below).
  if (key === ' '){ e.preventDefault(); if (!e.repeat){ ui.spaceHeld = true; ui.spaceUsedForPan = false; } return; }
  if (key === 'f'){ e.preventDefault(); focusOrFit(); return; }
  if (key === 'd' && state.sel.size){ e.preventDefault(); duplicateSelection({ next: e.shiftKey }); return; }   // ⇧D: the SMART duplicate (crud.ts copyNext)
  if (key === 'a' && e.shiftKey && !mod && state.sel.size){ e.preventDefault(); autoSizeSelection(); return; }   // ⇧A: fit selected frames and cards to their contents
  if (key === 'g' && !mod && state.sel.size){ e.preventDefault(); groupSelectionIntoFrame(); return; }   // G: group selection into a frame
  // ⌘/Ctrl C / X copy / cut the selected cards (with their subtrees). No ⌘V handler here —
  // the native `paste` event (features/attachments.ts) carries clipboardData permission-free.
  if (key === 'c' && mod && state.sel.size){ e.preventDefault(); void copySelection(); return; }
  if (key === 'x' && mod && state.sel.size){ e.preventDefault(); void cutSelection(); return; }
  if (key === 'x' && !mod && state.sel.size){   // don't shadow cut
    e.preventDefault(); toggleCollapseSelection(state.sel); return;
  }
  if (key === 'l' && !mod && state.sel.size && !state.readOnly){
    e.preventDefault();
    setLockedSelection(state.sel, !anyLocked(state.sel));
    return;
  }
  // image cards have no title/body UI to rename or edit — they're a leaf that shows only the image
  if (key === 'F2' && state.selId){
    e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return;   // selId guards non-null
  }
  if (key === 'e' && !mod && state.selId){
    e.preventDefault(); const n = state.nodes.get(state.selId); if (n) startBodyEdit(n); return;
  }
  if (key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  // Tab puts a new card INSIDE the selected frame — the one thing that has an inside.
  if (key === 'Tab' && state.selId){ e.preventDefault(); if (state.nodes.get(state.selId)?.type === 'frame') addCardInside(state.selId); return; }
  if (del && state.selEdges.size){ e.preventDefault(); deleteSelectedEdge(); return; }
  // ⌘L connects the selected cards (MindNode's shortcut for the same thing). Bare `l` is lock.
  if (key === 'l' && mod && state.sel.size){ e.preventDefault(); connectSelection(); return; }
  if (del && state.sel.size){
    e.preventDefault();
    // ⌥Delete keeps the children, promoting them to the deleted card's parent.
    if (e.altKey) deleteSelectionKeepChildren(); else deleteSelection();
  }
});
// Track the mouse so keyboard/clipboard actions (Space-tap, paste) land AT the pointer.
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') ui.lastMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  const wasPan = ui.spaceUsedForPan;
  ui.spaceHeld = false; ui.spaceUsedForPan = false;
  if (isTypingInField() || wasPan || ui.pan) return;
  // A Space TAP on a lone IMAGE card opens it full-screen — the picture is the whole card, so "look at
  // this properly" is the obvious thing the key can mean there, and the viewer closes on Space too
  // (features/image-viewer.ts). Everything else Space used to do on release (making a card) is `N` now.
  const sole = state.sel.size === 1 && state.selId ? state.nodes.get(state.selId) : null;
  if (sole && isImageCard(sole)) openImageAt(sole, sole.el?.querySelector('img.md-img') ?? null);
});

// Ghost-card drag: grab the corner card to spawn a new note that rides the cursor through the same
// move/drop machinery as dragging an existing card — so the guides and the drop-into-a-frame rule
// behave identically. Releasing back on the ghost cancels.
{
  const ghost = byId('ghostCard');
  let newNode: MindNode | null = null;

  // Move/up are handled on `window`, not the ghost, so the drop commits no matter where the pointer
  // is released or whether pointer-capture survived the mid-drag re-renders (a lost capture used to
  // deliver pointerup to the card underneath, whose handler ignores it — leaving the ghost stuck and
  // nothing created). setPointerCapture is still requested (best-effort) so the dragged card's own
  // handlers stay quiet; capture events bubble to window regardless.
  function endGhostDrag(): MindNode | null {
    const n = newNode;
    newNode = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    return n;
  }
  function onMove(e: PointerEvent): void { if (newNode) feedDragMove(e.clientX, e.clientY); }
  function onUp(e: PointerEvent): void {
    const n = endGhostDrag();
    if (!n) return;
    // released back on the ghost card itself -> cancel: discard the new card, create nothing
    const r = ghost.getBoundingClientRect();
    const onGhost = e.clientX >= r.left && e.clientX <= r.right &&
                    e.clientY >= r.top  && e.clientY <= r.bottom;
    if (onGhost) { abortDrag(); deleteNode(n.id); commitStep(); return; }   // nets null→null, discarded
    commitDrag();                          // land / reparent exactly where the preview showed
    startInlineEdit(n, { isNew: true });   // drop straight into renaming; Esc cancels creation
  }
  function onCancel(): void {
    const n = endGhostDrag();
    if (n) { abortDrag(); deleteNode(n.id); commitStep(); }   // nets null→null, discarded
  }

  ghost.addEventListener('pointerdown', (e: PointerEvent) => {
    if (state.readOnly) return;
    e.preventDefault();
    endInPlaceEdit();                       // grabbing the ghost commits any in-progress edit
    // anchor the new card at the grab offset within the ghost (i.e. the ghost's own top-left in
    // world space), then drive it with the real drag so it rides the cursor at that same offset
    const r = ghost.getBoundingClientRect();
    const w = screenToWorld(r.left, r.top);
    newNode = createDetachedNode(w.x, w.y) ?? null;
    if (!newNode) return;
    try { ghost.setPointerCapture(e.pointerId); } catch { /* no active pointer (e.g. synthetic) */ }
    startNodeDrag(newNode, e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });
}
byId('homeBtn').onclick = showStart;   // icon + folder name → home screen

// (rename/duplicate/export/delete on-screen actions now live in the floating bar's kebab menu —
// features/float-bar.ts)

// ---------- the ⌘P command palette's list ----------
// Every action the app has, with the shortcut that does the same — built here because every action
// function is in scope here. `when` hides what can't apply right now (features/palette.ts).
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl ';
const editable = (): boolean => !state.readOnly && store.isOpen;
const hasSel = (): boolean => state.sel.size > 0 && editable();
const oneSel = (): MindNode | undefined => state.sel.size === 1 && state.selId ? state.nodes.get(state.selId) : undefined;
function paletteCommands(): Command[] {
  return [
    { label: 'New card', shortcut: 'N', keywords: 'add create note', when: editable, run: newCardAtPointer },
    { label: 'Find…', shortcut: MOD + 'F', keywords: 'search filter tags card', run: () => openSearch() },
    { label: trayOpen() ? 'Hide the tag tray' : 'Show the tag tray', shortcut: 'T', keywords: 'tags stickers emoji', run: () => toggleTray() },
    { label: 'Undo', shortcut: MOD + 'Z', when: editable, run: undo },
    { label: 'Redo', shortcut: '⇧' + MOD + 'Z', when: editable, run: redo },
    { label: state.selId ? 'Focus the selection' : 'Fit the map to the screen', shortcut: 'F', keywords: 'zoom view', run: focusOrFit },
    { label: 'Zoom in', shortcut: MOD + '+', run: () => zoomAt(window.innerWidth/2, window.innerHeight/2, 1.2) },
    { label: 'Zoom out', shortcut: MOD + '−', run: () => zoomAt(window.innerWidth/2, window.innerHeight/2, 1/1.2) },
    { label: 'Select all', shortcut: MOD + 'A', run: selectAll },
    { label: 'Edit the note', shortcut: 'E', when: () => editable() && !!oneSel(), run: () => { const n = oneSel(); if (n) startBodyEdit(n); } },
    { label: 'Add a card inside the frame', shortcut: 'Tab', keywords: 'child', when: () => editable() && oneSel()?.type === 'frame', run: () => addCardInside(state.selId!) },
    { label: 'New frame', keywords: 'group box section', when: editable, run: newFrameAtPointer },
    { label: 'Inbox', keywords: 'phone capture new notes icloud', when: () => !!inboxFrame() || editable(), run: goToInbox },
    { label: 'Add a card after', shortcut: 'Enter', keywords: 'sibling', when: () => editable() && !!oneSel(), run: () => createSibling(state.selId!) },
    { label: 'Open', shortcut: '↑', keywords: 'enter frame', when: () => canEnter(oneSel()), run: () => openFrame(oneSel()) },
    { label: 'Connect the selected cards', shortcut: MOD + 'L', keywords: 'line edge arrow link', when: () => hasSel() && state.sel.size > 1, run: connectSelection },
    { label: 'Group into a frame', shortcut: 'G', when: hasSel, run: groupSelectionIntoFrame },
    { label: 'Duplicate', shortcut: 'D', keywords: 'copy', when: hasSel, run: () => duplicateSelection() },
    { label: 'Duplicate as the next one', shortcut: '⇧D', keywords: 'copy smart series next day date increment log', when: hasSel, run: () => duplicateSelection({ next: true }) },
    { label: 'Tag…', shortcut: '#', keywords: 'tags emoji label obsidian', when: () => editable() && taggableSelection().length > 0, run: openTagPicker },
    { label: 'Fold / unfold', shortcut: 'X', keywords: 'collapse expand', when: () => state.sel.size > 0, run: () => toggleCollapseSelection(state.sel) },
    ...TIDY_ACTIONS.map(a => ({ label: a.label, shortcut: a.shortcut || undefined, keywords: 'tidy align arrange distribute layout',
      when: () => !state.readOnly && state.sel.size >= (a.min ?? 2), run: a.run })),
    { label: 'Collapse all', keywords: 'fold every card frame', when: () => foldScope().some(n => !n.collapsed), run: () => setCollapsedSelection(foldScope().map(n => n.id), true) },
    { label: 'Expand all', keywords: 'unfold every card frame', when: () => foldScope().some(n => n.collapsed), run: expandAll },
    { label: anyLocked(state.sel) ? 'Unlock' : 'Lock', shortcut: 'L', when: hasSel, run: () => setLockedSelection(state.sel, !anyLocked(state.sel)) },
    { label: 'Delete', shortcut: '⌫', keywords: 'remove', when: hasSel, run: deleteSelection },
    { label: state.readOnly ? 'Edit again (leave read-only)' : 'Read-only mode', shortcut: 'R', keywords: 'lock view', run: () => setReadOnly(!state.readOnly) },
    { label: 'Background grid…', keywords: 'dots lines snap', run: openGridMenu },
    { label: 'Canvas colour…', keywords: 'background', when: () => !state.readOnly, run: () => byId('canvasColorBtn').click() },
    { label: 'Your maps…', keywords: 'home open folder switch', run: showStart },
    { label: 'Export the map as .zip', keywords: 'backup download', when: () => store.isOpen, run: () => { void exportZip(); } },
  ];
}
setPaletteSource(paletteCommands);
byId('paletteBtn').title = `Actions (${MOD.trim() === '⌘' ? '⌘P' : 'Ctrl+P'})`;
byId('paletteBtn').onclick = (e) => { e.stopPropagation(); if (paletteOpen()) closePalette(); else openPalette(); };

// keyboard shortcuts: ⌘S force-save, ⌘A select-all, ⌘Z/⇧⌘Z/⌘Y undo-redo  (duplicate = D, new node = Space)
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); flushSave(); return; }
  // ⌘P is FigJam's quick actions. Never the browser's print dialog, even while typing in a card.
  if (k === 'p') { e.preventDefault(); if (!isTypingInField()) openPalette(); return; }
  // While typing, ⌘A belongs to the field.
  if (k === 'a' && !isTypingInField()) { e.preventDefault(); selectAll(); return; }
  // While typing in a field, leave ⌘Z to the browser's native undo inside that editor.
  if (k === 'z' && !isTypingInField()) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (k === 'y' && !isTypingInField()) { e.preventDefault(); redo(); }
});


installEdgeTools();   // socket / handle / edge-hit grabs, claimed ahead of card-drag and canvas-pan
installPeek();        // hover a folded card to read it (features/peek.ts)

boot();   // local-first: open straight into the last map
