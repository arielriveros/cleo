/**
 * The sequence data model: what a `.sequence` asset and a `SequenceNode`'s embedded copy hold.
 *
 * A sequence is a set of TRACKS laid out on one timeline (seconds). A track drives one thing — a bound node's
 * path, a property, the active camera — through SECTIONS: spans of time that own their keys, so moving a
 * section moves its animation with it (the video-editor model; Unreal's Sequencer works the same way).
 * Sections on one track may overlap; the later one fades over the earlier by its ease-in.
 *
 * Nodes are never named in a track. A track names a SLOT ("Camera", "Time of Day"), and the `SequenceNode`
 * playing the sequence maps slots to nodes, so one sequence can be reused with different actors.
 *
 * Pure data, no engine imports (only types from core/math): the editor, the tools that generate sequences
 * and the tests all share it.
 */

// Keys and curves are the generic keyed curves of core/math.ts (type-only: this module stays pure data).
import type { KeyedCurve, KeyInterp, TimedKey } from '../core/math';

export type { KeyInterp };

/** One key. `v` is a number or a short vector; strings and booleans only step. Times are SECTION seconds. */
export type SequenceKey<V = number | number[] | string | boolean> = TimedKey<V>;

export type SequenceCurve<V = number | number[] | string | boolean> = KeyedCurve<V>;

/** A slot a track drives; the playing `SequenceNode` maps it to a node. */
export interface SequenceSlot {
    id: string;
    name: string;
    /** The node type the slot expects ('camera', 'node', ...): a hint for the editor's pickers. */
    nodeType?: string;
    /**
     * Fallback when the SequenceNode has no binding for this slot: a node NAME path from the scene root
     * ("Buildings/Long House", or just "Time of Day"). Lets a sequence find well-known nodes by itself.
     */
    path?: string;
}

/** Common to every section. */
export interface SectionBase {
    id: string;
    /** Sequence seconds. */
    start: number;
    end: number;
    /** Seconds over which this section fades in over whatever was there, and out again. */
    easeIn?: number;
    easeOut?: number;
    /** What the target does once the timeline leaves this section: hold the end value, or go back. */
    whenFinished?: 'keep' | 'restore';
    /** Editor label. */
    label?: string;
}

/** Where a path section's subject looks. */
export type PathLook =
    | { mode: 'ahead'; distance?: number }
    | { mode: 'point'; point: [number, number, number] }
    | { mode: 'slot'; slot: string; offset?: [number, number, number] }
    /** The look target rides its own spline, by the same progress as the subject (or its own curve). */
    | { mode: 'path'; points: [number, number, number][]; progress?: SequenceCurve<number> };

/**
 * The subject rides a spline (centripetal Catmull-Rom through `points`) at constant speed along it, by
 * `progress` (0..1 over the section; linear when absent), looking per `look`.
 */
export interface PathSection extends SectionBase {
    points: [number, number, number][];
    progress?: SequenceCurve<number>;
    look?: PathLook;
    /** Degrees about the view axis. */
    roll?: SequenceCurve<number>;
    /** Vertical field of view, degrees (camera subjects only). */
    fov?: SequenceCurve<number>;
}

export interface CameraCutSection extends SectionBase {
    /** The slot of the camera this shot looks through. */
    slot: string;
}

export interface PropertySection extends SectionBase {
    curve: SequenceCurve;
}

/**
 * A blend into one of the node's own presets (the Presets menu of its inspector: Clear Sky, Thunderstorm,
 * Storm...) over the section, eased in and out. It starts from `from` (another preset of the same list) when
 * given, else from the preset of the section before it on the track, else from the values the sequence found
 * — so a chain of sections morphs the look from one preset to the next, and seeking anywhere gives the same
 * picture. Numbers and colours interpolate; everything else switches halfway.
 */
export interface PresetSection extends SectionBase {
    /** A preset id of the slot's node type (`stormy`, `windy`...). */
    preset: string;
    from?: string;
}

/**
 * Live changes to a landscape's foliage layers: each channel a multiplier on the layers' own values, keyed
 * over the section (1 = as authored). `density` thins them (FoliageLayer.densityScale), `cull` brings their
 * draw distance in, `billboard` their impostor distance; `shadows` switches their shadow casting.
 */
export interface FoliageSection extends SectionBase {
    density?: SequenceCurve<number>;
    cull?: SequenceCurve<number>;
    billboard?: SequenceCurve<number>;
    shadows?: SequenceCurve<boolean>;
}

/** The Foliage track's channels, in the order the editor lists them. */
export const FOLIAGE_CHANNELS = ['density', 'cull', 'billboard', 'shadows'] as const;
export type FoliageChannel = typeof FOLIAGE_CHANNELS[number];

/** A call at a moment: a method on the director (the SequenceNode's own script) or on a bound node. */
export interface EventKey {
    t: number;
    /** What `onEvent` listeners receive. Defaults to `method`. */
    name?: string;
    method?: string;
    /** The slot whose node receives the call; absent means the director. */
    slot?: string;
    args?: unknown[];
}

export interface TrackBase {
    id: string;
    name?: string;
    muted?: boolean;
}

export interface PathTrack extends TrackBase {
    type: 'path';
    slot: string;
    sections: PathSection[];
}

export interface CameraCutTrack extends TrackBase {
    type: 'cameraCut';
    sections: CameraCutSection[];
}

export type PropertyValueType = 'number' | 'vector' | 'bool' | 'string';

export interface PropertyTrack extends TrackBase {
    type: 'property';
    /** The node driven; absent when `target` names a global. */
    slot?: string;
    /** A global instead of a node: the renderer's settings, or the Game facade. */
    target?: 'renderer' | 'game';
    /** Dotted path from the target: 'hour', 'camera.fov', 'opacity', 'ssrMaxDistance', 'timeScale'. */
    path: string;
    valueType: PropertyValueType;
    sections: PropertySection[];
}

export interface EventTrack extends TrackBase {
    type: 'event';
    keys: EventKey[];
}

/** Preset blends on one node with a preset list: Volumetric Clouds, Wind, Weather. */
export interface PresetTrack extends TrackBase {
    type: 'preset';
    slot: string;
    sections: PresetSection[];
}

/** Foliage changes on a landscape (the slot), to the layers named, or every layer. */
export interface FoliageTrack extends TrackBase {
    type: 'foliage';
    slot: string;
    /** Layer names (FoliageLayer.name), or 'all'. */
    layers: string[] | 'all';
    sections: FoliageSection[];
}

/**
 * A stretch of time a script method takes part in: the director's (the SequenceNode's own script) or a bound
 * node's. The method is called with a {@link SequenceScriptContext}: once as the section is entered, every frame
 * it is in after that, and once as it is left — on stop too.
 */
export interface ScriptSection extends SectionBase {
    method: string;
    /** Passed on in `ctx.args`. */
    args?: unknown[];
    /**
     * Playback waits at this section's end, holding the frame, until something calls `ctx.resume()` (the
     * method, once it has what it waited for: it is still called every frame while the playback waits) or the
     * SequenceNode's `resume()`.
     */
    hold?: boolean;
}

/** What a script section's method receives. */
export interface SequenceScriptContext {
    phase: 'enter' | 'update' | 'exit';
    /** Sequence seconds. */
    time: number;
    /** Seconds into the section, and its length. */
    local: number;
    duration: number;
    /** `local / duration`, 0..1. */
    alpha: number;
    /** The section's ease-in / ease-out ramp, 0..1. */
    weight: number;
    /** Sequence seconds since the last call (0 on entering, and on a seek). */
    dt: number;
    /** The timeline jumped here (a seek or a scrub) rather than played here. */
    seeking: boolean;
    /** On `exit`: the playback was stopped (and the scene is being put back), rather than time moving on. */
    stopped: boolean;
    args: unknown[];
    /** The SequenceNode playing. */
    sequence: unknown;
    /** Let a `hold` section go: playback carries on past its end. */
    resume(): void;
}

export interface ScriptTrack extends TrackBase {
    type: 'script';
    /** The node whose method is called; absent means the director. */
    slot?: string;
    sections: ScriptSection[];
}

/**
 * A clip played on the slot's animator as an ACTION (Animator.playAction), over whatever its controller does,
 * eased in and out by the section's eases, its clip time locked to the timeline.
 */
export interface AnimationSection extends SectionBase {
    clip: string;
    /** Clip seconds at the section's start. Default 0. */
    clipStart?: number;
    /** Clip seconds per sequence second. Default 1. */
    speed?: number;
    loop?: boolean;
}

export interface AnimationTrack extends TrackBase {
    type: 'animation';
    slot: string;
    /** The animator's action slot (a masked one keeps the legs on locomotion). Default 'Sequence'. */
    animSlot?: string;
    sections: AnimationSection[];
}

/** The slot's sound node playing over the section, from `offset` into its sample. */
export interface AudioSection extends SectionBase {
    /** Sample seconds at the section's start. Default 0. */
    offset?: number;
    /** A multiplier on the node's volume over the section, 0..1 (times the eases). */
    volume?: SequenceCurve<number>;
}

export interface AudioTrack extends TrackBase {
    type: 'audio';
    slot: string;
    sections: AudioSection[];
}

/** A template instantiated while the section is in, and removed when it is left (unless `keep`). */
export interface SpawnSection extends SectionBase {
    /** Template name or id. */
    template: string;
    /** World position (or local, under `parent`), and Euler degrees. */
    position?: [number, number, number];
    rotation?: [number, number, number];
    /** Spawn under this slot's node instead of the scene root. */
    parent?: string;
    /** The new node's name. */
    name?: string;
    /** The slot the spawned node fills while it lives, so the other tracks can drive it. */
    bindAs?: string;
}

export interface SpawnTrack extends TrackBase {
    type: 'spawn';
    sections: SpawnSection[];
}

/** The controller (the track's slot) possesses the pawn in the `pawn` slot over the section. */
export interface PossessSection extends SectionBase {
    pawn: string;
}

export interface PossessTrack extends TrackBase {
    type: 'possess';
    slot: string;
    sections: PossessSection[];
}

export type SequenceTrack = PathTrack | CameraCutTrack | PropertyTrack | EventTrack | PresetTrack | FoliageTrack
    | ScriptTrack | AnimationTrack | AudioTrack | SpawnTrack | PossessTrack;
export type SequenceTrackType = SequenceTrack['type'];

export interface SequenceMarker { t: number; name: string; }

export interface SequenceData {
    version: 1;
    name: string;
    /** Seconds. */
    duration: number;
    /** The editor's snapping rate. Playback is continuous. */
    fps: number;
    /** `game` follows Game.timeScale and pauses with the game; `real` runs on the wall clock. */
    clock: 'game' | 'real';
    loop: boolean;
    slots: SequenceSlot[];
    tracks: SequenceTrack[];
    markers: SequenceMarker[];
}

export const SEQUENCE_VERSION = 1;
