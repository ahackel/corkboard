// ============================================================
// Disk I/O orchestration over the active `store` adapter: load the vault into state,
// debounced autosave, import/export .zip, and the focus/visibility reload. Every mutation
// elsewhere calls scheduleSave(); a burst coalesces into one write ~400ms later.
// `store` is the active backend (reassigned by useStore); main holds the open() flows.
// ============================================================
import { state, world, setStatus, isBoxType, type MindNode } from '../core/state.js';
import { parseMd, serializeMd, fileStem } from '../utils/frontmatter.js';
import { safeName, slugStem, desiredFileFor, retargetLinks, FRAME_NOTE, isFrameNote, parentFileOf, dirOf, folderOf } from '../utils/filenames.js';
import { soleImage, bodyImages } from '../utils/markdown.js';
import { zipBlob, unzip } from '../utils/zip.js';
import { downloadBlob } from '../utils/download.js';
import { childrenOf, parentOf, ancestors } from '../utils/model.js';
import { commitRel, orderedKids, moveSubtreeTo, ancestorDepth, frameLabelH } from '../view/layout.js';
import { fit } from '../view/camera.js';
import { resetImageCache } from '../features/images.js';
import { clearHistory } from '../features/history.js';
import { opfsStore, fsaStore, resolveOnDeviceStore, setLastMap, touchMap, createDeviceMap, type Store, type MapKind, type MapRef } from '../store/index.js';
import type { TreeListing } from '../store/types.js';
import type { FoldTest } from '../store/tree.js';
import { paintAll, paintNode, remeasure, flashArrived, selectNode, nodeW, nodeH, snapPt, NODE_W, FRAME_BORDER, MIN_FRAME_W } from '../main.js';
import { updateDocumentTitle } from '../nav/url-state.js';
import { resolveScopeAfterLoad, scope } from '../nav/scope.js';
import { SPACING } from '../utils/guides.js';
import { refreshGrid } from '../view/grid.js';
import { isTypingInField, inPlaceEditActive, frozenFileNodeId } from '../core/ui-state.js';
import { hideStart } from '../boot.js';
import { releaseFolded, readAll } from './lazy.js';
import { byId } from '../utils/dom.js';
import { saveFailed, saveSucceeded } from './save-alert.js';
import { BOARD_FILE, boardJSON, loadBoard, resolveEdges, resolveOrder, boardGeom, flushBoard, scheduleSaveBoard, boardSavePending, boardIsLegacy, makeEdge, unparkEdges } from './board.js';

// Everything that is about the BOARD rather than about a note — the free edges, the ink layer, the
// per-map view prefs — lives in one board.json beside the notes; see data/board.ts, which owns its
// I/O and its own debounce. Only the .md walk in the store filters by extension, so that file is
// invisible to the node model.

// Active backend. Local-first: default to on-device; "Open folder" swaps in fsaStore.
// `ref` identifies WHICH map is now open (registry entry + what boot() reopens); omit it
// for stores that aren't registry-backed.
export let store: Store = opfsStore;
// Which map is on the canvas RIGHT NOW — in-memory runtime state, unlike the persisted
// last-map key (which another tab may rewrite). null for non-registry stores.
export let currentMap: { kind: MapKind; id: string } | null = null;
export function useStore(s: Store, ref?: { kind: MapKind; id: string }): void {
  store = s; store.watch(reloadFromDisk);
  currentMap = ref ?? null;
  if (ref) { setLastMap(ref.kind, ref.id); touchMap(ref.id); }
}

// Retarget the app at another on-device map. settleSave MUST come first — a straggling
// autosave firing after the adapter retargets would write the old map's files into the new one.
export async function switchToDeviceMap(ref: MapRef): Promise<void> {
  await settleSave();
  const s = await resolveOnDeviceStore();
  s.openMap(ref.id, ref.name);
  await s.pick();
  useStore(s, { kind: 'device', id: ref.id });
}

// Open a registry-backed map for URL/history restoration. Device maps can always be reopened;
// local folders only switch when their existing permission grant can be resumed silently.
export async function openMapRef(ref: MapRef): Promise<boolean> {
  if (currentMap?.kind === ref.kind && currentMap.id === ref.id && store.isOpen) return true;
  if (ref.kind === 'device') {
    await switchToDeviceMap(ref);
    await loadFromDir();
    return true;
  }
  await settleSave();
  if (!fsaStore.resume || !(await fsaStore.resume(ref.id))) return false;
  useStore(fsaStore, { kind: 'folder', id: ref.id });
  await loadFromDir();
  return true;
}

// ---- import / export as .zip (move a map between devices / back it up) ----
const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.zip,.md,.markdown,.png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp';
importInput.multiple = true;
importInput.style.display = 'none';
document.body.appendChild(importInput);
importInput.addEventListener('change', async () => {
  const files = [...(importInput.files || [])];
  importInput.value = '';
  if (files.length) await importFiles(files);
});
export function openImportPicker(): void { importInput.click(); }

// The image formats this app takes, BY FILENAME — the one list, shared with features/attachments.ts,
// which needs it for the files an OS drop hands over with no MIME type at all (an .svg dragged out of
// a file manager is the common one).
export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const IMG_RE = IMAGE_FILE_RE;
type ImportEntry = { name: string; text?: string; bytes?: Uint8Array };
export async function importFiles(files: File[]): Promise<void> {
  const entries: ImportEntry[] = [];
  for (const f of files){
    if (/\.zip$/i.test(f.name)) { try { entries.push(...await unzip(await f.arrayBuffer())); } catch { setStatus('That .zip could not be read.'); } }
    else if (/\.(md|markdown)$/i.test(f.name)) entries.push({ name: f.name, text: await f.text() });
    else if (IMG_RE.test(f.name)) entries.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  let md  = entries.filter(e => /\.(md|markdown)$/i.test(e.name) && !e.name.endsWith('/'));
  let img = entries.filter(e => e.bytes && IMG_RE.test(e.name) && !e.name.endsWith('/'));
  if (!md.length){ setStatus('No Markdown files found to import.'); return; }
  // An import always ADDS a new on-device map, never merges into the current one — named
  // after the .zip when there is one.
  const zipBase = files.find(f => /\.zip$/i.test(f.name))?.name.replace(/\.zip$/i, '').trim();
  const ref = await createDeviceMap(await resolveOnDeviceStore(), zipBase || 'Imported map');
  await switchToDeviceMap(ref);
  // strip a single common top-level folder (e.g. a zip of "MyNotes/…") from notes AND attachments,
  // so the relative ![](attachments/…) links still resolve after import — unless that folder is a
  // FRAME of a zip this app wrote (its board.json at the root says so): then it is part of the map.
  const slash = md[0].name.indexOf('/');
  const top = slash >= 0 ? md[0].name.slice(0, slash + 1) : '';
  if (top && md.every(e => e.name.startsWith(top)) && !entries.some(e => e.name === BOARD_FILE)){
    md  = md.map(e => ({ ...e, name: e.name.slice(top.length) }));
    img = img.map(e => e.name.startsWith(top) ? { ...e, name: e.name.slice(top.length) } : e);
  }
  for (const e of md)  await store.write(e.name, e.text ?? '');
  for (const e of img) await store.write(e.name, new Blob([e.bytes! as BlobPart]));
  // carry over the board file if the archive included one (matching the note top-folder strip)
  const board = entries.find(e => e.text != null && (e.name === BOARD_FILE || e.name === top + BOARD_FILE));
  if (board?.text != null) await store.write(BOARD_FILE, board.text);
  hideStart();
  await loadFromDir();
  setStatus(`Imported ${md.length} note${md.length===1?'':'s'}${img.length ? ` + ${img.length} image${img.length===1?'':'s'}` : ''}.`);
}

// download every current note (plus the image attachments they reference) packed into a .zip
export async function exportZip(): Promise<void> {
  await readAll();   // the zip is the WHOLE map, folded frames' notes included
  const nodes = [...state.nodes.values()];
  if (!nodes.length){ setStatus('Nothing to export yet.'); return; }
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
  // Lowercased, because the folder this unpacks into collides case-insensitively on macOS/Windows —
  // same reason desiredFileFor tests that way.
  const used = new Set<string>();
  const files: { name: string; data?: string; bytes?: Uint8Array }[] = nodes.map(n => {
    // A node that has never been saved has no file yet; name it the way desiredFileFor would, off
    // its title or (untitled) off its first line — hence the shared slugStem.
    let name = n.file || (slugStem(n) + '.md');
    while (used.has(name.toLowerCase())) name = name.replace(/(\.md)?$/, '') + '-1.md';
    used.add(name.toLowerCase());
    return { name, data: serializeMd(n) };
  });
  // collect every vault-relative image referenced in a body, and pack the files alongside the notes
  const refs = new Set<string>();
  for (const n of nodes) for (const { src } of bodyImages(n.body)) if (!/^(https?:|data:)/i.test(src)) refs.add(src);
  // read every referenced image concurrently, then pack the ones that resolved
  const images = await Promise.all([...refs].map(async path => {
    const blob = store.readBlob ? await store.readBlob(path) : null;
    return blob ? { name: path, bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
  }));
  const attached = images.filter(Boolean).length;
  for (const img of images) if (img) files.push(img);
  // Always: the board file now carries every node's position and size, so a zip without it would
  // unpack as a pile of notes with no layout.
  files.push({ name: BOARD_FILE, data: boardJSON() });
  const zipName = safeName(store.name || 'corkboard') + '.zip';   // the map's name, not a generic one
  downloadBlob(zipBlob(files), zipName);
  setStatus(`Exported ${nodes.length} notes${attached ? ` + ${attached} image${attached === 1 ? '' : 's'}` : ''} → ${zipName}`);
}

// ---------- reading notes into nodes ----------
// Shared by the load of the whole map and the read of ONE folded frame's folder (readFolder, below):
// both turn listed notes into nodes, take each node's parent off its FOLDER, and settle positions.
//
// How each node's rx/ry was seeded decides how the top-down pass (settle) reads it:
//  · rel    — board.json or the current mm_position_x/y fields: already parent-relative.
//  · legacy — the legacy mm_x/mm_y fields: parent-relative ONLY for frame children (the old
//    behaviour), otherwise ABSOLUTE — converted to relative in the top-down pass.
//  · neither — a grid fallback (absolute), likewise converted; and `unplaced`, so a frame whose notes
//    ALL lack a position lays them out once (arrangeFrames).
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
  if (w == null) return undefined;
  if (isBoxType(type) || isImage) return w;
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
  if (unmigrated) rest.title = fileStem(rel);
  // A folder's frame note IS a frame, whatever its frontmatter says (or doesn't).
  const type: MindNode['type'] = isFrameNote(rel) ? 'frame' : mm.type;
  // The PARENT is the folder the note sits in (utils/filenames.ts parentFileOf). Only a note at the top
  // level can still name one in `mm_parent` — a map from before frames were folders — and that note is
  // marked dirty: the save that follows moves it into its frame's folder and drops the key.
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
    ...rest, dirty: unmigrated || !!mm.parent, dirtyLayout: !hasPos,   // notes lacking a position get one persisted
  };
  if (mm.wasStack) seeds.wasStack.add(node.id);
  if (hasRel) seeds.rel.add(node.id);
  else if (hasLegacy) seeds.legacy.add(node.id);
  else { seeds.placed++; seeds.unplaced.add(node.id); }   // no saved position → fallback layout
  return node;
}
// A folder with notes in it but no frame note of its own — one made outside the app, in Finder or
// Obsidian — is a frame all the same, named after the folder. Its frame note is written by the next
// save (dirty), so from then on it is an ordinary frame.
function folderFrame(path: string, seeds: Seeds): MindNode {
  const d = dirOf(path).slice(0, -1);
  const n = nodeFromNote(path, parseMd(`# ${d.slice(d.lastIndexOf('/') + 1)}\n`), seeds);
  n.dirty = true;
  return n;
}
// Add every node a listing yields: its notes, a frame for each folder that lacks one, and the FOLDED
// frames whose notes stayed unread (`lazy`, with how many there are). Returns the nodes added.
function addListed(listing: TreeListing, seeds: Seeds): MindNode[] {
  for (const d of listing.foreign) foreignDirs.add(d);
  const known = new Set([...state.nodes.values()].map(n => n.file));
  const added: MindNode[] = [];
  const add = (n: MindNode): void => { state.nodes.set(n.id, n); known.add(n.file); added.push(n); };
  for (const { path, text } of listing.files) if (!known.has(path)) add(nodeFromNote(path, parseMd(text), seeds));
  for (const [dir, f] of listing.lazy) {
    const path = dir + FRAME_NOTE;
    let n = [...state.nodes.values()].find(m => m.file?.toLowerCase() === path.toLowerCase());
    if (!n) add(n = folderFrame(path, seeds));
    n.lazy = f.count;
    n.collapsed = true;   // a folder nobody has unfolded yet arrives as its pill
  }
  // Frames for the folders that have notes but no frame note — outermost last, since each one asks
  // for its own parent folder's frame in turn.
  for (let i = 0; i < added.length; i++) {
    const want = added[i]._parentPath;
    if (!want || !parentFileOf(added[i].file!) || known.has(want)) continue;
    add(folderFrame(want, seeds));
  }
  return added;
}
// Resolve each new node's parent path -> a loaded node's id (drops links to missing files), then settle
// every rx/ry to parent-relative and derive the working x/y — top-down, so a parent's absolute x/y is
// final by the time its children are reached. rel seeds and legacy frame children are already
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
    const alreadyRel = seeds.rel.has(n.id) || (seeds.legacy.has(n.id) && !!p && p.type === 'frame');
    if (p && !alreadyRel) { n.rx -= pax; n.ry -= pay; }   // absolute seed → parent-relative
    n.x = pax + n.rx; n.y = pay + n.ry;                   // working absolute coords
    for (const k of kidsOf.get(n.id) ?? []) stack.push(k);
  }
  return byPath;
}
// The frame an unread note sits in, for a line that ends on it: the deepest folded frame in memory
// whose folder holds the path (data/board.ts resolveEdges).
function standInFor(path: string): string | null {
  let best: MindNode | null = null;
  for (const n of state.nodes.values())
    if (n.lazy != null && n.file && path.startsWith(dirOf(n.file)) && (!best || n.file.length > best.file!.length)) best = n;
  return best?.id ?? null;
}
// Which folders a read leaves UNREAD (store/tree.ts): a frame folded in board.json, and a folder the
// board has never seen — it arrives as a folded pill. Never one on the way to a path in `keep` (the
// frames you are standing in), which has to be on the canvas.
function foldTest(keep: string[]): FoldTest {
  return (dir) => {
    if (keep.some(k => k.startsWith(dir))) return false;
    const g = boardGeom(dir + FRAME_NOTE);
    return g ? !!g.collapsed : true;
  };
}
// Folders on disk that are NOT frames (`attachments/`, …), lowercased: a frame may not move into one.
let foreignDirs = new Set<string>();
const scopeFiles = (): string[] => scope.stack.map(l => l.file).filter((f): f is string => !!f);

export async function loadFromDir({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  clearHistory();   // ids are minted fresh per load, so no snapshot survives a (re)load / map switch
  // …including the container wrappers, which carry no data-id: a frame's clipping wrapper
  // hangs off the NODE object (frameContentEl), so once state.nodes is
  // cleared nothing can reach the old ones to remove them and they'd pile up in #world on every load.
  state.nodes.clear(); state.toDelete = []; pendingRemovals.clear(); emptied.clear();
  foreignDirs = new Set(['attachments/']);   // where pasted pictures go, even before the first one has
  world.querySelectorAll('[data-id], .frame-content').forEach(e=>e.remove());
  resetImageCache();   // blob URLs from the previous map (or store) are stale now
  await loadBoard();   // edges + ink layer + view prefs for this map (board.json), if any
  refreshGrid();

  // Read every note — except the insides of FOLDED frames, which stay on disk until unfolded.
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
  // …and cards no longer hold cards: any card that still has children becomes a frame holding them.
  const folded = foldCardsIntoFrames();
  arrangeFrames(unplacedFrames(added, seeds), seeds.unplaced);
  // Re-point the open-frame scope at the freshly minted ids BEFORE the first layout/paint, so a
  // reload that happens while you're inside a frame lays out scoped straight away — no flash of the
  // whole map (nav/scope.ts).
  resolveScopeAfterLoad();
  remeasure();   // paint so every card has a real measured height, settle, and paint again
  if (!keepView) fit();
  // A migration is persisted BOARD FIRST, and awaited: the new edges and the model stamp have to be
  // on disk before any note moves into its frame's folder, or a failed write between the two would drop the
  // hierarchy AND the edges that replaced it. If the board write throws, the notes are left alone and
  // the map simply migrates again next time — the conversion is a pure function of what's on disk.
  if (flattened && !state.readOnly && store.isOpen) {
    try { await flushBoard(); }
    catch { setStatus('⚠ Could not write board.json — leaving this map as it was.'); return; }
    setStatus(`Converted ${flattened} branch${flattened === 1 ? '' : 'es'} to edges — nothing moved.`);
  }
  if (folded) setStatus(`Turned ${folded} card${folded === 1 ? '' : 's'} with cards inside into frame${folded === 1 ? '' : 's'}`);
  // Persist the resolved layout so the saved mm_x/mm_y match what's on screen. Only write when
  // the load actually moved something, so a stable reopen touches no files.
  if (!state.readOnly && [...state.nodes.values()].some(n => n.dirty || n.dirtyLayout))
    scheduleSave();
  updateMapTitle();
}
// Read the notes of ONE folded frame's folder into memory (data/lazy.ts decides when). `deep` reads
// everything under it; otherwise the frames folded INSIDE it stay unread in turn, like on a load.
// Nothing is painted or laid out here — the caller unfolds, opens or moves what it read.
// Two asks for the same folder at once (a double-click, a save) share ONE read.
const reading = new Map<string, Promise<void>>();
export function readFolder(f: MindNode, deep: boolean): Promise<void> {
  const busy = reading.get(f.id);
  if (busy) return busy;
  const p = readFolderNow(f, deep).finally(() => reading.delete(f.id));
  reading.set(f.id, p);
  return p;
}
async function readFolderNow(f: MindNode, deep: boolean): Promise<void> {
  if (f.lazy == null || !f.file || !store.isOpen) return;
  const listing = await store.listTree(dirOf(f.file), deep ? () => false : foldTest(scopeFiles()));
  if (f.lazy == null || !state.nodes.has(f.id)) return;   // read twice at once, or gone meanwhile
  f.lazy = undefined;
  const seeds = newSeeds();
  const added = addListed(listing, seeds);
  const byPath = settle(added, seeds);
  unparkEdges(byPath);
  resolveOrder(byPath);
  // Paint what was read, so the arrangement below can measure it (it is hidden under its folded frame
  // anyway until the caller unfolds that).
  for (const n of added) paintNode(n);
  arrangeFrames(unplacedFrames([f, ...added], seeds), seeds.unplaced);
}
// Frames holding notes that arrived with no saved position — a folder made outside the app, a map
// imported without its board.json, or a note saved into a frame's folder from somewhere else (the
// phone INBOX, docs/inbox.md): they get laid out, rather than dropped on a grid at the origin.
function unplacedFrames(nodes: MindNode[], seeds: Seeds): MindNode[] {
  return nodes.filter(f => f.type === 'frame' && f.lazy == null)
    .filter(f => childrenOf(f.id).some(k => seeds.unplaced.has(k.id)));
}
// ---------- cards that hold cards become frames (runs on every load; a no-op once done) ----------
// A card used to OUTLINE its children inside its own box — rows, indented by depth, with checklist
// ticks. That model is gone (docs/PRODUCT.md: cards are flat, frames are the only container), so a
// card that still has children on disk opens as a FRAME holding them: its title is the frame's tab,
// its note the frame's description, its children cards inside it. Nothing is lost or re-parented —
// only `mm_type` changes, on the card itself.
// Where its children SIT has to be decided, though: their saved positions were the outliner's rows,
// laid out by the app, and a frame shows its children where they are. So each converted frame — and
// any frame that was itself drawn as a row inside one — lays its cards out ONCE, in a column in their
// old order (kidOrder), with the house spacing, and sizes itself around them. Deepest first, so an
// inner frame has its final size before its parent stacks it. That needs MEASURED heights, so every
// affected node is unfolded and painted for the duration (scope set aside too: on a reload its ids
// are still the previous load's, and it would hide everything), then folded back exactly as it was.
// Pure function of what's on disk, so a failed save simply migrates again next time.
function foldCardsIntoFrames(): number {
  const cards = [...state.nodes.values()].filter(n => n.type === 'card' && childrenOf(n.id).length);
  if (!cards.length) return 0;
  const was = new Set(cards.map(n => n.id));
  const arrange = [...state.nodes.values()].filter(n => childrenOf(n.id).length
    && (was.has(n.id) || [...ancestors(n)].some(a => was.has(a.id))));
  for (const n of cards) { n.type = 'frame'; n.dirty = true; n.dirtyLayout = true; }
  arrangeFrames(arrange);
  return cards.length;
}
// Lay each frame's cards out ONCE, in a column in their stored order (kidOrder), with the house spacing,
// and size the frame around them. Deepest first, so an inner frame has its final size before its parent
// stacks it. That needs MEASURED heights, so every affected node is unfolded and painted for the
// duration (scope set aside too: on a reload its ids are still the previous load's, and it would hide
// everything), then folded back exactly as it was.
// With `fresh` (the notes that arrived with no position), a frame that ALSO holds placed cards keeps
// them where they are — nothing moves on its own — and its new arrivals stack in a column of their own
// just right of them (or from its top-left corner when it holds nothing yet), the frame growing to hold it. That is how a note saved into the Inbox folder from
// the phone shows up (docs/inbox.md).
function arrangeFrames(frames: MindNode[], fresh?: Set<string>): void {
  if (!frames.length) return;
  const unfolded = new Set<MindNode>();
  for (const f of frames) for (const a of [f, ...ancestors(f)]) if (a.collapsed) { a.collapsed = false; unfolded.add(a); }
  const keepScope = scope.rootId; scope.rootId = null;
  for (const n of state.nodes.values()) paintNode(n);
  for (const f of frames.sort((a, b) => ancestorDepth(b) - ancestorDepth(a))) {
    const kids = orderedKids(f, childrenOf(f.id));
    const settled = fresh ? kids.filter(k => !fresh.has(k.id)) : [];
    const right = settled.reduce((r, k) => Math.max(r, k.x + nodeW(k)), -Infinity);
    const x = settled.length ? right + SPACING : f.x + FRAME_BORDER + SPACING;
    let y = settled.length ? Math.min(...settled.map(k => k.y - frameLabelH(k))) : f.y + FRAME_BORDER + SPACING, w = 0;
    for (const k of settled.length ? kids.filter(k => fresh!.has(k.id)) : kids) {
      y += frameLabelH(k);   // a frame's label hangs above its box — leave it room
      moveSubtreeTo(k, x, y);
      y += nodeH(k) + SPACING;
      w = Math.max(w, nodeW(k));
    }
    const end = snapPt({ x: x + w + SPACING + FRAME_BORDER, y: y + FRAME_BORDER });
    // A frame that was already placed (an Inbox you made) only GROWS to hold them; one that arrived
    // with its notes is sized around them.
    const keep = !!fresh && !fresh.has(f.id);
    f.w = Math.max(keep ? f.w ?? 0 : MIN_FRAME_W, end.x - f.x);
    f.h = keep ? Math.max(f.h ?? 0, end.y - f.y) : end.y - f.y;
    f.dirtyLayout = true;
    paintNode(f);
  }
  scope.rootId = keepScope;
  for (const a of unfolded) a.collapsed = true;
}

// ---------- the containment migration (runs once per map) ----------
// A map written before containment (board.json missing, or its `model` below BOARD_MODEL) holds
// card-to-card `mm_parent` links that meant "this card sits BESIDE that one, joined by a branch
// line". Under containment the same link means "inside it, as an outline row" — so loading such a
// map unchanged would re-flow it into nested boxes and nothing would be where the user left it.
//
// So convert instead: each of those children becomes a TOP-LEVEL card at the absolute position it
// already renders at, and the branch it used to have becomes a drawn edge. The map looks IDENTICAL
// on first open; what it loses is collapse on those groups, which the user gets back deliberately by
// nesting a group again. See docs/spec-edges-and-containment.md.
//
// Four things are deliberately NOT flattened, each because flattening it would CHANGE what you see:
//   · a child of a legacy STACK (or of anything inside one) — it was already drawn inside its parent.
//   · a child of a FRAME — the frame is a container in both models, and pulling its contents out
//     would empty the box. A card flattened out of a branch INSIDE a frame re-anchors to that frame,
//     not to the world, for the same reason.
//   · anything under a COLLAPSED ancestor — those children are invisible right now, and making them
//     top-level would pop the whole hidden subtree onto the canvas. Left nested, a collapsed branch
//     looks exactly as it did, and expanding it simply reveals the new outline.
// Returns how many branches were converted.
function flattenLegacyBranches(wasStack: Set<string>): number {
  // Which nodes were OUTLINED by a legacy stack — the old insideStack, read off `wasStack` because
  // the kind itself has already folded to `card` by now (utils/frontmatter.ts foldTypeLayout).
  const outlined = new Set<string>();
  const wasOutlined = (n: MindNode): boolean => {
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (wasStack.has(p.id)) return true;
      if (p.type !== 'card' && p.type !== 'frame') return false;
    }
    return false;
  };
  for (const n of state.nodes.values()) if (wasOutlined(n)) outlined.add(n.id);
  const collapsedAbove = (n: MindNode): boolean => {
    for (let p = parentOf(n); p; p = parentOf(p)) if (p.collapsed) return true;
    return false;
  };
  // The container this card should belong to once its branch is cut: the nearest FRAME above it, or
  // the world. Never a card — that is the whole point of the migration.
  const containerAbove = (n: MindNode): MindNode | null => {
    for (let p = parentOf(n); p; p = parentOf(p)) if (p.type === 'frame') return p;
    return null;
  };
  let made = 0;
  for (const n of [...state.nodes.values()]) {
    const p = parentOf(n);
    if (!p || p.type !== 'card') continue;          // roots, and frame children, stay as they are
    if (outlined.has(n.id) || collapsedAbove(n)) continue;
    const host = containerAbove(n);
    n.parent = host ? host.id : null;
    // x/y are already absolute and final; re-derive the stored offset against the NEW anchor so the
    // card writes back exactly where it renders.
    n.rx = n.x - (host ? host.x : 0);
    n.ry = n.y - (host ? host.y : 0);
    n.dirty = true; n.dirtyLayout = true;
    state.edges.push(makeEdge(p.id, n.id));
    made++;
  }
  return made;
}
// Show the open map's name in the home button (:empty hides it until loaded) + the tab title.
export function updateMapTitle(): void {
  byId('folderName').textContent = store.name;
  updateDocumentTitle();
}
// The lowercased filename -> node index the collision test reads. Built ONCE per save rather than
// re-derived per candidate name: saveAll asks for every node's desired name, so a per-call
// `[...state.nodes.values()].some(…)` made settling filenames O(n²) with two string allocations per
// comparison. Lowercased because that is how the filesystem collides (see below).
function filesInUse(): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of state.nodes.values()) if (o.file) m.set(o.file.toLowerCase(), o.id);
  return m;
}
// Re-point inbound [[wikilinks]] across every note (utils/filenames.ts retargetLinks), returning the
// ids whose body changed, for phase 2 to write.
function retargetWikilinks(renames: Map<string, string>): string[] {
  if (!renames.size) return [];
  const touched: string[] = [];
  for (const n of state.nodes.values()) {
    const body = retargetLinks(n.body, renames);
    if (body === n.body) continue;
    n.body = body; n.dirty = true; touched.push(n.id);
  }
  return touched;
}
// Where every node's file SHOULD be, settled top-down: a node's folder is its parent frame's folder, so
// a parent's final path has to be known before its children's (utils/filenames.ts desiredFileFor).
// Pure — nothing is renamed here; saveAll adopts the result.
function planPaths(): Map<string, string> {
  const out = new Map<string, string>();
  // Kept in step below, so a name this loop has already handed out is seen as taken by the nodes after it.
  const inUse = filesInUse();
  for (const n of [...state.nodes.values()].sort((a, b) => ancestorDepth(a) - ancestorDepth(b))) {
    // While the title is being typed (in-card rename OR the editor sheet), keep the current
    // filename (rename happens when the edit session commits).
    const frozen = frozenFileNodeId() === n.id ? n.file : null;
    const p = parentOf(n);
    const pFile = p ? out.get(p.id) ?? p.file : null;
    const target = frozen ?? desiredFileFor(n, inUse, pFile ? folderOf(pFile) : '', foreignDirs);
    if (n.file) inUse.delete(n.file.toLowerCase());
    inUse.set(target.toLowerCase(), n.id);
    out.set(n.id, target);
  }
  return out;
}
export async function saveAll(): Promise<void> {
  if (state.readOnly) return;        // read-only mode never writes to disk
  if (!store.isOpen) { setStatus('Open a folder first.'); return; }
  // Phase 0 — a FOLDED frame whose notes were never read can't move them without reading them: one
  // that is about to move (renamed, retyped, dropped into another frame, or inside one that is) reads
  // its whole folder first, and one that somehow holds a note in memory reads its own level, so the
  // rest of the save sees a complete tree under every path it changes (data/lazy.ts).
  for (let guard = 0; guard < 16; guard++) {
    const plan = planPaths();
    const moving = [...state.nodes.values()].filter(n => n.lazy != null && n.file && plan.get(n.id) !== n.file);
    const holding = [...state.nodes.values()].filter(n => n.lazy != null && childrenOf(n.id).length);
    if (!moving.length && !holding.length) break;
    for (const f of moving) await readFolder(f, true);
    for (const f of holding) await readFolder(f, false);
  }
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
  // Each step below records its progress AS it lands, so a save that throws half-way (quota, a revoked
  // folder permission) leaves exactly the unfinished part pending, and the retry (data/save-alert.ts)
  // picks it up — rather than a renamed note's old file surviving it.
  while (state.toDelete.length) { const gone = state.toDelete[0]; await store.remove(gone); emptied.add(dirOf(gone)); state.toDelete.shift(); }

  // CONTENT changes rewrite the note; GEOMETRY changes don't — position, size, collapse and child
  // order live in board.json now, so `dirtyLayout` alone is not a reason to touch a .md. Moving a
  // card therefore writes one small JSON file instead of one .md per moved card.
  const needWrite = new Set<string>();
  for (const n of state.nodes.values()) if (n.dirty || !n.file) needWrite.add(n.id);

  // Phase 1 — settle every note's final path IN MEMORY first (planPaths). A frame is a folder, so a
  // renamed or moved frame moves every note inside it: each one is a rename of its own here.
  const renames = new Map<string, string>();   // old path -> new path, for the wikilink fixup below
  let pathsMoved = false;   // board.json is keyed by path, so a new or renamed note needs it rewritten
  const plan = planPaths();
  for (const n of state.nodes.values()) {
    const target = plan.get(n.id)!;
    if (n.file && n.file !== target) {
      pendingRemovals.add(n.file);                 // old file to delete once the rename is written
      renames.set(n.file, target);
    }
    if (n.file !== target) { needWrite.add(n.id); pathsMoved = true; }   // brand-new node, or a rename
    n.file = target;                               // adopt the final name
  }

  // Phase 1b — a rename drags its INBOUND links along: a path recorded elsewhere in the vault must not
  // outlive the path it records.
  for (const id of retargetWikilinks(renames)) needWrite.add(id);
  // Everything phase 1 decided must be written is now DIRTY, not just in this call's set: n.file has
  // already moved to its new name, so a retry would see no rename and forget it had to write it.
  for (const id of needWrite) state.nodes.get(id)!.dirty = true;

  // Phase 2 — write everything that changed, now that all paths are final.
  let written = 0;
  for (const n of state.nodes.values()) {
    if (!needWrite.has(n.id)) continue;
    await store.write(n.file!, serializeMd(n));
    n.dirty = false;
    written++;
  }
  // Phase 3 — drop files left behind by renames (unless some node now legitimately holds the path)…
  const held = new Set([...state.nodes.values()].map(n => n.file));
  for (const old of [...pendingRemovals]) {
    if (!held.has(old)) { await store.remove(old); emptied.add(dirOf(old)); }
    pendingRemovals.delete(old);
  }
  // …and the FOLDERS they leave empty: a frame renamed, moved or deleted leaves its old folder behind.
  // Deepest first, and up the chain, since emptying `A/B/` can empty `A/` too. removeDir only ever
  // removes an EMPTY folder, so one still holding anything — a live note, another app's file — stays.
  const live = new Set<string>();
  for (const f of held) if (f) for (let d = dirOf(f); d; d = dirOf(d.slice(0, -1))) live.add(d);
  const dirs = new Set<string>();
  for (const d0 of emptied) for (let d = d0; d; d = dirOf(d.slice(0, -1))) dirs.add(d);
  emptied.clear();
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) if (!live.has(d)) await store.removeDir(d);

  // …and the board follows, AWAITED: it is keyed by path, so after a move it must land before anything
  // else does — a reload in between would find the notes in their new folders and no layout for them.
  if (pathsMoved) await flushBoard();
  for (const n of state.nodes.values()) n.dirtyLayout = false;   // the board write carries these
  state.lastSelfWrite = Date.now();   // so focus-reload can ignore our own writes
  paintAll();
  setStatus(`Saved ${written} file${written===1?'':'s'} · ` + new Date().toLocaleTimeString());
  releaseFolded();   // a folded frame whose notes are all safely on disk can let go of them (data/lazy.ts)
}

// Old paths of renamed notes, still on disk until phase 3 removes them. Module-level so a failed save
// carries them to its retry; cleared by loadFromDir, since they belong to the map that was open.
const pendingRemovals = new Set<string>();
// Folders a removal may have left empty, for phase 3 to prune. Module-level for the same reason.
const emptied = new Set<string>();

// ---------- autosave (debounced) ----------
let saveTimer: number | undefined, saveAgain = false;
let savePromise: Promise<void> | null = null;   // non-null while a save chain is in flight
export function scheduleSave(): void {
  if (state.readOnly) return;         // read-only mode never writes to disk
  if (!store.isOpen) return;          // demo mode: nothing to write
  // Geometry lives in board.json, so the two files settle together: every mutation path in the app
  // ends in scheduleSave(), and a great many of them move something.
  scheduleSaveBoard();
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}
export function flushSave(): Promise<void> {
  if (!store.isOpen) return Promise.resolve();
  clearTimeout(saveTimer); saveTimer = undefined;
  if (savePromise) { saveAgain = true; return savePromise; }   // coalesce overlapping writes
  savePromise = (async () => {
    try {
      await saveAll();
      saveSucceeded('notes');
    } catch (err) {
      saveFailed('notes', err, () => { void flushSave(); });
    }
    savePromise = null;
    if (saveAgain) { saveAgain = false; await flushSave(); }
  })();
  return savePromise;
}
// Write out everything still pending (debounced or in flight, notes AND board.json), awaiting
// completion. MUST be called before retargeting the store at another map/folder — a straggling
// autosave firing after the switch would write the old map's files into the new one.
export async function settleSave(): Promise<void> {
  if (boardSavePending()) await flushBoard();
  if (saveTimer != null || savePromise || notesUnsaved()) await flushSave();
}
// Is there anything in memory the disk doesn't have yet — queued, in flight, or left over by a write
// that failed? Read-only and demo mode never write, so they never have anything unsaved.
function notesUnsaved(): boolean {
  if (state.readOnly || !store.isOpen) return false;
  if (state.toDelete.length || pendingRemovals.size) return true;
  for (const n of state.nodes.values()) if (n.dirty || !n.file) return true;
  return false;
}
export function hasUnsavedChanges(): boolean {
  if (state.readOnly || !store.isOpen) return false;
  return saveTimer != null || savePromise != null || boardSavePending() || notesUnsaved();
}

// ---------- never lose the last edit to a closing tab ----------
// The autosave waits 400ms for a burst to settle, so an edit made just before the tab is hidden,
// closed or reloaded would otherwise die with it. Hiding is the dependable signal (it fires before
// unload, and is the LAST one iOS gives a backgrounded page); beforeunload also asks the browser to
// hold the page while anything is still unwritten.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void settleSave(); });
window.addEventListener('pagehide', () => { void settleSave(); });
window.addEventListener('beforeunload', e => {
  if (!hasUnsavedChanges()) return;
  void settleSave();
  e.preventDefault();
});

// ---------- reload on focus ----------
let reloading = false;
export async function reloadFromDisk(): Promise<void> {
  if (!store.isOpen) return;
  // A single refocus dispatches BOTH window 'focus' and 'visibilitychange'. Guard re-entry.
  if (reloading) return;
  // if we just wrote, the focus event is almost certainly our own round-trip — skip
  if (Date.now() - (state.lastSelfWrite || 0) < 600) return;
  const selBefore = state.selId;
  // Don't yank the rug out while the user is actively typing in a card or renaming a frame.
  if (inPlaceEditActive() || isTypingInField()) return;
  reloading = true;
  try {
    // loadFromDir REPLACES every note with what's on disk, so whatever is still queued must reach the
    // disk first — this used to cancel the pending save instead, and an edit made just before
    // switching away was read over. If a write fails, memory holds the only copy: keep it, don't reload.
    await settleSave();
    if (hasUnsavedChanges()) return;
    if (inPlaceEditActive() || isTypingInField()) return;   // began during the write
    // What was there before, by PATH (ids are minted fresh each load) — and how many unread notes each
    // folded frame held — so a note that came in from outside (the phone inbox) can be pointed out.
    const known = new Set<string>(), unread = new Map<string, number>();
    for (const n of state.nodes.values()) if (n.file) { known.add(n.file); if (n.lazy != null) unread.set(n.file, n.lazy); }
    await loadFromDir({ keepView:true });
    if (selBefore && state.nodes.has(selBefore)) selectNode(selBefore);
    else selectNode(null);
    flashArrived([...state.nodes.values()]
      .filter(n => n.file && (!known.has(n.file) || (n.lazy ?? 0) > (unread.get(n.file) ?? n.lazy ?? 0)))
      .map(n => n.id));
  } finally {
    reloading = false;
  }
}
store.watch(reloadFromDisk);   // re-read on external change (FSA: window-focus / tab-visible)
