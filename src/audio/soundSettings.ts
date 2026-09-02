/**
 * Everything a user decides about a sound, plus the pure math the rest of the audio stack reads.
 *
 * Must stay a leaf: no howler, no Web Audio, no DOM. The editor imports it to type its asset record, the
 * node tests import it under `environment: 'node'`, and `attenuationAt` is drawn by the viewport gizmo as
 * well as being what the panner reproduces. A single `AudioContext` reference in here would take all three
 * away, so the file that owns the graph (effectRack.ts) is deliberately a separate module.
 *
 * The tolerant readers below — `normalizeEffects`, `clampSettings`, `parseSoundSettings` — ARE the
 * migration story, mirroring how `fromTextureConfig` reads a texture config: a field that has gained a
 * meaning, lost one, or arrived as garbage from an older project resolves to the default rather than
 * throwing. Nothing else in the audio stack validates, because everything else comes through here.
 */

/** The fixed mixer buses. Project-level state; a sample only names the one it routes into. */
export const BUS_IDS = ['master', 'music', 'sfx', 'ui'] as const;
export type BusId = typeof BUS_IDS[number];

export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';
export type Oversample = 'none' | '2x' | '4x';

/**
 * One insert in the rack. A discriminated union rather than a flat bag of optional fields, so a filter's
 * `frequency` and a delay's `time` can never be confused for each other by the settings panel.
 */
export type SoundEffect =
    | { kind: 'filter'; enabled: boolean; type: FilterKind; frequency: number; q: number }
    | { kind: 'distortion'; enabled: boolean; drive: number; oversample: Oversample }
    | { kind: 'delay'; enabled: boolean; time: number; feedback: number; mix: number }
    | { kind: 'reverb'; enabled: boolean; decay: number; preDelay: number; mix: number }
    | { kind: 'compressor'; enabled: boolean; threshold: number; knee: number; ratio: number; attack: number; release: number };

export type EffectKind = SoundEffect['kind'];

export const EFFECT_KINDS: readonly EffectKind[] = ['filter', 'distortion', 'delay', 'reverb', 'compressor'];

/**
 * Every field is required, unlike a partial options bag: an optional field here would be one the settings
 * panel has no value to show. `parseSoundSettings` is what turns a partial or stale record into one of
 * these, and it is the only way a `SoundSettings` should ever be built from untrusted data.
 */
export type SoundSettings = {
    /** 0..1. Multiplied by the node's own volume and then by the bus gain. */
    volume: number;
    /** Playback rate, 0.5..4. Changes pitch with it — there is no time-stretch. */
    rate: number;
    /**
     * Stereo pan, -1..1. Ignored by a SPATIAL SoundNode, where the panner owns the stereo field and a
     * second pan stage would fight it. Kept authored either way, so flipping a node to ambient and back
     * does not lose the value.
     */
    pan: number;
    loop: boolean;
    /** Loop region in SECONDS. `loopEnd === 0` means "to the end of the file". */
    loopStart: number;
    loopEnd: number;
    /** Fade ramps in seconds, applied on play and on stop. 0 disables. */
    fadeIn: number;
    fadeOut: number;
    bus: BusId;
    /** Decode at load rather than on first play. Worth it for a sound that must not be late. */
    preload: boolean;
    /** ORDERED — this array IS the rack. Position matters: a filter before a reverb is not the same patch. */
    effects: SoundEffect[];
};

// ---------------------------------------------------------------------------------------------------
// Defaults and clamping
// ---------------------------------------------------------------------------------------------------

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
    volume: 1,
    rate: 1,
    pan: 0,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    fadeIn: 0,
    fadeOut: 0,
    bus: 'sfx',
    preload: true,
    effects: [],
};

/** A fresh insert of `kind`, with the parameters a user would expect to hear as "barely doing anything". */
export function defaultEffect(kind: EffectKind): SoundEffect {
    switch (kind) {
        case 'filter': return { kind: 'filter', enabled: true, type: 'lowpass', frequency: 20000, q: 0.7 };
        case 'distortion': return { kind: 'distortion', enabled: true, drive: 0.2, oversample: '2x' };
        case 'delay': return { kind: 'delay', enabled: true, time: 0.25, feedback: 0.3, mix: 0.3 };
        case 'reverb': return { kind: 'reverb', enabled: true, decay: 1.8, preDelay: 0.01, mix: 0.3 };
        case 'compressor':
            return { kind: 'compressor', enabled: true, threshold: -18, knee: 30, ratio: 4, attack: 0.003, release: 0.25 };
    }
}

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback;
}

/**
 * Read one insert out of untrusted JSON. Returns null for a `kind` this build does not know, which is how
 * a project authored against a newer version degrades: the unknown insert is dropped rather than crashing
 * the rack, and every insert around it keeps its place.
 */
export function normalizeEffect(raw: unknown): SoundEffect | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    const kind = e.kind;
    if (typeof kind !== 'string' || !(EFFECT_KINDS as readonly string[]).includes(kind)) return null;

    // `enabled` defaults TRUE: an insert someone bothered to author is on unless it says otherwise.
    const enabled = e.enabled !== false;
    const d = defaultEffect(kind as EffectKind);

    switch (kind) {
        case 'filter': {
            const base = d as Extract<SoundEffect, { kind: 'filter' }>;
            return {
                kind: 'filter', enabled,
                type: oneOf<FilterKind>(e.type, ['lowpass', 'highpass', 'bandpass'], base.type),
                // 20 Hz .. 20 kHz: outside audible range a filter is either a no-op or a mute, and both
                // read to the user as "the slider is broken".
                frequency: clamp(num(e.frequency, base.frequency), 20, 20000),
                q: clamp(num(e.q, base.q), 0.0001, 30),
            };
        }
        case 'distortion': {
            const base = d as Extract<SoundEffect, { kind: 'distortion' }>;
            return {
                kind: 'distortion', enabled,
                drive: clamp(num(e.drive, base.drive), 0, 1),
                oversample: oneOf<Oversample>(e.oversample, ['none', '2x', '4x'], base.oversample),
            };
        }
        case 'delay': {
            const base = d as Extract<SoundEffect, { kind: 'delay' }>;
            return {
                kind: 'delay', enabled,
                // 5 s is the DelayNode maxDelayTime the rack allocates; asking for more would throw there.
                time: clamp(num(e.time, base.time), 0, 5),
                // Strictly below 1, or the feedback loop grows without bound and pins the output.
                feedback: clamp(num(e.feedback, base.feedback), 0, 0.95),
                mix: clamp(num(e.mix, base.mix), 0, 1),
            };
        }
        case 'reverb': {
            const base = d as Extract<SoundEffect, { kind: 'reverb' }>;
            return {
                kind: 'reverb', enabled,
                // The impulse is generated, and its cost is linear in decay — 10 s is already a cathedral.
                decay: clamp(num(e.decay, base.decay), 0.05, 10),
                preDelay: clamp(num(e.preDelay, base.preDelay), 0, 0.5),
                mix: clamp(num(e.mix, base.mix), 0, 1),
            };
        }
        case 'compressor': {
            const base = d as Extract<SoundEffect, { kind: 'compressor' }>;
            // Ranges are the DynamicsCompressorNode's own documented limits: outside them the setter throws.
            return {
                kind: 'compressor', enabled,
                threshold: clamp(num(e.threshold, base.threshold), -100, 0),
                knee: clamp(num(e.knee, base.knee), 0, 40),
                ratio: clamp(num(e.ratio, base.ratio), 1, 20),
                attack: clamp(num(e.attack, base.attack), 0, 1),
                release: clamp(num(e.release, base.release), 0, 1),
            };
        }
    }
    return null;
}

/**
 * Read a whole rack. Order is preserved — it is the one property of the array that carries meaning — and
 * unreadable entries are dropped rather than replaced with a default, so a corrupt row does not silently
 * become an audible effect nobody asked for.
 */
export function normalizeEffects(raw: unknown): SoundEffect[] {
    if (!Array.isArray(raw)) return [];
    const out: SoundEffect[] = [];
    for (const entry of raw) {
        const effect = normalizeEffect(entry);
        if (effect) out.push(effect);
    }
    return out;
}

/** Bring every field of an already-typed settings object back inside its legal range. */
export function clampSettings(s: SoundSettings): SoundSettings {
    const loopStart = Math.max(0, num(s.loopStart, 0));
    const loopEnd = Math.max(0, num(s.loopEnd, 0));
    return {
        volume: clamp(num(s.volume, 1), 0, 1),
        rate: clamp(num(s.rate, 1), 0.5, 4),
        pan: clamp(num(s.pan, 0), -1, 1),
        loop: !!s.loop,
        loopStart,
        // A region that ends before it starts is not a region. Zeroing `loopEnd` reads as "to the end of
        // the file", which is the one interpretation that always produces audio.
        loopEnd: loopEnd > loopStart ? loopEnd : 0,
        fadeIn: clamp(num(s.fadeIn, 0), 0, 60),
        fadeOut: clamp(num(s.fadeOut, 0), 0, 60),
        bus: oneOf<BusId>(s.bus, BUS_IDS, 'sfx'),
        preload: s.preload !== false,
        effects: normalizeEffects(s.effects),
    };
}

/** Build a full `SoundSettings` from anything — a partial, a stale record, `undefined`, or junk. */
export function parseSoundSettings(raw: unknown): SoundSettings {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SOUND_SETTINGS, effects: [] };
    const r = raw as Partial<SoundSettings>;
    return clampSettings({
        volume: num(r.volume, DEFAULT_SOUND_SETTINGS.volume),
        rate: num(r.rate, DEFAULT_SOUND_SETTINGS.rate),
        pan: num(r.pan, DEFAULT_SOUND_SETTINGS.pan),
        loop: r.loop === true,
        loopStart: num(r.loopStart, 0),
        loopEnd: num(r.loopEnd, 0),
        fadeIn: num(r.fadeIn, 0),
        fadeOut: num(r.fadeOut, 0),
        bus: oneOf<BusId>(r.bus, BUS_IDS, DEFAULT_SOUND_SETTINGS.bus),
        preload: r.preload !== false,
        effects: normalizeEffects(r.effects),
    });
}

/**
 * Whether two racks need the graph rebuilt, as opposed to merely retuned.
 *
 * This is the whole reason `EffectRack` splits `rebuild` from `tune`: dragging a cutoff slider must not
 * disconnect and reconnect nodes under a playing voice, which is audible as a click. Only the SHAPE —
 * how many inserts, in what order, which of them are on — can require surgery.
 */
export function rackShapeOf(effects: SoundEffect[]): string {
    return effects.map(e => `${e.kind}:${e.enabled ? 1 : 0}`).join('|');
}

// ---------------------------------------------------------------------------------------------------
// Distance attenuation
// ---------------------------------------------------------------------------------------------------

export type DistanceModel = 'inverse' | 'linear' | 'exponential';

export const DISTANCE_MODELS: readonly DistanceModel[] = ['inverse', 'linear', 'exponential'];

/** The spatial half of a SoundNode. Authored per placement, not per sample — see soundNode.ts. */
export type SpatialSettings = {
    distanceModel: DistanceModel;
    /** Distance at which the sound is at full volume. Louder than this it does not get. */
    refDistance: number;
    /** `linear` silences at this distance; the other two only use it as a clamp. */
    maxDistance: number;
    /** How fast it falls off. 0 is no attenuation at all. */
    rolloffFactor: number;
};

export const DEFAULT_SPATIAL_SETTINGS: SpatialSettings = {
    distanceModel: 'inverse',
    refDistance: 1,
    maxDistance: 100,
    rolloffFactor: 1,
};

export function parseSpatialSettings(raw: unknown): SpatialSettings {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpatialSettings>;
    const refDistance = Math.max(0.0001, num(r.refDistance, DEFAULT_SPATIAL_SETTINGS.refDistance));
    return {
        distanceModel: oneOf<DistanceModel>(r.distanceModel, DISTANCE_MODELS, DEFAULT_SPATIAL_SETTINGS.distanceModel),
        refDistance,
        // Never below refDistance: `linear` divides by (max - ref) and would produce a negative gain.
        maxDistance: Math.max(refDistance + 0.0001, num(r.maxDistance, DEFAULT_SPATIAL_SETTINGS.maxDistance)),
        rolloffFactor: clamp(num(r.rolloffFactor, DEFAULT_SPATIAL_SETTINGS.rolloffFactor), 0, 10),
    };
}

/**
 * The gain a listener `distance` away hears, 0..1.
 *
 * These are the three formulae from the Web Audio `PannerNode` spec, reimplemented rather than measured
 * off a live node, because the editor has to draw the falloff curve for a node that is not playing — and
 * because they are the only part of the spatial path that can be tested without an `AudioContext`.
 * Keeping them here means the gizmo and the panner can never disagree about where a sound goes quiet.
 */
export function attenuationAt(
    distance: number, model: DistanceModel, refDistance: number, maxDistance: number, rolloffFactor: number,
): number {
    const ref = Math.max(0.0001, refDistance);
    const max = Math.max(ref + 0.0001, maxDistance);
    const rolloff = Math.max(0, rolloffFactor);
    // Inside the reference radius everything is at full volume; that is what "reference" means.
    const d = Math.max(ref, Number.isFinite(distance) ? distance : ref);

    switch (model) {
        case 'linear': {
            // The one model that reaches exactly zero, and it does so AT maxDistance rather than beyond it.
            const clamped = Math.min(d, max);
            return clamp(1 - rolloff * (clamped - ref) / (max - ref), 0, 1);
        }
        case 'exponential':
            return clamp(Math.pow(d / ref, -rolloff), 0, 1);
        case 'inverse':
        default:
            return clamp(ref / (ref + rolloff * (d - ref)), 0, 1);
    }
}
