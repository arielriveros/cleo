// Play in window: where the editor leaves the game's bytes for the game window to pick up.
//
// IndexedDB, because both windows share the origin and the browser session on the desktop and on the web,
// and because a packed game can be hundreds of megabytes: a structured-clone put of one ArrayBuffer never
// builds a string. A database of its OWN ('cleo-play'), never the editor's 'cleo': a page that opens a
// database at an older version than another page's blocks that page's upgrade, and the game window has no
// business holding the project's database open at all.
//
// Two stores, so housekeeping never reads a game: 'bytes' (id -> ArrayBuffer) and 'meta' (id -> written-at).
// IndexedDB has no projection, and walking records that hold the buffers would deserialize every one.
//
// No DOM, no engine, no React: the project worker writes here (workers/projectJobs.ts 'playPack').

const DB_NAME = 'cleo-play';
const BYTES = 'bytes';
const META = 'meta';
const VERSION = 1;

/** Leftovers older than this are dropped when an editor starts (a window that crashed, an editor killed). */
export const STALE_SESSION_MS = 6 * 60 * 60 * 1000;

function open(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BYTES)) db.createObjectStore(BYTES);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onblocked = () => reject(new Error('The play-session store is held open at another version'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** One transaction on a fresh connection, closed after: each side touches the store a handful of times. */
async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = body(tx);
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Store a session's packed game (replacing what was there: Restart reuses the id). */
export async function putPlaySession(id: string, buffer: ArrayBuffer, now: number = Date.now()): Promise<void> {
  await run([BYTES, META], 'readwrite', tx => {
    tx.objectStore(BYTES).put(buffer, id);
    tx.objectStore(META).put(now, id);
  });
}

/** A session's packed game, or null when there is none (not built yet, or already dropped). */
export async function getPlaySession(id: string): Promise<ArrayBuffer | null> {
  const buffer = await run<unknown>([BYTES], 'readonly', tx => tx.objectStore(BYTES).get(id));
  return buffer instanceof ArrayBuffer ? buffer : null;
}

export async function deletePlaySession(id: string): Promise<void> {
  await run([BYTES, META], 'readwrite', tx => {
    tx.objectStore(BYTES).delete(id);
    tx.objectStore(META).delete(id);
  });
}

/** The ids written more than `maxAge` before `now` (or with no usable date). Pure, for the tests. */
export function staleSessionIds(entries: ReadonlyArray<{ id: string; createdAt: number }>, now: number, maxAge: number = STALE_SESSION_MS): string[] {
  return entries.filter(e => !(Number.isFinite(e.createdAt) && now - e.createdAt <= maxAge)).map(e => e.id);
}

/**
 * Drop sessions nobody can still want. Age-based rather than "everything": a second editor tab on the same
 * origin may be running a game right now, and its window reads its bytes again on every restart. Bytes with
 * no date (a write that died between the two stores) go too.
 */
export async function purgeStalePlaySessions(now: number = Date.now()): Promise<number> {
  const db = await open();
  try {
    const [ids, dates, byteIds] = await new Promise<[IDBValidKey[], unknown[], IDBValidKey[]]>((resolve, reject) => {
      const tx = db.transaction([BYTES, META], 'readonly');
      const keys = tx.objectStore(META).getAllKeys();
      const values = tx.objectStore(META).getAll();
      const bytes = tx.objectStore(BYTES).getAllKeys();
      tx.oncomplete = () => resolve([keys.result, values.result, bytes.result]);
      tx.onerror = () => reject(tx.error);
    });
    const entries = ids.map((id, i) => ({ id: String(id), createdAt: Number(dates[i]) }));
    const dated = new Set(entries.map(e => e.id));
    const stale = [...staleSessionIds(entries, now), ...byteIds.map(String).filter(id => !dated.has(id))];
    if (stale.length === 0) return 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BYTES, META], 'readwrite');
      for (const id of stale) { tx.objectStore(BYTES).delete(id); tx.objectStore(META).delete(id); }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return stale.length;
  } finally {
    db.close();
  }
}
