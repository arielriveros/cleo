// How flowing water's spray LOOKS and how much of it each place throws (waterSprayRig.ts runs it): three
// particle systems, one emitter each, fed spawn points by the engine (particles/particleSources.ts), and the
// rates and velocities that turn a spray point (sprayField.ts) into particles. Pure: plain JSON and numbers.
//
//  - DROPLETS: drops a few millimetres across thrown up and falling back under gravity and the air's drag,
//    lit and drawn as their motion blur, dying where they meet the water (the scene's depth, which the water
//    writes). What a rapid tosses off its crests, what bursts up the face of a rock in fast water, what a
//    waterfall throws off its foot.
//  - MIST: fine spray a fall's landing blows into the air: big, soft, faint puffs rising and drifting off with
//    the wind for a few seconds. Only tall falls and hard rapids make it.
//  - FOAM: bursts of white churn where the water tumbles, low over the surface, carried off by the current,
//    fading in a second or two.

import { makeModule, LOD_ALL_LEVELS, PARTICLE_SYSTEM_VERSION, type EmitterDef, type ParticleModule, type ParticleSystemDef } from '../../particles/particleSystemAsset';
import { defaultRenderSettings } from '../../particles/particleModules';
import { linearCurve } from '../../particles/curves';
import {
    BUILTIN_FOAM_NORMAL, BUILTIN_FOAM_SPRITE, BUILTIN_MIST_SIXWAY_NEG, BUILTIN_MIST_SIXWAY_POS, BUILTIN_SPRAY_NORMAL,
    BUILTIN_SPRAY_SPRITE,
} from '../../particles/spraySprites';
import { MAX_SPAWN_SOURCES } from '../../particles/particleSources';
import type { SpawnSource } from '../../particles/particleSources';
import type { SprayPoint } from './sprayField';
import { smoothstep } from '../../core/math';

export type SprayLook = 'droplets' | 'mist' | 'foam';
export const SPRAY_LOOKS: readonly SprayLook[] = ['droplets', 'mist', 'foam'];

/** Per look: the pool, how far from the camera it is drawn, and how many a second it may spawn at most. */
export const SPRAY_LOOK = {
    droplets: { capacity: 16384, radius: 70, budget: 6000, life: [0.6, 1.4] as [number, number], size: [0.015, 0.045] as [number, number] },
    mist: { capacity: 2048, radius: 150, budget: 160, life: [4, 7] as [number, number], size: [3, 6] as [number, number] },
    foam: { capacity: 4096, radius: 50, budget: 1000, life: [0.6, 1.4] as [number, number], size: [0.2, 0.5] as [number, number] },
} as const;

/** Metres above the water a particle is born, so it does not start inside the surface it dies on. */
export const SPRAY_LIFT = 0.05;

function mod(type: string, params: Record<string, unknown>): ParticleModule {
    const m = makeModule(type);
    Object.assign(m.params, params);
    return m;
}

/** The particle system one look is drawn with: one world-space emitter fed spawn points, drawn round the camera. */
export function sprayLookSystem(look: SprayLook): ParticleSystemDef {
    const d = SPRAY_LOOK[look];
    const init: ParticleModule[] = [
        mod('shape', { shape: 'sources' }),
        mod('lifetime', { range: [...d.life] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 0, speed: [0, 0], inherit: 0 }),
        mod('size', { range: [...d.size] }),
    ];
    const update: ParticleModule[] = [];
    const render = { ...defaultRenderSettings(), blend: 'alpha' as const, lit: true, roughness: 1 };
    if (look === 'droplets') {
        init.push(mod('color', { mode: 'constant', colorA: [0.92, 0.95, 1, 0.85], intensity: 1 }));
        update.push(mod('gravity', { scale: 1 }));
        update.push(mod('drag', { coefficient: 0.6 }));
        update.push(mod('wind', { source: 'scene', scale: 0.5, fall: [0, 0, 0], velocity: [0, 0, 0], influence: 0.6 }));
        update.push(mod('collision', { bodies: false, depth: true, planes: [], radius: 0.5, restitution: 0, friction: 0,
                                       lifetimeLoss: 0, kill: true, thickness: 0.6 }));
        update.push(mod('colorOverLife', { gradient: fade(0.04, 0.2) }));
        Object.assign(render, {
            alignment: 'velocity', stretch: 0, stretchRange: [0.8, 1.2], streakShutter: 1 / 40, minPixelWidth: 1,
            textureId: BUILTIN_SPRAY_SPRITE, softness: 0.05, nearFade: 0.3, translucency: 0.5,
            // Round drops: a normal map gives each a face for the sun to glint off, and the low roughness a highlight.
            normalTextureId: BUILTIN_SPRAY_NORMAL, normalStrength: 1, roughness: 0.2,
            flipbook: { columns: 2, rows: 2, frames: 4, mode: 'fps', fps: 0, cycles: 1, randomStart: true, blend: false },
        });
    } else if (look === 'mist') {
        // White, thin and big: it is the six-way lightmaps (baked from the puff's own density, lit from six sides)
        // that shade it, so the side facing the sun glows and the side facing away takes the sky's fill; never a
        // grey card.
        init.push(mod('color', { mode: 'constant', colorA: [0.97, 0.98, 1, 0.06], intensity: 1 }));
        init.push(mod('rotation', { angle: [0, 360], spin: [-6, 6] }));
        update.push(mod('drag', { coefficient: 1.5 }));
        update.push(mod('wind', { source: 'scene', scale: 1, fall: [0, 0.25, 0], velocity: [0, 0, 0], influence: 0.8 }));
        update.push(mod('curlNoise', { strength: 0.8, frequency: 0.12, scroll: 0.15, octaves: 1 }));
        update.push(mod('sizeOverLife', { curve: linearCurve(0.5, 1.8) }));
        update.push(mod('colorOverLife', { gradient: fade(0.25, 0.5) }));
        Object.assign(render, {
            alignment: 'camera', stretch: 0, textureId: null, shading: 'sixWay',
            sixWayPositiveTextureId: BUILTIN_MIST_SIXWAY_POS, sixWayNegativeTextureId: BUILTIN_MIST_SIXWAY_NEG,
            softness: 2, nearFade: 2.5, translucency: 1,
            sort: true,
            flipbook: { columns: 2, rows: 2, frames: 4, mode: 'fps', fps: 0, cycles: 1, randomStart: true, blend: false },
        });
    } else {
        init.push(mod('color', { mode: 'constant', colorA: [0.96, 0.97, 0.98, 0.4], intensity: 1 }));
        init.push(mod('rotation', { angle: [0, 360], spin: [-20, 20] }));
        update.push(mod('drag', { coefficient: 0.4 }));
        update.push(mod('sizeOverLife', { curve: linearCurve(0.7, 1.3) }));
        update.push(mod('colorOverLife', { gradient: fade(0.12, 0.5) }));
        Object.assign(render, {
            alignment: 'velocity', stretch: 0.25, stretchRange: [1, 2], textureId: BUILTIN_FOAM_SPRITE, softness: 0.4, nearFade: 0.5, translucency: 0.6,
            // Bubbles with relief: their rims catch the light, and the translucency softens the shading (wrap 0.6).
            normalTextureId: BUILTIN_FOAM_NORMAL, normalStrength: 1, roughness: 0.6,
            flipbook: { columns: 2, rows: 2, frames: 4, mode: 'fps', fps: 0, cycles: 1, randomStart: true, blend: false },
        });
    }
    const emitter: EmitterDef = {
        id: `water-spray-${look}`, name: look, enabled: true,
        capacity: d.capacity, simSpace: 'world', duration: 10, looping: true, prewarm: false, startDelay: 0,
        seed: look === 'droplets' ? 0x51a5 : look === 'mist' ? 0x3157 : 0xf0a3, maxLod: LOD_ALL_LEVELS,
        spawn: [], init, update, render: render as EmitterDef['render'],
    };
    // Bounds round the camera (the rig keeps the node on it): as far as this look is drawn, never culled short.
    const reach = d.radius + 10;
    return {
        version: PARTICLE_SYSTEM_VERSION,
        emitters: [emitter],
        bounds: { center: [0, 0, 0], extents: [reach, reach, reach] },
        lod: { enabled: false, levels: [], cullDistance: 0, scaleBursts: false },
    };
}

const fade = (fadeIn: number, fadeOut: number) => ({
    color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }],
    alpha: [{ t: 0, a: 0 }, { t: fadeIn, a: 1 }, { t: 1 - fadeOut, a: 1 }, { t: 1, a: 0 }],
});

/**
 * Particles a second a spray point throws of each look (before the water's own Spray amount and the budget),
 * from what drives it (sprayField.ts SprayPoint `power`, `q`, `height`, `speed`).
 */
export function sprayRates(p: SprayPoint): Record<SprayLook, number> {
    switch (p.kind) {
        // Foam is a burst here and there, never a bank: a point throws a few a second at most.
        case 'rapid': return { droplets: 60 * p.power, mist: p.power > 15 ? 0.15 * (p.power - 15) : 0, foam: Math.min(25, 3 * p.power) };
        case 'lip': return { droplets: 40 * p.q * p.speed, mist: 0, foam: 0 };
        case 'curtain': return { droplets: 15 * p.q * p.height, mist: 0, foam: 0 };
        case 'plunge': return {
            droplets: 0.004 * p.power, foam: Math.min(60, 0.002 * p.power),
            mist: 0.0003 * p.power * Math.min(1, Math.max(0, (p.height - 2) / 4)),
        };
        case 'face': return { droplets: 25 * p.power, mist: 0, foam: Math.min(30, 4 * p.power / Math.max(p.speed, 1e-3)) };
        case 'body': return { droplets: Math.min(400, 30 * p.power), mist: 0, foam: Math.min(120, 8 * p.power) };
        case 'entry': return { droplets: Math.min(1200, 180 * p.power), mist: 0, foam: Math.min(200, 40 * p.power) };
    }
}

/** A spray point as one look's spawn point, `count` particles this frame (SpawnSource), its velocity by its kind. */
export function spraySource(p: SprayPoint, look: SprayLook, count: number): SpawnSource {
    const base: SpawnSource = {
        x: p.x, y: p.y + SPRAY_LIFT, z: p.z, ax: p.ax, az: p.az, along: p.along, across: p.across, rise: 0,
        vx: 0, vy: 0, vz: 0, spread: 0.6, jitter: 0.35, size: 1, life: 1, count,
    };
    const ux = p.ax, uz = p.az;
    if (look === 'foam') {
        // On the water, carried by the current, spread about the vertical only.
        const cur = Math.hypot(p.ux, p.uz);
        return { ...base, y: p.y + 0.03, vx: p.ux, vy: 0, vz: p.uz, spread: -0.6, jitter: 0.4, size: cur > 3 ? 1.3 : 1,
                 along: p.along + 0.3, across: p.across + 0.3 };
    }
    if (look === 'mist') {
        const v = Math.min(4, 0.15 * p.speed + 0.5);
        return { ...base, y: p.y + 0.3, vx: ux * v * 0.6, vy: v * 0.5, vz: uz * v * 0.6, spread: 0.9, jitter: 0.5,
                 along: p.along + 1, across: p.across + 1, rise: Math.min(2, 0.2 * p.height) };
    }
    switch (p.kind) {
        case 'rapid': {
            const s = p.speed;
            return { ...base, vx: p.ux, vy: 0.55 * s + 0.5, vz: p.uz, spread: 0.6, jitter: 0.45 };
        }
        case 'lip':
            return { ...base, vx: p.ux, vy: 0.4, vz: p.uz, spread: 0.35, jitter: 0.4, size: 0.8 };
        case 'curtain':
            return { ...base, rise: p.rise, vx: ux * 0.6, vy: -1, vz: uz * 0.6, spread: 0.7, jitter: 0.6, size: 0.9 };
        case 'plunge': {
            const v = Math.min(14, p.speed);
            return { ...base, vx: ux * 0.25 * v, vy: 0.35 * v, vz: uz * 0.25 * v, spread: 0.95, jitter: 0.5, size: 1.2 };
        }
        case 'face': {
            const U = p.speed;
            return { ...base, vx: -ux * 0.25 * U, vy: 0.9 * U, vz: -uz * 0.25 * U, spread: 0.8, jitter: 0.4 };
        }
        case 'body': {
            const v = p.speed;
            return { ...base, vx: ux * 0.4 * v, vy: 0.7 * v, vz: uz * 0.4 * v, spread: 0.7, jitter: 0.4 };
        }
        case 'entry': {
            const v = p.speed;
            return { ...base, vy: 0.5 * v, spread: 1.1, jitter: 0.5, size: 1.2 };
        }
    }
}

/**
 * Whole particles from a rate, one point at a time: each point's fraction is carried to its next frame, so a
 * point throwing 2.5 a second gives exactly 150 in a minute. Points not seen for a second are forgotten.
 */
export class SprayAccumulator {
    private readonly _carry = new Map<number, { value: number; seen: number }>();
    private _clock = 0;

    /** Particles point `id` gives this frame at `rate` a second over `dt` seconds. */
    public take(id: number, rate: number, dt: number): number {
        let c = this._carry.get(id);
        if (!c) { c = { value: 0, seen: this._clock }; this._carry.set(id, c); }
        c.seen = this._clock;
        c.value += Math.max(0, rate) * Math.max(0, dt);
        const whole = Math.floor(c.value);
        c.value -= whole;
        return whole;
    }

    /** Move the clock on by `dt` and forget points not seen for a second. */
    public advance(dt: number): void {
        this._clock += Math.max(0, dt);
        for (const [id, c] of this._carry) if (this._clock - c.seen > 1) this._carry.delete(id);
    }

    /** Points remembered (for tests). */
    public get size(): number { return this._carry.size; }
}

/** A spray point and what it throws of one look a second, before it is chosen. */
export interface SprayCandidate { point: SprayPoint; rate: number; }

/**
 * How much more a kind of spray point counts when the points are chosen: what something does to the water (a
 * body, a post in the current) is what the player is looking at, and a frame of it is gone the next.
 */
export const SPRAY_PRIORITY: Readonly<Record<SprayPoint['kind'], number>> = {
    rapid: 1, lip: 1, curtain: 1, plunge: 1.5, face: 4, body: 8, entry: 8,
};

/**
 * The spray points one look is fed this frame: those within `radius` of the camera (behind it only when close),
 * the most important first (rate faded out toward the radius, by kind (SPRAY_PRIORITY), the ones fed last frame
 * favoured a little so the
 * choice does not flicker), at most MAX_SPAWN_SOURCES, their rates scaled down together to `budget` a second.
 * Returns each with the rate it is fed at.
 */
export function chooseSpray(candidates: readonly SprayCandidate[], camera: readonly number[], forward: readonly number[],
                            radius: number, budget: number, previous: ReadonlySet<number>): SprayCandidate[] {
    const scored: { c: SprayCandidate; score: number; rate: number }[] = [];
    for (const c of candidates) {
        if (!(c.rate > 0)) continue;
        const dx = c.point.x - camera[0], dy = c.point.y - camera[1], dz = c.point.z - camera[2];
        const d = Math.hypot(dx, dy, dz);
        if (d > radius) continue;
        // Behind the camera only when close (spray right round it is seen as it rises into view).
        if (d > 15 && dx * forward[0] + dy * forward[1] + dz * forward[2] < -0.2 * d) continue;
        const fade = 1 - smoothstep(0.6 * radius, radius, d);
        if (!(fade > 0)) continue;
        const rate = c.rate * fade;
        scored.push({ c, rate, score: rate * SPRAY_PRIORITY[c.point.kind] * (previous.has(c.point.id) ? 1.25 : 1) });
    }
    scored.sort((a, b) => b.score - a.score || a.c.point.id - b.c.point.id);
    const chosen = scored.slice(0, MAX_SPAWN_SOURCES);
    let total = 0;
    for (const s of chosen) total += s.rate;
    const scale = total > budget ? budget / total : 1;
    return chosen.map(s => ({ point: s.c.point, rate: s.rate * scale }));
}
