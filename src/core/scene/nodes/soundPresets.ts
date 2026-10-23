import type { SpatialSettings } from "../../../audio/soundSettings";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click distance falloffs for a spatial SoundNode. Key order is assignment order: the reference distance
 * lands before the max distance, which the node keeps above it.
 */
export type SoundFalloffPreset = Preset<SpatialSettings>;

const BASE: SpatialSettings = { distanceModel: 'inverse', refDistance: 1, maxDistance: 100, rolloffFactor: 1 };

export const SOUND_FALLOFF_PRESETS: SoundFalloffPreset[] = definePresets(BASE, [
    ['default', 'Default', 'Natural inverse-distance falloff from one metre.', {}],
    ['smallProp', 'Small Prop', 'Quiet, close sounds — a clock, a dripping tap, a buzzing lamp.',
        { refDistance: 0.5, maxDistance: 20, rolloffFactor: 1.5 }],
    ['voice', 'Voice', 'Dialogue and barks: clear up close, gone across a large room.',
        { refDistance: 1, maxDistance: 30, rolloffFactor: 1 }],
    ['room', 'Room', 'Fills about one room and is silent outside it.',
        { distanceModel: 'linear', refDistance: 1, maxDistance: 15, rolloffFactor: 1 }],
    ['ambientZone', 'Ambient Zone', 'Full volume across an area, fading out at its edge — wind, birdsong, room tone.',
        { distanceModel: 'linear', refDistance: 20, maxDistance: 120, rolloffFactor: 1 }],
    ['largeSource', 'Large Source', 'Big, loud emitters — a waterfall, an engine, a crowd.',
        { refDistance: 8, maxDistance: 250, rolloffFactor: 0.7 }],
    ['distantEvent', 'Distant Event', 'Explosions, thunder, bells — heard across the whole map.',
        { refDistance: 20, maxDistance: 1000, rolloffFactor: 0.5 }],
]);
