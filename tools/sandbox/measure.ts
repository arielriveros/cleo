// What the Sandbox generator measures off a clip, so that no number in the blend space or the state machine is
// typed in by hand: ground speed and direction, foot-strike phase, airborne spans, turn angle.
//
// Pure maths over a skin (Maps of local rest transforms, as `loadSkin` returns it) and a clip. Model space is the
// skin's: metres, +Y up, the character facing +Z, so +X is its LEFT and a heading `atan2(x, z)` is the engine's
// yaw (and moveDir's sign: right is negative).

import { mat4, quat, vec3 } from 'gl-matrix'
import type { Animation, Skin } from '../../src/animation/animatedModel'

const D = 180 / Math.PI

interface Track { input: ArrayLike<number>; output: ArrayLike<number> }

function sample(s: Track, time: number, n: 3 | 4): number[] {
    const t = s.input, o = s.output
    if (t.length < 2) return Array.from({ length: n }, (_, c) => o[c])
    let i = 0
    while (i < t.length - 2 && t[i + 1] < time) i++
    const span = t[i + 1] - t[i]
    const f = span > 0 ? Math.min(1, Math.max(0, (time - t[i]) / span)) : 0
    const a = Array.from({ length: n }, (_, c) => o[i * n + c]), b = Array.from({ length: n }, (_, c) => o[(i + 1) * n + c])
    if (n === 4) return Array.from(quat.slerp(quat.create(), a as any, b as any, f))
    return a.map((v, c) => v + (b[c] - v) * f)
}

export function clipSeconds(clip: Animation): number {
    let d = 0
    for (const s of clip.samplers) d = Math.max(d, s.input[s.input.length - 1] ?? 0)
    return d
}

/** `(time) => (node) => model-space position`, posing the clip over the skin's rest. */
export function poser(skin: Skin, clip: Animation) {
    const per = new Map<number, { translation?: Track; rotation?: Track; scale?: Track }>()
    for (const c of clip.channels) {
        const e = per.get(c.targetNodeIndex) ?? {}
        ;(e as any)[c.targetPath] = clip.samplers[c.samplerIndex]
        per.set(c.targetNodeIndex, e)
    }
    const parents = skin.nodeParents as Map<number, number>
    const rest = skin.nodeTransforms as Map<number, mat4>
    return (time: number) => {
        const cache = new Map<number, mat4>()
        const local = (i: number): mat4 => {
            const m = rest.get(i) ?? mat4.create()
            const ch = per.get(i)
            if (!ch) return m
            const T = mat4.getTranslation(vec3.create(), m)
            const S = mat4.getScaling(vec3.create(), m)
            const R = quat.create()
            if (!ch.rotation) {
                const pure = mat4.clone(m)
                for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= S[c] || 1
                mat4.getRotation(R, pure)
            }
            if (ch.translation) vec3.copy(T, sample(ch.translation, time, 3) as any)
            if (ch.rotation) quat.copy(R, sample(ch.rotation, time, 4) as any)
            return mat4.fromRotationTranslationScale(mat4.create(), quat.normalize(R, R), T, S)
        }
        const world = (i: number): mat4 => {
            const hit = cache.get(i)
            if (hit) return hit
            const p = parents.get(i)
            const m = p === undefined || p === i ? local(i) : mat4.multiply(mat4.create(), world(p), local(i))
            cache.set(i, m)
            return m
        }
        return { at: (i: number) => mat4.getTranslation(vec3.create(), world(i)), world }
    }
}

/** Node index of the bone whose name ends `:<base>` (Mixamo `mixamorig1:LeftFoot`), or `base` exactly. */
export function boneOf(skin: Skin, base: string): number {
    for (const [i, n] of skin.nodeNames ?? []) if (n === base || n.endsWith(':' + base)) return i
    throw new Error(`the skeleton has no ${base} bone`)
}

export interface Measured {
    seconds: number
    /** Hips ground travel over the clip, model space (x = left, z = forward), metres. */
    travel: [number, number]
    /** Ground speed in m/s: from the travel when the clip travels, else from the stance feet. */
    speed: number
    /** Heading of travel in degrees: 0 ahead, +90 left, -90 right, 180 back. */
    direction: number
    /** Normalized time of the left (and right) foot striking the ground, or null. */
    strikeL: number | null
    strikeR: number | null
    /** Airborne spans, seconds: both feet more than 5 cm above the clip's lowest. */
    air: { from: number; to: number; peak: number }[]
    /** Height of the lowest foot point over the clip's ground, per sample. */
    times: number[]
    lowest: number[]
    hipsY: number[]
    hipsXZ: [number, number][]
}

const STEP = 1 / 60

export function measure(skin: Skin, clip: Animation): Measured {
    const pose = poser(skin, clip)
    const seconds = clipSeconds(clip)
    const hips = boneOf(skin, 'Hips')
    const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(b => boneOf(skin, b))
    const n = Math.max(2, Math.round(seconds / STEP))
    const times: number[] = [], lowest: number[] = [], hipsY: number[] = [], hipsXZ: [number, number][] = []
    const ankles: { l: vec3; r: vec3; h: vec3 }[] = []
    for (let k = 0; k <= n; k++) {
        const t = seconds * k / n
        const p = pose(t)
        const fp = feet.map(f => p.at(f))
        const h = p.at(hips)
        times.push(t)
        lowest.push(Math.min(...fp.map(v => v[1])))
        hipsY.push(h[1])
        hipsXZ.push([h[0], h[2]])
        ankles.push({ l: fp[0], r: fp[1], h })
    }
    const ground = Math.min(...lowest)
    for (let k = 0; k < lowest.length; k++) lowest[k] -= ground

    const travel: [number, number] = [hipsXZ[n][0] - hipsXZ[0][0], hipsXZ[n][1] - hipsXZ[0][1]]
    let speed = Math.hypot(travel[0], travel[1]) / seconds
    let direction = Math.atan2(travel[0], travel[1]) * D
    // An in-place clip: a planted foot moves backward under the body at the speed the clip covers. Measured as each
    // stance's NET travel over its length (the speed at which a planted foot would hold the ground), summed over
    // every stance of both feet.
    if (Math.hypot(travel[0], travel[1]) < 0.1) {
        let dx = 0, dz = 0, time = 0
        for (const key of ['l', 'r'] as const) {
            const mn = Math.min(...ankles.map(a => a[key][1]))
            let from = -1
            const close = (k: number) => {
                if (from >= 0 && k - from >= 3) {
                    dx += (ankles[k][key][0] - ankles[k].h[0]) - (ankles[from][key][0] - ankles[from].h[0])
                    dz += (ankles[k][key][2] - ankles[k].h[2]) - (ankles[from][key][2] - ankles[from].h[2])
                    time += times[k] - times[from]
                }
                from = -1
            }
            for (let k = 0; k < ankles.length; k++) {
                const down = ankles[k][key][1] <= mn + 0.02
                if (down && from < 0) from = k
                if (!down && from >= 0) close(k - 1)
            }
            if (from >= 0) close(ankles.length - 1)
        }
        if (time > 0) { speed = Math.hypot(dx, dz) / time; direction = Math.atan2(-dx, -dz) * D }
    }

    const strike = (key: 'l' | 'r'): number | null => {
        const mn = Math.min(...ankles.map(a => a[key][1]))
        for (let k = 1; k < ankles.length; k++) if (ankles[k - 1][key][1] > mn + 0.02 && ankles[k][key][1] <= mn + 0.02) return times[k] / seconds
        return null
    }

    const air: { from: number; to: number; peak: number }[] = []
    let start = -1
    for (let k = 0; k < lowest.length; k++) {
        const up = lowest[k] > 0.05
        if (up && start < 0) start = k
        if ((!up || k === lowest.length - 1) && start >= 0) {
            air.push({ from: times[start], to: times[k], peak: Math.max(...lowest.slice(start, k + 1)) })
            start = -1
        }
    }
    return { seconds, travel, speed, direction, strikeL: strike('l'), strikeR: strike('r'), air, times, lowest, hipsY, hipsXZ }
}

/** The hips' heading (yaw, degrees, unwrapped) over a clip's hips rotation channel, relative to its first key. */
export function hipsYaw(skin: Skin, clip: Animation): { times: number[]; yaw: number[] } {
    const hips = boneOf(skin, 'Hips')
    const ch = clip.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'rotation')
    if (!ch) throw new Error(`${clip.name} does not rotate the hips`)
    const s = clip.samplers[ch.samplerIndex]
    const q0 = quat.invert(quat.create(), Array.from(s.output).slice(0, 4) as any)
    const times: number[] = [], yaw: number[] = []
    let prev = 0, total = 0
    for (let k = 0; k < s.input.length; k++) {
        const q = quat.multiply(quat.create(), Array.from(s.output).slice(k * 4, k * 4 + 4) as any, q0)
        const f = vec3.transformQuat(vec3.create(), [0, 0, 1], q)
        const a = Math.atan2(f[0], f[2]) * D
        let d = a - prev
        while (d > 180) d -= 360
        while (d < -180) d += 360
        total += d
        prev = a
        times.push(s.input[k])
        yaw.push(total)
    }
    return { times, yaw }
}

/**
 * The body's heading over a clip, degrees, unwrapped (0 = facing +Z): the line through the two thighs, which
 * stays well defined when the hips pitch far forward (their own forward axis then points at the ground).
 */
export function thighHeading(skin: Skin, clip: Animation, times: number[]): number[] {
    const pose = poser(skin, clip)
    const l = boneOf(skin, 'LeftUpLeg'), r = boneOf(skin, 'RightUpLeg')
    const out: number[] = []
    let prev = 0, total = 0, first = true
    for (const t of times) {
        const p = pose(t)
        const a = p.at(l), b = p.at(r)
        // Forward is (left - right) x up: +Z at rest, so the heading is the engine's yaw, atan2(x, z).
        const h = Math.atan2(-(a[2] - b[2]), a[0] - b[0]) * D
        if (first) { prev = h; total = h; first = false }
        let d = h - prev
        while (d > 180) d -= 360
        while (d < -180) d += 360
        total += d
        prev = h
        out.push(total)
    }
    return out
}

/**
 * How far the body leans sideways at each time, degrees, in its OWN frame: the hips' up axis, turned back by the
 * thigh heading, read about the forward axis. The sideways lean a clip had, whatever way it was facing.
 */
export function bodyRoll(skin: Skin, clip: Animation, times: number[]): number[] {
    const pose = poser(skin, clip)
    const hips = boneOf(skin, 'Hips')
    const heading = thighHeading(skin, clip, times)
    // The hips' up axis at REST, from the skin (a clip's first frame would make two cuts of one clip disagree).
    const parents = skin.nodeParents as Map<number, number>
    const local = skin.nodeTransforms as Map<number, mat4>
    const restWorld = (i: number): mat4 => { const p = parents.get(i); const l = local.get(i) ?? mat4.create(); return p === undefined || p === i ? l : mat4.multiply(mat4.create(), restWorld(p), l) }
    const rest = restWorld(hips)
    const restUp = vec3.transformMat4(vec3.create(), [0, 1, 0], mat4.invert(mat4.create(), stripTranslation(rest)))
    return times.map((t, k) => {
        const w = stripTranslation(pose(t).world(hips))
        const up = vec3.transformMat4(vec3.create(), restUp, w)
        vec3.transformQuat(up, up, quat.setAxisAngle(quat.create(), [0, 1, 0], -heading[k] / D))
        return Math.atan2(up[0], up[1]) * D
    })
}

function stripTranslation(m: mat4): mat4 {
    const out = mat4.clone(m)
    out[12] = 0; out[13] = 0; out[14] = 0
    return out
}

/** The constant acceleration that best fits the hips' ground travel from rest, m/s2 (least squares on d = a t2 / 2). */
export function travelAcceleration(m: Measured): number {
    let num = 0, den = 0
    const [x0, z0] = m.hipsXZ[0]
    for (let k = 0; k < m.times.length; k++) {
        const t = m.times[k], d = Math.hypot(m.hipsXZ[k][0] - x0, m.hipsXZ[k][1] - z0)
        num += d * t * t / 2
        den += (t * t / 2) ** 2
    }
    return den > 0 ? num / den : 0
}

/**
 * When each foot plants, in seconds: its ankle coming down to within 2.5 cm of its own lowest in the clip after at
 * least three frames above that. Heights only, so it reads a cycle or a one-shot, held in place or travelling. A
 * foot already down when the clip starts is not a plant.
 */
export function plants(skin: Skin, clip: Animation): { L: number[]; R: number[] } {
    const pose = poser(skin, clip)
    const seconds = clipSeconds(clip)
    const n = Math.max(2, Math.round(seconds / STEP))
    const bones = { L: boneOf(skin, 'LeftFoot'), R: boneOf(skin, 'RightFoot') }
    const heights = { L: [] as number[], R: [] as number[] }
    const times: number[] = []
    for (let k = 0; k <= n; k++) {
        const t = seconds * k / n
        const p = pose(t)
        times.push(t)
        heights.L.push(p.at(bones.L)[1])
        heights.R.push(p.at(bones.R)[1])
    }
    const out = { L: [] as number[], R: [] as number[] }
    for (const side of ['L', 'R'] as const) {
        const h = heights[side]
        const low = Math.min(...h)
        let above = 0
        for (let k = 0; k <= n; k++) {
            const down = h[k] <= low + 0.025
            if (down && above >= 3) out[side].push(times[k])
            above = down ? 0 : above + 1
        }
    }
    return out
}

/** A landing's impact: seconds from its start to the hips' lowest point within its first `window` seconds. */
export function impactTime(skin: Skin, clip: Animation, window = 0.8): number {
    const m = measure(skin, clip)
    let best = 0
    for (let k = 0; k < m.times.length && m.times[k] <= window; k++) if (m.hipsY[k] < m.hipsY[best]) best = k
    return m.times[best]
}
