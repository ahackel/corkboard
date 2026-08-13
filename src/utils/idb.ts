// ---- IndexedDB key/value (persists FSA directory handles across sessions) ----
// The File System Access store stows real directory handles here so resume() can
// silently reopen the folder at boot. Plain get/put/del over a single object store.
// Open a single-object-store IndexedDB database, creating the store on first run. Shared by this
// key/value helper and the on-device file vault (store/idb-store.ts) so the open boilerplate lives once.
// IndexedDB is a callback API, so every operation below is the same two-line Promise wrapper around
// either a REQUEST's success/error or a TRANSACTION's complete/error. Those two wrappers, once:
const result = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });

export function openDB(name: string, store: string): Promise<IDBDatabase> {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(store);
  return result(r);
}

// Promise-wrapped single-op transactions over any db/store (shared with store/idb-store.ts). A write
// waits on the TRANSACTION (the value isn't durable until it commits); a read waits on the REQUEST.
export function dbPut(db: IDBDatabase, store: string, key: IDBValidKey, val: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(val, key);
  return done(tx);
}
export function dbGet(db: IDBDatabase, store: string, key: IDBValidKey): Promise<any> {
  return result(db.transaction(store, 'readonly').objectStore(store).get(key));
}
export function dbDel(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
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
  return result(db.transaction(store, 'readonly').objectStore(store).count());
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
  const readTx = from.transaction(store, 'readonly');
  readTx.objectStore(store).openCursor().onsuccess = e => {
    const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (c){ rows.push({ key: c.key, value: c.value }); c.continue(); }
  };
  await done(readTx);
  if (!rows.length) return;
  const writeTx = to.transaction(store, 'readwrite');
  const os = writeTx.objectStore(store);
  for (const r of rows) os.put(r.value, r.key);
  await done(writeTx);
}

const IDB_DB = 'corkboard', LEGACY_IDB_DB = 'mindmap', IDB_STORE = 'handles';
let _idb: Promise<IDBDatabase> | null = null;   // cached, so the migration check runs once per session
const idb = (): Promise<IDBDatabase> => _idb ??= openRenamed(IDB_DB, LEGACY_IDB_DB, IDB_STORE);
export async function idbPut(key: IDBValidKey, val: unknown): Promise<void> { return dbPut(await idb(), IDB_STORE, key, val); }
export async function idbGet(key: IDBValidKey): Promise<any> { return dbGet(await idb(), IDB_STORE, key); }
export async function idbDel(key: IDBValidKey): Promise<void> { return dbDel(await idb(), IDB_STORE, key); }
