// The Sandbox guns' effects, as data: a muzzle flash and a bullet's impact (particle systems), a bullet hole (a decal
// and its texture) and a tracer (a glowing streak). build.ts makes each a template, with its script
// (examples/scripts/SandboxShotFx.ts, SandboxBulletHole.ts, SandboxTracer.ts); SandboxGun instantiates them by name.
//
// The flash and the impact are the Firing Line's (the FPS example's), its emitters rebuilt here, each split in two:
// its additive glow (the flash's core and sparks, the impact's sparks), which the camera's exposure brightens only by
// `GLOW_EXPOSURE_WEIGHT` of its stops (the Firing Line is lit by day; the Sandbox goes from day to night, and a glow
// tuned for one blazes white in the other), and its smoke or dust, lit by the scene and exposed like it.

import { makeModule, parseParticleSystem } from '../../../src/particles/particleSystemAsset'
import { defaultRenderSettings } from '../../../src/particles/particleModules'
import { encodePng } from '../../exampleKit/png.mjs'

/** The effect templates' names (SandboxGun's defaults). */
export const FX_NAMES = { flash: 'Muzzle Flash', impact: 'Bullet Impact', hole: 'Bullet Hole', tracer: 'Tracer' } as const

type Module = { type: string; params: Record<string, unknown> }
const mod = (type: string, params: Record<string, unknown> = {}): Module => {
    const m = makeModule(type) as unknown as Module
    Object.assign(m.params, params)
    return m
}
const burst = (count: number) => mod('spawnBurst', { bursts: [{ time: 0, count, cycles: 1, interval: 1, probability: 1 }] })
const fade = (peak = 1) => ({ color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 0 }, { t: 0.15, a: peak }, { t: 0.7, a: peak }, { t: 1, a: 0 }] })
const bounceOff = (restitution: number, friction: number) => mod('collision', { bodies: true, depth: true, radius: 1, restitution, friction, lifetimeLoss: 0 })

/**
 * How much of the camera's exposure the glows take (ParticleSystemNode.exposureWeight), and their brightness: the
 * Firing Line's, scaled so that at the Sandbox's dusk they read about as its do by day.
 */
export const GLOW_EXPOSURE_WEIGHT = 0.1
const GLOW_SCALE = 0.3

function emitter(id: string, name: string, seed: number, fields: Record<string, any>) {
    const base = {
        id, name, enabled: true, capacity: 512, simSpace: 'world', duration: 5, looping: true, prewarm: false, startDelay: 0, seed,
        spawn: [], init: [], update: [], render: defaultRenderSettings(),
    }
    const e: any = { ...base, ...fields, render: { ...base.render, ...(fields.render ?? {}) } }
    // An additive glow at its brightness; anything else lit by the scene.
    if (e.render.lit) return e
    if ((e.render.blend ?? 'alpha') !== 'additive') return { ...e, render: { ...e.render, lit: true } }
    return { ...e, init: e.init.map((m: Module) => m.type === 'color' ? { ...m, params: { ...m.params, intensity: +(((m.params.intensity as number) ?? 1) * GLOW_SCALE).toPrecision(3) } } : m) }
}

/** A particle system asset: `{ id, name, system }`. */
function vfx(id: string, name: string, emitters: any[], bounds: { center: number[]; extents: number[] }) {
    return { id, name, system: parseParticleSystem({ version: 1, emitters, bounds }) }
}

/**
 * The particle systems, ids from `idFor`. The flash fires along +Y (its node turns it along the bore); the impact
 * sprays off a surface along +Y (its template is turned onto the surface's normal).
 */
export function particleSystems(idFor: (key: string) => string, seedFor: (key: string) => number) {
    const em = (key: string, name: string, fields: Record<string, any>) => emitter(idFor('emitter:' + key), name, seedFor(key), fields)
    const flash = vfx(idFor('vfx:flash'), 'Muzzle Flash', [
        em('flash-core', 'Core', {
            capacity: 16, looping: false, duration: 0.2,
            spawn: [mod('spawnRate', { rate: 0 }), burst(3)],
            init: [mod('shape', { shape: 'cone', radius: 0.01, angle: 8, thickness: 1 }), mod('lifetime', { range: [0.035, 0.06] }),
                mod('velocity', { mode: 'shape', speed: [0.5, 1.5] }), mod('size', { range: [0.22, 0.34] }), mod('rotation', { angle: [0, 360], spin: [0, 0] }),
                mod('color', { mode: 'constant', colorA: [1, 0.78, 0.4, 1], intensity: 16 })],
            update: [mod('colorOverLife', { gradient: fade(1) })],
            render: { blend: 'additive', softness: 0 },
        }),
        em('flash-sparks', 'Sparks', {
            capacity: 32, looping: false, duration: 0.2,
            spawn: [mod('spawnRate', { rate: 0 }), burst(10)],
            init: [mod('shape', { shape: 'cone', radius: 0.015, angle: 16, thickness: 1 }), mod('lifetime', { range: [0.08, 0.2] }),
                mod('velocity', { mode: 'shape', speed: [5, 12] }), mod('size', { range: [0.012, 0.028] }),
                mod('color', { mode: 'constant', colorA: [1, 0.7, 0.25, 1], intensity: 14 })],
            update: [mod('drag', { coefficient: 1 }), mod('colorOverLife', { gradient: fade(1) })],
            render: { blend: 'additive', alignment: 'velocity', stretch: 1.4, softness: 0 },
        }),
    ], { center: [0, 0.5, 0], extents: [1, 1.5, 1] })
    const flashSmoke = vfx(idFor('vfx:flash-smoke'), 'Muzzle Smoke', [
        em('flash-smoke', 'Smoke', {
            capacity: 16, looping: false, duration: 1,
            spawn: [mod('spawnRate', { rate: 0 }), burst(3)],
            init: [mod('shape', { shape: 'cone', radius: 0.02, angle: 12, thickness: 1 }), mod('lifetime', { range: [0.5, 0.9] }),
                mod('velocity', { mode: 'shape', speed: [0.4, 1.1] }), mod('size', { range: [0.1, 0.18] }), mod('rotation', { angle: [0, 360], spin: [-40, 40] }),
                mod('color', { mode: 'constant', colorA: [0.62, 0.6, 0.57, 0.25] })],
            update: [mod('drag', { coefficient: 1.2 }), mod('colorOverLife', { gradient: fade(0.5) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.5 }, { t: 1, v: 2.2 }] } })],
            render: { lit: true, softness: 0.6 },
        }),
    ], { center: [0, 0.5, 0], extents: [1, 1.5, 1] })
    const impact = vfx(idFor('vfx:impact'), 'Impact Sparks', [
        em('impact-sparks', 'Sparks', {
            capacity: 48, looping: false, duration: 1,
            spawn: [mod('spawnRate', { rate: 0 }), burst(14)],
            init: [mod('shape', { shape: 'cone', radius: 0.01, angle: 55, thickness: 1 }), mod('lifetime', { range: [0.25, 0.7] }),
                mod('velocity', { mode: 'shape', speed: [2, 6] }), mod('size', { range: [0.008, 0.02] }),
                mod('color', { mode: 'constant', colorA: [1, 0.62, 0.2, 1], intensity: 12 })],
            update: [mod('gravity', { scale: 1 }), mod('drag', { coefficient: 0.4 }), bounceOff(0.4, 0.3), mod('colorOverLife', { gradient: fade(1) })],
            render: { blend: 'additive', alignment: 'velocity', stretch: 0.9, softness: 0 },
        }),
    ], { center: [0, 0.3, 0], extents: [1.5, 1.5, 1.5] })
    const impactDust = vfx(idFor('vfx:impact-dust'), 'Impact Dust', [
        em('impact-dust', 'Dust', {
            capacity: 24, looping: false, duration: 1.5,
            spawn: [mod('spawnRate', { rate: 0 }), burst(7)],
            init: [mod('shape', { shape: 'cone', radius: 0.03, angle: 40, thickness: 1 }), mod('lifetime', { range: [0.5, 1.0] }),
                mod('velocity', { mode: 'shape', speed: [0.3, 1.2] }), mod('size', { range: [0.12, 0.22] }), mod('rotation', { angle: [0, 360], spin: [-30, 30] }),
                mod('color', { mode: 'constant', colorA: [0.55, 0.52, 0.48, 0.32] })],
            update: [mod('drag', { coefficient: 1.5 }), mod('colorOverLife', { gradient: fade(0.6) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }] } })],
            render: { lit: true, softness: 0.6 },
        }),
    ], { center: [0, 0.3, 0], extents: [1.5, 1.5, 1.5] })
    return { flash, flashSmoke, impact, impactDust }
}

/** A seeded random in 0..1. */
function rng(seed: number) {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/**
 * A bullet hole, as a PNG (the decal's base colour; its alpha is the hole): a black crater, a soft ragged scorch
 * round it, cracks and chips. The Firing Line's.
 */
export function bulletHolePng(seed = 0x4401, size = 128): Buffer {
    const r = rng(seed)
    const rgba = new Uint8Array(size * size * 4)
    const cracks = Array.from({ length: 7 }, () => ({ a: r() * Math.PI * 2, len: 0.14 + r() * 0.2, w: 0.004 + r() * 0.006 }))
    const chips = Array.from({ length: 9 }, () => ({ a: r() * Math.PI * 2, d: 0.1 + r() * 0.22, s: 0.008 + r() * 0.02 }))
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size - 0.5, v = 0.5 - (y + 0.5) / size
        const d = Math.hypot(u, v), th = Math.atan2(v, u)
        const ragged = 1 + 0.18 * Math.sin(th * 5 + seed) + 0.1 * Math.sin(th * 11)
        let a = (1 - smooth(0.05 * ragged, 0.2 * ragged, d)) * 0.55
        let shade = 0.1
        const hole = 1 - smooth(0.022, 0.034, d)
        if (hole > 0) { a = Math.max(a, hole); shade = 0.02 }
        for (const c of cracks) {
            const along = u * Math.cos(c.a) + v * Math.sin(c.a)
            const across = Math.abs(-u * Math.sin(c.a) + v * Math.cos(c.a))
            if (along > 0.02 && along < c.len) a = Math.max(a, (1 - smooth(0, c.w, across)) * 0.8 * (1 - along / c.len))
        }
        for (const c of chips) {
            const dd = Math.hypot(u - Math.cos(c.a) * c.d, v - Math.sin(c.a) * c.d)
            a = Math.max(a, (1 - smooth(c.s * 0.6, c.s, dd)) * 0.7)
        }
        const i = (y * size + x) * 4
        rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(255 * shade)
        rgba[i + 3] = Math.round(255 * Math.min(1, a))
    }
    return encodePng(size, size, rgba)
}

/** The tracer's streak: `length` m along local -Z from the root (the head), this thick, m. */
export const TRACER = { length: 5, thickness: 0.012 }
/**
 * The flash's light: warm, short-ranged, faded fast by the effect's script, a little ahead of the muzzle. Dim for a
 * muzzle flash (the Firing Line's is 9000 lm): at dusk and night the eye is open, and a brighter one turns the
 * shooter's back white.
 */
export const FLASH_LIGHT = { color: [1, 0.72, 0.4], lumens: 1500, range: 5, ahead: 0.3 }
/** The hole's decal: its box (the size across, and how deep it projects), and how it fades at grazing angles. */
export const HOLE_DECAL = { size: [0.16, 0.5, 0.16], angleFade: 0.3, depthFade: 0.3 }
