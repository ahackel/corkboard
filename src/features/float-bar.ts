// The floating selection bar over the selected card; on NARROW_MQ widths CSS docks it to the bottom.
import { state, stage, world, setStatus, singleNoteRefuses, isImageCard, isStack, type MindNode } from '../core/state.js';
import { NARROW_MQ, ui, canvasMoving } from '../core/ui-state.js';
import { touch } from './history.js';
import { mutate } from './mutate.js';
import { subtreesBox, isSection } from '../view/layout.js';
import { createProperties, type PropertyControls } from './properties.js';
import { startInlineEdit, startBodyEdit, editSectionTitle } from './inline-edit.js';
import { settleSections } from './drop.js';
import { fitAround } from '../utils/placement.js';
import { duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, mkNode, nextSectionTitle } from './crud.js';
import { exportSelection, shareSelection, canShareFiles, copySelection, copyFormatted, cutSelection } from './clipboard.js';
import { pasteFromClipboard } from './attachments.js';
import { canTidy, tidyMenuEntries, canTidySection, tidySection } from './tidy.js';
import { openMenu, copyFilePath, type MenuEntry } from './context-menu.js';
import { childrenOf, isLockedEffective, subtreeHasLocked, nodesOf } from '../utils/model.js';
import { canOpen, canEnter } from '../nav/scope.js';
import { labelEl } from '../render.js';
import { animateLayout } from '../layout-anim.js';
import { byId, placeInViewport, placePopover, closeOnOutside, safeInsets, keys } from '../utils/dom.js';
import { canFold, canToggleFold, gridSnap, SECTION_W, SECTION_H } from '../view/geometry.js';
import { MIN_SECTION_W, MIN_SECTION_H } from '../view/geometry.js';
import { toggleCollapse, toggleCollapseSelection } from './fold.js';
import { openSection } from '../nav/sections.js';
import { LOCK_BADGE_SVG, ICON_LOCK_OPEN } from '../view/icons.js';
import { selectedIds, selectNode } from './selection.js';
import { setLockedSelection, anyLocked } from './lock.js';
import { hasStackSelected, stackToSection } from './stacks.js';

const bar = byId('floatBar');
const fbColor = byId<HTMLButtonElement>('fbColor');
const fbColorDot = byId('fbColorDot');
const fbLock = byId<HTMLButtonElement>('fbLock');
const fbTidy = byId<HTMLButtonElement>('fbTidy');
const fbOpen = byId<HTMLButtonElement>('fbOpen');
const fbFit = byId<HTMLButtonElement>('fbFit');
const fbTidySection = byId<HTMLButtonElement>('fbTidySection');
const fbFold = byId<HTMLButtonElement>('fbFold');
const fbTitle = byId<HTMLButtonElement>('fbTitle');
const fbWrap = byId<HTMLButtonElement>('fbWrap');
const fbUngroup = byId<HTMLButtonElement>('fbUngroup');
const fbToSection = byId<HTMLButtonElement>('fbToSection');
const colorPop = byId('fbColorPop');
const edColors = byId('edColors');

let props: PropertyControls;

// The label hangs outside the box, so the margin is the same on all four sides.
export const SECTION_FIT_PAD = 16;
const MIN_SECTION_SIZE = { w: MIN_SECTION_W, h: MIN_SECTION_H };

// Children keep their positions; the box moves to enclose them. Childless: unchanged, or default-sized.
export function fitSectionToContent(n: MindNode, orDefault = false): void {
  const fit = fitAround(subtreesBox(childrenOf(n.id)), SECTION_FIT_PAD, gridSnap(), MIN_SECTION_SIZE);
  if (fit) {
    Object.assign(n, fit);
  } else if (orDefault) {
    n.w = SECTION_W; n.h = SECTION_H;
  }
}

// A table is the one thing in a note that needs width rather than wrapping, so FIT widens to it.
const TABLE_FIT_W = 960;

// The width a card's unwrapped tables want, or 0 when they fit as is.
function tableFitW(n: MindNode): number {
  const body = n.el?.querySelector<HTMLElement>('.body');
  const tables = body ? [...body.querySelectorAll('table')] : [];
  if (!body || !tables.length || n.collapsed) {
    return 0;
  }
  let natural = 0;
  for (const t of tables) {
    const was = t.className;
    t.className = '';
    t.style.width = 'max-content';
    natural = Math.max(natural, t.offsetWidth);
    t.style.width = '';
    t.className = was;
  }
  const extra = natural - body.clientWidth;
  if (extra <= 1) {
    return 0;
  }
  const step = gridSnap();
  const w = Math.min(TABLE_FIT_W, Math.ceil(((n.w ?? n.el!.offsetWidth) + extra) / step) * step);
  return w > (n.w ?? n.el!.offsetWidth) ? w : 0;
}

function canFit(n: MindNode): boolean {
  if (isLockedEffective(n)) {
    return false;
  }
  return isSection(n) || (!isImageCard(n) && !isStack(n) && (n.h != null || tableFitW(n) > 0));
}

// FIT (↔, ⌥⇧⌘R, "Resize to fit"): sections hug their cards; cards drop their authored height and widen
// to their tables. Only ever on request.
export function autoSizeSelection(): void {
  const ids = selectedIds().filter(id => { const n = state.nodes.get(id); return !!n && canFit(n); });
  if (!ids.length) {
    return;
  }
  mutate(ids, () => animateLayout(() => {
    for (const id of ids){
      const n = state.nodes.get(id);
      if (!n) {
        continue;
      }
      if (n.type === 'section') {
        fitSectionToContent(n);
      } else {
        n.w = tableFitW(n) || n.w;
        n.h = undefined;
        n.clip = undefined;
      }
      n.dirty = true;
    }
  }), { reflow: 'none' });
}

export function groupSelectionIntoSection(): void {
  if (singleNoteRefuses()) {
    return;
  }
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!));
  const nodes = nodesOf(ids);
  if (!nodes.length) { setStatus('Locked — can’t group'); return; }
  // The nearest NON-selected ancestor, or wrapping a parent with its own child makes a cycle.
  const selectedSet = new Set(ids);
  let parentId: string | null = nodes[0].parent;
  while (parentId && selectedSet.has(parentId)) {
    parentId = state.nodes.get(parentId)?.parent ?? null;
  }
  const parent = parentId ? state.nodes.get(parentId) : null;
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t group here'); return; }

  let sectionId = '';
  mutate([], () => {
    const fit = fitAround(subtreesBox(nodes), SECTION_FIT_PAD, gridSnap(), MIN_SECTION_SIZE)
      ?? { x: 0, y: 0, w: SECTION_W, h: SECTION_H };
    const section = mkNode({
      ...fit, parent: parentId,
      title: nextSectionTitle(), type: 'section',
    });
    sectionId = section.id;
    state.nodes.set(sectionId, section);
    for (const n of nodes) { touch(n.id); n.parent = sectionId; n.dirty = true; }
    settleSections([sectionId]);
  }, { reflow: 'relayout' });
  selectNode(sectionId);
  startInlineEdit(state.nodes.get(sectionId));
}

function markOpen(): void {
  fbOpen.style.display = canEnter(anchorNode()) ? '' : 'none';
  fbFit.style.display = selectedIds().some(id => { const k = state.nodes.get(id); return !!k && canFit(k); }) ? '' : 'none';
  // Shows the state a click would make, as X does.
  const foldable = nodesOf(selectedIds()).filter(canToggleFold);
  fbFold.style.display = foldable.length ? '' : 'none';
  const expand = foldable.length > 0 && foldable.every(k => k.collapsed);
  fbFold.classList.toggle('expand', expand);
  fbFold.title = expand ? 'Expand (X)' : 'Collapse (X)';
  fbFold.setAttribute('aria-label', expand ? 'Expand' : 'Collapse');
  fbTidy.style.display = canTidy() ? '' : 'none';
  const n = anchorNode();
  fbTidySection.style.display = state.sel.size === 1 && canTidySection(n) ? '' : 'none';
  const oneSection = state.sel.size === 1 && n?.type === 'section';
  fbTitle.style.display = oneSection ? '' : 'none';
  fbWrap.style.display = state.sel.size > 1 ? '' : 'none';
  fbUngroup.style.display = nodesOf(selectedIds()).some(k => k.type === 'section') ? '' : 'none';

  const stacks = hasStackSelected();
  const onlyStacks = stacks && !nodesOf(selectedIds()).some(k => k.type === 'section' && !isStack(k));
  fbUngroup.title = keys(onlyStacks ? 'Unstack (⌘⌫)' : 'Ungroup (⌘⌫)');
  fbUngroup.setAttribute('aria-label', onlyStacks ? 'Unstack' : 'Ungroup');
  fbToSection.style.display = stacks ? '' : 'none';
}

// The pastel row, left to right without silver: what the number keys 1–9 colour the selection with.
export const KEY_COLORS = ['grey', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

// Colour the selection from the keyboard, through the picker's own commit path so the bar's swatch follows.
export function colorSelection(color: string): void {
  props.setColor(color);
  markColorTrigger();
}

// The trigger wears the popover's swatch classes; mirror the active one.
function markColorTrigger(): void {
  const active = edColors.querySelector<HTMLElement>('.swatch.active');
  fbColorDot.classList.remove('inherit', 'nofill');
  fbColorDot.style.removeProperty('--sw');
  if (!active || active.classList.contains('inherit')) {
    fbColorDot.classList.add('inherit');
  } else if (active.classList.contains('nofill')) {
    fbColorDot.classList.add('nofill');
  } else {
    fbColorDot.style.setProperty('--sw', active.style.getPropertyValue('--sw'));
  }
}

// Every other control is a no-op on a locked selection, so `.locked-sel` shrinks the bar to this button.
function markLock(): void {
  const locked = anyLocked(state.sel);
  bar.classList.toggle('locked-sel', locked);
  fbLock.innerHTML = locked ? LOCK_BADGE_SVG : ICON_LOCK_OPEN;
  fbLock.title = locked ? 'Unlock (L)' : 'Lock (L) — freeze this card in place';
  fbLock.setAttribute('aria-label', locked ? 'Unlock' : 'Lock');
}

function syncControls(): void {
  props.sync();
  markOpen();
  markColorTrigger();
  markLock();
}

let activePopover: { pop: HTMLElement; anchor: HTMLElement } | null = null;

function closePopovers(): void {
  colorPop.classList.remove('open');
  activePopover = null;
}

function togglePopover(pop: HTMLElement, anchor: HTMLElement): void {
  const willOpen = activePopover?.pop !== pop;
  closePopovers();
  if (willOpen){ pop.classList.add('open'); activePopover = { pop, anchor }; placePopover(pop, anchor, bar); }
}

// The right-click menu of `n`, which may or may not be in the selection; `sx`/`sy` place a paste.
// FigJam's order: clipboard, Delete, actions, outside the map, lock last.
export function buildCardMenu(n: MindNode, sx: number, sy: number): MenuEntry[] {
  const multi = state.sel.has(n.id) && state.sel.size > 1;
  const targetIds = multi ? [...state.sel] : [n.id];
  const anySection = targetIds.some(id => state.nodes.get(id)?.type === 'section');
  const isSection = n.type === 'section';
  // Group actions act on the selection, so a target outside it is selected first.
  const selectTargetFirst = () => {
    if (!multi) {
      selectNode(n.id);
    }
  };
  const locked = isLockedEffective(n);
  const someLocked = targetIds.some(id => isLockedEffective(state.nodes.get(id)!));
  const anySubtreeLocked = targetIds.some(id => subtreeHasLocked(id));
  const entries: MenuEntry[] = [];
  entries.push({ label:'Copy', shortcut:'⌘C', run: () => { selectTargetFirst(); void copySelection(); } });
  entries.push({ label:'Copy as formatted text', run: () => { selectTargetFirst(); void copyFormatted(); } });
  entries.push({ label:'Cut', shortcut:'⌘X', run: () => { selectTargetFirst(); void cutSelection(); }, disabled: anySubtreeLocked });
  const pastesInside = isSection && !multi;
  entries.push({ label: pastesInside ? 'Paste inside' : 'Paste', shortcut:'⌘V',
    run: () => { void pasteFromClipboard(sx, sy, pastesInside ? n.id : null); }, disabled: isSection && locked });
  entries.push({ label:'Duplicate', shortcut:'D', run: () => { selectTargetFirst(); duplicateSelection(); } });
  entries.push({ label:'Duplicate as the next one', shortcut:'⇧D', run: () => { selectTargetFirst(); duplicateSelection({ next: true }); } });
  entries.push('sep');
  entries.push({ label:'Delete', shortcut:'⌫', run: () => multi ? deleteSelection() : deleteNode(n.id), disabled: anySubtreeLocked });
  if (anySection) {
    entries.push({ label:'Ungroup', shortcut:'⌘⌫',
      run: () => { selectTargetFirst(); deleteSelectionKeepChildren(); }, disabled: someLocked });
  }
  entries.push('sep');
  if (!multi) {
    entries.push(isSection ? { label:'Rename', shortcut:'F2', run: () => startInlineEdit(n), disabled: locked }
                         : { label:'Edit', shortcut:'E', run: () => startBodyEdit(n), disabled: locked });
  }
  if (!multi && canOpen(n)) {
    entries.push({ label:'Open', shortcut:'⌘↓', run: () => openSection(n) });
  }
  if (!multi && canFold(n)) {
    entries.push({ label: n.collapsed ? 'Expand' : 'Collapse', shortcut:'X', run: () => toggleCollapse(n.id), disabled: locked });
  }
  entries.push({ label:'Wrap in new section', shortcut:'⌘S', run: () => { selectTargetFirst(); groupSelectionIntoSection(); }, disabled: someLocked });
  if (targetIds.some(id => { const k = state.nodes.get(id); return !!k && canFit(k); })) {
    entries.push({ label: 'Resize to fit', shortcut:'⌥⇧⌘R',
      run: () => { selectTargetFirst(); autoSizeSelection(); }, disabled: someLocked });
  }
  entries.push('sep');
  entries.push({ label:'Copy file path', run: () => copyFilePath(n), disabled: multi || !n.file });
  entries.push({ label:'Download as Markdown', run: () => { selectTargetFirst(); exportSelection(); } });
  if (canShareFiles) {
    entries.push({ label:'Share…', run: () => { selectTargetFirst(); void shareSelection(); } });
  }
  entries.push('sep');
  const lockedNow = anyLocked(targetIds);
  entries.push({ label: lockedNow ? 'Unlock' : 'Lock', shortcut:'L', run: () => setLockedSelection(targetIds, !lockedNow) });
  return entries;
}

// Clears the top port (free-edges.ts SOCKET_OUT) and its ⊕.
const GAP = 36;
const SAFE_TOP_MARGIN = 4;
const MIN_LABEL_W = 4;
const WHEEL_IDLE_MS = 150;

function anchorNode(): MindNode | undefined {
  const n: MindNode | undefined = state.selId ? state.nodes.get(state.selId) : undefined;
  return n?.el ? n : undefined;
}

// The bar stays clear of a node's title; an image card's title row is empty, hence the width guard.
function labelRect(n: MindNode): DOMRect {
  const el = n.el!;
  const lr = labelEl(n)?.getBoundingClientRect();
  return (lr && lr.width > MIN_LABEL_W) ? lr : el.getBoundingClientRect();
}

// False when nothing MEASURABLE is behind the selection (stale ids after a reload, or a hidden anchor
// with 0×0 rects); the caller then hides the bar rather than leave it in the screen corner.
function positionBar(): boolean {
  if (NARROW_MQ.matches){ bar.style.left = ''; bar.style.top = ''; return true; }
  const n = anchorNode(); const el = n?.el;
  if (!n || !el) {
    return false;
  }
  let r: DOMRect | { left: number; top: number; right: number; bottom: number; width: number; height: number } = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    return false;
  }
  let lr: { top: number } = labelRect(n);
  // Several selected: over the WHOLE selection, labels included, so it never sits on one of them.
  if (state.sel.size > 1) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of state.sel) {
      const m = state.nodes.get(id);
      if (!m?.el) {
        continue;
      }
      for (const b of [m.el.getBoundingClientRect(), labelRect(m)]) {
        if (!b.width && !b.height) {
          continue;
        }
        x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
      }
    }
    if (isFinite(x0)) {
      r = { left: x0, top: y0, right: x1, bottom: y1, width: x1 - x0, height: y1 - y0 };
      lr = { top: y0 };
    }
  }
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const left = r.left + r.width / 2 - bw / 2;
  let top = Math.min(r.top, lr.top) - bh - GAP;
  // The SAFE top, not the window's: under `viewport-fit=cover` the notch hides the first rows.
  if (top < safeInsets().top + SAFE_TOP_MARGIN) {
    top = r.bottom + GAP;
  }
  placeInViewport(bar, left, top);
  if (activePopover) {
    placePopover(activePopover.pop, activePopover.anchor, bar);
  }
  return true;
}

// The bar hides while the canvas moves (canvasMoving); a wheel has no pointerup, so it idles out.
let wheelIdleTimer: number | null = null;

function markWheelBusy(): void {
  ui.wheeling = true;
  if (wheelIdleTimer != null) {
    clearTimeout(wheelIdleTimer);
  }
  wheelIdleTimer = window.setTimeout(() => { ui.wheeling = false; wheelIdleTimer = null; }, WHEEL_IDLE_MS);
}

// Every caller that moves the bar goes through here, so it is hidden whenever it can't be anchored.
function placeBar(): boolean {
  const placed = positionBar();
  bar.classList.toggle('unanchored', !placed);
  placedOk = placed;
  return placed;
}

// Runs every frame while open but MEASURES only when the anchor can have moved: measuring is two rect
// reads per selected card, thousands a frame after ⌘A on a big board.
let raf: number | null = null;
let placedFor = '', placedOk = false;

function followLoop(): void {
  const interacting = canvasMoving();
  if (interacting) {
    placedFor = '';
  } else {
    const now = `${world.style.transform}|${ui.paintTick}|${state.selId}|${state.sel.size}|${window.innerWidth}x${window.innerHeight}`;
    if (now !== placedFor || document.body.classList.contains('layout-anim')) {
      placedOk = placeBar();
      placedFor = now;
    }
  }
  const placed = placedOk;
  bar.classList.toggle('hide-interact', interacting);
  if (activePopover){
    activePopover.pop.classList.toggle('hide-interact', interacting || !placed);
  }
  raf = bar.classList.contains('open') ? requestAnimationFrame(followLoop) : null;
}

// SHOWING is debounced (hiding and updating an open bar are not): a double-click's first click would
// otherwise flash the bar just before the fold moves the layout under it.
let showTimer: number | null = null;
const SHOW_DELAY = 180;

function showOpenBar(): void {
  syncControls();
  placeBar();
  if (raf == null) {
    followLoop();
  }
}

export function syncFloatBar(): void {
  closePopovers();
  const visible = state.sel.size > 0;
  if (showTimer != null) { clearTimeout(showTimer); showTimer = null; }
  if (!visible) {
    bar.classList.remove('open');
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    return;
  }
  if (bar.classList.contains('open')) {
    showOpenBar();
    return;
  }
  showTimer = window.setTimeout(() => {
    showTimer = null;
    if (!(state.sel.size > 0)) {
      return;
    }
    bar.classList.add('open');
    showOpenBar();
  }, SHOW_DELAY);
}

export function installFloatBar(): void {
  props = createProperties({ colors: edColors }, () => selectedIds());
  fbWrap.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); groupSelectionIntoSection(); });
  fbUngroup.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); deleteSelectionKeepChildren(); });
  fbToSection.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); stackToSection(); });

  // How an untitled section, which shows no label, gets one back.
  fbTitle.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopovers();
    const n = anchorNode();
    if (n?.type === 'section') {
      editSectionTitle(n);
    }
  });
  fbLock.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopovers();
    setLockedSelection(state.sel, !anyLocked(state.sel));
  });
  fbColor.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(colorPop, fbColor); });

  // Bubbles here after properties.ts has set the new .active swatch.
  colorPop.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest('.swatch');
    if (!sw) {
      return;
    }
    markColorTrigger();

    // The custom chip opens the native colour sheet; closing now would tear it down mid-choice.
    if (sw.classList.contains('custom')) {
      return;
    }
    closePopovers();
  });

  colorPop.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).closest('.swatch.custom')) {
      markColorTrigger();
    }
  });
  closeOnOutside(colorPop, fbColor, closePopovers);

  fbTidy.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopovers();
    const r = fbTidy.getBoundingClientRect();
    openMenu(tidyMenuEntries(), r.left, r.bottom + 8);
  });

  // The touch twin of ↑, so it acts on the ANCHOR exactly as navArrow does.
  fbOpen.addEventListener('click', (e) => { e.stopPropagation(); openSection(anchorNode()); });
  fbFold.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); toggleCollapseSelection(state.sel); syncFloatBar(); });
  fbTidySection.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopovers();
    const n = anchorNode();
    if (canTidySection(n)) {
      tidySection(n);
    }
  });
  fbFit.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); autoSizeSelection(); syncFloatBar(); });
  stage.addEventListener('wheel', markWheelBusy, { passive: true });
  stage.addEventListener('gesturestart', () => { ui.wheeling = true; });
  stage.addEventListener('gestureend', () => { ui.wheeling = false; });
  window.addEventListener('resize', () => { closePopovers(); placeBar(); });
  NARROW_MQ.addEventListener('change', syncFloatBar);
}
