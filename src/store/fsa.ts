// File System Access API adapter (Chrome/Edge only): a real local folder, with permission
// prompts and IndexedDB-persisted handles for silent resume at boot. File ops delegate to
// the shared handle-store helpers (DRY); only handle acquisition is FSA-specific.
import { idbGet, idbPut } from '../utils/idb.js';
import { listTree, removeEmptyDir, writeFile, removeFile, readFileBlob, folderStamp, stampOf } from './handle-store.js';
import type { FoldTest } from './tree.js';
import { rememberFolder, notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';
import type { Store, PickResult } from './types.js';
import { ensureWrite, hasWrite } from './permission.js';

// window.showDirectoryPicker isn't in lib.dom.
type DirectoryPicker = (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
const showDirectoryPicker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

async function rememberedHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await idbGet<FileSystemDirectoryHandle>(key);
  } catch {
    return undefined;
  }
}

export const fsaStore = {
  _dir: null as FileSystemDirectoryHandle | null,   // FSA directory handle
  _key: null as string | null,                      // the open folder's registry/handle key
  // The folder as this app last saw it (handle-store folderStamp): taken before each full load, kept up
  // to date by our own writes, so a refocus can tell whether anything ELSE touched the folder.
  _stamp: null as Map<string, string> | null,
  get isOpen(){ return !!this._dir; },
  get name(){ return this._dir ? this._dir.name : ''; },
  // The registry key distinguishes two folders with the same display name. It is assigned before
  // loading, so first-open layout state cannot leak from one "notes" folder into another.
  // Which map (registry id) the last pick/openRecent/resume landed on — callers use this
  // as the MapRef id instead of guessing it back out of the registry.
  get currentKey(){ return this._key; },

  // Adopt a picked, remembered or DROPPED folder as the live root, once read-write access is confirmed (the
  // picker's mode:'readwrite' asks, but the grant can sit in 'prompt' until requested — without it every write
  // silently fails), and remember it for the recents list.
  async adopt(handle: FileSystemDirectoryHandle): Promise<PickResult> {
    const r = await ensureWrite(handle);
    if (r !== 'ok') {
      return r;
    }
    this._dir = handle;
    await this._remember(handle);
    return 'ok';
  },

  // Pick a NEW source (needs a user gesture — the toolbar / start-screen click).
  async pick(): Promise<PickResult> {
    if (!showDirectoryPicker) {
      return 'unsupported';
    }
    let handle: FileSystemDirectoryHandle;
    try { handle = await showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e){ return (e as DOMException).name === 'AbortError' ? 'cancel' : 'error'; }
    return this.adopt(handle);
  },

  // Reopen a REMEMBERED source by its recents key (the click is the gesture).
  async openRecent(key?: string): Promise<PickResult> {
    const handle = key ? await rememberedHandle(key) : undefined;
    if (!handle) {
      return 'gone';
    }
    return this.adopt(handle);
  },

  // Silent reopen at boot — only succeeds if permission is ALREADY granted (no prompt/gesture).
  async resume(key: string): Promise<boolean> {
    const handle = await rememberedHandle(key);
    if (!handle) {
      return false;
    }
    if (!(await hasWrite(handle))) {
      return false;
    }
    this._dir = handle; this._key = key; return true;
  },

  async listTree(under: string, fold: FoldTest){
    // A full load restamps the folder from the files it reads, so a later change shows at the next focus.
    if (!under) {
      const stamp = new Map<string, string>();
      const tree = await listTree(this._dir!, '', fold, stamp);
      this._stamp = stamp;
      return tree;
    }
    return listTree(this._dir!, under, fold);
  },
  removeDir(dir: string){ return removeEmptyDir(this._dir!, dir); },
  async write(path: string, data: string | Blob){
    const f = await writeFile(this._dir!, path, data);
    this._stamp?.set(path, stampOf(f));
  },
  async remove(path: string){ await removeFile(this._dir!, path); this._stamp?.delete(path); },
  // Has anything outside this app changed the folder since the last load? Unknown counts as yes.
  async changed(): Promise<boolean> {
    const before = this._stamp, now = await folderStamp(this._dir!);
    this._stamp = now;
    return !before || before.size !== now.size || [...now].some(([p, s]) => before.get(p) !== s);
  },
  readBlob(path: string){ return readFileBlob(this._dir!, path); },

  // Fire cb when the source may have changed underneath us (window-focus / tab-visible).
  // An Obsidian/Tauri build would register a real file watcher here instead.
  watch(cb: () => void){ installWatch(cb); },

  // ---- recent sources: handles in IndexedDB, folder-kind MapRefs in the unified registry ----
  async _remember(handle: FileSystemDirectoryHandle){
    const key = 'dir:' + handle.name + ':' + Date.now();
    await idbPut(key, handle);                 // store the actual handle
    await rememberFolder(key, handle.name, handle); // registry entry (de-dupes by handle identity)
    this._key = key;
    notifyRecentsChanged();                    // main re-renders the recents UI
  },
};
fsaStore satisfies Store;   // compile-time contract check (extra _dir/_remember allowed on a reference)
