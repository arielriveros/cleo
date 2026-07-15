// Minimal promise-based store over IndexedDB. Used for editor persistence (project + libraries) that would
// otherwise blow past localStorage's ~5MB quota.
//
// Two object stores:
//   'kv'       key -> value. The project blob and the asset libraries.
//   'textures' the texture payloads, keyed by TextureManager id. Held as Blobs, NOT base64 — see
//              textureStore.ts. Kept out of 'kv' so a library write doesn't drag megabytes of image data
//              through structured clone with it.

const DB_NAME = 'cleo';
const STORE = 'kv';
export const TEXTURE_STORE = 'textures';
const VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    // Runs for a fresh DB and for an existing v1 (which only has 'kv') — both end up with both stores.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(TEXTURE_STORE)) db.createObjectStore(TEXTURE_STORE);
    };
    // Another tab still holds the DB open at the old version, so the upgrade can't run. Surface it — a
    // silent hang here would look like the editor failing to load.
    req.onblocked = () => reject(new Error('Cleo storage upgrade blocked — close the editor in other tabs and reload'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Read a value by key. Returns null if absent (or on any failure). Values are stored via structured clone. */
export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result ?? null) as T | null);
    req.onerror = () => reject(req.error);
  });
}

/** Write a value by key (structured clone — no JSON.stringify, so large objects avoid a giant string). */
export async function idbSet(key: string, value: any): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Every key in the kv store that starts with `prefix` (e.g. all `cleo_scene:` blobs). */
export async function idbKeysByPrefix(prefix: string): Promise<string[]> {
  const db = await openDB();
  return new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve((req.result as string[]).filter(k => typeof k === 'string' && k.startsWith(prefix)));
    req.onerror = () => reject(req.error);
  });
}

/** Delete a value by key. */
export async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
