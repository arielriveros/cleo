import type { PerceptionTuning } from "../../../ai/perception";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click AI tunings for ControllerNode. Perception presets replace `node.perception` (cone, range,
 * memory, reaction) but never the eye height, which belongs to the pawn's size, nor auto-acquire. Flocking
 * presets set the neighbour radius and the three urges.
 */
export type PerceptionPreset = Preset<PerceptionTuning>;

const PERCEPTION_BASE: PerceptionTuning = { fieldOfView: 120, range: 20, memorySpan: 5, reactionTime: 0.25 };

export const PERCEPTION_PRESETS: PerceptionPreset[] = definePresets(PERCEPTION_BASE, [
    ['guard', 'Guard', 'The default: a human-like forward cone, a room or two of range, a few seconds of memory.', {}],
    ['sentry', 'Sentry / Camera', 'Sees all the way round but forgets quickly — security cameras, turrets.',
        { fieldOfView: 360, range: 25, memorySpan: 3, reactionTime: 0.5 }],
    ['sniper', 'Sniper', 'A narrow, very long cone; slow to commit to what it sees.',
        { fieldOfView: 40, range: 80, memorySpan: 10, reactionTime: 0.6 }],
    ['hunter', 'Hunter', 'An alert predator: wide view, long memory, reacts almost at once.',
        { fieldOfView: 200, range: 35, memorySpan: 15, reactionTime: 0.12 }],
    ['shortSighted', 'Short-Sighted', 'Shamblers and beasts: only notices what is close, forgets fast.',
        { fieldOfView: 160, range: 8, memorySpan: 2, reactionTime: 0.8 }],
    ['senses', 'Close Senses', 'Notices anything nearby in every direction, instantly — smell, hearing, tremor.',
        { fieldOfView: 360, range: 6, memorySpan: 1, reactionTime: 0 }],
]);

/** The ControllerNode flocking fields a preset sets. */
export interface FlockingPresetOptions {
    flockRadius?: number;
    separationWeight?: number;
    alignmentWeight?: number;
    cohesionWeight?: number;
}

export type FlockingPreset = Preset<FlockingPresetOptions>;

const FLOCKING_BASE: FlockingPresetOptions = { flockRadius: 6, separationWeight: 1.5, alignmentWeight: 1, cohesionWeight: 0.8 };

export const FLOCKING_PRESETS: FlockingPreset[] = definePresets(FLOCKING_BASE, [
    ['default', 'Default', 'Balanced urges over a six-metre neighbourhood.', {}],
    ['fish', 'School of Fish', 'Tight and strongly aligned — the group turns as one.',
        { flockRadius: 4, separationWeight: 1.2, alignmentWeight: 2, cohesionWeight: 1.5 }],
    ['birds', 'Bird Flock', 'Wide, loose and aligned.',
        { flockRadius: 10, separationWeight: 1.5, alignmentWeight: 1.5, cohesionWeight: 1 }],
    ['crowd', 'Crowd', 'Pedestrians: keep their personal space and barely herd.',
        { flockRadius: 3, separationWeight: 2.5, alignmentWeight: 0.3, cohesionWeight: 0.2 }],
    ['swarm', 'Swarm', 'Insects: little shared heading, a strong pull to the centre.',
        { flockRadius: 6, separationWeight: 0.8, alignmentWeight: 0.4, cohesionWeight: 2.2 }],
    ['herd', 'Herd', 'Grazing animals: well spaced, drifting together over a wide area.',
        { flockRadius: 12, separationWeight: 2, alignmentWeight: 0.8, cohesionWeight: 0.6 }],
    ['off', 'Off', 'No flocking — skips the neighbour scan entirely.', { flockRadius: 0 }],
]);
