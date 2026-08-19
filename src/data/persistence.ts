// ============================================================
// Disk I/O orchestration over the active `store` adapter: load the vault into state,
// debounced autosave, import/export .zip, and the focus/visibility reload. Every mutation
// elsewhere calls scheduleSave(); a burst coalesces into one write ~400ms later.
// `store` is the active backend (reassigned by useStore); main holds the open() flows.
// ============================================================
import { state, world, setStatus, isBoxType, isAnnotation, type MindNode } from '../core/state.js';
import { parseMd, serializeMd, firstLineLabel, fileStem } from '../utils/frontmatter.js';
import { soleImage } from '../utils/markdown.js';
import { zipBlob, unzip } from '../utils/zip.js';
import { downloadBlob } from '../utils/download.js';
import { childrenOf, parentOf } from '../utils/model.js';
import { applyLayouts, collapseAtDepth, commitRel } from '../view/layout.js';
import { fit } from '../view/camera.js';
import { resetImageCache } from '../features/images.js';
import { clearHistory } from '../features/history.js';
import { opfsStore, resolveOnDeviceStore, seenFolders, markFolderSeen, setLastMap, touchMap, createDeviceMap, type Store, type MapKind, type MapRef } from '../store/index.js';
import { paintAll, selectNode, colorFill, NODE_W } from '../main.js';
import { updateDocumentTitle } from '../nav/url-state.js';
import { resolveScopeAfterLoad } from '../nav/scope.js';
import { paintStrokes } from '../features/sketch.js';
import { refreshGrid } from '../view/grid.js';
import { ui, isTypingInField, editSessionActive, frozenFileNodeId } from '../core/ui-state.js';
import { hideStart } from '../boot.js';
import { byId } from '../utils/dom.js';
import { BOARD_FILE, SKETCH_FILE, boardJSON, loadBoard, resolveEdges, resolveOrder, boardGeom, flushBoard, scheduleSaveBoard, boardSavePending, boardIsLegacy, makeEdge } from './board.js';

// Everything that is about the BOARD rather than about a note — the free edges, the ink layer, the
// per-map view prefs — lives in one board.json beside the notes; see data/board.ts, which owns its
// I/O and its own debounce. Only the .md walk in the store filters by extension, so that file is
// invisible to the node model.

// Active backend. Local-first: default to on-device; "Open folder" swaps in fsaStore.
// `ref` identifies WHICH map is now open (registry entry + what boot() reopens); omit it
// for stores that aren't registry-backed (help).
export let store: Store = opfsStore;
// Which map is on the canvas RIGHT NOW — in-memory runtime state, unlike the persisted
// last-map key (which another tab may rewrite). null for non-registry stores (help).
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
  // carry over the board file if the archive included one (matching the note top-folder strip),
  // falling back to the sketch.json an older export would have packed instead
  for (const name of [BOARD_FILE, SKETCH_FILE]){
    const f = entries.find(e => e.text != null && (e.name === name || e.name === top + name));
    if (f?.text != null) await store.write(name, f.text);
  }
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
  // …including the container wrappers, which carry no data-id: a frame's clipping wrapper and a tab
  // group's strip hang off the NODE object (frameContentEl / tabStripEl), so once state.nodes is
  // cleared nothing can reach the old ones to remove them and they'd pile up in #world on every load.
  state.nodes.clear(); state.toDelete = [];
  world.querySelectorAll('[data-id], .frame-content, .tab-strip').forEach(e=>e.remove());
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
  // width from a time when `n.w` also held derived values (a stack outline row's stretched width, for
  // one). Those are all NARROWER than a normal card, and a card/stack can only ever be widened past
  // its default, so anything under the default is junk from that era: drop it. Two kinds of note
  // legitimately go narrower and are exempt: an annotation (which shrink-wraps its text, and never
  // had a width written back then), and an IMAGE card — a small picture is a small card, and one
  // that used to carry `mm_type: image` now loads as an ordinary card (foldTypeLayout), so without
  // this its authored size would be read as junk from that era and thrown away.
  const authoredW = (w: number | null | undefined, type: MindNode['type'], isImage: boolean): number | undefined => {
    if (w == null) return undefined;
    if (isBoxType(type) || type === 'annotation' || isImage) return w;
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
      done: !!mm.done,
      checklist: !!mm.checklist,
      type: mm.type, layout: mm.layout,
      // authoredW's junk-width filter is for the FRONTMATTER value only — a width in board.json was
      // written by this build and means exactly what it says.
      w: g?.w ?? authoredW(mm.w, mm.type, imageOnly),
      h: g?.h ?? mm.h ?? undefined,
      query: mm.query || undefined,
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
  // Resolve layouts in three steps: paint once so every card has a real measured height, run
  // the line/fan layout against those true heights, then paint the resolved positions.
  paintAll();
  applyLayouts();
  paintAll();
  paintStrokes();      // render the sketch layer over the freshly loaded map
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
  // Persist the resolved layout so the saved mm_x/mm_y match what's on screen. Only write when
  // the load actually moved something, so a stable reopen touches no files.
  if (!state.readOnly && [...state.nodes.values()].some(n => n.dirty || n.dirtyLayout))
    scheduleSave();
  updateMapTitle();
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
//   · an ANNOTATION, which is pinned to its parent rather than laid out beside it.
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
    if (isAnnotation(n) || outlined.has(n.id) || collapsedAbove(n)) continue;
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
// title -> safe filename component (no path separators or illegal chars)
function safeName(title: string): string {
  return (title || 'Untitled').trim().replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g,' ').slice(0,120);
}
// The filename a node SHOULD have, given its title, keeping its current directory.
//
// The filename is a SLUG, not the node's identity any more — the title lives in the note itself (the
// body's leading heading, utils/frontmatter.ts splitHeading), so this is free to suffix a colliding
// name without that suffix ever being read back as part of the title. Which is what lets two cards
// share a title: `Notes.md` and `Notes 2.md`, both titled "Notes".
//
// The slug TRACKS the text: it is re-derived on every save, so a card's filename always reads as the
// name the card shows — its heading, else its first line. It used to be minted once and left to go
// stale, which meant an ordinary card (untitled, its text edited into shape after it was created) kept
// whatever name it had at its very first autosave — `Untitled 12.md` for life. Tracking costs a rename
// per edit that changes the first line, and the two things that record a path follow it: the children's
// mm_parent (saveAll phase 1) and the inbound [[wikilinks]] (phase 1b). It is not a rename PER
// KEYSTROKE, though: while any editor holds the note's text the name is frozen (ui-state.ts
// frozenFileNodeId), so the rename lands once, when the edit session commits.
// The bare slug a node's own text gives it, with no directory and no `.md` — the ONE spelling of that
// rule, shared with exportZip, which has to name never-saved nodes the same way.
// An IMAGE card (a card holding nothing but one `![alt](src)`) is named after the PICTURE: its alt
// text, else the image file's own stem. firstLineLabel would hand back the raw `![](attachments/…)`
// markup, which slugifies into something no one can read in a folder listing — and the note has no
// other text to be named from, so this is the one kind of body worth reading structurally.
function slugStem(n: MindNode): string {
  const img = soleImage(n.body);
  if (!n.title.trim() && img) return safeName(img.alt || fileStem(img.src) || 'image');
  return safeName(n.title.trim() || firstLineLabel(n.body));
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
function desiredFileFor(n: MindNode, inUse: Map<string, string>): string {
  const dir = n.file ? n.file.slice(0, n.file.lastIndexOf('/')+1) : '';
  const stem = slugStem(n);
  // Nothing in the note to be named off — `Untitled` is safeName's fallback for an empty string, so
  // this is a card with no heading, no text and no picture. Keep the name it already has: there is
  // nothing to track, and renaming it would only renumber it as its neighbours come and go. A card the
  // user just CLEARED therefore keeps the slug it was named under, which utils/model.ts namelessLabel
  // leans on — the stem is the name they deleted, so nothing shows it to them again.
  if (stem === 'Untitled' && n.file) return n.file;
  let rel = dir + stem + '.md';
  // Avoid clobbering a DIFFERENT node that already uses this filename — case-INSENSITIVELY, since
  // that's how the filesystem collides on macOS/Windows: "Notes" and "notes" are one file there, so
  // an exact-match test would hand both nodes "their own" name and let the second write eat the first.
  const taken = (p: string): boolean => {
    const owner = inUse.get(p.toLowerCase());
    return owner !== undefined && owner !== n.id;
  };
  let i = 2;
  while (taken(rel)) rel = dir + stem + ' ' + (i++) + '.md';
  return rel;
}
// Re-point the PATH-form [[wikilinks]] that name a file phase 1 just renamed, so a link written
// before the rename still resolves after it (utils/model.ts resolveWikilink matches a target against
// the node's path, `.md` optional). Only the path form moves: a `[[Title]]` names the title, which
// re-slugging a file never touches — and the keys here are whole paths, so a bare title can only
// collide with one by BEING that path, which resolveWikilink already reads path-first anyway.
// The alias half is carried through verbatim: `[[Untitled 7|see this]]` keeps the words the reader sees.
// Returns the ids whose body changed, for phase 2 to write.
function retargetWikilinks(renames: Map<string, string>): string[] {
  if (!renames.size) return [];
  const dropMd = (path: string): string => path.replace(/\.md$/i, '');
  const to = new Map<string, string>();   // old path, no `.md`, lowercased -> new path, no `.md`
  for (const [from, into] of renames) to.set(dropMd(from).toLowerCase(), dropMd(into));
  const touched: string[] = [];
  for (const n of state.nodes.values()) {
    // Same shape as the renderer's wikilink arm (utils/markdown.ts mdInline).
    const body = n.body.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (m, target: string, alias?: string) => {
      const into = to.get(dropMd(target.trim()).toLowerCase());
      return into ? `[[${into}${alias ?? ''}]]` : m;
    });
    if (body === n.body) continue;
    n.body = body; n.dirty = true; touched.push(n.id);
  }
  return touched;
}
export async function saveAll(): Promise<void> {
  if (state.readOnly) return;        // read-only mode never writes to disk
  if (!store.isOpen) { setStatus('Open a folder first.'); return; }
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
  for (const f of state.toDelete) await store.remove(f);
  state.toDelete = [];

  // CONTENT changes rewrite the note; GEOMETRY changes don't — position, size, collapse and child
  // order live in board.json now, so `dirtyLayout` alone is not a reason to touch a .md. Moving a
  // card therefore writes one small JSON file instead of one .md per moved card.
  const needWrite = new Set<string>();
  for (const n of state.nodes.values()) if (n.dirty || !n.file) needWrite.add(n.id);

  // Phase 1 — settle every note's final filename IN MEMORY first. A child records its parent
  // by path (mm_parent), so a renamed parent forces its children to be rewritten, and all
  // parent paths must be final before we serialize anyone.
  const removals: string[] = [];
  const renames = new Map<string, string>();   // old path -> new path, for the wikilink fixup below
  // Kept in step with n.file below, so a name this loop has already handed out is seen as taken by
  // the nodes after it — the live `state.nodes` scan this replaced got that for free.
  const inUse = filesInUse();
  for (const n of state.nodes.values()) {
    // While the title is being typed (in-card rename OR the editor sheet), keep the current
    // filename (rename happens when the edit session commits).
    const frozen = frozenFileNodeId() === n.id ? n.file : null;
    const target = frozen ?? desiredFileFor(n, inUse);
    if (n.file && n.file !== target) {
      removals.push(n.file);                       // old file to delete once the rename is written
      renames.set(n.file, target);
      for (const c of childrenOf(n.id)) needWrite.add(c.id);
    }
    if (n.file !== target) needWrite.add(n.id);    // brand-new node, or a rename
    if (n.file) inUse.delete(n.file.toLowerCase());
    n.file = target;                               // adopt the final name
    inUse.set(target.toLowerCase(), n.id);
  }

  // Phase 1b — a rename drags its INBOUND links along, for the same reason it rewrites its children's
  // mm_parent: a path recorded elsewhere in the vault must not outlive the path it records.
  for (const id of retargetWikilinks(renames)) needWrite.add(id);

  // Phase 2 — write everything that changed, now that all paths are final.
  let written = 0;
  for (const n of state.nodes.values()) {
    if (!needWrite.has(n.id)) continue;
    await store.write(n.file!, serializeMd(n));
    n.dirty = false;
    written++;
  }
  // Phase 3 — drop files left behind by renames (unless some node now legitimately holds the path).
  for (const old of removals)
    if (![...state.nodes.values()].some(n => n.file === old)) await store.remove(old);

  for (const n of state.nodes.values()) n.dirtyLayout = false;   // the board write below carries these
  state.lastSelfWrite = Date.now();   // so focus-reload can ignore our own writes
  paintAll();
  setStatus(`Saved ${written} file${written===1?'':'s'} · ` + new Date().toLocaleTimeString());
}

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
  saveTimer = setTimeout(flushSave, 400);
}
export function flushSave(): Promise<void> {
  if (!store.isOpen) return Promise.resolve();
  clearTimeout(saveTimer); saveTimer = undefined;
  if (savePromise) { saveAgain = true; return savePromise; }   // coalesce overlapping writes
  savePromise = (async () => {
    try {
      await saveAll();
    } catch (err) {
      console.error('Save failed:', err);
      setStatus('⚠ Save failed: ' + ((err as Error).message || (err as Error).name));
    }
    savePromise = null;
    if (saveAgain) { saveAgain = false; await flushSave(); }
  })();
  return savePromise;
}
// Write out everything still pending (debounced or in flight, notes AND sketch), awaiting
// completion. MUST be called before retargeting the store at another map/folder — a straggling
// autosave firing after the switch would write the old map's files into the new one.
export async function settleSave(): Promise<void> {
  if (boardSavePending()) await flushBoard();
  if (saveTimer != null || savePromise) await flushSave();
}

// ---------- reload on focus ----------
let reloading = false;
export async function reloadFromDisk(): Promise<void> {
  if (!store.isOpen) return;
  // A single refocus dispatches BOTH window 'focus' and 'visibilitychange'. Guard re-entry.
  if (reloading) return;
  // if we just wrote, the focus event is almost certainly our own round-trip — skip
  if (Date.now() - (state.lastSelfWrite || 0) < 600) return;
  clearTimeout(saveTimer);
  if (savePromise) return;            // a write is mid-flight; don't read torn state
  const selBefore = state.selId;
  // Don't yank the rug out while the user is actively typing in the panel or renaming a card.
  // ui.sheetEdit counts even when no field is focused — on iOS the keyboard can be dismissed
  // while the editor sheet still holds uncommitted text.
  if (editSessionActive() || isTypingInField()) return;
  if (ui.sketchDraw) return;          // mid-stroke: don't reload the ink layer under the pen
  reloading = true;
  try {
    await loadFromDir({ keepView:true });
    if (selBefore && state.nodes.has(selBefore)) selectNode(selBefore);
    else selectNode(null);
  } finally {
    reloading = false;
  }
}
store.watch(reloadFromDisk);   // re-read on external change (FSA: window-focus / tab-visible)
