// ONE .md file opened on its own (File System Access, Chrome/Edge): a map that is a single card.
//
// The map is that one note and nothing else, so the tree this store lists holds exactly one path, the
// file's own name. There is no folder to put a second card, a picture or a board.json in: the board
// (the card's size, the grid, the canvas colour) is kept in IndexedDB under the file's key instead, so
// the note on disk stays exactly the note. Nothing may add a card beside it or take it away
// (core/state.ts singleNoteRefuses), and its filename never follows its title (data/save.ts planPaths).
import { idbGet, idbPut, idbDel } from '../utils/idb.js';
import { readMaps, upsertMap, removeMapRef } from './maps.js';
import { notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';
import { stampOf } from './handle-store.js';
import type { FoldTest } from './tree.js';
import type { Store, PickResult, TreeListing } from './types.js';

// The FSA permission API and window.showOpenFilePicker aren't in lib.dom.
interface Permable {
  queryPermission(d: { mode: string }): Promise<PermissionState>;
  requestPermission(d: { mode: string }): Promise<PermissionState>;
}
type FilePicker = (opts?: {
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
  excludeAcceptAllOption?: boolean; multiple?: boolean;
}) => Promise<FileSystemFileHandle[]>;
const showOpenFilePicker = (window as Window & { showOpenFilePicker?: FilePicker }).showOpenFilePicker;

// The board's stand-in for the board.json a folder would hold — the only other path this store answers.
const BOARD_PATH = 'board.json';
const boardKey = (key: string): string => 'note-board:' + key;
const RW = { mode: 'readwrite' };

async function rememberedHandle(key: string): Promise<FileSystemFileHandle | undefined> {
  try {
    return await idbGet<FileSystemFileHandle>(key);
  } catch {
    return undefined;
  }
}

// The key a file was opened under before, so reopening it finds its board again; else a fresh one.
async function keyFor(handle: FileSystemFileHandle): Promise<string> {
  for (const m of readMaps()) {
    if (m.kind !== 'note') {
      continue;
    }
    const prior = await rememberedHandle(m.id);
    if (prior && await handle.isSameEntry(prior)) {
      return m.id;
    }
  }
  return 'note:' + handle.name + ':' + Date.now();
}

export const noteStore = {
  _file: null as FileSystemFileHandle | null,
  _key: null as string | null,
  // The file as this app last saw it (size + modification time), so a refocus can tell whether
  // anything else touched it.
  _stamp: null as string | null,
  singleNote: true as const,
  get isOpen(){ return !!this._file; },
  get name(){ return this._file ? this._file.name.replace(/\.(md|markdown)$/i, '') : ''; },
  get currentKey(){ return this._key; },

  async _adopt(handle: FileSystemFileHandle): Promise<PickResult> {
    const h = handle as unknown as Permable;
    if ((await h.queryPermission(RW)) !== 'granted' && (await h.requestPermission(RW)) !== 'granted') {
      return 'denied';
    }
    const key = await keyFor(handle);
    await idbPut(key, handle);
    upsertMap({ id: key, kind: 'note', name: handle.name, when: Date.now() });
    notifyRecentsChanged();
    this._file = handle; this._key = key; this._stamp = null;
    return 'ok';
  },

  // Pick a note file (needs a user gesture).
  async pick(): Promise<PickResult> {
    if (!showOpenFilePicker) {
      return 'unsupported';
    }
    let handle: FileSystemFileHandle | undefined;
    try {
      [handle] = await showOpenFilePicker({
        types: [{ description: 'Markdown note', accept: { 'text/markdown': ['.md', '.markdown'] } }],
        multiple: false,
      });
    } catch (e) { return (e as DOMException).name === 'AbortError' ? 'cancel' : 'error'; }
    return handle ? this._adopt(handle) : 'cancel';
  },

  // Reopen a remembered note by its key (the click is the gesture for the permission prompt).
  async openRecent(key: string): Promise<PickResult> {
    const handle = await rememberedHandle(key);
    return handle ? this._adopt(handle) : 'gone';
  },

  // Silent reopen at boot — only if read-write permission is still granted.
  async resume(key: string): Promise<boolean> {
    const handle = await rememberedHandle(key);
    if (!handle) {
      return false;
    }
    try {
      if ((await (handle as unknown as Permable).queryPermission(RW)) !== 'granted') {
        return false;
      }
    } catch { return false; }
    this._file = handle; this._key = key; this._stamp = null;
    return true;
  },

  // Forget a remembered note: its registry entry, its handle and its board.
  async forget(key: string): Promise<void> {
    removeMapRef(key);
    await idbDel(key).catch(() => {});
    await idbDel(boardKey(key)).catch(() => {});
  },

  // The one note. A section's folder can't exist here, so asking under one finds nothing.
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
      // Nothing in single-note mode should ever ask (core/state.ts singleNoteRefuses): fail loudly
      // rather than drop what was meant for it.
      throw new Error(`A single note has nowhere to save “${path}”.`);
    }
    const w = await this._file.createWritable();
    await w.write(data);
    await w.close();
    this._stamp = stampOf(await this._file.getFile());
  },

  // The note itself is never removed from here, and there is nothing else on disk to remove.
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

  // Has anything outside this app changed the file since the last read or write? Unknown counts as yes.
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
