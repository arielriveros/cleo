// Falling rain and snow as an ordinary particle system: the same module catalogue an author stacks by
// hand, with realistic numbers. What a WeatherNode's `precipitation` falls with (core/scene/
// precipitationRig.ts runs it round the camera). Pure, so every default is unit-tested.
//
// ONE EMITTER, a column round the camera. It spawns in a wide, thin box above the camera, everywhere
// at the HIGHEST rate any volume in reach asks for; the `weather` module then keeps each particle only
// where the volumes make its kind fall, as thinly as they do there, and kills it under shelter. So two
// volumes never double it, a dry box nested in a wet one carves it out, and rain stops at a roof.
//
// THE FALL. Drops and flakes fall at their terminal velocity, not under gravity (a game's own physics
// gravity has nothing to do with rain), carried by the AIR they fall through: the `wind` module, reading
// the scene's wind field (core/wind/windField.ts) where each one is, pulls it toward that air plus its fall
// through still air (drag reaching terminal velocity in moving air). So the gusts and the veer the grass
// shows sweep the rain and the snow too, and a wind that changes needs no rebuild:
// - rain couples tightly (a drop near terminal speed answers a gust in about a third of a second);
// - snow loosely, and is fluttered by turbulence.
//
// THE LOOK OF RAIN (after Lagarde's Remember Me rain and Tatarchuk's ToyShop, the documented AAA work): a
// drop is 1-6 mm across and a streak is its motion blur, the fall speed times a camera's shutter, not a
// stretched sprite: about 28 cm at 8.5 m/s through a 1/30 s shutter. Thinner than a pixel at a distance, so it is drawn at least
// one pixel wide with its alpha scaled down by how much thinner it really is (`minPixelWidth`), and far
// rain turns to fine faint lines instead of shimmering. A drop is a tiny lens, not a grey surface: it shows
// the light round it (the sky's), and glints when the sun or a lamp is behind it (`shading: 'rain'`).

import { makeModule, LOD_ALL_LEVELS, PARTICLE_SYSTEM_VERSION, type EmitterDef, type ParticleModule, type ParticleSystemDef } from './particleSystemAsset';
import { defaultRenderSettings } from './particleModules';
import { BUILTIN_RAIN_SPRITE, BUILTIN_SNOW_SPRITE, BUILTIN_SPRITE_LAYOUT } from './precipitationSprites';
import type { PrecipitationSprite } from '../core/scene/nodes/weatherNode';

export type FallingKind = 'rain' | 'snow';

/** How one kind of precipitation looks and falls: what the highest-priority volume of that kind asks for. */
export interface PrecipitationStyle {
    /** The highest rate (0..1) any volume in reach asks for: what the emitter spawns at. */
    rate: number;
    /** Size multiplier (0.25..3). */
    size: number;
    /** Fall-speed multiplier (0.25..3). */
    speed: number;
    /** The sprite sheet, or null for the built-in one. */
    sprite: PrecipitationSprite | null;
    /** Rain's trail (streak length) as multipliers of its default, min and max, one drawn per drop. */
    trail?: readonly [number, number];
    /** 0..1: how much of the scene's wind carries it (WeatherNode `precipitationWind`). Default 0.5. */
    wind?: number;
}

/** The frame's conditions the system is built for. */
export interface PrecipitationEnvironment {
    /**
     * Horizontal air velocity, m/s, world XZ: the steady wind now. Only where the column stands (the rig
     * leans it upwind); the drops themselves read the scene's wind field as they fall.
     */
    wind: [number, number];
    /** The renderer's precipitation density (0..1): a multiplier on the spawn rate. */
    density: number;
    /** Start with the column already full (a scene loading in the rain), not falling in from above. */
    prewarm: boolean;
}

/** The realistic defaults per kind. Exported for the tests and the docs. */
export const PRECIPITATION_DEFAULTS = {
    rain: {
        capacity: 36864, spawnRate: 16000, box: [36, 1, 36] as [number, number, number], height: 12,
        lifetime: [1.8, 2.2] as [number, number], terminal: 8.5, speedJitter: 0.12, spread: 1.5,
        // 3-6 mm drops (a downpour's); a 1/30 s shutter draws each as its ~28 cm of motion blur. Far ones are
        // a pixel wide and fainter (minPixelWidth), so it takes this many to read as heavy rain.
        size: [0.003, 0.006] as [number, number], color: [0.86, 0.9, 0.96, 0.9] as [number, number, number, number],
        fadeIn: 0.06, fadeOut: 0.04, thickness: 1.0, shutter: 1 / 30, minPixelWidth: 1,
        softness: 0.1, nearFade: 0.6, roughness: 1, translucency: 1.2,
        // How tightly a drop follows the air (1/s): its drag time at terminal speed is about 0.35 s.
        coupling: 3,
    },
    snow: {
        capacity: 16384, spawnRate: 1200, box: [30, 1, 30] as [number, number, number], height: 8,
        lifetime: [10, 12] as [number, number], terminal: 1.0, speedJitter: 0.25, spread: 8,
        size: [0.015, 0.035] as [number, number], color: [0.95, 0.96, 1, 0.9] as [number, number, number, number],
        fadeIn: 0.04, fadeOut: 0.08, thickness: 0.5, coupling: 1.5, spin: 60,
        noise: { strength: 0.6, frequency: 0.4, scroll: 0.2, octaves: 1 }, softness: 0.15, nearFade: 0.4, roughness: 1, translucency: 0.8,
    },
} as const;

/** The default trail range (rain's streak length multipliers, min and max). */
export const DEFAULT_TRAIL: readonly [number, number] = [0.7, 1.3];

function trailRange(trail: readonly [number, number] | undefined): [number, number] {
    const a = Math.min(4, Math.max(0.1, trail?.[0] ?? DEFAULT_TRAIL[0]));
    const b = Math.min(4, Math.max(0.1, trail?.[1] ?? DEFAULT_TRAIL[1]));
    return [Math.min(a, b), Math.max(a, b)];
}

/** The built-in sprite of a kind. */
export function builtinSpriteOf(kind: FallingKind): string {
    return kind === 'rain' ? BUILTIN_RAIN_SPRITE : BUILTIN_SNOW_SPRITE;
}

/** Spawn box half-height above the camera and the box itself, per kind: what the rig places. */
export function precipitationColumn(kind: FallingKind): { box: readonly [number, number, number]; height: number } {
    const d = PRECIPITATION_DEFAULTS[kind];
    return { box: d.box, height: d.height };
}

/** Seconds a particle of `kind` takes to fall from its spawn box to eye level: how far ahead the rig leads. */
export function precipitationFallTime(kind: FallingKind, speed = 1): number {
    const d = PRECIPITATION_DEFAULTS[kind];
    return d.height / (d.terminal * Math.max(0.25, speed));
}

function mod(type: string, params: Record<string, unknown>): ParticleModule {
    const m = makeModule(type);
    Object.assign(m.params, params);
    return m;
}

const fadeGradient = (fadeIn: number, fadeOut: number) => ({
    color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }],
    alpha: [{ t: 0, a: 0 }, { t: fadeIn, a: 1 }, { t: 1 - fadeOut, a: 1 }, { t: 1, a: 0 }],
});

/**
 * The particle system `kind` falls with: one emitter in the emitter's own space (the rig keeps the
 * node at the camera, unrotated), spawning above it.
 */
export function precipitationSystem(kind: FallingKind, style: PrecipitationStyle, env: PrecipitationEnvironment): ParticleSystemDef {
    const d = PRECIPITATION_DEFAULTS[kind];
    // The spawn runs at the FULL rate and the `weather` module keeps each particle where the volumes' rate is
    // above its own draw: a rate that changes (a storm building) thins or fills the rain without a rebuild.
    const rate = Math.min(1, Math.max(0, style.rate));
    const size = Math.min(3, Math.max(0.25, style.size));
    const speed = Math.min(3, Math.max(0.25, style.speed));
    const density = Math.min(1, Math.max(0, env.density));
    const windScale = Math.min(1, Math.max(0, style.wind ?? 0.5));
    const vt = d.terminal * speed;
    const fall: [number, number, number] = [0, -vt, 0];

    const init: ParticleModule[] = [
        mod('shape', { shape: 'box', box: [...d.box], offset: [0, d.height, 0] }),
        mod('lifetime', { range: [d.lifetime[0] / speed, d.lifetime[1] / speed] }),
        mod('velocity', { mode: 'direction', direction: fall, spread: d.spread, inherit: 0,
                          speed: [vt * (1 - d.speedJitter), vt * (1 + d.speedJitter)] }),
        mod('size', { range: [d.size[0] * size, d.size[1] * size] }),
        mod('color', { mode: 'constant', colorA: [...d.color], intensity: 1 }),
    ];
    const update: ParticleModule[] = [];
    // The air it falls through, from the scene's wind field, plus its own fall through still air.
    update.push(mod('wind', { source: 'scene', scale: windScale, fall, velocity: fall, influence: d.coupling }));
    if (kind === 'snow') {
        const s = PRECIPITATION_DEFAULTS.snow;
        init.push(mod('rotation', { angle: [0, 360], spin: [-s.spin, s.spin] }));
        update.push(mod('curlNoise', { ...s.noise }));
    }
    update.push(mod('collision', { bodies: false, depth: true, planes: [], radius: 0.5, restitution: 0, friction: 0,
                                   lifetimeLoss: 0, kill: true, thickness: d.thickness }));
    update.push(mod('weather', { kind, shelter: true, fullRate: 1 }));
    update.push(mod('colorOverLife', { gradient: fadeGradient(d.fadeIn, d.fadeOut) }));

    const sprite = style.sprite;
    const builtin = builtinSpriteOf(kind);
    const layout = BUILTIN_SPRITE_LAYOUT[builtin];
    const render = {
        ...defaultRenderSettings(),
        alignment: kind === 'rain' ? 'velocity' as const : 'camera' as const,
        blend: 'alpha' as const,
        stretch: 0,
        stretchRange: kind === 'rain' ? trailRange(style.trail) : [1, 1] as [number, number],
        ...(kind === 'rain' ? {
            streakShutter: PRECIPITATION_DEFAULTS.rain.shutter,
            minPixelWidth: PRECIPITATION_DEFAULTS.rain.minPixelWidth,
            shading: 'rain' as const,
        } : {}),
        textureId: sprite ? sprite.textureId : builtin,
        flipbook: sprite
            ? { columns: sprite.columns, rows: sprite.rows, frames: sprite.frames, mode: 'fps' as const, fps: sprite.fps,
                cycles: 1, randomStart: true, blend: sprite.fps > 0 }
            : { columns: layout.columns, rows: layout.rows, frames: layout.frames, mode: 'fps' as const, fps: 0,
                cycles: 1, randomStart: true, blend: false },
        softness: d.softness,
        nearFade: d.nearFade,
        lit: true,
        roughness: d.roughness,
        translucency: d.translucency,
    };

    const emitter: EmitterDef = {
        id: `precipitation-${kind}`, name: kind === 'rain' ? 'Rain' : 'Snow', enabled: true,
        capacity: d.capacity, simSpace: 'world', duration: 10, looping: true, prewarm: env.prewarm, startDelay: 0,
        seed: kind === 'rain' ? 0x7a1d : 0x5a0f, maxLod: LOD_ALL_LEVELS,
        // `rate` only says whether anything falls; how much is the volumes' own rate, per particle.
        spawn: [mod('spawnRate', { rate: rate > 0 ? d.spawnRate * density : 0 })],
        init, update, render,
    };

    // Bounds that always hold the camera (the node sits on it) and the column round it: never culled.
    const half = Math.max(d.box[0], d.box[2]) / 2 + 2;
    return {
        version: PARTICLE_SYSTEM_VERSION,
        emitters: [emitter],
        bounds: { center: [0, d.height / 2, 0], extents: [half, d.height / 2 + 6, half] },
        lod: { enabled: false, levels: [], cullDistance: 0, scaleBursts: false },
    };
}
