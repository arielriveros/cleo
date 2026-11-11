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

export type SequenceTrack = PathTrack | CameraCutTrack | PropertyTrack | EventTrack;
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
