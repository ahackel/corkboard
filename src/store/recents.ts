// Recent FSA folders — now a thin view over the unified map registry (maps.ts): folder-kind
// MapRefs ARE the recents list. Directory handles still live in IndexedDB (not serializable
// to JSON) under the ref's id. Plus the one-time "seen" set (so the first-open auto-arrange
// never fires twice).
import { idbDel, idbGet } from '../utils/idb.js';
import { readMaps, upsertMap, removeMapRef } from './maps.js';

// A picker returns a new key every time. Collapse only entries for the same directory; names are
// not identities, so two folders called "notes" must both remain reopenable.
export async function rememberFolder(key: string, name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  for (const m of readMaps()) {
    if (m.kind !== 'folder' || m.id === key) {
      continue;
    }
    const prior = await idbGet<FileSystemDirectoryHandle>(m.id).catch(() => undefined);
    if (!prior || !(await handle.isSameEntry(prior))) {
      continue;
    }
    removeMapRef(m.id);
    await idbDel(m.id).catch(() => {});
  }
  upsertMap({ id: key, kind: 'folder', name, when: Date.now() });
}
// Drop a recent folder by its key (registry entry + its stored handle) when it can no longer be opened.
export async function forgetRecent(key: string): Promise<void> {
  removeMapRef(key);
  try { await idbDel(key); } catch {}
}

// The store layer must not render UI. main wires this to renderRecents so the FSA adapter
// can signal "the recents list changed" without reaching into the view layer.
let _onChanged: () => void = () => {};
export function setOnRecentsChanged(fn: () => void): void { _onChanged = fn; }
export function notifyRecentsChanged(): void { _onChanged(); }
