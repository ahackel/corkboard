// ---------- floating selection bar ----------
// Replaces the old #editor right-hand sidebar: a compact row of icon buttons anchored right
// next to the selected card (Miro/Figma-style), instead of a persistent docked panel. Colour
// collapses to one trigger button that opens a small popover with the full picker; a trailing
// kebab button opens the card's actions in the generic context menu (openMenu,
// features/context-menu.ts).
// On narrow/touch widths (NARROW_MQ) styles.css docks the bar to the bottom edge instead —
// this module skips the floating position math there and lets CSS own it.
import { state, stage, setStatus, isImageCard, type MindNode } from '../core/state.js';
import { NARROW_MQ, ui, inPlaceEditActive } from '../core/ui-state.js';
import { record, touch } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { subtreeBox } from '../view/layout.js';
import { createProperties, type PropertyControls } from './properties.js';
import { startInlineEdit, startBodyEdit, editFrameTitle } from './inline-edit.js';
import { settleFrames } from './drag.js';
import { duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, mkNode } from './crud.js';
import { exportSelection, shareSelection, canShareFiles, copySelection, cutSelection } from './clipboard.js';
import { pasteFromClipboard } from './attachments.js';
import { canTidy, tidyMenuEntries } from './tidy.js';
import { openMenu, copyFilePath, type MenuEntry } from './context-menu.js';
import { childrenOf, isHidden, isLockedEffective, subtreeHasLocked, parentOf } from '../utils/model.js';
import { canOpen, isScopeRoot } from '../nav/scope.js';
import { selectedIds, selectNode, toggleCollapse, toggleCollapseSelection, canFold, openFrame, setLockedSelection, anyLocked, labelEl, LOCK_BADGE_SVG, ICON_LOCK_OPEN, gridSnap, FRAME_W, FRAME_H, MIN_FRAME_W, MIN_FRAME_H, relayout, animateLayout } from '../main.js';
import { byId, placeInViewport, safeInsets } from '../utils/dom.js';


const bar = byId('floatBar');
const fbColor = byId<HTMLButtonElement>('fbColor');
const fbColorDot = byId('fbColorDot');
const fbLock = byId<HTMLButtonElement>('fbLock');
const fbTidy = byId<HTMLButtonElement>('fbTidy');
const fbOpen = byId<HTMLButtonElement>('fbOpen');
const fbFit = byId<HTMLButtonElement>('fbFit');
const fbFold = byId<HTMLButtonElement>('fbFold');
const fbTitle = byId<HTMLButtonElement>('fbTitle');
const fbMore = byId<HTMLButtonElement>('fbMore');
const colorPop = byId('fbColorPop');
const edColors = byId('edColors');

// colour wiring lives in features/properties.ts. Tags are omitted: no room in the bar.
// Deferred to first use: createProperties() eagerly builds
// the swatch row from main.js's PALETTE/SWATCH_BG, which aren't initialized yet while this module
// is still being imported at main.ts's top — see the main↔features import cycle note in CLAUDE.md.
let _props: PropertyControls | null = null;
function props(): PropertyControls {
  return _props ??= createProperties({ colors: edColors }, () => selectedIds());
}

// Fit a frame's box snugly around its children: the same margin on every side, snapped to the grid
// and clamped to the min size. Children keep their positions (the box moves to enclose them). With
// no children it's left as-is, or given the default size when `orDefault`. Shared by the Auto-size
// action and the load migration that turns a card's old children into a frame's
// (data/persistence.ts).
// The frame's label hangs outside the box (above it), so the margin is the same on all four sides.
const FRAME_FIT_PAD = 16;
export function fitFrameToContent(n: MindNode, orDefault = false): void {
  const kids = childrenOf(n.id).filter(k => !isHidden(k));
  const snapStep = gridSnap();
  const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of kids) {
    const b = subtreeBox(k); if (!isFinite(b.x0)) continue;
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  if (!isFinite(x0)) { if (orDefault) { n.w = FRAME_W; n.h = FRAME_H; } return; }
  n.x = snap(x0 - FRAME_FIT_PAD);
  n.y = snap(y0 - FRAME_FIT_PAD);
  n.w = Math.max(MIN_FRAME_W, snap(x1 + FRAME_FIT_PAD - n.x));
  n.h = Math.max(MIN_FRAME_H, snap(y1 + FRAME_FIT_PAD - n.y));
}
// GROW a frame until it holds what's in it — only outward, never shrinking or moving a side that
// already clears its contents. A frame clips (overflow:hidden), so a card dropped, pasted, created or
// typed past its edge would otherwise be in the frame and out of sight. Not the open frame: its box is
// the window. Each grown frame is touched, so it rides the caller's undo step.
export function growFramesToHold(ids: Iterable<string>): boolean {
  let grew = false;
  const frames = new Set<MindNode>();
  for (const id of ids) {
    const n = state.nodes.get(id); const p = n ? parentOf(n) : null;
    if (p && p.type === 'frame' && !p.collapsed && !isScopeRoot(p) && !isLockedEffective(p)) frames.add(p);
  }
  const snapStep = gridSnap();
  const up = (v: number): number => Math.ceil(v / snapStep) * snapStep;
  const down = (v: number): number => Math.floor(v / snapStep) * snapStep;
  for (const f of frames) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of childrenOf(f.id)) {
      if (isHidden(k)) continue;
      const b = subtreeBox(k); if (!isFinite(b.x0)) continue;
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    if (!isFinite(x0)) continue;
    const L = Math.min(f.x, down(x0 - FRAME_FIT_PAD)), T = Math.min(f.y, down(y0 - FRAME_FIT_PAD));
    const R = Math.max(f.x + (f.w ?? FRAME_W), up(x1 + FRAME_FIT_PAD)), B = Math.max(f.y + (f.h ?? FRAME_H), up(y1 + FRAME_FIT_PAD));
    if (L === f.x && T === f.y && R === f.x + (f.w ?? FRAME_W) && B === f.y + (f.h ?? FRAME_H)) continue;
    touch(f.id);
    f.x = L; f.y = T; f.w = R - L; f.h = B - T;
    f.dirtyLayout = true;
    grew = true;
  }
  return grew;
}
// FIT — the float bar's ↔, ⇧A and the menu's "Fit to contents": every selected frame hugs its cards
// (fitFrameToContent), every selected card drops its authored height — a minimum it was dragged out to,
// or a CLIP it was dragged in to — and measures its text again. Width stays: it's what the text wraps at.
export function canFit(n: MindNode): boolean {
  if (isLockedEffective(n)) return false;
  return n.type === 'frame' || (n.h != null && !isImageCard(n));
}
export function autoSizeSelection(): void {
  const ids = selectedIds().filter(id => { const n = state.nodes.get(id); return !!n && canFit(n); });
  if (!ids.length) return;
  // animated, like a fold: the box glides to its new size (main.ts animateLayout)
  record(ids, () => animateLayout(() => {
    for (const id of ids){
      const n = state.nodes.get(id); if (!n) continue;
      if (n.type === 'frame') fitFrameToContent(n); else { n.h = undefined; n.clip = undefined; }
      n.dirty = true; n.dirtyLayout = true;
    }
  }));
  scheduleSave();
}
// Wrap the selected cards in a fresh frame: the frame lands as a child of the nearest
// NON-selected ancestor of the first selected card (walking up past any selected ancestor —
// grouping a parent together with its own child would otherwise reparent the parent under the
// frame while the frame sits under that same parent, a cycle), sized to enclose the selection's
// current positions (same fit math as fitFrameToContent). Every selected card is reparented
// under the new frame, which ends up selected. Shared by the 'G' shortcut and the context menu.
export function groupSelectionIntoFrame(): void {
  if (state.readOnly) return;
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!));
  const nodes = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!nodes.length) { setStatus('Locked — can’t group'); return; }
  const selectedSet = new Set(ids);
  let parentId: string | null = nodes[0].parent;
  while (parentId && selectedSet.has(parentId)) parentId = state.nodes.get(parentId)?.parent ?? null;
  const parent = parentId ? state.nodes.get(parentId) : null;
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t group here'); return; }

  let frameId = '';
  record([], () => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const b = subtreeBox(n); if (!isFinite(b.x0)) continue;
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    const snapStep = gridSnap();
  const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
    const fx = isFinite(x0) ? snap(x0 - FRAME_FIT_PAD) : 0;
    const fy = isFinite(y0) ? snap(y0 - FRAME_FIT_PAD) : 0;
    const fw = isFinite(x1) ? Math.max(MIN_FRAME_W, snap(x1 + FRAME_FIT_PAD - fx)) : FRAME_W;
    const fh = isFinite(y1) ? Math.max(MIN_FRAME_H, snap(y1 + FRAME_FIT_PAD - fy)) : FRAME_H;
    const frame = mkNode({
      x: fx, y: fy, w: fw, h: fh, parent: parentId,
      // A frame is one kind that keeps a required title: its folder tab is the only thing you can
      // grab it by, and a blank tab reads as broken. No dedupe — the FILE takes the suffix now.
      title: 'Frame', type: 'frame',
    });
    frameId = frame.id;
    state.nodes.set(frameId, frame);
    for (const n of nodes) { touch(n.id); n.parent = frameId; n.dirty = true; }
    settleFrames([frameId]);   // …and whatever else its box now covers
  });
  relayout(); selectNode(frameId); scheduleSave();
  setStatus(`Grouped ${nodes.length} card${nodes.length === 1 ? '' : 's'} into a frame`);
}
// Open (→]) go IN: shown only when the selection can be opened (canOpenSelection below).
function markOpen(): void {
  fbOpen.style.display = canOpenSelection() ? '' : 'none';
  fbFit.style.display = selectedIds().some(id => { const k = state.nodes.get(id); return !!k && canFit(k); }) ? '' : 'none';
  // Collapse / expand: THE fold button (cards carry none of their own). It shows the state it would make:
  // expand once everything foldable in the selection is folded, collapse otherwise — what X does.
  const foldable = selectedIds().map(id => state.nodes.get(id)).filter((k): k is MindNode =>
    !!k && canFold(k) && !isLockedEffective(k) && !isScopeRoot(k));
  fbFold.style.display = foldable.length ? '' : 'none';
  const expand = foldable.length > 0 && foldable.every(k => k.collapsed);
  fbFold.classList.toggle('expand', expand);
  fbFold.title = expand ? 'Expand (X)' : 'Collapse (X)';
  fbFold.setAttribute('aria-label', expand ? 'Expand' : 'Collapse');
  fbTidy.style.display = canTidy() ? '' : 'none';
  const n = anchorNode();
  const oneFrame = state.sel.size === 1 && n?.type === 'frame';
  fbTitle.style.display = oneFrame ? '' : 'none';
}
// T — a frame's TITLE. An untitled frame shows no label at all (its text was deleted, FigJam-style),
// so this is how one comes back: it seeds a name and selects it, ready to type over. A named frame just
// opens its label with the name selected — the same editor F2 and a double-click on the label open.
fbTitle.addEventListener('click', (e) => {
  e.stopPropagation();
  closePopovers();
  const n = anchorNode(); if (n?.type === 'frame') editFrameTitle(n);
});

// ---------- colour trigger ----------
// The trigger button reuses the SAME .swatch/.inherit/.nofill CSS look as the popover's chips
// (see index.html: fbColorDot starts with class "fb-swatch swatch inherit") — just mirror whichever
// swatch is currently active.
function markColorTrigger(): void {
  const active = edColors.querySelector<HTMLElement>('.swatch.active');
  fbColorDot.classList.remove('inherit', 'nofill');
  fbColorDot.style.removeProperty('--sw');
  if (!active || active.classList.contains('inherit')) fbColorDot.classList.add('inherit');
  else if (active.classList.contains('nofill')) fbColorDot.classList.add('nofill');
  else fbColorDot.style.setProperty('--sw', active.style.getPropertyValue('--sw'));
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
  props().sync();
  markOpen();
  markColorTrigger();
  markLock();
}

// ---------- the colour popover ----------
// A free-floating island 8px off the bar, as FigJam's is — no stem joining the two.
const POP_GAP = 8;
let activePopover: { pop: HTMLElement; anchor: HTMLElement } | null = null;
function positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
  const ar = anchor.getBoundingClientRect();
  // vertical offset comes from the BAR's own rect, not the trigger's — fbColor's swatch button is
  // a smaller box than the bar, so anchoring to its own rect would hang the popover a few px low.
  const br = bar.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = ar.left + ar.width / 2 - pw / 2;
  let top = br.top - ph - POP_GAP;
  if (top < 4) top = br.bottom + POP_GAP;
  placeInViewport(pop, left, top);
}
function closePopovers(): void {
  colorPop.classList.remove('open');
  activePopover = null;
}
function togglePopover(pop: HTMLElement, anchor: HTMLElement): void {
  const willOpen = activePopover?.pop !== pop;
  closePopovers();
  if (willOpen){ pop.classList.add('open'); activePopover = { pop, anchor }; positionPopover(pop, anchor); }
}
fbColor.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(colorPop, fbColor); });
// a colour pick updates the trigger's own swatch look and closes the popover. Runs after properties.ts's own listener has already
// set the new .active swatch (bubble phase fires the target's listener before this ancestor one).
colorPop.addEventListener('click', (e) => {
  const sw = (e.target as HTMLElement).closest('.swatch');
  if (!sw) return;
  markColorTrigger();
  // …except the custom chip, whose click OPENS the native colour sheet rather than picking anything:
  // closing here would tear the swatch row down while the user is still choosing, and the trigger
  // has nothing to mirror yet. It closes the ordinary way — a tap outside, or Esc.
  if (sw.classList.contains('custom')) return;
  closePopovers();
});
// …and while that sheet is open, keep the trigger's swatch in step with the live preview.
colorPop.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).closest('.swatch.custom')) markColorTrigger();
});
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Node;
  if (activePopover && !colorPop.contains(t) && !fbColor.contains(t)) closePopovers();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && activePopover) closePopovers(); }, true);

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
  // port's ⊕, a new card inside a frame is a double-click in it, zooming is F.
  const multi = state.sel.has(n.id) && state.sel.size > 1;
  const targetIds = multi ? [...state.sel] : [n.id];
  const anyFrame = targetIds.some(id => state.nodes.get(id)?.type === 'frame');
  const isFrame = n.type === 'frame';
  // group actions (Duplicate/Cut/Copy/Export/Share/Auto-size) act on state.sel via selectedIds();
  // when the target isn't already part of the selection, select it first so they act on IT.
  const selectTargetFirst = () => { if (!multi) selectNode(n.id); };
  const locked = isLockedEffective(n);                 // n itself: locked, or a locked descendant
  const someLocked = targetIds.some(id => isLockedEffective(state.nodes.get(id)!));
  const anySubtreeLocked = targetIds.some(id => subtreeHasLocked(id));
  const ro = state.readOnly;
  const entries: MenuEntry[] = [];
  entries.push({ label:'Copy', shortcut:'⌘C', run: () => { selectTargetFirst(); void copySelection(); } });
  if (!ro){
    entries.push({ label:'Cut', shortcut:'⌘X', run: () => { selectTargetFirst(); void cutSelection(); }, disabled: anySubtreeLocked });
    // on a frame, what's pasted lands INSIDE it; on a card, beside it at the pointer
    entries.push({ label: isFrame && !multi ? 'Paste inside' : 'Paste', shortcut:'⌘V',
      run: () => { void pasteFromClipboard(sx, sy, isFrame && !multi ? n.id : null); }, disabled: isFrame && locked });
    entries.push({ label:'Duplicate', shortcut:'D', run: () => { selectTargetFirst(); duplicateSelection(); } });
    entries.push({ label:'Duplicate as the next one', shortcut:'⌘⌥D', run: () => { selectTargetFirst(); duplicateSelection({ next: true }); } });
    entries.push('sep');
    entries.push({ label:'Delete', shortcut:'⌫', run: () => multi ? deleteSelection() : deleteNode(n.id), disabled: anySubtreeLocked });
    if (anyFrame)
      entries.push({ label:'Delete frame, keep cards', shortcut:'⌥⌫',
        run: () => { selectTargetFirst(); deleteSelectionKeepChildren(); }, disabled: someLocked });
  }
  entries.push('sep');
  if (!ro && !multi)
    entries.push(isFrame ? { label:'Rename', shortcut:'F2', run: () => startInlineEdit(n), disabled: locked }
                         : { label:'Edit', shortcut:'E', run: () => startBodyEdit(n), disabled: locked });
  if (!multi && canOpen(n)) entries.push({ label:'Open', shortcut:'↑', run: () => openFrame(n) });
  if (!multi && canFold(n))
    entries.push({ label: n.collapsed ? 'Expand' : 'Collapse', shortcut:'X', run: () => toggleCollapse(n.id), disabled: locked });
  if (!ro){
    entries.push({ label:'Group into frame', shortcut:'G', run: () => { selectTargetFirst(); groupSelectionIntoFrame(); }, disabled: someLocked });
    if (targetIds.some(id => { const k = state.nodes.get(id); return !!k && canFit(k); }))
      entries.push({ label: 'Fit to contents', shortcut:'⇧A',
        run: () => { selectTargetFirst(); autoSizeSelection(); }, disabled: someLocked });
  }
  entries.push('sep');
  entries.push({ label:'Copy file path', run: () => copyFilePath(n), disabled: multi || !n.file });
  entries.push({ label:'Download as Markdown', run: () => { selectTargetFirst(); exportSelection(); } });
  if (canShareFiles) entries.push({ label:'Share…', run: () => { selectTargetFirst(); void shareSelection(); } });
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
fbMore.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = state.selId; const n = id ? state.nodes.get(id) : undefined;
  if (!n) return;
  const r = fbMore.getBoundingClientRect();
  const entries = buildCardMenu(n, r.left, r.bottom);
  openMenu(entries, r.left, r.bottom + 4);
});

// ---------- anchoring: float the bar right above/below the selected card ----------
const GAP = 36;   // clear of the top port (free-edges.ts SOCKET_OUT) and its ⊕
// Open (→]) go IN — the touch-reachable twin of ↑, since the float bar is the one action surface identical on
// desktop and on a phone. Acts on the ANCHOR, exactly as ↑ does (main.ts navArrow): you can only stand
// in one place, so the two must not disagree about which node a multi-selection means. Hidden for the
// kinds with no interior and for the card you are already inside, both of which openFrame would refuse.
export function canOpenSelection(): boolean {
  const n = anchorNode();
  return !!n && canOpen(n) && !isScopeRoot(n);
}
fbOpen.addEventListener('click', (e) => { e.stopPropagation(); openFrame(anchorNode()); });
fbFold.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); toggleCollapseSelection(state.sel); syncFloatBar(); });
fbFit.addEventListener('click', (e) => { e.stopPropagation(); closePopovers(); autoSizeSelection(); syncFloatBar(); });
function anchorNode(): MindNode | undefined {
  const n: MindNode | undefined = state.selId ? state.nodes.get(state.selId) : undefined;
  return n?.el ? n : undefined;
}
// What the bar centres itself over HORIZONTALLY: the node's TITLE, not its box. A frame's box can be
// many times wider than its label, and the bar belongs over the thing you selected and are about to
// rename/recolour — centred on a wide box it drifts far from the tab it acts on. labelEl (main.ts) owns
// WHICH element that is, so the folded case needs no second spelling here; an image card renders its
// title row empty, hence the width guard falling back to the whole box.
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
  const n = anchorNode(); const el = n?.el; if (!n || !el) return false;
  let r: DOMRect | { left: number; top: number; right: number; bottom: number; width: number; height: number } = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;   // hidden (display:none) — nothing to hang off
  let lr: { left: number; top: number; width: number } = labelRect(n);
  // Several selected: over the WHOLE selection (labels included), centred on it — FigJam's — so the
  // bar never sits on one of the cards it acts on.
  if (state.sel.size > 1) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of state.sel) {
      const m = state.nodes.get(id); if (!m?.el) continue;
      for (const b of [m.el.getBoundingClientRect(), labelRect(m)]) {
        if (!b.width && !b.height) continue;
        x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
      }
    }
    if (isFinite(x0)) {
      r = { left: x0, top: y0, right: x1, bottom: y1, width: x1 - x0, height: y1 - y0 };
      lr = { left: x0, top: y0, width: x1 - x0 };
    }
  }
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const left = lr.left + lr.width / 2 - bw / 2;
  // Over whichever is higher, the box or its label: a frame's label hangs ABOVE its box (outside its
  // bounds), and the bar mustn't sit on top of the name it's about to edit.
  let top = Math.min(r.top, lr.top) - bh - GAP;
  // …flipping below the card when there isn't room above it. Measured from the SAFE top edge, not
  // the window's: under `viewport-fit=cover` the first rows of pixels can be behind the status bar
  // / notch, and a bar that "fits" there would only be clamped back down over its own card.
  if (top < safeInsets().top + 4) top = r.bottom + GAP;
  placeInViewport(bar, left, top);
  if (activePopover) positionPopover(activePopover.pop, activePopover.anchor);
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
  if (wheelIdleTimer != null) clearTimeout(wheelIdleTimer);
  wheelIdleTimer = window.setTimeout(() => { wheelBusy = false; wheelIdleTimer = null; }, 150);
}
stage.addEventListener('wheel', markWheelBusy, { passive: true });
stage.addEventListener('gesturestart', () => { wheelBusy = true; });
stage.addEventListener('gestureend', () => { wheelBusy = false; });
export function isInteracting(): boolean {
  return !!(ui.drag || ui.pan || ui.pinch || ui.marquee) || inPlaceEditActive() || wheelBusy;
}
// ONE placement pass plus its visibility consequence — every caller that moves the bar goes through
// here, so it can never paint a frame sitting in the screen corner with nothing behind it. Reports
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
  // a selected card's own add-emoji/add-note buttons (main.ts's showAddTag/.addnote) float outside
  // its border and don't reposition themselves — they'd lag behind mid-pan/zoom the same way the
  // bar itself would, so hide them right along with it via one body-level class (styles.css).
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
    if (raf == null) followLoop();
    return;
  }
  showTimer = window.setTimeout(() => {
    showTimer = null;
    // the selection this was scheduled for may already be gone by the time the delay elapses
    if (!(state.sel.size > 0 && !state.readOnly)) return;
    bar.classList.add('open');
    syncControls();
    placeBar();
    if (raf == null) followLoop();
  }, SHOW_DELAY);
}
// Crossing the narrow breakpoint (resize/rotate) docks or undocks the bar — re-place it directly.
NARROW_MQ.addEventListener('change', syncFloatBar);
