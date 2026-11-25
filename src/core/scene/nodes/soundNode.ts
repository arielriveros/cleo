import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { AudioManager } from "../../../audio/audioManager";
import { audioNow } from "../../../audio/sound";
import type { Sound } from "../../../audio/sound";
import { DEFAULT_SPATIAL_SETTINGS, attenuationAt, parseSpatialSettings } from "../../../audio/soundSettings";
import type { DistanceModel, SpatialSettings } from "../../../audio/soundSettings";
import { clamp, clamp01, finiteOr } from "../../math";

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
 *
 * OVERLAP is the node's too: how many of its plays may sound at once (`voices`; 1, the default, restarts
 * the sound), which voice a play takes over when they are all busy (`whenFull`), whether a spatial voice
 * stays where it started (`voicesStayPut`), a random pitch and volume per play, and a minimum time between
 * plays (`retrigger`). A rapid-fire gun is one node with many voices, not a pool of copies of it.
 */

export type SoundMode = 'ambient' | 'spatial';

/** Whether a node overrides the sample's own loop setting. */
export type LoopMode = 'inherit' | 'on' | 'off';

/** What a play does when every voice is busy: stop the oldest, the quietest or the farthest one for it, or not play. */
export type WhenFull = 'oldest' | 'quietest' | 'farthest' | 'skip';

const WHEN_FULL: readonly WhenFull[] = ['oldest', 'quietest', 'farthest', 'skip'];

/** The most voices one node may have sounding. */
export const MAX_VOICES = 32;

/** A stolen voice's ramp to silence: long enough not to click, too short to be heard as a fade. */
const STEAL_RAMP = 0.03;

export interface SoundPlayOptions {
    /** Seconds into the sample to start at. */
    offset?: number;
    /** Stop every voice first, and ignore the retrigger guard: this play is the only one (a timeline's sound). */
    restart?: boolean;
    /** False: this play takes no random pitch or volume. */
    vary?: boolean;
}

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
    /** How many plays may sound at once, 1..32. 1: a play restarts the sound. */
    voices?: number;
    whenFull?: WhenFull;
    /** Spatial: each voice stays where it started instead of following the node. */
    voicesStayPut?: boolean;
    /** Semitones, 0..12: each play's pitch is moved by up to this much, either way. */
    pitchVariation?: number;
    /** 0..1: each play's volume is lowered by up to this share. */
    volumeVariation?: number;
    /** Seconds, 0..5: a play this soon after the last one is ignored. */
    retrigger?: number;
}

/** One sounding play: howler's voice id and what this play was given. */
interface Voice {
    id: number;
    /** The random volume multiplier and rate this play drew (1 when none). */
    gain: number;
    rate: number;
    /** Where a stay-put voice sounds; null while it follows the node. */
    position: [number, number, number] | null;
}

export class SoundNode extends Node {
    private _mode: SoundMode;
    private _sampleId: string | null;
    private _volume: number;
    private _loopMode: LoopMode;
    private _playOnStart: boolean;
    private _spatial: SpatialSettings;
    private _maxVoices: number;
    private _whenFull: WhenFull;
    private _stayPut: boolean;
    private _pitchVariation: number;
    private _volumeVariation: number;
    private _retrigger: number;

    /** The voices this node has sounding, oldest first. Ended ones are dropped as they are found. */
    private _live: Voice[] = [];
    /** When the last play started (audio clock seconds), for the retrigger guard. */
    private _lastPlay = -Infinity;
    /** Runtime only, never saved: a multiplier on `volume`, and the voices' rate (a sequence's fades and speed). */
    private _gain = 1;
    private _rate = 1;

    constructor(name: string, options: SoundNodeOptions = {}, id: string = uuidv4()) {
        super(name, 'sound', id);
        this._mode = options.mode === 'ambient' ? 'ambient' : 'spatial';
        this._sampleId = options.sampleId ?? null;
        this._volume = clamp01(finiteOr(options.volume, 1));
        this._loopMode = readLoopMode(options.loopMode);
        this._playOnStart = options.playOnStart !== false;
        this._spatial = parseSpatialSettings({
            distanceModel: options.distanceModel ?? DEFAULT_SPATIAL_SETTINGS.distanceModel,
            refDistance: options.refDistance ?? DEFAULT_SPATIAL_SETTINGS.refDistance,
            maxDistance: options.maxDistance ?? DEFAULT_SPATIAL_SETTINGS.maxDistance,
            rolloffFactor: options.rolloffFactor ?? DEFAULT_SPATIAL_SETTINGS.rolloffFactor,
        });
        this._maxVoices = readVoices(options.voices);
        this._whenFull = readWhenFull(options.whenFull);
        this._stayPut = options.voicesStayPut === true;
        this._pitchVariation = readPitchVariation(options.pitchVariation);
        this._volumeVariation = clamp01(finiteOr(options.volumeVariation, 0));
        this._retrigger = readRetrigger(options.retrigger);
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
     * Start this emitter. With one voice (the default) it restarts if it is already sounding; with more, the
     * play rings over the ones still sounding, and when they are all busy `whenFull` decides.
     *
     * Silently does nothing when the scene has audio disabled, which is how the editor keeps a level's
     * sounds quiet while you author it: the viewport scene runs started and unpaused so the camera can
     * fly, so without that gate every emitter in the level would fire the moment a project opened.
     */
    public play(options: SoundPlayOptions = {}): void {
        if (this._scene?.soundsEnabled === false) return;
        const sound = this._sample();
        if (!sound) return;
        const now = audioNow();
        if (!options.restart && this._retrigger > 0 && now - this._lastPlay < this._retrigger) return;

        this._prune(sound);
        if (options.restart || this._maxVoices === 1) this.stop();
        else {
            if (this._whenFull === 'skip' && this._live.length >= this._maxVoices) return;
            // More than one when `voices` was lowered while they sounded.
            while (this._live.length >= this._maxVoices) {
                const victim = this._victim(sound);
                this._live.splice(this._live.indexOf(victim), 1);
                sound.stopVoice(victim.id, STEAL_RAMP);
            }
        }

        const id = sound.play();
        if (id === null) return;
        this._lastPlay = now;
        const vary = options.vary !== false;
        const p = this.worldPosition;
        const voice: Voice = {
            id,
            gain: vary && this._volumeVariation > 0 ? 1 - Math.random() * this._volumeVariation : 1,
            rate: vary && this._pitchVariation > 0 ? Math.pow(2, (Math.random() * 2 - 1) * this._pitchVariation / 12) : 1,
            position: this._mode === 'spatial' && this._stayPut ? [p[0], p[1], p[2]] : null,
        };
        this._live.push(voice);

        if (this._loopMode !== 'inherit') sound.setVoiceLoop(id, this._loopMode === 'on');
        sound.setVoiceVolume(id, this._voiceVolume(sound, voice));
        if (this._rate * voice.rate !== 1) sound.setVoiceRate(id, this._rate * voice.rate);
        // Part-way in: a cinematic's sound joined at the moment its timeline is at.
        if (typeof options.offset === 'number' && options.offset > 0) sound.seekVoice(id, options.offset);

        if (this._mode === 'spatial') {
            sound.setVoiceSpatial(id, this._spatial);
            this._pushPosition(sound, voice);
        } else {
            // Ambient voices take the sample's authored stereo pan. A spatial voice must NOT: its panner
            // owns the stereo field, and a second pan stage in front of it would fight the placement.
            sound.setVoicePan(id, sound.settings.pan);
        }
    }

    /** Stop every voice (each honouring the sample's fade-out). */
    public stop(): void {
        if (this._live.length === 0) return;
        const sound = this._sample();
        if (sound) for (const v of this._live) sound.stop(v.id);
        this._live = [];
    }

    public pause(): void {
        const sound = this._sample();
        if (sound) for (const v of this._live) sound.pause(v.id);
    }

    public resume(): void {
        const sound = this._sample();
        if (sound) for (const v of this._live) sound.resume(v.id);
    }

    /** Ramp this emitter's volume over `seconds`. Also updates `volume`, so it survives a re-sync. */
    public fadeTo(volume: number, seconds: number): void {
        const sound = this._sample();
        const target = clamp01(finiteOr(volume, 1));
        if (sound) {
            for (const v of this._live) {
                const from = sound.settings.volume * this._volume * this._gain * v.gain;
                sound.fade(from, sound.settings.volume * target * this._gain * v.gain, seconds, v.id);
            }
        }
        this._volume = target;
    }

    /** Seconds into the sample the newest voice is at (0 when silent). */
    public get playhead(): number {
        const newest = this._newest();
        return newest ? (this._sample()?.seek(newest.id) ?? 0) : 0;
    }

    /** The sample's length in seconds (0 until it has decoded, or with no sample). */
    public get duration(): number { return this._sample()?.duration ?? 0; }

    /** Move the newest voice's playhead to `seconds` into the sample. */
    public seek(seconds: number): void {
        const newest = this._newest();
        if (newest) this._sample()?.seekVoice(newest.id, seconds);
    }

    /**
     * Runtime only, never saved: a 0..1 multiplier on {@link volume}, applied to the voices at once — what a
     * sequence's audio track fades with, leaving the authored volume alone.
     */
    public get gain(): number { return this._gain; }
    public set gain(value: number) {
        const g = clamp01(finiteOr(value, 1));
        if (g === this._gain) return;
        this._gain = g;
        this._pushVolumes();
    }

    /** Runtime only, never saved: the voices' rate as a multiple of the sample's own (0.5..4). */
    public get playbackRate(): number { return this._rate; }
    public set playbackRate(value: number) {
        const r = Math.min(4, Math.max(0.5, finiteOr(value, 1)));
        if (r === this._rate) return;
        this._rate = r;
        const sound = this._sample();
        if (sound) for (const v of this._live) sound.setVoiceRate(v.id, r * v.rate);
    }

    /** Whether any of this emitter's voices is sounding (a paused one is not). */
    public get isPlaying(): boolean {
        if (this._live.length === 0) return false;
        const sound = this._sample();
        return !!sound && this._live.some(v => sound.isPlaying(v.id));
    }

    /** How many voices this emitter has going (playing or paused). */
    public get activeVoices(): number {
        const sound = this._sample();
        if (!sound) return 0;
        this._prune(sound);
        return this._live.length;
    }

    /**
     * Push this frame's world position at the panner, for the voices that follow the node.
     *
     * Called by the scene's late audio pass rather than from `update`, because camera rigs run AFTER the
     * per-node update loop: a listener refreshed mid-loop would trail a rig-driven camera by a frame, and
     * emitter and listener have to be sampled at the same instant or a fast pan smears the stereo image.
     */
    public syncSpatial(): void {
        if (this._mode !== 'spatial' || this._live.length === 0) return;
        const sound = this._sample();
        if (!sound) return;
        // A voice may have ended on its own (a one-shot finishing); drop it rather than keep writing
        // positions at a dead id.
        this._prune(sound);
        for (const v of this._live) if (!v.position) this._pushPosition(sound, v);
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
        if (this.isPlaying) this.play({ restart: true });
        this._notifyChange('component', 'soundMode');
    }

    public get sampleId(): string | null { return this._sampleId; }
    public set sampleId(value: string | null) {
        if (value === this._sampleId) return;
        const wasPlaying = this.isPlaying;
        this.stop();
        this._sampleId = value || null;
        if (wasPlaying) this.play({ restart: true });
        this._notifyChange('component', 'sampleId');
    }

    public get volume(): number { return this._volume; }
    public set volume(value: number) {
        this._volume = clamp01(finiteOr(value, 1));
        this._pushVolumes();
        this._notifyChange('component', 'volume');
    }

    public get loopMode(): LoopMode { return this._loopMode; }
    public set loopMode(value: LoopMode) {
        this._loopMode = readLoopMode(value);
        const sound = this._sample();
        if (sound && this._loopMode !== 'inherit') {
            for (const v of this._live) sound.setVoiceLoop(v.id, this._loopMode === 'on');
        }
        this._notifyChange('component', 'loopMode');
    }

    public get playOnStart(): boolean { return this._playOnStart; }
    public set playOnStart(value: boolean) {
        this._playOnStart = value;
        this._notifyChange('component', 'playOnStart');
    }

    /** How many plays may sound at once, 1..32. 1: a play restarts the sound. Lowering it lets the ones sounding finish. */
    public get voices(): number { return this._maxVoices; }
    public set voices(value: number) {
        this._maxVoices = readVoices(value);
        this._notifyChange('component', 'voices');
    }

    /** What a play does when all `voices` are busy. */
    public get whenFull(): WhenFull { return this._whenFull; }
    public set whenFull(value: WhenFull) {
        this._whenFull = readWhenFull(value);
        this._notifyChange('component', 'whenFull');
    }

    /** Spatial: a voice stays where it started (a shot rings where it was fired) instead of following the node. */
    public get voicesStayPut(): boolean { return this._stayPut; }
    public set voicesStayPut(value: boolean) {
        this._stayPut = value === true;
        this._notifyChange('component', 'voicesStayPut');
    }

    /** Semitones, 0..12: each play's pitch moves by a random amount up to this, either way. */
    public get pitchVariation(): number { return this._pitchVariation; }
    public set pitchVariation(value: number) {
        this._pitchVariation = readPitchVariation(value);
        this._notifyChange('component', 'pitchVariation');
    }

    /** 0..1: each play's volume is lowered by a random share up to this (never raised). */
    public get volumeVariation(): number { return this._volumeVariation; }
    public set volumeVariation(value: number) {
        this._volumeVariation = clamp01(finiteOr(value, 0));
        this._notifyChange('component', 'volumeVariation');
    }

    /** Seconds, 0..5: a play this soon after the last one is ignored. */
    public get retrigger(): number { return this._retrigger; }
    public set retrigger(value: number) {
        this._retrigger = readRetrigger(value);
        this._notifyChange('component', 'retrigger');
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
                // Overlap: written only when set, so a scene saved before it existed reads back unchanged.
                ...(this._maxVoices !== 1 ? { voices: this._maxVoices } : {}),
                ...(this._whenFull !== 'oldest' ? { whenFull: this._whenFull } : {}),
                ...(this._stayPut ? { voicesStayPut: true } : {}),
                ...(this._pitchVariation > 0 ? { pitchVariation: this._pitchVariation } : {}),
                ...(this._volumeVariation > 0 ? { volumeVariation: this._volumeVariation } : {}),
                ...(this._retrigger > 0 ? { retrigger: this._retrigger } : {}),
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

    private _sample(): Sound | undefined {
        return this._sampleId ? AudioManager.Instance.getSound(this._sampleId) : undefined;
    }

    private _newest(): Voice | undefined {
        return this._live[this._live.length - 1];
    }

    /** Forget the voices that ended on their own (or were stopped elsewhere). */
    private _prune(sound: Sound): void {
        let kept = 0;
        for (const v of this._live) if (sound.voiceAlive(v.id)) this._live[kept++] = v;
        this._live.length = kept;
    }

    /** The voice a play takes over when all are busy: the oldest, the quietest, or the farthest from the listener. */
    private _victim(sound: Sound): Voice {
        const live = this._live;
        let best = live[0];
        if (this._whenFull === 'quietest') {
            let lowest = Infinity;
            for (const v of live) {
                const level = sound.voiceLevel(v.id) * this._attenuation(v);
                // Strictly lower: on a tie the oldest goes.
                if (level < lowest) { lowest = level; best = v; }
            }
        } else if (this._whenFull === 'farthest' && this._mode === 'spatial') {
            let farthest = -1;
            for (const v of live) {
                const d = this._distance(v);
                if (d > farthest + 1e-6) { farthest = d; best = v; }
            }
        }
        return best;
    }

    /** A voice's distance from the listener: where it stays, or the node. */
    private _distance(v: Voice): number {
        return vec3.distance(v.position ?? this.worldPosition, AudioManager.Instance.listenerPosition as vec3);
    }

    /** How much of a spatial voice reaches the listener (1 for an ambient one). */
    private _attenuation(v: Voice): number {
        if (this._mode !== 'spatial') return 1;
        const s = this._spatial;
        return attenuationAt(this._distance(v), s.distanceModel, s.refDistance, s.maxDistance, s.rolloffFactor);
    }

    private _voiceVolume(sound: Sound, v: Voice): number {
        return sound.settings.volume * this._volume * this._gain * v.gain;
    }

    private _pushVolumes(): void {
        const sound = this._sample();
        if (sound) for (const v of this._live) sound.setVoiceVolume(v.id, this._voiceVolume(sound, v));
    }

    private _pushPosition(sound: Sound, v: Voice): void {
        const p = v.position ?? this.worldPosition;
        sound.setVoicePosition(v.id, p[0], p[1], p[2]);
    }

    private _pushSpatial(): void {
        const sound = this._sample();
        if (sound && this._mode === 'spatial') {
            for (const v of this._live) sound.setVoiceSpatial(v.id, this._spatial);
        }
        this._notifyChange('component', 'spatial');
    }
}

function readLoopMode(value: unknown): LoopMode {
    return value === 'on' || value === 'off' ? value : 'inherit';
}

function readVoices(value: unknown): number {
    return Math.round(clamp(finiteOr(value, 1), 1, MAX_VOICES));
}

function readWhenFull(value: unknown): WhenFull {
    return typeof value === 'string' && (WHEN_FULL as readonly string[]).includes(value) ? value as WhenFull : 'oldest';
}

function readPitchVariation(value: unknown): number {
    return clamp(finiteOr(value, 0), 0, 12);
}

function readRetrigger(value: unknown): number {
    return clamp(finiteOr(value, 0), 0, 5);
}
