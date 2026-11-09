// ---------- floating selection bar ----------
// Replaces the old #editor right-hand sidebar: a compact row of icon buttons anchored right
// next to the selected card (Miro/Figma-style), instead of a persistent docked panel. Colour
// collapses to one trigger button that opens a small popover with the full picker. No kebab, as in
// FigJam: the card's full action list is the right-click menu (features/context-menu.ts).
// On narrow/touch widths (NARROW_MQ) styles.css docks the bar to the bottom edge instead —
// this module skips the floating position math there and lets CSS own it.
import { state, stage, setStatus, singleNoteRefuses, isImageCard, isStack, type MindNode } from '../core/state.js';
import { NARROW_MQ, ui, inPlaceEditActive } from '../core/ui-state.js';
import { touch } from './history.js';
import { mutate } from './mutate.js';
import { subtreesBox, isSection } from '../view/layout.js';
import { createProperties } from './properties.js';
import { startInlineEdit, startBodyEdit, editSectionTitle } from './inline-edit.js';
import { settleSections } from './drag.js';
import { duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, mkNode, nextSectionTitle } from './crud.js';
import { exportSelection, shareSelection, canShareFiles, copySelection, cutSelection } from './clipboard.js';
import { pasteFromClipboard } from './attachments.js';
import { canTidy, tidyMenuEntries, canTidySection, tidySection } from './tidy.js';
import { openMenu, copyFilePath, type MenuEntry } from './context-menu.js';
import { childrenOf, isLockedEffective, subtreeHasLocked, nodesOf } from '../utils/model.js';
import { canOpen, canEnter } from '../nav/scope.js';
import { labelEl, animateLayout } from '../main.js';
import { byId, placeInViewport, placePopover, closeOnOutside, safeInsets, keys } from '../utils/dom.js';
import { canFold, canToggleFold, gridSnap, SECTION_W, SECTION_H } from '../view/geometry.js';
import { MIN_SECTION_W, MIN_SECTION_H } from './resize.js';
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

// colour wiring lives in features/properties.ts. Tags are omitted: no room in the bar.
const props = createProperties({ colors: edColors }, () => selectedIds());

// Fit a section's box snugly around its children: the same margin on every side, snapped to the grid
// and clamped to the min size. Children keep their positions (the box moves to enclose them). With
// no children it's left as-is, or given the default size when `orDefault`. Shared by the Auto-size
// action and the load migration that turns a card's old children into a section's
// (data/persistence.ts).
// The section's label hangs outside the box (above it), so the margin is the same on all four sides.
export const SECTION_FIT_PAD = 16;
export function fitSectionToContent(n: MindNode, orDefault = false): void {
  const snapStep = gridSnap();
  const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
  const { x0, y0, x1, y1 } = subtreesBox(childrenOf(n.id));
  if (!isFinite(x0)) { if (orDefault) { n.w = SECTION_W; n.h = SECTION_H; } return; }
  n.x = snap(x0 - SECTION_FIT_PAD);
  n.y = snap(y0 - SECTION_FIT_PAD);
  n.w = Math.max(MIN_SECTION_W, snap(x1 + SECTION_FIT_PAD - n.x));
  n.h = Math.max(MIN_SECTION_H, snap(y1 + SECTION_FIT_PAD - n.y));
}
// FIT — the float bar's ↔, ⌥⇧⌘R and the menu's "Resize to fit": every selected section hugs its cards
// (fitSectionToContent), every selected card drops its authored height — a minimum it was dragged out to,
// or a CLIP it was dragged in to — and measures its text again. Width stays (it's what the text wraps at),
// except that a card WIDENS to its widest table, up to TABLE_FIT_W: a table is the one thing in a note
// that needs width rather than wrapping. Only ever on request — nothing resizes on its own.
const TABLE_FIT_W = 960;
// The width a card's tables want — laid out at their natural width, unwrapped — or 0 when they fit as is.
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
export function autoSizeSelection(): void {
  const ids = selectedIds().filter(id => { const n = state.nodes.get(id); return !!n && canFit(n); });
  if (!ids.length) {
    return;
  }
  // animated, like a fold: the box glides to its new size (main.ts animateLayout)
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
      n.dirty = true; n.dirtyLayout = true;
    }
  }), { reflow: 'none' });
}
// Wrap the selected cards in a fresh section: the section lands as a child of the nearest
// NON-selected ancestor of the first selected card (walking up past any selected ancestor —
// grouping a parent together with its own child would otherwise reparent the parent under the
// section while the section sits under that same parent, a cycle), sized to enclose the selection's
// current positions (same fit math as fitSectionToContent). Every selected card is reparented
// under the new section, which ends up selected. Shared by the 'G' shortcut and the context menu.
export function groupSelectionIntoSection(): void {
  if (state.readOnly || singleNoteRefuses()) {
    return;
  }
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!));
  const nodes = nodesOf(ids);
  if (!nodes.length) { setStatus('Locked — can’t group'); return; }
  const selectedSet = new Set(ids);
  let parentId: string | null = nodes[0].parent;
  while (parentId && selectedSet.has(parentId)) {
    parentId = state.nodes.get(parentId)?.parent ?? null;
  }
  const parent = parentId ? state.nodes.get(parentId) : null;
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t group here'); return; }

  let sectionId = '';
  mutate([], () => {
    const { x0, y0, x1, y1 } = subtreesBox(nodes);
    const snapStep = gridSnap();
    const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
    const fx = isFinite(x0) ? snap(x0 - SECTION_FIT_PAD) : 0;
    const fy = isFinite(y0) ? snap(y0 - SECTION_FIT_PAD) : 0;
    const fw = isFinite(x1) ? Math.max(MIN_SECTION_W, snap(x1 + SECTION_FIT_PAD - fx)) : SECTION_W;
    const fh = isFinite(y1) ? Math.max(MIN_SECTION_H, snap(y1 + SECTION_FIT_PAD - fy)) : SECTION_H;
    const section = mkNode({
      x: fx, y: fy, w: fw, h: fh, parent: parentId,
      // A section is one kind that keeps a required title: its folder tab is the only thing you can
      // grab it by, and a blank tab reads as broken.
      title: nextSectionTitle(), type: 'section',
    });
    sectionId = section.id;
    state.nodes.set(sectionId, section);
    for (const n of nodes) { touch(n.id); n.parent = sectionId; n.dirty = true; }
    settleSections([sectionId]);   // …and whatever else its box now covers
  }, { reflow: 'relayout', status: `Grouped ${nodes.length} card${nodes.length === 1 ? '' : 's'} into a section` });
  selectNode(sectionId);
}
// Open (→]) go IN: shown only when the selection can be opened (see fbOpen's click handler below).
function markOpen(): void {
  fbOpen.style.display = canEnter(anchorNode()) ? '' : 'none';
  fbFit.style.display = selectedIds().some(id => { const k = state.nodes.get(id); return !!k && canFit(k); }) ? '' : 'none';
  // Collapse / expand: THE fold button (cards carry none of their own). It shows the state it would make:
  // expand once everything foldable in the selection is folded, collapse otherwise — what X does.
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
  fbWrap.style.display = !state.readOnly && state.sel.size > 1 ? '' : 'none';
  fbUngroup.style.display = !state.readOnly && nodesOf(selectedIds()).some(k => k.type === 'section') ? '' : 'none';

  // On a stack, Ungroup is UNSTACK (crud.ts deleteSelectionKeepChildren), and a stack can become a section.
  const stacks = hasStackSelected();
  const onlyStacks = stacks && !nodesOf(selectedIds()).some(k => k.type === 'section' && !isStack(k));
  fbUngroup.title = keys(onlyStacks ? 'Unstack (⌘⌫)' : 'Ungroup (⌘⌫)');
  fbUngroup.setAttribute('aria-label', onlyStacks ? 'Unstack' : 'Ungroup');
  fbToSection.style.display = stacks ? '' : 'none';
}
fbWrap.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); groupSelectionIntoSection(); });
fbUngroup.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); deleteSelectionKeepChildren(); });
fbToSection.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); stackToSection(); });
// T — a section's TITLE. An untitled section shows no label at all (its text was deleted, FigJam-style),
// so this is how one comes back: it seeds a name and selects it, ready to type over. A named section just
// opens its label with the name selected — the same editor F2 and a double-click on the label open.
fbTitle.addEventListener('click', (e) => {
  e.stopPropagation();
  closePopovers();
  const n = anchorNode();
  if (n?.type === 'section') {
    editSectionTitle(n);
  }
});

// The pastel row, left to right without silver: what the number keys 1–9 colour the selection with.
export const KEY_COLORS = ['grey', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

// Colour the selection from the keyboard, through the picker's own commit path so the bar's swatch follows.
export function colorSelection(color: string): void {
  props.setColor(color);
  markColorTrigger();
}

// ---------- colour trigger ----------
// The trigger button reuses the SAME .swatch/.inherit/.nofill CSS look as the popover's chips
// (see index.html: fbColorDot starts with class "fb-swatch swatch inherit") — just mirror whichever
// swatch is currently active.
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

// ---------- lock toggle ----------
// Replaces the old Lock/Unlock context-menu entry. A locked card can't be moved, folded, renamed,
// re-coloured or deleted (isLockedEffective), so every OTHER control in the bar would be
// a no-op — hence `.locked-sel`, which collapses the bar down to this one button (styles.css). A
// mixed selection counts as locked — anyLocked (main.ts) owns that rule, shared with the L shortcut.
function markLock(): void {
  const locked = anyLocked(state.sel);
  bar.classList.toggle('locked-sel', locked);
  fbLock.innerHTML = locked ? LOCK_BADGE_SVG : ICON_LOCK_OPEN;
  fbLock.title = locked ? 'Unlock (L)' : 'Lock (L) — freeze this card in place';
  fbLock.setAttribute('aria-label', locked ? 'Unlock' : 'Lock');
}
fbLock.addEventListener('click', (e) => {
  e.stopPropagation();
  closePopovers();
  setLockedSelection(state.sel, !anyLocked(state.sel));
});

function syncControls(): void {
  props.sync();
  markOpen();
  markColorTrigger();
  markLock();
}

// ---------- the colour popover ----------
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
fbColor.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(colorPop, fbColor); });
// a colour pick updates the trigger's own swatch look and closes the popover. Runs after properties.ts's own listener has already
// set the new .active swatch (bubble phase fires the target's listener before this ancestor one).
colorPop.addEventListener('click', (e) => {
  const sw = (e.target as HTMLElement).closest('.swatch');
  if (!sw) {
    return;
  }
  markColorTrigger();
  // …except the custom chip, whose click OPENS the native colour sheet rather than picking anything:
  // closing here would tear the swatch row down while the user is still choosing, and the trigger
  // has nothing to mirror yet. It closes the ordinary way — a tap outside, or Esc.
  if (sw.classList.contains('custom')) {
    return;
  }
  closePopovers();
});
// …and while that sheet is open, keep the trigger's swatch in step with the live preview.
colorPop.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).closest('.swatch.custom')) {
    markColorTrigger();
  }
});
closeOnOutside(colorPop, fbColor, closePopovers);

// ---------- card actions menu: rename / edit note / duplicate / export / delete / … ----------
// Shared by the kebab button here AND the right-click context menu (features/context-menu.ts) —
// ONE list of entries so the two never drift apart. `n` is the menu's TARGET card: the kebab's
// target is always the (sole) selection anchor; the context menu's is whatever was clicked, which
// may or may not be part of the current multi-selection. `sx`/`sy` only matter for "Paste inside"
// (where the pasted card lands) — the kebab has no cursor position, so it passes the
// button's own screen position instead.
export function buildCardMenu(n: MindNode, sx: number, sy: number): MenuEntry[] {
  // FigJam's order: the clipboard, Delete, what you can DO with it, where it goes outside the map, and
  // the lock last. Only actions with no other easy home are here — a new card next to this one is the
  // port's ⊕, a new card inside a section is a double-click in it, zooming is F.
  const multi = state.sel.has(n.id) && state.sel.size > 1;
  const targetIds = multi ? [...state.sel] : [n.id];
  const anySection = targetIds.some(id => state.nodes.get(id)?.type === 'section');
  const isSection = n.type === 'section';
  // group actions (Duplicate/Cut/Copy/Export/Share/Auto-size) act on state.sel via selectedIds();
  // when the target isn't already part of the selection, select it first so they act on IT.
  const selectTargetFirst = () => {
    if (!multi) {
      selectNode(n.id);
    }
  };
  const locked = isLockedEffective(n);                 // n itself: locked, or a locked descendant
  const someLocked = targetIds.some(id => isLockedEffective(state.nodes.get(id)!));
  const anySubtreeLocked = targetIds.some(id => subtreeHasLocked(id));
  const ro = state.readOnly;
  const entries: MenuEntry[] = [];
  entries.push({ label:'Copy', shortcut:'⌘C', run: () => { selectTargetFirst(); void copySelection(); } });
  if (!ro){
    entries.push({ label:'Cut', shortcut:'⌘X', run: () => { selectTargetFirst(); void cutSelection(); }, disabled: anySubtreeLocked });
    // on a section, what's pasted lands INSIDE it; on a card, beside it at the pointer
    entries.push({ label: isSection && !multi ? 'Paste inside' : 'Paste', shortcut:'⌘V',
      run: () => { void pasteFromClipboard(sx, sy, isSection && !multi ? n.id : null); }, disabled: isSection && locked });
    entries.push({ label:'Duplicate', shortcut:'D', run: () => { selectTargetFirst(); duplicateSelection(); } });
    entries.push({ label:'Duplicate as the next one', shortcut:'⇧D', run: () => { selectTargetFirst(); duplicateSelection({ next: true }); } });
    entries.push('sep');
    entries.push({ label:'Delete', shortcut:'⌫', run: () => multi ? deleteSelection() : deleteNode(n.id), disabled: anySubtreeLocked });
    if (anySection) {
      entries.push({ label:'Ungroup', shortcut:'⌘⌫',
        run: () => { selectTargetFirst(); deleteSelectionKeepChildren(); }, disabled: someLocked });
    }
  }
  entries.push('sep');
  if (!ro && !multi) {
    entries.push(isSection ? { label:'Rename', shortcut:'F2', run: () => startInlineEdit(n), disabled: locked }
                         : { label:'Edit', shortcut:'E', run: () => startBodyEdit(n), disabled: locked });
  }
  if (!multi && canOpen(n)) {
    entries.push({ label:'Open', shortcut:'⌘↓', run: () => openSection(n) });
  }
  if (!multi && canFold(n)) {
    entries.push({ label: n.collapsed ? 'Expand' : 'Collapse', shortcut:'X', run: () => toggleCollapse(n.id), disabled: locked });
  }
  if (!ro){
    entries.push({ label:'Wrap in new section', shortcut:'⌘S', run: () => { selectTargetFirst(); groupSelectionIntoSection(); }, disabled: someLocked });
    if (targetIds.some(id => { const k = state.nodes.get(id); return !!k && canFit(k); })) {
      entries.push({ label: 'Resize to fit', shortcut:'⌥⇧⌘R',
        run: () => { selectTargetFirst(); autoSizeSelection(); }, disabled: someLocked });
    }
  }
  entries.push('sep');
  entries.push({ label:'Copy file path', run: () => copyFilePath(n), disabled: multi || !n.file });
  entries.push({ label:'Download as Markdown', run: () => { selectTargetFirst(); exportSelection(); } });
  if (canShareFiles) {
    entries.push({ label:'Share…', run: () => { selectTargetFirst(); void shareSelection(); } });
  }
  if (!ro){
    entries.push('sep');
    const lockedNow = anyLocked(targetIds);
    entries.push({ label: lockedNow ? 'Unlock' : 'Lock', shortcut:'L', run: () => setLockedSelection(targetIds, !lockedNow) });
  }
  return entries;
}
// ▦ — several selected: Tidy up, align, distribute, same width (features/tidy.ts)
fbTidy.addEventListener('click', (e) => {
  e.stopPropagation();
  closePopovers();
  const r = fbTidy.getBoundingClientRect();
  openMenu(tidyMenuEntries(), r.left, r.bottom + 8);
});

// ---------- anchoring: float the bar right above/below the selected card ----------
const GAP = 36;   // clear of the top port (free-edges.ts SOCKET_OUT) and its ⊕

// Open (→]) go IN — the touch-reachable twin of ↑, since the float bar is the one action surface identical on
// desktop and on a phone. Acts on the ANCHOR, exactly as ↑ does (features/commands.ts navArrow): you can only stand
// in one place, so the two must not disagree about which node a multi-selection means. Hidden for the
// kinds with no interior and for the card you are already inside, both of which openSection would refuse.
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
function anchorNode(): MindNode | undefined {
  const n: MindNode | undefined = state.selId ? state.nodes.get(state.selId) : undefined;
  return n?.el ? n : undefined;
}
// A node's TITLE: the bar stays clear of it (a section's label hangs above its box), but centres on the box.
// labelEl (main.ts) owns WHICH element that is, so the folded case needs no second spelling here; an image
// card renders its title row empty, hence the width guard falling back to the whole box.
function labelRect(n: MindNode): DOMRect {
  const el = n.el!;
  const lr = labelEl(n)?.getBoundingClientRect();
  return (lr && lr.width > 4) ? lr : el.getBoundingClientRect();
}
// Put the bar over its anchor card. Returns whether it could actually be placed — false when the
// selection has nothing MEASURABLE behind it, which is not a theoretical case:
//   · the anchor id resolves to no node, or to a node with no element yet — a selection carried over
//     from before a (re)load, whose ids are all minted fresh (see loadFromDir);
//   · the anchor is HIDDEN (an ancestor folded under it, a tab closed over it) — `display:none`, so
//     every rect it reports is 0×0.
// Both used to leave the bar visible in the top-left corner of the SCREEN: the first because it bailed
// before writing left/top, so a bar that had never been placed kept its static position; the second
// because a zero rect lands at the world origin and then gets clamped to the 4px viewport margin. The
// caller hides it instead (`unanchored`) and keeps polling, so it comes back the moment the card does —
// unfolding the branch, or the next real selection, puts it right back over its card.
function positionBar(): boolean {
  if (NARROW_MQ.matches){ bar.style.left = ''; bar.style.top = ''; return true; }   // CSS docks it to the bottom
  const n = anchorNode(); const el = n?.el;
  if (!n || !el) {
    return false;
  }
  let r: DOMRect | { left: number; top: number; right: number; bottom: number; width: number; height: number } = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    return false;   // hidden (display:none) — nothing to hang off
  }
  let lr: { top: number } = labelRect(n);
  // Several selected: over the WHOLE selection (labels included), centred on it — FigJam's — so the
  // bar never sits on one of the cards it acts on.
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
  const left = r.left + r.width / 2 - bw / 2;   // centred on the box, however wide a section's is
  // Over whichever is higher, the box or its label: a section's label hangs ABOVE its box (outside its
  // bounds), and the bar mustn't sit on top of the name it's about to edit.
  let top = Math.min(r.top, lr.top) - bh - GAP;
  // …flipping below the card when there isn't room above it. Measured from the SAFE top edge, not
  // the window's: under `viewport-fit=cover` the first rows of pixels can be behind the status bar
  // / notch, and a bar that "fits" there would only be clamped back down over its own card.
  if (top < safeInsets().top + 4) {
    top = r.bottom + GAP;
  }
  placeInViewport(bar, left, top);
  if (activePopover) {
    placePopover(activePopover.pop, activePopover.anchor, bar);
  }
  return true;
}
// ---------- hide during drag / pan / zoom ----------
// The bar gets in the way while the card underneath (or the whole canvas) is moving, so it hides
// for the duration of any interaction and reappears once the pointer lifts. Node drag / canvas
// pan / pinch / marquee all flow through the shared `ui` holder (core/ui-state.ts) and clear on
// pointerup, so polling them from the follow loop below covers all of those with no extra hooks
// into drag.ts/gestures.ts. Wheel-driven pan/zoom has no pointer at all — those set `wheelBusy`
// directly and clear it after a short idle debounce instead.
let wheelBusy = false;
let wheelIdleTimer: number | null = null;
function markWheelBusy(): void {
  wheelBusy = true;
  if (wheelIdleTimer != null) {
    clearTimeout(wheelIdleTimer);
  }
  wheelIdleTimer = window.setTimeout(() => { wheelBusy = false; wheelIdleTimer = null; }, 150);
}
stage.addEventListener('wheel', markWheelBusy, { passive: true });
stage.addEventListener('gesturestart', () => { wheelBusy = true; });
stage.addEventListener('gestureend', () => { wheelBusy = false; });
export function isInteracting(): boolean {
  return !!(ui.drag || ui.pan || ui.pinch || ui.marquee) || inPlaceEditActive() || wheelBusy;
}
// ONE placement pass plus its visibility consequence — every caller that moves the bar goes through
// here, so it can never paint a section sitting in the screen corner with nothing behind it. Reports
// whether it's anchored, for the popovers that hang off it (they'd float alone otherwise).
function placeBar(): boolean {
  const placed = positionBar();
  bar.classList.toggle('unanchored', !placed);
  return placed;
}
// Tracks the anchor card across camera pan/zoom and node drag without threading a hook through
// drag.ts/camera.ts — cheap (one rect read + one style write per frame) and only runs while open.
// It's also what un-hides an `unanchored` bar again: the check re-runs every frame while the bar is
// open, so unfolding the branch that swallowed its card brings it straight back.
let raf: number | null = null;
function followLoop(): void {
  const placed = placeBar();
  const interacting = isInteracting();
  bar.classList.toggle('hide-interact', interacting);
  // an open colour/layout popover would otherwise sit at a stale position mid-pan/drag/zoom —
  // hide it right along with the bar it hangs off, same rule, same class.
  if (activePopover){
    activePopover.pop.classList.toggle('hide-interact', interacting || !placed);
  }
  // …and tell the rest of the page, via one body-level class: a hover peek (features/peek.ts) holds
  // off while the canvas moves under it.
  document.body.classList.toggle('canvas-interacting', interacting);
  raf = bar.classList.contains('open') ? requestAnimationFrame(followLoop) : null;
}
window.addEventListener('resize', () => { closePopovers(); placeBar(); });

// ---------- visibility ----------
// Showing the bar is debounced a touch (SHOW_DELAY) — hiding is not. A double-click both selects
// (click 1) AND folds the card (the dblclick itself, which doesn't touch selection) in quick
// succession; without the delay the bar would flash on right on click 1 only to have nothing
// change it back off, which reads as a flicker since it appears for a beat and then the fold
// yanks the layout under it. Any hide/re-show request within the delay window (including a
// genuine selection change) just reschedules or cancels this timer, so only the settled state
// after a short pause ever actually shows the bar — repositioning/control updates on an ALREADY
// open bar stay instant, so switching the selected card never feels laggy.
let showTimer: number | null = null;
const SHOW_DELAY = 180;
export function syncFloatBar(): void {
  closePopovers();
  const visible = state.sel.size > 0 && !state.readOnly;
  if (showTimer != null) { clearTimeout(showTimer); showTimer = null; }
  if (!visible) {
    bar.classList.remove('open');
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    document.body.classList.remove('canvas-interacting');
    return;
  }
  if (bar.classList.contains('open')) {   // already showing — update in place, no delay needed
    syncControls();
    placeBar();
    if (raf == null) {
      followLoop();
    }
    return;
  }
  showTimer = window.setTimeout(() => {
    showTimer = null;
    // the selection this was scheduled for may already be gone by the time the delay elapses
    if (!(state.sel.size > 0 && !state.readOnly)) {
      return;
    }
    bar.classList.add('open');
    syncControls();
    placeBar();
    if (raf == null) {
      followLoop();
    }
  }, SHOW_DELAY);
}
// Crossing the narrow breakpoint (resize/rotate) docks or undocks the bar — re-place it directly.
NARROW_MQ.addEventListener('change', syncFloatBar);
