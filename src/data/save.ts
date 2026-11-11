// ---------- saving: the autosave, and the write of every changed note ----------
import { state, setStatus, type MindNode } from '../core/state.js';
import { retargetLinks, desiredFileFor, folderOf, dirOf, prunableDirs, pathKey, slugStem, ownStem } from '../utils/filenames.js';
import { ancestorDepth, commitRel } from '../view/layout.js';
import { ui, frozenFileNodeId } from '../core/ui-state.js';
import { parentOf, childrenOf } from '../utils/model.js';
import { store } from './persistence.js';
import { serializeMd } from '../utils/frontmatter.js';
import { flushBoard, scheduleSaveBoard, boardSavePending } from './board.js';
import { releaseFolded } from './lazy.js';
import { saveSucceeded, saveFailed } from './save-alert.js';
import { setSaving } from './save-flag.js';
import { foreignDirs, readFolder } from './load.js';

// The pathKey -> node index the collision test reads. Built ONCE per save rather than
// re-derived per candidate name: saveAll asks for every node's desired name, so a per-call
// `[...state.nodes.values()].some(…)` made settling filenames O(n²) with two string allocations per
// comparison. Keyed the way the filesystem collides (utils/filenames.ts pathKey). A name found on DISK
// that no node holds (diskTaken) is taken too, by nobody.
function filesInUse(): Map<string, string> {
  const m = new Map<string, string>();
  for (const key of diskTaken) {
    m.set(key, '');
  }
  for (const o of state.nodes.values()) {
    if (o.file) {
      m.set(pathKey(o.file), o.id);
    }
  }
  return m;
}

// What each note's filename was last SETTLED against: the slug its text gave it then. A name that says
// something else than the text — `2026-11-11.md` in someone's Obsidian vault, a file named in Finder —
// is left alone until that text changes: opening a folder must not rename what is in it.
const namedFor = new Map<string, string>();

export function noteNamed(path: string, slug: string): void { namedFor.set(path, slug); }

// Does the file already carry the name its text gives it (or that name with a ` 2` suffix)? Then it is
// the app's own name, and is re-derived as before — a suffix goes once the plain name is free.
function tracksText(n: MindNode, slug: string): boolean {
  const own = pathKey(ownStem(n.file!, n.type === 'section')), want = pathKey(slug);
  return own === want || (own.startsWith(want + ' ') && /^\d+$/.test(own.slice(want.length + 1)));
}

function keepsName(n: MindNode): boolean {
  if (!n.file) {
    return false;
  }
  const slug = slugStem(n);
  return namedFor.get(n.file) === slug && !tracksText(n, slug);
}

// Names that turned out to be on disk although no node holds them: a note another app (or another tab)
// wrote since the map was read. Writing a new card there would replace it, so the name counts as taken.
const diskTaken = new Set<string>();
const CHECKS_AT_ONCE = 16;

// planPaths, checked against the DISK for every path a note is about to take for the first time.
async function planFreePaths(): Promise<Map<string, string>> {
  const checked = new Set<string>();
  for (let guard = 0; guard < 8; guard++) {
    const plan = planPaths();
    const fresh: string[] = [];
    for (const n of state.nodes.values()) {
      const target = plan.get(n.id)!, key = pathKey(target);
      if (n.file !== target && !checked.has(key) && !pendingRemovals.has(target)) {
        checked.add(key);
        fresh.push(target);
      }
    }
    let clash = false;
    for (let i = 0; i < fresh.length; i += CHECKS_AT_ONCE) {
      const found = await Promise.all(fresh.slice(i, i + CHECKS_AT_ONCE).map(async path => (await store.readBlob(path)) ? path : null));
      for (const path of found) {
        if (path) {
          diskTaken.add(pathKey(path));
          clash = true;
        }
      }
    }
    if (!clash) {
      return plan;
    }
  }
  return planPaths();
}
// Re-point inbound [[wikilinks]] across every note (utils/filenames.ts retargetLinks), returning the
// ids whose body changed, for phase 2 to write.
function retargetWikilinks(renames: Map<string, string>): string[] {
  if (!renames.size) {
    return [];
  }
  const touched: string[] = [];
  const existing = new Set([...state.nodes.values()].map(n => (n.file ?? '').replace(/\.md$/i, '').toLowerCase()));
  for (const n of state.nodes.values()) {
    const body = retargetLinks(n.body, renames, existing);
    if (body === n.body) {
      continue;
    }
    n.body = body; n.dirty = true; touched.push(n.id);
  }
  return touched;
}
// Where every node's file SHOULD be, settled top-down: a node's folder is its parent section's folder, so
// a parent's final path has to be known before its children's (utils/filenames.ts desiredFileFor).
// Pure — nothing is renamed here; saveAll adopts the result.
function planPaths(): Map<string, string> {
  const out = new Map<string, string>();
  // Kept in step below, so a name this loop has already handed out is seen as taken by the nodes after it.
  const inUse = filesInUse();
  for (const n of [...state.nodes.values()].sort((a, b) => ancestorDepth(a) - ancestorDepth(b))) {
    // While the title is being typed (in-card rename OR the editor sheet), keep the current
    // filename (rename happens when the edit session commits). A note opened ON ITS OWN (store/note.ts)
    // keeps the name you picked it by for good: there is no folder to rename it in.
    const frozen = frozenFileNodeId() === n.id || state.singleNote ? n.file : null;
    const p = parentOf(n);
    const pFile = p ? out.get(p.id) ?? p.file : null;
    const target = frozen ?? desiredFileFor(n, inUse, pFile ? folderOf(pFile) : '', foreignDirs, keepsName(n));
    // A node's OLD name stays taken for the rest of this save: phase 3 deletes that file, and on a
    // case-insensitive disk a node handed `plan.md` for a freed `Plan.md` would be deleted with it.
    // It suffixes instead (`plan 2.md`) and takes the plain name on the next save, once it is free.
    inUse.set(pathKey(target), n.id);
    out.set(n.id, target);
  }
  return out;
}
async function saveAll(): Promise<void> {
  if (!store.isOpen) { setStatus('Open a folder first.'); return; }
  // Phase 0 — a FOLDED section whose notes were never read can't move them without reading them: one
  // that is about to move (renamed, retyped, dropped into another section, or inside one that is) reads
  // its whole folder first, and one that somehow holds a note in memory reads its own level, so the
  // rest of the save sees a complete tree under every path it changes (data/lazy.ts).
  for (let guard = 0; guard < 16; guard++) {
    const plan = planPaths();
    const moving = [...state.nodes.values()].filter(n => n.lazy != null && n.file && plan.get(n.id) !== n.file);
    const holding = [...state.nodes.values()].filter(n => n.lazy != null && childrenOf(n.id).length);
    if (!moving.length && !holding.length) {
      break;
    }
    for (const f of moving) {
      await readFolder(f, true);
    }
    for (const f of holding) {
      await readFolder(f, false);
    }
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
  for (const n of state.nodes.values()) {
    if (n.dirty || !n.file) {
      needWrite.add(n.id);
    }
  }

  // Phase 1 — settle every note's final path IN MEMORY first (planPaths). A section is a folder, so a
  // renamed or moved section moves every note inside it: each one is a rename of its own here.
  const renames = new Map<string, string>();   // old path -> new path, for the wikilink fixup below
  let pathsMoved = false;   // board.json is keyed by path, so a new or renamed note needs it rewritten
  const plan = await planFreePaths();
  for (const n of state.nodes.values()) {
    const target = plan.get(n.id)!;
    if (n.file && n.file !== target) {
      // A note renamed AGAIN before its last rename reached the disk: what waited on that write waits on this one.
      for (const [old, to] of pendingRemovals) {
        if (to === n.file) {
          pendingRemovals.set(old, target);
        }
      }
      pendingRemovals.set(n.file, target);         // old file to delete once the rename is written
      renames.set(n.file, target);
      namedFor.delete(n.file);
    }
    if (n.file !== target) { needWrite.add(n.id); pathsMoved = true; }   // brand-new node, or a rename
    n.file = target;                               // adopt the final name
    if (frozenFileNodeId() !== n.id && !keepsName(n)) {
      namedFor.set(target, slugStem(n));
    }
  }

  // Phase 1b — a rename drags its INBOUND links along: a path recorded elsewhere in the vault must not
  // outlive the path it records.
  for (const id of retargetWikilinks(renames)) {
    needWrite.add(id);
  }
  // Everything phase 1 decided must be written is now DIRTY, not just in this call's set: n.file has
  // already moved to its new name, so a retry would see no rename and forget it had to write it.
  for (const id of needWrite) {
    state.nodes.get(id)!.dirty = true;
  }

  // Phase 2 — write everything that changed, now that all paths are final. One note that can't be
  // written (a name the disk refuses, a file another app holds) must not keep the others from being
  // saved: it stays dirty, the rest go on, and the failure is reported once they have.
  let written = 0;
  const failed = new Set<string>();
  let firstError: unknown;
  for (const n of state.nodes.values()) {
    if (!needWrite.has(n.id)) {
      continue;
    }
    try {
      await store.write(n.file!, serializeMd(n));
    } catch (err) {
      failed.add(n.file!);
      firstError ??= err;
      continue;
    }
    n.dirty = false;
    written++;
  }
  // Phase 3 — drop files left behind by renames, unless some node now legitimately holds the path — on
  // ANY disk: where case or accents fold, a different spelling is the same file. A rename whose new
  // file didn't land keeps its old one, which is the only copy on disk.
  const held = new Set([...state.nodes.values()].map(n => n.file ? pathKey(n.file) : ''));
  for (const [old, to] of [...pendingRemovals]) {
    if (failed.has(to)) {
      continue;
    }
    if (!held.has(pathKey(old))) { await store.remove(old); emptied.add(dirOf(old)); }
    pendingRemovals.delete(old);
  }
  // …and the FOLDERS they leave empty: a section renamed, moved or deleted leaves its old folder behind.
  // Deepest first, and up the chain, since emptying `A/B/` can empty `A/` too. removeDir only ever
  // removes an EMPTY folder, so one still holding anything — a live note, another app's file — stays.
  const dirs = prunableDirs(emptied, [...state.nodes.values()].map(n => n.file));
  emptied.clear();
  for (const d of dirs) {
    await store.removeDir(d);
  }

  // …and the board follows, AWAITED: it is keyed by path, so after a move it must land before anything
  // else does — a reload in between would find the notes in their new folders and no layout for them.
  if (pathsMoved) {
    await flushBoard();
  }
  for (const n of state.nodes.values()) {
    n.dirtyLayout = false;   // the board write carries these
  }
  state.lastSelfWrite = Date.now();   // so focus-reload can ignore our own writes
  if (firstError !== undefined) {
    throw firstError;
  }
  releaseFolded();   // a folded section whose notes are all safely on disk can let go of them (data/lazy.ts)
}

// Old paths of renamed notes, still on disk until phase 3 removes them, each with the path its note
// moved TO. Module-level so a failed save carries them to its retry; cleared by loadFromDir, since they
// belong to the map that was open.
const pendingRemovals = new Map<string, string>();
// Folders a removal may have left empty, for phase 3 to prune. Module-level for the same reason.
const emptied = new Set<string>();

// Forget the removals planned for the map that was open (loadFromDir, on a new map or a reload).
export function resetSaveState(): void {
  pendingRemovals.clear();
  emptied.clear();
  namedFor.clear();
  diskTaken.clear();
}

// ---------- autosave (debounced) ----------
let saveTimer: number | undefined, saveAgain = false;
let savePromise: Promise<void> | null = null;   // non-null while a save chain is in flight
export function scheduleSave(): void {
  if (!store.isOpen) {
    return;          // demo mode: nothing to write
  }
  // Geometry lives in board.json, so the two files settle together: every mutation path in the app
  // ends in scheduleSave(), and a great many of them move something.
  scheduleSaveBoard();
  setSaving('notes', true);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}
export function flushSave(): Promise<void> {
  if (!store.isOpen) {
    return Promise.resolve();
  }
  clearTimeout(saveTimer); saveTimer = undefined;
  if (savePromise) { saveAgain = true; return savePromise; }   // coalesce overlapping writes
  setSaving('notes', true);
  savePromise = (async () => {
    try {
      await saveAll();
      saveSucceeded('notes');
    } catch (err) {
      saveFailed('notes', err, () => { void flushSave(); });
    }
    savePromise = null;
    if (saveAgain) { saveAgain = false; await flushSave(); }
    if (saveTimer == null && !savePromise) {
      setSaving('notes', false);
    }
  })();
  return savePromise;
}
// Write out everything still pending (debounced or in flight, notes AND board.json), awaiting
// completion. MUST be called before retargeting the store at another map/folder — a straggling
// autosave firing after the switch would write the old map's files into the new one.
export async function settleSave(): Promise<void> {
  if (boardSavePending()) {
    await flushBoard();
  }
  if (saveTimer != null || savePromise || notesUnsaved()) {
    await flushSave();
  }
}
// Is there anything in memory the disk doesn't have yet — queued, in flight, or left over by a write
// that failed? Demo mode never writes, so it never has anything unsaved.
function notesUnsaved(): boolean {
  if (!store.isOpen) {
    return false;
  }
  if (state.toDelete.length || pendingRemovals.size) {
    return true;
  }
  // …and the open card editor, until what it holds has been written into its note (inline-edit.ts flushOpenEdit)
  if (ui.bodyEdit && ui.bodyEdit.ta.value !== ui.bodyEdit.saved) {
    return true;
  }
  for (const n of state.nodes.values()) {
    if (n.dirty || !n.file) {
      return true;
    }
  }
  return false;
}
export function hasUnsavedChanges(): boolean {
  if (!store.isOpen) {
    return false;
  }
  return saveTimer != null || savePromise != null || boardSavePending() || notesUnsaved();
}

// ---------- never lose the last edit to a closing tab ----------
// The autosave waits 400ms for a burst to settle, so an edit made just before the tab is hidden,
// closed or reloaded would otherwise die with it. Hiding is the dependable signal (it fires before
// unload, and is the LAST one iOS gives a backgrounded page); beforeunload also asks the browser to
// hold the page while anything is still unwritten.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void settleSave();
  }
});
window.addEventListener('pagehide', () => { void settleSave(); });
window.addEventListener('beforeunload', e => {
  if (!hasUnsavedChanges()) {
    return;
  }
  void settleSave();
  e.preventDefault();
});

