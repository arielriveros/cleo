// The save SESSION: the game state that outlives a scene — `SaveGame` globals and every visited scene's
// memory — for one play session. A save writes it out; a load replaces it and rebuilds the scene from it.
//
// Hosts (the editor's play mode, the published player) build every runtime scene through
// parseRuntimeScene, so a scene the player returns to comes back as they left it, and a loaded save lands in
// the scene it was made in. Game.loadScene records the scene being left (captureOutgoing).

import type { Scene } from '../scene/scene';
import { CleoEngine } from '../engine';
import { Logger } from '../logger';
import type { SaveDocument, SceneMemory } from './doc';
import { captureScene, resetCaptureWarnings } from './capture';
import { applyLive, patchSceneJson } from './apply';
import { indexNodeJson, livePathOf } from './nodePaths';

interface SaveSession {
    /** `SaveGame.set` values, JSON-encoded (values.ts). */
    globals: Map<string, unknown>;
    /** Every visited scene's memory, by scene key (its id in the game's scene table). */
    scenes: Map<string, SceneMemory>;
    /** Seconds of play carried in from the save this session began from. */
    playTimeBase: number;
    /** The engine's game clock (ms) when the session began. */
    clockMark: number;
    /** The slot this session was loaded from, if any. */
    loadedFrom: string | null;
}

const clock = () => CleoEngine.instance?.timeSinceStart ?? 0;

function freshSession(): SaveSession {
    return { globals: new Map(), scenes: new Map(), playTimeBase: 0, clockMark: clock(), loadedFrom: null };
}

let session: SaveSession = freshSession();

/** Listeners a reset must clear (SaveGame keeps its migrators here, so this module stays the one owner). */
const resetHooks = new Set<() => void>();

/** @internal The live session. */
export function saveSession(): SaveSession {
    return session;
}

/** @internal Run `fn` whenever the session is reset (a new play session in the editor). */
export function onSaveSessionReset(fn: () => void): void {
    resetHooks.add(fn);
}

/**
 * Start a new, empty session: no globals, no scene memory, play time from zero. The editor calls this when
 * Play starts and stops; a published game starts with one.
 */
export function resetSaveSession(): void {
    session = freshSession();
    resetCaptureWarnings();
    for (const fn of resetHooks) fn();
}

/** A new game in the same session: globals and scene memory cleared, play time from zero. */
export function clearSaveSession(): void {
    session = freshSession();
}

/** Make `doc` the session: its globals, its scenes' memory and its play time. */
export function beginSaveSessionFrom(doc: SaveDocument, slot: string | null = doc.slot): void {
    session = {
        globals: new Map(Object.entries(doc.globals ?? {})),
        scenes: new Map(Object.entries(doc.scenes ?? {})),
        playTimeBase: doc.playTime ?? 0,
        clockMark: clock(),
        loadedFrom: slot,
    };
}

/** Seconds of play in this session, including what the save it began from had. */
export function sessionPlayTime(): number {
    return session.playTimeBase + Math.max(0, clock() - session.clockMark) / 1000;
}

/** Record `scene`'s participants into the session, under its key. Returns the memory, or null without a key. */
export function rememberScene(scene: Scene, name?: string): SceneMemory | null {
    const key = scene.saveState.key;
    if (!key) return null;
    const mem = captureScene(scene);
    if (name) mem.name = name;
    session.scenes.set(key, mem);
    return mem;
}

/**
 * Record the running scene before it is left (Game.loadScene). Never throws: a capture that fails must not
 * stop the player from changing scene.
 */
export function captureOutgoing(sceneName?: string): void {
    const scene = CleoEngine.instance?.scene;
    if (!scene?.saveState.key) return;
    try { rememberScene(scene, sceneName); }
    catch (e) { Logger.error(`Save: could not record scene "${sceneName ?? scene.saveState.key}" before leaving it: ${(e as Error)?.message ?? e}`, 'Save'); }
}

/**
 * Parse `json` (a scene: `{ scene, textures }`) into `scene` the way a running game must: with the session's
 * memory for `sceneKey` written in before the parse and applied after it. Every host builds its runtime
 * scenes through this. Does not start the scene.
 *
 * `json.scene` is edited in place when there is memory, so pass a copy the host owns (both hosts already
 * parse a fresh copy per visit).
 */
export function parseRuntimeScene(scene: Scene, json: { scene: any; textures?: any }, sceneKey: string | null, useCache: boolean = false): void {
    const st = scene.saveState;
    st.key = sceneKey;
    const mem = sceneKey ? session.scenes.get(sceneKey) ?? null : null;
    // The authored tree's index, taken BEFORE the patch prunes it: paths are authored paths.
    const index = mem && json?.scene ? indexNodeJson(json.scene) : null;
    const plan = mem && index ? patchSceneJson(mem, index) : null;

    scene.parse(json, useCache);

    const root = scene.root;
    for (const node of st.participants) {
        const path = index ? (index.pathOf.get(index.byId.get(node.id)) ?? livePathOf(root, node)) : livePathOf(root, node);
        node._saveInfo().path = path;
        st.authored.set(node.id, path);
    }
    st.memoryIn = mem;
    if (plan) applyLive(scene, plan, index);
}
