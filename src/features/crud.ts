// Node lifecycle: create, duplicate, merge, extract, delete.
import { state, setStatus, singleNoteRefuses, isStack, type MindNode, type NodeType } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { childrenOf, nodeLabel, isLockedEffective, subtreeHasLocked, parentOf, isHidden, nodesOf, subtreeIds, takesDrop } from '../utils/model.js';
import { stripImageRef, appendMd, imageMd } from '../utils/markdown.js';
import { advanceTitle } from '../utils/advance.js';
import { splitHeading, setNoteText } from '../utils/frontmatter.js';
import { sectionInterior, holderOf, sectionAt } from '../view/layout.js';
import { worldAtOrCentre } from '../view/camera.js';
import { detachParentId } from '../nav/scope.js';
import { paintAll, relayout, remeasure } from '../render.js';
import { startInlineEdit, dropBodyEdit, syncOpenEditor } from './inline-edit.js';
import { touch, touchEdges, commitStep } from './history.js';
import { mutate } from './mutate.js';
import { SPACING, slidePast } from '../utils/guides.js';
import { nextInRow, belowContents } from '../utils/placement.js';
import { mergedText, mergedTags } from '../utils/merge-notes.js';
import { boxOf } from './guides.js';
import { settleSections } from './drop.js';
import { scheduleSaveBoard } from '../data/board.js';
import { afterReading } from '../data/lazy.js';
import { nodeH, nodeW, snapPt, NODE_W, SECTION_W, SECTION_H } from '../view/geometry.js';
import { selectNode, setSelectionSet, applySelection, selectedIds } from './selection.js';
import { scheduleSave } from '../data/save.js';
import { settleStacks, selectedStacks, spreadPiles } from './stacks.js';

// The ONE place the node schema and its defaults live; every create goes through it.
export function mkNode(fields: Partial<MindNode> = {}): MindNode {
  const id = 'n' + (state.idSeq++);

  // Not in state.nodes yet, so its before-image is null: undoing the create removes it.
  touch(id);
  return {
    id, file:null,
    x:0, y:0, rx:0, ry:0, parent:null, collapsed:false, locked:false,
    title:'', color:'', tags:[], body:'',
    type:'card',
    dirty:true,
    ...fields,
  };
}

// A square yellow sticky, written rather than inherited, so it stays yellow inside a coloured section.
const NEW_CARD = { color: 'amber', h: NODE_W };

// A first guess before each card can be measured (layoutH's fallback too); createCards restacks after.
const NEW_CARD_H = 64;

// The ONE spelling of "a new card HERE": centred on the point, on the grid.
export function centredAt(p: Pt): Pt { return snapPt({ x: p.x - NODE_W / 2, y: p.y - NODE_W / 2 }); }

interface CreateOpts {
  x?: number; y?: number; parent?: string | null; title?: string; color?: string;
  tags?: string[]; body?: string; type?: NodeType; isNew?: boolean;
  w?: number; h?: number;

  // false: no editor opens, as for a paste whose content is final.
  edit?: boolean;
}

// A data attribute, not a class: paintNode rewrites className wholesale.
function popIn(n: MindNode): void {
  const el = n.el;
  if (el) { el.dataset.pop = ''; el.addEventListener('animationend', () => { delete el.dataset.pop; }, { once: true }); }
}

export function createNode(opts: CreateOpts = {}): MindNode | undefined {
  if (singleNoteRefuses()) {
    return;
  }
  // While a section is OPEN its interior is the top level; a true root would vanish outside the scope.
  const parentId = opts.parent !== undefined && opts.parent !== null ? holderOf(opts.parent) : detachParentId();
  if (parentId) {
    const p = state.nodes.get(parentId);
    if (p && isLockedEffective(p)) { setStatus('Locked — can’t add a child'); return; }
  }
  const c = centredAt(worldAtOrCentre());
  const isCard = (opts.type ?? 'card') === 'card';
  const n = mkNode({
    x: opts.x ?? c.x, y: opts.y ?? c.y,
    parent: parentId,
    title: opts.title ?? '',
    color: opts.color ?? (isCard ? NEW_CARD.color : ''),
    tags: opts.tags ? [...opts.tags] : [], body: opts.body ?? '',
    type: opts.type ?? 'card',
    w: opts.w, h: opts.h ?? (isCard ? NEW_CARD.h : undefined),
  });
  const id = n.id;
  state.nodes.set(id, n);
  relayout();
  if (n.type === 'section' && settleSections([id]).length) {
    relayout();
  }
  selectNode(id);
  popIn(n);
  if (opts.edit !== false) {
    startInlineEdit(n, { isNew: opts.isNew ?? true });
  } else {
    commitStep();
  }
  scheduleSave();
  return n;
}

const LIST_GAP = SPACING;

// A column whose top-left is `at`, in ONE undo step, stacked from MEASURED heights, so painted first.
export function createCards(texts: string[], at: Pt, parent: string | null): MindNode[] {
  if (!texts.length || singleNoteRefuses()) {
    return [];
  }
  const parentId = parent ? holderOf(parent) : detachParentId();
  const p = parentId ? state.nodes.get(parentId) : undefined;
  if (p && isLockedEffective(p)) { setStatus('Locked — can’t add a child'); return []; }
  const made: MindNode[] = [];
  mutate([parentId], () => {
    if (p?.collapsed) {
      p.collapsed = false;
    }
    texts.forEach((t, i) => {
      const { title, body } = splitHeading(t);
      const n = mkNode({ x: at.x, y: at.y + i * (NEW_CARD_H + LIST_GAP), parent: parentId, title, body });
      state.nodes.set(n.id, n);
      made.push(n);
    });
    remeasure();
    let y = at.y;
    for (const n of made) { n.y = y; y += nodeH(n) + LIST_GAP; }
  }, { reflow: 'relayout' });
  setSelectionSet(made.map(n => n.id));
  made.forEach(popIn);
  return made;
}

// Painted but not selected, edited or saved: the dock's ghost-card drag drives it, and an abandoned
// drag must never write a file.
export function createDetachedNode(x: number, y: number): MindNode | undefined {
  if (singleNoteRefuses()) {
    return;
  }
  const n = mkNode({ ...NEW_CARD, x, y, parent: detachParentId() });
  state.nodes.set(n.id, n);
  paintAll();
  return n;
}

// Not its subtree. The title is kept verbatim; desiredFileFor keeps the FILE names apart.
function cloneNodeAt(s: MindNode, x: number, y: number): MindNode {
  const copy = mkNode({
    x, y,
    parent: s.parent,
    title: s.title,
    color: s.color,
    tags: [...s.tags], body: s.body,
    type: s.type,
    w: s.w, h: s.h, clip: s.clip,

    // titleGap rides along, or the copy's file would gain a blank line the original lacks.
    collapsed: s.collapsed, titleGap: s.titleGap, titleLevel: s.titleLevel,
  });
  state.nodes.set(copy.id, copy);
  return copy;
}

const DUPLICATE_GAP = 24;

// Snapped: the measured height would otherwise put the copy off its source's grid.
function copyNode(s: MindNode): MindNode {
  const at = snapPt({ x: s.x, y: s.y + nodeH(s) + DUPLICATE_GAP });
  return cloneNodeAt(s, at.x, at.y);
}

// See "A SMART duplicate makes the NEXT card" in docs/architecture.md.
function copyNext(s: MindNode): MindNode {
  const sibs = childrenOf(s.parent).filter(o => o !== s && !isHidden(o));
  const at = snapPt(nextInRow(boxOf(s), sibs.map(o => boxOf(o)), LIST_GAP));
  const c = cloneNodeAt(s, at.x, at.y);
  if (c.title.trim()) {
    c.title = advanceTitle(c.title);
  } else {
    const nl = c.body.indexOf('\n');
    c.body = advanceTitle(nl < 0 ? c.body : c.body.slice(0, nl)) + (nl < 0 ? '' : c.body.slice(nl));
  }
  return c;
}

// The copies come out SELECTED, not in an editor, so D / ⇧D again builds a series.
export function duplicateSelection({ next = false }: { next?: boolean } = {}): MindNode[] | undefined {
  if (singleNoteRefuses()) {
    return;
  }
  const ids = selectedIds();
  if (afterReading(ids, () => duplicateSelection({ next }))) {
    return;
  }
  const srcs = nodesOf(ids);
  if (!srcs.length) {
    return;
  }
  const copies = srcs.map(next ? copyNext : copyNode);
  remeasure();
  if (copies.length === 1){
    selectNode(copies[0].id);
  } else {
    setSelectionSet(copies.map(c => c.id));
  }
  commitStep();
  if (next) {
    setStatus(copies.length === 1 ? `Next → “${nodeLabel(copies[0])}”` : `Made the next of ${copies.length} cards`);
  }
  scheduleSave();
  return copies;
}

// The copy a clone-drag leaves behind while the original is dragged away.
export function leaveClone(s: MindNode, pos: Pt): MindNode {
  return cloneNodeAt(s, pos.x, pos.y);
}

// Without a point, under what the section already holds, so Tab-Tab-Tab fills it top to bottom.
export function addCardInside(sectionId: string, at?: Pt): void {
  const f = state.nodes.get(sectionId);
  if (!f || f.type !== 'section') {
    return;
  }
  if (isLockedEffective(f)) { setStatus('Locked — can’t add a card'); return; }

  // The reveal belongs to the create step.
  touch(sectionId);
  if (f.collapsed) {
    f.collapsed = false;
  }
  let pos: Pt;
  if (at) {
    pos = centredAt(at);
  } else {
    pos = snapPt(belowContents(sectionInterior(f), childrenOf(sectionId).map(k => boxOf(k)), LIST_GAP));
  }
  createNode({ ...pos, parent: sectionId });
}

// FigJam's: one past the highest "Section N" already there.
export function nextSectionTitle(): string {
  let max = 0;
  for (const n of state.nodes.values()) {
    const m = n.type === 'section' ? /^Section (\d+)$/.exec(n.title) : null;
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `Section ${max + 1}`;
}

export function newSectionAt(p: Pt): void {
  const at = snapPt({ x: p.x - SECTION_W / 2, y: p.y - SECTION_H / 2 });
  createNode({ ...at, type: 'section', w: SECTION_W, h: SECTION_H, title: nextSectionTitle(), parent: sectionAt(p.x, p.y, new Set())?.id });
}

// Below `refId`, past whatever already sits there, so Enter, Enter, Enter appends to a column.
export function createSibling(refId: string){
  const ref = state.nodes.get(refId);
  if (!ref) {
    return;
  }
  const parent = parentOf(ref);
  if (parent && isLockedEffective(parent)) { setStatus('Locked — can’t add a card here'); return; }
  const others = childrenOf(ref.parent).filter(o => o !== ref).map(o => boxOf(o));
  const { y } = slidePast({ x: ref.x, y: ref.y + nodeH(ref) + LIST_GAP, w: nodeW(ref), h: NODE_W }, others, 'y', LIST_GAP);
  createNode({ x: ref.x, y, parent: ref.parent });
}

// See "MERGING notes and BREAKING them apart are two DRAGS" in docs/architecture.md.

// The editor is DROPPED, not ended: ending would write its stale text back. The caller commits the step.
function cutCardText(n: MindNode, start: number, end: number, value: string): string {
  touch(n.id);
  const text = value.slice(start, end);
  const rest = (value.slice(0, start) + value.slice(end)).replace(/\n{3,}/g, '\n\n').trim();
  setNoteText(n, rest);
  n.dirty = true;
  dropBodyEdit();
  return text;
}

// Syncs an editor open on the target, or its next commit would write the old text back.
function appendToBody(t: MindNode, md: string): void {
  if (!md) {
    return;
  }
  t.body = appendMd(t.body, md);
  t.dirty = true;
  syncOpenEditor(t);
}

// ⌘⇧E: the selected text into a fresh card beside its note.
export function extractToCard(): void {
  if (!ui.bodyEdit || singleNoteRefuses()) {
    return;
  }
  const n = state.nodes.get(ui.bodyEdit.id);
  if (!n) {
    return;
  }
  const ta = ui.bodyEdit.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e){ setStatus('Select some body text to extract'); return; }
  const { title, body } = splitHeading(cutCardText(n, s, e, ta.value));
  const at = snapPt({ x: n.x + nodeW(n) + LIST_GAP, y: n.y });
  const card = mkNode({ ...at, parent: n.parent, title, body });
  state.nodes.set(card.id, card);
  remeasure(); selectNode(card.id); popIn(card); scheduleSave();
  commitStep();
}

// Offsets into the open editor's LIVE text, so they are read against that, not n.title/n.body.
export interface TextSource { id: string; start: number; end: number }

function liveText(src: TextSource): string | null {
  return ui.bodyEdit && ui.bodyEdit.id === src.id ? ui.bodyEdit.ta.value : null;
}

// null once that editor has closed.
export function cardText(src: TextSource): string | null {
  const value = liveText(src);
  return value == null ? null : value.slice(src.start, src.end);
}

export type TextDrop = { into: MindNode } | { container: MindNode | null; at: Pt };

export function dropCardText(src: TextSource, dest: TextDrop): void {
  const n = state.nodes.get(src.id);
  if (!n) {
    return;
  }
  const value = liveText(src);
  if (value == null) {
    return;
  }
  if (src.start >= src.end || src.end > value.length) {
    return;
  }
  // Refuse the landing BEFORE cutting, so the text is never removed with nowhere to put it.
  if ('into' in dest){
    const t = dest.into;
    if (t.id === src.id || !takesDrop(t)) {
      return;
    }
    const text = cutCardText(n, src.start, src.end, value);
    touch(t.id);
    appendToBody(t, text.trim());
    relayout(); selectNode(t.id); scheduleSave(); commitStep();
    return;
  }
  if (singleNoteRefuses()) {
    return;
  }
  const parent = dest.container ?? state.nodes.get(detachParentId() ?? '') ?? null;
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
}

// What can be folded INTO another note; what can receive one is takesDrop.
export const canMerge = (n: MindNode): boolean =>
  n.type === 'card' && !isLockedEffective(n);

// The target SURVIVES, gaining only the tags. Runs inside the drag's undo step: the caller commits.
export function mergeCardsInto(targetId: string, sourceIds: Iterable<string>): number {
  const target = state.nodes.get(targetId);
  if (!takesDrop(target)) {
    return 0;
  }
  const cards = [...sourceIds]
    .map(id => state.nodes.get(id))
    .filter((n): n is MindNode => !!n && n.id !== targetId && canMerge(n));
  if (!cards.length) {
    return 0;
  }
  touch(targetId);
  appendToBody(target, mergedText(cards));
  target.tags = mergedTags(target.tags, cards);
  target.dirty = true;
  deleteNodes(cards.map(c => c.id));
  return cards.length;
}

// Callers pass the full subtree(s).
export function deleteNodes(ids: Iterable<string>): void {
  const gone = new Set(ids);
  touch(...gone);
  for (const id of gone){
    const n = state.nodes.get(id);
    if (!n) {
      continue;
    }
    // A section's wrapper carries no data-id, so nothing else would ever reach it again.
    state.nodes.delete(id); n.el?.remove(); n.sectionContentEl?.remove();
    if (n.file) {
      state.toDelete.push(n.file);
    }
  }
  // In the same step, so one ⌘Z brings back the card AND its edges.
  if (state.edges.some(e => gone.has(e.from) || gone.has(e.to))) {
    touchEdges();
    state.edges = state.edges.filter(e => !gone.has(e.from) && !gone.has(e.to));
    scheduleSaveBoard();
  }
  settleStacks();
}

export function deleteNode(id: string): void {
  if (singleNoteRefuses()) {
    return;
  }
  if (!state.nodes.has(id)) {
    return;
  }
  if (subtreeHasLocked(id)) { setStatus('Locked — can’t delete'); return; }
  // A folded section's notes are read first, so one ⌘Z brings them back.
  if (afterReading([id], () => deleteNode(id))) {
    return;
  }
  mutate([], () => {
    deleteNodes(subtreeIds(id));
    selectNode(null);
  }, { reflow: 'relayout' });
}

// A fresh card left empty. Its step's before-image is null (mkNode), so null→null: commitStep
// discards the step and ⌘Z has nothing to walk back through.
export function discardNewCard(id: string, status?: string): void {
  deleteNode(id);
  commitStep();
  if (status) {
    setStatus(status);
  }
}

export function deleteSelection(): void {
  if (singleNoteRefuses()) {
    return;
  }
  const ids = [...state.sel].filter(id => !subtreeHasLocked(id));
  if (!ids.length) { setStatus('Locked — can’t delete'); return; }
  if (afterReading(ids, deleteSelection)) {
    return;
  }
  mutate([], () => {
    state.sel.clear(); state.selId = null;
    deleteNodes(new Set(ids.flatMap(id => subtreeIds(id))));
  }, { reflow: 'relayout' });
  applySelection();
}

function canPromoteDelete(id: string): boolean {
  const n = state.nodes.get(id);
  if (!n) {
    return false;
  }
  if (isLockedEffective(n)) {
    return false;
  }
  const parent = parentOf(n);
  if (parent && isLockedEffective(parent)) {
    return false;
  }
  return childrenOf(id).every(k => !isLockedEffective(k));
}

// UNGROUP: each selected section's cards move up to ITS parent, where they sit. Children are read live,
// so nested selected sections cascade in any order.
export function deleteSelectionKeepChildren(): void {
  if (singleNoteRefuses()) {
    return;
  }

  // A stack's cards all lie on one spot, so stacks are spread out instead of left in a heap.
  const stacks = selectedStacks().filter(s => canPromoteDelete(s.id));
  const ids = selectedIds().filter(id => !isStack(state.nodes.get(id)) && canPromoteDelete(id));
  if (!ids.length && !stacks.length) {
    setStatus('Locked — can’t delete');
    return;
  }
  if (afterReading(ids, deleteSelectionKeepChildren, false)) {
    return;
  }
  const promoted = new Set<string>();
  let loose: string[] = [];
  const part = (k: number, one: string): string => k ? `${k} ${one}${k === 1 ? '' : 's'}` : '';
  mutate([], () => {
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

      // The kept cards still sit in the wrapper; the next paint moves them out.
      state.nodes.delete(id);
      n.el?.remove();
      n.sectionContentEl?.remove();
      if (n.file) {
        state.toDelete.push(n.file);
      }
    }
    // After the sections, so a stack that was in one spreads out where it now lies.
    loose = spreadPiles(stacks.filter(s => state.nodes.has(s.id)));
  }, { reflow: 'relayout', status: `Ungrouped ${[part(ids.length, 'section'), part(stacks.length, 'stack')].filter(Boolean).join(' and ')}` });
  for (const id of [...ids, ...stacks.map(s => s.id)]) {
    promoted.delete(id);
  }
  setSelectionSet([...promoted, ...loose]);
}

// ⌥-drag of an image out of a card: into another card's note, or a fresh image card. Its own undo step.
export function extractImage(sourceId: string, path: string, alt: string,
    target: { toCardId: string } | { x: number; y: number; w: number; h: number }): void {
  if (!path || singleNoteRefuses()) {
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
  const md = imageMd(alt, path);
  if ('toCardId' in target){
    const tgt = state.nodes.get(target.toCardId);
    if (tgt){
      touch(tgt.id);
      appendToBody(tgt, md);
    }
  } else {
    // Untitled, or it would not be an image card (isImageCard).
    const into = sectionAt(target.x + target.w / 2, target.y + target.h / 2, new Set());
    const n = mkNode({ x: target.x, y: target.y, parent: into?.id ?? detachParentId(), title: '',
      body: md, color: 'none', w: target.w, h: target.h });
    touch(n.id);
    state.nodes.set(n.id, n);
  }
  relayout();
  scheduleSave();
  commitStep();
}
