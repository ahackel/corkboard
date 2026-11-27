// ONE .md file opened on its own (FSA): a map of a single card. Its board.json lives in IndexedDB, so the
// note on disk stays exactly the note. See "A single NOTE opens as a map of ONE card" in docs/architecture.md.
import { idbGet, idbPut, idbDel } from '../utils/idb.js';
import { readMaps, upsertMap, removeMapRef } from './maps.js';
import { notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';
import { stampOf } from './handle-store.js';
import type { FoldTest } from './tree.js';
import type { Store, PickResult, TreeListing } from './types.js';
import { ensureWrite, hasWrite, sameEntry, reachable } from './permission.js';

// window.showOpenFilePicker isn't in lib.dom.
type FilePicker = (opts?: {
  startIn?: FileSystemHandle;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
  excludeAcceptAllOption?: boolean; multiple?: boolean;
}) => Promise<FileSystemFileHandle[]>;
const showOpenFilePicker = (window as Window & { showOpenFilePicker?: FilePicker }).showOpenFilePicker;

// The only other path this store answers.
const BOARD_PATH = 'board.json';
const PICK_NOTE = {
  types: [{ description: 'Markdown note', accept: { 'text/markdown': ['.md', '.markdown'] } }],
  multiple: false,
};
const boardKey = (key: string): string => 'note-board:' + key;

async function rememberedHandle(key: string): Promise<FileSystemFileHandle | undefined> {
  try {
    return await idbGet<FileSystemFileHandle>(key);
  } catch {
    return undefined;
  }
}

// Reuses the key a file was opened under before, so it finds its board again.
async function keyFor(handle: FileSystemFileHandle): Promise<string> {
  for (const m of readMaps()) {
    if (m.kind !== 'note') {
      continue;
    }
    const prior = await rememberedHandle(m.id);
    if (prior && await sameEntry(handle, prior)) {
      return m.id;
    }
  }
  return 'note:' + handle.name + ':' + Date.now();
}

export const noteStore = {
  _file: null as FileSystemFileHandle | null,
  _key: null as string | null,
  _stamp: null as string | null,
  singleNote: true as const,
  get isOpen(){ return !!this._file; },
  get name(){ return this._file ? this._file.name.replace(/\.(md|markdown)$/i, '') : ''; },
  get currentKey(){ return this._key; },

  // `key`: the entry it replaces (relink), so the note keeps that entry's board.
  async adopt(handle: FileSystemFileHandle, key?: string): Promise<PickResult> {
    const r = await ensureWrite(handle);
    if (r !== 'ok') {
      return r;
    }
    key ??= await keyFor(handle);
    await idbPut(key, handle);
    upsertMap({ id: key, kind: 'note', name: handle.name, when: Date.now() });
    notifyRecentsChanged();
    this._file = handle; this._key = key; this._stamp = null;
    return 'ok';
  },

  async pick(): Promise<PickResult> {
    if (!showOpenFilePicker) {
      return 'unsupported';
    }
    let handle: FileSystemFileHandle | undefined;
    try {
      [handle] = await showOpenFilePicker(PICK_NOTE);
    } catch (e) { return (e as DOMException).name === 'AbortError' ? 'cancel' : 'error'; }
    return handle ? this.adopt(handle) : 'cancel';
  },

  // For a dead handle: the picker, opened beside the old file if Chrome still knows where it is.
  async relink(key: string): Promise<PickResult> {
    if (!showOpenFilePicker) {
      return 'unsupported';
    }
    const old = await rememberedHandle(key);
    let handle: FileSystemFileHandle | undefined;
    for (const startIn of old ? [old, undefined] : [undefined]) {
      try {
        [handle] = await showOpenFilePicker({ ...PICK_NOTE, ...(startIn ? { startIn } : {}) });
        break;
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === 'AbortError') {
          return 'cancel';
        }
        if (name === 'SecurityError') {
          return 'needs-click';
        }
      }
    }
    return handle ? this.adopt(handle, key) : 'needs-click';
  },

  async openRecent(key: string): Promise<PickResult> {
    const handle = await rememberedHandle(key);
    return handle ? this.adopt(handle) : 'gone';
  },

  async resume(key: string): Promise<boolean> {
    const handle = await rememberedHandle(key);
    if (!handle) {
      return false;
    }
    if (!(await hasWrite(handle)) || !(await reachable(handle))) {
      return false;
    }
    this._file = handle; this._key = key; this._stamp = null;
    return true;
  },

  async forget(key: string): Promise<void> {
    removeMapRef(key);
    await idbDel(key).catch(() => {});
    await idbDel(boardKey(key)).catch(() => {});
  },

  async listTree(under: string, _fold: FoldTest): Promise<TreeListing> {
    const empty: TreeListing = { files: [], lazy: new Map(), foreign: new Set() };
    if (under || !this._file) {
      return empty;
    }
    const f = await this._file.getFile();
    this._stamp = stampOf(f);
    return { ...empty, files: [{ path: this._file.name, text: await f.text() }] };
  },

  async write(path: string, data: string | Blob){
    if (path === BOARD_PATH) {
      await idbPut(boardKey(this._key!), typeof data === 'string' ? data : await data.text());
      return;
    }
    if (path !== this._file?.name) {
      // Nothing should ever ask (singleNoteRefuses): fail loudly rather than drop it.
      throw new Error(`A single note has nowhere to save “${path}”.`);
    }
    const w = await this._file.createWritable();
    await w.write(data);
    await w.close();
    this._stamp = stampOf(await this._file.getFile());
  },

  async remove(_path: string){},
  async removeDir(_dir: string){},

  async readBlob(path: string): Promise<Blob | null> {
    if (path === BOARD_PATH) {
      const text = this._key ? await idbGet<string>(boardKey(this._key)).catch(() => undefined) : undefined;
      return text == null ? null : new Blob([text], { type: 'application/json' });
    }
    if (this._file && path === this._file.name) {
      return this._file.getFile();
    }
    return null;
  },

  async changed(): Promise<boolean> {
    if (!this._file) {
      return false;
    }
    const before = this._stamp, now = stampOf(await this._file.getFile());
    this._stamp = now;
    return before !== now;
  },

  watch(cb: () => void){ installWatch(cb); },
};
noteStore satisfies Store;
