// The render + selection core. The interactive subsystems (drag / inline-edit / crud / gestures /
// attachments) live in features/ and share live state via the `ui` holder; this file owns the
// render pipeline (paintNode/paintAll/paintEdges), selection + edit-panel, read-only mode, focus,
// and the global keyboard/toolbar wiring. It exports the render kernels the feature modules call
// back into. Fully strict-typed and covered by `npm run typecheck`.
/* ============================================================
   Markdown Mindmap — PoC v2: hierarchy + collapse + add-child
   Storage: one .md per node. Layout lives in each note's frontmatter as mm_* keys
   (mm_parent = parent note's path, mm_x/mm_y, mm_collapsed) — no sidecar, no ids on disk.
   The filename IS the node's identity; in-memory ids are ephemeral, minted per load.
   Edges are DERIVED from parent — no separate edge list.
   ============================================================ */

import './styles.css';   // app styles (Vite bundles + singlefile inlines into dist/index.html)
import { renderBodyHTML, esc } from './utils/markdown.js';
import { inkFor, scrimFor, isHexColor } from './utils/ink.js';
import { childrenOf, isHidden, rootsInOrder, descendantCount, hasLockedAncestor, isLockedEffective, subtreeHasLocked } from './utils/model.js';
import { state, world, dragLayer, stage, setStatus, isImageCard, isAnnotation, isQueryCard } from './core/state.js';
import { setupTheme } from './view/theme.js';
import { setupGrid } from './view/grid.js';
import { mountIcons, FOLDER_PATH } from './view/icons.js';
import edgeStraightIcon from './assets/icons/edge-straight.svg?raw';
import edgeOrthogonalIcon from './assets/icons/edge-orthogonal.svg?raw';
import edgeBezierIcon from './assets/icons/edge-bezier.svg?raw';
import { zoomAt, frameBox, revealInView, screenToWorld } from './view/camera.js';
import { applyLayouts, hostFrame, frameInterior, frameFlow, isStack, isFrame, isContainer, stackRowW, isTabsFrame, isDockedTab, tabGroupOf, tabsOf, activeTab, tabStripRect, normalizeTabs, orderedKids, actionTarget } from './view/layout.js';
import { paintEdges } from './view/edges.js';
import './features/gestures.js';   // registers the canvas pan/zoom/marquee gesture listeners
import './features/attachments.js';   // registers the OS image drag/drop listeners
import { openMenu } from './features/context-menu.js';   // also registers the custom right-click menu on the canvas
import { startInlineEdit, startBodyEdit, endInlineEdit, endBodyEdit, onInlineInput, onInlineKeydown } from './features/inline-edit.js';
import { createNode, createDetachedNode, createAnnotationHere, createSibling, addChild, duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, centredAt, NEW_CARD_H } from './features/crud.js';
import { bindNodeDrag, startNodeDrag, feedDragMove, commitDrag, abortDrag } from './features/drag.js';   // also registers the Alt/Shift drag-modifier listeners
import { openSearch } from './features/search.js';
import { renderOutline, toggleOutlineView, outlineActive } from './features/outline.js';   // also wires the outline toggle button
import { refreshSwatches } from './features/properties.js';
import { syncFloatBar, autoSizeSelection, groupSelectionIntoFrame } from './features/float-bar.js';   // also registers the float bar's own listeners
import { copySelection, cutSelection, bindCardFileDrag } from './features/clipboard.js';
import { toggleSketchMode } from './features/sketch.js';   // also registers the sketch toolbar wiring
import { bindCardTagPills, tagPillHTML } from './features/tags.js';
import { commitStep, record, touch, undo, redo, updateUndoButtons } from './features/history.js';
import { resetImageCache, hydrateImages } from './features/images.js';
import { openImageViewer } from './features/image-viewer.js';
import { store, scheduleSave, flushSave, loadFromDir } from './data/persistence.js';
import { showStart, openHelpTab, boot } from './boot.js';
import { syncUrl, scheduleUrlSync, updateDocumentTitle } from './nav/url-state.js';
import type { MindNode, EdgeStyle } from './core/state.js';
import { ui, isTypingInField, type Pt, type Drag } from './core/ui-state.js';

declare global {
  interface Window { __dbg: { readonly state: typeof state; readonly drag: Drag | null }; }
}

// The DOM shell (index.html) is fixed, so these elements always exist — assert non-null.
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

window.__dbg = { get state(){ return state; }, get drag(){ return ui.drag; } };   // TEMP debug hook

mountIcons();                         // fill [data-icon] placeholders with their SVG assets
setupTheme();
setupGrid();




// ---------- rendering ----------
// small closed-padlock badge shown at a locked card's upper-left corner; exported for the outline
// row (features/outline.ts), the float bar's lock toggle (features/float-bar.ts) and the read-only
// toolbar button (applyReadOnly, further down) — all four share this one glyph.
export const LOCK_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
// magnifier glyph shown in front of a query card's title; tapping it reveals the query-input in
// the title's place (see the query-icon click handler + endQueryEdit below).
const QUERY_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><path d="M20 20l-5-5"/></svg>`;
// line-smiley glyph for the card's own "add emoji tag" button (bottom-left, next to .addnote) —
// same hand-drawn-icon style (stroke=currentColor) as LOCK_BADGE_SVG/QUERY_ICON_SVG above.
const TAG_ADD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="10" x2="9.01" y2="10"/><line x1="15" y1="10" x2="15.01" y2="10"/><path d="M8 14.5a4.5 4.5 0 0 0 8 0"/></svg>`;
// writing-pen glyph for the "add a note" button — bottom-left corner (mirrors the tag row's own
// add-emoji button living at the bottom-RIGHT, see the tag-row comment further down), now that
// .addnote is a small icon button rather than a wide "Add note…" text pill.
const NOTE_ADD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4a2.4 2.4 0 1 1 3.4 3.4L7.8 19 4 20l1-3.8Z"/><path d="M4 21.5h14"/></svg>`;
// The two faces of the corner bubble (.hidden-count), which is also the fold BUTTON:
//   folded   → "+5" — the + marks it as the expand control, the number is what's tucked underneath
//              (a bare "+" when that's only a body).
//   expanded → a down chevron ("push this in"), which reads as a control far better than a "−"
//              would at 16px, and can't be mistaken for the count's own typography.
// BOTH live in the button permanently — the count in its own `.cnt` span, the chevron beside it — and
// `data-chip` shows one and hides the other (styles.css). That's what keeps paintNode off the chip's
// innerHTML: re-parsing this <svg> for every foldable node on every paint is real work, and paintAll
// runs per animation FRAME for the length of a resize drag.
const FOLD_PLUS = '+';
// exported: the outliner's rows carry the very same bubble (features/outline.ts), so the chevron is
// drawn from one glyph rather than two that could drift apart.
export const FOLD_CHIP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"/></svg>`;
// Closed-folder glyph in front of a FOLDED tab group's title (revealed by `.tabs-fold`, styles.css —
// see foldedTab below). The pill's label is its OPEN TAB's title, so the icon is the only thing that
// tells "a folder holding tabs" from a plain folded frame; it replaces the old, wordier way of saying
// so — the minted group title used to be suffixed "… tabs", which the pill then read out. Baked into
// nodeEl like the chip's chevron, for the same reason: paintNode never touches this <svg>.
// Same shape as the frame kind/layout chips, from the one path they share (FOLDER_PATH).
const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FOLDER_PATH}</svg>`;
function nodeEl(n: MindNode): HTMLElement {
  if (n.el) return n.el;
  const el = document.createElement('div');
  el.dataset.id = n.id;
  // The fold chip lives INSIDE .title-row, and that placement is load-bearing: it makes the chip hang
  // off whatever element carries the title. For a card the row is in flow (so the chip resolves
  // against the card, as it always did), but a FRAME's row is its absolutely-positioned title TAB —
  // so the chip lands on the tab's own corner rather than 43px lower on the box, and a docked tab
  // (whose label IS the element) gets it in the same spot. Being out of flow, it never disturbs the
  // row's flex layout. Hence the `> .title-row >` in every .hidden-count selector in styles.css.
  el.innerHTML = `<div class="title-row"><input type="checkbox" class="donebox" title="Mark done"><span class="query-icon" title="Search">${QUERY_ICON_SVG}</span><span class="folder-icon">${FOLDER_SVG}</span><div class="title"></div><input type="text" class="query-input" placeholder="Search…" autocomplete="off"><span class="progress"></span><button type="button" class="hidden-count"><span class="cnt"></span>${FOLD_CHIP_SVG}</button></div><div class="body"></div>
    <div class="tag-row"></div>
    <div class="query-box">
      <div class="query-results"></div>
    </div>
    <span class="lock-badge" title="Locked">${LOCK_BADGE_SVG}</span>
    <button type="button" class="addnote" title="Add note" aria-label="Add note">${NOTE_ADD_SVG}</button>`;
  world.appendChild(el);
  n.el = el;
  bindNodeDrag(n);
  bindCardFileDrag(n);   // ⌥-drag out of the window = save as .md file(s)
  const addnote = el.querySelector('.addnote')!;
  addnote.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  addnote.addEventListener('click', (e)=>{ e.stopPropagation(); startBodyEdit(n); });
  // the corner bubble is a real fold/unfold button (single click), not just a badge: stop the
  // pointerdown so bindNodeDrag's el-level handler never starts a drag/select. Clicking the chip of
  // a card that's part of a MULTI-selection folds the whole selection (matching X, and matching the
  // fact that every selected card shows its own chip) — the chip never reduces the selection first.
  const foldChip = el.querySelector(':scope > .title-row > .hidden-count')!;
  foldChip.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
  foldChip.addEventListener('click', (e)=>{
    e.stopPropagation();
    const t = chipTarget(n);
    if (t !== n) toggleCollapse(t.id);   // a tab's chip folds its GROUP (chipTarget)
    else if (state.sel.size > 1 && state.sel.has(n.id)) toggleCollapseSelection(state.sel);
    else toggleCollapse(n.id);
  });
  const bodyEl = el.querySelector('.body')!;
  // body links: open externally, or jump to a wikilink's node. Don't let the click bubble to
  // the card (which would select / toggle the panel); pointerdown is stopped in bindNodeDrag.
  bodyEl.addEventListener('click', (e)=>{
    const zoom = (e.target as HTMLElement).closest('.img-zoom') as HTMLElement | null;
    if (zoom){
      e.stopPropagation();
      const img = zoom.closest('.img-wrap')?.querySelector('img.md-img') as HTMLImageElement | null;
      if (img && img.src && !img.classList.contains('md-img-missing')) openImageViewer(img.src, img.alt);
      return;
    }
    const a = (e.target as HTMLElement).closest('a.lk') as HTMLElement | null; if (!a) return;
    e.stopPropagation();
    if (a.classList.contains('wikilink')){
      e.preventDefault();
      focusByTitle(a.dataset.target ?? '');
    }
  });
  // task checkboxes: toggle the matching [ ]/[x] in the body and persist
  bodyEl.addEventListener('change', (e)=>{
    const cb = (e.target as HTMLElement).closest('input.taskbox') as HTMLInputElement | null; if (!cb) return;
    e.stopPropagation();
    toggleTask(n, +(cb.dataset.ti ?? 0));
  });
  // query card: a magnifier icon in front of the title toggles the query-input in the title's
  // place (see queryMatches/renderQueryResults below); confirming (Enter/blur) or Escape hides it
  // again and shows the title. pointerdown/click are stopped so typing/clicking never starts a
  // card drag or selects-through.
  const titleRow = el.querySelector('.title-row') as HTMLElement;
  const queryIcon = el.querySelector('.query-icon')!;
  queryIcon.addEventListener('pointerdown', (e) => e.stopPropagation());
  queryIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    if (titleRow.classList.contains('query-editing')) { queryInput.blur(); }
    else startQueryEdit(n);
  });
  const queryInput = el.querySelector('.query-input') as HTMLInputElement;
  queryInput.addEventListener('pointerdown', (e) => e.stopPropagation());
  queryInput.addEventListener('click', (e) => e.stopPropagation());
  queryInput.addEventListener('focus', () => {
    if (!ui.queryEdit || ui.queryEdit.id !== n.id) { touch(n.id); ui.queryEdit = { id: n.id, orig: n.query ?? '' }; }
    titleRow.classList.add('query-editing');
  });
  queryInput.addEventListener('input', () => onQueryInput(n, queryInput.value));
  queryInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') queryInput.blur(); });
  queryInput.addEventListener('blur', () => endQueryEdit(n));
  // result cards: a plain click selects + centers the matched node on the canvas (these are compact
  // rows you read and act on, not canvas cards you drag); the "⋮" opens a small actions menu; the
  // done checkbox (checklist items only) toggles independent of either.
  const queryResultsEl = el.querySelector('.query-results')!;
  queryResultsEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  queryResultsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest('.query-item') as HTMLElement | null; if (!item) return;
    e.stopPropagation();
    const m = state.nodes.get(item.dataset.id!); if (!m) return;
    const more = target.closest('.qi-more') as HTMLElement | null;
    if (more) { const r = more.getBoundingClientRect(); openQueryItemMenu(m, r.left, r.bottom + 4); return; }
    if (target.closest('.qi-done')) return;   // handled by the change listener below
    selectNode(m.id); focusNode(m, true);
  });
  queryResultsEl.addEventListener('change', (e) => {
    const cb = (e.target as HTMLElement).closest('.qi-done') as HTMLInputElement | null; if (!cb) return;
    e.stopPropagation();
    const item = cb.closest('.query-item') as HTMLElement;
    const m = state.nodes.get(item.dataset.id!); if (m) toggleDone(m);
  });
  // done checkbox (title-only cards): toggle the card-level done mark, independent of drag/select
  const doneEl = el.querySelector('.donebox') as HTMLInputElement;
  doneEl.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); if (isLockedEffective(n)) e.preventDefault(); });
  doneEl.addEventListener('click', (e)=>{ e.stopPropagation(); });
  doneEl.addEventListener('change', (e)=>{ e.stopPropagation(); toggleDone(n); });
  // inline title rename: typing reflows + validates; Enter/Tab commit, Escape cancels, blur commits
  const titleEl = el.querySelector('.title') as HTMLElement;
  titleEl.addEventListener('input',   ()  => onInlineInput(n));
  titleEl.addEventListener('keydown', (e) => onInlineKeydown(e as KeyboardEvent, n));
  titleEl.addEventListener('blur',    ()  => { if (ui.inlineEdit && ui.inlineEdit.id === n.id) endInlineEdit(); });
  // Double-click OPENS the node — rename / edit its note / add a card inside it, dispatched by what
  // was hit (activateNode). Folding lives on the corner chip above.
  el.addEventListener('dblclick', (e)=>{
    // The INNERMOST card owns the gesture, whether or not it acts on it — child cards are DOM-nested,
    // so anything this handler DECLINES still bubbles to its host card, which reads it as a
    // double-click on itself. Hence the stopPropagation ahead of the two bails rather than after
    // them: double-clicking a word inside an open title editor (the ordinary way to fix one word of
    // a name) reached the host and opened the HOST's note editor, which closed the rename and sent
    // the rest of the typing into the parent's body. Same for a word inside an open body editor, and
    // for a double-click on a nested card's own controls. A container's children are NOT nested (they
    // live in its sibling .frame-content / .tab-strip wrapper), so this is about plain cards.
    e.stopPropagation();
    // while editing this card's title or body, a double-click selects a word — don't take it over
    if ((ui.inlineEdit && ui.inlineEdit.id === n.id) || (ui.bodyEdit && ui.bodyEdit.id === n.id)) return;
    if (isNodeControlAt(e.clientX, e.clientY)) return;   // the card's own buttons keep their click
    e.preventDefault();
    activateNode(n, e.clientX, e.clientY);
  });
  return el;
}
// A node's own controls — each already acts on a single click, so a double one must not also be read
// as "open this card". `.fh` is a resize handle; the rest are the card's buttons, links and inputs.
const NODE_CONTROLS = '.hidden-count, .donebox, .taskbox, .addnote, .lock-badge, .query-icon, .query-input, .query-box, .tag-row, .img-zoom, a.lk, .fh';
// What a gesture at these viewport coords actually hits. Deliberately NOT the event's own `target`:
// bindNodeDrag takes a POINTER CAPTURE on the node's element, and a capture retargets the click (and
// so the dblclick) that follows to the capturing element — so by the time a double-click arrives its
// `target` is always the whole `.node` and can no longer tell a title from a body. Hit-testing the
// point is the only reading of "what did they double-click" that survives the capture.
const hitAt = (cx: number, cy: number): Element | null => document.elementFromPoint(cx, cy);
export const isNodeControlAt = (cx: number, cy: number): boolean => !!hitAt(cx, cy)?.closest(NODE_CONTROLS);
// ---------- double-click / double-tap = OPEN this node ----------
// Folding moved to the corner chip (see the .hidden-count button above), which freed the gesture for
// what a double-click means nearly everywhere else: open the thing for editing. What it opens is
// decided by WHAT WAS HIT, so one gesture covers every kind:
//   · the title (a card's title row, a frame's folder tab)  → rename in place
//   · anywhere else on a card                               → edit its note
//   · a container's empty interior                          → put a new card THERE
// A container has no body of its own to edit, so its interior falls to the third case — the same
// "double-click empty space to make a card" as on the canvas (features/gestures.ts), one level in.
// A FOLDED node is nothing but its title (its body is display:none), so every hit on it renames —
// otherwise a double-click would open an editor inside a hidden .body.
// Shared by nodeEl's dblclick and the touch double-tap in features/drag.ts.
export function activateNode(n: MindNode, cx: number, cy: number): void {
  // Read-only (the help map, or a map the user has locked down): there is nothing to open, so the
  // gesture keeps its old meaning — fold/unfold, the one thing this mode still allows. Browsing a
  // read-only map is all expanding, so leaving the double-click inert there would just cost a gesture.
  if (state.readOnly) { toggleCollapse(n.id); return; }
  // `parentElement === n.el` keeps it to this node's OWN row: .title-row is always a direct child, so
  // a hit inside a DOM-nested child card can't be read as a hit on its host's title.
  const onTitle = hitAt(cx, cy)?.closest('.title-row')?.parentElement === n.el;
  // startInlineEdit is the single rename funnel: it redirects a tab group to its open tab, an
  // annotation to its body and a query card to its query, and refuses a locked node.
  if (onTitle || n.collapsed) { startInlineEdit(n); return; }
  if (isContainer(n)) { addChildIn(n, cx, cy); return; }
  if (isImageCard(n) || isQueryCard(n)) return;   // no note to edit; only their title is editable
  startBodyEdit(n);
}
// Add a card inside a container at the double-clicked point. A stack is an OUTLINER — the point
// means nothing there, the row just appends — and a flow/tabs frame re-places its children anyway,
// so the point only really lands in a free frame. Clamped into the interior so a card double-clicked
// near an edge doesn't hang half out of the box it was aimed at. addChild does the rest: it routes a
// tab group to its open tab (contentParent), refuses a locked parent, and reveals a folded one.
function addChildIn(n: MindNode, cx: number, cy: number): void {
  if (isStack(n)) { addChild(n.id); return; }
  const PAD = 8;
  const box = frameInterior(n);
  const p = centredAt(screenToWorld(cx, cy));   // the same "new card HERE" centring the canvas uses
  const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  addChild(n.id, {
    x: cl(p.x, box.x + PAD, box.x + box.w - NODE_W - PAD),
    y: cl(p.y, box.y + PAD, box.y + box.h - NEW_CARD_H - PAD),
  });
}
// A card's colour is its own, or — if unset — inherited from the nearest coloured ancestor. While
// dragging, preview what that inherited colour is ABOUT TO become, so it doesn't wait for the
// drop to update:
//  - Alt-dragging, or pulled past the rip threshold, to detach: treat the dragged node as a root
//    (stop the ancestor walk there) — mirrors the actual detach condition in dragPointerUp.
//  - Poised over a valid reparent target: continue the walk from the NEW parent instead of the
//    real (about-to-change) one — a sibling-mode drop adopts the target's own parent.
// Either way this only redirects the walk once it reaches the actively dragged node, so the whole
// dragged subtree's inheriting descendants preview correctly too (their own walk passes through it).
// An inheriting card with no coloured ancestor (a root left on the default "inherit") falls back
// to grey, so it gets the same neutral card bg as an explicit grey rather than going transparent.
// Explicit 'none' still short-circuits below (it's truthy), so "no colour" stays transparent.
export function effectiveColor(n: MindNode): string {
  // An annotation never inherits a background — only its OWN colour counts (drives its dotted
  // connector + the anchor dot on its parent); with none ('inherit') it takes the THEME'S CONTRAST
  // colour — white on the dark canvas, black on the light one — so it always stands out on top.
  if (isAnnotation(n)) return n.color || (document.body.classList.contains('light') ? 'black' : 'white');
  // A tab GROUP's box belongs to whichever tab is OPEN, so it takes that tab's colour — switching tabs
  // re-tints the box (and its border, its incoming edge and its outline swatch, which all read from
  // here). Unconditionally, since from the user's side there IS no group to have a colour of its own; a
  // colour authored on the group still shows through, because the walk continues from the tab THROUGH
  // the group, so it stands in for any tab that inherits.
  if (isTabsFrame(n) && !n.collapsed) n = activeTab(n) ?? n;
  const drag = ui.drag;
  let previewId: string | null = null;
  let previewParent: MindNode | null | undefined;
  if (drag && !drag.shift && (drag.alt || drag.rip)) { previewId = drag.active.id; previewParent = null; }
  // …and never substitute the dragged card for its OWN parent: the walk below would then never leave
  // it and would spin forever. A drop target that IS the dragged card is a no-op drop anyway (drag.ts
  // rules it out), so there's nothing to preview.
  else if (drag && drag.dropTarget && drag.dropTarget !== drag.active.id) {
    previewId = drag.active.id;
    const tgt = state.nodes.get(drag.dropTarget);
    previewParent = drag.dropMode === 'sibling' ? (tgt?.parent ? state.nodes.get(tgt.parent) : null) : tgt;
    if (previewParent?.id === previewId) previewParent = null;
  }
  // `guard`, like effectiveLayout's: a chain is only as trustworthy as the data behind it, and this
  // runs on every paint of every card — a cycle must degrade to a fallback colour, not hang the tab.
  let guard = 0;
  for (let c: MindNode | null | undefined = n; c && guard++ < 4096; c = (c.id === previewId) ? previewParent : (c.parent ? state.nodes.get(c.parent) : null))
    if (c.color) return c.color;
  // light theme: the neutral fallback card reads better as white than as the dark-grey card
  return document.body.classList.contains('light') ? 'white' : 'grey';
}
// A card shows a done checkbox only if its PARENT has `checklist` on — Trello-style: the
// setting lives on the parent ("treat my children as a checklist"), not on the item itself, and
// doesn't cascade past that one level (a checklist item can run its own checklist for its kids).
function showsDoneCheckbox(n: MindNode): boolean {
  const p = n.parent ? state.nodes.get(n.parent) : undefined;
  return !!(p && p.checklist);
}
// true if ANY ancestor (at any depth, not just the direct parent) has a title containing `needle`
// (already lowercased) — backs the "p:<parent>" query token below.
function hasAncestorTitleContaining(n: MindNode, needle: string): boolean {
  for (let p = n.parent ? state.nodes.get(n.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    if (p.title.toLowerCase().includes(needle)) return true;
  return false;
}
// ---------- query card: search field + scrollable results list ----------
// Opens the query field for editing: swaps the title's live query-text display for the
// `.query-input` in place. Called by the card's own magnifier-icon click, and — since a
// query card has no renamable title of its own — by startInlineEdit's redirect
// (features/inline-edit.ts) whenever a rename would otherwise have been triggered (slow
// click on the title, F2, context-menu "Rename").
export function startQueryEdit(n: MindNode): void {
  if (!n.el) return;
  const titleRow = n.el.querySelector('.title-row') as HTMLElement;
  const queryInput = n.el.querySelector('.query-input') as HTMLInputElement;
  if (!ui.queryEdit || ui.queryEdit.id !== n.id) { touch(n.id); ui.queryEdit = { id: n.id, orig: n.query ?? '' }; }
  titleRow.classList.add('query-editing');
  queryInput.focus(); queryInput.select();
}
// Matches every OTHER node's title OR body against the query card's own search text — the same
// substring rule the toolbar find box uses (features/search.ts runSearch), but uncapped (the
// results list scrolls) and scoped to this one card's #query-results element, not the whole canvas.
// A "p:<parent>" token (whitespace-delimited, repeatable) filters to nodes with an ancestor whose
// title contains <parent>; a "t:<tag>" token (also repeatable) filters to nodes with an EXACT
// (case-insensitive) tag match. Both are ANDed with each other, with any remaining plain search
// text, and with any other tokens of their own kind — all case-insensitive.
function queryMatches(n: MindNode): MindNode[] {
  const raw = (n.query ?? '').trim();
  if (!raw) return [];
  const parentTerms: string[] = [];
  const tagTerms: string[] = [];
  const textTerms: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    const pm = /^p:(.+)$/i.exec(tok);
    const tm = /^t:(.+)$/i.exec(tok);
    if (pm) parentTerms.push(pm[1].toLowerCase());
    else if (tm) tagTerms.push(tm[1].toLowerCase());
    else textTerms.push(tok.toLowerCase());
  }
  const text = textTerms.join(' ');
  const hits = [...state.nodes.values()].filter(m => m.id !== n.id && !isAnnotation(m) && !isQueryCard(m) &&
    parentTerms.every(pt => hasAncestorTitleContaining(m, pt)) &&
    tagTerms.every(tt => m.tags.some(t => t.toLowerCase() === tt)) &&
    (!text || m.title.toLowerCase().includes(text) || (m.body && m.body.toLowerCase().includes(text))));
  return hits.sort((a, b) => {
    const at = a.title.toLowerCase().includes(text), bt = b.title.toLowerCase().includes(text);
    return at !== bt ? (at ? -1 : 1) : a.title.localeCompare(b.title);
  });
}
function renderQueryResults(n: MindNode): void {
  const el = n.el?.querySelector('.query-results') as HTMLElement | null; if (!el) return;
  const hits = queryMatches(n);
  // Rebuilding on every repaint (paintAll runs on every selection change, incl. clicking a result)
  // would replace the .query-item elements mid-click — a real mouse's SECOND click of a double-click
  // then lands on a freshly-minted element, and the browser never recognises it as the same target,
  // so dblclick silently stops firing. Key the cache on the ids actually shown (not the raw query
  // text) so a result set that hasn't changed keeps its DOM identity across an unrelated repaint.
  const hasQuery = !!(n.query ?? '').trim();
  // Keyed on more than just the id set: a matched note's colour/lock/done/title can change without
  // the SET of matches changing (e.g. recolouring a hit from elsewhere on the canvas) — fold those
  // into the key too so the result cards refresh live, not just when the match set itself changes.
  const key = !hasQuery ? '' : hits.length
    ? hits.map(m => `${m.id}:${effectiveColor(m)}:${m.locked ? 1 : 0}:${m.done ? 1 : 0}:${m.title}`).join(',')
    : 'none';
  if (el.dataset.queryKey === key) return;
  el.dataset.queryKey = key;
  el.innerHTML = !hasQuery
    ? ''
    : hits.length
      ? hits.map(m => queryItemHTML(m)).join('')
      : '<div class="query-empty">No matches</div>';
}
// One matched note, rendered as a small card (colour, lock badge, checklist done box, title) —
// the outline's `.ol-row` in miniature, minus drag-to-reorder (these are search hits, not
// siblings). The "⋮" opens a menu with the same actions the outline row's own ⋯ menu offers.
function queryItemHTML(m: MindNode): string {
  const done = showsDoneCheckbox(m);
  const col = effectiveColor(m);
  return `<div class="query-item ${colorClass(col)}${done && m.done ? ' done' : ''}" style="${colorVars(col)}" data-id="${m.id}">
    ${m.locked ? `<span class="qi-lock" title="Locked">${LOCK_BADGE_SVG}</span>` : ''}
    ${done ? `<input type="checkbox" class="qi-done" ${m.done ? 'checked' : ''} title="Mark done">` : ''}
    <span class="qi-title">${esc(m.title)}</span>
    <button type="button" class="qi-more" title="Card actions" aria-label="Actions for “${esc(m.title)}”">⋮</button>
  </div>`;
}
function openQueryItemMenu(m: MindNode, x: number, y: number): void {
  const locked = isLockedEffective(m);
  openMenu([
    { label: 'Rename', run: () => startInlineEdit(m), disabled: locked },
    { label: 'Duplicate', run: () => { selectNode(m.id); duplicateSelection({ edit: false }); } },
    { label: locked ? 'Unlock' : 'Lock', run: () => setLockedSelection([m.id], !locked) },
    { label: 'Delete', run: () => deleteNode(m.id), danger: true, disabled: subtreeHasLocked(m.id) },
  ], x, y);
}
// Debounced per-card: recomputing the results list on every keystroke is cheap here (no dropdown/
// highlight side effects like the toolbar search), but still worth coalescing on a fast typist.
const queryDebounce = new Map<string, number>();
function onQueryInput(n: MindNode, value: string): void {
  n.query = value; n.dirty = true;
  const pending = queryDebounce.get(n.id); if (pending != null) clearTimeout(pending);
  queryDebounce.set(n.id, window.setTimeout(() => { queryDebounce.delete(n.id); renderQueryResults(n); }, 150));
}
// Append a whole `token` (e.g. "t:bug") to a query card's search text, if not already present —
// used by the tag panel's drag-onto-query-card assignment (features/tags.ts). The caller owns
// touch()/scheduleSave()/commitStep() around this, same as any other single-field mutation; this
// just updates the model and, if the field isn't mid-edit, its rendered input + results.
export function appendQueryToken(n: MindNode, token: string): void {
  const raw = (n.query ?? '').trim();
  const tokens = raw ? raw.split(/\s+/) : [];
  if (tokens.some(t => t.toLowerCase() === token.toLowerCase())) return;
  n.query = tokens.length ? `${raw} ${token}` : token;
  n.dirty = true;
  const input = n.el?.querySelector('.query-input') as HTMLInputElement | null;
  if (input && !(ui.queryEdit && ui.queryEdit.id === n.id)) input.value = n.query;
  renderQueryResults(n);
}
function endQueryEdit(n: MindNode): void {
  if (!ui.queryEdit || ui.queryEdit.id !== n.id) return;
  ui.queryEdit = null;
  n.el?.querySelector('.title-row')?.classList.remove('query-editing');
  const pending = queryDebounce.get(n.id); if (pending != null) { clearTimeout(pending); queryDebounce.delete(n.id); renderQueryResults(n); }
  paintNode(n);   // the revealed .title slot shows the query text (see paintNode) — refresh it now,
                   // not on whatever repaint happens to come next, since typing itself never touches it
  scheduleSave();
  commitStep();
}
export function paintNode(n: MindNode): void {
  const el = nodeEl(n);
  // Drop the content wrapper the moment it isn't holding anything — `hostsContent` is exactly the set
  // of cases the sizing chain below creates one for, so the two can't drift. ONE drop, and it sits
  // ahead of the isHidden return so it covers a hidden node too: folding a tab GROUP hides its open
  // tab, whose own wrapper would otherwise survive. A fold used to strand it — an empty overflow:hidden
  // div left at the box's old size, sitting over the canvas below the tab; same for a frame converted
  // to a card, or a stack demoted to a row inside another stack. Its (hidden) children ride along
  // detached and are re-placed by place() the moment it holds again.
  if (n.frameContentEl && !hostsContent(n)) { n.frameContentEl.remove(); n.frameContentEl = null; }
  if (isHidden(n)) { el.style.display = 'none'; return; }   // an ancestor is folded: nothing to paint
  el.style.display = '';
  const kids = childrenOf(n.id);
  const hasKids = kids.length > 0;
  const editingBody = ui.bodyEdit && ui.bodyEdit.id === n.id;    // body editor open on this card
  const hasBody = editingBody || !!(n.body && n.body.trim());  // keep the body slot while editing
  const collapsedKids = n.collapsed && hasKids;            // hidden children → +N chip
  const collapsed = n.collapsed && (hasKids || hasBody);   // folded to just its title
  const showDone = showsDoneCheckbox(n);                   // checklist item of a checklist parent
  // selected card gets an inline "+" at the end of its tag row (features/tags.ts's openEmojiPicker) —
  // frames have no natural place for a tag row at all (see the tag-row comment below). Only the
  // selection ANCHOR (state.selId — the same card the floating toolbar anchors to, float-bar.ts's
  // anchorEl) shows the button during a multi-selection, so there's exactly one "+" on screen no
  // matter how many cards are selected; the emoji it adds still applies to every selected card
  // (features/tags.ts's bindCardTagPills reads the full selection, not just this card's id).
  const showAddTag = n.id === state.selId && !isFrameBox(n) && !isStack(n) && !isAnnotation(n) && !isQueryBox(n) && !isDockedTab(n) && !state.readOnly && !isLockedEffective(n);
  const col = effectiveColor(n);
  applyColorVars(el, col);   // a custom colour's --card/--ink/--scrim; removed again for a palette key
  el.className = 'node ' + colorClass(col)
    + (isFrameBox(n) ? ' frame' : '')
    + (isStack(n) ? ' stack' : '')
    + (inStack(n) ? ' stack-child' : '')   // a card inside a stack's outliner — rendered slightly brighter
    + (inFrame(n) ? ' frame-child' : '')   // …and a card inside a frame's box, by the same step
    + (isImageBox(n) ? ' image-card' : '')
    + (isQueryBox(n) ? ' query-card' : '')
    + (isAnnotation(n) ? ' annotation' : '')
    + (state.sel.has(n.id) ? ' sel' : '')
    + (state.sel.size === 1 && state.sel.has(n.id) ? ' solo' : '')   // lone selection → show +
    + (collapsed ? ' collapsed' : '')
    + (isFrameFold(n) ? ' frame-folded' : '')   // folded to its bare title tab (styles.css)
    // a group, and whether it has tabs to show — with tabs, its own title tab is hidden (styles.css),
    // since a third tab-shaped thing in the strip reads as a third tab
    + (isTabsFrame(n) ? (tabsOf(n).length ? ' tabs has-tabs' : ' tabs') : '')
    // …and folded, the lone pill left behind wears a folder icon in front of that tab's title
    + (foldedTab(n) ? ' tabs-fold' : '')
    // a tab: the same bare-tab render as a folded frame, but joined to the group's box while OPEN
    + (isDockedTab(n) ? (n.collapsed ? ' docked' : ' docked tab-active') : '')
    // A group's box and its OPEN tab are one frame to the user, so they ring TOGETHER — whichever of the
    // two the selection actually landed on (clicking the box selects the group, clicking the tab selects
    // the tab). `sel-join` is the ring the other half then draws; see styles.css.
    + (selJoin(n) ? ' sel-join' : '')
    + (n.locked ? ' locked' : '')
    + (hasBody ? '' : ' no-body')
    + (isFrameBox(n) || isStack(n) || isAnnotation(n) || isQueryBox(n) || (!n.tags.length && !showAddTag) ? ' no-tags' : '')
    + (showDone ? ' show-done' : '')
    + (showDone && n.done ? ' done' : '')
    + (ui.drag?.targets?.has(n.id) ? ' dragging' : '')   // float the dragged subtree above all cards
    + (state.searchMatch && !state.searchMatch.has(n.id) ? ' search-dim' : '')
    + (state.searchActiveId === n.id ? ' search-active' : '');   // active dropdown option → white outline
  (el.querySelector('.donebox') as HTMLInputElement).checked = n.done;
  // this card's own checklist (over ITS children) → an "n/m done" progress readout by the title
  el.querySelector('.progress')!.textContent =
    (n.checklist && hasKids) ? `${kids.filter(k => k.done).length}/${kids.length}` : '';
  // Which frame (if any) hosts this card's element — settled outside gestures (see settledHost).
  const host = settledHost(n);
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
    el.style.left = dragOrig.x + 'px'; el.style.top = elTop(n, dragOrig.y) + 'px';
    el.style.transform = `translate(${n.x - dragOrig.x}px,${n.y - dragOrig.y}px)`;
    const root = dragRoot();
    if (el.parentElement !== root) root.appendChild(el);
  } else {
    if (el.style.transform) el.style.transform = '';
    // A child card is nested INSIDE its parent card's element, positioned by its offset from the
    // parent (n.x - parent.x — the live, staleness-proof form of rx/ry). So the parent carries its
    // whole subtree via the compositor: moving the parent's element moves every descendant with it,
    // no per-descendant left/top rewrite. Roots stay under #world; a direct frame child stays in the
    // frame's overflow:hidden wrapper (place()). isFrameBox covers frames (image cards are leaves).
    const p = n.parent ? state.nodes.get(n.parent) : null;
    const np = paintPos(n);   // live, or the frozen drag origin — see paintPos
    if (isAnnotation(n)) {
      // An annotation always renders directly under #world at absolute coords — never nested in its
      // parent nor in a frame's overflow:hidden wrapper — so a high z-index (styles.css) floats it on
      // TOP of everything and no frame mask ever clips it. It still tracks its parent: layout keeps
      // n.x/n.y = parent + offset, and drag carries it (it's in the parent's subtreeIds → own transform).
      place(el, np.x, np.y, null);
    } else if (p && !isContainerBox(p) && !isContainerBox(n)) {
      const pEl = nodeEl(p);
      const pp = paintPos(p);
      el.style.left = (np.x - pp.x) + 'px';
      el.style.top  = (elTop(n, np.y) - elTop(p, pp.y)) + 'px';
      if (el.parentElement !== pEl) pEl.appendChild(el);
    } else {
      // root → #world; direct frame/stack child → container content wrapper. A CONTAINER's own box
      // takes this branch too, even when its parent is an ordinary card: its content wrapper is
      // placed by the very same place()/settledHost call (frameContentEl), and the two only stack
      // correctly — wrapper (and the rows inside it) above the box's own fill — while they're
      // SIBLINGS in one DOM parent. Nesting the box inside a parent card instead put the two in
      // different stacking contexts, so the box's fill won the tie and swallowed its own rows'
      // pointer events (pressing a stack row grabbed the whole stack).
      // …and a DOCKED TAB's own label goes to its group's strip instead — see placeSelf.
      placeSelf(n, np.x, elTop(n, np.y));
    }
  }
  // Apply the node's size, and give it the resize hit-zones its kind supports. A frame / image card /
  // query card is its own 2D box (8 handles). Everything else authors only a WIDTH (2 side handles):
  // a stack's height is auto-fitted by layout, and a card's/annotation's comes from its content, so
  // their inline height is always cleared and left to CSS. The one node that ISN'T resizable is an
  // outline row inside a stack — its width is derived from the stack's, so it gets the width but no
  // handles (see nodeW / stackRowW).
  // Resolved once up front, not inside the `else if`: nodeW() would run the same ancestor walk a
  // second time to answer the same question. The earlier branches can't be rows, so they skip it.
  const rowW = isBoxNode(n) || isFrameFold(n) || isStack(n) ? null : stackRowW(n);
  if (isBoxNode(n)) {
    el.style.width = nodeW(n) + 'px';
    // the element is the BOX, and a frame's bounds height also covers its tab — elTop(n, 0) IS that
    // drop, so the box height is the bounds height less it (never re-spell the drop inline).
    el.style.height = (nodeH(n) - elTop(n, 0)) + 'px';
    // border matches this card's EDGE tint (same colour edges use), falling back to --edge
    el.style.setProperty('--frame-stroke', colorFill(effectiveColor(n)) ?? 'var(--edge)');
    ensureResizeHandles(n, FRAME_DIRS);
    if (isFrameBox(n)) frameContentEl(n);   // create/reposition/resize this frame's overflow:hidden content wrapper
  } else if (isFrameFold(n)) {
    // folded: the element is the bare title tab, shrink-wrapped by CSS (.frame-folded) — no inline
    // size, no resize zones, but it keeps --frame-stroke, which tints the tab itself.
    if (el.style.width) { el.style.width = ''; el.style.height = ''; }
    el.style.setProperty('--frame-stroke', colorFill(effectiveColor(n)) ?? 'var(--edge)');
    clearResizeHandles(el);
    // An OPEN docked tab still hosts its children — in the box its group lent it, not in this label —
    // so it keeps a clipping wrapper of its own, positioned at that lent interior (frameInterior).
    if (isDockedTab(n) && !n.collapsed) frameContentEl(n);
  } else if (isStack(n)) {
    el.style.width = nodeW(n) + 'px';    // authored (n.w, default STACK_W) — resizable on this axis only
    el.style.height = nodeH(n) + 'px';   // auto-fitted to children (set by layoutSubtree)
    el.style.setProperty('--frame-stroke', colorFill(effectiveColor(n)) ?? 'var(--edge)');
    frameContentEl(n);                   // clipping content wrapper
    ensureResizeHandles(n, EW_DIRS);
  } else if (rowW != null) {
    // an OUTLINE ROW — a narrower test than inStack(n), which also catches an annotation parented to a
    // stack; the outline skips those, so they keep their own shrink-to-fit width via the branch below
    el.style.width = rowW + 'px';        // stretched to the row width its depth allows (stackRowW)
    if (el.style.height) el.style.height = '';
    el.style.removeProperty('--frame-stroke');
    clearResizeHandles(el);              // a row's width is derived, so it isn't resizable
  } else {
    // A plain card or an annotation: an authored width if it has one (else back to the CSS-fixed
    // card / the annotation's shrink-to-fit), never an inline height.
    const authored = n.w != null;
    el.style.width = authored ? n.w + 'px' : '';
    if (el.style.height) el.style.height = '';
    // an annotation's CSS max-width would otherwise cap — and so desync — an authored width
    el.classList.toggle('w-set', authored);
    el.style.removeProperty('--frame-stroke');
    ensureResizeHandles(n, EW_DIRS);
  }
  // A tab group's STRIP is a second container of its own (tabStripEl), so it's created here rather
  // than by the sizing branch above — and dropped the moment the node stops being an expanded group,
  // so switching the layout away (or folding the group) can't strand an empty band on the canvas.
  if (isTabsFrame(n) && !n.collapsed) tabStripEl(n);
  else if (n.tabStripEl) { n.tabStripEl.remove(); n.tabStripEl = null; }
  // don't clobber the title while it's being inline-edited (the user is typing into it). A query
  // card has no editable title of its own — its title slot always shows the live query text
  // instead (falling back to n.title before any query has been typed), so the card always reads as
  // "what it's searching for" rather than whatever name it happened to be created with.
  if (!(ui.inlineEdit && ui.inlineEdit.id === n.id)) {
    const titleEl = el.querySelector('.title') as HTMLElement;
    // A folded tab group shows its OPEN TAB's title, not its own (foldedTab) — everything else its own.
    const label = foldedTab(n) ?? n;
    titleEl.textContent = isQueryBox(n) ? ((n.query ?? '').trim() || n.title) : label.title;
    // A frame's title tab is a single ellipsised line (it must stay exactly FRAME_TAB_H tall), so give
    // it a native tooltip with the full name. Every other kind wraps and needs none.
    if (n.type === 'frame') titleEl.title = label.title; else titleEl.removeAttribute('title');
  }
  const bodyEl = el.querySelector('.body') as HTMLElement;
  // don't clobber the body while it's being edited in place (the textarea lives inside .body)
  if (!editingBody) {
    bodyEl.innerHTML = renderBodyHTML(n.body);
    hydrateImages(bodyEl);   // swap inline-image placeholders for resolved (blob/remote) URLs
  }
  if (isQueryBox(n)) {
    const qInput = el.querySelector('.query-input') as HTMLInputElement;
    // don't clobber the field while the user is actively typing into it
    if (!(ui.queryEdit && ui.queryEdit.id === n.id)) qInput.value = n.query ?? '';
    renderQueryResults(n);
  }
  // tag pills — skipped for frames (whose fixed box (n.h) holds arbitrary child cards rather than
  // its own content, so there's no natural place for a tag row to live) and for annotations (no
  // room on a title-less pinned note, and their frontmatter's own `tags` — if any, e.g. inherited
  // from converting an existing card — is deliberately ignored, never rendered or editable here).
  // Image/query cards ARE shown despite also being fixed-size boxes — the whole row floats outside
  // the card's own border (styles.css), so it doesn't compete for interior space either way. The
  // row is pinned to the card's bottom-right corner; a leading "+" (only present on the selected
  // card, rendered FIRST so it ends up leftmost) is where the NEXT tag will land. Newly added tags
  // are prepended in DOM order — most-recently-added right after the button — so each addition only
  // ever fills the button's current slot and nudges the button one slot further left; every
  // previously-placed tag keeps the exact screen position it already had (n.tags itself still
  // stores oldest-first, insertion order — only the on-screen order is reversed). Keyed like
  // renderQueryResults: only rebuild when the tag list or the button's presence actually changed, so
  // an unrelated repaint mid-drag can't destroy a pointer-captured pill (features/tags.ts's
  // bindCardTagPills).
  const tagRowEl = el.querySelector('.tag-row') as HTMLElement;
  // isDockedTab: a strip of tabs has no room for pills hanging off each label (they'd overlap the
  // next tab), and a tab is a handle on a box rather than a note you'd tag.
  const noTagRow = isFrameBox(n) || isAnnotation(n) || isQueryBox(n) || isDockedTab(n);
  const tagsKey = noTagRow ? '' : n.tags.join(' ') + (showAddTag ? ' +' : '');
  if (tagRowEl.dataset.tagsKey !== tagsKey) {
    tagRowEl.dataset.tagsKey = tagsKey;
    tagRowEl.innerHTML = (showAddTag ? `<button type="button" class="tag-add-btn" title="Add emoji" aria-label="Add emoji">${TAG_ADD_SVG}</button>` : '') +
      (noTagRow ? '' : [...n.tags].reverse().map(t => tagPillHTML(t)).join(''));
    bindCardTagPills(tagRowEl, n);
  }
  // The corner bubble, in its two faces — `data-chip` is the SINGLE thing that decides which one
  // shows (see chipFace + styles.css): 'count' is the folded "+5", 'fold' the expanded chevron.
  const chip = el.querySelector(':scope > .title-row > .hidden-count') as HTMLElement;
  const face = chipFace(n, hasKids, hasBody, collapsed);
  if (el.dataset.chip !== face) { if (face) el.dataset.chip = face; else delete el.dataset.chip; }
  // `wide` only when there are digits to make room for: a bare "+" and the chevron stay perfect
  // 16px circles rather than being stretched into lozenges by the side padding (styles.css).
  chip.classList.toggle('wide', face === 'count' && collapsedKids);
  if (face === 'count') {
    (chip.querySelector('.cnt') as HTMLElement).textContent = FOLD_PLUS + (collapsedKids ? descendantCount(n.id) : '');
    chip.title = collapsedKids ? 'Expand (X)' : 'Unfold note (X)';
  } else if (face === 'fold') {
    // no "(X)" on a tab: X folds the selection, and a docked tab isn't foldable on its own — this
    // button's whole job there is to fold the GROUP (see the click handler in nodeEl)
    chip.title = isDockedTab(n) ? 'Collapse tab group' : (hasKids ? 'Collapse (X)' : 'Fold note away (X)');
  }
}
// The tab whose title a FOLDED tab group wears — its open one — else null (any other node, and an
// EMPTY group, which has only its own name to show). A group doesn't exist from the user's side:
// there are tabs, one of them open. So folding one leaves a pill carrying the very label that was on
// screen a moment ago, marked with a folder icon (FOLDER_SVG / `.tabs-fold`) to say the other tabs are
// tucked in behind it — the text doesn't change under the fold, and the group's own title (still what
// the outline and search list it as, and what its .md file is called) never has to be readable. Which
// is why renaming a folded group unfolds it first and renames that tab (features/inline-edit.ts): the
// name on the pill must be the name a rename edits.
function foldedTab(n: MindNode): MindNode | null {
  return isTabsFrame(n) && n.collapsed ? (activeTab(n) ?? null) : null;
}
// WHICH node the corner bubble acts on. Itself, except on the OPEN TAB of a group, where the button
// folds the whole GROUP — the box the tab is the front of. A tab has no fold of its own (it opens,
// closing its siblings), and from the user's side there is no group anyway: there are tabs, one of
// them open, and this closes the lot. It comes back as the group's own pill, whose +N re-opens it with
// this tab still active. chipFace and the click handler in nodeEl both read this, so the button that's
// SHOWN and the node it FOLDS can't disagree (chipFace gates on the target's lock, not the tab's).
function chipTarget(n: MindNode): MindNode {
  return (isDockedTab(n) ? tabGroupOf(n) : null) ?? n;
}
// Which face the corner bubble wears — the ONE predicate behind it, so no per-kind CSS rule has to
// out-specify the :hover/.sel ones (that fight is unwinnable: `:hover:not(:has(.node:hover))` beats
// any plain class selector). '' hides the bubble entirely.
//   'count' — folded: "+N" hidden descendants, or a bare "+" when only a body is tucked away.
//   'fold'  — expanded and collapsible: the chevron, which styles.css reveals on hover or while
//             SELECTED. Every kind that can actually fold gets it, so the gesture is discoverable
//             on frames and stacks too, not just plain cards.
function chipFace(n: MindNode, hasKids: boolean, hasBody: boolean, collapsed: boolean): '' | 'count' | 'fold' {
  // TABS. A group and its open tab are one frame from the user's side, so between them they carry ONE
  // button — on the tab, because that's the title you can see — and it folds the group (the click
  // handler in nodeEl redirects it). So:
  //   · the OPEN tab offers 'fold', unless the group refuses to be folded (locked);
  //   · a CLOSED tab offers nothing — its contents are one click away in the box rather than tucked
  //     under a stub, and a badge would collide with the next tab along the strip;
  //   · the GROUP shows nothing while open (its button is up on the tab) but takes the 'count' face
  //     once folded, when it's a lone pill again and that +N is the only way back.
  if (isDockedTab(n)) {
    const g = chipTarget(n);
    return (!n.collapsed && g !== n && !isLockedEffective(g)) ? 'fold' : '';
  }
  if (isTabsFrame(n)) return collapsed ? 'count' : '';
  if (collapsed) return 'count';
  // A frame's and a stack's own body is never rendered (styles.css), so only CHILDREN make one
  // collapsible; every other kind can also fold a body away to just its title. Deliberately a test on
  // the KIND and not isContainer/isFrame/isStack: those also carry state (a collapsed frame, a stack
  // demoted to a row inside another stack) that has no bearing on whether the body is drawn.
  const foldable = (n.type === 'frame' || n.type === 'stack') ? hasKids : (hasKids || hasBody);
  if (!foldable) return '';
  // An annotation IS its body (no title row at all), so folding it would leave an empty shell —
  // it keeps double-click/X but is never invited to. An image/query card is a box whose whole
  // content is the point, and its corner is already spoken for by the picture/results.
  if (isAnnotation(n) || isImageCard(n) || isQueryCard(n)) return '';
  // toggleCollapse refuses a locked node, so it must not offer a button that does nothing. Its
  // folded COUNT above is unaffected: that's information, not a control.
  if (isLockedEffective(n)) return '';
  return 'fold';
}
export const NODE_W = 200;
// world-px grid dragged positions AND frame/image-card sizes snap to — tracks the visible grid's
// own cell size (state.gridSize, view/grid.ts); 0 (grid off) disables snapping rather than
// collapsing every position to the origin.
export function gridSnap(): number { return state.gridSize || 1; }
export const FRAME_BORDER = 4;   // must match .node.frame's CSS `border` width (styles.css)
// Height of a frame's title TAB — the folder tab attached above the box's top-left corner
// (styles.css `.node.frame > .title-row`). Must match the CSS (10px padding + 20px line-height + 10px
// padding — a normal card's own padding and title metric, so the tab reads like a collapsed card),
// which is why the tab stays a SINGLE ellipsised line: this is a constant, and the frame's
// whole geometry hangs off it, so a wrapping tab would make the box's world position a function of
// the rendered line count.
export const FRAME_TAB_H = 40;
// A frame's BOUNDS (n.x/n.y/w/h — and so mm_position_y/mm_h on disk) include that tab: n.y is the
// TAB's top edge and the box starts FRAME_TAB_DROP lower. One tab, less the 1px the tab overlaps the
// box's top border (styles.css), so the tab spans exactly [n.y, n.y + FRAME_TAB_H] — in BOTH states,
// which is the point: a folded frame renders as the bare tab at n.y, so the title doesn't move when
// the box folds away beneath it.
export const FRAME_TAB_DROP = FRAME_TAB_H - 1;   // 39
// Default frame container size (world px). The height is BOUNDS — a 260px box plus the tab above it —
// so it's written as that sum rather than a literal, which is what keeps a new frame's usable
// interior fixed when the tab height changes (declared after FRAME_TAB_DROP so the sum is in scope).
export const FRAME_W = 360, FRAME_H = 260 + FRAME_TAB_DROP;
export const IMAGE_W = 240, IMAGE_H = 180;   // default image-card size (world px)
export const QUERY_W = 280, QUERY_H = 320;   // default query-card size (world px)
// Stack geometry (a framed, auto-sized outliner node kind — see isStack in view/layout.ts). Its
// width is AUTHORED (n.w, defaulting to STACK_W — it takes the EW handle set like a card); its
// height auto-fits its children and is never authored (computed in layoutSubtree).
export const STACK_W = NODE_W;   // a stack STARTS the same width as a normal card (not wider)
export const STACK_HEADER = 36;  // title strip reserved above the stacked children
export const STACK_PAD = 6;      // inset from the border to the content — half a normal card's
                                 // padding, so full-width child cards still fit in the narrow box
export const STACK_GAP = 8;      // vertical gap between stacked children
// Whether a node currently renders as a frame BOX. A collapsed frame folds to its bare title tab
// (isFrameFold below), so it has no box at all — and neither does a frame DOCKED as a tab, open or
// not: the box belongs to its group, which is exactly what docking means. Shared by the geometry
// helpers below.
function isFrameBox(n: MindNode): boolean { return n.type === 'frame' && !n.collapsed && !isDockedTab(n); }
// …and the other half: a frame that renders as nothing but its title tab — a small pill at the bounds
// top (n.y), i.e. exactly where an expanded frame's tab sits, so folding never moves the title. Its
// element shrink-wraps the title, so its width is measured (nodeW) rather than assumed. TWO ways to
// get here: FOLDED (its own box hidden below the tab), or DOCKED as a tab (no box of its own at all —
// its group's box is what its contents show through, and this tab is the handle that opens it). So a
// docked tab needs no render mode of its own: open vs closed is just `collapsed`, which already
// decides whether its contents show, plus a CSS class (see paintNode).
function isFrameFold(n: MindNode): boolean { return n.type === 'frame' && (!!n.collapsed || isDockedTab(n)); }
// Whether `n` currently holds its children in a content wrapper of its own (frameContentEl) — the three
// cases paintNode's sizing chain creates one for, spelled once so its cleanup can't drift from them:
// an expanded frame BOX, an expanded stack (isStack already excludes collapsed and demoted-to-a-row),
// and an OPEN docked tab, whose contents show through the box its group lent it.
// Being HIDDEN (an ancestor folded) counts as holding nothing, which is what lets paintNode maintain
// "a wrapper exists iff hostsContent(n)" with ONE drop, ahead of its isHidden early return: folding a
// tab group hides its open tab, whose own wrapper would otherwise survive the fold.
function hostsContent(n: MindNode): boolean {
  if (isHidden(n)) return false;
  return isFrameBox(n) || isStack(n) || (isDockedTab(n) && !n.collapsed);
}
// The width a frame's own title TAB renders at — MEASURED, since a title is as wide as its text (up
// to the CSS max-width, which ellipsises it). When the frame is folded or docked its element IS that
// tab; otherwise the tab is the .title-row hanging above the box. Shared by the strip layout, the dock
// hit-test and the dock preview, so all three agree on where a tab starts and ends.
// Is `n` the OTHER half of a selected tab frame — the open tab of a selected group, or the box of a group
// whose open tab is selected? Either way the two are one frame on screen and must show one continuous
// ring, so the half that isn't selected borrows the ring too (styles.css `.sel-join`).
// Exported because it also answers "is this box selected, as far as the user can tell": a group is
// never itself in the selection (selTarget), so features/drag.ts asks this before deciding whether a
// press inside a frame moves it or rubber-bands its contents.
export function selJoin(n: MindNode): boolean {
  if (isDockedTab(n)) return !n.collapsed && !!n.parent && state.sel.has(n.parent);
  if (isTabsFrame(n) && !n.collapsed) { const t = activeTab(n); return !!t && state.sel.has(t.id); }
  return false;
}
export function frameLabelW(n: MindNode): number {
  const lab = labelEl(n);
  if (!lab || lab === n.el) return nodeW(n);   // labelEl returns the element itself for a fold/tab
  return lab.offsetWidth || NODE_W;
}
// WHICH element carries this node's visible title. Its own `.title-row`, except for a frame that
// renders as nothing but its tab (folded or docked), where the element IS the label. Exported because
// the float bar centres itself on the label rather than the box (features/float-bar.ts) and needs the
// same answer this does — so a kind whose label element differs is a change in one place, not two.
export function labelEl(n: MindNode): HTMLElement | null {
  if (!n.el) return null;
  return isFrameFold(n) ? n.el : (n.el.querySelector(':scope > .title-row') as HTMLElement | null);
}
// An image card: a resizable leaf that shows nothing but its one image — no children, no title UI.
function isImageBox(n: MindNode): boolean { return n.type === 'image' && !n.collapsed; }
// A query card: a resizable leaf with a search field + scrollable results list — no children.
function isQueryBox(n: MindNode): boolean { return n.type === 'query' && !n.collapsed; }
// Any 2D box — authors BOTH axes, so it gets the full 8-handle set and shares the sizing plumbing
// below. A stack is a box too (it gets a size + a .frame-content wrapper) but authors only a width,
// so it takes the EW handles in paintNode and is covered by isContainerBox instead.
function isBoxNode(n: MindNode): boolean { return isFrameBox(n) || isImageBox(n) || isQueryBox(n); }
// Any node that renders as a child-containing BOX with a size + clipping wrapper: a resizable frame
// OR an auto-sized stack. Used for the size/wrapper plumbing in paintNode.
// A DOCKED TAB counts even though it draws no box: it still HOSTS its children in the box its group
// lent it, so its children must be placed into its wrapper (place) rather than DOM-nested inside its
// element — which is only a label in the strip, nowhere near where its contents belong.
function isContainerBox(n: MindNode): boolean { return isFrameBox(n) || isStack(n) || isDockedTab(n); }
// Does this card live inside a stack's outliner? True when its nearest CONTAINER ancestor is a
// stack (a frame in between governs instead) — covers the stack's direct children AND deeper rows.
// Used for the .stack-child tint. For "is this actually an outline ROW" (which drives the row width
// and excludes annotations) use stackRowW instead — see the sizing branch above.
function inStack(n: MindNode): boolean {
  const h = hostFrame(n);
  return !!h && isStack(h);
}
// …and the mirror for a FRAME's box: a card sitting in one is tinted a touch brighter (.frame-child),
// exactly as a stack's rows are, and for the same reason — a card INHERITS its colour from its
// ancestors (effectiveColor), so one dropped into a coloured frame resolves to the frame's own fill
// and vanishes into it. Nearest container only, so a card in a stack in a frame stays a stack row.
// Plain cards only: every other kind is a shape with its own fill rules — a nested stack already
// steps DOWN inside a frame, a nested frame's fill is tied to the --frame-stroke its border and title
// tab share, an image/query card is deliberately image-only / outline-only, and an annotation never
// inherits a colour in the first place (it takes the theme's contrast colour, which the tint would
// wash out).
function inFrame(n: MindNode): boolean {
  if (isContainer(n) || isImageBox(n) || isQueryBox(n) || isAnnotation(n)) return false;
  const h = hostFrame(n);
  return !!h && isFrame(h);
}
function boxDefaultW(n: MindNode): number { return isImageBox(n) ? IMAGE_W : isQueryBox(n) ? QUERY_W : FRAME_W; }
function boxDefaultH(n: MindNode): number { return isImageBox(n) ? IMAGE_H : isQueryBox(n) ? QUERY_H : FRAME_H; }
// A node's footprint WIDTH. `n.w` is the AUTHORED width — dragged with a resize handle, persisted as
// mm_w — and every kind can carry one: a frame/image/query card sizes its whole box with it, while a
// card/annotation/stack authors only this axis (their height comes from content/outline instead).
// The two widths that are NOT authored come first, so they win: an outline ROW inside a stack is
// stretched to the width its indent depth allows (stackRowW, derived — a row can't be resized, and a
// card keeps whatever width it authored OUTSIDE the stack for when it's dragged back out), and a
// folded frame's tab shrink-wraps its title. An annotation shrinks to fit its text (styles.css)
// unless a width was authored, so it's measured live off the element rather than assumed.
export function nodeW(n: MindNode): number {
  if (isBoxNode(n)) return n.w ?? boxDefaultW(n);
  if (isFrameFold(n)) return (n.el && n.el.offsetWidth) || NODE_W;   // the tab shrink-wraps its title
  const row = stackRowW(n); if (row != null) return row;             // outline row — derived, not authored
  if (isStack(n)) return n.w ?? STACK_W;
  if (isAnnotation(n)) return n.w ?? ((n.el && n.el.offsetWidth) || NODE_W);
  return n.w ?? NODE_W;
}
// live height (falls back pre-render). An expanded frame/image card's height is its box (n.h), a
// stack's height is its auto-fitted box (n.h, set by layout) — not its card.
export function nodeH(n: MindNode): number {
  if (isBoxNode(n)) return n.h ?? boxDefaultH(n);
  if (isFrameFold(n)) return FRAME_TAB_H;   // just the tab — one fixed line, never measured
  if (isStack(n)) return n.h ?? (STACK_HEADER + STACK_PAD);
  return (n.el && n.el.offsetHeight) || 64;
}
// Height used for LAYOUT geometry. Identical to nodeH for every kind whose height is DECLARED
// (box / folded frame / stack), so it defers to it rather than restating the ladder — a new kind
// added to nodeH must not have to be remembered here too. The two differ only for a MEASURED card:
// nodeH treats a zero-height element as unrendered and falls back to 64, while layout wants the real
// 0 (the selection affordances — + and the "add note" bubble — are absolutely positioned and
// overhang, so they never inflate the measurement either way).
export function layoutH(n: MindNode): number {
  if (isBoxNode(n) || isFrameFold(n) || isStack(n)) return nodeH(n);
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
  if (ui.drag || ui.inlineEdit || ui.bodyEdit) return n.hostFrameId ? (state.nodes.get(n.hostFrameId) ?? null) : null;
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
function paintPos(n: MindNode): Pt { return ui.drag?.origins?.get(n.id) ?? n; }
// Where a node's ELEMENT paints, given a bounds-top y: the SINGLE authority for the tab drop. The same
// y for everything except a frame BOX, whose element is the box alone — one tab BELOW the bounds top
// (FRAME_TAB_DROP), with the tab itself an absolutely positioned child hanging back up over that gap
// (styles.css). A FOLDED frame's element IS that tab, so it paints at the bounds top like any card.
// Takes y separately from n because a mid-drag paint writes the FROZEN origin, not the live position.
export function elTop(n: MindNode, y: number): number { return isFrameBox(n) ? y + FRAME_TAB_DROP : y; }
// elTop's inverse: the BOUNDS top for an element that paints at y. Only followEdges needs it — it
// reads back interpolated left/top mid-animation to reproject them into world coordinates.
function boundsTop(n: MindNode, y: number): number { return isFrameBox(n) ? y - FRAME_TAB_DROP : y; }
// Place an element at absolute world coords, expressed relative to its container: #world (or the drag
// layer) for a root, else the host container's content wrapper — which sits at the host's INTERIOR, so
// the offset is the host's own inset (the border, plus a frame's title tab — see frameInsetY).
function place(el: HTMLElement, absX: number, absY: number, host: MindNode | null): void {
  if (!host) return placeIn(el, absX, absY, dragRoot(), 0, 0);
  const o = contentOrigin(host);
  placeIn(el, absX, absY, frameContentEl(host), o.x, o.y);
}
// The mechanical half of place(): write absolute world (absX,absY) as an offset from `container`'s own
// world origin and (re)parent into it. Split out so the tab strip — a second container, positioned
// outside its group's clipping wrapper (tabStripEl) — shares the same arithmetic.
function placeIn(el: HTMLElement, absX: number, absY: number, container: HTMLElement, ox: number, oy: number): void {
  el.style.left = (absX - ox) + 'px';
  el.style.top  = (absY - oy) + 'px';
  if (el.parentElement !== container) container.appendChild(el);
}
// Where a container's content wrapper sits in world coords, on the PAINT basis (its frozen origin
// mid-drag — see paintPos). Everything that has to agree on that point reads it here: place() offsets
// left/top by it, frameContentEl() positions the wrapper at it, followEdges() projects back through
// it. Expressed as a delta off the host's own origin rather than re-spelling the insets, so a docked
// tab (whose interior is the box its GROUP lent it) needs no special case anywhere.
function contentOrigin(host: MindNode): Pt {
  const box = frameInterior(host);
  // Measured off the node the interior actually BELONGS to: for a docked tab that's its group, whose box
  // doesn't move when the tab does — anchoring to the tab instead would drag its contents along the strip
  // with it. (Same node either way for everything else.)
  const basis = tabGroupOf(host) ?? host;
  const bp = paintPos(basis);
  return { x: bp.x + (box.x - basis.x), y: bp.y + (box.y - basis.y) };
}
// A tab group's STRIP: the band its tabs' labels are laid out in, as a container of its own.
// UNCLIPPED, and that's the whole point — the strip of a top-level group sits ABOVE its box (the same
// band its own title tab hangs in), so tabs placed in the group's overflow:hidden content wrapper
// would be clipped away entirely. A DOCKED group's strip is inside the interior it was lent, so it
// goes into that group's wrapper and clips with it, exactly as its own box would.
function tabStripEl(g: MindNode): HTMLElement {
  let s = g.tabStripEl;
  if (!s) { s = document.createElement('div'); s.className = 'tab-strip'; g.tabStripEl = s; }
  const o = stripOrigin(g), r = tabStripRect(g);
  place(s, o.x, o.y, settledHost(g));
  s.style.width = (r.w + TAB_STRIP_PAD * 2) + 'px';
  s.style.height = (r.h + TAB_STRIP_PAD * 2) + 'px';
  // …and keep it right BEFORE the box among its siblings. Neither carries a z-index, so tree order is
  // what decides: an inactive tab then paints behind the box, letting its border and selection ring run
  // across the top of it (styles.css). The open tab lifts back above with a z-index of its own.
  const boxEl = nodeEl(g);
  if (s.parentElement && s.parentElement === boxEl.parentElement && s.nextSibling !== boxEl)
    s.parentElement.insertBefore(s, boxEl);
  return s;
}
// A tab is exactly FRAME_TAB_H tall and the band is too, so a strip clipped to the band would cut off
// whatever a tab hangs outside itself: its selection ring (2px out — see styles.css `.sel-join`), a locked
// tab's lock badge (8px out at the top-left, `.node .lock-badge`) and the open tab's fold chip (12px out
// at the top-right — `.node.frame-folded > .title-row > .hidden-count`, lifted so it straddles the tab's
// rounded corner rather than sinking into it). Give the wrapper headroom for the largest of those all
// round — stripOrigin shifts with it, so the tabs inside still land on their world positions, and the
// clip that keeps a long row of tabs inside the box still does its job.
const TAB_STRIP_PAD = 14;
// …and where that strip sits, on the paint basis — contentOrigin's counterpart for the tab band.
function stripOrigin(g: MindNode): Pt {
  const r = tabStripRect(g), gp = paintPos(g);
  return { x: gp.x + (r.x - g.x) - TAB_STRIP_PAD, y: gp.y + (r.y - g.y) - TAB_STRIP_PAD };
}
// Put a node's OWN element where it belongs. A docked tab's label goes in its group's strip — it
// isn't content of the box, it's the handle that opens it — and everything else goes in its host
// container's content wrapper, or straight under #world. The single decision point, shared by
// paintNode and frameContentEl's ordering guard.
function placeSelf(n: MindNode, absX: number, absY: number): void {
  const g = tabGroupOf(n);
  if (!g) place(nodeEl(n), absX, absY, settledHost(n));
  else {
    const o = stripOrigin(g);
    placeIn(nodeEl(n), absX, absY, tabStripEl(g), o.x, o.y);
  }
  orderContentAfterBox(n);
}
// Keep a container's own box BEFORE its content wrapper among their shared siblings. The two paint in
// the same step (both z-index:auto — see .node.frame in styles.css), so document order alone decides
// which is on top: the wrapper must FOLLOW the box, or the box's opaque fill paints straight over
// everything inside it that also sits at z-index:auto — a nested stack, a nested frame. (Plain cards
// are z-index:2 and survive either way, which is exactly what "the stack vanished but its rows didn't"
// looked like.)
// Any re-append of the box moves it to the END of its container, inverting the pair whenever the
// wrapper got there first — which is routine, since Map iteration order isn't parent-before-child, so
// a child's paint reaches frameContentEl before the container's own paintNode. The case that actually
// bit: dropping a dragged frame returns box and wrapper from #dragLayer in whatever order the repaint
// visits them. So re-assert the order after every box placement; frameContentEl's own creation guard
// covers the mirror case (a wrapper built before its box had ever been placed).
// A docked tab is the one pair that ISN'T siblings — its label lives in its group's strip while its
// wrapper sits in the lent interior — and the same-parent test below leaves it alone.
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
    placeSelf(f, f.x, elTop(f, f.y));
    w = document.createElement('div'); w.className = 'frame-content'; f.frameContentEl = w;
  }
  // A stack auto-sizes to its outline, so nothing ever needs clipping — and clipping would cut off
  // its rows' corner affordances (the +N count / lock badges that overhang the card edge). Mark its
  // wrapper so CSS lets those overhang (overflow:visible); a resizable frame keeps overflow:hidden.
  w.classList.toggle('stack-content', isStack(f));
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
// a frame is never narrower than a normal card; its min HEIGHT is bounds, so it carries the tab too
export const MIN_FRAME_W = NODE_W, MIN_FRAME_H = 120 + FRAME_TAB_DROP;
export const MIN_IMAGE_W = 60, MIN_IMAGE_H = 60;        // an image card can shrink to a small thumbnail
export const MIN_QUERY_W = 200, MIN_QUERY_H = 160;      // a query card keeps room for the search field + a couple of rows
// The one exception to "a kind's default width is its floor": an annotation shrink-wraps its text
// (styles.css), so it has no fixed natural width to floor at — it can be narrowed too, down to
// something still readable.
const MIN_ANNO_W = 80;
// An annotation's UN-AUTHORED width: what the element measures with no authored width in play. Its
// current offsetWidth is useless as a floor once a width HAS been authored (it just reports that
// width back), so strip both halves of the authored sizing for one measurement and put them straight
// back. The `w-set` class matters as much as the inline width: it's what lifts the shrink-to-fit
// max-width cap, and measuring with the cap still lifted returns the full one-line text width — which
// as a floor would mean a widened annotation could never be narrowed again.
function naturalW(n: MindNode): number {
  const el = n.el; if (!el) return NODE_W;
  const prev = el.style.width, hadSet = el.classList.contains('w-set');
  el.style.width = ''; el.classList.remove('w-set');
  const w = el.offsetWidth;
  el.style.width = prev; el.classList.toggle('w-set', hadSet);
  return Math.max(MIN_ANNO_W, w);
}
// A width-only kind can only ever get WIDER than the width it has by default — the whole point is
// trading height for width on a card whose text wraps badly, so its natural size is the floor. That
// floor is NODE_W for a plain card, a stack (STACK_W is NODE_W) and a frame alike, so they share the
// one fall-through rather than three aliases that had to be kept equal by hand.
function minWOf(n: MindNode): number {
  if (isImageBox(n)) return MIN_IMAGE_W;
  if (isQueryBox(n)) return MIN_QUERY_W;
  if (isAnnotation(n)) return naturalW(n);
  return NODE_W;
}
function minHOf(n: MindNode): number { return isImageBox(n) ? MIN_IMAGE_H : isQueryBox(n) ? MIN_QUERY_H : MIN_FRAME_H; }
// 8 resize handles: 4 edges (one axis) + 4 corners (two axes). A `w`/`n` component moves that edge,
// which shifts the frame's x/y (the opposite edge stays put); `e`/`s` just grow width/height.
const FRAME_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type FrameDir = typeof FRAME_DIRS[number];
// …and the width-only set: a card / annotation / stack authors a WIDTH but never a height (its
// height stays whatever its content measures, or — for a stack — whatever its outline needs), so it
// gets the two side bands and no corners.
const EW_DIRS = ['e', 'w'] as const;
// Ensure the node has exactly the (invisible) resize hit-zones its kind wants — one per edge/corner,
// added once and reused. No visible grip: the resize cursors on the border are the affordance.
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
  // Does this kind author its own HEIGHT, or only a width? A card/annotation measures its height from
  // its content and a stack derives its own from its outline, so for those the resize writes w only.
  const sizeH = isBoxNode(n);
  const minW = minWOf(n), minH = minHOf(n);
  const aspect = isImageBox(n) ? imageAspect(n) : null;   // width/height — locked while dragging an image card
  const flow = !!frameFlow(n);   // frame-h/frame-v: reflow its children live as the box resizes, not just on release
  // Live geometry, not (n.w ?? boxDefaultW): boxDefaultH falls back to FRAME_H for anything that
  // isn't an image/query, so a plain card would start from a bogus 279px-tall box.
  const left0 = n.x, top0 = n.y, right0 = n.x + nodeW(n), bottom0 = n.y + nodeH(n);
  const sx = e.clientX, sy = e.clientY;
  const west = dir.includes('w'), east = dir.includes('e'), north = dir.includes('n'), south = dir.includes('s');
  // Attached annotations ride the BORDER they sit on. An annotation is pinned on top of its parent at
  // an offset, so a resize that moves an edge it was hugging would otherwise leave it stranded mid-card
  // (or hanging off the end). Latch each one to its nearer edge on each axis NOW, at the size the user
  // grabbed, and move it by whatever that edge ends up doing — including the BOTTOM edge of a
  // width-only card, whose height changes on its own as the text re-wraps.
  const annos = childrenOf(n.id).filter(isAnnotation).map(a => ({
    a, x0: a.x, y0: a.y,
    toRight:  Math.abs((a.x + nodeW(a)) - right0)  < Math.abs(a.x - left0),
    toBottom: Math.abs((a.y + nodeH(a)) - bottom0) < Math.abs(a.y - top0),
  }));
  const shiftAnnos = (): void => {
    for (const t of annos) {
      t.a.x = t.x0 + (t.toRight  ? (n.x + nodeW(n)) - right0  : n.x - left0);
      t.a.y = t.y0 + (t.toBottom ? (n.y + nodeH(n)) - bottom0 : n.y - top0);
      t.a.dirty = true;
      paintNode(t.a);
    }
  };
  touch(n.id);
  for (const t of annos) touch(t.a.id);   // one undo step covers the box AND the annotations it carried
  let lastDx = 0, lastDy = 0;
  let subtreeRAF: number | null = null;
  const identity = (v: number): number => v;
  const g = gridSnap();
  const snap = (v: number): number => Math.round(v / g) * g;
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
    n.x = left; n.w = right - left;
    // a width-only kind never gets a y/h written — see sizeH
    if (sizeH) { n.y = top; n.h = bottom - top; }
    n.dirty = true;
  };
  const move = (ev: PointerEvent): void => {
    lastDx = (ev.clientX - sx) / state.view.k; lastDy = (ev.clientY - sy) / state.view.k;
    resize(identity);
    paintNode(n);        // paint FIRST: shiftAnnos reads back the re-wrapped height for a bottom latch
    shiftAnnos();
    paintEdges();
    // A flow frame (frame-h/frame-v) arranges its children by wrapping them into the box's own
    // width/height — reflow them live as that box changes size, not just once on release, so the
    // wrap point visibly updates while dragging. Coalesced to once per animation frame (applyLayouts
    // walks every root's subtree, so it's not free) rather than once per raw pointermove.
    // A width-only kind needs the same live pass for a different reason: its HEIGHT is measured, and
    // re-wrapping the text at the new width changes it — so its parent's line/fan arrangement (and a
    // stack's own auto-fitted box) has to settle around the new shape as the drag goes, or everything
    // below it jumps on release. paintNode(n) above already ran, so the measurement is current.
    if ((flow || !sizeH) && !subtreeRAF) subtreeRAF = requestAnimationFrame(() => {
      subtreeRAF = null;
      applyLayouts(); paintAll();
    });
    // A north/west resize shifts the frame's own x/y, which shifts its content wrapper's origin —
    // repaint the whole subtree (not just direct children) so every hosted descendant's live,
    // wrapper-relative position compensates and stays put in absolute space as the box resizes
    // around it (an east/south-only resize doesn't move the origin, so this is skipped entirely).
    // subtreeIds walks the whole node map, so coalesce it to once per animation frame rather than
    // once per raw pointermove (which can fire far faster than the screen repaints). Skipped for a
    // flow frame — the applyLayouts()+paintAll() above already repaints the whole subtree.
    else if ((north || west) && !subtreeRAF) subtreeRAF = requestAnimationFrame(() => {
      subtreeRAF = null;
      for (const id of subtreeIds(n.id)) { const k = state.nodes.get(id); if (k) paintNode(k); }
    });
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (subtreeRAF) { cancelAnimationFrame(subtreeRAF); subtreeRAF = null; }
    resize(snap);   // snap to the grid on release, like a dropped card
    // Back at (or under) the natural width → drop the authored width entirely rather than persisting
    // a redundant mm_w on every card the user so much as nudges. For an annotation that also restores
    // its shrink-to-fit sizing, which an explicit width would otherwise pin forever.
    if (!sizeH && n.w != null && Math.round(n.w) <= minW) n.w = undefined;
    // paint BEFORE laying out: a width-only node's height (and a stack's title-row header, which is
    // measured) only matches the snapped width once the DOM has it — see prepRow in view/layout.ts.
    paintNode(n);
    shiftAnnos();        // settle the latched annotations against the snapped edges
    // NB a west/north drag also moves this node's own x/y, which restales every CHILD's persisted
    // offset — commitRel handles that centrally for every mover, so there's nothing to do here.
    applyLayouts(); paintAll(); scheduleSave(); commitStep();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
export function paintAll(): void {
  for (const n of state.nodes.values()) paintNode(n);
  paintEdges();
  updateEmptyHints();
  renderOutline();   // keep the outline list in sync (no-op while the canvas view is active)
}

// First-run hints ("Drag to create a card" / "Click for help") show only on an empty canvas.
// The help hint tracks the (centred, variable-x) help button; the ghost hint is CSS-anchored.
export function updateEmptyHints(): void {
  document.body.classList.toggle('empty-canvas', state.nodes.size === 0);
}

// ---------- animated relayout (expand / collapse) ----------
function prefersReducedMotion(): boolean { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
// The animation writes left/top itself (that's what it interpolates), so it must go through the SAME
// placement authority paintNode's own final branch uses — placeSelf + elTop — not a bare place():
//   · elTop, or a frame's element parks at its BOUNDS top instead of one tab lower, so mid-animation
//     the box sat up over its own tab band. Since the box paints after the strip (tree order, see
//     tabStripEl), on a tab GROUP that meant a big empty box drawn straight over its tabs, which is
//     what "the tabs disappear while it animates" actually was.
//   · placeSelf, or a docked TAB's label gets re-parented out of its group's strip for the duration
//     and lands at world coords, nowhere near the band it belongs to.
function placeNodeEl(n: MindNode): void { if (n.el) placeSelf(n, n.x, elTop(n, n.y)); }
function setNodeElXY(n: MindNode, x: number, y: number): void { if (n.el) placeSelf(n, x, elTop(n, y)); }
// Newly revealed cards emanate from the nearest ancestor that was already on screen.
function ancestorStart(node: MindNode, before: Map<string, Pt>): Pt {
  let p = node.parent ? state.nodes.get(node.parent) : null;
  while (p){ const b = before.get(p.id); if (b) return b; p = p.parent ? state.nodes.get(p.parent) : null; }
  return { x: node.x, y: node.y };
}
// Cards glide to new spots via a CSS transition; SVG edges can't transition, so for the duration
// we redraw them each frame from the cards' live (animating) on-screen positions.
function followEdges(tok: number, ms: number): void {
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (tok !== ui.animToken) return;                  // superseded by a newer animation
    const saved: [MindNode, number, number][] = [];
    for (const n of state.nodes.values()){
      if (!n.el || isHidden(n)) continue;
      // A docked tab's left/top are strip-relative, not host-relative — and its label is never an edge
      // endpoint anyway (a container draws no edge to its children, and its group's own edge comes off
      // the group), so there's nothing to project: leave its position alone.
      if (isDockedTab(n)) continue;
      const c = getComputedStyle(n.el);             // interpolated left/top while transitioning
      saved.push([n, n.x, n.y]);
      // left/top are HOST-relative for a hosted card — project back to absolute world coords, through
      // the same origin place() measured them from (contentOrigin, on its no-drag basis).
      const host = settledHost(n);
      const o = host ? frameInterior(host) : null;
      const px = parseFloat(c.left), py = parseFloat(c.top);
      n.x = px ? (o ? px + o.x : px) : n.x;
      // boundsTop as well: `top` holds a frame's BOX top, while n.y is its bounds (tab) top.
      n.y = py ? boundsTop(n, o ? py + o.y : py) : n.y;
    }
    paintEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }   // restore logical (final) positions
    if (now - t0 < ms) requestAnimationFrame(tick); else paintEdges();
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
// Run a structural change (a collapse toggle) and CSS-animate the resulting reflow.
function withLayoutAnimation(mutate: () => void): void {
  const before = layoutSnapshot();
  mutate();
  paintAll();          // reveal/hide DOM and measure real heights
  applyLayouts();      // compute FINAL positions into n.x/n.y (DOM not updated yet)
  // Paint again: a container that AUTO-SIZES only learns its new box in the pass above, and the
  // first paint wrote the pre-toggle one. animateReflow moves elements' left/top but never their
  // size, so a stack stayed at its collapsed height while its revealed rows spilled out of the box
  // until some later, unrelated repaint happened to fix it. Harmless for the animation: the parking
  // step below immediately rewrites every position before the browser gets a chance to paint.
  paintAll();
  animateReflow(before);
}
// CSS-animate every visible card from its snapshotted `before` spot to its current (final)
// n.x/n.y. Just-revealed cards (absent from `before`) fade in from their nearest ancestor.
function animateReflow(before: Map<string, Pt>): void {
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++ui.animToken;                           // supersede any in-flight animation
  if (prefersReducedMotion()){ for (const m of visible){ m.el!.classList.remove('lt-anim'); placeNodeEl(m); } paintEdges(); return; }
  // 1) park every visible card at its STARTING spot with no transition; just-revealed cards
  //    also start invisible so they fade in (covers free layouts where nothing reflows)
  for (const m of visible){
    m.el!.classList.remove('lt-anim');
    const s = before.get(m.id) || ancestorStart(m, before);
    setNodeElXY(m, s.x, s.y);
    if (!before.has(m.id)) m.el!.style.opacity = '0';
  }
  void document.body.offsetWidth;                    // commit the start positions before transitioning
  // 2) turn on the transition and move every card to its FINAL spot → the browser animates left/top
  const DUR = 320;
  for (const m of visible){ m.el!.classList.add('lt-anim'); placeNodeEl(m); m.el!.style.opacity = ''; }
  // 3) edges follow the moving cards; drop the transition class once it's done
  followEdges(tok, DUR + 20);
  setTimeout(() => { if (tok !== ui.animToken) return; for (const m of visible) m.el && m.el.classList.remove('lt-anim'); paintEdges(); }, DUR + 60);
}

// ---------- edge style (straight / orthogonal / bezier), persisted ----------
const EDGE_KEY = 'mindmap.edgeStyle';
const EDGE_STYLES: EdgeStyle[] = ['orthogonal', 'bezier', 'straight'];
const EDGE_ICONS: Record<EdgeStyle, string> = { straight: edgeStraightIcon, orthogonal: edgeOrthogonalIcon, bezier: edgeBezierIcon };
// The toolbar button shows the ACTIVE style's icon (not a generic one); clicking cycles.
function updateEdgeIcon(): void {
  const span = document.querySelector('#edgeBtn .ic');
  if (span) span.innerHTML = EDGE_ICONS[state.edgeStyle];
  const btn = document.getElementById('edgeBtn');
  if (btn) btn.title = `Edge style: ${state.edgeStyle} — click to cycle`;
}
function initEdgeStyle(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(EDGE_KEY); } catch {}
  if (saved && (EDGE_STYLES as string[]).includes(saved)) state.edgeStyle = saved as EdgeStyle;
  updateEdgeIcon();
}
function cycleEdgeStyle(): void {
  const i = EDGE_STYLES.indexOf(state.edgeStyle);
  state.edgeStyle = EDGE_STYLES[(i + 1) % EDGE_STYLES.length];
  try { localStorage.setItem(EDGE_KEY, state.edgeStyle); } catch {}
  updateEdgeIcon();
  paintEdges();
  setStatus(`Edge style: ${state.edgeStyle}`);
}
initEdgeStyle();

// Toggle one node's collapse: folds it down to just its title — hides its body and, if it has
// children, folds them (and everything below) too. A leaf with a body can fold its body alone.
// Open one tab of a group: expand it and close every sibling — the "exactly one open tab" invariant
// as an ACTION (normalizeTabs is the same rule as a repair). Every way of opening a tab funnels here:
// clicking its label, the collapse toggle on a docked tab, and (later) revealing a search hit inside a
// closed one. Re-opening the tab that's already open is a no-op, not a fold — a tab has no folded
// state of its own to toggle into.
// Allowed on a LOCKED tab, unlike the edits a lock protects against: which tab is open is how you look
// at the box, not a change to what's in it — a locked tab you can't even open would just be unreachable.
export function activateTab(t: MindNode): void {
  const g = tabGroupOf(t); if (!g) return;
  const tabs = tabsOf(g);
  if (!t.collapsed && tabs.every(k => k === t || k.collapsed)) return;   // already the open one
  record(tabs.map(k => k.id), () => withLayoutAnimation(() => openTabFlags(t)));
  scheduleSave();
  setStatus(`Tab “${t.title}”`);
}
// The flag half of "open this tab": expand it, close its siblings. No history, save or paint of its
// own, so a caller that has several to open — a reveal walking a chain of nested closed tabs — can
// batch them into ONE undo step (see focusNode). Returns whether anything actually changed.
function openTabFlags(t: MindNode): boolean {
  const g = tabGroupOf(t); if (!g) return false;
  let changed = false;
  for (const k of tabsOf(g)) {
    const want = k !== t;
    if (k.collapsed !== want) { touch(k.id); k.collapsed = want; k.dirty = true; changed = true; }
    k.dirtyLayout = true;
  }
  return changed;
}
export function toggleCollapse(id: string): void {
  const n = state.nodes.get(id); if (!n) return;
  // A docked tab doesn't fold — it OPENS, closing its siblings (there's always exactly one open tab).
  // Before the lock check: opening a tab is allowed even when it's locked (see activateTab).
  if (isDockedTab(n)) { activateTab(n); return; }
  if (isLockedEffective(n)) { setStatus('Locked — can’t collapse/expand'); return; }
  const hasKids = childrenOf(n.id).length > 0;
  const hasBody = !!(n.body && n.body.trim());
  if (!hasKids && !hasBody) return;   // nothing to fold: no children and no body
  // animate the reflow; withLayoutAnimation paints, measures heights, and lays out the children
  record([id], () => withLayoutAnimation(() => { n.collapsed = !n.collapsed; n.dirtyLayout = true; }));
  scheduleSave();
  // Name the thing the user can SEE: for a tab group that's its open tab either way round — folded it's
  // the label on the pill (foldedTab), open it's the tab holding the box — never the group's own
  // bookkeeping title, which appears nowhere on the canvas.
  const shown = isTabsFrame(n) ? (activeTab(n) ?? n) : n;
  setStatus(n.collapsed ? `Collapsed “${shown.title}”` : `Expanded “${shown.title}”`);
}
// Fold/unfold a whole set of cards together (double-clicking one card of a multi-selection).
// Only foldable cards (children or a body) count; the group lands on one shared state — expand
// if they're all collapsed already, otherwise collapse them all.
export function toggleCollapseSelection(ids: Iterable<string>): void {
  const cards = [...ids].map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n)
    // A docked tab has no fold of its own (it opens, closing its siblings — see activateTab), and a
    // group fold that closed every tab at once would just be repaired by normalizeTabs anyway. But an
    // OPEN tab stands for its GROUP, exactly as its corner chip does (chipTarget) — and since the box
    // now hands its selection to that tab (selTarget), this is X's ONLY route to folding a group. A
    // CLOSED tab drops out: its contents are one click away in the box, so it has nothing to fold.
    .map(n => (isDockedTab(n) && !n.collapsed ? tabGroupOf(n) ?? n : n))
    .filter(n => !isDockedTab(n))
    .filter(n => !isLockedEffective(n))
    .filter(n => childrenOf(n.id).length > 0 || !!(n.body && n.body.trim()));
  if (!cards.length) return;
  const target = !cards.every(n => n.collapsed);   // all collapsed → expand; otherwise collapse all
  record(cards.map(n => n.id),
    () => withLayoutAnimation(() => { for (const n of cards){ n.collapsed = target; n.dirtyLayout = true; } }));
  scheduleSave();
  setStatus(`${target ? 'Collapsed' : 'Expanded'} ${cards.length} card${cards.length > 1 ? 's' : ''}`);
}
// ---------- arrow-key navigation (walk + fold the tree from the keyboard) ----------
// TREE semantics, deliberately not geometric: → always goes DEEPER (expanding first if the branch
// is folded), ← always goes SHALLOWER (collapsing first if it's open), ↑/↓ walk siblings. Screen
// direction would be ambiguous the moment a node has children on two sides at once — which a fan
// layout does by default, since each child's side is its own stored mm_side — whereas "deeper /
// shallower" is never ambiguous. Same direction as X and the outline view.
//
// Siblings come from orderedKids (view/layout.ts), so ↑/↓ walk them in exactly the order the
// outline lists them and the layout stacks them, not in state.nodes insertion order.
function navSiblings(n: MindNode): MindNode[] {
  const p = n.parent ? state.nodes.get(n.parent) : null;
  // roots have no parent to hold a kidOrder — rootsInOrder is what stands in for orderedKids there,
  // and it's the same list the outline's top level reads, so the two walks can't drift apart.
  return p ? orderedKids(p, childrenOf(p.id).filter(k => !isHidden(k))) : rootsInOrder();
}
// Select `to` and pan just far enough to bring it on screen — never reframing or re-zooming the way
// focusNode does, so walking a long branch doesn't make the map jump at every step.
function navTo(to: MindNode | undefined): void {
  if (!to || !isSelectable(to.id)) return;
  selectNode(to.id);
  revealInView(to);
}
// One arrow keypress against the current primary selection. A multi-selection collapses to its
// anchor (state.selId) and the walk continues from there, like a caret in a text editor.
function navArrow(key: string): void {
  const n = state.selId ? state.nodes.get(state.selId) : null;
  // nothing selected → the first root is the way in (↑/← pick the last one, so the key's direction
  // still reads sensibly when the walk starts)
  if (!n) {
    const roots = rootsInOrder(m => isSelectable(m.id));
    navTo(roots[(key === 'ArrowUp' || key === 'ArrowLeft') ? roots.length - 1 : 0]);   // navTo ignores undefined
    return;
  }
  const kids = childrenOf(n.id);
  if (key === 'ArrowRight') {
    // folded (or a closed tab, which toggleCollapse OPENS) → reveal; already open → step into it
    if (kids.length && n.collapsed) { toggleCollapse(n.id); return; }
    if (kids.length) navTo(orderedKids(n, kids.filter(k => !isHidden(k)))[0]);
    return;
  }
  if (key === 'ArrowLeft') {
    // open branch → fold it; leaf or already folded → step out to the parent
    if (kids.length && !n.collapsed && !isDockedTab(n)) { toggleCollapse(n.id); return; }
    // Stepping out of a docked TAB skips its group: the group can't hold the selection (selTarget
    // hands it straight back to this very tab), so the node one level out is whatever the GROUP hangs
    // under — otherwise the key would look dead.
    const outId = isDockedTab(n) ? (tabGroupOf(n)?.parent ?? null) : n.parent;
    navTo(outId ? state.nodes.get(outId) : undefined);
    return;
  }
  const sibs = navSiblings(n);
  const i = sibs.findIndex(s => s.id === n.id);
  if (i < 0) return;
  navTo(sibs[i + (key === 'ArrowDown' ? 1 : -1)]);
}
// Flip a checklist item's done mark (mm_done) and persist. Independent of any body task list.
// Also repaints the parent so its "n/m" checklist progress readout stays in sync.
// Exported: the outline row list shows the same donebox/progress readout (features/outline.ts).
export function toggleDone(n: MindNode): void {
  if (state.readOnly || isLockedEffective(n)) return;
  record([n.id], () => { n.done = !n.done; n.dirty = true; });
  paintNode(n);
  if (n.parent){ const p = state.nodes.get(n.parent); if (p) paintNode(p); }
  scheduleSave();
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


// Focus a card: un-collapse hiding ancestors (and, when openTarget, the card itself), select
// it, frame it + all its visible descendants. Ancestors are expanded shallowest-first with a
// layout pass after EACH level, so every newly revealed level lays out on the already-settled
// positions above it — expanding a nested chain in one shot mis-spaces the shallow branches.
export function focusNode(target: MindNode | undefined, openTarget = false): void {
  if (!target) return;
  const before = layoutSnapshot();             // pre-reveal frame to glide away from
  const toReveal: MindNode[] = [];
  for (let p = target.parent ? state.nodes.get(target.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    toReveal.push(p);
  toReveal.reverse();                          // root → immediate parent (shallowest first)
  if (openTarget) toReveal.push(target);       // open the card itself last (deepest level)
  let revealed = false;
  record(toReveal.map(n => n.id), () => {
    for (const n of toReveal){
      // A closed TAB doesn't expand, it OPENS — closing its siblings. Expanding it like an ordinary
      // branch would leave two tabs open, and the next layout pass (normalizeTabs) would close one of
      // them again, which for a hit buried in a later tab means the reveal quietly does nothing.
      if (isDockedTab(n)) {
        if (openTabFlags(n)) { revealed = true; paintAll(); applyLayouts(); }
        continue;
      }
      if (!n.collapsed) continue;
      n.collapsed = false; n.dirtyLayout = true; revealed = true;
      paintAll(); applyLayouts();              // settle this level before revealing the next
    }
  });
  selectNode(target.id);                       // select → the card shows its full body (grows)
  applyLayouts(); paintAll();                  // reflow siblings around the now-taller selection
  animateReflow(before);                       // one glide from the pre-reveal frame to the final
  frameBox(subtreeIds(target.id).map(id => state.nodes.get(id)));
  if (revealed && store.isOpen) scheduleSave();
}
// Follow a [[wikilink]]: find the node by title (case-insensitive) and focus it.
function focusByTitle(title: string): void {
  const t = title.trim().toLowerCase();
  const target = [...state.nodes.values()].find(n => n.title.trim().toLowerCase() === t);
  if (!target){ setStatus(`No node titled “${title}” in this map`); return; }
  focusNode(target);
}
// The "focus" command (toolbar button + F): frame the selected card (+ its subtree), or
// frame the whole map when nothing is selected — both glide with the same easing.
function focusOrFit(): void {
  if (state.selId && state.nodes.has(state.selId)) focusNode(state.nodes.get(state.selId));
  else frameBox([...state.nodes.values()], true);   // frame the whole map — strokes included
}

// ---------- selection + editor ----------
// Selection and the edit panel are decoupled: a node can stay selected while the
// panel is closed (press Esc). That closed-but-selected state is when Delete works.

// colour palette (keys match the .c-* CSS classes); 'grey' is the old neutral "none" look.
// The hexes themselves live in ONE place — the --pal-* custom properties in styles.css's
// :root/body.light — so CSS (.c-*, #ghostCard) and JS (edges/backgrounds fills, swatch dots
// below) can never drift apart. Read from document.body (not documentElement) so the
// body.light overrides are picked up; re-read on every theme toggle (see refreshPalette).
export const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey','white','black'];
const pal = (name: string): string => getComputedStyle(document.body).getPropertyValue(`--pal-${name}`).trim();
const SWATCH_KEYS = PALETTE;
export const SWATCH_BG: Record<string, string> = Object.fromEntries(SWATCH_KEYS.map(c => [c, pal(c)]));
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
function deriveInk(): void {
  inkStyle.textContent = ':root{' + SWATCH_KEYS.map(c => {
    const bg = SWATCH_BG[c] ?? '';
    return `--pal-ink-${c}:${inkFor(bg)};--pal-scrim-${c}:${scrimFor(bg)};`;
  }).join('') + '}';
}
deriveInk();
// ---------- a colour VALUE: a palette key, or an authored hex ----------
// `n.color` (and so effectiveColor's result) is one of: '' (inherit), 'none', a PALETTE KEY, or a
// custom '#rrggbb' picked from the colour popover. These three resolve any of them, and every
// consumer goes through them so "custom" never needs a branch of its own:
//   colorFill  — the hex it paints as, for the things JS tints itself (edges, --frame-stroke).
//                null for 'none'/inherit/unknown, which callers already fall back to --edge for.
//   colorClass — the CSS class to hang on the element. A hex can't be a class name (and there'd be
//                nowhere to put its hexes), so a custom colour gets .c-custom + inline variables…
//   colorVars  — …which are those variables: the same --card/--ink/--scrim triple a .c-* class
//                provides, just computed per node instead of once per palette key. Everything
//                downstream keys off the variables alone, so a custom colour behaves exactly like a
//                palette one — including a coloured stack's step-down and the :not(.c-none) tests.
// One inline declaration per coloured node is affordable where a generated stylesheet isn't: the set
// of custom colours in a map is open-ended, and a node's own style attribute is already written on
// every paint.
export function colorFill(c: string): string | null { return SWATCH_BG[c] ?? (isHexColor(c) ? c : null); }
export function colorClass(c: string): string { return isHexColor(c) ? 'c-custom' : 'c-' + c; }
export function colorVars(c: string): string {
  return isHexColor(c) ? `--card:${c};--ink:${inkFor(c)};--scrim:${scrimFor(c)}` : '';
}
// The element form of colorVars: SET for a custom colour, REMOVED otherwise. Removing matters —
// recolouring a custom card back to a palette key has to drop the inline triple, or it would keep
// overriding the .c-* class that now owns the colour (an inline custom property beats any selector).
export function applyColorVars(el: HTMLElement, c: string): void {
  const custom = isHexColor(c);
  for (const [prop, val] of [['--card', c], ['--ink', custom ? inkFor(c) : ''], ['--scrim', custom ? scrimFor(c) : '']] as const) {
    if (custom) el.style.setProperty(prop, val); else el.style.removeProperty(prop);
  }
}
// After a theme switch: re-read the palette hexes, re-derive their inks, and repaint everything that
// bakes them in as literal hex (edges, swatches). The two themes now SHARE one --pal-* set, so the
// re-read is a no-op in practice — kept because it costs nothing and keeps this correct if a theme
// ever overrides a colour again. The repaint is not optional either way: what still differs per theme
// is effectiveColor's own fallback (an uncoloured card, an annotation's default) and .c-none's ink.
export function refreshPalette(): void {
  for (const c of SWATCH_KEYS) SWATCH_BG[c] = pal(c);
  deriveInk();
  refreshSwatches();
  paintAll();
}
// the ids currently being edited (one or many) — colour/layout/checklist/bg apply to all of them
export function selectedIds(): string[] { return state.sel.size ? [...state.sel] : (state.selId ? [state.selId] : []); }
// reflect state.sel in the canvas + the floating edit bar (features/float-bar.ts)
export function applySelection(): void { paintAll(); syncFloatBar(); syncUrl(); updateDocumentTitle(); }
// A descendant of a locked card can't be selected at all — the locked card itself still can be
// (see utils/model.ts hasLockedAncestor). Shared by every selection entry point below.
function isSelectable(id: string): boolean {
  const n = state.nodes.get(id); return !n || !hasLockedAncestor(n);
}
// A tab GROUP is not something the user selects — from their side there are just tabs, one of them
// open. So every selection entry point below maps an open group to its OPEN TAB (the same redirect
// actionTarget already spells for colour/rename/delete): clicking the box selects the tab whose
// contents fill it, so the float bar shows that TAB's kind/layout/colour rather than a "group"
// nobody asked for — which is also why the layout picker no longer needs a `tabs` chip (tabs are
// made and unmade by dragging; see features/float-bar.ts). Nothing the box visibly owns is lost:
// the two ring as one shape (selJoin) and both the interior drag (features/drag.ts) and the resize
// handles key off that, so the box still moves and resizes with its open tab selected.
// A FOLDED group is left alone — it's a lone pill with no tab on screen, and selecting it is the
// only way to move it.
function selTarget(id: string): string {
  const n = state.nodes.get(id);
  return n ? actionTarget(n).id : id;
}
// Replace the whole selection with `ids` (a Set or array), recomputing the primary.
export function setSelectionSet(ids: Iterable<string>): void {
  state.sel = new Set([...ids].map(selTarget).filter(isSelectable));
  if (state.sel.size === 0) state.selId = null;
  else if (state.sel.size === 1) state.selId = [...state.sel][0];
  else if (!state.selId || !state.sel.has(state.selId)) state.selId = [...state.sel].pop() ?? null;
  applySelection();
}
// ⌘/Ctrl-click: add or remove one card from the selection.
export function toggleSel(rawId: string): void {
  const id = selTarget(rawId);
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
const roBtn = byId('roBtn');
// open padlock (unlocked); the closed one is LOCK_BADGE_SVG up top — one glyph shared by the
// locked-card badge, the float bar's lock toggle (features/float-bar.ts) and this button.
export const ICON_LOCK_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;
export function applyReadOnly(): void {
  const ro = state.readOnly;
  document.body.classList.toggle('readonly', ro);
  roBtn.classList.toggle('locked', ro);          // red when locked
  roBtn.innerHTML = ro ? LOCK_BADGE_SVG : ICON_LOCK_OPEN;
  roBtn.title = ro ? 'Read-only — click to unlock & edit (R)' : 'Lock to read-only (R) — view & collapse only';
  // ghost card visibility is driven by body.readonly CSS rule
  updateUndoButtons();
  syncFloatBar();
  setStatus(ro ? 'Read-only — nothing is saved' : 'Editing enabled');
  scheduleUrlSync();
}
applyReadOnly();   // set the initial open-padlock icon
async function setReadOnly(on: boolean): Promise<void> {
  if (on === state.readOnly) return;
  if (on){
    await flushSave();                                   // persist anything pending before locking (clears the save timer)
    state.readOnly = true;
    // sketching stays available in read-only, but any strokes made there are in-memory only:
    // leaving read-only reloads sketch.json below, discarding them (like the collapse state).
    selectNode(null);                                    // close any open edit
  } else {
    state.readOnly = false;
    if (store.isOpen) await loadFromDir({ keepView:true }); // discard in-memory collapses, restore disk state
  }
  applyReadOnly();
}
roBtn.onclick = () => setReadOnly(!state.readOnly);

// Select exactly one node (or clear with null), replacing any multi-selection.
export function selectNode(rawId: string | null): void {
  if (rawId == null){ state.sel.clear(); state.selId = null; }
  else {
    const id = selTarget(rawId);
    if (!isSelectable(id)) return;
    state.sel = new Set([id]); state.selId = id;
  }
  applySelection();
}
// Colour / checklist / group-background / layout all apply live via the floating bar
// (features/float-bar.ts). The TITLE and BODY are edited on the canvas (F2 / double-click → inline edit).


// ---------- image attachments live in features/attachments.ts ----------
// ---------- inline title/body editing lives in features/inline-edit.ts ----------
// While a title is being renamed inline, the save loop defers the file rename until editing ends
// (so the folder isn't littered with M.md, Ma.md, Mag.md…) — it keys off `ui.inlineEdit` directly.

// keyboard:
//  · Space          → new node at the pointer (only when nothing is selected)
//  · Enter          → add a sibling of the selected node
//  · Tab            → add a child of the selected node
//  · F2             → rename the selected node in place (also: double-click its title)
//  · X              → collapse/eXpand the selected node(s) (also: the corner chip)
//  · ← → ↑ ↓        → walk the tree: →/← go deeper/shallower (folding on the way), ↑/↓ walk siblings
//  · E              → edit the selected node's note/body in place (also: double-click the body)
//  · Delete/Backspace → delete the selected node (only when the edit panel is closed)
// A focused title editor (the sidebar field OR an in-card inline rename) counts as "typing",
// so these card shortcuts stay out of the way while you're naming something.
window.addEventListener('keydown', (e) => {
  // F1 opens the bundled help mindmap (read-only) in a new tab — works even while typing.
  if (e.key === 'F1'){ e.preventDefault(); openHelpTab(); return; }

  // Intercept browser zoom shortcuts (Cmd/Ctrl +/-/0) so they drive the canvas, not the viewport.
  // Must be checked before the `typing` guard so they work even while a text field is focused.
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomAt(window.innerWidth/2, window.innerHeight/2, 1.2); return; }
    if (e.key === '-')                  { e.preventDefault(); zoomAt(window.innerWidth/2, window.innerHeight/2, 1/1.2); return; }
    if (e.key === '0')                  { e.preventDefault(); focusOrFit(); return; }
  }

  const active = document.activeElement as HTMLElement | null;
  const typing = isTypingInField();
  // Esc blurs the active field (so Delete works next), or deselects when not typing.
  if (e.key === 'Escape'){
    e.preventDefault();
    if (typing) { active?.blur?.(); }
    else if (state.sel.size) selectNode(null);
    return;
  }
  if (typing) return;
  // ←→↑↓ walk / fold the tree (navArrow). Canvas only: the outline view is its own tree widget with
  // its own fold state (outlineFold), so arrows there are a separate concern. No modifiers — ⇧/⌘
  // arrow combinations are left free for the browser and for later (extend-selection).
  if (e.key.startsWith('Arrow') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !outlineActive()){
    e.preventDefault(); navArrow(e.key); return;
  }
  if (e.key === 'r' || e.key === 'R'){ e.preventDefault(); setReadOnly(!state.readOnly); return; }
  if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey){ e.preventDefault(); if (!outlineActive()) toggleSketchMode(); return; }   // Sketch mode (canvas only)
  if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey){ e.preventDefault(); toggleOutlineView(); return; }   // Outline view
  if (e.key === '/'){ e.preventDefault(); openSearch(); return; }   // find a card
  // Space = hand-tool to pan while held; a quick tap (released without panning) makes a node.
  if (e.key === ' '){ e.preventDefault(); if (!e.repeat){ ui.spaceHeld = true; ui.spaceUsedForPan = false; } return; }
  if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); focusOrFit(); return; }
  if ((e.key === 'd' || e.key === 'D') && state.sel.size){ e.preventDefault(); duplicateSelection(); return; }
  if ((e.key === 'a' || e.key === 'A') && e.shiftKey && !e.metaKey && !e.ctrlKey && state.sel.size){ e.preventDefault(); autoSizeSelection(); return; }   // ⇧A: auto-size selected frames to fit
  if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey && state.sel.size){ e.preventDefault(); groupSelectionIntoFrame(); return; }   // G: group selection into a frame
  // A -> create an annotation at the cursor (mirrors Space's new-card tap). If a card is selected
  // the annotation becomes its child; otherwise it's a root. ⇧A is auto-size (handled just above).
  if ((e.key === 'a' || e.key === 'A') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !outlineActive()){
    e.preventDefault();
    const p = ui.lastMouse ? screenToWorld(ui.lastMouse.x, ui.lastMouse.y) : screenToWorld(window.innerWidth/2, window.innerHeight/2);
    createAnnotationHere(p.x - 80, p.y - 16);
    return;
  }
  // ⌘/Ctrl C / X copy / cut the selected cards (with their subtrees). No ⌘V handler here —
  // the native `paste` event (features/attachments.ts) carries clipboardData permission-free.
  if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey) && state.sel.size){
    e.preventDefault(); void copySelection(); return;
  }
  if ((e.key === 'x' || e.key === 'X') && (e.metaKey || e.ctrlKey) && state.sel.size){
    e.preventDefault(); void cutSelection(); return;
  }
  if ((e.key === 'x' || e.key === 'X') && state.sel.size && !e.metaKey && !e.ctrlKey){   // don't shadow cut
    e.preventDefault(); toggleCollapseSelection(state.sel); return;
  }
  if ((e.key === 'l' || e.key === 'L') && state.sel.size && !e.metaKey && !e.ctrlKey && !state.readOnly){
    e.preventDefault();
    setLockedSelection(state.sel, !anyLocked(state.sel));
    return;
  }
  // image cards have no title/body UI to rename or edit — they're a leaf that shows only the image
  if (e.key === 'F2' && state.selId && !isImageCard(state.nodes.get(state.selId))){
    e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return;   // selId guards non-null
  }
  if ((e.key === 'e' || e.key === 'E') && state.selId && !e.metaKey && !e.ctrlKey){
    e.preventDefault(); const n = state.nodes.get(state.selId); if (n && !isImageCard(n) && !isQueryCard(n)) startBodyEdit(n); return;
  }
  if (e.key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  if (e.key === 'Tab' && state.selId){ e.preventDefault(); addChild(state.selId); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && e.altKey && state.sel.size){
    e.preventDefault(); deleteSelectionKeepChildren(); return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel.size){
    e.preventDefault(); deleteSelection();
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
  if (isTypingInField() || wasPan || ui.pan || state.sel.size !== 0) return;
  if (outlineActive()) return;   // no invisible cards onto the hidden canvas
  if (ui.lastMouse){         // tap = new card under the cursor (centre when the mouse hasn't moved yet)
    createNode(centredAt(screenToWorld(ui.lastMouse.x, ui.lastMouse.y)));
  } else createNode();
});

// Ghost-card drag: grab the corner card to spawn a new note that rides the cursor through the same
// move/reparent machinery as dragging an existing card — so the landing-ghost preview, child/sibling
// drop zones and managed-layout snapping all behave identically. Releasing back on the ghost cancels.
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
    endInlineEdit(); endBodyEdit();         // grabbing the ghost commits any in-progress edit
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
byId('fitBtn').onclick = focusOrFit;
byId('edgeBtn').onclick = cycleEdgeStyle;
byId('homeBtn').onclick = showStart;   // icon + folder name → home screen
byId('helpBtn').onclick = openHelpTab;  // same as F1 — opens the help mindmap in a new tab

// (rename/duplicate/export/delete on-screen actions now live in the floating bar's kebab menu —
// features/float-bar.ts)

// keyboard shortcuts: ⌘S force-save, ⌘Z/⇧⌘Z/⌘Y undo-redo  (duplicate = D, new node = Space)
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); flushSave(); return; }
  // While typing in a field, leave ⌘Z to the browser's native undo inside that editor.
  if (k === 'z' && !isTypingInField()) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (k === 'y' && !isTypingInField()) { e.preventDefault(); redo(); }
});


boot();   // local-first: open straight into the last map
