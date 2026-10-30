// ---------- reading notes into nodes ----------
import { type MindNode, isBoxType, state, world, setStatus } from '../core/state.js';
import { surfaceColorOf } from '../view/color.js';
import { NODE_W, nodeW, SECTION_BORDER, nodeH, snapPt } from '../view/geometry.js';
import { parseMd, fileStem } from '../utils/frontmatter.js';
import { soleImage } from '../utils/markdown.js';
import { isSectionNote, parentFileOf, dirOf, SECTION_NOTE } from '../utils/filenames.js';
import { boardGeom, loadBoard, resolveEdges, resolveOrder, boardIsLegacy, flushBoard, unparkEdges } from './board.js';
import { type TreeListing } from '../store/types.js';
import { parentOf, childrenOf, ancestors } from '../utils/model.js';
import { unreadSectionHolding } from './lazy.js';
import { type FoldTest } from '../store/tree.js';
import { scope, resolveScopeAfterLoad } from '../nav/scope.js';
import { clearHistory } from '../features/history.js';
import { holdCanvasFade } from '../features/canvas-color.js';
import { resetSaveState, scheduleSave } from './save.js';
import { resetImageCache } from '../features/images.js';
import { refreshGrid } from '../view/grid.js';
import { store, updateMapTitle } from './persistence.js';
import { flattenLegacyBranches, foldCardsIntoSections } from './migrate.js';
import { remeasure, paintNode } from '../main.js';
import { fit } from '../view/camera.js';
import { ancestorDepth, orderedKids, sectionLabelH, moveSubtreeTo } from '../view/layout.js';
import { SPACING } from '../utils/guides.js';
import { MIN_SECTION_W } from '../features/resize.js';

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
interface Seeds { rel: Set<string>; legacy: Set<string>; wasStack: Set<string>; unplaced: Set<string>; placed: number; }
const newSeeds = (): Seeds => ({ rel: new Set(), legacy: new Set(), wasStack: new Set(), unplaced: new Set(), placed: 0 });
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
  const hasPos = hasRel || hasLegacy;
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
    ...rest, dirty: unmigrated || !!mm.parent, dirtyLayout: !hasPos,   // notes lacking a position get one persisted
  };
  if (mm.wasStack) {
    seeds.wasStack.add(node.id);
  }

  // A section coloured from the STICKY palette, from before sections had their own (view/color.ts): it
  // takes that colour's surface twin, once, and is saved so.
  if (type === 'section' && !node.stack && node.color && surfaceColorOf(node.color) !== node.color) {
    node.color = surfaceColorOf(node.color);
    node.dirty = true;
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
function addListed(listing: TreeListing, seeds: Seeds): MindNode[] {
  for (const d of listing.foreign) {
    foreignDirs.add(d);
  }
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
    let n = [...state.nodes.values()].find(m => m.file?.toLowerCase() === path.toLowerCase());
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
function settle(added: MindNode[], seeds: Seeds): Map<string | null, string> {
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
// The section an unread note sits in, for a line that ends on it: the deepest folded section in memory
// whose folder holds the path (data/board.ts resolveEdges).
function standInFor(path: string): string | null {
  return unreadSectionHolding(path)?.id ?? null;
}
// Which folders a read leaves UNREAD (store/tree.ts): a section folded in board.json, and a folder the
// board has never seen — it arrives as a folded pill. Never one on the way to a path in `keep` (the
// sections you are standing in), which has to be on the canvas.
function foldTest(keep: string[]): FoldTest {
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
const scopeFiles = (): string[] => scope.stack.map(l => l.file).filter((f): f is string => !!f);

// A load's canvas colour LANDS rather than fading in from the board's grey (features/canvas-color.ts
// holdCanvasFade), however long the reads take.
export async function loadFromDir(opts: { keepView?: boolean } = {}): Promise<void> {
  const release = holdCanvasFade();
  try {
    await load(opts);
  } finally {
    release();
  }
}

async function load({ keepView = false }: { keepView?: boolean }): Promise<void> {
  clearHistory();   // ids are minted fresh per load, so no snapshot survives a (re)load / map switch
  // …including the container wrappers, which carry no data-id: a section's clipping wrapper
  // hangs off the NODE object (sectionContentEl), so once state.nodes is
  // cleared nothing can reach the old ones to remove them and they'd pile up in #world on every load.
  state.nodes.clear(); state.toDelete = [];
  resetSaveState();
  foreignDirs.clear();
  foreignDirs.add('attachments/');   // where pasted pictures go, even before the first one has
  world.querySelectorAll('[data-id], .section-content').forEach(e=>e.remove());
  resetImageCache();   // blob URLs from the previous map (or store) are stale now
  await loadBoard();   // edges + ink layer + view prefs for this map (board.json), if any
  refreshGrid();

  // Read every note — except the insides of FOLDED sections, which stay on disk until unfolded.
  // Ids are ephemeral (minted fresh each load) since the path is the real identity.
  state.idSeq = 1;
  const seeds = newSeeds();
  const added = addListed(await store.listTree('', foldTest(scopeFiles())), seeds);
  const byPath = settle(added, seeds);
  resolveEdges(byPath, standInFor);   // the board's edges hold paths too — same index, same drop-if-missing rule
  resolveOrder(byPath);   // …and so does each parent's stored child order
  // A map written before containment: its card-to-card links meant "beside", not "inside". Convert
  // them now that every node has final absolute coordinates to be re-anchored from.
  const flattened = boardIsLegacy() ? flattenLegacyBranches(seeds.wasStack) : 0;
  // …and cards no longer hold cards: any card that still has children becomes a section holding them.
  const folded = foldCardsIntoSections();
  arrangeSections(unplacedSections(added, seeds), seeds.unplaced);
  // Re-point the open-section scope at the freshly minted ids BEFORE the first layout/paint, so a
  // reload that happens while you're inside a section lays out scoped straight away — no flash of the
  // whole map (nav/scope.ts).
  resolveScopeAfterLoad();
  remeasure();   // paint so every card has a real measured height, settle, and paint again
  if (!keepView) {
    fit();
  }
  // A migration is persisted BOARD FIRST, and awaited: the new edges and the model stamp have to be
  // on disk before any note moves into its section's folder, or a failed write between the two would drop the
  // hierarchy AND the edges that replaced it. If the board write throws, the notes are left alone and
  // the map simply migrates again next time — the conversion is a pure function of what's on disk.
  if (flattened && !state.readOnly && store.isOpen) {
    try { await flushBoard(); }
    catch { setStatus('⚠ Could not write board.json — leaving this map as it was.'); return; }
    setStatus(`Converted ${flattened} branch${flattened === 1 ? '' : 'es'} to edges — nothing moved.`);
  }
  if (folded) {
    setStatus(`Turned ${folded} card${folded === 1 ? '' : 's'} with cards inside into section${folded === 1 ? '' : 's'}`);
  }
  // Persist the resolved layout so the saved mm_x/mm_y match what's on screen. Only write when
  // the load actually moved something, so a stable reopen touches no files.
  if (!state.readOnly && [...state.nodes.values()].some(n => n.dirty || n.dirtyLayout)) {
    scheduleSave();
  }
  updateMapTitle();
}
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
    paintNode(n);
  }
  arrangeSections(unplacedSections([f, ...added], seeds), seeds.unplaced);
}
// Sections holding notes that arrived with no saved position — a folder made outside the app, a map
// imported without its board.json, or a note saved into a section's folder from somewhere else (the
// phone INBOX, docs/inbox.md): they get laid out, rather than dropped on a grid at the origin.
function unplacedSections(nodes: MindNode[], seeds: Seeds): MindNode[] {
  return nodes.filter(f => f.type === 'section' && f.lazy == null)
    .filter(f => childrenOf(f.id).some(k => seeds.unplaced.has(k.id)));
}
// Lay each section's cards out ONCE, in a column in their stored order (kidOrder), with the house spacing,
// and size the section around them. Deepest first, so an inner section has its final size before its parent
// stacks it. That needs MEASURED heights, so every affected node is unfolded and painted for the
// duration (scope set aside too: on a reload its ids are still the previous load's, and it would hide
// everything), then folded back exactly as it was.
// With `fresh` (the notes that arrived with no position), a section that ALSO holds placed cards keeps
// them where they are — nothing moves on its own — and its new arrivals stack in a column of their own
// just right of them (or from its top-left corner when it holds nothing yet), the section growing to hold it. That is how a note saved into the Inbox folder from
// the phone shows up (docs/inbox.md).
export function arrangeSections(sections: MindNode[], fresh?: Set<string>): void {
  if (!sections.length) {
    return;
  }
  const unfolded = new Set<MindNode>();
  for (const f of sections) {
    for (const a of [f, ...ancestors(f)]) {
      if (a.collapsed) { a.collapsed = false; unfolded.add(a); }
    }
  }
  const keepScope = scope.rootId; scope.rootId = null;
  for (const n of state.nodes.values()) {
    paintNode(n);
  }
  for (const f of sections.sort((a, b) => ancestorDepth(b) - ancestorDepth(a))) {
    const kids = orderedKids(f, childrenOf(f.id));
    const settled = fresh ? kids.filter(k => !fresh.has(k.id)) : [];
    const right = settled.reduce((r, k) => Math.max(r, k.x + nodeW(k)), -Infinity);
    const x = settled.length ? right + SPACING : f.x + SECTION_BORDER + SPACING;
    let y = settled.length ? Math.min(...settled.map(k => k.y - sectionLabelH(k))) : f.y + SECTION_BORDER + SPACING, w = 0;
    for (const k of settled.length ? kids.filter(k => fresh!.has(k.id)) : kids) {
      y += sectionLabelH(k);   // a section's label hangs above its box — leave it room
      moveSubtreeTo(k, x, y);
      y += nodeH(k) + SPACING;
      w = Math.max(w, nodeW(k));
    }
    const end = snapPt({ x: x + w + SPACING + SECTION_BORDER, y: y + SECTION_BORDER });
    // A section that was already placed (an Inbox you made) only GROWS to hold them; one that arrived
    // with its notes is sized around them.
    const keep = !!fresh && !fresh.has(f.id);
    f.w = Math.max(keep ? f.w ?? 0 : MIN_SECTION_W, end.x - f.x);
    f.h = keep ? Math.max(f.h ?? 0, end.y - f.y) : end.y - f.y;
    f.dirtyLayout = true;
    paintNode(f);
  }
  scope.rootId = keepScope;
  for (const a of unfolded) {
    a.collapsed = true;
  }
}

