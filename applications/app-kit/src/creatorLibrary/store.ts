// The Creator library's storage: its own IndexedDB database, `cleo_creator`, beside the editor's `cleo`.
//
// Its own database rather than a store in `cleo`: adding one there means a version bump, which an editor
// tab still open at the old version blocks, and a project delete sweeps `cleo` by prefix. Two stores:
//   'assets'  id -> CreatorAssetMeta. Small; listing reads only this.
//   'files'   `${id}/${name}` -> { mime, blob }. The payloads, read only for the asset being imported.
//
// The backend is an interface so the tests run on a Map; the browser uses IndexedDB.

import { creatorChannel } from './channel';
import type { CreatorAssetKind, CreatorAssetMeta, CreatorFile } from './types';

export interface CreatorBackend {
  all(): Promise<CreatorAssetMeta[]>;
  get(id: string): Promise<CreatorAssetMeta | null>;
  files(id: string, names: string[]): Promise<CreatorFile[]>;
  /** One atomic write: the meta, the files given, and the file names to drop. */
  write(meta: CreatorAssetMeta, put: CreatorFile[], drop: string[]): Promise<void>;
}

// --- IndexedDB ------------------------------------------------------------------------------------

const DB_NAME = 'cleo_creator';
const VERSION = 1;
const ASSETS = 'assets';
const FILES = 'files';

let dbPromise: Promise<IDBDatabase> | null = null;
function openCreatorDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    req.onblocked = () => reject(new Error('Creator library upgrade blocked: close Cleo in other tabs and reload'));
    req.onsuccess = () => {
      const db = req.result;
      // A later version opening elsewhere: step aside rather than block it.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});
const result = <T>(req: IDBRequest) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result as T);
  req.onerror = () => reject(req.error);
});

export const indexedDbBackend: CreatorBackend = {
  async all() {
    const db = await openCreatorDB();
    return result<CreatorAssetMeta[]>(db.transaction(ASSETS, 'readonly').objectStore(ASSETS).getAll());
  },
  async get(id) {
    const db = await openCreatorDB();
    return (await result<CreatorAssetMeta | undefined>(db.transaction(ASSETS, 'readonly').objectStore(ASSETS).get(id))) ?? null;
  },
  async files(id, names) {
    const db = await openCreatorDB();
    const store = db.transaction(FILES, 'readonly').objectStore(FILES);
    const out: CreatorFile[] = [];
    for (const name of names) {
      const row = await result<{ mime: string; blob: Blob } | undefined>(store.get(`${id}/${name}`));
      if (row) out.push({ name, mime: row.mime, blob: row.blob });
    }
    return out;
  },
  async write(meta, put, drop) {
    const db = await openCreatorDB();
    const tx = db.transaction([ASSETS, FILES], 'readwrite');
    const files = tx.objectStore(FILES);
    for (const name of drop) files.delete(`${meta.id}/${name}`);
    for (const f of put) files.put({ mime: f.mime, blob: f.blob }, `${meta.id}/${f.name}`);
    tx.objectStore(ASSETS).put(meta, meta.id);
    return done(tx);
  },
};

/** A backend on a Map: the tests', and anywhere IndexedDB is missing. */
export function memoryBackend(): CreatorBackend {
  const assets = new Map<string, CreatorAssetMeta>();
  const files = new Map<string, CreatorFile>();
  return {
    async all() { return [...assets.values()].map(m => structuredClone(m)); },
    async get(id) { const m = assets.get(id); return m ? structuredClone(m) : null; },
    async files(id, names) { return names.map(n => files.get(`${id}/${n}`)).filter((f): f is CreatorFile => !!f); },
    async write(meta, put, drop) {
      for (const n of drop) files.delete(`${meta.id}/${n}`);
      for (const f of put) files.set(`${meta.id}/${f.name}`, f);
      assets.set(meta.id, structuredClone(meta));
    },
  };
}

let backend: CreatorBackend | null = null;
const current = () => backend ?? (backend = typeof indexedDB === 'undefined' ? memoryBackend() : indexedDbBackend);
/** Swap the storage (tests). */
export function setCreatorBackend(b: CreatorBackend | null): void { backend = b; }

// --- API ------------------------------------------------------------------------------------------

/** Every asset, tombstones included (a reader needs them to retire its copies), oldest first. */
export async function listCreatorAssets(): Promise<CreatorAssetMeta[]> {
  return (await current().all()).sort((a, b) => a.updatedAt - b.updatedAt);
}

export async function getCreatorAsset(id: string): Promise<CreatorAssetMeta | null> {
  return current().get(id);
}

/** An asset's importable files (or the named ones). */
export async function getCreatorFiles(id: string, names?: string[]): Promise<CreatorFile[]> {
  const meta = await current().get(id);
  if (!meta || meta.deleted) return [];
  return current().files(id, names ?? meta.fileNames);
}

/** A fresh asset id. */
export function newCreatorAssetId(kind: CreatorAssetKind): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${kind}_${Date.now().toString(36)}${rnd}`;
}

export interface CreatorAssetInput {
  id: string;
  kind: CreatorAssetKind;
  name: string;
  doc: unknown;
  sidecar: Record<string, unknown> | null;
  /** Every file the editor imports: replaces the asset's previous set. */
  files: CreatorFile[];
  /** Files only the Creator reads back; replaces the previous private set. */
  privateFiles?: CreatorFile[];
  /** Of the files and the document; equal to the stored one -> nothing is written or announced. */
  contentHash: string;
  /** A new thumbnail; absent keeps the stored one. Never part of the hash. */
  thumbnail?: string;
}

/**
 * Create or replace an asset. Returns the stored meta, or null when nothing changed (same hash and name).
 * Announces the new revision on the channel once the write has committed.
 */
export async function putCreatorAsset(input: CreatorAssetInput): Promise<CreatorAssetMeta | null> {
  const b = current();
  const prev = await b.get(input.id);
  if (prev && !prev.deleted && prev.contentHash === input.contentHash && prev.name === input.name) {
    // Only the picture changed: stored quietly, no new revision (nothing the editor imports moved).
    if (input.thumbnail && input.thumbnail !== prev.thumbnail) await b.write({ ...prev, thumbnail: input.thumbnail }, [], []);
    return null;
  }
  const privateFiles = input.privateFiles ?? [];
  const meta: CreatorAssetMeta = {
    id: input.id, kind: input.kind, name: input.name, doc: input.doc,
    revision: (prev?.revision ?? 0) + 1, contentHash: input.contentHash, updatedAt: Date.now(),
    sidecar: input.sidecar, fileNames: input.files.map(f => f.name), privateFileNames: privateFiles.map(f => f.name),
    ...(prev?.folder ? { folder: prev.folder } : {}),
    ...(input.thumbnail ?? prev?.thumbnail ? { thumbnail: input.thumbnail ?? prev?.thumbnail } : {}),
  };
  const keep = new Set([...meta.fileNames, ...meta.privateFileNames]);
  const drop = prev ? [...prev.fileNames, ...prev.privateFileNames].filter(n => !keep.has(n)) : [];
  await b.write(meta, [...input.files, ...privateFiles], drop);
  creatorChannel().post({ type: 'upsert', id: meta.id, revision: meta.revision });
  return meta;
}

/** Rename an asset (a new revision: the editor renames its copies). */
export async function renameCreatorAsset(id: string, name: string): Promise<CreatorAssetMeta | null> {
  const b = current();
  const prev = await b.get(id);
  if (!prev || prev.deleted || prev.name === name) return null;
  const meta = { ...prev, name, revision: prev.revision + 1, updatedAt: Date.now() };
  await b.write(meta, [], []);
  creatorChannel().post({ type: 'upsert', id, revision: meta.revision });
  return meta;
}

/**
 * File an asset in a folder of the Creator explorer ('' for the tool's root). Only the explorer cares, so
 * no new revision: an editor project does not re-import the asset for it. Announced so other windows'
 * explorers follow.
 */
export async function moveCreatorAsset(id: string, folder: string): Promise<void> {
  const b = current();
  const prev = await b.get(id);
  const clean = folder.split('/').filter(Boolean).join('/');
  if (!prev || prev.deleted || (prev.folder ?? '') === clean) return;
  await b.write({ ...prev, folder: clean || undefined }, [], []);
  creatorChannel().post({ type: 'upsert', id, revision: prev.revision });
}

/** A copy of an asset under a new name and id, in the same folder: its document, files and thumbnail. */
export async function duplicateCreatorAsset(id: string, name: string): Promise<CreatorAssetMeta | null> {
  const b = current();
  const prev = await b.get(id);
  if (!prev || prev.deleted) return null;
  const files = await b.files(id, prev.fileNames);
  const privateFiles = await b.files(id, prev.privateFileNames);
  const copy = await putCreatorAsset({
    id: newCreatorAssetId(prev.kind), kind: prev.kind, name, doc: prev.doc, sidecar: prev.sidecar,
    files, privateFiles, contentHash: prev.contentHash, thumbnail: prev.thumbnail,
  });
  if (copy && prev.folder) await moveCreatorAsset(copy.id, prev.folder);
  return copy ? (await b.get(copy.id)) : null;
}

/** Delete an asset: its files go, a tombstone stays so every project learns it is gone. */
export async function deleteCreatorAsset(id: string): Promise<void> {
  const b = current();
  const prev = await b.get(id);
  if (!prev || prev.deleted) return;
  const meta: CreatorAssetMeta = {
    ...prev, revision: prev.revision + 1, updatedAt: Date.now(), deleted: true,
    doc: null, sidecar: null, fileNames: [], privateFileNames: [], contentHash: '',
  };
  await b.write(meta, [], [...prev.fileNames, ...prev.privateFileNames]);
  creatorChannel().post({ type: 'delete', id, revision: meta.revision });
}

/** FNV-1a over byte chunks: the content hash `putCreatorAsset` compares. */
export function hashChunks(chunks: Iterable<ArrayLike<number>>): string {
  let h = 0x811c9dc5;
  for (const bytes of chunks) {
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i] & 0xff; h = Math.imul(h, 0x01000193); }
    h ^= 0xff; h = Math.imul(h, 0x01000193);   // chunk boundary, so ["ab","c"] != ["a","bc"]
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
