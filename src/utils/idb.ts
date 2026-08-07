// ---- IndexedDB key/value (persists FSA directory handles across sessions) ----
// The File System Access store stows real directory handles here so resume() can
// silently reopen the folder at boot. Plain get/put/del over a single object store.
// Open a single-object-store IndexedDB database, creating the store on first run. Shared by this
// key/value helper and the on-device file vault (store/idb-store.ts) so the open boilerplate lives once.
export function openDB(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// Promise-wrapped single-op transactions over any db/store (shared with store/idb-store.ts).
export function dbPut(db: IDBDatabase, store: string, key: IDBValidKey, val: unknown): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export function dbGet(db: IDBDatabase, store: string, key: IDBValidKey): Promise<any> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const g = tx.objectStore(store).get(key);
    g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
  });
}
export function dbDel(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

// ---- one-time rename migration (mindmap → Corkboard) ----
// An IndexedDB database can't be renamed, so the FIRST open of the new name copies every
// entry out of the old one. Guarded on the new store being EMPTY, so it runs exactly once
// and can never overwrite fresher data if an older build is opened in between. The legacy
// database is left in place rather than deleted — it costs nothing and is the fallback if
// the copy ever goes wrong. The localStorage half of the rename is utils/legacy-keys.ts.
export async function openRenamed(name: string, legacy: string, store: string): Promise<IDBDatabase> {
  const db = await openDB(name, store);
  try {
    if (await dbCount(db, store)) return db;      // already populated — nothing to carry over
    if (!(await dbExists(legacy))) return db;
    const old = await openDB(legacy, store);
    await dbCopyAll(old, db, store);
    old.close();
  } catch {}
  return db;
}
function dbCount(db: IDBDatabase, store: string): Promise<number> {
  return new Promise((res, rej) => {
    const c = db.transaction(store, 'readonly').objectStore(store).count();
    c.onsuccess = () => res(c.result); c.onerror = () => rej(c.error);
  });
}
// `indexedDB.databases()` is missing on older Safari/Firefox, where merely OPENING the legacy
// name would create it. Assume it exists there and let the copy find it empty instead.
async function dbExists(name: string): Promise<boolean> {
  try { const list = await indexedDB.databases?.(); return list ? list.some(d => d.name === name) : true; }
  catch { return true; }
}
// Read fully, then write. A cursor over the source and puts into the target are two separate
// transactions on two databases; interleaving them lets the write tx auto-commit mid-walk.
async function dbCopyAll(from: IDBDatabase, to: IDBDatabase, store: string): Promise<void> {
  const rows: { key: IDBValidKey; value: unknown }[] = [];
  await new Promise<void>((res, rej) => {
    const tx = from.transaction(store, 'readonly');
    tx.objectStore(store).openCursor().onsuccess = e => {
      const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (c){ rows.push({ key: c.key, value: c.value }); c.continue(); }
    };
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
  if (!rows.length) return;
  await new Promise<void>((res, rej) => {
    const tx = to.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const r of rows) os.put(r.value, r.key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

const IDB_DB = 'corkboard', LEGACY_IDB_DB = 'mindmap', IDB_STORE = 'handles';
let _idb: Promise<IDBDatabase> | null = null;   // cached, so the migration check runs once per session
const idb = (): Promise<IDBDatabase> => _idb ??= openRenamed(IDB_DB, LEGACY_IDB_DB, IDB_STORE);
export async function idbPut(key: IDBValidKey, val: unknown): Promise<void> { return dbPut(await idb(), IDB_STORE, key, val); }
export async function idbGet(key: IDBValidKey): Promise<any> { return dbGet(await idb(), IDB_STORE, key); }
export async function idbDel(key: IDBValidKey): Promise<void> { return dbDel(await idb(), IDB_STORE, key); }
