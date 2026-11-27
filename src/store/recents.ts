// Recent FSA folders: the registry's folder-kind entries, their handles in IndexedDB under the same id.
import { idbDel, idbGet } from '../utils/idb.js';
import { readMaps, upsertMap, removeMapRef } from './maps.js';
import { sameEntry } from './permission.js';

// Collapses entries for the same directory, never by name: two "notes" folders both stay reopenable.
export async function rememberFolder(key: string, name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  for (const m of readMaps()) {
    if (m.kind !== 'folder' || m.id === key) {
      continue;
    }
    const prior = await idbGet<FileSystemDirectoryHandle>(m.id).catch(() => undefined);
    if (!prior || !(await sameEntry(handle, prior))) {
      continue;
    }
    removeMapRef(m.id);
    await idbDel(m.id).catch(() => {});
  }
  upsertMap({ id: key, kind: 'folder', name, when: Date.now() });
}
export async function forgetRecent(key: string): Promise<void> {
  removeMapRef(key);
  try { await idbDel(key); } catch {}
}

// The store layer must not render UI.
let _onChanged: () => void = () => {};
export function setOnRecentsChanged(fn: () => void): void { _onChanged = fn; }
export function notifyRecentsChanged(): void { _onChanged(); }
