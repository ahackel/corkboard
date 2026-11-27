// Turning listed notes into nodes: for the whole map, and for one folded section's folder (readFolder).
import { type MindNode, isBoxType, state } from '../core/state.js';
import { NODE_W } from '../view/geometry.js';
import { parseMd, fileStem } from '../utils/frontmatter.js';
import { soleImage } from '../utils/markdown.js';
import { isSectionNote, parentFileOf, dirOf, SECTION_NOTE, slugStem, pathKey } from '../utils/filenames.js';
import { boardGeom, resolveOrder, unparkEdges } from './board.js';
import { type TreeListing } from '../store/types.js';
import { parentOf, childrenOf } from '../utils/model.js';
import { type FoldTest } from '../store/tree.js';
import { scope } from '../nav/scope.js';
import { dataHooks } from './hooks.js';
import { noteNamed } from './note-names.js';
import { knowAssets } from './images.js';
import { store } from './active-store.js';
import { arrangeSections } from './arrange.js';

const FALLBACK_ORIGIN = 120, FALLBACK_COLS = 4, FALLBACK_COL_W = 240, FALLBACK_ROW_H = 200;
const fallbackX = (placed: number): number => FALLBACK_ORIGIN + (placed % FALLBACK_COLS) * FALLBACK_COL_W;
const fallbackY = (placed: number): number => FALLBACK_ORIGIN + Math.floor(placed / FALLBACK_COLS) * FALLBACK_ROW_H;

// How each rx/ry was seeded, for settle(): `rel` is parent-relative already; `legacy` (mm_x/mm_y) only for
// section children, else absolute; the rest sit on a fallback grid (absolute) and are `unplaced`.
// TODO: drop `legacy` once every map has been re-saved (the first save drops mm_x/mm_y).
export interface Seeds { rel: Set<string>; legacy: Set<string>; wasStack: Set<string>; unplaced: Set<string>; placed: number; }
export const newSeeds = (): Seeds => ({ rel: new Set(), legacy: new Set(), wasStack: new Set(), unplaced: new Set(), placed: 0 });
// Old builds wrote derived widths into mm_w, all narrower than a card's default: a plain card's width
// below NODE_W is that junk. Image cards legitimately go narrower.
function authoredW(w: number | null | undefined, type: MindNode['type'], isImage: boolean): number | undefined {
  if (w == null) {
    return undefined;
  }
  if (isBoxType(type) || isImage) {
    return w;
  }
  return w >= NODE_W ? w : undefined;
}
function nodeFromNote(rel: string, parsed: ReturnType<typeof parseMd>, seeds: Seeds): MindNode {
  const { mm, ...rest } = parsed;
  const imageOnly = !rest.title.trim() && !!soleImage(rest.body);
  // See "A body-less note is MIGRATED on load" and "A note that is blank ON PURPOSE" in docs/architecture.md.
  const unmigrated = !rest.title.trim() && !rest.body.trim() && !mm.blank;
  if (unmigrated) {
    rest.title = fileStem(rel);
  }
  const type: MindNode['type'] = isSectionNote(rel) ? 'section' : mm.type;
  // A legacy `mm_parent` counts only at the top level; the note is marked dirty so a save moves it.
  const folderParent = parentFileOf(rel);
  const legacyParent = !folderParent && mm.parent ? mm.parent : '';
  // board.json first, else the note's legacy mm_* (same meaning: an offset from the parent).
  const g = boardGeom(rel);
  const hasBoard = (g?.x != null && g?.y != null);
  const hasRel = hasBoard || (mm.px != null && mm.py != null);
  const hasLegacy = (mm.x != null && mm.y != null);
  const placed = seeds.placed;
  const node: MindNode = {
    id: 'n' + (state.idSeq++), file:rel, x: 0, y: 0,   // x/y derived from rx/ry in settle()
    rx: hasBoard ? g!.x! : (mm.px != null && mm.py != null) ? mm.px! : hasLegacy ? mm.x! : fallbackX(placed),
    ry: hasBoard ? g!.y! : (mm.px != null && mm.py != null) ? mm.py! : hasLegacy ? mm.y! : fallbackY(placed),
    _parentPath: folderParent ?? legacyParent,   // resolved to an id in settle()
    parent: null,
    collapsed: g ? !!g.collapsed : !!mm.collapsed,
    locked: !!mm.locked,
    type,
    w: g?.w ?? authoredW(mm.w, type, imageOnly),
    // A legacy mm_h only ever meant a box's size.
    h: g?.h ?? (isBoxType(type) || imageOnly ? mm.h : undefined) ?? undefined,
    clip: !!g?.clip,
    stack: type === 'section' && !!g?.stack,
    ...rest, dirty: unmigrated || !!mm.parent,
  };
  noteNamed(rel, slugStem(node));
  if (mm.wasStack) {
    seeds.wasStack.add(node.id);
  }
  if (hasRel) {
    seeds.rel.add(node.id);
  } else if (hasLegacy) {
    seeds.legacy.add(node.id);
  } else {
    seeds.placed++;
    seeds.unplaced.add(node.id);
  }
  return node;
}
// A folder made outside the app, with no section note: a section named after it, written by the next save.
function folderSection(path: string, seeds: Seeds): MindNode {
  const d = dirOf(path).slice(0, -1);
  const n = nodeFromNote(path, parseMd(`# ${d.slice(d.lastIndexOf('/') + 1)}\n`), seeds);
  n.dirty = true;
  return n;
}
// The listing's notes, a section for each folder lacking one, and the unread folded sections (`lazy`).
export function addListed(listing: TreeListing, seeds: Seeds): MindNode[] {
  for (const d of listing.foreign) {
    foreignDirs.add(d);
  }
  knowAssets(listing.assets ?? []);
  const known = new Set([...state.nodes.values()].map(n => n.file));
  const added: MindNode[] = [];
  const add = (n: MindNode): void => { state.nodes.set(n.id, n); known.add(n.file); added.push(n); };
  for (const { path, text } of listing.files) {
    if (!known.has(path)) {
      add(nodeFromNote(path, parseMd(text), seeds));
    }
  }
  for (const [dir, f] of listing.lazy) {
    const path = dir + SECTION_NOTE;
    let n = [...state.nodes.values()].find(m => !!m.file && pathKey(m.file) === pathKey(path));
    if (!n) {
      add(n = folderSection(path, seeds));
    }
    n.lazy = f.count;
    n.lazySections = f.sections;
    n.collapsed = true;
  }
  // `added` grows as it is walked: each new section asks for its own parent folder's in turn.
  for (let i = 0; i < added.length; i++) {
    const want = added[i]._parentPath;
    if (!want || !parentFileOf(added[i].file!) || known.has(want)) {
      continue;
    }
    add(folderSection(want, seeds));
  }
  return added;
}
// Parent paths → ids, then rx/ry → parent-relative and x/y derived, top-down so a parent's x/y is final first.
export function settle(added: MindNode[], seeds: Seeds): Map<string | null, string> {
  const byPath = new Map<string | null, string>([...state.nodes.values()].map(n => [n.file, n.id]));
  for (const n of added) {
    n.parent = n._parentPath ? (byPath.get(n._parentPath) || null) : null;
    delete n._parentPath;
  }
  const mine = new Set(added.map(n => n.id));
  const kidsOf = new Map<string | null, MindNode[]>();
  for (const n of added) { const k = kidsOf.get(n.parent) ?? []; k.push(n); kidsOf.set(n.parent, k); }
  const stack = added.filter(n => !n.parent || !mine.has(n.parent));
  while (stack.length) {
    const n = stack.pop()!;
    const p = parentOf(n);
    const pax = p ? p.x : 0, pay = p ? p.y : 0;
    const alreadyRel = seeds.rel.has(n.id) || (seeds.legacy.has(n.id) && !!p && p.type === 'section');
    if (p && !alreadyRel) { n.rx -= pax; n.ry -= pay; }
    n.x = pax + n.rx; n.y = pay + n.ry;
    for (const k of kidsOf.get(n.id) ?? []) {
      stack.push(k);
    }
  }
  return byPath;
}
// Folders a read leaves unread: folded in board.json, or never seen. Never one on the way to `keep`.
export function foldTest(keep: string[]): FoldTest {
  return (dir) => {
    if (keep.some(k => k.startsWith(dir))) {
      return false;
    }
    const g = boardGeom(dir + SECTION_NOTE);
    return g ? !!g.collapsed : true;
  };
}
// Folders on disk that are NOT sections (`attachments/`, …), lowercased: a section may not move into one.
export const foreignDirs = new Set<string>();
export const scopeFiles = (): string[] => scope.stack.map(l => l.file).filter((f): f is string => !!f);

// `deep` also reads the sections folded inside it. Concurrent asks for one folder share one read.
const reading = new Map<string, Promise<void>>();
export function readFolder(f: MindNode, deep: boolean): Promise<void> {
  const busy = reading.get(f.id);
  if (busy) {
    return busy;
  }
  const p = readFolderNow(f, deep).finally(() => reading.delete(f.id));
  reading.set(f.id, p);
  return p;
}
async function readFolderNow(f: MindNode, deep: boolean): Promise<void> {
  if (f.lazy == null || !f.file || !store.isOpen) {
    return;
  }
  const listing = await store.listTree(dirOf(f.file), deep ? () => false : foldTest(scopeFiles()));
  if (f.lazy == null || !state.nodes.has(f.id)) {
    return;   // gone meanwhile
  }
  f.lazy = undefined; f.lazySections = undefined;
  const seeds = newSeeds();
  const added = addListed(listing, seeds);
  const byPath = settle(added, seeds);
  unparkEdges(byPath);
  resolveOrder(byPath);
  // Painted so the arrangement can measure it.
  for (const n of added) {
    dataHooks.paintNode(n);
  }
  arrangeSections(unplacedSections([f, ...added], seeds), seeds.unplaced);
}
// Sections holding notes with no saved position (made outside the app, the inbox): they get laid out.
export function unplacedSections(nodes: MindNode[], seeds: Seeds): MindNode[] {
  return nodes.filter(f => f.type === 'section' && f.lazy == null)
    .filter(f => childrenOf(f.id).some(k => seeds.unplaced.has(k.id)));
}
