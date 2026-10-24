import type { SkyAtmosphereOptions } from "./skyAtmosphereNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click air for SkyAtmosphereNode: how clear the atmosphere is and how much fog hangs in it. Never the
 * sun, the planet, the bake quality, the night sky, the moon or god rays — nor `fogHeight`, which is
 * where the valley floor is in this particular scene.
 */
export type SkyAtmospherePreset = Preset<SkyAtmosphereOptions>;

const BASE: SkyAtmosphereOptions = {
    rayleighScatter: 1, rayleighHeight: 8000, mieScatter: 1, mieHeight: 1200, mieG: 0.76,
    exposure: 1.3, groundColor: [0.25, 0.22, 0.2],
    fogEnabled: false, fogDensity: 0.0008, fogStart: 20, fogMaxOpacity: 0.7, fogHeightFalloff: 0,
    fogColor: [0.7, 0.8, 0.9], fogColorBlend: 0,
};

export const SKY_ATMOSPHERE_PRESETS: SkyAtmospherePreset[] = definePresets(BASE, [
    ['clear', 'Clear Day', 'The default: an Earth-like sky with no fog.', {}],
    ['crisp', 'Crisp Mountain Air', 'Thin, dry air — a deep blue sky and a small, sharp glow round the sun.',
        { rayleighScatter: 1.1, mieScatter: 0.3, mieHeight: 1000, exposure: 1.2 }],
    ['aerial', 'Aerial Perspective', 'A clear sky with just enough distance fog to push far hills back.',
        { fogEnabled: true, fogDensity: 0.0004, fogStart: 50, fogMaxOpacity: 0.55 }],
    ['hazy', 'Hazy Summer', 'Milky, humid air with a wide bright halo and soft distance haze.',
        { mieScatter: 3, mieHeight: 1600, mieG: 0.8,
          fogEnabled: true, fogDensity: 0.0005, fogStart: 50, fogMaxOpacity: 0.6 }],
    ['desertDust', 'Desert Dust', 'Dusty, sand-tinted air and a warm haze.',
        { rayleighScatter: 0.8, mieScatter: 5, mieHeight: 2000, mieG: 0.7, groundColor: [0.45, 0.36, 0.25],
          fogEnabled: true, fogDensity: 0.0012, fogStart: 30, fogMaxOpacity: 0.75,
          fogColor: [0.85, 0.72, 0.55], fogColorBlend: 0.15 }],
    ['smog', 'Smog', 'Low, brown-grey pollution that dulls the sky and the distance.',
        { rayleighScatter: 0.9, mieScatter: 6, mieHeight: 900, mieG: 0.6, groundColor: [0.22, 0.21, 0.2],
          fogEnabled: true, fogDensity: 0.0015, fogStart: 20, fogMaxOpacity: 0.8,
          fogColor: [0.62, 0.58, 0.5], fogColorBlend: 0.15 }],
    ['valleyMist', 'Valley Morning Mist', 'Mist pooled near the ground that is gone a few tens of metres up. Set Fog Height to the valley floor.',
        { mieScatter: 1.5, fogEnabled: true, fogDensity: 0.008, fogStart: 5, fogMaxOpacity: 0.9,
          fogHeightFalloff: 0.06, fogColor: [0.85, 0.88, 0.92], fogColorBlend: 0.1 }],
    ['denseFog', 'Dense Fog', 'Thick fog everywhere — about a hundred metres of visibility.',
        { mieScatter: 3, fogEnabled: true, fogDensity: 0.03, fogStart: 0, fogMaxOpacity: 0.97,
          fogColor: [0.75, 0.78, 0.8], fogColorBlend: 0.15 }],
]);
