// The OPFS adapter, the local-first default. Each map is a directory: maps/<id>/, or the legacy root
// 'vault/' as the map with id 'vault'.
import { listTree, removeEmptyDir, writeFile, removeFile, readFileBlob } from './handle-store.js';
import type { FoldTest } from './tree.js';
import { MAP_META_FILE, serializeMapMeta, parseMapMetaName } from './maps.js';
import type { DeviceStore, PickResult } from './types.js';
import { keepStorage } from './persist.js';

// Only another tab can change OPFS underneath us: each write tells the others which map it touched.
const otherTabs = new BroadcastChannel('corkboard-opfs');
const OTHER_TAB_SETTLE_MS = 300;

export const opfsStore = {
  _dir: null as FileSystemDirectoryHandle | null,
  _opened: false,
  _mapId: 'vault',
  _mapName: 'On-device storage',
  get isOpen(){ return this._opened; },
  get name(){ return this._mapName; },

  async _mapDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    if (id === 'vault') {
      return root.getDirectoryHandle('vault', { create });
    }
    const maps = await root.getDirectoryHandle('maps', { create: true });
    return maps.getDirectoryHandle(id, { create });
  },
  async _root(): Promise<FileSystemDirectoryHandle> {
    return this._dir ??= await this._mapDir(this._mapId, true);
  },

  // Cheap: the dir handle is re-resolved lazily.
  openMap(id: string, name?: string): void {
    if (id !== this._mapId){ this._mapId = id; this._dir = null; this._opened = false; }
    if (name) {
      this._mapName = name;
    }
  },
  async createMap(id: string, name: string): Promise<void> {
    const d = await this._mapDir(id, true);
    await writeFile(d, MAP_META_FILE, serializeMapMeta(name));
  },
  async deleteMap(id: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      if (id === 'vault') {
        await root.removeEntry('vault', { recursive: true });
      } else {
        await (await root.getDirectoryHandle('maps')).removeEntry(id, { recursive: true });
      }
    } catch { /* already gone */ }
    if (id === this._mapId){ this._dir = null; this._opened = false; }
  },
  async renameMap(id: string, name: string): Promise<void> {
    await this.createMap(id, name);   // rename IS a meta rewrite
    if (id === this._mapId) {
      this._mapName = name;
    }
  },
  async listMaps(): Promise<Array<{ id: string; name: string }>> {
    const nameOf = async (d: FileSystemDirectoryHandle, fallback: string): Promise<string> => {
      const blob = await readFileBlob(d, MAP_META_FILE);
      return (blob && parseMapMetaName(await blob.text())) || fallback;
    };
    const dirs: Array<{ id: string; handle: FileSystemDirectoryHandle; fallback: string }> = [];
    const root = await navigator.storage.getDirectory();
    try { dirs.push({ id: 'vault', handle: await root.getDirectoryHandle('vault'), fallback: 'My map' }); } catch {}
    try {
      const maps = await root.getDirectoryHandle('maps');
      for await (const [id, h] of maps.entries()) {
        if (h.kind === 'directory') {
          dirs.push({ id, handle: h as FileSystemDirectoryHandle, fallback: id });
        }
      }
    } catch {}
    return Promise.all(dirs.map(async d => ({ id: d.id, name: await nameOf(d.handle, d.fallback) })));
  },

  async pick(): Promise<PickResult> { try { await this._root(); this._opened = true; return 'ok'; } catch { return 'error'; } },
  async listTree(under: string, fold: FoldTest){ return listTree(await this._root(), under, fold); },
  async removeDir(dir: string){ return removeEmptyDir(await this._root(), dir); },
  async write(path: string, data: string | Blob){ await writeFile(await this._root(), path, data); keepStorage(); otherTabs.postMessage(this._mapId); },
  async remove(path: string){ await removeFile(await this._root(), path); otherTabs.postMessage(this._mapId); },
  async readBlob(path: string){ return readFileBlob(await this._root(), path); },
  // A save is a burst of writes: reload once it has settled.
  watch(cb: () => void){
    let wait: number | undefined;
    otherTabs.onmessage = e => {
      if (e.data === this._mapId && this._opened) {
        clearTimeout(wait);
        wait = window.setTimeout(cb, OTHER_TAB_SETTLE_MS);
      }
    };
  },
};
opfsStore satisfies DeviceStore;
