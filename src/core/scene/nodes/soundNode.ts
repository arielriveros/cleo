import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { AudioManager } from "../../../audio/audioManager";
import { DEFAULT_SPATIAL_SETTINGS, parseSpatialSettings } from "../../../audio/soundSettings";
import type { DistanceModel, SpatialSettings } from "../../../audio/soundSettings";

/**
 * A sound emitter in the scene graph.
 *
 * One node type with the mode in its payload, exactly like {@link LightNode} carries directional / point
 * / spotlight in `lightType`: an ambient sound and a spatial one differ in how they are heard, not in
 * what they are, and splitting them into two classes would duplicate the whole play/stop surface to
 * express that.
 *
 *  - `ambient`  — heard at a constant level wherever the listener is. Music, room tone, UI.
 *  - `spatial`  — placed in the world and attenuated by distance from the listener. Everything diegetic.
 *
 * WHAT THIS NODE DOES NOT OWN: the sample. Volume, rate, loop points, the effect rack and the bus all
 * belong to the `SoundSampleAsset` this node references by `sampleId`, and are shared with every other
 * node using the same sample — which is the point of the split. The node owns only its PLACEMENT: where
 * it is, how loud it is relative to the sample, whether it starts on its own, and how it falls off.
 */

export type SoundMode = 'ambient' | 'spatial';

/** Whether a node overrides the sample's own loop setting. */
export type LoopMode = 'inherit' | 'on' | 'off';

export interface SoundNodeOptions {
    mode?: SoundMode;
    /** The `SoundSampleAsset` / `AudioManager` id this node plays. */
    sampleId?: string | null;
    /** 0..1, multiplied by the sample's own volume. */
    volume?: number;
    /**
     * Looping is a property of the SAMPLE, so the default is `inherit`. The override exists because one
     * sample can legitimately be a one-shot in one place and a bed in another, and it is expressed as
     * three states rather than a boolean so "off" and "the sample decides" stay distinguishable.
     */
    loopMode?: LoopMode;
    playOnStart?: boolean;
    // Spatial only. Ignored — but preserved — while `mode` is 'ambient'.
    distanceModel?: DistanceModel;
    refDistance?: number;
    maxDistance?: number;
    rolloffFactor?: number;
}

export class SoundNode extends Node {
    private _mode: SoundMode;
    private _sampleId: string | null;
    private _volume: number;
    private _loopMode: LoopMode;
    private _playOnStart: boolean;
    private _spatial: SpatialSettings;

    /** The howler voice this node is currently sounding, or null. One voice per node, not a pool. */
    private _voice: number | null = null;

    constructor(name: string, options: SoundNodeOptions = {}, id: string = uuidv4()) {
        super(name, 'sound', id);
        this._mode = options.mode === 'ambient' ? 'ambient' : 'spatial';
        this._sampleId = options.sampleId ?? null;
        this._volume = clamp01(options.volume ?? 1);
        this._loopMode = readLoopMode(options.loopMode);
        this._playOnStart = options.playOnStart !== false;
        this._spatial = parseSpatialSettings({
            distanceModel: options.distanceModel ?? DEFAULT_SPATIAL_SETTINGS.distanceModel,
            refDistance: options.refDistance ?? DEFAULT_SPATIAL_SETTINGS.refDistance,
            maxDistance: options.maxDistance ?? DEFAULT_SPATIAL_SETTINGS.maxDistance,
            rolloffFactor: options.rolloffFactor ?? DEFAULT_SPATIAL_SETTINGS.rolloffFactor,
        });
    }

    // -----------------------------------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------------------------------

    public onStart(): void {
        if (this._playOnStart) this.play();
    }

    public onDespawn(): void {
        this.stop();
    }

    // -----------------------------------------------------------------------------------------------
    // Playback
    // -----------------------------------------------------------------------------------------------

    /**
     * Start this emitter. Restarts it if it is already sounding.
     *
     * Silently does nothing when the scene has audio disabled, which is how the editor keeps a level's
     * sounds quiet while you author it: the viewport scene runs started and unpaused so the camera can
     * fly, so without that gate every emitter in the level would fire the moment a project opened.
     */
    public play(): void {
        if (this._scene?.soundsEnabled === false) return;
        const sound = this._sample();
        if (!sound) return;

        this.stop();
        const voice = sound.play();
        if (voice === null) return;
        this._voice = voice;

        if (this._loopMode !== 'inherit') sound.howl.loop(this._loopMode === 'on', voice);
        sound.setVoiceVolume(voice, sound.settings.volume * this._volume);

        if (this._mode === 'spatial') {
            sound.setVoiceSpatial(voice, this._spatial);
            this._pushPosition(sound, voice);
        } else {
            // Ambient voices take the sample's authored stereo pan. A spatial voice must NOT: its panner
            // owns the stereo field, and a second pan stage in front of it would fight the placement.
            sound.setVoicePan(voice, sound.settings.pan);
        }
    }

    public stop(): void {
        if (this._voice === null) return;
        this._sample()?.stop(this._voice);
        this._voice = null;
    }

    public pause(): void {
        if (this._voice !== null) this._sample()?.pause(this._voice);
    }

    public resume(): void {
        if (this._voice !== null) this._sample()?.resume(this._voice);
    }

    /** Ramp this emitter's volume over `seconds`. Also updates `volume`, so it survives a re-sync. */
    public fadeTo(volume: number, seconds: number): void {
        const sound = this._sample();
        const target = clamp01(volume);
        if (sound && this._voice !== null) {
            const from = sound.settings.volume * this._volume;
            sound.fade(from, sound.settings.volume * target, seconds, this._voice);
        }
        this._volume = target;
    }

    public get isPlaying(): boolean {
        return this._voice !== null && !!this._sample()?.isPlaying(this._voice);
    }

    /**
     * Push this frame's world position at the panner.
     *
     * Called by the scene's late audio pass rather than from `update`, because camera rigs run AFTER the
     * per-node update loop: a listener refreshed mid-loop would trail a rig-driven camera by a frame, and
     * emitter and listener have to be sampled at the same instant or a fast pan smears the stereo image.
     */
    public syncSpatial(): void {
        if (this._mode !== 'spatial' || this._voice === null) return;
        const sound = this._sample();
        if (!sound) return;
        // The voice may have ended on its own (a one-shot finishing); drop the handle rather than keep
        // writing positions at a dead id.
        if (!sound.isPlaying(this._voice)) { this._voice = null; return; }
        this._pushPosition(sound, this._voice);
    }

    // -----------------------------------------------------------------------------------------------
    // Properties
    // -----------------------------------------------------------------------------------------------

    public get mode(): SoundMode { return this._mode; }
    public set mode(value: SoundMode) {
        if (value === this._mode) return;
        this._mode = value;
        // A live voice cannot swap between a stereo panner and a spatial one — howler builds one or the
        // other when the voice starts — so restart it. Silent nodes just take the new mode.
        if (this.isPlaying) this.play();
        this._notifyChange('component', 'soundMode');
    }

    public get sampleId(): string | null { return this._sampleId; }
    public set sampleId(value: string | null) {
        if (value === this._sampleId) return;
        const wasPlaying = this.isPlaying;
        this.stop();
        this._sampleId = value || null;
        if (wasPlaying) this.play();
        this._notifyChange('component', 'sampleId');
    }

    public get volume(): number { return this._volume; }
    public set volume(value: number) {
        this._volume = clamp01(value);
        const sound = this._sample();
        if (sound && this._voice !== null) sound.setVoiceVolume(this._voice, sound.settings.volume * this._volume);
        this._notifyChange('component', 'volume');
    }

    public get loopMode(): LoopMode { return this._loopMode; }
    public set loopMode(value: LoopMode) {
        this._loopMode = readLoopMode(value);
        const sound = this._sample();
        if (sound && this._voice !== null && this._loopMode !== 'inherit') {
            sound.howl.loop(this._loopMode === 'on', this._voice);
        }
        this._notifyChange('component', 'loopMode');
    }

    public get playOnStart(): boolean { return this._playOnStart; }
    public set playOnStart(value: boolean) {
        this._playOnStart = value;
        this._notifyChange('component', 'playOnStart');
    }

    /** The distance falloff. Read-only reference; assign the whole object or use the setters below. */
    public get spatial(): SpatialSettings { return this._spatial; }
    public set spatial(value: SpatialSettings) {
        this._spatial = parseSpatialSettings(value);
        this._pushSpatial();
    }

    public get distanceModel(): DistanceModel { return this._spatial.distanceModel; }
    public set distanceModel(value: DistanceModel) {
        this.spatial = { ...this._spatial, distanceModel: value };
    }

    public get refDistance(): number { return this._spatial.refDistance; }
    public set refDistance(value: number) {
        this.spatial = { ...this._spatial, refDistance: value };
    }

    public get maxDistance(): number { return this._spatial.maxDistance; }
    public set maxDistance(value: number) {
        this.spatial = { ...this._spatial, maxDistance: value };
    }

    public get rolloffFactor(): number { return this._spatial.rolloffFactor; }
    public set rolloffFactor(value: number) {
        this.spatial = { ...this._spatial, rolloffFactor: value };
    }

    // -----------------------------------------------------------------------------------------------
    // Serialization
    // -----------------------------------------------------------------------------------------------

    protected _serializePayload(): any {
        return {
            sound: {
                mode: this._mode,
                sampleId: this._sampleId,
                volume: this._volume,
                loopMode: this._loopMode,
                playOnStart: this._playOnStart,
                distanceModel: this._spatial.distanceModel,
                refDistance: this._spatial.refDistance,
                maxDistance: this._spatial.maxDistance,
                rolloffFactor: this._spatial.rolloffFactor,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new SoundNode(json.name, json.sound ?? {}, json.id);
        // finishParse ATTACHES the node. Never call parent.addChild after it — see tests/nodeParse.test.ts.
        Node.finishParse(node, parent, json);
    }

    /** Selection bounds: a small box around the emitter's origin. It has no geometry of its own. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.5;
        return {
            min: vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius),
            max: vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius),
        };
    }

    // -----------------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------------

    private _sample() {
        return this._sampleId ? AudioManager.Instance.getSound(this._sampleId) : undefined;
    }

    private _pushPosition(sound: NonNullable<ReturnType<SoundNode['_sample']>>, voice: number): void {
        const p = this.worldPosition;
        sound.setVoicePosition(voice, p[0], p[1], p[2]);
    }

    private _pushSpatial(): void {
        const sound = this._sample();
        if (sound && this._voice !== null && this._mode === 'spatial') {
            sound.setVoiceSpatial(this._voice, this._spatial);
        }
        this._notifyChange('component', 'spatial');
    }
}

function clamp01(v: number): number {
    return !Number.isFinite(v) ? 1 : v < 0 ? 0 : v > 1 ? 1 : v;
}

function readLoopMode(value: unknown): LoopMode {
    return value === 'on' || value === 'off' ? value : 'inherit';
}
