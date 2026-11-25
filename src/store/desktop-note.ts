// ONE .md file opened on its own, in the DESKTOP app: store/note.ts reached by the file's PATH (desktop-bridge.ts)
// instead of a permission handle. Same rules — a map of one card, the board kept in IndexedDB under the
// note's key so the file on disk stays exactly the note. Picked by the build (store/index.ts).
import { idbGet, idbPut, idbDel } from '../utils/idb.js';
import { upsertMap, removeMapRef } from './maps.js';
import { notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';
import type { FoldTest } from './tree.js';
import type { Store, PickResult, TreeListing } from './types.js';
import { native, stampText, baseName, keyOfPath, pathOfKey } from './desktop-bridge.js';

const BOARD_PATH = 'board.json';
const NOTE_RE = /\.(md|markdown)$/i;
const boardKey = (key: string): string => 'note-board:' + key;

export const desktopNoteStore = {
  _path: null as string | null,
  _key: null as string | null,
  _stamp: null as string | null,
  singleNote: true as const,
  get isOpen(){ return !!this._path; },
  get name(){ return this._path ? baseName(this._path).replace(NOTE_RE, '') : ''; },
  get currentKey(){ return this._key; },
  get fileName(){ return this._path ? baseName(this._path) : ''; },

  async openPath(path: string): Promise<PickResult> {
    if (!NOTE_RE.test(path) || await native.kindOf(path) !== 'file') {
      return 'gone';
    }
    this._path = path; this._key = keyOfPath(path); this._stamp = null;
    upsertMap({ id: this._key, kind: 'note', name: baseName(path), when: Date.now() });
    notifyRecentsChanged();
    return 'ok';
  },

  // A dropped handle (features/open-drop.ts) is a browser's; the app opens what Finder hands it instead.
  async adopt(_handle: FileSystemFileHandle, _key?: string): Promise<PickResult> { return 'unsupported'; },

  async pick(): Promise<PickResult> {
    const path = await native.pickNote();
    return path ? this.openPath(path) : 'cancel';
  },

  // A remembered note that is not where it was: the dialog, opened where it used to be. The note found
  // takes its board along.
  async relink(key: string): Promise<PickResult> {
    const path = await native.pickNote(pathOfKey(key) ?? undefined);
    if (!path) {
      return 'cancel';
    }
    const r = await this.openPath(path);
    if (r === 'ok' && this._key !== key) {
      const board = await idbGet<string>(boardKey(key)).catch(() => undefined);
      if (board != null) {
        await idbPut(boardKey(this._key!), board);
      }
      await this.forget(key);
      notifyRecentsChanged();
    }
    return r;
  },

  async openRecent(key: string): Promise<PickResult> {
    const path = pathOfKey(key);
    return path ? this.openPath(path) : 'gone';
  },

  async resume(key: string): Promise<boolean> {
    const path = pathOfKey(key);
    if (!path || await native.kindOf(path) !== 'file') {
      return false;
    }
    this._path = path; this._key = key; this._stamp = null;
    return true;
  },

  async forget(key: string): Promise<void> {
    removeMapRef(key);
    await idbDel(boardKey(key)).catch(() => {});
  },

  absolutePath(path: string): string | null {
    return this._path && (!path || path === this.fileName) ? this._path : null;
  },

  async listTree(under: string, _fold: FoldTest): Promise<TreeListing> {
    const empty: TreeListing = { files: [], lazy: new Map(), foreign: new Set() };
    if (under || !this._path) {
      return empty;
    }
    const text = await native.readTextAt(this._path);
    this._stamp = stampText(await native.stat(this._path));
    return { ...empty, files: [{ path: this.fileName, text }] };
  },

  async write(path: string, data: string | Blob){
    const text = typeof data === 'string' ? data : await data.text();
    if (path === BOARD_PATH) {
      await idbPut(boardKey(this._key!), text);
      return;
    }
    if (path !== this.fileName) {
      // Nothing in single-note mode should ever ask (core/state.ts singleNoteRefuses).
      throw new Error(`A single note has nowhere to save “${path}”.`);
    }
    this._stamp = stampText(await native.writeTextAt(this._path!, text));
  },

  async remove(_path: string){},
  async removeDir(_dir: string){},

  async readBlob(path: string): Promise<Blob | null> {
    if (path === BOARD_PATH) {
      const text = this._key ? await idbGet<string>(boardKey(this._key)).catch(() => undefined) : undefined;
      return text == null ? null : new Blob([text], { type: 'application/json' });
    }
    if (this._path && path === this.fileName) {
      return new Blob([await native.readTextAt(this._path)], { type: 'text/markdown' });
    }
    return null;
  },

  async changed(): Promise<boolean> {
    if (!this._path) {
      return false;
    }
    const before = this._stamp;
    this._stamp = stampText(await native.stat(this._path));
    return before !== this._stamp;
  },

  watch(cb: () => void){ installWatch(cb); },
};
desktopNoteStore satisfies Store;
