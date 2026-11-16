// The save document: what `SaveGame.save` writes and `SaveGame.load` reads back, as plain JSON (a `.cleosave`
// file). Pure data and pure functions, no engine imports, so stores, the editor's Saves panel and the desktop
// shell's tests can all read it.

/** What every save document says it is. */
export const SAVE_FORMAT = 'cleo-save';

/**
 * The document layout's version. Bumped when the ENGINE writes something an older engine cannot read; a
 * newer document is refused rather than half-read. A game's own data has its own version, {@link
 * SaveDocument.gameVersion}.
 */
export const SAVE_FORMAT_VERSION = 1;

/** A node a save refers to: by id, and by its name path in the authored tree when the id is gone. */
export interface SavedRef {
    id: string;
    path: string | null;
}

/** What a save keeps for one node. Every key is optional: only what applies is written. */
export interface SavedNodeState {
    /** Its name path in the authored scene tree (`Dungeon/Lever`, `#k` for a later namesake). */
    path?: string | null;
    /** Local position, quaternion and scale (a Saved node). */
    p?: number[];
    q?: number[];
    s?: number[];
    /** Dormancy, where it differs from its parent: true asleep under an awake parent, false awake though authored asleep. */
    sleep?: boolean;
    /** Its own body's linear and angular velocity, when moving (a Saved node). */
    v?: number[];
    w?: number[];
    /** Its `@save` script fields, encoded (see values.ts). */
    fields?: Record<string, unknown>;
    /** Its node variables (a Saved node), as serialized: `{ type, value, access }`. */
    vars?: Record<string, unknown>;
    /** What its `onSave` returned, encoded. */
    custom?: unknown;
}

/** A Saved node a script instantiated from a template: made again, under the same id, when the scene is entered. */
export interface SavedSpawn {
    /** The template's id, and its name (looked up when the id is not registered). */
    template: string;
    templateName: string;
    /** The copy's own name and id. */
    name: string;
    id: string;
    /** Where it was attached; null for the scene root. */
    parent: SavedRef | null;
    /** The copy's root state. */
    state: SavedNodeState;
    /** Participants inside the copy, by their name path below its root. */
    sub?: Record<string, SavedNodeState>;
}

/** Everything a save keeps for one scene. Also what the scene's memory holds between visits. */
export interface SceneMemory {
    /** The scene's name when it was recorded, for a person reading the save. */
    name?: string;
    /** Authored participants, by node id. */
    nodes: Record<string, SavedNodeState>;
    /** Authored participants that were removed, which stay removed. */
    removed: SavedRef[];
    /** Saved copies instantiated at runtime. */
    spawned: SavedSpawn[];
}

/** A whole save. */
export interface SaveDocument {
    format: typeof SAVE_FORMAT;
    formatVersion: number;
    /** The engine build that wrote it, for diagnostics. */
    engine?: string;
    /** The game's own save version (Project ▸ General ▸ Saves), which `SaveGame.onMigrate` upgrades from. */
    gameVersion: number;
    slot: string;
    /** A caption for a slot menu. */
    label: string;
    /** ISO time it was written. */
    savedAt: string;
    /** Seconds of unpaused play the session had when it was written. */
    playTime: number;
    /** The scene it was saved in, by its id in the game's scene table and its name. */
    scene: { id: string; name: string };
    /** `SaveGame.set` values. */
    globals: Record<string, unknown>;
    /** Every scene's state, by scene id: the one it was saved in, and every other one visited. */
    scenes: Record<string, SceneMemory>;
}

/** A slot as a menu lists it, without the whole document. */
export interface SaveSlotInfo {
    slot: string;
    label: string;
    savedAt: string;
    playTime: number;
    scene: { id: string; name: string };
    gameVersion: number;
    /** The stored document's size, in bytes (UTF-16 code units of its JSON). */
    size: number;
}

/** A new, empty scene memory. */
export function emptySceneMemory(): SceneMemory {
    return { nodes: {}, removed: [], spawned: [] };
}

// Windows refuses these as file names, with any extension: a slot is a file name on the desktop.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Whether `slot` can name a save: 1..64 letters, digits, `_`, `-` and `.`, not starting with a dot and not a
 * name Windows reserves. The same rule everywhere, since a slot is a file name in a desktop game.
 */
export function isValidSlot(slot: unknown): slot is string {
    return typeof slot === 'string'
        && /^[\w-][\w.-]{0,63}$/.test(slot)
        && !RESERVED.test(slot);
}

/** The listing entry for a document. */
export function slotInfoOf(doc: SaveDocument, size: number): SaveSlotInfo {
    return {
        slot: doc.slot,
        label: doc.label,
        savedAt: doc.savedAt,
        playTime: doc.playTime,
        scene: { id: doc.scene.id, name: doc.scene.name },
        gameVersion: doc.gameVersion,
        size,
    };
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Check that `raw` is a save document this engine can read, and return it typed. Throws a message fit for a
 * player-facing error otherwise. Tolerant of what a newer or older writer may add or leave out WITHIN the
 * format version: a missing `globals` or `scenes` reads as empty.
 */
export function validateSaveDocument(raw: unknown): SaveDocument {
    if (!isObject(raw) || raw.format !== SAVE_FORMAT) throw new Error('Not a Cleo save file.');
    const version = raw.formatVersion;
    if (typeof version !== 'number' || !Number.isFinite(version) || version < 1)
        throw new Error('The save file has no valid format version.');
    if (version > SAVE_FORMAT_VERSION)
        throw new Error(`The save was written by a newer engine (format ${version}; this one reads up to ${SAVE_FORMAT_VERSION}).`);
    if (!isObject(raw.scene) || typeof raw.scene.id !== 'string')
        throw new Error('The save file does not say which scene it was saved in.');
    const scenes: Record<string, SceneMemory> = {};
    if (isObject(raw.scenes)) {
        for (const [key, mem] of Object.entries(raw.scenes)) {
            if (!isObject(mem)) continue;
            scenes[key] = {
                ...(typeof mem.name === 'string' ? { name: mem.name } : {}),
                nodes: isObject(mem.nodes) ? mem.nodes : {},
                removed: Array.isArray(mem.removed) ? mem.removed.filter((r: any) => isObject(r) && typeof r.id === 'string') : [],
                spawned: Array.isArray(mem.spawned) ? mem.spawned.filter((s: any) => isObject(s) && typeof s.template === 'string') : [],
            };
        }
    }
    return {
        format: SAVE_FORMAT,
        formatVersion: version,
        engine: typeof raw.engine === 'string' ? raw.engine : undefined,
        gameVersion: typeof raw.gameVersion === 'number' && Number.isFinite(raw.gameVersion) ? raw.gameVersion : 0,
        slot: typeof raw.slot === 'string' ? raw.slot : 'auto',
        label: typeof raw.label === 'string' ? raw.label : '',
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date(0).toISOString(),
        playTime: typeof raw.playTime === 'number' && Number.isFinite(raw.playTime) ? Math.max(0, raw.playTime) : 0,
        scene: { id: raw.scene.id, name: typeof raw.scene.name === 'string' ? raw.scene.name : '' },
        globals: isObject(raw.globals) ? raw.globals : {},
        scenes,
    };
}

/** A game's upgrade of its own save data, from the version a document was written at. */
export type SaveMigrator = (doc: SaveDocument, fromVersion: number) => SaveDocument | void;

/**
 * Bring a document written at an older game save version up to `current`: every migrator runs, in the order
 * they were registered, with the version the document was written at. A migrator may edit the document in
 * place or return a replacement. A document from a NEWER game version is read as it is.
 */
export function migrateSaveDocument(doc: SaveDocument, current: number, migrators: readonly SaveMigrator[]): SaveDocument {
    const from = doc.gameVersion;
    if (from >= current || migrators.length === 0) return doc;
    let out = doc;
    for (const migrate of migrators) {
        const next = migrate(out, from);
        if (next && typeof next === 'object') out = next;
    }
    out.gameVersion = current;
    return out;
}
