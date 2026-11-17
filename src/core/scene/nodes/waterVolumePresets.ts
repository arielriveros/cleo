import type { WaterVolumeOptions } from "./waterVolumeNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click liquids for WaterVolumeNode: how the liquid buoys, drags and bobs what floats in it, and the
 * wind its waves are shaped for. Never the body (its type, points, size, connections), the material, the
 * splash template or whether characters are buoyed: those are the scene's layout, not the liquid.
 */
export type WaterVolumePreset = Preset<WaterVolumeOptions>;

const BASE: WaterVolumeOptions = {
    density: 1000, linearDrag: 2.5, angularDrag: 1.5, waveAmplitude: 0.03, waveFrequency: 0.6,
    windSpeed: 0, waveScale: 1, choppiness: 0.5, shoreFade: 6, currents: true, followWind: false,
};

export const WATER_VOLUME_PRESETS: WaterVolumePreset[] = definePresets(BASE, [
    ['stillPool', 'Still Pool', 'Fresh water with a perfectly flat surface: floating things settle and stay put.',
        { waveAmplitude: 0, waveFrequency: 0 }],
    ['lake', 'Pond / Lake', 'The default: fresh water with a faint bob and the ripples of a light breeze.',
        { windSpeed: 3, choppiness: 0.3 }],
    ['river', 'River', 'Fresh water that carries what floats in it downstream, with a light chop.',
        { waveAmplitude: 0.01, windSpeed: 2, choppiness: 0.4, linearDrag: 3 }],
    ['sea', 'Sea', 'Salt water (a little more buoyant) under a steady breeze: rolling waves that boats ride.',
        { density: 1025, linearDrag: 2, angularDrag: 1.2, waveAmplitude: 0.02, waveFrequency: 0.25, windSpeed: 7, choppiness: 0.5 }],
    ['roughSea', 'Rough Sea', 'A gale: tall, sharp-crested waves that toss boats and debris.',
        { density: 1025, linearDrag: 1.6, angularDrag: 1, waveAmplitude: 0.05, waveFrequency: 0.2, windSpeed: 15, choppiness: 0.8 }],
    ['swamp', 'Swamp / Mud', 'Thick, sluggish water: things wallow and barely drift.',
        { density: 1100, linearDrag: 7, angularDrag: 5, waveAmplitude: 0, waveFrequency: 0, currents: false }],
    ['oil', 'Oil', 'Lighter than water, so props ride lower and sink sooner; viscous.',
        { density: 900, linearDrag: 4, angularDrag: 3, waveAmplitude: 0.01, waveFrequency: 0.4, windSpeed: 1, choppiness: 0.1 }],
    ['lava', 'Lava', 'Dense, viscous melt: most props float high and crawl across it.',
        { density: 3000, linearDrag: 12, angularDrag: 8, waveAmplitude: 0, waveFrequency: 0, currents: false }],
]);
