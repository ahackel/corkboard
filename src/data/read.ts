// ---------- reading notes into nodes ----------
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

// Shared by the load of the whole map and the read of ONE folded section's folder (readFolder, below):
// both turn listed notes into nodes, take each node's parent off its FOLDER, and settle positions.
//
// How each node's rx/ry was seeded decides how the top-down pass (settle) reads it:
//  · rel    — board.json or the current mm_position_x/y fields: already parent-relative.
//  · legacy — the legacy mm_x/mm_y fields: parent-relative ONLY for section children (the old
//    behaviour), otherwise ABSOLUTE — converted to relative in the top-down pass.
//  · neither — a grid fallback (absolute), likewise converted; and `unplaced`, so a section whose notes
//    ALL lack a position lays them out once (arrangeSections).
// TODO: legacy is a transitional migration shim — it can go once every map has been re-saved
// (serializeMd only re-emits mm_position_*, so the first save of any note drops its mm_x/mm_y).
export interface Seeds { rel: Set<string>; legacy: Set<string>; wasStack: Set<string>; unplaced: Set<string>; placed: number; }
export const newSeeds = (): Seeds => ({ rel: new Set(), legacy: new Set(), wasStack: new Set(), unplaced: new Set(), placed: 0 });
// mm_w is now written for every kind (an authored width), but it USED to be written ungated for a
// while before the box-kinds-only gate landed — so an old, not-since-re-saved note can carry a stale
// width from a time when `n.w` also held derived values (an outline row's stretched width, for
// one). Those are all NARROWER than a normal card, and a card can only ever be widened past
// its default, so anything under the default is junk from that era: drop it. One kind of note
// legitimately goes narrower and is exempt: an IMAGE card — a small picture is a small card, and one
// that used to carry `mm_type: image` now loads as an ordinary card (foldTypeLayout), so without
// this its authored size would be read as junk from that era and thrown away.
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
  // An UNMIGRATED note: no `# ` heading AND nothing in its body either. Its title used to BE its
  // filename, so there is no longer anything in the file to read a name off, and the card would show
  // up as a blank on the canvas and "Untitled" in every list. So take the name off the filename ONE
  // last time and mark the note dirty, which persists it as the `# Heading` it should have been —
  // after that the file stands on its own and this never fires for it again.
  // Deliberately only when the body is EMPTY. A note WITH text and no heading is a legitimately
  // UNTITLED card under this format (it shows its text and no title row, which is the point of
  // allowing it), and promoting its filename to a title would put a name on something nobody named.
  // And never when the note SAYS it is empty on purpose (`mm_blank`, written by serializeMd for exactly
  // this): emptying an existing card is an ordinary edit, and this migration used to undo it on the next
  // load — reading the card's old filename slug back as the title and saving it as a heading.
  // Nothing but a picture in the note → this is an IMAGE card (core/state.ts isImageCard reads the
  // same thing off the live node). Needed here before the node exists, for the width filter below.
  const imageOnly = !rest.title.trim() && !!soleImage(rest.body);
  const unmigrated = !rest.title.trim() && !rest.body.trim() && !mm.blank;
  if (unmigrated) {
    rest.title = fileStem(rel);
  }
  // A folder's section note IS a section, whatever its frontmatter says (or doesn't).
  const type: MindNode['type'] = isSectionNote(rel) ? 'section' : mm.type;
  // The PARENT is the folder the note sits in (utils/filenames.ts parentFileOf). Only a note at the top
  // level can still name one in `mm_parent` — a map from before sections were folders — and that note is
  // marked dirty: the save that follows moves it into its section's folder and drops the key.
  const folderParent = parentFileOf(rel);
  const legacyParent = !folderParent && mm.parent ? mm.parent : '';
  // GEOMETRY comes from board.json first (data/board.ts) and falls back to the note's own mm_*
  // for a vault written before it moved. Same meaning either way — an offset from the parent —
  // so the top-down pass doesn't care which supplied it.
  const g = boardGeom(rel);
  const hasBoard = (g?.x != null && g?.y != null);
  const hasRel = hasBoard || (mm.px != null && mm.py != null);
  const hasLegacy = (mm.x != null && mm.y != null);
  const placed = seeds.placed;
  const node: MindNode = {
    id: 'n' + (state.idSeq++), file:rel, x: 0, y: 0,   // x/y derived from rx/ry in settle()
    rx: hasBoard ? g!.x! : (mm.px != null && mm.py != null) ? mm.px! : hasLegacy ? mm.x! : (120 + (placed % 4) * 240),
    ry: hasBoard ? g!.y! : (mm.px != null && mm.py != null) ? mm.py! : hasLegacy ? mm.y! : (120 + Math.floor(placed / 4) * 200),
    _parentPath: folderParent ?? legacyParent,   // resolved to an id once all notes are loaded
    parent: null,
    collapsed: g ? !!g.collapsed : !!mm.collapsed,
    locked: !!mm.locked,
    type,
    // authoredW's junk-width filter is for the FRONTMATTER value only — a width in board.json was
    // written by this build and means exactly what it says.
    w: g?.w ?? authoredW(mm.w, type, imageOnly),
    // A legacy frontmatter mm_h only ever meant a box's size; a card's own (minimum) height is newer
    // than that and lives in board.json alone.
    h: g?.h ?? (isBoxType(type) || imageOnly ? mm.h : undefined) ?? undefined,
    clip: !!g?.clip,
    stack: type === 'section' && !!g?.stack,
    ...rest, dirty: unmigrated || !!mm.parent,   // notes lacking a position get one persisted
  };
  // The name the file has now stands for the text it has now (data/note-names.ts keepsName)
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
    seeds.unplaced.add(node.id);   // no saved position → fallback layout
  }
  return node;
}
// A folder with notes in it but no section note of its own — one made outside the app, in Finder or
// Obsidian — is a section all the same, named after the folder. Its section note is written by the next
// save (dirty), so from then on it is an ordinary section.
function folderSection(path: string, seeds: Seeds): MindNode {
  const d = dirOf(path).slice(0, -1);
  const n = nodeFromNote(path, parseMd(`# ${d.slice(d.lastIndexOf('/') + 1)}\n`), seeds);
  n.dirty = true;
  return n;
}
// Add every node a listing yields: its notes, a section for each folder that lacks one, and the FOLDED
// sections whose notes stayed unread (`lazy`, with how many there are). Returns the nodes added.
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
    n.collapsed = true;   // a folder nobody has unfolded yet arrives as its pill
  }
  // Sections for the folders that have notes but no section note — outermost last, since each one asks
  // for its own parent folder's section in turn.
  for (let i = 0; i < added.length; i++) {
    const want = added[i]._parentPath;
    if (!want || !parentFileOf(added[i].file!) || known.has(want)) {
      continue;
    }
    add(folderSection(want, seeds));
  }
  return added;
}
// Resolve each new node's parent path -> a loaded node's id (drops links to missing files), then settle
// every rx/ry to parent-relative and derive the working x/y — top-down, so a parent's absolute x/y is
// final by the time its children are reached. rel seeds and legacy section children are already
// relative; the rest hold an ABSOLUTE seed, so subtract the parent's position.
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
    const pax = p ? p.x : 0, pay = p ? p.y : 0;   // final (parents are visited before their children)
    const alreadyRel = seeds.rel.has(n.id) || (seeds.legacy.has(n.id) && !!p && p.type === 'section');
    if (p && !alreadyRel) { n.rx -= pax; n.ry -= pay; }   // absolute seed → parent-relative
    n.x = pax + n.rx; n.y = pay + n.ry;                   // working absolute coords
    for (const k of kidsOf.get(n.id) ?? []) {
      stack.push(k);
    }
  }
  return byPath;
}
// Which folders a read leaves UNREAD (store/tree.ts): a section folded in board.json, and a folder the
// board has never seen — it arrives as a folded pill. Never one on the way to a path in `keep` (the
// sections you are standing in), which has to be on the canvas.
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

// Read the notes of ONE folded section's folder into memory (data/lazy.ts decides when). `deep` reads
// everything under it; otherwise the sections folded INSIDE it stay unread in turn, like on a load.
// Nothing is painted or laid out here — the caller unfolds, opens or moves what it read.
// Two asks for the same folder at once (a double-click, a save) share ONE read.
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
    return;   // read twice at once, or gone meanwhile
  }
  f.lazy = undefined; f.lazySections = undefined;
  const seeds = newSeeds();
  const added = addListed(listing, seeds);
  const byPath = settle(added, seeds);
  unparkEdges(byPath);
  resolveOrder(byPath);
  // Paint what was read, so the arrangement below can measure it (it is hidden under its folded section
  // anyway until the caller unfolds that).
  for (const n of added) {
    dataHooks.paintNode(n);
  }
  arrangeSections(unplacedSections([f, ...added], seeds), seeds.unplaced);
}
// Sections holding notes that arrived with no saved position — a folder made outside the app, a map
// imported without its board.json, or a note saved into a section's folder from somewhere else (the
// phone INBOX, docs/inbox.md): they get laid out, rather than dropped on a grid at the origin.
export function unplacedSections(nodes: MindNode[], seeds: Seeds): MindNode[] {
  return nodes.filter(f => f.type === 'section' && f.lazy == null)
    .filter(f => childrenOf(f.id).some(k => seeds.unplaced.has(k.id)));
}
