// ---------- floating selection bar ----------
// Replaces the old #editor right-hand sidebar: a compact row of icon buttons anchored right
// next to the selected card (Miro/Figma-style), instead of a persistent docked panel. Colour
// and layout each collapse to one trigger button that opens a small popover with the full
// picker (the same #edColors/#edLayoutTypes markup the old sidebar used); checklist is an icon
// toggle; a trailing kebab button replaces the old always-visible action row via the
// existing generic context menu (openMenu, features/context-menu.ts).
// On narrow/touch widths (NARROW_MQ) styles.css docks the bar to the bottom edge instead —
// this module skips the floating position math there and lets CSS own it.
import { state, stage, setStatus, isBoxType, isAnnotation, isQueryCard, type MindNode, type NodeType, type NodeLayout } from '../core/state.js';
import { NARROW_MQ, ui, inPlaceEditActive } from '../core/ui-state.js';
import { record, touch } from './history.js';
import { scheduleSave } from '../data/persistence.js';
import { subtreeBox, frameInterior, tabsOf, moveSubtreeTo, actionTarget, isTabsFrame } from '../view/layout.js';
import { outlineActive } from './outline.js';
import { FOLDER_PATH } from '../view/icons.js';
import { createProperties, type PropertyControls } from './properties.js';
import { startInlineEdit, startBodyEdit } from './inline-edit.js';
import { duplicateSelection, deleteSelection, deleteNode, deleteSelectionKeepChildren, addChild, createSibling, mkNode } from './crud.js';
import { exportSelection, shareSelection, canShareFiles, copySelection, cutSelection } from './clipboard.js';
import { pasteFromClipboard, pickImagesForNode } from './attachments.js';
import { openMenu, copyFilePath, type MenuEntry } from './context-menu.js';
import { childrenOf, isHidden, isLockedEffective, subtreeHasLocked, parentOf } from '../utils/model.js';
import { canOpen } from '../nav/scope.js';
import { frameBox } from '../view/camera.js';
import { selectedIds, selectNode, toggleCollapse, openFrame, setLockedSelection, anyLocked, labelEl, LOCK_BADGE_SVG, ICON_LOCK_OPEN, gridSnap, subtreeIds, elTop, FRAME_BORDER, FRAME_W, FRAME_H, MIN_FRAME_W, MIN_FRAME_H, FRAME_TAB_DROP, QUERY_W, QUERY_H, relayout } from '../main.js';
import { byId, placeInViewport } from '../utils/dom.js';


const bar = byId('floatBar');
const fbColor = byId<HTMLButtonElement>('fbColor');
const fbType = byId<HTMLButtonElement>('fbType');
const fbLayout = byId<HTMLButtonElement>('fbLayout');
const fbChecklist = byId<HTMLInputElement>('fbChecklist');
// the <label> wrapping the toggle (markup: <label class="fb-toggle"><input id="fbChecklist">...) —
// hidden entirely for an annotation selection, see markChips below.
const fbChecklistLabel = fbChecklist.parentElement!;
const fbLock = byId<HTMLButtonElement>('fbLock');
const fbMore = byId<HTMLButtonElement>('fbMore');
const colorPop = byId('fbColorPop');
const typePop = byId('fbTypePop');
const layoutPop = byId('fbLayoutPop');
const popConnector = byId('fbPopConnector');
const edColors = byId('edColors');
const edTypes = byId('edTypes');
const edLayoutTypes = byId('edLayoutTypes');

// colour / checklist share the SAME control wiring the sidebar (and the outline's
// branch-editor sheet) used — see features/properties.ts. Tags are omitted: no room in the bar.
// Deferred to first use (like branch-editor.ts's own instance): createProperties() eagerly builds
// the swatch row from main.js's PALETTE/SWATCH_BG, which aren't initialized yet while this module
// is still being imported at main.ts's top — see the main↔features import cycle note in CLAUDE.md.
let _props: PropertyControls | null = null;
function props(): PropertyControls {
  // actionTarget, not the raw selection: selecting a tab group's box means "this frame" to the user, and
  // the frame they mean is the OPEN TAB — so its colour (and its checklist) is what the swatches read
  // and write. Colouring the invisible group would look like nothing happened; colouring the open tab
  // tints the box too, since that's where the box takes its colour from (effectiveColor).
  return _props ??= createProperties({ colors: edColors, checklist: fbChecklist },
    () => selectedIds().map(id => actionTarget(state.nodes.get(id)!).id));
}

// ---------- layout picker ----------
// Moved here from main.ts now that the layout chips live in this bar's popover rather than the
// old sidebar; still purely canvas geometry, just owned by the editor surface instead of the
// render core.
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const DOT = (cx: number, cy: number, r = 2.2) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
// One card in a layout icon — the arrangement glyphs below are nothing but these, laid out the way
// the layout lays children out.
const BLOCK = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="currentColor" stroke="none"/>`;
// A node's KIND. Selecting one seeds/tears down its box (see setType) and swaps which layout
// chips the layout popover offers (LAYOUTS_BY_TYPE below).
const TYPE_ICONS: Record<NodeType, string> = {
  // A plain box: the FRAME's folder less its tab, and shallower — the two kinds differ by exactly
  // that tab on the canvas too. Nothing inside it, so it can't be read as "a card with two lines of
  // something"; the dashed `inherit` layout chip is the only other hollow rect and stays distinct.
  card: SVG_OPEN + '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/></svg>',
  frame: SVG_OPEN + FOLDER_PATH + '</svg>',
  stack: SVG_OPEN + '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 8.5h16"/><rect x="6.5" y="10.5" width="11" height="2.5" rx="1" fill="currentColor" stroke="none"/><rect x="6.5" y="14.5" width="11" height="2.5" rx="1" fill="currentColor" stroke="none"/></svg>',
  annotation: SVG_OPEN + '<path d="M4 4l3.5 3.5" stroke-dasharray="2 2"/><rect x="8" y="8" width="12" height="9" rx="2"/><path d="M10.5 12h7"/></svg>',
  query: SVG_OPEN + '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="10" cy="10" r="3"/><path d="M12.3 12.3l3 3"/></svg>',
};
const NODE_TYPES: { key: NodeType; label: string; icon: string }[] = [
  { key:'card',  label:'Card — an ordinary note',                                        icon: TYPE_ICONS.card },
  { key:'frame', label:'Frame — a resizable box; drag cards inside to hold them, out to release', icon: TYPE_ICONS.frame },
  { key:'stack', label:'Stack — an outline: the whole subtree listed in one indented column, auto-sized', icon: TYPE_ICONS.stack },
  { key:'annotation', label:'Annotation — a title-less note pinned on top of its parent, ignored by layout', icon: TYPE_ICONS.annotation },
  { key:'query', label:'Query — a resizable box with a search field over a scrollable list of matching cards', icon: TYPE_ICONS.query },
];
// An ARRANGEMENT, one glyph per layout key — deliberately generic: none of them draws the container
// it sits in, so the same chip means the same thing whichever kind offers it (`free` is shared by
// card and frame already, and a kind added later inherits the vocabulary for free). Blocks are cards:
// scattered for free, three columns for horizontal, three rows for vertical. `tabs` is excluded from
// the map, not just from the rows below — it's never a chip (see LAYOUTS_BY_TYPE.frame).
const LAYOUT_ICONS: Record<Exclude<NodeLayout, 'tabs'>, string> = {
  inherit: SVG_OPEN + '<rect x="5" y="7" width="14" height="10" rx="2" stroke-dasharray="3 2.5"/></svg>',
  // Cards where they were dropped — the same BLOCKs the two flow glyphs use, just not lined up. Dots
  // are the CONNECTOR vocabulary (line/fan below, where what matters is the chain, not the card).
  free: SVG_OPEN + BLOCK(3.5, 4.8, 7.5, 4) + BLOCK(13, 10, 7.5, 4) + BLOCK(5.5, 15.2, 7.5, 4) + '</svg>',
  line: SVG_OPEN + DOT(4,12) + '<path d="M6.5 12h3"/>' + DOT(12,12) + '<path d="M14.5 12h3"/>' + DOT(20,12) + '</svg>',
  fan: SVG_OPEN + DOT(4,12) + '<path d="M6 12l6-6M6 12h6M6 12l6 6"/>' + DOT(14,6,1.8) + DOT(14,12,1.8) + DOT(14,18,1.8) + '</svg>',
  horizontal: SVG_OPEN + BLOCK(3.5, 5, 4.6, 14) + BLOCK(9.7, 5, 4.6, 14) + BLOCK(15.9, 5, 4.6, 14) + '</svg>',
  vertical: SVG_OPEN + BLOCK(3.5, 5, 17, 3.2) + BLOCK(3.5, 10.4, 17, 3.2) + BLOCK(3.5, 15.8, 17, 3.2) + '</svg>',
};
// How a node of each type arranges its children. The layout popover shows exactly this type's set
// (image has none — it's a leaf, so its layout chip row is empty and the trigger is hidden).
const LAYOUTS_BY_TYPE: Record<NodeType, { key: NodeLayout; label: string; icon: string }[]> = {
  card: [
    { key:'inherit', label:'Inherit — take the parent’s layout (default)', icon: LAYOUT_ICONS.inherit },
    { key:'free', label:'Free — children stay where you drag them', icon: LAYOUT_ICONS.free },
    { key:'line', label:'Line — children chained one after another, each on whichever side it sits on',
      icon: LAYOUT_ICONS.line },
    { key:'fan', label:'Fan — children spread out, each to whichever side it’s placed on', icon: LAYOUT_ICONS.fan },
  ],
  frame: [
    { key:'free', label:'Free — children placed freely inside the box', icon: LAYOUT_ICONS.free },
    { key:'horizontal', label:'Horizontal — cards flow left to right, wrapping down', icon: LAYOUT_ICONS.horizontal },
    { key:'vertical', label:'Vertical — cards flow top to bottom, wrapping right', icon: LAYOUT_ICONS.vertical },
    // No `tabs` chip, deliberately: a tab group is made by DRAGGING one frame's title onto another's
    // tab and unmade by dragging its tabs back out (the last one takes the empty box with it), so
    // `mm_layout: tabs` is bookkeeping the user never picks. It's also unreachable from here — an open
    // group can't be selected at all (main.ts selTarget) — and markChips hides this whole row for the
    // one group that still can be, the folded pill.
  ],
  // a stack always outlines its whole subtree — there's nothing to choose, so its chip row is empty
  // and the layout trigger hides itself (markChips), same as for the leaf kinds
  stack: [],
  annotation: [],
  query: [],
};
// The default layout for a freshly-set type — omitted from frontmatter (see serializeMd).
const DEFAULT_LAYOUT: Record<NodeType, NodeLayout> = { card: 'inherit', frame: 'free', stack: 'inherit', annotation: 'free', query: 'free' };
// Fit a frame's box snugly around its children: the same margin on every side, snapped to the grid
// and clamped to the min size. Children keep their positions (the box moves to enclose them). With
// no children it's left as-is, or given the default size when `orDefault` (used when a card first
// becomes a frame). Shared by the frame chip and the Auto-size action.
// The TOP margin also has to carry the frame's own title tab: n.y is the tab's top edge and the box
// starts FRAME_TAB_DROP lower (main.ts), so the pad above the content is that drop plus the same
// margin as the other three sides. n.h then encloses the tab for free, since it measures from n.y.
// A function, not a const: main.js's exports aren't initialized yet while this module's body runs
// (the deliberate main↔features import cycle — see CLAUDE.md and the props() note above), so reading
// FRAME_TAB_DROP at module scope throws "cannot access before initialization".
const FRAME_FIT_PAD = 16;
function frameFitTop(): number { return FRAME_TAB_DROP + FRAME_FIT_PAD; }
export function fitFrameToContent(n: MindNode, orDefault = false): void {
  const kids = childrenOf(n.id).filter(k => !isHidden(k) && !isAnnotation(k));   // annotations don't size the frame
  const snapStep = gridSnap();
  const snap = (v: number): number => Math.round(v / snapStep) * snapStep;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of kids) {
    const b = subtreeBox(k); if (!isFinite(b.x0)) continue;
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  if (!isFinite(x0)) { if (orDefault) { n.w = FRAME_W; n.h = FRAME_H; } return; }
  n.x = snap(x0 - FRAME_FIT_PAD);
  n.y = snap(y0 - frameFitTop());
  n.w = Math.max(MIN_FRAME_W, snap(x1 + FRAME_FIT_PAD - n.x));
  n.h = Math.max(MIN_FRAME_H, snap(y1 + FRAME_FIT_PAD - n.y));
}
// Auto-size every selected frame to fit its content (shortcut / context menu).
export function autoSizeSelection(): void {
  const ids = selectedIds().filter(id => state.nodes.get(id)?.type === 'frame' && !isLockedEffective(state.nodes.get(id)!));
  if (!ids.length) return;
  record(ids, () => { for (const id of ids){ const n = state.nodes.get(id); if (n) { fitFrameToContent(n); n.dirty = true; } } });
  relayout(); scheduleSave();
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
    const fy = isFinite(y0) ? snap(y0 - frameFitTop()) : 0;
    const fw = isFinite(x1) ? Math.max(MIN_FRAME_W, snap(x1 + FRAME_FIT_PAD - fx)) : FRAME_W;
    const fh = isFinite(y1) ? Math.max(MIN_FRAME_H, snap(y1 + FRAME_FIT_PAD - fy)) : FRAME_H;
    const frame = mkNode({
      x: fx, y: fy, w: fw, h: fh, parent: parentId,
      // A frame is one kind that keeps a required title: its folder tab is the only thing you can
      // grab it by, and a blank tab reads as broken. No dedupe — the FILE takes the suffix now.
      title: 'Frame', type: 'frame', layout: 'free',
    });
    frameId = frame.id;
    state.nodes.set(frameId, frame);
    for (const n of nodes) { touch(n.id); n.parent = frameId; n.dirty = true; }
  });
  relayout(); selectNode(frameId); scheduleSave();
  setStatus(`Grouped ${nodes.length} card${nodes.length === 1 ? '' : 's'} into a frame`);
}
(function buildTypeChips(){
  edTypes.innerHTML = NODE_TYPES.map(t =>
    `<div class="layoutchip" data-type="${t.key}" title="${t.label}">${t.icon}</div>`).join('');
  edTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { setType(c.dataset.type as NodeType); closePopovers(); }));
})();
// The layout chips are type-dependent, so they're (re)built lazily whenever the selected type
// changes — `builtFor` avoids rebuilding (and re-binding listeners) on every sync.
let builtFor: NodeType | null = null;
function rebuildLayoutChips(type: NodeType): void {
  if (builtFor === type) return;
  builtFor = type;
  edLayoutTypes.innerHTML = LAYOUTS_BY_TYPE[type].map(l =>
    `<div class="layoutchip" data-layout="${l.key}" title="${l.label}">${l.icon}</div>`).join('');
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.addEventListener('click', () => { setLayout(c.dataset.layout as NodeLayout); closePopovers(); }));
}
// Change the KIND of the selection: seed/reset the box, drop a now-invalid layout, reseed order.
function setType(type: NodeType): void {
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
  // annotation/query are leaves — refuse to flip a card that already has children into one
  if ((type === 'annotation' || type === 'query') && ids.some(id => childrenOf(id).length)) {
    setStatus(`A${type === 'query' ? ' query card' : 'n annotation'} can’t have children — move or delete them first`);
    return;
  }
  record(ids, () => {
    for (const id of ids){
      const n = state.nodes.get(id); if (!n || n.type === type) continue;
      // Leaving a 2D box for a width-only kind: drop BOTH axes of its box size. The height has to go
      // (the new kind measures or derives its own), and so does the width — a frame's box is sized to
      // enclose its children, which says nothing about how wide its own title/body wants to be, and
      // silently keeping it would turn a converted 800px frame into an 800px card.
      // card/annotation/stack: the height is never authored — and the width goes too if we're
      // leaving a 2D box, whose width described its contents rather than its own text.
      // A tab group is a FRAME with layout tabs; leaving `frame` behind dissolves the group, so its
      // tabs need their own boxes back (same as switching the layout away — see undockAllTabs).
      if (n.type === 'frame' && n.layout === 'tabs' && type !== 'frame') undockAllTabs(n);
      if (!isBoxType(type)) { n.h = undefined; if (isBoxType(n.type)) n.w = undefined; }
      if (type === 'frame') fitFrameToContent(n, true);   // give it a box enclosing its children
      if (type === 'query' && (n.w == null || n.h == null)) { n.w = QUERY_W; n.h = QUERY_H; }
      n.type = type;
      // keep the current arrangement if the new type still supports it (e.g. free across card↔frame);
      // otherwise fall back to the type's default (card→inherit, frame→free, leaf kinds→none).
      if (!LAYOUTS_BY_TYPE[type].some(l => l.key === n.layout)) n.layout = DEFAULT_LAYOUT[type];
      n.kidOrder = undefined;   // reseed order from the children's CURRENT positions under the new type
      n.dirty = true;
    }
  });
  markChips();
  relayout(); scheduleSave();
}
// Give a tab group's tabs their own boxes back: open every one (only one was open) and cascade them
// inside the frame, since as tabs they were all stacked in the same strip band and would otherwise
// land in a pile. Their authored mm_w/mm_h were never touched while docked, so each comes back at the
// size it went in at. Run while the frame is still a tabs frame, i.e. BEFORE the type is reassigned —
// setType (retyping a folded group to a card/stack/…) is the one caller left, since the layout picker
// no longer offers tabs at all and hides itself for a group.
function undockAllTabs(g: MindNode): void {
  const box = frameInterior(g);
  tabsOf(g).forEach((t, i) => {
    touch(...subtreeIds(t.id));   // its whole subtree moves with it, so it all needs undoing
    const lent = frameInterior(t);   // where its cards sit right now: the interior the group lent it
    t.collapsed = false;
    t.x = box.x + 20 + i * 24; t.y = box.y + 20 + i * 24;
    // Re-anchor its cards to the box they're in rather than carrying them along with the frame: while
    // docked, their offset was measured from a LABEL in the strip, which says nothing about where they
    // sit — what has to be preserved is their position inside the interior. Spelt out (border, plus the
    // frame's own title tab) because the group's layout hasn't flipped yet, so frameInterior would
    // still hand back the lent box.
    const dx = (t.x + FRAME_BORDER) - lent.x, dy = (t.y + FRAME_BORDER + FRAME_TAB_DROP) - lent.y;
    for (const k of childrenOf(t.id)) moveSubtreeTo(k, k.x + dx, k.y + dy);
    t.dirty = true; t.dirtyLayout = true;
  });
}
// Change the child-ARRANGEMENT of the selection (within its current type).
function setLayout(layout: NodeLayout): void {
  const ids = selectedIds().filter(id => !isLockedEffective(state.nodes.get(id)!)); if (!ids.length) return;
  record(ids, () => {
    for (const id of ids){
      const n = state.nodes.get(id); if (!n || n.layout === layout) continue;
      // No tabs case here: this row is hidden for a tab group (markChips), so a layout is never
      // reassigned over one. Leaving tabs behind is the KIND picker's job (setType → undockAllTabs).
      // Drop the stored child order: a switch INTO a managed layout (line/fan/flow) must reseed
      // order from the children's CURRENT positions — a free layout never touches kidOrder, so a
      // stale order from an earlier managed pass would otherwise survive.
      n.layout = layout;
      n.kidOrder = undefined;
      n.dirty = true;
    }
  });
  markChips();
  relayout(); scheduleSave();
}
// Reflect the selection's current type + layout in both popovers AND their trigger icons. A single
// type shows its chip active and its layout set; a mixed-type selection leaves both blank. The
// layout picker is rebuilt for the selected type and hidden entirely for leaves (image/annotation).
function markChips(): void {
  const ids = selectedIds();
  const typeSet = new Set(ids.map(id => state.nodes.get(id)?.type ?? 'card'));
  const type = typeSet.size === 1 ? [...typeSet][0] : null;
  edTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === type));
  fbType.innerHTML = type ? TYPE_ICONS[type] : TYPE_ICONS.card;

  // a checklist is meaningless on an annotation (a title-less leaf that can never have children —
  // no subtree to check off) — hide the toggle entirely rather than leave a no-op control in the bar.
  fbChecklistLabel.style.display = type === 'annotation' ? 'none' : '';

  const forType: NodeType = type ?? 'card';
  rebuildLayoutChips(forType);
  // A tab group has no arrangement to choose — its open tab lays out the box's contents, and tabs
  // mode itself is entered/left by dragging (no chip, see LAYOUTS_BY_TYPE.frame). Only a FOLDED group
  // reaches this at all, and showing it three chips with none active would read as a layout it lost;
  // worse, clicking one would silently dissolve the group. Hide the row for any selection holding one.
  const hasTabs = ids.some(id => { const n = state.nodes.get(id); return !!n && isTabsFrame(n); });
  const hasLayout = LAYOUTS_BY_TYPE[forType].length > 0 && !hasTabs;
  fbLayout.style.display = hasLayout ? '' : 'none';
  if (!hasLayout) { fbLayout.innerHTML = ''; return; }
  const layoutSet = new Set(ids.map(id => state.nodes.get(id)?.layout));
  const layout = (type && layoutSet.size === 1) ? [...layoutSet][0] : null;
  edLayoutTypes.querySelectorAll<HTMLElement>('.layoutchip').forEach(c =>
    c.classList.toggle('active', c.dataset.layout === layout));
  const active = edLayoutTypes.querySelector('.layoutchip.active');
  fbLayout.innerHTML = active ? active.innerHTML : LAYOUTS_BY_TYPE[forType][0].icon;
}

// ---------- colour trigger ----------
// The trigger button reuses the SAME .swatch/.inherit/.nofill CSS look as the popover's chips
// (see index.html: fbColor starts with class "fb-swatch swatch inherit") — just mirror whichever
// swatch is currently active.
function markColorTrigger(): void {
  const active = edColors.querySelector<HTMLElement>('.swatch.active');
  fbColor.classList.remove('inherit', 'nofill');
  fbColor.style.removeProperty('--sw');
  if (!active || active.classList.contains('inherit')) fbColor.classList.add('inherit');
  else if (active.classList.contains('nofill')) fbColor.classList.add('nofill');
  else fbColor.style.setProperty('--sw', active.style.getPropertyValue('--sw'));
}

// ---------- lock toggle ----------
// Replaces the old Lock/Unlock context-menu entry. A locked card can't be moved, folded, renamed,
// re-typed, re-coloured or deleted (isLockedEffective), so every OTHER control in the bar would be
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
  markChips();
  markColorTrigger();
  markLock();
}

// ---------- popovers (colour / layout) ----------
// 12px — the same margin every corner/toolbar button keeps from the browser window edge
// (#toolbar's top:12px, .floating-btn's 12px offsets, …), so the popover sits the same
// "distance away" from the bar as the bar's own chrome sits from the window.
const POP_GAP = 12;
let activePopover: { pop: HTMLElement; anchor: HTMLElement } | null = null;
function positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
  const ar = anchor.getBoundingClientRect();
  // vertical offset comes from the BAR's own rect, not the individual trigger's — fbColor's
  // swatch button is a smaller box than the other (--bar-btn sized) triggers, so anchoring to
  // its own rect would hang the colour popover a few px lower than the layout one. The bar's
  // height is shared by both triggers, so this keeps them flush regardless of that difference.
  const br = bar.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = ar.left + ar.width / 2 - pw / 2;
  let top = br.top - ph - POP_GAP;
  const above = top >= 4;
  if (!above) top = br.bottom + POP_GAP;
  top = placeInViewport(pop, left, top).top;
  // the connector stem bridges the gap, centred on the ANCHOR (not the popover, which may have
  // been clamped sideways near a screen edge) so it always starts right at the trigger button.
  popConnector.style.left = `${ar.left + ar.width / 2 - 1}px`;
  popConnector.style.top = `${above ? top + ph : br.bottom}px`;
  popConnector.style.height = `${POP_GAP}px`;
  popConnector.classList.add('open');
}
function closePopovers(): void {
  colorPop.classList.remove('open');
  typePop.classList.remove('open');
  layoutPop.classList.remove('open');
  popConnector.classList.remove('open');
  activePopover = null;
}
function togglePopover(pop: HTMLElement, anchor: HTMLElement): void {
  const willOpen = activePopover?.pop !== pop;
  closePopovers();
  if (willOpen){ pop.classList.add('open'); activePopover = { pop, anchor }; positionPopover(pop, anchor); }
}
fbColor.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(colorPop, fbColor); });
fbType.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(typePop, fbType); });
fbLayout.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(layoutPop, fbLayout); });
// a colour pick updates the trigger's own swatch look and closes the popover (the layout popover
// already closes itself in setLayout above). Runs after properties.ts's own listener has already
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
  if (activePopover && !colorPop.contains(t) && !typePop.contains(t) && !layoutPop.contains(t)
      && t !== fbColor && t !== fbType && t !== fbLayout) closePopovers();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && activePopover) closePopovers(); }, true);

// ---------- card actions menu: rename / edit note / duplicate / export / delete / … ----------
// Shared by the kebab button here AND the right-click context menu (features/context-menu.ts) —
// ONE list of entries so the two never drift apart. `n` is the menu's TARGET card: the kebab's
// target is always the (sole) selection anchor; the context menu's is whatever was clicked, which
// may or may not be part of the current multi-selection. `sx`/`sy` only matter for "Paste as
// child" (where the pasted card lands) — the kebab has no cursor position, so it passes the
// button's own screen position instead.
export function buildCardMenu(n: MindNode, sx: number, sy: number): MenuEntry[] {
  const multi = state.sel.has(n.id) && state.sel.size > 1;
  const targetIds = multi ? [...state.sel] : [n.id];
  const anyFrame = targetIds.some(id => state.nodes.get(id)?.type === 'frame');
  // group actions (Duplicate/Cut/Copy/Export/Share/Auto-size) act on state.sel via selectedIds();
  // when the target isn't already part of the selection, select it first so they act on IT.
  const selectTargetFirst = () => { if (!multi) selectNode(n.id); };
  const isAnno = isAnnotation(n);   // a leaf with a body but no title, no children
  const isQuery = isQueryCard(n);   // a leaf with its own search field, no body, but keeps its title
  const isLeaf = isAnno || isQuery;   // neither can hold children
  const locked = isLockedEffective(n);                 // n itself: locked, or a locked descendant
  const p = parentOf(n);
  const parentLocked = !!p && isLockedEffective(p);
  const anyLocked = targetIds.some(id => isLockedEffective(state.nodes.get(id)!));
  const anySubtreeLocked = targetIds.some(id => subtreeHasLocked(id));
  const entries: MenuEntry[] = [];
  if (!state.readOnly){
    if (!multi){
      if (!isAnno && !isQuery) entries.push({ label:'Rename', shortcut:'F2', run: () => startInlineEdit(n), disabled: locked });   // query has no renamable title — F2 edits its query instead (features/inline-edit.ts)
      if (!isQuery) entries.push({ label:'Edit note', shortcut:'E', run: () => startBodyEdit(n), disabled: locked });   // annotation keeps its body; query has none
      if (!isQuery) entries.push({ label:'Insert image…', run: () => pickImagesForNode(n.id), disabled: locked });
      if (!isLeaf){
        entries.push('sep');
        entries.push({ label:'Add child', shortcut:'Tab', run: () => addChild(n.id), disabled: locked });
        entries.push({ label:'Paste as child', shortcut:'⌘V', run: () => { void pasteFromClipboard(sx, sy, n.id); }, disabled: locked });
      }
      entries.push({ label:'Add sibling', shortcut:'Enter', run: () => createSibling(n.id), disabled: parentLocked });
    }
    entries.push({ label:'Duplicate', shortcut:'D', run: () => { selectTargetFirst(); duplicateSelection(); } });
    entries.push({ label:'Cut', shortcut:'⌘X', run: () => { selectTargetFirst(); void cutSelection(); }, disabled: anySubtreeLocked });
    entries.push({ label:'Group into frame', shortcut:'G', run: () => { selectTargetFirst(); groupSelectionIntoFrame(); }, disabled: anyLocked });
    // Lock/unlock is NOT here: it lives on the float bar's own lock toggle (markLock above), which
    // is the only control left in the bar once a card is locked. The L shortcut still works too.
    entries.push('sep');
  }
  // copy/collapse/fit/export never mutate → allowed in read-only mode too
  entries.push({ label:'Copy', shortcut:'⌘C', run: () => { selectTargetFirst(); void copySelection(); } });
  if (!multi)
    entries.push({ label: n.collapsed ? 'Expand' : 'Collapse', shortcut:'X', run: () => toggleCollapse(n.id),
      disabled: locked || (!childrenOf(n.id).length && !(n.body && n.body.trim())) });
  // Opening a frame mutates nothing, so it belongs in this read-only-safe block — and it's the one
  // way IN while read-only, since a double-click there still folds instead (activateNode). Routed
  // through actionTarget, so right-clicking a tab GROUP's box opens the tab that's showing.
  if (!multi && canOpen(actionTarget(n)))
    entries.push({ label:'Open frame', shortcut:'↑', run: () => openFrame(n) });
  entries.push({ label:'Fit view', shortcut:'F', run: () => frameBox(targetIds.map(id => state.nodes.get(id))) });
  entries.push({ label:'Copy file path', run: () => copyFilePath(n), disabled: !n.file });
  if (anyFrame && !state.readOnly)
    entries.push({ label: multi ? 'Auto-size frames' : 'Auto-size frame', shortcut:'⇧A',
      run: () => { selectTargetFirst(); autoSizeSelection(); }, disabled: anyLocked });
  entries.push('sep', { label:'Download selected cards', run: () => { selectTargetFirst(); exportSelection(); } });
  entries.push({ label:'Share…', run: () => { selectTargetFirst(); void shareSelection(); }, disabled: !canShareFiles });
  if (!state.readOnly){
    entries.push('sep', { label: multi ? `Delete ${state.sel.size} cards` : 'Delete', shortcut:'Del',
      danger: true, run: () => multi ? deleteSelection() : deleteNode(n.id), disabled: anySubtreeLocked });
    entries.push({ label: multi ? `Delete ${state.sel.size} cards, keep children` : 'Delete, keep children', shortcut:'⌥Del',
      danger: true, run: () => { selectTargetFirst(); deleteSelectionKeepChildren(); }, disabled: anyLocked });
  }
  return entries;
}
fbMore.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = state.selId; const n = id ? state.nodes.get(id) : undefined;
  if (!n) return;
  const r = fbMore.getBoundingClientRect();
  const entries = buildCardMenu(n, r.left, r.bottom);
  openMenu(entries, r.left, r.bottom + 4);
});

// ---------- anchoring: float the bar right above/below the selected card ----------
const GAP = 20;
function anchorNode(): MindNode | undefined {
  const n: MindNode | undefined = state.selId ? state.nodes.get(state.selId) : undefined;
  return n?.el ? n : undefined;
}
// What the bar centres itself over HORIZONTALLY: the node's TITLE, not its box. A frame's box can be
// many times wider than its label, and the bar belongs over the thing you selected and are about to
// rename/recolour — centred on a wide box it drifts far from the tab it acts on. Via actionTarget, so a
// selected tab GROUP (which shows no title of its own) uses its OPEN TAB's label, the same node its
// colour/rename/delete already land on. labelEl (main.ts) owns WHICH element that is, so the folded /
// docked case needs no second spelling here; an image card / annotation renders its title row empty,
// hence the width guard falling back to the whole box.
function labelRect(n: MindNode): DOMRect {
  const t = actionTarget(n);
  const el = t.el ?? n.el!;
  const lr = labelEl(t)?.getBoundingClientRect();
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
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;   // hidden (display:none) — nothing to hang off
  const lr = labelRect(n);
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const left = lr.left + lr.width / 2 - bw / 2;
  // Anchor on the node's BOUNDS top, not its element's: a frame box's element starts FRAME_TAB_DROP
  // below the bounds with the title tab hanging above it (elTop, main.ts), so measuring the element
  // would hang the bar over the tab and shift it when a frame is converted to a card or back.
  let top = r.top - elTop(n, 0) * state.view.k - bh - GAP;
  if (top < 4) top = r.bottom + GAP;   // not enough room above → flip below the card
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
function isInteracting(): boolean {
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
    popConnector.classList.toggle('hide-interact', interacting || !placed);
  }
  // a selected card's own add-emoji/add-note buttons (main.ts's showAddTag/.addnote) float outside
  // its border and don't reposition themselves — they'd lag behind mid-pan/zoom the same way the
  // bar itself would, so hide them right along with it via one body-level class (styles.css).
  document.body.classList.toggle('canvas-interacting', interacting);
  raf = bar.classList.contains('open') ? requestAnimationFrame(followLoop) : null;
}
window.addEventListener('resize', () => { closePopovers(); placeBar(); });

// ---------- visibility ----------
// Outline mode only hides the bar on a narrow/phone screen, where the outliner replaces the
// canvas entirely (no card left to anchor to). On a wide screen the outliner is a drawer over a
// still-visible canvas, so a selected card can keep its bar.
//
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
  const visible = state.sel.size > 0 && !state.readOnly && !(outlineActive() && NARROW_MQ.matches);
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
    if (!(state.sel.size > 0 && !state.readOnly && !(outlineActive() && NARROW_MQ.matches))) return;
    bar.classList.add('open');
    syncControls();
    placeBar();
    if (raf == null) followLoop();
  }, SHOW_DELAY);
}
// Crossing the narrow breakpoint (resize/rotate) can flip the outline+selection combo above
// without any selection change of its own, so re-run the visibility check directly.
NARROW_MQ.addEventListener('change', syncFloatBar);
