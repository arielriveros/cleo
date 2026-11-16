// Where saves are kept. `SaveGame` talks to one SaveStore, installed by the host:
//   - a published desktop game: files in the app's userData/saves, through the shell's `window.cleoSaves`
//     bridge (applications/app-kit/desktop/gamePreload.js);
//   - a published web game: IndexedDB on the page's origin, under the game's namespace;
//   - the editor's Play (in the editor, or in a window): IndexedDB `cleo-play-saves`, under the project, where
//     the Saves panel reads them;
//   - tests: memory.
// Every store keeps the document as JSON text, so its size is what is actually stored.

import { isValidSlot, slotInfoOf, validateSaveDocument, type SaveDocument, type SaveSlotInfo } from './doc';

export interface SaveStore {
    /** What it is, for diagnostics: 'files', 'indexeddb', 'memory'. */
    readonly kind: string;
    /** Every slot, newest first. A slot that cannot be read is left out. */
    list(): Promise<SaveSlotInfo[]>;
    /** The document in `slot`, or null when there is none. Throws when it is there but unreadable. */
    read(slot: string): Promise<SaveDocument | null>;
    /** Write `doc` to its slot, replacing what was there. */
    write(doc: SaveDocument): Promise<SaveSlotInfo>;
    /** Remove `slot`. Nothing happens when there is none. */
    delete(slot: string): Promise<void>;
}

/** The text layer a store sits on: slots in, JSON text out. */
export interface SaveTextBackend {
    kind: string;
    /** Every stored slot, with its listing entry when the backend keeps one apart from the text. */
    list(): Promise<{ slot: string; info?: SaveSlotInfo }[]>;
    read(slot: string): Promise<string | null>;
    write(slot: string, text: string, info: SaveSlotInfo): Promise<void>;
    remove(slot: string): Promise<void>;
}

function requireSlot(slot: string): void {
    if (!isValidSlot(slot)) throw new Error(`"${slot}" cannot name a save slot: use 1-64 letters, digits, '_', '-' or '.', not starting with '.'.`);
}

const newestFirst = (a: SaveSlotInfo, b: SaveSlotInfo) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0);

/** A SaveStore over a text backend. */
export function createTextSaveStore(backend: SaveTextBackend): SaveStore {
    const parse = (text: string) => validateSaveDocument(JSON.parse(text));
    return {
        kind: backend.kind,
        async list() {
            const out: SaveSlotInfo[] = [];
            for (const entry of await backend.list()) {
                if (!isValidSlot(entry.slot)) continue;
                if (entry.info) { out.push(entry.info); continue; }
                try {
                    const text = await backend.read(entry.slot);
                    if (text) out.push(slotInfoOf({ ...parse(text), slot: entry.slot }, text.length));
                } catch { /* unreadable: not offered as a slot */ }
            }
            return out.sort(newestFirst);
        },
        async read(slot) {
            requireSlot(slot);
            const text = await backend.read(slot);
            if (text === null || text === undefined) return null;
            return { ...parse(text), slot };
        },
        async write(doc) {
            requireSlot(doc.slot);
            const text = JSON.stringify(doc);
            const info = slotInfoOf(doc, text.length);
            await backend.write(doc.slot, text, info);
            return info;
        },
        async delete(slot) {
            requireSlot(slot);
            await backend.remove(slot);
        },
    };
}

/** Saves kept in memory: for tests, and a page with no storage at all. */
export function createMemorySaveStore(): SaveStore {
    const texts = new Map<string, string>();
    return createTextSaveStore({
        kind: 'memory',
        async list() { return [...texts.keys()].map(slot => ({ slot })); },
        async read(slot) { return texts.get(slot) ?? null; },
        async write(slot, text) { texts.set(slot, text); },
        async remove(slot) { texts.delete(slot); },
    });
}

/** What the published desktop shell exposes on `window.cleoSaves` (slot names only, never paths). */
export interface SaveFilesBridge {
    list(): Promise<string[]>;
    read(slot: string): Promise<string | null>;
    write(slot: string, text: string): Promise<void>;
    remove(slot: string): Promise<void>;
}

/** Saves as files, through the desktop shell's bridge. */
export function createBridgeSaveStore(bridge: SaveFilesBridge): SaveStore {
    return createTextSaveStore({
        kind: 'files',
        async list() { return (await bridge.list()).map(slot => ({ slot })); },
        read: slot => bridge.read(slot),
        write: (slot, text) => bridge.write(slot, text),
        remove: slot => bridge.remove(slot),
    });
}

/** Posted on BroadcastChannel {@link SAVES_CHANNEL} by a store made with `notify`, after each change. */
export interface SavesChangedMessage {
    type: 'saves-changed';
    db: string;
    namespace: string;
    slot: string;
    change: 'write' | 'delete';
}

/** The channel the editor's Saves panel listens on. */
export const SAVES_CHANNEL = 'cleo-saves';

export interface IndexedDbSaveStoreOptions {
    /** The database: one per origin is plenty, every game or project under its own namespace. */
    dbName: string;
    /** Whose saves: a game's namespace, or the editor project's id. No '/'. */
    namespace: string;
    /** Announce every change on BroadcastChannel 'cleo-saves' (the editor's Play stores). */
    notify?: boolean;
    /** The IndexedDB factory; the page's by default. */
    indexedDB?: IDBFactory;
}

const DOCS = 'docs';
const META = 'meta';

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('The save was not written (the transaction was aborted).'));
    });
}

/**
 * Saves in IndexedDB: the document text in one object store, its listing entry in another (a slot menu never
 * reads every document). Keys are `<namespace>/<slot>`.
 */
export function createIndexedDbSaveStore(options: IndexedDbSaveStoreOptions): SaveStore {
    const { dbName, notify } = options;
    const namespace = options.namespace.replace(/\//g, '_') || 'game';
    const factory = options.indexedDB ?? (globalThis as any).indexedDB as IDBFactory | undefined;
    let opening: Promise<IDBDatabase> | null = null;
    const open = (): Promise<IDBDatabase> => {
        if (!factory) return Promise.reject(new Error('This browser has no IndexedDB, so the game cannot save.'));
        opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open(dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS);
                if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
            };
            req.onsuccess = () => {
                const db = req.result;
                // Another tab upgrading the database: let it, and open again next time.
                db.onversionchange = () => { db.close(); opening = null; };
                resolve(db);
            };
            req.onerror = () => { opening = null; reject(req.error); };
        });
        return opening;
    };
    const key = (slot: string) => `${namespace}/${slot}`;
    const range = () => IDBKeyRange.bound(`${namespace}/`, `${namespace}/￿`);
    const announce = (slot: string, change: 'write' | 'delete') => {
        if (!notify || typeof BroadcastChannel === 'undefined') return;
        try {
            const channel = new BroadcastChannel(SAVES_CHANNEL);
            const message: SavesChangedMessage = { type: 'saves-changed', db: dbName, namespace, slot, change };
            channel.postMessage(message);
            channel.close();
        } catch { /* nobody to tell */ }
    };

    return createTextSaveStore({
        kind: 'indexeddb',
        async list() {
            const db = await open();
            const tx = db.transaction(META, 'readonly');
            const [keys, infos] = await Promise.all([
                request(tx.objectStore(META).getAllKeys(range())),
                request(tx.objectStore(META).getAll(range())),
            ]);
            return keys.map((k, i) => ({ slot: String(k).slice(namespace.length + 1), info: infos[i] as SaveSlotInfo }));
        },
        async read(slot) {
            const db = await open();
            const text = await request(db.transaction(DOCS, 'readonly').objectStore(DOCS).get(key(slot)));
            return typeof text === 'string' ? text : null;
        },
        async write(slot, text, info) {
            const db = await open();
            const tx = db.transaction([DOCS, META], 'readwrite');
            tx.objectStore(DOCS).put(text, key(slot));
            tx.objectStore(META).put(info, key(slot));
            await done(tx);
            announce(slot, 'write');
        },
        async remove(slot) {
            const db = await open();
            const tx = db.transaction([DOCS, META], 'readwrite');
            tx.objectStore(DOCS).delete(key(slot));
            tx.objectStore(META).delete(key(slot));
            await done(tx);
            announce(slot, 'delete');
        },
    });
}
