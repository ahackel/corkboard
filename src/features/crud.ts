// ---------- node lifecycle: create / duplicate / delete / extract ----------
// Every node is one .md file; ids are ephemeral (minted in mkNode). All create/duplicate paths go
// through mkNode so the node schema stays in one place. Each mutation schedules a save. Re-parenting
// by drag lives in features/drag.ts; this is the keyboard/toolbar-driven lifecycle.
import { state, setStatus, type MindNode, type NodeType } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf, nodeLabel, isLockedEffective, subtreeHasLocked, parentOf, isHidden, nodesOf } from '../utils/model.js';
import { stripImageRef } from '../utils/markdown.js';
import { advanceTitle } from '../utils/advance.js';
import { splitHeading } from '../utils/frontmatter.js';
import { frameInterior, holderOf, frameAt } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { detachParentId } from '../nav/scope.js';
import { scheduleSave } from '../data/persistence.js';
import { paintAll, selectNode, setSelectionSet, applySelection, selectedIds, nodeH, nodeW, subtreeIds, snapPt, NODE_W, FRAME_W, FRAME_H, relayout, remeasure } from '../main.js';
import { startInlineEdit, dropBodyEdit, syncOpenEditor } from './inline-edit.js';
import { touch, touchEdges, commitStep, record } from './history.js';
import { SPACING } from '../utils/guides.js';
import { growFramesToHold } from './float-bar.js';
import { settleFrames } from './drag.js';
import { scheduleSaveBoard } from '../data/board.js';
import { afterReading } from '../data/lazy.js';

// Mint a fresh node with the standard shape; callers override only the fields they care about.
// Keeps the node schema (and its defaults) in ONE place so every create/duplicate path stays in
// sync — the id is always minted here (ids are ephemeral, see below).
export function mkNode(fields: Partial<MindNode> = {}): MindNode {
  const id = 'n' + (state.idSeq++);
  touch(id);   // not in state.nodes yet → before-image is null (undo of a create = remove it)
  return {
    id, file:null,
    x:0, y:0, rx:0, ry:0, parent:null, collapsed:false, locked:false,
    title:'', color:'', keepStatus:'', tags:[], body:'',
    type:'card',
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
  tags?: string[]; body?: string; type?: NodeType; isNew?: boolean;
  w?: number; h?: number;
  edit?: boolean;   // false = don't open the inline rename (e.g. paste — the content is final)
}
// A new card pops in (styles.css card-pop) — only one the user just made, never on a load. A data
// attribute, not a class: paintNode rewrites className wholesale.
function popIn(n: MindNode): void {
  const el = n.el;
  if (el) { el.dataset.pop = ''; el.addEventListener('animationend', () => { delete el.dataset.pop; }, { once: true }); }
}
export function createNode(opts: CreateOpts = {}): MindNode | undefined {
  if (state.readOnly) return;
  // No parent asked for means "the top level", and while a frame is OPEN its interior IS the top
  // level (detachParentId, nav/scope.ts) — a genuine root would land outside the scope and simply
  // vanish. That's what makes this ONE line cover every create path: the canvas double-click, Space,
  // both "New card here" menus, a paste, a dropped image.
  const parentId = opts.parent !== undefined && opts.parent !== null ? holderOf(opts.parent) : detachParentId();
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
    // where the minted "New Card 1" used to come from: it existed only so the
    // node had a unique filename, which is no longer the title's job.
    title: opts.title ?? '',
    color: opts.color ?? '',
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    type: opts.type ?? 'card',
    w: opts.w, h: opts.h,
  });
  const id = n.id;
  state.nodes.set(id, n);
  relayout();
  // a card made past its frame's edge is shown, not clipped; a new FRAME takes in what it covers
  if (growFramesToHold([id, ...(n.type === 'frame' ? settleFrames([id]) : [])])) relayout();
  selectNode(id);
  popIn(n);
  if (opts.edit !== false) startInlineEdit(n, { isNew: opts.isNew ?? true });
  else commitStep();   // no rename session follows, so the create step ends here
  scheduleSave();
  return n;
}
// Many cards at once — a pasted list (utils/paste-list.ts), one card per item — in a neat column
// whose top-left is `at`, in ONE undo step. Each text splits like a card's own (splitHeading).
// The column is stacked from MEASURED heights, so it has to paint first: lay out, read each card's
// height, then restack with an even gap. Under a parent the cards become its children, in order.
const LIST_GAP = SPACING;   // the house spacing, the same one the smart guides pull to
export function createCards(texts: string[], at: Pt, parent: string | null): MindNode[] {
  if (state.readOnly || !texts.length) return [];
  const parentId = parent ? holderOf(parent) : detachParentId();
  const p = parentId ? state.nodes.get(parentId) : undefined;
  if (p && isLockedEffective(p)) { setStatus('Locked — can’t add a child'); return []; }
  const made: MindNode[] = [];
  record([parentId], () => {
    if (p?.collapsed) p.collapsed = false;   // reveal the new cards
    texts.forEach((t, i) => {
      const { title, body } = splitHeading(t);
      const n = mkNode({ x: at.x, y: at.y + i * (NEW_CARD_H + LIST_GAP), parent: parentId, title, body });
      state.nodes.set(n.id, n);
      made.push(n);
    });
    remeasure();
    let y = at.y;
    for (const n of made) { n.y = y; y += nodeH(n) + LIST_GAP; }
    growFramesToHold(made.map(n => n.id));
    relayout();
    setSelectionSet(made.map(n => n.id));
    made.forEach(popIn);
    scheduleSave();
  });
  return made;
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
// Clone one card (not its subtree) at (x,y): same content/colour, keeping its parent so the copy
// stays attached as a sibling. Keeps the source's title VERBATIM — a duplicate of "Idea" is another
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
    tags: [...s.tags], body: s.body,
    type: s.type,
    w: s.w, h: s.h, clip: s.clip,   // a frame/image card's own box size; a clipped card's exact height
    // …and how it was SHOWING: a copy of a folded card is a folded card (paste already worked this
    // way — features/clipboard.ts — and a duplicate that silently springs open reads as a bug, most
    // visibly on an image card, whose fold is its icon). titleGap rides along with the body it
    // describes, or the copy's file would gain the blank line the original doesn't have.
    collapsed: s.collapsed, titleGap: s.titleGap,
  });
  state.nodes.set(copy.id, copy);
  return copy;
}
// A duplicate sits directly below the original, clear of it.
// A duplicate sits one card-height below its source — snapped, since that height is MEASURED and would
// otherwise put the copy a few px off the grid its source is on.
function copyNode(s: MindNode): MindNode {
  const at = snapPt({ x: s.x, y: s.y + nodeH(s) + 24 });
  return cloneNodeAt(s, at.x, at.y);
}
// The SMART duplicate (⇧D): the next card of a series — a daily log, sprints, versions. The copy's
// title steps to its next value (utils/advance.ts: a date by a day with its weekday, else the last
// number up) and it lands in the NEXT SLOT of its row: to the right, at the same gap the row already
// keeps (from its left neighbour), past anything already there. Its frame grows to hold it, the way a
// drop does. A card with no heading advances its first line instead.
function copyNext(s: MindNode): MindNode {
  const w = nodeW(s), h = nodeH(s);
  const sibs = childrenOf(s.parent).filter(o => o !== s && !isHidden(o));
  const inRow = (o: MindNode, y: number): boolean => o.y < y + h && o.y + nodeH(o) > y;
  const left = sibs.filter(o => inRow(o, s.y) && o.x + nodeW(o) <= s.x)
    .sort((a, b) => (b.x + nodeW(b)) - (a.x + nodeW(a)))[0];
  const gap = left ? s.x - (left.x + nodeW(left)) : LIST_GAP;
  let x = s.x + w + gap;
  for (let moved = true; moved;) {
    moved = false;
    for (const o of sibs) {
      if (!inRow(o, s.y) || o.x >= x + w || o.x + nodeW(o) <= x) continue;
      x = o.x + nodeW(o) + gap; moved = true;
    }
  }
  const at = snapPt({ x, y: s.y });
  const c = cloneNodeAt(s, at.x, at.y);
  if (c.title.trim()) c.title = advanceTitle(c.title);
  else {
    const nl = c.body.indexOf('\n');
    c.body = advanceTitle(nl < 0 ? c.body : c.body.slice(0, nl)) + (nl < 0 ? '' : c.body.slice(nl));
  }
  return c;
}
// Duplicate every selected card (or just the one). Each copy keeps its source's parent, so it
// stays connected. One card → open its rename like a fresh node; many → select the new copies.
// `edit:false` skips the rename, so a duplicate doesn't yank the user into an editor. `next` is the
// smart duplicate (copyNext above); without it the copy is exact, just below its source.
export function duplicateSelection({ next = false }: { next?: boolean } = {}): MindNode[] | undefined {
  if (state.readOnly) return;
  const ids = selectedIds();
  // A folded frame's notes may still be on disk: duplicating it copies them, so they're read first.
  if (afterReading(ids, () => duplicateSelection({ next }))) return;
  const srcs = nodesOf(ids);
  if (!srcs.length) return;
  const copies = srcs.map(next ? copyNext : copyNode);
  // paint first so the new cards get real DOM heights, then settle and commit.
  remeasure();
  if (next && growFramesToHold(copies.map(c => c.id))) relayout();
  const msg = copies.length === 1 ? `${next ? 'Next' : 'Duplicated'} → “${nodeLabel(copies[0])}”`
    : `${next ? 'Made the next of' : 'Duplicated'} ${copies.length} cards`;
  if (copies.length === 1){
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

// ---------- a new card inside a frame / after a card / a new frame ----------
// A new card INSIDE a frame — Tab, the ⋯ menu, a double-click in its interior (main.ts activateNode,
// which passes where the user pointed as `at`). Without a point it goes under whatever the frame
// already holds, at the interior's left edge, so Tab-Tab-Tab fills a frame top to bottom.
export function addCardInside(frameId: string, at?: Pt): void {
  if (state.readOnly) return;
  const f = state.nodes.get(frameId); if (!f || f.type !== 'frame') return;
  if (isLockedEffective(f)) { setStatus('Locked — can’t add a card'); return; }
  touch(frameId);   // the reveal below belongs to the create step
  if (f.collapsed) f.collapsed = false;
  let pos: Pt;
  if (at) pos = centredAt(at);
  else {
    const box = frameInterior(f);
    const kids = childrenOf(frameId);
    const bottom = kids.reduce((y, k) => Math.max(y, k.y + nodeH(k)), -Infinity);
    pos = snapPt({ x: box.x + LIST_GAP, y: kids.length ? bottom + LIST_GAP : box.y + LIST_GAP });
  }
  createNode({ ...pos, parent: frameId });
}
// A new, empty FRAME centred on a world point, its name editor open — the palette's "New frame".
export function newFrameAt(p: Pt): void {
  if (state.readOnly) return;
  const at = snapPt({ x: p.x - FRAME_W / 2, y: p.y - FRAME_H / 2 });
  // in the frame under the pointer, if any — the same drop rule a card gets
  createNode({ ...at, type: 'frame', w: FRAME_W, h: FRAME_H, parent: frameAt(p.x, p.y, new Set())?.id });
}
// The next card after `refId`, in the same place it lives (the top level, or the same frame): just
// below it, or below whatever already sits under it — Enter, Enter, Enter down a column of cards
// appends to it rather than stacking on the card underneath.
export function createSibling(refId: string){
  if (state.readOnly) return;
  const ref = state.nodes.get(refId); if (!ref) return;
  const parent = parentOf(ref);
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t add a card here'); return; }
  const w = nodeW(ref);
  let y = ref.y + nodeH(ref) + LIST_GAP;
  for (let moved = true; moved;) {
    moved = false;
    for (const o of childrenOf(ref.parent)) {
      const oh = nodeH(o);
      if (o === ref || o.x >= ref.x + w || o.x + nodeW(o) <= ref.x || o.y >= y + NEW_CARD_H || o.y + oh <= y) continue;
      y = o.y + oh + LIST_GAP; moved = true;
    }
  }
  createNode({ x: ref.x, y, parent: ref.parent });
}

// ---------- breaking a note apart: extract selected body text into a card of its own ----------
// Two gestures share this: ⌘⇧E (→ a card beside it) and dragging the selection out of the editor
// (features/text-drag.ts → a card where it was dropped, or straight into another card's note). All of them CUT the text out of the source, so the three helpers below
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
  if (!md) {
    return;
  }
  t.body = (t.body && t.body.trim()) ? t.body.replace(/\s*$/, '') + '\n\n' + md : md;
  t.dirty = true;
  syncOpenEditor(t);
}
// Triggered with ⌘⇧E while editing a card's body in place: cut the selected text out of the note and
// drop it into a fresh card right beside it, in the same place the source lives.
export function extractToCard(): void {
  if (state.readOnly || !ui.bodyEdit) return;
  const n = state.nodes.get(ui.bodyEdit.id); if (!n) return;
  const ta = ui.bodyEdit.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e){ setStatus('Select some body text to extract'); return; }
  const { title, body } = splitHeading(cutCardText(n, s, e, ta.value));
  const at = snapPt({ x: n.x + nodeW(n) + LIST_GAP, y: n.y });
  const card = mkNode({ ...at, parent: n.parent, title, body });
  state.nodes.set(card.id, card);
  remeasure(); selectNode(card.id); popIn(card); scheduleSave();
  commitStep();   // extract bypasses endBodyEdit (ui.bodyEdit nulled above), so close the step here
  setStatus(`Extracted “${nodeLabel(card)}”`);
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
  // WHERE THE NEW CARD BELONGS: the frame it was dropped in (text-drag.ts resolves it with the same
  // frameAt every drop uses), else the top level — the open frame while there is one.
  const parent = dest.container ?? nodeOrNull(detachParentId());
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t drop there'); return; }
  const text = cutCardText(n, src.start, src.end, value);
  const { title, body } = splitHeading(text);
  if (parent?.collapsed){ touch(parent.id); parent.collapsed = false; }
  const card = mkNode({
    x: dest.at.x, y: dest.at.y,
    parent: parent?.id ?? null, title, body,
  });
  state.nodes.set(card.id, card);
  remeasure(); selectNode(card.id); scheduleSave(); commitStep();
  setStatus(`Extracted “${nodeLabel(card)}”`);
}

// ---------- merging cards into one ----------
// What can FUSE with another note, on EITHER side of the gesture: a plain card — the kind whose whole
// content is a body (with a title above it). A frame is a box whose own shape is the point,
// so folding it into a body would throw away exactly what it is. One predicate rather than a
// source/target pair, because the answer really is the same question both ways round.
export const canMerge = (n: MindNode): boolean =>
  n.type === 'card' && !isLockedEffective(n);
// ⌥-drop card(s) onto another card (features/drag.ts): fold each dragged note into the target's
// body — `## Title` then its text, in the order they were selected — and let the now-redundant cards
// go. The target is the card that SURVIVES, so it keeps its own id, file, colour, size and flags;
// only tags are unioned in, since a tag is a label on content that just moved.
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
  // An UNTITLED card contributes just its text: `n.title` is empty exactly when the
  // note carries no `# ` line, and inventing a heading here (from its first line, say) would put words
  // in the note that nobody wrote. A titled card contributes `## Title` — one level under the `# ` line
  // that is now the target's own title, which is what makes the merged note a correctly nested document.
  const section = (c: MindNode): string => {
    const body = (c.body || '').trim();
    const title = c.title.trim();
    if (!title) return body;
    return body ? `## ${title}\n\n${body}` : `## ${title}`;
  };
  appendToBody(target, cards.map(section).filter(Boolean).join('\n\n'));
  const tags = new Set(target.tags);
  for (const c of cards) for (const t of c.tags) tags.add(t);
  target.tags = [...tags];
  target.dirty = true;
  deleteNodes(cards.map(c => c.id));
  return cards.length;
}

// ---------- delete ----------
// Forget a set of node ids: drop them from state, remove their DOM cards, and queue
// their files for deletion on the next save. Callers pass the full subtree(s) to remove.
function deleteNodes(ids: Iterable<string>): void {
  const gone = new Set(ids);
  touch(...gone);   // single choke point: every removal's before-image lands in the step
  for (const id of gone){
    const n = state.nodes.get(id); if (!n) continue;
    // …including its container wrapper: a frame's clipping wrapper is hung off the node, not marked
    // with its data-id, so nothing else would ever reach it again.
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
    scheduleSaveBoard();
  }
}
export function deleteNode(id: string): void {
  if (state.readOnly) return;
  if (!state.nodes.has(id)) return;
  if (subtreeHasLocked(id)) { setStatus('Locked — can’t delete'); return; }
  // Deleting a folded frame deletes the notes in its folder, so they're read first — that way they
  // go through the history like any other delete, and one ⌘Z brings them all back.
  if (afterReading([id], () => deleteNode(id))) return;
  record([], () => {                 // ids are touched inside deleteNodes
    deleteNodes(subtreeIds(id));
    selectNode(null); relayout();
    scheduleSave();
  });
}
// Undo a creation that never became a card — Escape out of a fresh card's first edit, or clicking away
// from one nothing was typed into. Not a delete from the user's side, and not one in the history
// either: the pending step still holds this card's before-image (null, from mkNode), so deleting it
// here nets null→null and commitStep DISCARDS the whole step — neither the create nor the delete is
// left behind for ⌘Z to walk back through. `status` is passed where the user did something explicit
// (Escape); a card abandoned by clicking away goes quietly. Shared by both editors that can open
// on a brand-new card (features/inline-edit.ts), which
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
  if (afterReading(ids, deleteSelection)) return;   // a folded frame's notes first (see deleteNode)
  record([], () => {                 // ids are touched inside deleteNodes
    state.sel.clear(); state.selId = null;
    deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));   // dedup overlapping subtrees
    relayout(); applySelection(); scheduleSave();
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
// UNGROUP: delete every selected frame WITHOUT touching what it holds — its cards move up to ITS OWN
// parent, right where they sit. (A card has no children, so on a card this is a plain delete.) Cascades correctly when a selected node's parent is ALSO selected: children
// are read live (childrenOf), so a child already promoted by an earlier pass in this loop is what a
// later pass (deleting that now-former parent) sees and promotes again — any chain length just
// works, in any processing order. New parents get no explicit kidOrder splice; orderedKids
// (view/layout.ts) already treats a reparented-but-unlisted child as "fresh" and slots it in by
// position, so nothing needs doing here. Shared by ⌥Delete/⌥Backspace and the ⋯ menu's Ungroup.
export function deleteSelectionKeepChildren(): void {
  if (state.readOnly) {
    return;
  }
  const ids = selectedIds().filter(canPromoteDelete);
  if (!ids.length) {
    setStatus('Locked — can’t delete');
    return;
  }
  if (afterReading(ids, deleteSelectionKeepChildren, false)) {
    return;   // the children it keeps must exist
  }
  const promoted = new Set<string>();
  record([], () => {
    for (const id of ids) {
      const n = state.nodes.get(id);
      if (!n) {
        continue;
      }
      const kids = childrenOf(id);
      touch(id, ...kids.map(k => k.id));
      for (const k of kids) {
        k.parent = n.parent;
        k.dirty = true;
        promoted.add(k.id);
      }

      // the kept cards sit in the wrapper, and the next paint moves them out of it
      state.nodes.delete(id);
      n.el?.remove();
      n.frameContentEl?.remove();
      if (n.file) {
        state.toDelete.push(n.file);
      }
    }
  });
  for (const id of ids) {
    promoted.delete(id);   // a node promoted-then-itself-deleted (chain) isn't a survivor
  }
  relayout();
  setSelectionSet(promoted);
  scheduleSave();
  setStatus(`Ungrouped ${ids.length} frame${ids.length===1?'':'s'}`);
}
// Alt-drag an image OUT of a card (features/image-extract.ts): strip the `![alt](path)` from the
// source card's body, then either MOVE it into another card's body (`target.toCardId`) or drop it
// as a fresh image-only card at a world position (`target.x/y/w/h`). One undo step — touches +
// mutates and commits it (image extraction is its own gesture, not nested in a live drag).
export function extractImage(sourceId: string, path: string, alt: string,
    target: { toCardId: string } | { x: number; y: number; w: number; h: number }): void {
  if (state.readOnly || !path) {
    return;
  }
  const source = state.nodes.get(sourceId);
  if (!source) {
    return;
  }
  touch(sourceId);
  source.body = stripImageRef(source.body, path);
  source.dirty = true;
  syncOpenEditor(source);
  const md = `![${alt}](${path})`;
  if ('toCardId' in target){
    const tgt = state.nodes.get(target.toCardId);
    if (tgt){
      touch(tgt.id);
      tgt.body = (tgt.body && tgt.body.trim()) ? tgt.body.replace(/\s*$/, '') + '\n\n' + md : md;
      tgt.dirty = true;
      syncOpenEditor(tgt);
    }
    setStatus('Image moved');
  } else {
    // untitled: the note is the picture and nothing else, which is what makes it render as one
    // (core/state.ts isImageCard). The alt rides along in the markdown and names the file.
    const into = frameAt(target.x + target.w / 2, target.y + target.h / 2, new Set());
    const n = mkNode({ x: target.x, y: target.y, parent: into?.id ?? detachParentId(), title: '',
      body: md, color: 'none', w: target.w, h: target.h });
    touch(n.id);                 // before-image is null (not yet in state) → undo removes it
    state.nodes.set(n.id, n);
    relayout();
    growFramesToHold([n.id]);
    setStatus('Image extracted');
  }
  relayout();
  scheduleSave();
  commitStep();
}
