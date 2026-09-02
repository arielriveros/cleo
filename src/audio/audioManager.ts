import { Howler } from "howler";
import { v4 as uuidv4 } from 'uuid';
import { vec3 } from "gl-matrix";
import { Logger } from "../core/logger";
import { Sound } from "./sound";
import { Mixer } from "./buses";
import { DEFAULT_SOUND_SETTINGS, parseSoundSettings } from "./soundSettings";
import type { SoundSettings } from "./soundSettings";

/**
 * The runtime registry of playable samples, and the audio stack's single entry point.
 *
 * Deliberately shaped like {@link TextureManager}: the same `addXFromBytes` / `addXFromFile` /
 * `getSource` / `serializeXBytes` / `removeX` surface, because every editor-side mechanism written
 * against that shape — the asset reconciler, the IndexedDB byte store, the publish packer — is then a
 * copy rather than a new design. A `Sound`'s id is the id its `SoundSampleAsset` is saved under, and it
 * is what a serialized `SoundNode` references.
 *
 * Registration is SYNCHRONOUS and decoding is not, the same invariant `TextureManager` documents: a
 * caller gets a usable id back immediately, so an import can serialize before the file has decoded.
 */
export class AudioManager {
    private static _instance: AudioManager | null = null;

    private readonly _sounds = new Map<string, Sound>();
    private readonly _mixer = new Mixer();
    /** Cached so a listener update that changes nothing does not touch the Web Audio graph every frame. */
    private readonly _listenerPosition = vec3.create();
    private readonly _listenerForward = vec3.fromValues(0, 0, -1);
    private readonly _listenerUp = vec3.fromValues(0, 1, 0);
    private _listenerSet = false;

    private constructor() { }

    public static get Instance(): AudioManager {
        if (!AudioManager._instance) AudioManager._instance = new AudioManager();
        return AudioManager._instance;
    }

    public get mixer(): Mixer { return this._mixer; }
    public get sounds(): Map<string, Sound> { return this._sounds; }

    /** Whether the browser gave howler a real Web Audio graph. False means no effects and no buses. */
    public get hasWebAudio(): boolean { return !!Howler.ctx && !Howler.noAudio; }

    // -----------------------------------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------------------------------

    /**
     * Register a sample from its compressed bytes and return the id it is stored under.
     * Returns undefined for empty bytes — a caller treats that as "this file was not audio".
     */
    public addSoundFromBytes(
        bytes: Uint8Array, mime: string, settings?: SoundSettings, id?: string,
    ): string | undefined {
        if (!bytes || bytes.length === 0) return undefined;
        const identifier = id || uuidv4();

        // Replacing an existing id has to free the old one, or its Howl keeps the blob URL alive and
        // keeps playing. This is the path a re-import of the same asset takes.
        this._sounds.get(identifier)?.delete();

        try {
            const sound = new Sound(identifier, bytes, mime, settings ?? { ...DEFAULT_SOUND_SETTINGS }, this._mixer);
            this._sounds.set(identifier, sound);
            return identifier;
        } catch (err) {
            Logger.print('warn', ['Failed to create sound', identifier, err], 'Audio');
            return undefined;
        }
    }

    /**
     * Register a sample from a picked or dropped file. Returns the id SYNCHRONOUSLY so a caller can
     * assign it straight away, but the sample itself only exists once the file has been read.
     *
     * That gap is why `onRegistered` exists, and callers must use it. `TextureManager.addTextureFromFile`
     * can register its `Texture` object up front and fill it in later; a `Sound` cannot, because its Howl
     * is built around a blob URL over the bytes. So anything that reacts to the registry changing — the
     * editor's asset reconciler, which mints both record halves — has to be told when the read lands,
     * not when this returns. Firing that notification early is a silent failure: the reconciler runs
     * against a registry that does not hold the sample yet, mints nothing, and never runs again.
     */
    public addSoundFromFile(
        file: File,
        settings?: SoundSettings,
        id?: string,
        onRegistered?: (id: string | undefined) => void,
    ): string | undefined {
        if (!file) return undefined;
        const identifier = id || uuidv4();

        file.arrayBuffer()
            .then(buffer => {
                const registered = this.addSoundFromBytes(
                    new Uint8Array(buffer),
                    file.type || mimeOfName(file.name),
                    settings,
                    identifier,
                );
                onRegistered?.(registered);
            })
            .catch(() => {
                Logger.print('warn', ['Failed to read sound file:', file.name], 'Audio');
                onRegistered?.(undefined);
            });

        return identifier;
    }

    public getSound(id: string): Sound | undefined { return this._sounds.get(id); }

    /** The compressed bytes a sample was built from, or null. Mirrors `TextureManager.getSource`. */
    public getSource(id: string): { bytes: Uint8Array; mime: string } | null {
        return this._sounds.get(id)?.source ?? null;
    }

    /**
     * Every registered sample's original bytes, for the bundle exporter and the publish packer.
     * Pass `ids` to take only what a build actually references.
     */
    public serializeSoundBytes(
        ids?: Iterable<string>,
    ): { id: string; bytes: Uint8Array; mime: string; settings: SoundSettings }[] {
        const wanted = ids ? new Set(ids) : null;
        const out: { id: string; bytes: Uint8Array; mime: string; settings: SoundSettings }[] = [];
        for (const [id, sound] of this._sounds) {
            if (wanted && !wanted.has(id)) continue;
            const source = sound.source;
            if (!source) continue;
            out.push({ id, bytes: source.bytes, mime: source.mime, settings: sound.settings });
        }
        return out;
    }

    public removeSound(id: string): void {
        const sound = this._sounds.get(id);
        if (!sound) return;
        // Unlike a texture — whose GPU object other holders may still draw — a sample has exactly one
        // owner, so removing it really does free it.
        sound.delete();
        this._sounds.delete(id);
    }

    /** Retune a registered sample. No-op for an unknown id, which is routine during a load. */
    public applySettings(id: string, settings: SoundSettings): void {
        this._sounds.get(id)?.applySettings(parseSoundSettings(settings));
    }

    // -----------------------------------------------------------------------------------------------
    // Global control
    // -----------------------------------------------------------------------------------------------

    /**
     * Place the listener. Driven once per frame by the scene's late audio pass, from the active camera.
     *
     * Skips the write when nothing moved: `Howler.pos`/`orientation` walk every live voice's panner, and
     * a stationary camera would otherwise pay for that on every frame of the game.
     */
    public setListener(position: vec3, forward: vec3, up: vec3): void {
        const moved = !this._listenerSet
            || !vec3.exactEquals(position, this._listenerPosition)
            || !vec3.exactEquals(forward, this._listenerForward)
            || !vec3.exactEquals(up, this._listenerUp);
        if (!moved) return;

        vec3.copy(this._listenerPosition, position);
        vec3.copy(this._listenerForward, forward);
        vec3.copy(this._listenerUp, up);
        this._listenerSet = true;

        Howler.pos(position[0], position[1], position[2]);
        Howler.orientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }

    /** Stop every voice of every sample. What leaving play mode calls. */
    public stopAll(): void {
        for (const sound of this._sounds.values()) sound.stop();
    }

    /** Silence everything without stopping it — the tab lost focus, or the editor paused. */
    public suspend(): void { Howler.mute(true); }
    public resume(): void { Howler.mute(false); }

    /** Free every sample. For a project close, where the next project's ids may collide with these. */
    public clear(): void {
        for (const sound of this._sounds.values()) sound.delete();
        this._sounds.clear();
        this._listenerSet = false;
    }
}

/** Best-effort MIME from a filename, for the browsers that hand over a File with an empty `type`. */
function mimeOfName(name: string): string {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    switch (ext) {
        case '.mp3': return 'audio/mpeg';
        case '.wav': return 'audio/wav';
        case '.ogg': return 'audio/ogg';
        case '.opus': return 'audio/opus';
        case '.flac': return 'audio/flac';
        case '.aac': return 'audio/aac';
        case '.m4a': return 'audio/mp4';
        case '.webm': return 'audio/webm';
        default: return 'audio/mpeg';
    }
}
