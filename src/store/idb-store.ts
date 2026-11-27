// The IndexedDB fallback for Safari < 17.2: flat keys `<id>::<path>`; unprefixed keys are the legacy 'vault'.
import type { DeviceStore, PickResult, TreeListing } from './types.js';
import { planTree, type FoldTest } from './tree.js';
import { openRenamed, dbPut, dbGet, dbDel, dbEach } from '../utils/idb.js';
import { MAP_META_FILE, serializeMapMeta, parseMapMetaName } from './maps.js';
import { keepStorage } from './persist.js';

export const idbStore = (() => {
  let _db: IDBDatabase | null = null, _opened = false;
  let _mapId = 'vault', _mapName = 'On-device storage';
  async function db(): Promise<IDBDatabase> {
    return _db ??= await openRenamed('corkboard-vault', 'mindmap-vault', 'files');
  }
  const prefixOf = (id: string): string => id === 'vault' ? '' : id + '::';
  const ownedBy = (key: string, id: string): boolean =>
    id === 'vault' ? !key.includes('::') : key.startsWith(prefixOf(id));

  async function eachKey(cb: (key: string, value: unknown) => void): Promise<void> {
    return dbEach(await db(), 'files', 'readonly', row => cb(row.key as string, row.value));
  }

  const put = async (key: string, data: string | Blob): Promise<void> => dbPut(await db(), 'files', key, data);
  const del = async (key: string): Promise<void> => dbDel(await db(), 'files', key);

  return {
    get isOpen(){ return _opened; },
    get name(){ return _mapName; },

    openMap(id: string, name?: string){
      _mapId = id;
      if (name) {
        _mapName = name;
      }
    },
    async createMap(id: string, name: string){ await put(prefixOf(id) + MAP_META_FILE, serializeMapMeta(name)); },
    async renameMap(id: string, name: string){
      await this.createMap(id, name);
      if (id === _mapId) {
        _mapName = name;
      }
    },
    async deleteMap(id: string){
      await dbEach(await db(), 'files', 'readwrite', row => {
        if (ownedBy(row.key as string, id)) {
          row.delete();
        }
      });
    },
    async listMaps(){
      const ids = new Set<string>(); const names = new Map<string, string>();
      await eachKey((k, v) => {
        const sep = k.indexOf('::');
        const id = sep >= 0 ? k.slice(0, sep) : 'vault';
        ids.add(id);
        if (k === prefixOf(id) + MAP_META_FILE && typeof v === 'string'){
          const name = parseMapMetaName(v);
          if (name) {
            names.set(id, name);
          }
        }
      });
      return [...ids].map(id => ({ id, name: names.get(id) ?? (id === 'vault' ? 'My map' : id) }));
    },

    async pick(): Promise<PickResult> { try { await db(); _opened = true; return 'ok'; } catch { return 'error'; } },
    async listTree(under: string, fold: FoldTest): Promise<TreeListing> {
      const p = prefixOf(_mapId), all = new Map<string, unknown>();
      await eachKey((k, v) => {
        if (!ownedBy(k, _mapId)) {
          return;
        }
        const path = k.slice(p.length);
        if (path.startsWith(under) && !path.split('/').some(s => s.startsWith('.'))) {
          all.set(path, v);
        }
      });
      const plan = planTree([...all.keys()], under, fold);
      return { files: plan.read.map(path => ({ path, text: all.get(path) as string })), lazy: plan.lazy, foreign: plan.foreign, assets: plan.assets };
    },
    async removeDir(): Promise<void> { /* no folders in a flat key space */ },
    async write(path: string, data: string | Blob): Promise<void> { await put(prefixOf(_mapId) + path, data); keepStorage(); },
    async remove(path: string): Promise<void> { try { await del(prefixOf(_mapId) + path); } catch {} },
    async readBlob(path: string): Promise<Blob | null> {
      try {
        const v = await dbGet<string | Blob>(await db(), 'files', prefixOf(_mapId) + path);
        if (!v) {
          return null;
        }
        return v instanceof Blob ? v : new Blob([v], { type: 'text/plain' });
      } catch { return null; }
    },
    watch(){ },
  };
})();
idbStore satisfies DeviceStore;
