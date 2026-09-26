/**
 * Ephemeral IndexedDB store for conversion results.
 *
 * Lives only until the next page load: `openStore()` always nukes the old database first,
 * so nothing survives a refresh. This is intentional — the store is a temporary holding
 * area, not a persistent cache.
 *
 * Each result is keyed by the FileEntry.id it belongs to. Live Photo companions are stored
 * alongside the primary blob via a second key (`{id}/companion`).
 */

const DB_NAME = 'web-format-factory-results';
const STORE_NAME = 'results';
const DB_VERSION = 1;

interface ResultRecord {
  id: string;
  blob: Blob;
  name: string;
  size: number;
}

function nuke(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      // Another tab holds the DB open. Close it and try again.
      // In practice this is the same origin so the other tab is us — but if the user
      // has two tabs open the second one will block. We don't retry; the conversion
      // that follows will catch the error.
      reject(new Error('数据库被其他标签页占用'));
    };
  });
}

function createStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Open the results store, destroying any previous database first.
 *
 * Call this once at app startup. It is idempotent in the sense that calling it again
 * will nuke and recreate — but you shouldn't call it again while results are in flight.
 */
export async function openStore(): Promise<IDBDatabase> {
  await nuke();
  return createStore();
}

/** Companion entries are keyed under `{id}/companion` to avoid colliding with primary blobs. */
export function companionKey(id: string): string {
  return `${id}/companion`;
}

/** Write a single result blob to the store. */
export function putResult(
  db: IDBDatabase,
  id: string,
  blob: Blob,
  name: string,
  size: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readwrite');
    const store = txn.objectStore(STORE_NAME);
    const req = store.put({ id, blob, name, size } satisfies ResultRecord);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Write a companion blob (Live Photo second file), keyed under `{id}/companion`. */
export function putCompanion(
  db: IDBDatabase,
  id: string,
  blob: Blob,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readwrite');
    const store = txn.objectStore(STORE_NAME);
    const req = store.put({
      id: companionKey(id),
      blob,
      name,
      size: blob.size,
    } satisfies ResultRecord);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Read a result back. Returns null when the id is not in the store. */
export function getResult(
  db: IDBDatabase,
  id: string,
): Promise<{ blob: Blob; name: string; size: number } | null> {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readonly');
    const store = txn.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const record = req.result as ResultRecord | undefined;
      if (!record) {
        resolve(null);
        return;
      }
      resolve({ blob: record.blob, name: record.name, size: record.size });
    };
    req.onerror = () => reject(req.error);
  });
}

/** Remove a single result (and its companion, if any) from the store. */
export function deleteResult(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readwrite');
    const store = txn.objectStore(STORE_NAME);
    const req1 = store.delete(id);
    const req2 = store.delete(companionKey(id));
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
    // Touch req1/req2 so tsc doesn't complain about unused variables.
    void req1;
    void req2;
  });
}