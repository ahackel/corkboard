// IndexedDB key/value: FSA directory handles persist here so the folder silently reopens at boot.
const whenRequest = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const whenCommitted = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });

export function openDB(name: string, store: string): Promise<IDBDatabase> {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(store);
  return whenRequest(r);
}

// A write waits on the TRANSACTION (not durable until it commits); a read waits on the REQUEST.
export function dbPut(db: IDBDatabase, store: string, key: IDBValidKey, val: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(val, key);
  return whenCommitted(tx);
}

// The CALLER names the stored value's type.
export function dbGet<T = unknown>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return whenRequest(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export function dbDel(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return whenCommitted(tx);
}

// In 'readwrite' mode `visit` may delete the row it is on.
export function dbEach(db: IDBDatabase, store: string, mode: IDBTransactionMode,
    visit: (row: IDBCursorWithValue) => void): Promise<void> {
  const tx = db.transaction(store, mode);
  tx.objectStore(store).openCursor().onsuccess = e => {
    const row = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (row) {
      visit(row);
      row.continue();
    }
  };
  return whenCommitted(tx);
}

// A database can't be renamed, so the first open copies the legacy one over, only into an EMPTY store
// (never over fresher data). The legacy database is kept as a fallback.
export async function openRenamed(name: string, legacy: string, store: string): Promise<IDBDatabase> {
  const db = await openDB(name, store);
  try {
    if (await dbCount(db, store)) {
      return db;
    }
    if (!(await dbExists(legacy))) {
      return db;
    }
    const old = await openDB(legacy, store);
    await dbCopyAll(old, db, store);
    old.close();
  } catch {}
  return db;
}

function dbCount(db: IDBDatabase, store: string): Promise<number> {
  return whenRequest(db.transaction(store, 'readonly').objectStore(store).count());
}

// `indexedDB.databases()` is missing on older Safari/Firefox, where merely OPENING the legacy name would
// create it; assume it exists and let the copy find it empty.
async function dbExists(name: string): Promise<boolean> {
  try { const list = await indexedDB.databases?.(); return list ? list.some(d => d.name === name) : true; }
  catch { return true; }
}

// Read fully, then write: interleaving the two databases' transactions lets the write auto-commit mid-walk.
async function dbCopyAll(from: IDBDatabase, to: IDBDatabase, store: string): Promise<void> {
  const rows: Array<{ key: IDBValidKey; value: unknown }> = [];
  await dbEach(from, store, 'readonly', row => rows.push({ key: row.key, value: row.value }));
  if (!rows.length) {
    return;
  }
  const writeTx = to.transaction(store, 'readwrite');
  const os = writeTx.objectStore(store);
  for (const r of rows) {
    os.put(r.value, r.key);
  }
  await whenCommitted(writeTx);
}

const IDB_DB = 'corkboard', LEGACY_IDB_DB = 'mindmap', IDB_STORE = 'handles';
let _idb: Promise<IDBDatabase> | null = null;
const idb = (): Promise<IDBDatabase> => _idb ??= openRenamed(IDB_DB, LEGACY_IDB_DB, IDB_STORE);

export async function idbPut(key: IDBValidKey, val: unknown): Promise<void> { return dbPut(await idb(), IDB_STORE, key, val); }

export async function idbGet<T = unknown>(key: IDBValidKey): Promise<T | undefined> { return dbGet<T>(await idb(), IDB_STORE, key); }

export async function idbDel(key: IDBValidKey): Promise<void> { return dbDel(await idb(), IDB_STORE, key); }
