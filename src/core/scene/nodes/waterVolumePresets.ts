import type { WaterVolumeOptions } from "./waterVolumeNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click liquids for WaterVolumeNode: how the liquid buoys, drags and bobs what floats in it. Never the
 * box size, the surface model, the splash template or whether characters are buoyed — those are the
 * scene's layout, not the liquid.
 */
export type WaterVolumePreset = Preset<WaterVolumeOptions>;

const BASE: WaterVolumeOptions = { density: 1000, linearDrag: 2.5, angularDrag: 1.5, waveAmplitude: 0.03, waveFrequency: 0.6 };

export const WATER_VOLUME_PRESETS: WaterVolumePreset[] = definePresets(BASE, [
    ['stillPool', 'Still Pool', 'Fresh water with a perfectly flat surface — floating things settle and stay put.',
        { waveAmplitude: 0, waveFrequency: 0 }],
    ['lake', 'Pond / Lake', 'The default: fresh water with a faint bob.', {}],
    ['sea', 'Sea', 'Salt water (a little more buoyant) with a gentle bob. Only the floating bodies move — the drawn surface stays flat, so the swell stays small.',
        { density: 1025, linearDrag: 2, angularDrag: 1.2, waveAmplitude: 0.08, waveFrequency: 0.25 }],
    ['roughSea', 'Rough Sea', 'A heavier bob that rocks boats and debris, as far as it can go before they visibly sink through a flat surface.',
        { density: 1025, linearDrag: 1.6, angularDrag: 1, waveAmplitude: 0.15, waveFrequency: 0.2 }],
    ['swamp', 'Swamp / Mud', 'Thick, sluggish water: things wallow and barely drift.',
        { density: 1100, linearDrag: 7, angularDrag: 5, waveAmplitude: 0, waveFrequency: 0 }],
    ['oil', 'Oil', 'Lighter than water, so props ride lower and sink sooner; viscous.',
        { density: 900, linearDrag: 4, angularDrag: 3, waveAmplitude: 0.01, waveFrequency: 0.4 }],
    ['lava', 'Lava', 'Dense, viscous melt: most props float high and crawl across it.',
        { density: 3000, linearDrag: 12, angularDrag: 8, waveAmplitude: 0, waveFrequency: 0 }],
]);
