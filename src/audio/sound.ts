import { Howl, Howler } from "howler";
import { Logger } from "../core/logger";
import { EffectRack } from "./effectRack";
import { Mixer } from "./buses";
import { rackShapeOf } from "./soundSettings";
import type { SoundSettings, SpatialSettings } from "./soundSettings";

/**
 * One playable sample: a `Howl` over the sample's compressed bytes, plus the effect rack every voice of
 * it runs through.
 *
 * The analogue of {@link Texture} on the graphics side, and it keeps the same two promises: it retains
 * the ORIGINAL compressed bytes so the editor can persist and publish them without re-encoding, and
 * `applySettings` retunes it in place so an inspector slider is audible on the currently-playing note
 * rather than on the next one.
 *
 * ONE RACK PER SAMPLE, SHARED BY EVERY VOICE. A rapid-fire footstep can have thirty voices alive at
 * once, and thirty convolvers would cost more than the rest of the frame put together. Sharing is also
 * what a hardware mixer does — the insert belongs to the channel, not to the note.
 *
 * VOICES ARE NOT OWNED HERE. `play` hands back howler's voice id and every per-voice call takes one, so
 * several `SoundNode`s can share a sample and still be positioned, panned and stopped independently.
 */

/** Extension howler should infer the codec from, since a blob URL carries no filename. */
function formatOf(mime: string): string | undefined {
    const type = (mime || '').toLowerCase();
    if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
    if (type.includes('wav')) return 'wav';
    if (type.includes('ogg')) return 'ogg';
    if (type.includes('opus')) return 'opus';
    if (type.includes('flac')) return 'flac';
    if (type.includes('aac')) return 'aac';
    if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
    if (type.includes('webm')) return 'webm';
    return undefined;
}

/**
 * The `GainNode` a howler voice ends on — its last stage before `Howler.masterGain`, and so the point the
 * rack splices in at.
 *
 * Reaches into howler's internals, which is a deliberate and contained choice: howler exposes no public
 * handle on a voice's output node, and the alternative is losing effects and buses entirely. Kept to this
 * one function so there is a single place to fix if howler's internals move. Returns null under the
 * HTML5-audio fallback, where the voice is an `<audio>` element with no Web Audio graph at all.
 */
function voiceOutputNode(howl: Howl, voiceId: number): AudioNode | null {
    const sounds = (howl as unknown as { _sounds?: { _id: number; _node?: unknown }[] })._sounds;
    if (!Array.isArray(sounds)) return null;
    const voice = sounds.find(s => s._id === voiceId);
    const node = voice?._node;
    // An HTML5 `<audio>` element is also stored on `_node`; only a real AudioNode can be connected.
    return node && typeof (node as AudioNode).connect === 'function' ? node as AudioNode : null;
}

/** The sprite name a loop region is played under. Arbitrary, but it must not collide with a user sprite. */
const REGION_SPRITE = '__cleoLoopRegion';

export class Sound {
    private readonly _id: string;
    private readonly _bytes: Uint8Array;
    private readonly _mime: string;
    private readonly _objectUrl: string;
    private readonly _howl: Howl;
    private readonly _mixer: Mixer | null;

    private _settings: SoundSettings;
    private _rack: EffectRack | null = null;
    private _duration = 0;
    private _deleted = false;
    /** The bus the rack output is currently wired to, so a settings change knows whether to rewire. */
    private _connectedBus: string | null = null;

    constructor(id: string, bytes: Uint8Array, mime: string, settings: SoundSettings, mixer: Mixer | null = null) {
        this._id = id;
        this._bytes = bytes;
        this._mime = mime;
        this._settings = settings;
        this._mixer = mixer;

        // Cast: a Uint8Array is a valid BlobPart at runtime, but lib.dom's type is narrower.
        const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
        this._objectUrl = URL.createObjectURL(blob);

        this._howl = new Howl({
            src: [this._objectUrl],
            // A blob URL has no extension, so howler cannot sniff the codec without being told.
            format: formatOf(mime) ? [formatOf(mime) as string] : undefined,
            // Web Audio, not an <audio> element: the rack, the buses and the spatial panner all need a
            // real graph. Howler would otherwise pick HTML5 for anything it considers long.
            html5: false,
            preload: settings.preload,
            volume: settings.volume,
            rate: settings.rate,
            loop: settings.loop,
            sprite: this._spriteFor(settings),
            onload: () => { this._duration = this._howl.duration() || 0; },
            onloaderror: (_voice, err) => {
                Logger.print('warn', ['Failed to decode sound', id, err], 'Audio');
            },
        });

        // Every voice gets routed through the rack as it starts. This has to be an event rather than a
        // one-off: howler builds a fresh gain node per voice and reconnects it straight to its master.
        this._howl.on('play', (voiceId: number) => this._routeVoice(voiceId));

        this._buildRack();
    }

    public get id(): string { return this._id; }
    /** Seconds. 0 until the sample has decoded — a caller polls it or waits on `onLoad`. */
    public get duration(): number { return this._duration; }
    public get settings(): SoundSettings { return this._settings; }
    public get objectUrl(): string { return this._objectUrl; }
    /** The compressed bytes, retained so persistence and publish never re-encode. */
    public get source(): { bytes: Uint8Array; mime: string } | null {
        return this._deleted ? null : { bytes: this._bytes, mime: this._mime };
    }
    /** The underlying Howl. For the editor's transport and for scripts that want howler directly. */
    public get howl(): Howl { return this._howl; }

    /** Run `fn` once the sample has decoded, or immediately if it already has. */
    public onLoad(fn: () => void): void {
        if (this._duration > 0) fn();
        else this._howl.once('load', fn);
    }

    // -----------------------------------------------------------------------------------------------
    // Playback
    // -----------------------------------------------------------------------------------------------

    /**
     * Start a voice and return its id, or null if the sample cannot play.
     *
     * A loop REGION plays through a sprite, because that is the only route by which howler sets the
     * buffer source's `loopStart`/`loopEnd`. Looping the whole file needs no sprite and does not use one.
     */
    public play(): number | null {
        if (this._deleted) return null;
        const region = this._settings.loop && this._settings.loopEnd > this._settings.loopStart;
        const voiceId = region ? this._howl.play(REGION_SPRITE) : this._howl.play();
        if (typeof voiceId !== 'number') return null;

        if (this._settings.fadeIn > 0) {
            this._howl.volume(0, voiceId);
            this._howl.fade(0, this._settings.volume, this._settings.fadeIn * 1000, voiceId);
        }
        return voiceId;
    }

    /**
     * Stop a voice, or every voice when `voiceId` is omitted.
     * Honours `fadeOut`, which means the stop is deferred until the ramp completes.
     */
    public stop(voiceId?: number): void {
        if (this._deleted) return;
        const fade = this._settings.fadeOut;
        if (fade > 0 && typeof voiceId === 'number') {
            const from = this._howl.volume(voiceId) as unknown as number;
            this._howl.fade(typeof from === 'number' ? from : this._settings.volume, 0, fade * 1000, voiceId);
            // `once` rather than `on`: the same voice id may be reused by the pool later, and a lingering
            // handler would stop a future, unrelated note.
            this._howl.once('fade', (id: number) => { if (id === voiceId) this._howl.stop(voiceId); });
            return;
        }
        if (typeof voiceId === 'number') this._howl.stop(voiceId);
        else this._howl.stop();
    }

    public pause(voiceId?: number): void {
        if (this._deleted) return;
        if (typeof voiceId === 'number') this._howl.pause(voiceId); else this._howl.pause();
    }

    public resume(voiceId?: number): number | null {
        if (this._deleted) return null;
        const id = typeof voiceId === 'number' ? this._howl.play(voiceId) : this._howl.play();
        return typeof id === 'number' ? id : null;
    }

    public isPlaying(voiceId?: number): boolean {
        if (this._deleted) return false;
        return typeof voiceId === 'number' ? this._howl.playing(voiceId) : this._howl.playing();
    }

    /** Playhead position in seconds, for the editor's transport. */
    public seek(voiceId?: number): number {
        if (this._deleted) return 0;
        const at = typeof voiceId === 'number' ? this._howl.seek(voiceId) : this._howl.seek();
        return typeof at === 'number' ? at : 0;
    }

    public fade(from: number, to: number, seconds: number, voiceId?: number): void {
        if (this._deleted) return;
        this._howl.fade(from, to, Math.max(0, seconds) * 1000, voiceId);
    }

    // -----------------------------------------------------------------------------------------------
    // Per-voice placement — driven by SoundNode, so one sample can be ambient here and spatial there
    // -----------------------------------------------------------------------------------------------

    /** Voice gain, 0..1. The node's own volume multiplied by the sample's. */
    public setVoiceVolume(voiceId: number, volume: number): void {
        if (!this._deleted) this._howl.volume(Math.min(1, Math.max(0, volume)), voiceId);
    }

    /** Stereo pan, -1..1. Ambient voices only — a spatial voice's panner owns the stereo field. */
    public setVoicePan(voiceId: number, pan: number): void {
        if (!this._deleted) this._howl.stereo(Math.min(1, Math.max(-1, pan)), voiceId);
    }

    public setVoicePosition(voiceId: number, x: number, y: number, z: number): void {
        if (!this._deleted) this._howl.pos(x, y, z, voiceId);
    }

    public setVoiceSpatial(voiceId: number, spatial: SpatialSettings): void {
        if (this._deleted) return;
        this._howl.pannerAttr({
            // Cast: @types/howler narrows `distanceModel` to inverse|linear, but howler assigns it
            // straight onto the PannerNode, which takes all three of the Web Audio models.
            distanceModel: spatial.distanceModel as 'inverse' | 'linear',
            refDistance: spatial.refDistance,
            maxDistance: spatial.maxDistance,
            rolloffFactor: spatial.rolloffFactor,
            // No cones: the simplified panner deliberately leaves a sound omnidirectional. These are the
            // Web Audio defaults, restated so a voice recycled from a previous configuration cannot
            // inherit a cone nobody asked for.
            coneInnerAngle: 360,
            coneOuterAngle: 360,
            coneOuterGain: 0,
            panningModel: 'HRTF',
        }, voiceId);
    }

    // -----------------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------------

    /**
     * Retune to `next` without interrupting anything that is playing.
     *
     * Only a change of rack SHAPE rebuilds the graph; a parameter edit writes straight to the AudioParams.
     * That distinction is what makes dragging a cutoff slider over a sustained note silent rather than a
     * string of clicks.
     */
    public applySettings(next: SoundSettings): void {
        if (this._deleted) return;
        const previous = this._settings;
        this._settings = next;

        if (next.volume !== previous.volume) this._howl.volume(next.volume);
        if (next.rate !== previous.rate) this._howl.rate(next.rate);
        if (next.loop !== previous.loop) this._howl.loop(next.loop);

        if (next.loopStart !== previous.loopStart || next.loopEnd !== previous.loopEnd || next.loop !== previous.loop) {
            this._applyLoopRegion(next);
        }

        if (this._rack) {
            if (rackShapeOf(next.effects) === rackShapeOf(previous.effects)) this._rack.tune(next.effects);
            else this._rack.rebuild(next.effects);
        }

        if (next.bus !== this._connectedBus) this._connectOutput();
    }

    /** Free the Howl, the rack and the blob URL. The Sound is unusable afterwards. */
    public delete(): void {
        if (this._deleted) return;
        this._deleted = true;
        try { this._howl.off(); } catch { /* already torn down */ }
        try { this._howl.unload(); } catch { /* already unloaded */ }
        this._rack?.dispose();
        this._rack = null;
        URL.revokeObjectURL(this._objectUrl);
    }

    // -----------------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------------

    /** The sprite map for a settings object — one entry, or none when there is no loop region. */
    private _spriteFor(settings: SoundSettings): Record<string, [number, number, boolean]> | undefined {
        if (!settings.loop || settings.loopEnd <= settings.loopStart) return undefined;
        const start = settings.loopStart * 1000;
        return { [REGION_SPRITE]: [start, settings.loopEnd * 1000 - start, true] };
    }

    /**
     * Update the loop region on a live Howl.
     *
     * Writes `_sprite` directly. Howler has no public setter, and the alternative — constructing a new
     * Howl — would re-download and re-decode the sample and cut off anything playing, which is exactly
     * what the editor's live preview must not do. Contained here, next to `_spriteFor`, which is the only
     * other place that knows the sprite's shape.
     *
     * Takes effect on the NEXT voice: a buffer source's loop points are read when it starts.
     */
    private _applyLoopRegion(settings: SoundSettings): void {
        const sprite = this._spriteFor(settings);
        const internal = this._howl as unknown as { _sprite: Record<string, [number, number, boolean]> };
        const existing = internal._sprite || {};
        const rest: Record<string, [number, number, boolean]> = {};
        for (const key of Object.keys(existing)) {
            if (key !== REGION_SPRITE && key !== '__default') rest[key] = existing[key];
        }
        // `__default` is howler's own whole-file sprite; it rebuilds it on load, and dropping it here
        // would break a plain `play()` with no sprite name.
        if (existing.__default) rest.__default = existing.__default;
        internal._sprite = sprite ? { ...rest, ...sprite } : rest;
    }

    private _buildRack(): void {
        const ctx = Howler.ctx as AudioContext | undefined;
        // No Web Audio (howler fell back to HTML5 audio, or the device has none): the sample still plays,
        // it just has no rack and no bus. Better than refusing to play at all.
        if (!ctx) return;
        this._rack = new EffectRack(ctx);
        this._rack.rebuild(this._settings.effects);
        this._connectOutput();
    }

    /** Wire the rack's output to its bus — or straight to howler's master when there is no bus node. */
    private _connectOutput(): void {
        if (!this._rack) return;
        const master = Howler.masterGain as GainNode | undefined;
        const target = this._mixer?.nodeFor(this._settings.bus) ?? master;
        if (!target) return;
        try { this._rack.output.disconnect(); } catch { /* not connected yet */ }
        this._rack.output.connect(target);
        this._connectedBus = this._settings.bus;
    }

    /** Splice a freshly started voice into the rack. Called on every `play`, including pooled replays. */
    private _routeVoice(voiceId: number): void {
        // The rack may not exist yet if the context only became available after construction — howler
        // creates its context lazily on the first unlock, so try once more here.
        if (!this._rack) this._buildRack();
        this._rack?.attach(voiceOutputNode(this._howl, voiceId));
    }
}
