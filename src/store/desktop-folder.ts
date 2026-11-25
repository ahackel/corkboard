// A real folder on disk, in the DESKTOP app: the same map a Chrome folder is (store/fsa.ts), reached by its
// PATH through the app's native side (desktop-bridge.ts) instead of a permission handle. So nothing has to be
// granted again and nothing goes stale: a remembered folder opens as long as it is where it was. Picked by
// the build (store/index.ts), never beside fsa.ts at run time.
import { planTree, type FoldTest } from './tree.js';
import { upsertMap } from './maps.js';
import { forgetRecent, notifyRecentsChanged } from './recents.js';
import { installWatch } from './watch.js';
import { imageMimeFor } from '../utils/image-types.js';
import type { Store, PickResult, TreeListing } from './types.js';
import { native, stampText, baseName, keyOfPath, pathOfKey } from './desktop-bridge.js';

export const desktopFolderStore = {
  _root: null as string | null,
  _key: null as string | null,
  // Every file's size + modification time as of the last full load, kept current by this app's own writes,
  // so a refocus can tell whether anything else touched the folder.
  _stamp: null as Map<string, string> | null,
  get isOpen(){ return !!this._root; },
  get name(){ return this._root ? baseName(this._root) : ''; },
  get currentKey(){ return this._key; },

  // The folder at `path` becomes the open map and the first of the recents.
  async openPath(path: string): Promise<PickResult> {
    if (await native.kindOf(path) !== 'dir') {
      return 'gone';
    }
    this._root = path; this._key = keyOfPath(path); this._stamp = null;
    upsertMap({ id: this._key, kind: 'folder', name: baseName(path), when: Date.now() });
    notifyRecentsChanged();
    return 'ok';
  },

  // A dropped handle (features/open-drop.ts) is a browser's; the app opens what Finder hands it instead.
  async adopt(_handle: FileSystemDirectoryHandle): Promise<PickResult> { return 'unsupported'; },

  async pick(): Promise<PickResult> {
    const path = await native.pickFolder();
    return path ? this.openPath(path) : 'cancel';
  },

  // A remembered folder that is not where it was: the dialog, opened where it used to be.
  async relink(key: string): Promise<PickResult> {
    const path = await native.pickFolder(pathOfKey(key) ?? undefined);
    if (!path) {
      return 'cancel';
    }
    const r = await this.openPath(path);
    if (r === 'ok' && this._key !== key) {
      await forgetRecent(key);
    }
    return r;
  },

  async openRecent(key?: string): Promise<PickResult> {
    const path = pathOfKey(key);
    return path ? this.openPath(path) : 'gone';
  },

  // At boot: there is no permission to lose, only a folder that may have gone.
  async resume(key: string): Promise<boolean> {
    const path = pathOfKey(key);
    if (!path || await native.kindOf(path) !== 'dir') {
      return false;
    }
    this._root = path; this._key = key; this._stamp = null;
    return true;
  },

  // Where a note of this map is on disk: what Copy file path copies, and Show in Finder shows.
  absolutePath(path: string): string | null {
    return this._root ? (path ? `${this._root}/${path}` : this._root) : null;
  },

  async listTree(under: string, fold: FoldTest): Promise<TreeListing> {
    const entries = await native.list(this._root!, under);
    const plan = planTree(entries.map(e => e.path), under, fold);
    const texts = await native.readTexts(this._root!, plan.read);
    if (!under) {
      this._stamp = new Map(entries.map(e => [e.path, stampText(e)]));
    }
    return {
      files: plan.read.map((path, i) => ({ path, text: texts[i]! })),
      lazy: plan.lazy, foreign: plan.foreign, assets: plan.assets,
    };
  },

  async write(path: string, data: string | Blob){
    const stamp = typeof data === 'string'
      ? await native.writeText(this._root!, path, data)
      : await native.writeBytes(this._root!, path, new Uint8Array(await data.arrayBuffer()));
    this._stamp?.set(path, stampText(stamp));
  },

  async remove(path: string){
    await native.remove(this._root!, path);
    this._stamp?.delete(path);
  },

  removeDir(dir: string){ return native.removeEmptyDir(this._root!, dir); },

  async readBlob(path: string): Promise<Blob | null> {
    try {
      return new Blob([await native.readBytes(this._root!, path)], { type: imageMimeFor(path) ?? '' });
    } catch {
      return null;
    }
  },

  // Has anything outside this app changed the folder since the last load? Unknown counts as yes.
  async changed(): Promise<boolean> {
    const before = this._stamp;
    const now = new Map((await native.list(this._root!, '')).map(e => [e.path, stampText(e)]));
    this._stamp = now;
    return !before || before.size !== now.size || [...now].some(([p, s]) => before.get(p) !== s);
  },

  watch(cb: () => void){ installWatch(cb); },
};
desktopFolderStore satisfies Store;
