// The autosave: writing every changed note, renames and all.
import { state, setStatus } from '../core/state.js';
import { retargetLinks, desiredFileFor, folderOf, dirOf, prunableDirs, pathKey, slugStem } from '../utils/filenames.js';
import { ancestorDepth, commitRel } from '../view/layout.js';
import { ui, frozenFileNodeId } from '../core/ui-state.js';
import { parentOf, childrenOf } from '../utils/model.js';
import { store } from './active-store.js';
import { serializeMd } from '../utils/frontmatter.js';
import { flushBoard, scheduleSaveBoard, boardSavePending, boardPathMoved } from './board.js';
import { releaseFolded } from './lazy.js';
import { saveSucceeded, saveFailed, writesHeld } from './save-alert.js';
import { setSaving } from './save-flag.js';
import { foreignDirs, readFolder } from './read.js';
import { noteNamed, forgetNoteName, forgetNoteNames, keepsName } from './note-names.js';

// pathKey → node id, built once per save (per-name lookups were O(n²)). A diskTaken name maps to ''.
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

// On disk but held by no node: another app or tab wrote it since the read. Writing there would replace it.
const diskTaken = new Set<string>();
const CHECKS_AT_ONCE = 16, WRITES_AT_ONCE = 8;

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
// Returns the ids whose body changed.
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
// Where every node's file should be. Pure. Top-down: a parent's folder must be known before its children's.
function planPaths(): Map<string, string> {
  const out = new Map<string, string>();
  const inUse = filesInUse();
  for (const n of [...state.nodes.values()].sort((a, b) => ancestorDepth(a) - ancestorDepth(b))) {
    // Renamed only when the edit commits; a single note opened on its own is never renamed.
    const frozen = frozenFileNodeId() === n.id || state.singleNote ? n.file : null;
    const p = parentOf(n);
    const pFile = p ? out.get(p.id) ?? p.file : null;
    const target = frozen ?? desiredFileFor(n, inUse, pFile ? folderOf(pFile) : '', foreignDirs, keepsName(n));
    // The OLD name stays taken: phase 3 deletes it, and on a case-insensitive disk a node handed `plan.md`
    // for a freed `Plan.md` would be deleted with it.
    inUse.set(pathKey(target), n.id);
    out.set(n.id, target);
  }
  return out;
}
async function saveAll(): Promise<void> {
  if (!store.isOpen) { setStatus('Open a folder first.'); return; }
  if (writesHeld()) {
    return;
  }
  // Phase 0: an unread folded section that is about to move (or holds a note in memory) is read first,
  // so the save sees a complete tree under every path it changes.
  for (let guard = 0; guard < 16 && [...state.nodes.values()].some(n => n.lazy != null); guard++) {
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
  commitRel();
  // Each step records progress as it lands, so a save that throws half-way leaves exactly the rest pending.
  while (state.toDelete.length) { const gone = state.toDelete[0]; await store.remove(gone); emptied.add(dirOf(gone)); state.toDelete.shift(); }

  // Geometry lives in board.json, so a move alone doesn't rewrite a .md.
  const needWrite = new Set<string>();
  for (const n of state.nodes.values()) {
    if (n.dirty || !n.file) {
      needWrite.add(n.id);
    }
  }

  // Phase 1: settle every final path in memory. A moved section moves every note inside it.
  const renames = new Map<string, string>();   // old path → new path
  let pathsMoved = false;   // board.json is keyed by path
  const plan = await planFreePaths();
  for (const n of state.nodes.values()) {
    const target = plan.get(n.id)!;
    if (n.file && n.file !== target) {
      // Renamed again before the last rename reached disk: what waited on that write waits on this one.
      for (const [old, to] of pendingRemovals) {
        if (to === n.file) {
          pendingRemovals.set(old, target);
        }
      }
      pendingRemovals.set(n.file, target);
      renames.set(n.file, target);
      forgetNoteName(n.file);
      boardPathMoved(n.file, target);
    }
    if (n.file !== target) { needWrite.add(n.id); pathsMoved = true; }
    n.file = target;
    if (frozenFileNodeId() !== n.id && !keepsName(n)) {
      noteNamed(target, slugStem(n));
    }
  }

  // Phase 1b: a rename drags its inbound links along.
  for (const id of retargetWikilinks(renames)) {
    needWrite.add(id);
  }
  // n.file already holds the new name, so a retry would see no rename: mark it dirty instead.
  for (const id of needWrite) {
    state.nodes.get(id)!.dirty = true;
  }

  // Phase 2: write, a few at a time. A note that fails stays dirty without stopping the others.
  const failed = new Set<string>();
  let firstError: unknown;
  const todo = [...state.nodes.values()].filter(n => needWrite.has(n.id));
  for (let i = 0; i < todo.length; i += WRITES_AT_ONCE) {
    await Promise.all(todo.slice(i, i + WRITES_AT_ONCE).map(async n => {
      // An edit made while the write is in flight dirties it again.
      const path = n.file!, text = serializeMd(n);
      n.dirty = false;
      try {
        await store.write(path, text);
      } catch (err) {
        n.dirty = true;
        failed.add(path);
        firstError ??= err;
      }
    }));
  }
  // Phase 3: drop files renames left behind, unless a node holds that path (by pathKey: case and accents
  // may fold). A rename whose new file didn't land keeps its old one, the only copy.
  const held = new Set([...state.nodes.values()].map(n => n.file ? pathKey(n.file) : ''));
  for (const [old, to] of [...pendingRemovals]) {
    if (failed.has(to)) {
      continue;
    }
    if (!held.has(pathKey(old))) { await store.remove(old); emptied.add(dirOf(old)); }
    pendingRemovals.delete(old);
  }
  // …and the folders they leave empty, deepest first (removeDir only removes an empty one).
  const dirs = prunableDirs(emptied, [...state.nodes.values()].map(n => n.file));
  emptied.clear();
  for (const d of dirs) {
    await store.removeDir(d);
  }

  // Awaited: a reload in between would find moved notes with no layout for their new paths.
  if (pathsMoved) {
    await flushBoard();
  }
  state.lastSelfWrite = Date.now();   // so focus-reload can ignore our own writes
  if (firstError !== undefined) {
    throw firstError;
  }
  releaseFolded();
}

// Old path → new path, still on disk until phase 3. Module-level so a failed save carries them to its retry.
const pendingRemovals = new Map<string, string>();
const emptied = new Set<string>();

export function resetSaveState(): void {
  pendingRemovals.clear();
  emptied.clear();
  forgetNoteNames();
  diskTaken.clear();
}

const SAVE_DELAY_MS = 400;
let saveTimer: number | undefined, saveAgain = false;
let savePromise: Promise<void> | null = null;   // non-null while a save chain is in flight
export function scheduleSave(): void {
  if (!store.isOpen || writesHeld()) {
    return;
  }
  scheduleSaveBoard();
  setSaving('notes', true);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, SAVE_DELAY_MS);
}
export function flushSave(): Promise<void> {
  if (!store.isOpen) {
    return Promise.resolve();
  }
  clearTimeout(saveTimer); saveTimer = undefined;
  if (savePromise) { saveAgain = true; return savePromise; }
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
// MUST run before retargeting the store: a straggling autosave would write the old map into the new one.
export async function settleSave(): Promise<void> {
  if (boardSavePending()) {
    await flushBoard();
  }
  if (saveTimer != null || savePromise || notesUnsaved()) {
    await flushSave();
  }
}
function notesUnsaved(): boolean {
  if (!store.isOpen || writesHeld()) {
    return false;
  }
  if (state.toDelete.length || pendingRemovals.size) {
    return true;
  }
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
  if (!store.isOpen || writesHeld()) {
    return false;
  }
  return saveTimer != null || savePromise != null || boardSavePending() || notesUnsaved();
}

// Hiding is the dependable signal: the last one iOS gives a backgrounded page.
export function installSaveOnLeave(): void {
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
}

