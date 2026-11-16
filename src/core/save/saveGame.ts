// The facade a script saves and loads through: `import { SaveGame } from 'cleo'`. Same shape and reason as
// `Game` and `Input`: one object, forwarding to the session (session.ts) and the store the host installed.

import { CleoEngine } from '../engine';
import { Game, loadSceneInternal, type LoadSceneOptions } from '../game';
import { Logger } from '../logger';
import { SAVE_FORMAT, SAVE_FORMAT_VERSION, isValidSlot, migrateSaveDocument, type SaveDocument, type SaveMigrator, type SaveSlotInfo } from './doc';
import type { SaveStore } from './stores';
import { beginSaveSessionFrom, clearSaveSession, onSaveSessionReset, rememberScene, saveSession, sessionPlayTime } from './session';
import { cloneGlobal, decodeSaveValue } from './values';

let store: SaveStore | null = null;
/** The game's own save version (Project ▸ General ▸ Saves), written into every save. */
let gameVersion = 0;
const migrators: SaveMigrator[] = [];
let loading = false;

onSaveSessionReset(() => {
    migrators.length = 0;
    loading = false;
});

/** Options a host installs a store with. */
export interface SaveStoreOptions {
    /** The game's save version, written into each save and migrated from on load. */
    gameVersion?: number;
}

/** Install (or clear, with null) where saves go. Called by the player and the editor's play mode. */
export function setSaveStore(next: SaveStore | null, options: SaveStoreOptions = {}): void {
    store = next;
    if (options.gameVersion !== undefined) gameVersion = Number.isFinite(options.gameVersion) ? Math.max(0, Math.floor(options.gameVersion)) : 0;
}

/** The store saves go to, or null. */
export function getSaveStore(): SaveStore | null {
    return store;
}

function requireStore(): SaveStore {
    if (!store) throw new Error('Saving is only available while the game runs (Play, or a published build).');
    return store;
}

function requireSlot(slot: string, what: string): void {
    if (!isValidSlot(slot)) throw new Error(`SaveGame.${what}: "${slot}" cannot name a slot (1-64 letters, digits, '_', '-' or '.').`);
}

/** Options for {@link SaveGame.save}. */
export interface SaveOptions {
    /** A caption a slot menu can show ("Firelink Shrine"). Defaults to the scene's name. */
    label?: string;
}

/** Options for {@link SaveGame.load}. */
export interface LoadOptions {
    /** Cover the load with a loading screen, as `Game.loadScene` does. */
    loadingScreen?: LoadSceneOptions['loadingScreen'];
}

export const SaveGame = {
    /**
     * Whether saving works here: true while the game runs (Play, Play in window, a published build). Outside
     * of that every method that touches storage throws.
     */
    get available(): boolean {
        return store !== null;
    },

    /**
     * Keep a value for the rest of the session, and in every save: progress, flags, an inventory.
     *
     *   SaveGame.set('souls', this.souls)
     *   SaveGame.set('opened', [...this.opened])
     *
     * Plain data only (numbers, strings, booleans, arrays, plain objects); a copy is stored, so changing the
     * array afterwards does not change the save. `undefined` removes the key. Survives `Game.loadScene`.
     */
    set(key: string, value: unknown): void {
        if (typeof key !== 'string' || !key) throw new Error('SaveGame.set: the key must be a non-empty string.');
        const copy = cloneGlobal(key, value);
        if (copy === undefined) saveSession().globals.delete(key);
        else saveSession().globals.set(key, copy);
    },

    /** The value stored under `key` (a fresh copy), or `fallback` when there is none. */
    get<T = unknown>(key: string, fallback?: T): T {
        const globals = saveSession().globals;
        if (!globals.has(key)) return fallback as T;
        return decodeSaveValue(structuredCloneJson(globals.get(key))) as T;
    },

    /** Whether a value is stored under `key`. */
    has(key: string): boolean {
        return saveSession().globals.has(key);
    },

    /** Remove the value under `key` (as `set(key, undefined)` does). */
    unset(key: string): void {
        saveSession().globals.delete(key);
    },

    /** Every key a value is stored under. */
    keys(): string[] {
        return [...saveSession().globals.keys()];
    },

    /**
     * Write the game to `slot` (default `'auto'`): the globals, the state of every Saved node and `@save`
     * field in this scene, and the memory of every scene visited. Replaces what the slot held.
     *
     *   await SaveGame.save('auto', { label: 'Firelink Shrine' })
     *
     * Every participant's `onSave` runs first. Resolves with the slot's listing entry.
     */
    async save(slot: string = 'auto', options: SaveOptions = {}): Promise<SaveSlotInfo> {
        requireSlot(slot, 'save');
        const target = requireStore();
        const scene = CleoEngine.instance?.scene;
        const sceneName = Game.sceneName;
        const key = scene?.saveState.key ?? null;
        if (scene && key) rememberScene(scene, sceneName);
        else Logger.warn('SaveGame.save: this scene was not built by a running game, so only the globals are saved.', 'Save');
        const s = saveSession();
        const doc: SaveDocument = {
            format: SAVE_FORMAT,
            formatVersion: SAVE_FORMAT_VERSION,
            gameVersion,
            slot,
            label: typeof options.label === 'string' ? options.label : sceneName,
            savedAt: new Date().toISOString(),
            playTime: Math.round(sessionPlayTime() * 1000) / 1000,
            scene: { id: key ?? sceneName, name: sceneName },
            globals: Object.fromEntries(s.globals),
            scenes: Object.fromEntries(s.scenes),
        };
        return target.write(doc);
    },

    /**
     * Load the game in `slot` (default `'auto'`): its globals and scene memory replace this session's, and
     * the scene it was saved in is built again with everything put back. Resolves once that scene has
     * started. The scene being left is NOT recorded (it is the past being undone).
     *
     *   await SaveGame.load('auto', { loadingScreen: true })
     *
     * Throws when the slot is empty or unreadable. Restored nodes see `wasRestored` and get `onRestore`.
     */
    async load(slot: string = 'auto', options: LoadOptions = {}): Promise<void> {
        requireSlot(slot, 'load');
        if (loading) throw new Error('SaveGame.load: a load is already in progress.');
        const raw = await requireStore().read(slot);
        if (!raw) throw new Error(`SaveGame.load: there is no save in slot "${slot}".`);
        const doc = migrateSaveDocument(raw, gameVersion, migrators);
        loading = true;
        try {
            beginSaveSessionFrom(doc, slot);
            // By id, which survives a rename; hosts resolve either, and key the scene's memory by id themselves.
            await loadSceneInternal(doc.scene.id || doc.scene.name, { loadingScreen: options.loadingScreen }, { capture: false });
        } finally {
            loading = false;
        }
    },

    /** Every saved slot's listing entry, newest first. */
    async list(): Promise<SaveSlotInfo[]> {
        return requireStore().list();
    },

    /** Whether `slot` holds a save. */
    async exists(slot: string = 'auto'): Promise<boolean> {
        requireSlot(slot, 'exists');
        return (await requireStore().list()).some(info => info.slot === slot);
    },

    /** Remove the save in `slot`. */
    async delete(slot: string): Promise<void> {
        requireSlot(slot, 'delete');
        await requireStore().delete(slot);
    },

    /** The newest save's listing entry, or null: what a title screen's Continue loads. */
    async mostRecent(): Promise<SaveSlotInfo | null> {
        return (await requireStore().list())[0] ?? null;
    },

    /**
     * Start over: clear the globals and every scene's memory (saved slots stay). Load the first scene next:
     *
     *   SaveGame.newGame(); await Game.loadScene('Level 1')
     */
    newGame(): void {
        clearSaveSession();
    },

    /**
     * Upgrade older saves of this game when they load: `fn(doc, fromVersion)` runs for a save written at a
     * lower save version (Project ▸ General ▸ Saves) than the game's, and may edit `doc` or return a new one.
     * Register it before loading, from the scene that loads (a title screen's onStart). Returns the
     * unregister function.
     *
     *   SaveGame.onMigrate((doc, from) => { if (from < 2) doc.globals.gold = doc.globals.coins })
     */
    onMigrate(fn: SaveMigrator): () => void {
        migrators.push(fn);
        return () => {
            const at = migrators.indexOf(fn);
            if (at >= 0) migrators.splice(at, 1);
        };
    },

    /** Whether a {@link load} is in progress. */
    get isLoading(): boolean {
        return loading;
    },

    /** The slot this session was loaded from, or null for a game started fresh. */
    get loadedFrom(): string | null {
        return saveSession().loadedFrom;
    },

    /** Seconds of play in this session, counting what the loaded save had. */
    get playTime(): number {
        return sessionPlayTime();
    },

    /** The game's save version: what a save written now records (Project ▸ General ▸ Saves). */
    get version(): number {
        return gameVersion;
    },
};

/** A copy of a JSON-only value (what the globals hold). */
function structuredCloneJson<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
