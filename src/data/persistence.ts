// ============================================================
// Disk I/O orchestration over the active `store` adapter: load the vault into state,
// debounced autosave, import/export .zip, and the focus/visibility reload. Every mutation
// elsewhere calls scheduleSave(); a burst coalesces into one write ~400ms later.
// `store` is the active backend (reassigned by useStore); main holds the open() flows.
// ============================================================
import { state, world, setStatus, isBoxType, type MindNode } from '../core/state.js';
import { parseMd, serializeMd, fileStem } from '../utils/frontmatter.js';
import { safeName, slugStem, desiredFileFor, retargetLinks } from '../utils/filenames.js';
import { soleImage } from '../utils/markdown.js';
import { zipBlob, unzip } from '../utils/zip.js';
import { downloadBlob } from '../utils/download.js';
import { childrenOf, parentOf, ancestors } from '../utils/model.js';
import { applyLayouts, collapseAtDepth, commitRel, orderedKids, moveSubtreeTo, frameInsetY, ancestorDepth } from '../view/layout.js';
import { fit } from '../view/camera.js';
import { resetImageCache } from '../features/images.js';
import { clearHistory } from '../features/history.js';
import { opfsStore, fsaStore, resolveOnDeviceStore, seenFolders, markFolderSeen, setLastMap, touchMap, createDeviceMap, type Store, type MapKind, type MapRef } from '../store/index.js';
import { paintAll, paintNode, selectNode, nodeW, nodeH, snapPt, NODE_W, FRAME_BORDER, MIN_FRAME_W } from '../main.js';
import { updateDocumentTitle } from '../nav/url-state.js';
import { resolveScopeAfterLoad, scope } from '../nav/scope.js';
import { SPACING } from '../utils/guides.js';
import { refreshGrid } from '../view/grid.js';
import { isTypingInField, editSessionActive, frozenFileNodeId } from '../core/ui-state.js';
import { hideStart } from '../boot.js';
import { byId } from '../utils/dom.js';
import { saveFailed, saveSucceeded } from './save-alert.js';
import { BOARD_FILE, boardJSON, loadBoard, resolveEdges, resolveOrder, boardGeom, flushBoard, scheduleSaveBoard, boardSavePending, boardIsLegacy, makeEdge } from './board.js';

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
  // so the relative ![](attachments/…) links still resolve after import
  const slash = md[0].name.indexOf('/');
  const top = slash >= 0 ? md[0].name.slice(0, slash + 1) : '';
  if (top && md.every(e => e.name.startsWith(top))){
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
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const n of nodes){ let m: RegExpExecArray | null; const b = n.body || ''; while ((m = re.exec(b))){ const p = m[1]; if (!/^(https?:|data:)/i.test(p)) refs.add(p); } }
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

export async function loadFromDir({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  clearHistory();   // ids are minted fresh per load, so no snapshot survives a (re)load / map switch
  // …including the container wrappers, which carry no data-id: a frame's clipping wrapper
  // hangs off the NODE object (frameContentEl), so once state.nodes is
  // cleared nothing can reach the old ones to remove them and they'd pile up in #world on every load.
  state.nodes.clear(); state.toDelete = []; pendingRemovals.clear();
  world.querySelectorAll('[data-id], .frame-content').forEach(e=>e.remove());
  resetImageCache();   // blob URLs from the previous map (or store) are stale now
  await loadBoard();   // edges + ink layer + view prefs for this map (board.json), if any
  refreshGrid();

  // First pass: read every .md and parse it (layout now lives in each note's frontmatter).
  const entries: { rel: string; parsed: ReturnType<typeof parseMd> }[] = [];
  for (const { path, text } of await store.list())
    entries.push({ rel: path, parsed: parseMd(text) });

  // Ids are ephemeral (minted fresh each load) since the filename is the real identity —
  // parent links are stored/resolved BY PATH, so ids never need to survive a reload.
  let seq = 0;
  let placed = 0;          // count of notes lacking a saved position, for fallback layout
  // Seed each node's rx/ry from disk; the top-down pass below settles them to parent-relative and
  // derives the working x/y. The raw seed's frame of reference depends on the fields present:
  //  · relSeed  — the current mm_position_x/y fields: already parent-relative (roots world-relative).
  //  · legacySeed — the legacy mm_x/mm_y fields: parent-relative ONLY for frame children (the old
  //    behaviour), otherwise ABSOLUTE — converted to relative in the top-down pass below.
  //  · neither — a grid fallback (absolute), likewise converted below.
  // TODO: legacySeed is a transitional migration shim — it can go once every map has been re-saved
  // (serializeMd only re-emits mm_position_*, so the first save of any note drops its mm_x/mm_y).
  const relSeed = new Set<string>();
  const legacySeed = new Set<string>();
  const wasStack = new Set<string>();   // notes that carried the legacy stack kind (flattenLegacyBranches)
  // mm_w is now written for every kind (an authored width), but it USED to be written ungated for a
  // while before the box-kinds-only gate landed — so an old, not-since-re-saved note can carry a stale
  // width from a time when `n.w` also held derived values (an outline row's stretched width, for
  // one). Those are all NARROWER than a normal card, and a card can only ever be widened past
  // its default, so anything under the default is junk from that era: drop it. One kind of note
  // legitimately goes narrower and is exempt: an IMAGE card — a small picture is a small card, and one
  // that used to carry `mm_type: image` now loads as an ordinary card (foldTypeLayout), so without
  // this its authored size would be read as junk from that era and thrown away.
  const authoredW = (w: number | null | undefined, type: MindNode['type'], isImage: boolean): number | undefined => {
    if (w == null) return undefined;
    if (isBoxType(type) || isImage) return w;
    return w >= NODE_W ? w : undefined;
  };
  for (const { rel, parsed } of entries) {
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
    // GEOMETRY comes from board.json first (data/board.ts) and falls back to the note's own mm_*
    // for a vault written before it moved. Same meaning either way — an offset from the parent —
    // so the top-down pass below doesn't care which supplied it.
    const g = boardGeom(rel);
    const hasBoard = (g?.x != null && g?.y != null);
    const hasRel = hasBoard || (mm.px != null && mm.py != null);
    const hasLegacy = (mm.x != null && mm.y != null);
    const hasPos = hasRel || hasLegacy;
    const node: MindNode = {
      id: 'n' + (++seq), file:rel, x: 0, y: 0,   // x/y derived from rx/ry in the top-down pass below
      rx: hasBoard ? g!.x! : (mm.px != null && mm.py != null) ? mm.px! : hasLegacy ? mm.x! : (120 + (placed % 4) * 240),
      ry: hasBoard ? g!.y! : (mm.px != null && mm.py != null) ? mm.py! : hasLegacy ? mm.y! : (120 + Math.floor(placed / 4) * 200),
      _parentPath: mm.parent || '',                // resolved to an id once all notes are loaded
      parent: null,
      collapsed: g ? !!g.collapsed : !!mm.collapsed,
      locked: !!mm.locked,
      type: mm.type,
      // authoredW's junk-width filter is for the FRONTMATTER value only — a width in board.json was
      // written by this build and means exactly what it says.
      w: g?.w ?? authoredW(mm.w, mm.type, imageOnly),
      h: g?.h ?? mm.h ?? undefined,
      ...rest, dirty:unmigrated, dirtyLayout: !hasPos,   // notes lacking a position get one persisted
    };
    if (mm.wasStack) wasStack.add(node.id);
    if (hasRel) relSeed.add(node.id);
    else if (hasLegacy) legacySeed.add(node.id);
    else placed++;                                  // no saved position → fallback layout
    state.nodes.set(node.id, node);
  }
  // Resolve each note's parent path -> the loaded node's id (drops links to missing files).
  const byPath = new Map([...state.nodes.values()].map(n => [n.file, n.id]));
  for (const n of state.nodes.values()) {
    n.parent = n._parentPath ? (byPath.get(n._parentPath) || null) : null;
    delete n._parentPath;
  }
  resolveEdges(byPath);   // the board's edges hold paths too — same index, same drop-if-missing rule
  resolveOrder(byPath);   // …and so does each parent's stored child order
  // Settle every rx/ry to parent-relative and derive the working x/y, in one top-down pass so the
  // parent's absolute x/y is already final when we reach a child. relSeed and legacy frame children
  // are already relative; the rest hold an ABSOLUTE seed, so subtract the parent's position.
  const kidsOf = new Map<string | null, MindNode[]>();
  for (const n of state.nodes.values()) { const k = kidsOf.get(n.parent) ?? []; k.push(n); kidsOf.set(n.parent, k); }
  const stack = [...(kidsOf.get(null) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    const p = parentOf(n);
    const pax = p ? p.x : 0, pay = p ? p.y : 0;   // final (parents are visited before their children)
    const alreadyRel = relSeed.has(n.id) || (legacySeed.has(n.id) && !!p && p.type === 'frame');
    if (p && !alreadyRel) { n.rx -= pax; n.ry -= pay; }   // absolute seed → parent-relative
    n.x = pax + n.rx; n.y = pay + n.ry;                   // working absolute coords
    for (const k of kidsOf.get(n.id) ?? []) stack.push(k);
  }
  // A map written before containment: its card-to-card links meant "beside", not "inside". Convert
  // them now that every node has final absolute coordinates to be re-anchored from.
  const flattened = boardIsLegacy() ? flattenLegacyBranches(wasStack) : 0;
  // …and cards no longer hold cards: any card that still has children becomes a frame holding them.
  const folded = foldCardsIntoFrames();
  // advance the runtime id counter past everything we just loaded so new nodes don't collide
  state.idSeq = seq + 1;
  // Auto-collapse a big map ONLY the very first time this folder is opened. After that we
  // always restore exactly the saved frontmatter state — reopening must look like you left it.
  const seenKey = store.seenKey;   // stable per map (names can be renamed / collide)
  const firstEver = !seenFolders().includes(seenKey);
  if (!keepView && firstEver && state.nodes.size > 40)
    collapseAtDepth(1);   // applyLayouts() below resolves positions
  if (!keepView) markFolderSeen(seenKey);
  // Re-point the open-frame scope at the freshly minted ids BEFORE the first layout/paint, so a
  // reload that happens while you're inside a frame lays out scoped straight away — no flash of the
  // whole map (nav/scope.ts).
  resolveScopeAfterLoad();
  // Paint once so every card has a real measured height, settle, and paint again.
  paintAll();
  applyLayouts();
  paintAll();
  if (!keepView) fit();
  // A migration is persisted BOARD FIRST, and awaited: the new edges and the model stamp have to be
  // on disk before any note loses its mm_parent, or a failed write between the two would drop the
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
  const unfolded = new Set<MindNode>();
  for (const f of arrange) for (const a of [f, ...ancestors(f)]) if (a.collapsed) { a.collapsed = false; unfolded.add(a); }
  const keepScope = scope.rootId; scope.rootId = null;
  for (const n of state.nodes.values()) paintNode(n);
  for (const f of arrange.sort((a, b) => ancestorDepth(b) - ancestorDepth(a))) {
    const x = f.x + FRAME_BORDER + SPACING;
    let y = f.y + frameInsetY(f) + SPACING, w = 0;
    for (const k of orderedKids(f, childrenOf(f.id))) {
      moveSubtreeTo(k, x, y);
      y += nodeH(k) + SPACING;
      w = Math.max(w, nodeW(k));
    }
    const end = snapPt({ x: x + w + SPACING + FRAME_BORDER, y: y + FRAME_BORDER });
    f.w = Math.max(MIN_FRAME_W, end.x - f.x);
    f.h = end.y - f.y;
    f.dirtyLayout = true;
    paintNode(f);
  }
  scope.rootId = keepScope;
  for (const a of unfolded) a.collapsed = true;
  return cards.length;
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
export async function saveAll(): Promise<void> {
  if (state.readOnly) return;        // read-only mode never writes to disk
  if (!store.isOpen) { setStatus('Open a folder first.'); return; }
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
  // Each step below records its progress AS it lands, so a save that throws half-way (quota, a revoked
  // folder permission) leaves exactly the unfinished part pending, and the retry (data/save-alert.ts)
  // picks it up — rather than a renamed note's old file, or a child's stale mm_parent, surviving it.
  while (state.toDelete.length) { await store.remove(state.toDelete[0]); state.toDelete.shift(); }

  // CONTENT changes rewrite the note; GEOMETRY changes don't — position, size, collapse and child
  // order live in board.json now, so `dirtyLayout` alone is not a reason to touch a .md. Moving a
  // card therefore writes one small JSON file instead of one .md per moved card.
  const needWrite = new Set<string>();
  for (const n of state.nodes.values()) if (n.dirty || !n.file) needWrite.add(n.id);

  // Phase 1 — settle every note's final filename IN MEMORY first. A child records its parent
  // by path (mm_parent), so a renamed parent forces its children to be rewritten, and all
  // parent paths must be final before we serialize anyone.
  const renames = new Map<string, string>();   // old path -> new path, for the wikilink fixup below
  // Kept in step with n.file below, so a name this loop has already handed out is seen as taken by
  // the nodes after it — the live `state.nodes` scan this replaced got that for free.
  const inUse = filesInUse();
  let pathsMoved = false;   // board.json is keyed by path, so a new or renamed note needs it rewritten
  for (const n of state.nodes.values()) {
    // While the title is being typed (in-card rename OR the editor sheet), keep the current
    // filename (rename happens when the edit session commits).
    const frozen = frozenFileNodeId() === n.id ? n.file : null;
    const target = frozen ?? desiredFileFor(n, inUse);
    if (n.file && n.file !== target) {
      pendingRemovals.add(n.file);                 // old file to delete once the rename is written
      renames.set(n.file, target);
      for (const c of childrenOf(n.id)) needWrite.add(c.id);
    }
    if (n.file !== target) { needWrite.add(n.id); pathsMoved = true; }   // brand-new node, or a rename
    if (n.file) inUse.delete(n.file.toLowerCase());
    n.file = target;                               // adopt the final name
    inUse.set(target.toLowerCase(), n.id);
  }

  // Phase 1b — a rename drags its INBOUND links along, for the same reason it rewrites its children's
  // mm_parent: a path recorded elsewhere in the vault must not outlive the path it records.
  for (const id of retargetWikilinks(renames)) needWrite.add(id);
  // Everything phase 1 decided must be written is now DIRTY, not just in this call's set: n.file has
  // already moved to its new name, so a retry would see no rename and forget the children it implied.
  for (const id of needWrite) state.nodes.get(id)!.dirty = true;

  // Phase 2 — write everything that changed, now that all paths are final.
  let written = 0;
  for (const n of state.nodes.values()) {
    if (!needWrite.has(n.id)) continue;
    await store.write(n.file!, serializeMd(n));
    n.dirty = false;
    written++;
  }
  // Phase 3 — drop files left behind by renames (unless some node now legitimately holds the path).
  for (const old of [...pendingRemovals]) {
    if (![...state.nodes.values()].some(n => n.file === old)) await store.remove(old);
    pendingRemovals.delete(old);
  }

  // …and the board follows. Its own debounce fires alongside this save, so it may already have been
  // written with this note still nameless (a card created a moment ago) or under its old path — and
  // then nothing would ever write that card's position. A reload would drop it at the origin.
  if (pathsMoved) scheduleSaveBoard();
  for (const n of state.nodes.values()) n.dirtyLayout = false;   // the board write carries these
  state.lastSelfWrite = Date.now();   // so focus-reload can ignore our own writes
  paintAll();
  setStatus(`Saved ${written} file${written===1?'':'s'} · ` + new Date().toLocaleTimeString());
}

// Old paths of renamed notes, still on disk until phase 3 removes them. Module-level so a failed save
// carries them to its retry; cleared by loadFromDir, since they belong to the map that was open.
const pendingRemovals = new Set<string>();

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
  if (editSessionActive() || isTypingInField()) return;
  reloading = true;
  try {
    // loadFromDir REPLACES every note with what's on disk, so whatever is still queued must reach the
    // disk first — this used to cancel the pending save instead, and an edit made just before
    // switching away was read over. If a write fails, memory holds the only copy: keep it, don't reload.
    await settleSave();
    if (hasUnsavedChanges()) return;
    if (editSessionActive() || isTypingInField()) return;   // began during the write
    await loadFromDir({ keepView:true });
    if (selBefore && state.nodes.has(selBefore)) selectNode(selBefore);
    else selectNode(null);
  } finally {
    reloading = false;
  }
}
store.watch(reloadFromDisk);   // re-read on external change (FSA: window-focus / tab-visible)
