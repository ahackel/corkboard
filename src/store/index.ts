// The store adapters, the single swappable I/O boundary: opfsStore (default), fsaStore (a real folder),
// idbStore (Safari < 17.2) and noteStore (one .md file). Also resolves which on-device store to use.
import { opfsStore } from './opfs.js';
import { idbStore } from './idb-store.js';
import type { DeviceStore } from './types.js';

export type { Store, DeviceStore, NoteFile, PickResult } from './types.js';
export { opfsStore } from './opfs.js';
export { fsaStore } from './fsa.js';
export { noteStore } from './note.js';
export { forgetRecent, setOnRecentsChanged } from './recents.js';
export {
  readMaps, touchMap, getLastMap, setLastMap,
  createDeviceMap, deleteDeviceMap, renameDeviceMap, ensureMapRegistry,
  type MapRef, type MapKind,
} from './maps.js';

// OPFS createWritable arrived in Safari 17.2.
async function opfsCanWrite(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('__writetest__', { create: true });
    const w = await fh.createWritable();
    await w.close();
    await root.removeEntry('__writetest__');
    return true;
  } catch { return false; }
}

let _onDeviceStore: DeviceStore | null = null;
export async function resolveOnDeviceStore(): Promise<DeviceStore> {
  if (_onDeviceStore) {
    return _onDeviceStore;
  }
  _onDeviceStore = await opfsCanWrite() ? opfsStore : idbStore;
  return _onDeviceStore;
}
