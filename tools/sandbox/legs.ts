// Leg-track helpers for the stair clips: world rotations read off a posed skin, rotation tracks written back, and
// the knee alignment the climbs get (descent.ts rebuilds the descents' legs with the same pieces).

import { mat4, quat, vec3 } from 'gl-matrix'
import type { Animation, Skin } from '../../src/animation/animatedModel'
import { boneOf, clipSeconds, poser } from './measure'

/** Samples per second of a rewritten leg track. */
export const LEG_FPS = 60

/** A world matrix's rotation (the skin is on unit-scale joints). */
export function rotationOf(m: mat4): quat {
    return quat.normalize(quat.create(), mat4.getRotation(quat.create(), m))
}

/** Append a quaternion, on the same side of the sphere as the one before (no flip mid-track). */
export function push(track: number[], q: quat): void {
    const k = track.length
    if (k >= 4 && track[k - 4] * q[0] + track[k - 3] * q[1] + track[k - 2] * q[2] + track[k - 1] * q[3] < 0) quat.scale(q, q, -1)
    track.push(q[0], q[1], q[2], q[3])
}

/** `parent^-1 * child`: a joint's local rotation from its own and its parent's world rotations. */
export function localOf(parentW: quat, childW: quat): quat {
    return quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), parentW), childW))
}

/** The clip with the rotation tracks of `tracks`' joints replaced (sampled at `times`), everything else as it was. */
export function withRotationTracks(clip: Animation, times: number[], tracks: Map<number, number[]>): Animation {
    const out: Animation = {
        ...clip,
        samplers: clip.samplers.map(s => ({ input: Array.from(s.input), output: Array.from(s.output), interpolation: s.interpolation })),
        channels: clip.channels.filter(c => !(tracks.has(c.targetNodeIndex) && c.targetPath === 'rotation')).map(c => ({ ...c })),
    } as Animation
    for (const [node, output] of tracks) {
        out.samplers.push({ input: times.slice(), output, interpolation: 'LINEAR' } as any)
        out.channels.push({ samplerIndex: out.samplers.length - 1, targetNodeIndex: node, targetPath: 'rotation' })
    }
    return out
}

/** The legs of a humanoid skin: each side's thigh, shin and foot joints. */
export function legsOf(skin: Skin) {
    return ['Left', 'Right'].map(side => ({
        side, thigh: boneOf(skin, `${side}UpLeg`), shin: boneOf(skin, `${side}Leg`), foot: boneOf(skin, `${side}Foot`),
    }))
}

/** How far apart the knees are side to side, on average over the clip, m (model space: +X is the left). */
export function kneeSpacing(skin: Skin, clip: Animation): number {
    const T = clipSeconds(clip), pose = poser(skin, clip)
    const [l, r] = legsOf(skin)
    let sum = 0
    const n = 30
    for (let k = 0; k < n; k++) { const p = pose(T * k / n); sum += p.at(l.shin)[0] - p.at(r.shin)[0] }
    return sum / n
}

/**
 * Turn each knee toward straight ahead by `share` of the way, about the line from its hip to its ankle: the leg
 * turns as one about that line, so the ankle stays exactly where the clip puts it and only the knee moves. The
 * foot keeps its own world rotation. For a clip that splays its knees (the pack's walking climb holds them 23 cm
 * apart over hips 16 cm apart; the flat walk 18).
 */
export function alignKnees(skin: Skin, clip: Animation, share: number): Animation {
    const T = clipSeconds(clip)
    if (!(T > 0) || !(share > 0)) return clip
    const legs = legsOf(skin)
    const hips = boneOf(skin, 'Hips')
    const pose = poser(skin, clip)
    const n = Math.max(2, Math.round(T * LEG_FPS))
    const times = Array.from({ length: n + 1 }, (_, k) => T * k / n)
    const tracks = new Map<number, number[]>()
    for (const l of legs) for (const node of [l.thigh, l.shin, l.foot]) tracks.set(node, [])
    const ahead = vec3.fromValues(0, 0, 1)
    const axis = vec3.create(), off = vec3.create(), want = vec3.create(), cross = vec3.create()
    for (const t of times) {
        const p = pose(t)
        const hipsW = rotationOf(p.world(hips))
        for (const l of legs) {
            const root = p.at(l.thigh), knee = p.at(l.shin), tip = p.at(l.foot)
            vec3.normalize(axis, vec3.sub(axis, tip, root))
            // The knee's offset from the hip-ankle line, and straight ahead off that line.
            vec3.sub(off, knee, root)
            vec3.scaleAndAdd(off, off, axis, -vec3.dot(off, axis))
            vec3.scaleAndAdd(want, ahead, axis, -vec3.dot(ahead, axis))
            let turn = quat.create()
            if (vec3.length(off) > 1e-4 && vec3.length(want) > 1e-4) {
                vec3.normalize(off, off); vec3.normalize(want, want)
                const angle = Math.atan2(vec3.dot(vec3.cross(cross, off, want), axis), vec3.dot(off, want))
                turn = quat.setAxisAngle(quat.create(), axis, angle * share)
            }
            const thighW = quat.multiply(quat.create(), turn, rotationOf(p.world(l.thigh)))
            const shinW = quat.multiply(quat.create(), turn, rotationOf(p.world(l.shin)))
            const footW = rotationOf(p.world(l.foot))
            push(tracks.get(l.thigh)!, localOf(hipsW, thighW))
            push(tracks.get(l.shin)!, localOf(thighW, shinW))
            push(tracks.get(l.foot)!, localOf(shinW, footW))
        }
    }
    return withRotationTracks(clip, times, tracks)
}
