// ---------- node lifecycle: create / duplicate / delete / extract ----------
// Every node is one .md file; ids are ephemeral (minted in mkNode). All create/duplicate paths go
// through mkNode so the node schema stays in one place. Each mutation schedules a save. Re-parenting
// by drag lives in features/drag.ts; this is the keyboard/toolbar-driven lifecycle.
import { state, setStatus, isLeafType, isAnnotation, isImageCard, type MindNode, type NodeType, type NodeLayout } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf, takenTitles, isLockedEffective, subtreeHasLocked, isAncestor } from '../utils/model.js';
import { applyLayouts, insertedKidOrder, sideOf, isTabsFrame, isDockedTab, canBeTab, tabsOf, activeTab, actionTarget, frameInterior, frameInsetY, moveSubtreeTo } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, setSelectionSet, applySelection, selectedIds, nodeH, subtreeIds, FRAME_BORDER, FRAME_W, FRAME_H } from '../main.js';
import { startInlineEdit } from './inline-edit.js';
import { touch, commitStep, record } from './history.js';

// Mint a fresh node with the standard shape; callers override only the fields they care about.
// Keeps the node schema (and its defaults) in ONE place so every create/duplicate path stays in
// sync — the id is always minted here (ids are ephemeral, see below).
export function mkNode(fields: Partial<MindNode> = {}): MindNode {
  const id = 'n' + (state.idSeq++);
  touch(id);   // not in state.nodes yet → before-image is null (undo of a create = remove it)
  return {
    id, file:null,
    x:0, y:0, rx:0, ry:0, parent:null, collapsed:false, locked:false, done:false, checklist:false,
    title:'', color:'', keepStatus:'', tags:[], body:'',
    type:'card', layout:'inherit',
    dirty:true, dirtyLayout:true,
    ...fields,
  };
}
// Make a new UNCONNECTED node (parent:null) at the viewport centre (or a given spot).
interface CreateOpts {
  x?: number; y?: number; parent?: string | null; title?: string; color?: string;
  tags?: string[]; body?: string; type?: NodeType; layout?: NodeLayout; isNew?: boolean;
  w?: number; h?: number;
  edit?: boolean;   // false = don't open the inline rename (e.g. paste — the content is final)
}
export function createNode(opts: CreateOpts = {}): MindNode | undefined {
  if (state.readOnly) return;
  if (opts.parent) {
    const p = state.nodes.get(opts.parent);
    if (p && isLockedEffective(p)) { setStatus('Locked — can’t add a child'); return; }
  }
  const c = screenToWorld(window.innerWidth/2, window.innerHeight/2);
  const n = mkNode({
    x: opts.x ?? (c.x - 100), y: opts.y ?? (c.y - 40),
    parent: opts.parent ?? null,
    title: opts.title ?? (opts.type === 'annotation' ? uniqueTitle('Annotation') : newCardTitle()),
    color: opts.color ?? '',
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    type: opts.type ?? 'card', layout: opts.layout ?? 'inherit',
    w: opts.w, h: opts.h,
  });
  const id = n.id;
  state.nodes.set(id, n);
  applyLayouts(); paintAll(); selectNode(id);
  if (opts.edit !== false) startInlineEdit(n, { isNew: opts.isNew ?? true });
  else commitStep();   // no rename session follows, so the create step ends here
  scheduleSave();
  return n;
}
// Create an annotation at (x,y). If a card is selected it becomes that card's child (the primary
// selection anchor — as long as it can hold children); otherwise it's a root. Shared by the 'A'
// shortcut and the "Create annotation here" context-menu entry.
export function createAnnotationHere(x: number, y: number): MindNode | undefined {
  const sel = state.selId ? state.nodes.get(state.selId) : null;
  // an annotation can pin to anything EXCEPT another annotation (images included — you can annotate them)
  const parent = sel && !isAnnotation(sel) ? sel.id : null;
  return createNode({ x, y, type:'annotation', parent });
}
// Make a new unconnected node at (x,y) and render it, but DON'T select / rename / save yet — the
// caller drives it (e.g. the ghost-card drag rides it under the cursor, then renames on drop or
// deletes it on cancel). Kept save-free so an abandoned drag never writes a file.
export function createDetachedNode(x: number, y: number): MindNode | undefined {
  if (state.readOnly) return;
  const n = mkNode({ x, y, parent:null, title: newCardTitle() });
  state.nodes.set(n.id, n);
  paintAll();   // give the card a DOM element so it can be dragged
  return n;
}
// Pick a title not already in use: "Some heading" -> "Some heading 2" -> "Some heading 3"…
export function uniqueTitle(base: string): string {
  const taken = takenTitles();
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}
// Titles are numbered: fresh cards are "New Card 1", "New Card 2", …; a copy of "Idea 3" tries
// "Idea 4" next (or the first free number after it), and a copy of an unnumbered "Idea" starts
// a new suffix at "Idea 2".
function splitNumbered(title: string): { base: string; num: number | null } {
  const m = title.match(/^(.*\S) (\d+)$/);
  return m ? { base: m[1], num: parseInt(m[2], 10) } : { base: title, num: null };
}
function nextNumberedTitle(base: string, from = 1): string {
  const taken = takenTitles();
  let i = from;
  while (taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}
export const newCardTitle = (): string => nextNumberedTitle('New Card');
const copyTitle = (title: string): string => {
  const { base, num } = splitNumbered(title);
  return nextNumberedTitle(base, (num ?? 1) + 1);   // numbered → next free number; plain → "… 2"
};
// Clone one card (not its subtree) at (x,y): same content/colour, keeping its parent so the copy
// stays attached as a sibling. Gets the next free numbered title (copyTitle) so its file is valid.
// Shared by the duplicate (sidebar/keyboard) and Shift-drag clone paths; doesn't touch selection/layout.
function cloneNodeAt(s: MindNode, x: number, y: number): MindNode {
  const copy = mkNode({
    x, y,
    parent: s.parent,
    title: copyTitle(s.title),
    color: s.color,
    tags: [...s.tags], body: s.body, done: s.done, checklist: s.checklist,
    type: s.type, layout: s.layout, side: s.side,
    w: s.w, h: s.h,   // a frame/image card's own box size
  });
  state.nodes.set(copy.id, copy);
  return copy;
}
// A duplicate sits directly below the original, clear of it.
function copyNode(s: MindNode): MindNode { return cloneNodeAt(s, s.x, s.y + nodeH(s) + 24); }
// Duplicate every selected card (or just the one). Each copy keeps its source's parent, so it
// stays connected. One card → open its rename like a fresh node; many → select the new copies.
// `edit:false` skips the rename (outline duplicate just drops the copy into the list, selected —
// see features/outline.ts) so it doesn't yank the user into an editor.
export function duplicateSelection({ edit = true }: { edit?: boolean } = {}): MindNode[] | undefined {
  if (state.readOnly) return;
  const ids = selectedIds();
  const srcs = ids.map(id => state.nodes.get(id)).filter((n): n is MindNode => !!n);
  if (!srcs.length) return;
  const copies = srcs.map(copyNode);
  // paint first so the new cards get real DOM heights — applyLayouts measures offsetHeight,
  // and a chain/fan of fresh copies would otherwise stack on the 64px fallback (only the first
  // lands right). Then lay out with correct heights and commit.
  paintAll(); applyLayouts(); paintAll();
  const msg = copies.length === 1 ? `Duplicated → “${copies[0].title}”` : `Duplicated ${copies.length} cards`;
  if (copies.length === 1 && edit){
    selectNode(copies[0].id);
    startInlineEdit(copies[0], { isNew: false });
  } else {
    setSelectionSet(copies.map(c => c.id));
    commitStep();   // no rename opens, so the step ends here
  }
  setStatus(msg);
  scheduleSave();
  return copies;
}
// Shift+drag clone: drop a copy at `pos` that keeps the source's parent (a sibling),
// while the original is the node being dragged away. Doesn't steal selection/focus.
export function leaveClone(s: MindNode, pos: Pt): MindNode {
  const copy = cloneNodeAt(s, pos.x, pos.y);
  setStatus(`Cloned → “${copy.title}”`);
  return copy;
}

// ---------- add child / sibling ----------
// Where a new child of `n` actually belongs. A tab GROUP holds no content of its own — its box is
// whichever tab is OPEN — so a card added "to the group" goes into that tab, or it would sit in the box
// and stay put through every tab switch. And a card added as a SIBLING of a tab isn't a tab (only
// frames are), so it belongs inside that tab too. The keyboard counterpart of the drop routing in
// features/drag.ts; an empty group has no tab to take it and keeps the card itself.
export function contentParent(n: MindNode): MindNode {
  return isTabsFrame(n) ? (activeTab(n) ?? n) : n;
}
export function addChild(parentId: string): void {
  if (state.readOnly) return;
  const parent0 = state.nodes.get(parentId); if (!parent0) return;
  const parent = contentParent(parent0); parentId = parent.id;
  if (isLeafType(parent)) return;   // image/annotation are leaves — they can't have children
  if (isLockedEffective(parent)) { setStatus('Locked — can’t add a child'); return; }
  touch(parentId);   // the reveal below (and a line/fan kidOrder change) belong to the create step
  if (parent.collapsed){ parent.collapsed = false; } // reveal so the new child is visible
  const sibs = childrenOf(parentId);
  const n = mkNode({
    x: parent.x + 40 + sibs.length * 30,
    y: parent.y + 150 + sibs.length * 10,
    parent: parentId,
    title: newCardTitle(),
  });
  const id = n.id;
  state.nodes.set(id, n);
  applyLayouts();        // a line/fan parent immediately slots the new child into place
  paintAll();
  selectNode(id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
}
// Add a SIBLING of `refId` — a new node sharing its parent, on the SAME side as the reference
// card and slotted into the child order DIRECTLY AFTER it (not appended at the end). A root-level
// node has no parent, so its "sibling" is a fresh unconnected node placed just below it.
export function createSibling(refId: string){
  if (state.readOnly) return;
  const ref = state.nodes.get(refId); if (!ref) return;
  // A sibling of a TAB would be a plain card parented to the group, i.e. content the group can't show —
  // only frames are tabs. So "add a sibling" of a tab means "add a card inside it", which is what the
  // key is reaching for anyway (see contentParent).
  if (isDockedTab(ref)) return addChild(ref.id);
  if (ref.parent == null) return createNode({ x: ref.x, y: ref.y + nodeH(ref) + 40 });
  const parent = state.nodes.get(ref.parent); if (!parent) return;
  if (isLockedEffective(parent)) { setStatus('Locked — can’t add a sibling'); return; }
  touch(parent.id);   // the kidOrder change (and a possible reveal) belong to the create step
  if (parent.collapsed) parent.collapsed = false;
  const n = mkNode({
    // seed just below the reference; a managed layout re-places it, a free layout keeps it here
    x: ref.x, y: ref.y + nodeH(ref) + 24,
    parent: ref.parent,
    side: sideOf(parent, ref),                             // same direction as the reference card
    title: newCardTitle(),
  });
  state.nodes.set(n.id, n);
  parent.kidOrder = insertedKidOrder(parent, n.id, ref.id);   // directly after the reference
  applyLayouts(); paintAll();
  selectNode(n.id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
}

// ---------- extract selected body text into a new child card ----------
// Triggered with ⌘⇧E while editing a card's body in place: cut the selected text out of the
// note and drop it into a fresh child card.
export function extractToChild(): void {
  if (state.readOnly || !ui.bodyEdit) return;
  const n = state.nodes.get(ui.bodyEdit.id); if (!n) return;
  const ta = ui.bodyEdit.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e){ setStatus('Select some body text to extract'); return; }
  touch(n.id);   // usually already touched by startBodyEdit — idempotent
  const sel = ta.value.slice(s, e);
  const lines = sel.split('\n');
  let ti = lines.findIndex((l: string) => l.trim()); if (ti < 0) ti = 0;
  const title = uniqueTitle(
    lines[ti].replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/, '').trim() || newCardTitle());
  const childBody = lines.slice(ti+1).join('\n').trim();
  // cut the selection out of the parent (tidy up the blank lines it leaves) and close its editor
  n.body = (ta.value.slice(0, s) + ta.value.slice(e)).replace(/\n{3,}/g, '\n\n').trim();
  n.dirty = true;
  ui.bodyEdit = null;   // commit & drop the in-card editor
  // make the child below the parent and jump to it
  const sibs = childrenOf(n.id);
  if (n.collapsed) n.collapsed = false;
  const child = mkNode({
    x: n.x + 40 + sibs.length*30, y: n.y + 180 + sibs.length*10,
    parent: n.id, title, body: childBody,
  });
  const id = child.id;
  state.nodes.set(id, child);
  applyLayouts(); paintAll(); selectNode(id); scheduleSave();
  commitStep();   // extract bypasses endBodyEdit (ui.bodyEdit nulled above), so close the step here
  setStatus(`Extracted “${title}” as a child`);
}

// ---------- docking frames as tabs ----------
// Re-anchor a frame's contents when the box they live in changes identity: while docked they sit in
// the interior its GROUP lent it, undocked they sit in its own box (frameInterior resolves both — see
// containerBox). The cards keep their position INSIDE the box, which is what the eye tracks; carrying
// them along with the frame instead would leave them wherever the label happened to be. Pass the
// interior from BEFORE the change; call after it.
// …in ONE formula, for docking, undocking and re-slotting alike: where the contents sat before the
// gesture (`was`), where they sit now, minus the drag delta they already rode along with their frame
// (its cards are in the drag's target set, and the wrapper holding them gets the same transform). Miss
// that last term and a gesture that doesn't change the box — dragging a tab along the strip to re-slot
// it — leaves the whole content offset by however far the tab travelled.
// `was` must be captured BEFORE the parent changes (interiorAtHome), `home` is the frame's pre-drag
// position, and `f.x/f.y` are still where it was dropped.
export function reanchorContents(f: MindNode, was: Pt, home: Pt): void {
  const now = frameInterior(f);
  const dx = now.x - was.x - (f.x - home.x), dy = now.y - was.y - (f.y - home.y);
  for (const k of childrenOf(f.id)) moveSubtreeTo(k, k.x + dx, k.y + dy);
}
// Turn a plain card into a frame, so it can be a tab (canBeTab lets cards into the dock zone for exactly
// this). It keeps its title, its note and its children; it gains a box, sized from whatever width it
// already had — so undock it later and it's a frame with the same content at that size. Note a frame
// never SHOWS a body (styles.css), so a card's note is out of sight while it serves as a tab — still on
// disk, back the moment its kind is changed again.
function asFrame(n: MindNode): void {
  if (n.type === 'frame') return;
  touch(n.id);
  n.type = 'frame'; n.layout = 'free';
  n.w ??= FRAME_W; n.h ??= FRAME_H;
  n.dirty = true; n.dirtyLayout = true;
}
// The interior a frame's contents were sitting in BEFORE the gesture: the box its GROUP lent it if it
// was already a tab — which doesn't move when the tab does, so it's position-independent — else its own
// box at the position the drag started from.
export function interiorAtHome(f: MindNode, home: Pt): Pt {
  if (isDockedTab(f)) { const b = frameInterior(f); return { x: b.x, y: b.y }; }
  return { x: home.x + FRAME_BORDER, y: home.y + frameInsetY(f) };
}
// Dock frame(s) onto `target`'s tab: they become tabs sharing one box. When the target isn't a group
// yet, one is minted around it — a frame with `layout: tabs` that takes over its box, its place in the
// tree and its colour, with the target itself as the first tab. The DROPPED frame ends up open (you
// just moved it there, so that's what you want to see); everything else closes. Returns the group.
// Each frame's own mm_w/mm_h are left untouched throughout — that's what lets it come back out at the
// size it went in at (see undock in features/drag.ts).
// `homes` carries each frame's PRE-DRAG position (the drag's start map), which is what lets the contents
// be put back correctly — without it the drag delta can't be cancelled (see reanchorContents). Omit it
// when there's no drag in play; the delta is then zero by construction.
export function dockFrames(target: MindNode, rootIds: string[], afterId?: string | null, homes?: Map<string, Pt>): MindNode | null {
  if (state.readOnly) return null;
  const frames = rootIds.map(id => state.nodes.get(id))
    .filter((f): f is MindNode => !!f && canBeTab(f) && f.id !== target.id && !isLockedEffective(f));
  if (!frames.length || isLockedEffective(target)) return null;
  let g = isTabsFrame(target) ? target : null;
  // Dropping a tab on a FOLDED group means "open it and put this in there" — a new tab hidden inside a
  // folded group would just look like the drop had vanished.
  if (g?.collapsed) { touch(g.id); g.collapsed = false; g.dirty = true; g.dirtyLayout = true; }
  if (!g) {
    touch(target.id, target.parent);
    // The group inherits the target's BOUNDS — its authored box (not the rendered one, so docking onto
    // a FOLDED frame gives the group the box that frame would unfold to, rather than a 40px sliver).
    // No colour of its own, deliberately: a group's box takes the colour of whichever tab is OPEN
    // (effectiveColor), so copying the target's colour here would pin the box to that one tab's tint
    // for good. An explicit colour on the group still overrides, for whoever wants a fixed box.
    g = mkNode({
      type: 'frame', layout: 'tabs',
      title: uniqueTitle(`${target.title} tabs`),
      parent: target.parent, side: target.side,
      x: target.x, y: target.y, w: target.w, h: target.h,
    });
    state.nodes.set(g.id, g);
    // The group stands exactly where the target stood, so it takes its slot in the old parent's stored
    // order too — otherwise a line/fan parent would append it at the end and visibly reshuffle.
    const op = target.parent ? state.nodes.get(target.parent) : null;
    if (op?.kidOrder) op.kidOrder = op.kidOrder.map(id => id === target.id ? g!.id : id);
    // …and the target becomes its first tab. Its contents don't move: the group's box is its old box.
    target.parent = g.id; target.side = undefined; target.dirty = true; target.dirtyLayout = true;
  }
  for (const f of frames) {
    if (isAncestor(f.id, g.id)) continue;   // would dock a group into its own descendant
    asFrame(f);                             // a card becomes a frame first — that's what a tab is
    const home = homes?.get(f.id) ?? { x: f.x, y: f.y };
    const was = interiorAtHome(f, home);    // the box its contents were in before the gesture
    touch(f.id, f.parent, g.id);            // pre-images incl. both parents' kidOrder
    f.parent = g.id; f.side = undefined; f.dirty = true; f.dirtyLayout = true;
    reanchorContents(f, was, home);         // …and the one the group lends it now
  }
  // Slot the dropped frames in where the preview said they'd go: right after `afterId` (`null` = the
  // front of the strip, `undefined` = the end). Set explicitly, because otherwise the order would be
  // seeded from the raw drop POSITION (kidsByPosition sorts tabs by x) — which is where the tab happens
  // to be under the cursor, not the gap the insertion bar marked.
  const docked = new Set(frames.map(f => f.id));
  const rest = tabsOf(g).map(t => t.id).filter(id => !docked.has(id));
  const at = afterId === undefined ? rest.length
           : afterId === null ? 0
           : rest.indexOf(afterId) + 1 || rest.length;   // an unknown anchor falls back to the end
  g.kidOrder = [...rest.slice(0, at), ...frames.map(f => f.id), ...rest.slice(at)];
  // exactly one open tab, and it's the one just dropped (the anchor of the drag, i.e. the first root)
  const open = frames[0];
  for (const t of tabsOf(g)) {
    const want = t !== open;
    if (t.collapsed !== want) { touch(t.id); t.collapsed = want; t.dirty = true; t.dirtyLayout = true; }
  }
  return g;
}
// A group with nothing left in it is an empty box with a label on it — the last tab to leave took its
// own contents with it, so there's nothing to preserve. Only ever dissolves a CHILDLESS group (a card
// dropped straight into the box is still a child, and deleting the group would delete it too).
export function dissolveEmptyTabGroups(ids: Iterable<string | null | undefined>): void {
  if (state.readOnly) return;
  for (let id of new Set(ids)) {
    // …and walk up as it goes: dissolving a NESTED group can empty the group that held it as a tab.
    while (id) {
      const g = state.nodes.get(id);
      if (!g || !isTabsFrame(g) || childrenOf(g.id).length) break;
      if (state.selId === g.id) selectNode(null);
      deleteNodes([g.id]);
      id = g.parent;
    }
  }
}

// ---------- delete ----------
// Forget a set of node ids: drop them from state, remove their DOM cards, and queue
// their files for deletion on the next save. Callers pass the full subtree(s) to remove.
function deleteNodes(ids: Iterable<string>): void {
  touch(...ids);   // single choke point: every removal's before-image lands in the step
  for (const id of ids){
    const n = state.nodes.get(id); if (!n) continue;
    // …including its container wrappers: a frame's clipping wrapper and a tab group's strip are hung
    // off the node, not marked with its data-id, so nothing else would ever reach them again.
    state.nodes.delete(id); n.el?.remove(); n.frameContentEl?.remove(); n.tabStripEl?.remove();
    if (n.file) state.toDelete.push(n.file);
  }
}
export function deleteNode(id: string): void {
  if (state.readOnly) return;
  // Deleting a tab GROUP means deleting the frame you can SEE — the open tab — after which the next tab
  // takes over the box (normalizeTabs). Delete them one at a time and the last one takes the box with it
  // (dissolveEmptyTabGroups), so "delete the whole thing" is still reachable, just tab by tab.
  const n0 = state.nodes.get(id); if (!n0) return;
  id = actionTarget(n0).id;
  if (subtreeHasLocked(id)) { setStatus('Locked — can’t delete'); return; }
  const parent = state.nodes.get(id)?.parent;
  record([], () => {                 // ids are touched inside deleteNodes
    deleteNodes(subtreeIds(id));
    dissolveEmptyTabGroups([parent]);
    applyLayouts(); selectNode(null); paintAll();
    scheduleSave();
  });
}
// Delete every selected card and their entire subtrees.
export function deleteSelection(): void {
  if (state.readOnly) return;
  // actionTarget: a selected tab group stands for its open tab — see deleteNode
  const ids = [...state.sel].map(id => actionTarget(state.nodes.get(id)!).id).filter(id => !subtreeHasLocked(id));
  if (!ids.length) { setStatus('Locked — can’t delete'); return; }
  const parents = ids.map(id => state.nodes.get(id)?.parent);
  record([], () => {                 // ids are touched inside deleteNodes
    state.sel.clear(); state.selId = null;
    deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));   // dedup overlapping subtrees
    dissolveEmptyTabGroups(parents);   // a group whose last tab just went takes the box with it
    applyLayouts(); applySelection(); scheduleSave();
  });
  setStatus(`Deleted ${ids.length} card${ids.length===1?'':'s'}`);
}
// A node is safe to delete-and-promote when it's unlocked, its own parent isn't locked (the
// promoted children need to land there), and none of its direct children are locked (a locked
// child can't be reparented — see drag.ts's own isLockedEffective guard on move).
function canPromoteDelete(id: string): boolean {
  const n = state.nodes.get(id); if (!n) return false;
  if (isLockedEffective(n)) return false;
  const parent = n.parent ? state.nodes.get(n.parent) : null;
  if (parent && isLockedEffective(parent)) return false;
  return childrenOf(id).every(k => !isLockedEffective(k));
}
// Delete every selected card WITHOUT touching its subtree: each one's direct children move up to
// become children of ITS OWN parent, right where it sat — the node disappears, its branch survives
// one level shallower. Cascades correctly when a selected node's parent is ALSO selected: children
// are read live (childrenOf), so a child already promoted by an earlier pass in this loop is what a
// later pass (deleting that now-former parent) sees and promotes again — any chain length just
// works, in any processing order. New parents get no explicit kidOrder splice; orderedKids
// (view/layout.ts) already treats a reparented-but-unlisted child as "fresh" and slots it in by
// position, so nothing needs doing here. Shared by ⌥Delete/⌥Backspace and its context-menu twin.
export function deleteSelectionKeepChildren(): void {
  if (state.readOnly) return;
  const ids = selectedIds().filter(canPromoteDelete);
  if (!ids.length) { setStatus('Locked — can’t delete'); return; }
  const promoted = new Set<string>();
  record([], () => {
    for (const id of ids) {
      const n = state.nodes.get(id); if (!n) continue;
      const kids = childrenOf(id);
      touch(id, ...kids.map(k => k.id));
      for (const k of kids) { k.parent = n.parent; k.dirty = true; promoted.add(k.id); }
      state.nodes.delete(id); n.el?.remove();
      if (n.file) state.toDelete.push(n.file);
    }
  });
  for (const id of ids) promoted.delete(id);   // a node promoted-then-itself-deleted (chain) isn't a survivor
  applyLayouts(); paintAll();
  setSelectionSet(promoted);
  scheduleSave();
  setStatus(`Deleted ${ids.length} card${ids.length===1?'':'s'}, kept children`);
}
// Alt-drop an image CARD onto a regular card (features/drag.ts): fold each image card's markdown
// (its `![alt](path)` body) onto the end of the target card's body as an inline image, then delete
// the now-redundant image card(s). The referenced attachment file stays on disk — the target body
// still points at it; only the image card's own .md note is removed. Runs INSIDE the live drag
// undo step: it touches + mutates only, and the caller (dragPointerUp) commits.
export function foldImageCardsIntoBody(targetId: string, imageCardIds: Iterable<string>): number {
  if (state.readOnly) return 0;
  const target = state.nodes.get(targetId); if (!target) return 0;
  const cards = [...imageCardIds]
    .map(id => state.nodes.get(id))
    .filter((n): n is MindNode => !!n && isImageCard(n));
  if (!cards.length) return 0;
  const md = cards.map(c => (c.body || '').trim()).filter(Boolean).join('\n\n');
  touch(targetId);
  if (md){
    target.body = (target.body && target.body.trim()) ? target.body.replace(/\s*$/, '') + '\n\n' + md : md;
    target.dirty = true;
    if (ui.bodyEdit && ui.bodyEdit.id === targetId) ui.bodyEdit.ta.value = target.body;   // sync an open editor
  }
  deleteNodes(cards.map(c => c.id));
  return cards.length;
}
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Alt-drag an image OUT of a card (features/image-extract.ts): strip the `![alt](path)` from the
// source card's body, then either MOVE it into another card's body (`target.toCardId`) or drop it
// as a fresh image-only card at a world position (`target.x/y/w/h`). One undo step — touches +
// mutates and commits it (image extraction is its own gesture, not nested in a live drag).
export function extractImage(sourceId: string, path: string, alt: string,
    target: { toCardId: string } | { x: number; y: number; w: number; h: number }): void {
  if (state.readOnly || !path) return;
  const source = state.nodes.get(sourceId); if (!source) return;
  const re = new RegExp(`[ \\t]*!\\[[^\\]]*\\]\\(\\s*${escRe(path)}\\s*\\)[ \\t]*\\n?`);
  touch(sourceId);
  source.body = source.body.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  source.dirty = true;
  if (ui.bodyEdit && ui.bodyEdit.id === sourceId) ui.bodyEdit.ta.value = source.body;
  const md = `![${alt}](${path})`;
  if ('toCardId' in target){
    const tgt = state.nodes.get(target.toCardId);
    if (tgt){
      touch(tgt.id);
      tgt.body = (tgt.body && tgt.body.trim()) ? tgt.body.replace(/\s*$/, '') + '\n\n' + md : md;
      tgt.dirty = true;
      if (ui.bodyEdit && ui.bodyEdit.id === tgt.id) ui.bodyEdit.ta.value = tgt.body;
    }
    setStatus('Image moved');
  } else {
    const n = mkNode({ x: target.x, y: target.y, parent: null, title: uniqueTitle(alt || 'image'),
      body: md, type: 'image', color: 'none', w: target.w, h: target.h });
    touch(n.id);                 // before-image is null (not yet in state) → undo removes it
    state.nodes.set(n.id, n);
    setStatus('Image extracted');
  }
  applyLayouts(); paintAll(); scheduleSave(); commitStep();
}
