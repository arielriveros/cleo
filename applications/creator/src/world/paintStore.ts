// Where the Scratch world's painted masks live between sessions: IndexedDB (localStorage, which holds the
// document, is far too small for a 1024² mask). A saved asset carries its masks as private files instead
// (useCreatorAsset), so this only ever holds the Scratch document's.

const DB = 'cleo_creator_world_paint';
const STORE = 'masks';

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(d => new Promise<T>((resolve, reject) => {
    const req = run(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** The stored pixels of the masks `ids` (missing ones are left out). */
export async function loadScratchMasks(ids: readonly string[]): Promise<Record<string, Float32Array>> {
  const out: Record<string, Float32Array> = {};
  try {
    for (const id of ids) {
      const v = await tx<unknown>('readonly', s => s.get(id));
      if (v instanceof Float32Array) out[id] = v;
    }
  } catch { /* no IndexedDB (private mode): masks start blank */ }
  return out;
}

export async function saveScratchMask(id: string, pixels: Float32Array): Promise<void> {
  try { await tx('readwrite', s => s.put(pixels.slice(), id)); } catch { /* quota or no IndexedDB */ }
}

/** Drop every stored mask but `keep` (the Scratch document's current ones). */
export async function pruneScratchMasks(keep: readonly string[]): Promise<void> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', s => s.getAllKeys());
    const live = new Set(keep);
    for (const k of keys) if (typeof k === 'string' && !live.has(k)) await tx('readwrite', s => s.delete(k));
  } catch { /* nothing to prune */ }
}
