// File System Access adapter (Chrome/Edge): a real local folder, its handle kept in IndexedDB.
import { idbGet, idbPut } from '../utils/idb.js';
import { listTree, removeEmptyDir, writeFile, removeFile, readFileBlob, folderStamp, stampOf } from './handle-store.js';
import type { FoldTest } from './tree.js';
import { rememberFolder, notifyRecentsChanged, forgetRecent } from './recents.js';
import { installWatch } from './watch.js';
import type { Store, PickResult } from './types.js';
import { ensureWrite, hasWrite, reachable } from './permission.js';

// window.showDirectoryPicker isn't in lib.dom.
type DirectoryPicker = (opts?: { mode?: string; startIn?: FileSystemHandle }) => Promise<FileSystemDirectoryHandle>;
const showDirectoryPicker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

// A dead handle can make `startIn` itself throw: then the picker opens where Chrome likes.
async function pickAgain(near: FileSystemDirectoryHandle | undefined): Promise<FileSystemDirectoryHandle | PickResult> {
  const pick = (startIn?: FileSystemHandle): Promise<FileSystemDirectoryHandle> =>
    showDirectoryPicker!({ mode: 'readwrite', ...(startIn ? { startIn } : {}) });
  try {
    return await pick(near);
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'AbortError') {
      return 'cancel';
    }
    if (name === 'SecurityError' || !near) {
      return 'needs-click';
    }
  }
  try {
    return await pick();
  } catch (e) {
    return (e as DOMException).name === 'AbortError' ? 'cancel' : 'needs-click';
  }
}

async function rememberedHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await idbGet<FileSystemDirectoryHandle>(key);
  } catch {
    return undefined;
  }
}

export const fsaStore = {
  _dir: null as FileSystemDirectoryHandle | null,
  _key: null as string | null,                      // registry/handle key
  // Kept up to date by our own writes, so a refocus can tell whether anything ELSE touched the folder.
  _stamp: null as Map<string, string> | null,
  get isOpen(){ return !!this._dir; },
  get name(){ return this._dir ? this._dir.name : ''; },
  // Assigned before loading, so two folders with one name can't share layout state.
  get currentKey(){ return this._key; },

  // The picker's mode:'readwrite' can still leave the grant at 'prompt', where every write silently fails.
  async adopt(handle: FileSystemDirectoryHandle): Promise<PickResult> {
    const r = await ensureWrite(handle);
    if (r !== 'ok') {
      return r;
    }
    this._dir = handle;
    await this._remember(handle);
    return 'ok';
  },

  async pick(): Promise<PickResult> {
    if (!showDirectoryPicker) {
      return 'unsupported';
    }
    let handle: FileSystemDirectoryHandle;
    try { handle = await showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e){ return (e as DOMException).name === 'AbortError' ? 'cancel' : 'error'; }
    return this.adopt(handle);
  },

  // Chrome won't ask about a dead handle, but a fresh pick is a fresh grant.
  async relink(key: string): Promise<PickResult> {
    if (!showDirectoryPicker) {
      return 'unsupported';
    }
    const old = await rememberedHandle(key);
    const r = await pickAgain(old);
    if (typeof r === 'string') {
      return r;
    }
    const adopted = await this.adopt(r);
    if (adopted === 'ok') {
      await forgetRecent(key);
      notifyRecentsChanged();
    }
    return adopted;
  },

  async openRecent(key?: string): Promise<PickResult> {
    const handle = key ? await rememberedHandle(key) : undefined;
    if (!handle) {
      return 'gone';
    }
    return this.adopt(handle);
  },

  async resume(key: string): Promise<boolean> {
    const handle = await rememberedHandle(key);
    if (!handle) {
      return false;
    }
    if (!(await hasWrite(handle)) || !(await reachable(handle))) {
      return false;
    }
    this._dir = handle; this._key = key; return true;
  },

  async listTree(under: string, fold: FoldTest){
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
  async changed(): Promise<boolean> {
    const before = this._stamp, now = await folderStamp(this._dir!);
    this._stamp = now;
    return !before || before.size !== now.size || [...now].some(([p, s]) => before.get(p) !== s);
  },
  readBlob(path: string){ return readFileBlob(this._dir!, path); },

  watch(cb: () => void){ installWatch(cb); },

  async _remember(handle: FileSystemDirectoryHandle){
    const key = 'dir:' + handle.name + ':' + Date.now();
    await idbPut(key, handle);
    await rememberFolder(key, handle.name, handle); // de-dupes by handle identity
    this._key = key;
    notifyRecentsChanged();
  },
};
fsaStore satisfies Store;
