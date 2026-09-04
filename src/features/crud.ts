// ---------- node lifecycle: create / duplicate / delete / extract ----------
// Every node is one .md file; ids are ephemeral (minted in mkNode). All create/duplicate paths go
// through mkNode so the node schema stays in one place. Each mutation schedules a save. Re-parenting
// by drag lives in features/drag.ts; this is the keyboard/toolbar-driven lifecycle.
import { state, setStatus, isLeafType, isAnnotation, type MindNode, type NodeType, type NodeLayout } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf, nodeLabel, isLockedEffective, subtreeHasLocked, parentOf } from '../utils/model.js';
import { splitHeading } from '../utils/frontmatter.js';
import { applyLayouts, insertedKidOrder, hostFrame, frameLabelled } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { detachParentId, boxIsViewport } from '../nav/scope.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, setSelectionSet, applySelection, selectedIds, nodeH, subtreeIds, snapPt, NODE_W, relayout, remeasure } from '../main.js';
import { startInlineEdit, dropBodyEdit } from './inline-edit.js';
import { touch, touchEdges, commitStep, record } from './history.js';
import { gcJunctions, scheduleSaveBoard } from '../data/board.js';

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
// The height a FRESH card lays out at, before it has an element to measure (layoutH's own fallback is
// the same number). Only useful as half of the centring below — a card's real height is measured.
export const NEW_CARD_H = 64;
// Centre a fresh card on a world point — the ONE spelling of it. Every "new card HERE" gesture (the
// canvas double-click, the canvas ⋯ menu, Space, a dropped file, a card double-clicked into a
// container) lands the card under the pointer rather than hanging down-right of it, so the default
// card's size is written once instead of once per gesture.
// Where a card goes when it is placed AT a point — the pointer, usually. Centred on that point and then
// put on the grid (main.ts snapPt), which is the one funnel every interactive create runs through: the
// canvas double-click, Space/N, both "New card here" menus, a dropped image, a dragged-out selection. A
// card the user positions is on the grid whether it was placed or dragged there.
export function centredAt(p: Pt): Pt { return snapPt({ x: p.x - NODE_W / 2, y: p.y - NEW_CARD_H / 2 }); }
// Make a new UNCONNECTED node (parent:null) at the viewport centre (or a given spot).
interface CreateOpts {
  x?: number; y?: number; parent?: string | null; title?: string; color?: string;
  tags?: string[]; body?: string; type?: NodeType; layout?: NodeLayout; isNew?: boolean;
  w?: number; h?: number;
  edit?: boolean;   // false = don't open the inline rename (e.g. paste — the content is final)
}
export function createNode(opts: CreateOpts = {}): MindNode | undefined {
  if (state.readOnly) return;
  // No parent asked for means "the top level", and while a frame is OPEN its interior IS the top
  // level (detachParentId, nav/scope.ts) — a genuine root would land outside the scope and simply
  // vanish. That's what makes this ONE line cover every create path: the canvas double-click, Space,
  // both "New card here" menus, an annotation with nothing selected, a paste, a dropped image.
  const parentId = opts.parent ?? detachParentId();
  if (parentId) {
    const p = state.nodes.get(parentId);
    if (p && isLockedEffective(p)) { setStatus('Locked — can’t add a child'); return; }
  }
  const c = centredAt(screenToWorld(window.innerWidth/2, window.innerHeight/2));
  const n = mkNode({
    x: opts.x ?? c.x, y: opts.y ?? c.y,
    parent: parentId,
    // A fresh card is UNTITLED — it has no name until the first line of its text is a `# ` heading
    // (utils/frontmatter.ts splitHeading), and its file is slugged off that text instead. This is
    // where "New Card 1" and the minted "Annotation 7" used to come from: both existed only so the
    // node had a unique filename, which is no longer the title's job.
    title: opts.title ?? '',
    color: opts.color ?? '',
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    type: opts.type ?? 'card', layout: opts.layout ?? 'inherit',
    w: opts.w, h: opts.h,
  });
  const id = n.id;
  state.nodes.set(id, n);
  relayout(); selectNode(id);
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
  // …parented to the open frame while there is one, so the ghost card rides the ordinary frame-child
  // machinery instead of being dragged onto a canvas that can't show it.
  const n = mkNode({ x, y, parent: detachParentId() });
  state.nodes.set(n.id, n);
  paintAll();   // give the card a DOM element so it can be dragged
  return n;
}
// Clone a node AND its subtree at (x,y): same content/colour, keeping its parent so the copy stays
// attached as a sibling; every descendant is copied under it at the same offset, so a duplicated
// frame holds copies of its cards and a duplicated outliner keeps its rows. Keeps the source's title VERBATIM — a duplicate of "Idea" is another
// card called "Idea", and the two are told apart by where they sit, which is what a canvas is for.
// (It used to become "Idea 2", numbered against every other title in the map, purely so the copy's
// filename wouldn't collide; that's desiredFileFor's business now, and it suffixes the FILE.)
// Shared by the duplicate (sidebar/keyboard) and Shift-drag clone paths; doesn't touch selection/layout.
function cloneNodeAt(s: MindNode, x: number, y: number): MindNode {
  const copy = mkNode({
    x, y,
    parent: s.parent,
    title: s.title,
    color: s.color,
    tags: [...s.tags], body: s.body, done: s.done, checklist: s.checklist,
    type: s.type, layout: s.layout,
    w: s.w, h: s.h,   // a frame/image card's own box size
    // …and how it was SHOWING: a copy of a folded card is a folded card (paste already worked this
    // way — features/clipboard.ts — and a duplicate that silently springs open reads as a bug, most
    // visibly on an image card, whose fold is its icon). titleGap rides along with the body it
    // describes, or the copy's file would gain the blank line the original doesn't have.
    collapsed: s.collapsed, titleGap: s.titleGap,
  });
  state.nodes.set(copy.id, copy);
  for (const k of childrenOf(s.id)) cloneNodeAt(k, k.x + x - s.x, k.y + y - s.y).parent = copy.id;
  return copy;
}
// A duplicate sits directly below the original, clear of it.
// A duplicate sits one card-height below its source — snapped, since that height is MEASURED and would
// otherwise put the copy a few px off the grid its source is on.
function copyNode(s: MindNode): MindNode {
  const at = snapPt({ x: s.x, y: s.y + nodeH(s) + 24 });
  return cloneNodeAt(s, at.x, at.y);
}
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
  remeasure();
  const msg = copies.length === 1 ? `Duplicated → “${nodeLabel(copies[0])}”` : `Duplicated ${copies.length} cards`;
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
  setStatus(`Cloned → “${nodeLabel(copy)}”`);
  return copy;
}

// ---------- add child / sibling ----------
// `at` (world coords) seeds the new child's position instead of the staggered offset below — the
// double-click-inside-a-container gesture (main.ts activateNode) knows where the user pointed. A
// managed layout (line/fan/flow/stack) re-places it either way, so it only sticks in a free parent.
export function addChild(parentId: string, at?: Pt): void {
  if (state.readOnly) return;
  const parent = state.nodes.get(parentId); if (!parent) return;
  if (isLeafType(parent)) return;   // image/annotation are leaves — they can't have children
  if (isLockedEffective(parent)) { setStatus('Locked — can’t add a child'); return; }
  touch(parentId);   // the reveal below (and a line/fan kidOrder change) belong to the create step
  if (parent.collapsed){ parent.collapsed = false; } // reveal so the new child is visible
  const sibs = childrenOf(parentId);
  const n = mkNode({
    x: at ? at.x : parent.x + 40 + sibs.length * 30,
    y: at ? at.y : parent.y + 150 + sibs.length * 10,
    parent: parentId,
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
  if (ref.parent == null) return createNode({ x: ref.x, y: ref.y + nodeH(ref) + 40 });
  const parent = state.nodes.get(ref.parent); if (!parent) return;
  if (isLockedEffective(parent)) { setStatus('Locked — can’t add a sibling'); return; }
  touch(parent.id);   // the kidOrder change (and a possible reveal) belong to the create step
  if (parent.collapsed) parent.collapsed = false;
  const n = mkNode({
    // seed just below the reference; a managed layout re-places it, a free layout keeps it here
    x: ref.x, y: ref.y + nodeH(ref) + 24,
    parent: ref.parent,
  });
  state.nodes.set(n.id, n);
  parent.kidOrder = insertedKidOrder(parent, n.id, ref.id);   // directly after the reference
  relayout();
  selectNode(n.id);
  startInlineEdit(n, { isNew: true });   // drop straight into renaming the fresh card; Esc cancels creation
  scheduleSave();
}

// ---------- breaking a note apart: extract selected body text into a card of its own ----------
// Two gestures share this: ⌘⇧E (→ a child) and dragging the selection out of the editor
// (features/text-drag.ts → a sibling, a card in whatever container it was dropped in, or straight
// into another card's note). All of them CUT the text out of the source, so the three helpers below
// are the shared halves — deriving the new card's title/body, and the cut itself.

// A lump of extracted text IS a card's text, so it splits exactly the way the note it came from does —
// hence plain `splitHeading` at both sites below: a leading `# ` line is the new card's title, and
// without one the card is untitled and the whole lump is its body. Nothing is minted; text dragged out
// of a note keeps the shape it had.
// Cut [start,end) out of the card's text (tidying the blank lines it leaves) and return it. What's
// left is re-SPLIT into title + body, because a card is one field and the range may have taken the
// title heading with it — cut a card's whole name out and the card is simply untitled now, which is
// the whole of what used to be a refusal ("a title is a filename, so it can't be cut to nothing").
// The in-card editor is DROPPED rather than ended: endBodyEdit would write the textarea's now-stale
// value back over the shortened text. The caller owns closing the undo step (commitStep), since
// nothing else will.
function cutCardText(n: MindNode, start: number, end: number, value: string): string {
  touch(n.id);   // usually already touched by startCardEdit — idempotent
  const text = value.slice(start, end);
  const rest = (value.slice(0, start) + value.slice(end)).replace(/\n{3,}/g, '\n\n').trim();
  const split = splitHeading(rest);
  n.title = split.title; n.body = split.body; n.titleGap = split.gap;
  n.dirty = true;
  dropBodyEdit();   // see inline-edit.ts — the editor still shows the pre-cut text
  return text;
}
// Append a lump of markdown to a card's note, blank-line separated. Shared by every "this text now
// lives in THAT card" path (the merge below, a dragged-in selection) — including the sync of an
// editor that happens to be open on the target, which is easy to forget and leaves the next commit
// writing the pre-merge text straight back over it.
function appendToBody(t: MindNode, md: string): void {
  if (!md) return;
  t.body = (t.body && t.body.trim()) ? t.body.replace(/\s*$/, '') + '\n\n' + md : md;
  t.dirty = true;
  if (ui.bodyEdit && ui.bodyEdit.id === t.id) ui.bodyEdit.ta.value = t.body;
}
// Triggered with ⌘⇧E while editing a card's body in place: cut the selected text out of the
// note and drop it into a fresh child card.
export function extractToChild(): void {
  if (state.readOnly || !ui.bodyEdit) return;
  const n = state.nodes.get(ui.bodyEdit.id); if (!n) return;
  const ta = ui.bodyEdit.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e){ setStatus('Select some body text to extract'); return; }
  const { title, body } = splitHeading(cutCardText(n, s, e, ta.value));
  // make the child below the parent and jump to it
  const sibs = childrenOf(n.id);
  if (n.collapsed) n.collapsed = false;
  const child = mkNode({
    x: n.x + 40 + sibs.length*30, y: n.y + 180 + sibs.length*10,
    parent: n.id, title, body,
  });
  const id = child.id;
  state.nodes.set(id, child);
  relayout(); selectNode(id); scheduleSave();
  commitStep();   // extract bypasses endBodyEdit (ui.bodyEdit nulled above), so close the step here
  setStatus(`Extracted “${nodeLabel(child)}” as a child`);
}
const nodeOrNull = (id: string | null | undefined): MindNode | null =>
  (id ? state.nodes.get(id) ?? null : null);
// WHICH TEXT is being dragged: a range of the card's one editor (features/text-drag.ts captures this
// at dragstart; the offsets are into that editor's live text, which is why the drop re-reads it rather
// than trusting n.title/n.body). It used to carry a `part: 'title' | 'body'` too, with a contenteditable
// measured by Range on one side and a textarea's selectionStart on the other — one field, one arm.
export interface TextSource { id: string; start: number; end: number }
function liveText(src: TextSource): string | null {
  return ui.bodyEdit && ui.bodyEdit.id === src.id ? ui.bodyEdit.ta.value : null;
}
// The text under the drag, read live — `null` once that editor is no longer open on that card, which
// is also the drop's own "did this drag outlive its editor" test. Exported for the drag PREVIEW, so
// the ghost card and the drop read the selection through the one piece of code that knows how.
export function cardText(src: TextSource): string | null {
  const value = liveText(src);
  return value == null ? null : value.slice(src.start, src.end);
}
// The landing of a dragged-out selection: INTO an existing card's note, or as a card of its own at a
// world point — inside `container` when it was dropped in one, else out on the canvas (see the rule
// below). features/text-drag.ts resolves which; canMerge says what counts as a note here.
export type TextDrop = { into: MindNode } | { container: MindNode | null; at: Pt };
export function dropCardText(src: TextSource, dest: TextDrop): void {
  if (state.readOnly) return;
  const n = state.nodes.get(src.id); if (!n) return;
  const value = liveText(src); if (value == null) return;   // the editor closed under the drag
  if (src.start >= src.end || src.end > value.length) return;
  // Resolve (and refuse) the landing BEFORE cutting, so a drop that can't be honoured leaves the
  // card's text alone rather than removing it with nowhere to put it.
  if ('into' in dest){
    const t = dest.into;
    if (t.id === src.id || !canMerge(t)) return;
    const text = cutCardText(n, src.start, src.end, value);
    touch(t.id);
    appendToBody(t, text.trim());
    relayout(); selectNode(t.id); scheduleSave(); commitStep();
    setStatus(`Moved text into “${nodeLabel(t)}”`);
    return;
  }
  // WHERE THE NEW CARD BELONGS, in one rule read both ways: the box you dropped in governs.
  //  · dropped IN a container → its child, wherever in it you let go;
  //  · dropped on the open canvas, from a card that LIVES in a container (a stack's row, a card in a
  //    frame) → out to the top level, i.e. the open frame while there is one (detachParentId). This is
  //    the half "sibling of the source" got wrong: it parented the card back INSIDE the box, so
  //    dragging text out of a stack row put a new ROW in the outline instead of a card where you
  //    dropped it, and out of a frame's card put one at a drop point the box's overflow:hidden clips
  //    away to nothing. Dropping on the canvas is how a note comes OUT;
  //  · dropped on the open canvas from a card already ON it → a sibling of that card, slotted directly
  //    after it the way createSibling does, so the new card joins the branch it was cut from.
  // hostFrame is the "am I inside a box" test, and it's the right one because it stops at the scope
  // root: inside an OPEN frame there's no box to come out of — that frame IS the canvas — so its cards
  // keep the sibling reading.
  const parent = dest.container
    ?? (hostFrame(n) ? nodeOrNull(detachParentId()) : parentOf(n));
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t drop there'); return; }
  const text = cutCardText(n, src.start, src.end, value);
  const { title, body } = splitHeading(text);
  if (parent){
    touch(parent.id);
    if (parent.collapsed) parent.collapsed = false;
  }
  const card = mkNode({
    x: dest.at.x, y: dest.at.y,
    parent: parent?.id ?? null, title, body,
  });
  state.nodes.set(card.id, card);
  // Only a real sibling splices the order; a card dropped into a container is slotted by its
  // position (orderedKids treats an unlisted child as fresh), which is where the drop point is.
  if (parent && parent.id === n.parent) parent.kidOrder = insertedKidOrder(parent, card.id, n.id);
  relayout(); selectNode(card.id); scheduleSave(); commitStep();
  setStatus(`Extracted “${nodeLabel(card)}”`);
}

// ---------- merging cards into one ----------
// What can FUSE with another note, on EITHER side of the gesture: a plain card or an annotation —
// the two kinds whose whole content is a body (a card just also has a title above it). Every other
// kind is a box or a leaf whose own shape is the point (a frame, a stack, an image, a query card),
// so folding it into a body would throw away exactly what it is. One predicate rather than a
// source/target pair, because the answer really is the same question both ways round.
export const canMerge = (n: MindNode): boolean =>
  (n.type === 'card' || n.type === 'annotation') && !isLockedEffective(n);
// ⌥-drop card(s) onto another card (features/drag.ts): fold each dragged note into the target's
// body — `## Title` then its text, in the order they were selected — and let the now-redundant cards
// go. The target is the card that SURVIVES, so it keeps its own id, file, colour, size and flags;
// only tags are unioned in, since a tag is a label on content that just moved. Their CHILDREN come
// up onto the target rather than going with them: merging notes must never take a branch with it.
// Runs INSIDE the live drag undo step — it touches + mutates only, and the caller (dragPointerUp)
// commits. Returns how many cards were folded in.
export function mergeCardsInto(targetId: string, sourceIds: Iterable<string>): number {
  if (state.readOnly) return 0;
  const target = state.nodes.get(targetId);
  if (!target || !canMerge(target)) return 0;
  const cards = [...sourceIds]
    .map(id => state.nodes.get(id))
    .filter((n): n is MindNode => !!n && n.id !== targetId && canMerge(n));
  if (!cards.length) return 0;
  touch(targetId);
  // An annotation IS its body — it has no title worth a heading — so it contributes just its text. So
  // does an UNTITLED card, for the same reason and by the same test: `n.title` is empty exactly when the
  // note carries no `# ` line, and inventing a heading here (from its first line, say) would put words
  // in the note that nobody wrote. A titled card contributes `## Title` — one level under the `# ` line
  // that is now the target's own title, which is what makes the merged note a correctly nested document.
  const section = (c: MindNode): string => {
    const body = (c.body || '').trim();
    const title = c.title.trim();
    if (isAnnotation(c) || !title) return body;
    return body ? `## ${title}\n\n${body}` : `## ${title}`;
  };
  appendToBody(target, cards.map(section).filter(Boolean).join('\n\n'));
  const tags = new Set(target.tags);
  for (const c of cards) for (const t of c.tags) tags.add(t);
  target.tags = [...tags];
  target.dirty = true;
  // Where the swallowed cards' children land. Normally the target — but an ANNOTATION is a leaf
  // (isLeafType: it never adopts children, and nothing would draw them), so a merge into one hands
  // them to the card that annotation is pinned to instead, which is where they'd have gone had the
  // annotation not been in the way. Pinned to nothing → the top level, i.e. the open frame.
  const kidHome = isAnnotation(target) ? (target.parent ?? detachParentId()) : targetId;
  // No kidOrder splice for the adopted children: orderedKids already slots a reparented-but-unlisted
  // child by position (same as deleteSelectionKeepChildren).
  for (const c of cards){
    const kids = childrenOf(c.id);
    touch(...kids.map(k => k.id));
    for (const k of kids){ k.parent = kidHome; k.dirty = true; }
  }
  deleteNodes(cards.map(c => c.id));
  return cards.length;
}

// A frame lives by what it holds (docs/spec-goo-groups.md): the LAST card dragged out takes the frame
// with it, whatever was written on it. Down to ONE child, a frame with nothing authored — no title,
// colour or tags — dissolves too and the child steps up to where the frame sat. Walks up like
// since the parent may be thin now as well.
export function dissolveThinFrames(ids: Iterable<string | null | undefined>): void {
  if (state.readOnly) return;
  for (let id of new Set(ids)) {
    while (id) {
      const f = state.nodes.get(id);
      if (!f || f.type !== 'frame' || boxIsViewport(f)) break;
      const kids = childrenOf(f.id);
      if (kids.length > 1) break;
      if (kids.length === 1 && (frameLabelled(f) || f.color || f.tags.length)) break;
      touch(f.parent);
      for (const k of kids) { touch(k.id); k.parent = f.parent; k.dirty = true; k.dirtyLayout = true; }
      if (state.selId === f.id) selectNode(null);
      deleteNodes([f.id]);
      id = f.parent;
    }
  }
}

// ---------- delete ----------
// Forget a set of node ids: drop them from state, remove their DOM cards, and queue
// their files for deletion on the next save. Callers pass the full subtree(s) to remove.
function deleteNodes(ids: Iterable<string>): void {
  const gone = new Set(ids);
  touch(...gone);   // single choke point: every removal's before-image lands in the step
  for (const id of gone){
    const n = state.nodes.get(id); if (!n) continue;
    // …including its container wrappers: a frame's clipping wrapper and a tab group's strip are hung
    // off the node, not marked with its data-id, so nothing else would ever reach them again.
    state.nodes.delete(id); n.el?.remove(); n.frameContentEl?.remove();
    if (n.file) state.toDelete.push(n.file);
  }
  // Prune the free edges that pointed at any of them. An edge with a missing end is already
  // invisible (edgeVisible) and unsaveable (serializeEdge drops it), so leaving it would only make
  // it linger in memory until the next save quietly ate it — and, worse, an UNDO would then restore
  // the card with no edge attached. Pruning here, inside the same step, is what lets one ⌘Z bring
  // back the card AND the edges that ran to it.
  if (state.edges.some(e => gone.has(e.from) || gone.has(e.to))) {
    touchEdges();
    state.edges = state.edges.filter(e => !gone.has(e.from) && !gone.has(e.to));
    // A junction those edges met at may now have nothing ending at it. Same step, same ⌘Z.
    gcJunctions();
    scheduleSaveBoard();
  }
}
export function deleteNode(id: string): void {
  if (state.readOnly) return;
  if (!state.nodes.has(id)) return;
  if (subtreeHasLocked(id)) { setStatus('Locked — can’t delete'); return; }
  record([], () => {                 // ids are touched inside deleteNodes
    deleteNodes(subtreeIds(id));
    applyLayouts(); selectNode(null); paintAll();
    scheduleSave();
  });
}
// Undo a creation that never became a card — Escape out of a fresh card's first edit, or clicking away
// from one nothing was typed into. Not a delete from the user's side, and not one in the history
// either: the pending step still holds this card's before-image (null, from mkNode), so deleting it
// here nets null→null and commitStep DISCARDS the whole step — neither the create nor the delete is
// left behind for ⌘Z to walk back through. `status` is passed where the user did something explicit
// (Escape); a card abandoned by clicking away goes quietly. Shared by all four editors that can open
// on a brand-new card (features/inline-edit.ts ×2, the outline row, the phone editor sheet), which
// each used to spell out these three lines and half of the reasoning.
export function discardNewCard(id: string, status?: string): void {
  deleteNode(id);
  commitStep();
  if (status) setStatus(status);
}
// Delete every selected card and their entire subtrees.
export function deleteSelection(): void {
  if (state.readOnly) return;
  const ids = [...state.sel].filter(id => !subtreeHasLocked(id));
  if (!ids.length) { setStatus('Locked — can’t delete'); return; }
  record([], () => {                 // ids are touched inside deleteNodes
    state.sel.clear(); state.selId = null;
    deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));   // dedup overlapping subtrees
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
  const parent = parentOf(n);
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
  relayout();
  setSelectionSet(promoted);
  scheduleSave();
  setStatus(`Deleted ${ids.length} card${ids.length===1?'':'s'}, kept children`);
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
    // untitled: the note is the picture and nothing else, which is what makes it render as one
    // (core/state.ts isImageCard). The alt rides along in the markdown and names the file.
    const n = mkNode({ x: target.x, y: target.y, parent: null, title: '',
      body: md, color: 'none', w: target.w, h: target.h });
    touch(n.id);                 // before-image is null (not yet in state) → undo removes it
    state.nodes.set(n.id, n);
    setStatus('Image extracted');
  }
  relayout(); scheduleSave(); commitStep();
}
