import { finiteOr } from '../core/math';
import { definePresets, type Preset } from '../core/presets';

// How water LOOKS: the parameters of a Water material (graphics/material.ts WaterMaterial), read by the
// water surface renderer (graphics/render/water.ts, shaders/wgsl/water.wgsl). Plain data, so a preset is
// just a partial look.

export interface WaterLook {
    /** Linear RGB the water tints toward in its shallows (what light scattered near the surface looks like). */
    shallowColor: [number, number, number];
    /** Linear RGB of deep water: the colour light scattered back from far down takes. */
    deepColor: [number, number, number];
    /** Per metre, per channel: how fast light dies with depth (clear water absorbs red first). */
    absorption: [number, number, number];
    /** 0..1: suspended silt. Murky water scatters light back long before it reaches the bed. */
    turbidity: number;
    /** Metres you can see down in clear water before the scattering hides the bed. */
    clarity: number;
    /** 0..1: surface microroughness (0 a mirror, 1 a blur). */
    roughness: number;
    /** 0..1: reflectance looking straight down (water is 0.02); grazing reflection follows Fresnel. */
    reflectivity: number;
    /** 0..1: how strongly the screen-space reflection is used over the sky and probe reflection. */
    screenReflections: number;
    /** Metres: how far the refraction bends what is seen through the surface. */
    refraction: number;
    /** 0..2: strength of the small ripples on top of the waves. */
    detailStrength: number;
    /** Metres: size of those ripples. */
    detailScale: number;
    /** 0..2: how far the ripples ride the current (rivers). */
    flowStrength: number;
    /** Linear RGB of foam. */
    foamColor: [number, number, number];
    /** Metres of foam along the shore. */
    shoreFoam: number;
    /** 0..1: foam on breaking wave crests. */
    crestFoam: number;
    /** 0..1: foam where the water runs fast or tumbles (rapids, waterfalls). */
    flowFoam: number;
    /** 0..2: brightness of the caustics on the bed. */
    caustics: number;
    /** Metres between the caustic lines. */
    causticsScale: number;
    /** 0..2: how much rain rings the surface. */
    rainRipples: number;
    /** 0..1: how much snow settles (as slush, then ice) on still water. */
    snowCover: number;
    /** 0..2: how much the wind roughens the surface. */
    windResponse: number;
    /**
     * Linear RGB of light that has travelled THROUGH the water before reaching the eye (subsurface
     * scattering): what thin wave crests glow with against the sun. Clear water scatters green-turquoise.
     */
    scatterColor: [number, number, number];
    /** 0..2: how strong that subsurface glow is (0 = none). */
    subsurface: number;
    /** 1..16: how tightly the glow gathers round looking toward the sun. */
    subsurfaceSharpness: number;
    /** 0..1: how far the surface's slope bends the light through it, spreading the glow over wave faces. */
    subsurfaceDistortion: number;
    /** Linear RGB of the fog seen from underwater. */
    underwaterColor: [number, number, number];
    /** Per metre: how thick that fog is. */
    underwaterFog: number;
}

export const DEFAULT_WATER_LOOK: WaterLook = {
    shallowColor: [0.10, 0.32, 0.30],
    deepColor: [0.01, 0.06, 0.09],
    absorption: [0.45, 0.09, 0.06],
    turbidity: 0.15,
    clarity: 8,
    roughness: 0.06,
    reflectivity: 0.02,
    screenReflections: 1,
    refraction: 0.25,
    detailStrength: 1,
    detailScale: 1.5,
    flowStrength: 1,
    foamColor: [0.9, 0.93, 0.95],
    shoreFoam: 0.6,
    crestFoam: 0.5,
    flowFoam: 0.4,
    caustics: 1,
    causticsScale: 1.4,
    rainRipples: 1,
    snowCover: 1,
    windResponse: 1,
    scatterColor: [0.1, 0.55, 0.45],
    subsurface: 1,
    subsurfaceSharpness: 5,
    subsurfaceDistortion: 0.4,
    underwaterColor: [0.03, 0.14, 0.16],
    underwaterFog: 0.12,
};

const rgb = (v: unknown, d: [number, number, number]): [number, number, number] =>
    Array.isArray(v) ? [0, 1, 2].map(i => Math.max(0, finiteOr(v[i], d[i]))) as [number, number, number] : [...d] as [number, number, number];
const unit = (v: unknown, d: number) => Math.min(1, Math.max(0, finiteOr(v, d)));
const pos = (v: unknown, d: number, max = Infinity) => Math.min(max, Math.max(0, finiteOr(v, d)));

/** A complete look from any partial one: missing or broken fields take the defaults. */
export function normaliseWaterLook(v: any): WaterLook {
    const d = DEFAULT_WATER_LOOK;
    return {
        shallowColor: rgb(v?.shallowColor, d.shallowColor),
        deepColor: rgb(v?.deepColor, d.deepColor),
        absorption: rgb(v?.absorption, d.absorption),
        turbidity: unit(v?.turbidity, d.turbidity),
        clarity: pos(v?.clarity, d.clarity, 500) || 0.1,
        roughness: unit(v?.roughness, d.roughness),
        reflectivity: unit(v?.reflectivity, d.reflectivity),
        screenReflections: unit(v?.screenReflections, d.screenReflections),
        refraction: pos(v?.refraction, d.refraction, 4),
        detailStrength: pos(v?.detailStrength, d.detailStrength, 2),
        detailScale: pos(v?.detailScale, d.detailScale, 50) || 0.05,
        flowStrength: pos(v?.flowStrength, d.flowStrength, 2),
        foamColor: rgb(v?.foamColor, d.foamColor),
        shoreFoam: pos(v?.shoreFoam, d.shoreFoam, 20),
        crestFoam: unit(v?.crestFoam, d.crestFoam),
        flowFoam: unit(v?.flowFoam, d.flowFoam),
        caustics: pos(v?.caustics, d.caustics, 2),
        causticsScale: pos(v?.causticsScale, d.causticsScale, 20) || 0.1,
        rainRipples: pos(v?.rainRipples, d.rainRipples, 2),
        snowCover: unit(v?.snowCover, d.snowCover),
        windResponse: pos(v?.windResponse, d.windResponse, 2),
        scatterColor: rgb(v?.scatterColor, d.scatterColor),
        subsurface: pos(v?.subsurface, d.subsurface, 2),
        subsurfaceSharpness: Math.max(1, pos(v?.subsurfaceSharpness, d.subsurfaceSharpness, 16)),
        subsurfaceDistortion: unit(v?.subsurfaceDistortion, d.subsurfaceDistortion),
        underwaterColor: rgb(v?.underwaterColor, d.underwaterColor),
        underwaterFog: pos(v?.underwaterFog, d.underwaterFog, 5),
    };
}

export type WaterLookPreset = Preset<Partial<WaterLook>>;

/** One-click looks for a Water material. */
export const WATER_LOOK_PRESETS: WaterLookPreset[] = definePresets<Partial<WaterLook>>({}, [
    ['clearLake', 'Clear Lake', 'Clean fresh water: you see the bed several metres down, green-blue in the deep.', {}],
    ['tropical', 'Tropical Lagoon', 'Very clear turquoise water over pale sand, bright caustics.',
        { shallowColor: [0.12, 0.55, 0.52], deepColor: [0.0, 0.12, 0.22], absorption: [0.35, 0.05, 0.03], turbidity: 0.05, clarity: 20, caustics: 1.6,
          scatterColor: [0.08, 0.7, 0.62], subsurface: 1.4, subsurfaceSharpness: 4 }],
    ['alpineRiver', 'Alpine River', 'Cold glacier-fed water: milky blue-green, lots of foam where it runs fast.',
        { shallowColor: [0.25, 0.45, 0.45], deepColor: [0.04, 0.14, 0.16], turbidity: 0.4, clarity: 3, flowFoam: 0.9, roughness: 0.1, causticsScale: 0.9,
          scatterColor: [0.3, 0.55, 0.5], subsurface: 0.8, subsurfaceDistortion: 0.6 }],
    ['murkySwamp', 'Murky Swamp', 'Brown, still, silted water: the bed vanishes a hand below the surface.',
        { shallowColor: [0.12, 0.10, 0.04], deepColor: [0.03, 0.03, 0.01], absorption: [0.9, 0.8, 0.9], turbidity: 0.9, clarity: 0.4,
          caustics: 0.1, reflectivity: 0.03, roughness: 0.12, shoreFoam: 0.2, underwaterColor: [0.05, 0.05, 0.02], underwaterFog: 1.2,
          scatterColor: [0.2, 0.22, 0.08], subsurface: 0.15 }],
    ['openOcean', 'Open Ocean', 'Deep blue sea: dark far out, whitecaps on the crests, surf on the shore.',
        { shallowColor: [0.05, 0.25, 0.32], deepColor: [0.0, 0.03, 0.08], absorption: [0.5, 0.12, 0.07], clarity: 12, crestFoam: 0.8, shoreFoam: 3, roughness: 0.08,
          scatterColor: [0.05, 0.42, 0.42], subsurface: 1.3, subsurfaceSharpness: 6, subsurfaceDistortion: 0.35 }],
    ['pool', 'Swimming Pool', 'Chlorinated, perfectly clear, pale blue: the tiles show sharp at the bottom.',
        { shallowColor: [0.3, 0.7, 0.8], deepColor: [0.05, 0.3, 0.5], absorption: [0.25, 0.05, 0.03], turbidity: 0, clarity: 40, caustics: 1.8, causticsScale: 0.8, shoreFoam: 0, roughness: 0.03,
          scatterColor: [0.35, 0.75, 0.85], subsurface: 0.9 }],
]);
