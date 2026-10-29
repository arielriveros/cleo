// Minimal promise-based store over IndexedDB, for editor persistence that would blow past localStorage's
// ~5MB quota. Two object stores:
//   'kv'       key -> value. The project blob and the asset libraries.
//   'textures' texture payloads keyed by TextureManager id, held as Blobs (see textureStore.ts). Kept out
//              of 'kv' so a library write does not drag megabytes of image data through structured clone.
//   'audio'    sound payloads keyed by AudioManager id, held as Blobs (see audioStore.ts). Separate from
//              'textures' rather than sharing it: the two are enumerated independently (a range scan over
//              one must not deserialize the other's blobs), and a project delete drops them by store.

const DB_NAME = 'cleo';
const STORE = 'kv';
export const TEXTURE_STORE = 'textures';
export const AUDIO_STORE = 'audio';
// 3 added the 'audio' store. The upgrade handler creates whatever is missing, so a v1 or v2 database
// gains it without touching a single existing row.
const VERSION = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    // Runs for a fresh DB and for any older version; all of them end up with every store.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(TEXTURE_STORE)) db.createObjectStore(TEXTURE_STORE);
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
    };
    // Another tab holds the DB open at the old version. Must surface: a silent hang here looks like the
    // editor failing to load.
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
