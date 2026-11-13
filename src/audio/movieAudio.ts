import type { BusId, SoundSettings, SpatialSettings } from './soundSettings';
import { BUS_IDS } from './soundSettings';

/**
 * A movie's sound (src/sequencer/movie/): recorded as what was ASKED of the audio stack, then mixed offline.
 *
 * A movie renders slower (or faster) than real time, so its sound cannot be captured from the speakers: a
 * voice started at movie second 3 would have played on for however long the frames took to draw. Instead,
 * while a recording is active every `Sound` is VIRTUAL — `play` starts no Howl, and the voice's position is
 * computed from the movie's clock and its rate — and every voice operation is logged at the movie time it
 * was made. Afterwards `mixAudioLog` replays the log through an `OfflineAudioContext`, the voices through
 * the same effect racks, buses and spatial panners the live game uses, and hands the mix out window by
 * window for the encoder.
 *
 * Virtual voices also answer `seek()` and `isPlaying()` from the movie clock, which matters beyond
 * silence: the sequencer's audio track re-seeks a voice that drifts more than 0.2 s from its timeline. On
 * real playback under a slow render it would drift constantly; a virtual voice never does.
 *
 * Everything above `mixAudioLog` is pure (no Web Audio, no howler), so the recorder and the schedule are
 * testable in node.
 */

// ---------------------------------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export type AudioOp =
    | { op: 'play'; t: number; voice: number; sound: string; offset: number; volume: number; rate: number;
        loop: boolean; region: [number, number] | null }
    | { op: 'stop'; t: number; voice: number; fade: number }
    | { op: 'pause'; t: number; voice: number }
    | { op: 'resume'; t: number; voice: number }
    | { op: 'seek'; t: number; voice: number; offset: number }
    | { op: 'rate'; t: number; voice: number; rate: number }
    | { op: 'loop'; t: number; voice: number; loop: boolean }
    | { op: 'volume'; t: number; voice: number; volume: number }
    | { op: 'fade'; t: number; voice: number; from: number; to: number; seconds: number }
    | { op: 'pan'; t: number; voice: number; pan: number }
    | { op: 'position'; t: number; voice: number; position: Vec3 }
    | { op: 'spatial'; t: number; voice: number; spatial: SpatialSettings }
    | { op: 'listener'; t: number; position: Vec3; forward: Vec3; up: Vec3 }
    | { op: 'bus'; t: number; bus: BusId; gain: number; muted: boolean }
    | { op: 'master'; t: number; volume: number };

/** A sample the log played, with what the mix needs to play it again. */
export interface AudioLogSound {
    id: string;
    bytes: Uint8Array;
    mime: string;
    settings: SoundSettings;
    /** Seconds, 0 when it had not decoded when first played. */
    duration: number;
}

export interface AudioLog {
    /** Movie seconds the log covers. */
    duration: number;
    sounds: Record<string, AudioLogSound>;
    ops: AudioOp[];
    /** The mixer when recording began: each bus's gain and mute, and the master volume. */
    buses: Record<BusId, { gain: number; muted: boolean }>;
    master: number;
}

/** What the recorder reads of a `Sound` (structural, so the tests need no howler). */
export interface RecordedSound {
    readonly id: string;
    readonly settings: SoundSettings;
    /** Seconds; 0 until decoded. */
    readonly duration: number;
    readonly source: { bytes: Uint8Array; mime: string } | null;
}

/** Where a voice is in its sample at `t`: a piece of constant rate from `t0`, at `offset` into the file. */
function filePosition(offset: number, t0: number, rate: number, t: number, loop: boolean,
                      region: [number, number] | null, duration: number): { position: number; ended: boolean } {
    let p = offset + Math.max(0, t - t0) * rate;
    if (loop) {
        const [a, b] = region ?? [0, duration];
        if (b > a && p >= b) p = a + ((p - a) % (b - a));
        return { position: p, ended: false };
    }
    if (duration > 0 && p >= duration) return { position: duration, ended: true };
    return { position: p, ended: false };
}

interface VirtualVoice {
    id: number;
    sound: RecordedSound;
    playing: boolean;
    paused: boolean;
    loop: boolean;
    region: [number, number] | null;
    /** The current constant-rate piece: from `t0`, `offset` into the file, at `rate`. */
    t0: number;
    offset: number;
    rate: number;
    /** A stop with a fade-out: the voice sounds until then. */
    stopAt: number;
    volume: number;
}

/**
 * The live half: virtual voices plus the log. Install with {@link setAudioRecorder}; `Sound`, the mixer and
 * the listener route through it while it is installed.
 */
export class AudioRecorder {
    private readonly _voices = new Map<number, VirtualVoice>();
    private _next = 1;
    private readonly _ops: AudioOp[] = [];
    private readonly _sounds: Record<string, AudioLogSound> = {};

    constructor(private readonly _clock: () => number,
                private readonly _buses: Record<BusId, { gain: number; muted: boolean }>,
                private readonly _master: number) {}

    /** Movie seconds now. */
    public get now(): number { return this._clock(); }

    private _log(op: AudioOp): void { this._ops.push(op); }

    private _voice(id: number | undefined): VirtualVoice | undefined {
        return typeof id === 'number' ? this._voices.get(id) : undefined;
    }

    private _voicesOf(sound: RecordedSound, id?: number): VirtualVoice[] {
        if (typeof id === 'number') { const v = this._voices.get(id); return v && v.sound === sound ? [v] : []; }
        return [...this._voices.values()].filter(v => v.sound === sound);
    }

    /** The voice's position now, ending it if it ran out. */
    private _position(v: VirtualVoice, t = this.now): number {
        if (!v.playing || v.paused) return v.offset;
        const at = filePosition(v.offset, v.t0, v.rate, t, v.loop, v.region, v.sound.duration);
        if (at.ended || t >= v.stopAt) { v.playing = false; v.offset = at.position; }
        return at.position;
    }

    /** Start the clock's piece over at `t` (a rate or loop change, a seek): the position carries on from here. */
    private _rebase(v: VirtualVoice, t: number, offset = this._position(v, t)): void {
        v.offset = offset;
        v.t0 = t;
    }

    public play(sound: RecordedSound): number {
        const t = this.now;
        if (!this._sounds[sound.id] && sound.source) {
            this._sounds[sound.id] = { id: sound.id, bytes: sound.source.bytes, mime: sound.source.mime,
                                       settings: structuredClone(sound.settings), duration: sound.duration };
        }
        const s = sound.settings;
        const region: [number, number] | null = s.loop && s.loopEnd > s.loopStart ? [s.loopStart, s.loopEnd] : null;
        const id = this._next++;
        const rate = Math.min(4, Math.max(0.5, s.rate || 1));
        const volume = s.fadeIn > 0 ? 0 : s.volume;
        const voice: VirtualVoice = { id, sound, playing: true, paused: false, loop: s.loop, region, t0: t,
                                      offset: region ? region[0] : 0, rate, stopAt: Infinity, volume };
        this._voices.set(id, voice);
        this._log({ op: 'play', t, voice: id, sound: sound.id, offset: voice.offset, volume, rate, loop: s.loop, region });
        if (s.fadeIn > 0) this.fade(sound, 0, s.volume, s.fadeIn, id);
        return id;
    }

    public stop(sound: RecordedSound, id?: number): void {
        const t = this.now;
        const fade = typeof id === 'number' ? Math.max(0, sound.settings.fadeOut) : 0;
        for (const v of this._voicesOf(sound, id)) {
            if (!v.playing) continue;
            this._log({ op: 'stop', t, voice: v.id, fade });
            if (fade > 0) { v.stopAt = t + fade; continue; }
            this._rebase(v, t);
            v.playing = false;
        }
    }

    public pause(sound: RecordedSound, id?: number): void {
        const t = this.now;
        for (const v of this._voicesOf(sound, id)) {
            if (!v.playing || v.paused) continue;
            this._rebase(v, t);
            v.paused = true;
            this._log({ op: 'pause', t, voice: v.id });
        }
    }

    public resume(sound: RecordedSound, id?: number): number | null {
        const t = this.now;
        let last: number | null = null;
        for (const v of this._voicesOf(sound, id)) {
            if (!v.paused) continue;
            v.paused = false;
            v.t0 = t;
            this._log({ op: 'resume', t, voice: v.id });
            last = v.id;
        }
        return last;
    }

    public isPlaying(sound: RecordedSound, id?: number): boolean {
        return this._voicesOf(sound, id).some(v => { this._position(v); return v.playing && !v.paused; });
    }

    public seek(sound: RecordedSound, id?: number): number {
        const v = this._voicesOf(sound, id)[0];
        return v ? this._position(v) : 0;
    }

    public seekVoice(id: number, seconds: number): void {
        const v = this._voice(id);
        if (!v || !Number.isFinite(seconds)) return;
        const t = this.now;
        this._rebase(v, t, Math.max(0, seconds));
        this._log({ op: 'seek', t, voice: id, offset: v.offset });
    }

    /** `rate` is the effective one (the sample's times the voice's), clamped as howler clamps it. */
    public setRate(id: number, rate: number): void {
        const v = this._voice(id);
        if (!v || !Number.isFinite(rate)) return;
        const t = this.now;
        this._rebase(v, t);
        v.rate = Math.min(4, Math.max(0.5, rate));
        this._log({ op: 'rate', t, voice: id, rate: v.rate });
    }

    public setLoop(id: number, loop: boolean): void {
        const v = this._voice(id);
        if (!v) return;
        const t = this.now;
        this._rebase(v, t);
        v.loop = loop;
        this._log({ op: 'loop', t, voice: id, loop });
    }

    public fade(sound: RecordedSound, from: number, to: number, seconds: number, id?: number): void {
        const t = this.now;
        for (const v of this._voicesOf(sound, id)) {
            v.volume = to;
            this._log({ op: 'fade', t, voice: v.id, from, to, seconds: Math.max(0, seconds) });
        }
    }

    public setVolume(id: number, volume: number): void {
        const v = this._voice(id);
        if (!v) return;
        v.volume = volume;
        this._log({ op: 'volume', t: this.now, voice: id, volume });
    }

    public setPan(id: number, pan: number): void {
        if (this._voice(id)) this._log({ op: 'pan', t: this.now, voice: id, pan });
    }

    public setPosition(id: number, x: number, y: number, z: number): void {
        if (this._voice(id)) this._log({ op: 'position', t: this.now, voice: id, position: [x, y, z] });
    }

    public setSpatial(id: number, spatial: SpatialSettings): void {
        if (this._voice(id)) this._log({ op: 'spatial', t: this.now, voice: id, spatial: { ...spatial } });
    }

    /** The voice's current gain, for a fade-out that starts from it. */
    public volumeOf(id: number): number { return this._voice(id)?.volume ?? 0; }

    public listener(position: ArrayLike<number>, forward: ArrayLike<number>, up: ArrayLike<number>): void {
        this._log({ op: 'listener', t: this.now, position: [position[0], position[1], position[2]],
                    forward: [forward[0], forward[1], forward[2]], up: [up[0], up[1], up[2]] });
    }

    public bus(bus: BusId, gain: number, muted: boolean): void {
        this._log({ op: 'bus', t: this.now, bus, gain, muted });
    }

    public master(volume: number): void {
        this._log({ op: 'master', t: this.now, volume });
    }

    /**
     * The log, closed at `duration` seconds and timed from `origin` (the clock's reading at the movie's first
     * frame): what was asked before it, in a pre-roll, lands at negative times and is mixed in part-way.
     */
    public finish(duration: number, origin = 0): AudioLog {
        const ops = this._ops.map(op => ({ ...op, t: op.t - origin }) as AudioOp);
        return { duration: Math.max(0, duration), sounds: { ...this._sounds }, ops,
                 buses: structuredClone(this._buses), master: this._master };
    }
}

let active: AudioRecorder | null = null;

/** The recording in progress, or null: `Sound`, the mixer and the listener check it on every call. */
export function audioRecorder(): AudioRecorder | null { return active; }

/** Install (or with null, remove) the recording. */
export function setAudioRecorder(recorder: AudioRecorder | null): void { active = recorder; }

// ---------------------------------------------------------------------------------------------------
// The schedule: the log as per-voice pieces and automation, pure
// ---------------------------------------------------------------------------------------------------

/** One stretch of a voice at constant rate: from `t0` until `t1` (Infinity: until it ends by itself). */
export interface VoicePiece {
    t0: number;
    t1: number;
    /** Seconds into the sample at `t0`. */
    offset: number;
    rate: number;
    loop: boolean;
}

/** A value from `t` on; `ramp`: reached linearly from the previous key rather than stepped to. */
export interface AudioKey {
    t: number;
    v: number;
    ramp?: boolean;
}

export interface VoicePlan {
    voice: number;
    sound: string;
    region: [number, number] | null;
    pieces: VoicePiece[];
    gain: AudioKey[];
    pan: AudioKey[];
    /** Null for an ambient voice; set once a position or spatial setting arrives. */
    spatial: SpatialSettings | null;
    /** Positions as keys per axis, ramped between the frames they were set in. */
    position: [AudioKey[], AudioKey[], AudioKey[]];
}

export interface AudioSchedule {
    duration: number;
    voices: VoicePlan[];
    /** Listener position, forward and up, nine keyed axes (px py pz fx fy fz ux uy uz). */
    listener: AudioKey[][];
    buses: Record<BusId, AudioKey[]>;
    master: AudioKey[];
}

/** Value of keyed automation at `t` (steps and ramps as Web Audio plays them). Before the first key: its value. */
export function keyValueAt(keys: readonly AudioKey[], t: number, fallback: number): number {
    if (keys.length === 0) return fallback;
    if (t < keys[0].t) return keys[0].v;
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
    const next = keys[i + 1];
    if (next?.ramp && next.t > keys[i].t) {
        const a = (t - keys[i].t) / (next.t - keys[i].t);
        return keys[i].v + (next.v - keys[i].v) * a;
    }
    return keys[i].v;
}

/**
 * Add a key, dropping any later ones: a value set mid-fade ends the fade where it had got to, as howler's
 * volume() does.
 */
function pushKey(keys: AudioKey[], key: AudioKey): void {
    const reached = keyValueAt(keys, key.t, key.v);
    let cutRamp = false;
    while (keys.length && keys[keys.length - 1].t > key.t) {
        if (keys[keys.length - 1].ramp) cutRamp = true;
        keys.pop();
    }
    if (cutRamp) keys.push({ t: key.t, v: reached, ramp: true });
    keys.push(key);
}

interface VoiceState {
    /** The open piece, or null while paused or stopped. */
    piece: VoicePiece | null;
    paused: boolean;
    /** Where a paused voice picks up, and the rate and loop it picks up with. */
    resumeAt: number;
    rate: number;
    loop: boolean;
    duration: number;
}

/** Turn a log into per-voice pieces and automation. */
export function buildAudioSchedule(log: AudioLog): AudioSchedule {
    const plans = new Map<number, VoicePlan>();
    const states = new Map<number, VoiceState>();
    const listener: AudioKey[][] = Array.from({ length: 9 }, () => []);
    const buses = {} as Record<BusId, AudioKey[]>;
    for (const bus of BUS_IDS) {
        const b = log.buses[bus] ?? { gain: 1, muted: false };
        buses[bus] = [{ t: 0, v: b.muted ? 0 : b.gain }];
    }
    const master: AudioKey[] = [{ t: 0, v: log.master }];

    /** Where the voice is at `t`, on its open piece. */
    const positionAt = (plan: VoicePlan, s: VoiceState, t: number): number => {
        const p = s.piece;
        if (!p) return s.resumeAt;
        return filePosition(p.offset, p.t0, p.rate, t, p.loop, plan.region, s.duration).position;
    };
    /** End the open piece at `t` and return where the voice got to. */
    const close = (plan: VoicePlan, s: VoiceState, t: number): number => {
        const at = positionAt(plan, s, t);
        if (s.piece) s.piece.t1 = t;
        s.piece = null;
        return at;
    };
    const open = (plan: VoicePlan, s: VoiceState, t: number, offset: number): void => {
        const piece: VoicePiece = { t0: t, t1: Infinity, offset, rate: s.rate, loop: s.loop };
        plan.pieces.push(piece);
        s.piece = piece;
    };

    for (const op of log.ops) {
        if (op.op === 'listener') {
            const v = [...op.position, ...op.forward, ...op.up];
            for (let i = 0; i < 9; i++) pushKey(listener[i], { t: op.t, v: v[i], ramp: listener[i].length > 0 });
            continue;
        }
        if (op.op === 'bus') { pushKey(buses[op.bus], { t: op.t, v: op.muted ? 0 : op.gain }); continue; }
        if (op.op === 'master') { pushKey(master, { t: op.t, v: op.volume }); continue; }
        if (op.op === 'play') {
            const plan: VoicePlan = { voice: op.voice, sound: op.sound, region: op.region, pieces: [],
                                      gain: [{ t: op.t, v: op.volume }], pan: [], spatial: null, position: [[], [], []] };
            const s: VoiceState = { piece: null, paused: false, resumeAt: op.offset, rate: op.rate, loop: op.loop,
                                    duration: log.sounds[op.sound]?.duration ?? 0 };
            open(plan, s, op.t, op.offset);
            plans.set(op.voice, plan);
            states.set(op.voice, s);
            continue;
        }
        const plan = plans.get(op.voice);
        const s = states.get(op.voice);
        if (!plan || !s) continue;
        switch (op.op) {
            case 'stop': {
                if (op.fade > 0) {
                    pushKey(plan.gain, { t: op.t, v: keyValueAt(plan.gain, op.t, 0) });
                    pushKey(plan.gain, { t: op.t + op.fade, v: 0, ramp: true });
                    if (s.piece) s.piece.t1 = op.t + op.fade;
                    s.piece = null;
                } else close(plan, s, op.t);
                s.paused = false;
                break;
            }
            case 'pause': {
                if (!s.piece) break;
                s.resumeAt = close(plan, s, op.t);
                s.paused = true;
                break;
            }
            case 'resume': {
                if (!s.paused) break;
                s.paused = false;
                open(plan, s, op.t, s.resumeAt);
                break;
            }
            case 'seek': case 'rate': case 'loop': {
                // On a paused voice the change waits for the resume; on a playing one it starts a new piece.
                const playing = !!s.piece;
                const position = op.op === 'seek' ? op.offset : positionAt(plan, s, op.t);
                if (playing) close(plan, s, op.t);
                if (op.op === 'rate') s.rate = op.rate;
                if (op.op === 'loop') s.loop = op.loop;
                if (playing) open(plan, s, op.t, position);
                else if (s.paused) s.resumeAt = position;
                break;
            }
            case 'volume': pushKey(plan.gain, { t: op.t, v: op.volume }); break;
            case 'fade': {
                pushKey(plan.gain, { t: op.t, v: op.from });
                pushKey(plan.gain, { t: op.t + op.seconds, v: op.to, ramp: op.seconds > 0 });
                break;
            }
            case 'pan': pushKey(plan.pan, { t: op.t, v: op.pan }); break;
            case 'spatial': plan.spatial = { ...op.spatial }; break;
            case 'position': {
                plan.spatial ??= { distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1 };
                for (let i = 0; i < 3; i++)
                    pushKey(plan.position[i], { t: op.t, v: op.position[i], ramp: plan.position[i].length > 0 });
                break;
            }
        }
    }
    // Open pieces play on to their natural end (or the movie's); empty ones (a stop at the start) go.
    const voices = [...plans.values()].map(plan => ({ ...plan, pieces: plan.pieces.filter(p => p.t1 > p.t0) }));
    return { duration: log.duration, voices, listener, buses, master };
}

// ---------------------------------------------------------------------------------------------------
// The mix (Web Audio)
// ---------------------------------------------------------------------------------------------------

export interface MixOptions {
    sampleRate?: number;
    channels?: number;
    /** Seconds mixed before each window and dropped, so reverb and delay tails carry across windows. */
    preRoll?: number;
}

/** Schedule automation keys onto `param`, for the window starting at `base` (context time 0) and ending at `end`. */
function automate(param: AudioParam, keys: readonly AudioKey[], base: number, end: number, fallback: number): void {
    param.setValueAtTime(keyValueAt(keys, base, fallback), 0);
    for (const key of keys) {
        if (key.t <= base) continue;
        if (key.t >= end) {
            // A ramp that ends after the window still has to move inside it.
            if (key.ramp) param.linearRampToValueAtTime(keyValueAt(keys, end, fallback), end - base);
            break;
        }
        if (key.ramp) param.linearRampToValueAtTime(key.v, key.t - base);
        else param.setValueAtTime(key.v, key.t - base);
    }
}

/**
 * Mixes a recorded log offline, one window at a time, through the effect racks, buses and panners the live
 * game uses. A window can be mixed as soon as the log reaches its end (what is asked later cannot change
 * it), so a movie mixes its sound alongside its frames and the encoder interleaves the two. Each window is
 * mixed with a pre-roll before it, dropped from the result, so a reverb's tail carries across the seam.
 */
export class AudioMixdown {
    private readonly _decoded = new Map<string, AudioBuffer | null>();
    public readonly sampleRate: number;
    public readonly channels: number;
    private readonly _preRoll: number;

    constructor(options: MixOptions = {}) {
        this.sampleRate = options.sampleRate ?? 48000;
        this.channels = options.channels ?? 2;
        this._preRoll = Math.max(0, options.preRoll ?? 3);
    }

    /** The mix of [from, to) movie seconds of `log` (which must reach `to`), as one buffer. */
    public async mix(log: AudioLog, from: number, to: number): Promise<AudioBuffer> {
        const { EffectRack } = await import('./effectRack');
        const sampleRate = this.sampleRate, channels = this.channels;
        const schedule = buildAudioSchedule(log);
        const pre = Math.min(this._preRoll, Math.max(0, from));
        const base = from - pre;
        const frames = Math.max(1, Math.round((to - base) * sampleRate));
        const ctx = new OfflineAudioContext(channels, frames, sampleRate);

        for (const [id, sound] of Object.entries(log.sounds)) {
            if (this._decoded.has(id)) continue;
            try {
                this._decoded.set(id, await ctx.decodeAudioData(sound.bytes.slice().buffer));
            } catch {
                // An undecodable sample is silent in the movie, as it was in the game.
                this._decoded.set(id, null);
            }
        }

        const masterGain = ctx.createGain();
        masterGain.connect(ctx.destination);
        automate(masterGain.gain, schedule.master, base, to, 1);
        // The master bus's own gain and mute are howler's volume too: one more node in front of it.
        const masterBus = ctx.createGain();
        masterBus.connect(masterGain);
        automate(masterBus.gain, schedule.buses.master, base, to, 1);
        const busNodes = new Map<BusId, GainNode>();
        for (const bus of BUS_IDS) {
            if (bus === 'master') continue;
            const node = ctx.createGain();
            node.connect(masterGain);
            automate(node.gain, schedule.buses[bus], base, to, 1);
            busNodes.set(bus, node);
        }

        const l = ctx.listener;
        const axes = [l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ];
        const listenerDefaults = [0, 0, 0, 0, 0, -1, 0, 1, 0];
        if (axes.every(a => !!a)) for (let i = 0; i < 9; i++) automate(axes[i], schedule.listener[i], base, to, listenerDefaults[i]);

        const racks = new Map<string, InstanceType<typeof EffectRack>>();
        for (const plan of schedule.voices) {
            const buffer = this._decoded.get(plan.sound);
            const sound = log.sounds[plan.sound];
            if (!buffer || !sound) continue;
            const pieces = plan.pieces.filter(p => p.t1 > base && p.t0 < to);
            if (pieces.length === 0) continue;

            let rack = racks.get(plan.sound);
            if (!rack) {
                rack = new EffectRack(ctx);
                rack.rebuild(sound.settings.effects);
                rack.output.connect(busNodes.get(sound.settings.bus) ?? masterBus);
                racks.set(plan.sound, rack);
            }
            const gain = ctx.createGain();
            automate(gain.gain, plan.gain, base, to, 1);
            let out: AudioNode = gain;
            if (plan.spatial) {
                const panner = ctx.createPanner();
                panner.panningModel = 'HRTF';
                panner.distanceModel = plan.spatial.distanceModel;
                panner.refDistance = plan.spatial.refDistance;
                panner.maxDistance = plan.spatial.maxDistance;
                panner.rolloffFactor = plan.spatial.rolloffFactor;
                panner.coneInnerAngle = 360; panner.coneOuterAngle = 360; panner.coneOuterGain = 0;
                automate(panner.positionX, plan.position[0], base, to, 0);
                automate(panner.positionY, plan.position[1], base, to, 0);
                automate(panner.positionZ, plan.position[2], base, to, 0);
                gain.connect(panner);
                out = panner;
            } else if (plan.pan.length > 0) {
                const stereo = ctx.createStereoPanner();
                automate(stereo.pan, plan.pan, base, to, 0);
                gain.connect(stereo);
                out = stereo;
            }
            rack.attach(out);

            const duration = sound.duration > 0 ? sound.duration : buffer.duration;
            for (const piece of pieces) {
                const start = Math.max(piece.t0, base);
                const at = filePosition(piece.offset, piece.t0, piece.rate, start, piece.loop, plan.region, duration);
                if (at.ended) continue;
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.playbackRate.value = piece.rate;
                if (piece.loop) {
                    source.loop = true;
                    const [a, b] = plan.region ?? [0, buffer.duration];
                    source.loopStart = a;
                    source.loopEnd = b;
                }
                source.connect(gain);
                source.start(start - base, at.position);
                if (piece.t1 < to) source.stop(piece.t1 - base);
            }
        }

        const rendered = await ctx.startRendering();
        const skip = Math.round(pre * sampleRate);
        const length = Math.max(1, Math.round((to - from) * sampleRate));
        const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
        for (let c = 0; c < channels; c++)
            out.copyToChannel(rendered.getChannelData(c).subarray(skip, skip + length), c);
        return out;
    }
}

/** Mix a whole finished log, `windowSeconds` at a time, handing each window to `onWindow` in order. */
export async function mixAudioLog(log: AudioLog, options: MixOptions & {
    windowSeconds?: number;
    onWindow: (buffer: AudioBuffer, startSeconds: number) => Promise<void> | void;
    signal?: AbortSignal;
}): Promise<void> {
    const mixdown = new AudioMixdown(options);
    const step = Math.max(1, options.windowSeconds ?? 30);
    for (let w0 = 0; w0 < log.duration - 1e-9; w0 += step) {
        if (options.signal?.aborted) return;
        const w1 = Math.min(log.duration, w0 + step);
        await options.onWindow(await mixdown.mix(log, w0, w1), w0);
    }
}
