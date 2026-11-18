// The Sandbox's clips: which Locomotion Pack file plays what, and how each is conditioned for the engine.
//
// Every clip arrives from prepare.mjs retargeted onto the mannequin's metre skeleton with its TRAVEL KEPT, so its
// ground speed can be measured before it is taken out. This file decides, per clip:
//
//   locomotion  measured (speed, direction, foot phase), then held in place (`bakeInPlace`): the Character moves
//               the body, and a blend space cannot use root motion anyway;
//   turn        the hips' yaw moved onto the Pivot joint above them and scaled to exactly 90 / 180 degrees, with
//               root motion on, so the capsule turns and nothing else moves (see prepare.mjs);
//   air         cut at take-off and touchdown, held in place, and the clip's own ballistic rise taken out of the
//               hips over each airborne span: the physics jump carries the body, the clip keeps the tuck;
//   stop        its turn (the run-to-stop plants sideways, 46 degrees) moved onto the Pivot as root motion, so the
//               capsule turns with it and the planted feet stay put; its travel taken out as the body brakes; and
//               its mirror, so a stop can start on either foot (the machine picks by the run's phase);
//   start       held in place by the travel the BODY makes as it accelerates into a sprint, and played at the rate
//               that matches the clip's push-off to the Character's acceleration;
//   run turn    a turn (yaw onto the Pivot, scaled to 180) whose travel is held in place.
//
// "Held in place" is `holdInPlace` here, not the engine's bakeInPlace. That one also takes the YAW out of the hips,
// with a swing-twist split, and these clips turn the pelvis while they bend (the hard landing twists 44 degrees
// bent 74 forward): the twist taken out of a twisted-then-bent rotation leaves the bend about the twisted axis, a
// sideways lean of up to 51 degrees. The pelvis twisting against the planted feet is part of the motion, so it is
// left alone: only the ground travel goes.
//
// To use a better clip, drop it in build/LocomotionPack and point its role here. A role whose file is missing is
// skipped with a warning when it is optional (the sprint) and stops the build when it is not.

import { mat4, quat, vec3 } from 'gl-matrix'
import type { Animation, Skin } from '../../src/animation/animatedModel'
import { mirrorClip, timeScaleClip, trimClip } from '../../src/animation/clipEdit'
import { detectFootLockWindows, shrinkFootLockSpans } from '../../src/animation/footLockWindows'
import { boneOf, clipSeconds, hipsYaw, measure, travelAcceleration, type Measured } from './measure'

export type ClipKind = 'loop' | 'locomotion' | 'turn' | 'air' | 'oneShot' | 'stop' | 'start' | 'runTurn'

export interface ClipRole {
    /** The clip's name in the project (what states and blend-space samples name). */
    name: string
    /** File stem in build/LocomotionPack. */
    file: string
    kind: ClipKind
    /** A turn: the angle it must turn by (positive = left), within 15 degrees. */
    turn?: number
    optional?: boolean
}

export const ROLES: ClipRole[] = [
    { name: 'Idle', file: 'idle', kind: 'loop' },
    { name: 'WalkF', file: 'walking', kind: 'locomotion' },
    { name: 'WalkL', file: 'left strafe walking', kind: 'locomotion' },
    { name: 'WalkR', file: 'right strafe walking', kind: 'locomotion' },
    { name: 'WalkB', file: 'Walking Backward', kind: 'locomotion' },
    { name: 'JogF', file: 'running', kind: 'locomotion' },
    { name: 'JogL', file: 'left strafe', kind: 'locomotion' },
    { name: 'JogR', file: 'right strafe', kind: 'locomotion' },
    { name: 'JogB', file: 'Running Backward', kind: 'locomotion' },
    { name: 'JogBR', file: 'Jog Backward Diagonal', kind: 'locomotion' },
    { name: 'SprintF', file: 'sprint', kind: 'locomotion' },
    { name: 'Start', file: 'Idle To Sprint', kind: 'start' },
    { name: 'RunTurnR', file: 'Running Turn 180', kind: 'runTurn', turn: -180 },
    { name: 'Turn90L', file: 'left turn 90', kind: 'turn', turn: 90 },
    { name: 'Turn90R', file: 'right turn 90', kind: 'turn', turn: -90 },
    { name: 'Turn180L', file: 'left turn', kind: 'turn', turn: 180 },
    { name: 'Turn180R', file: 'right turn', kind: 'turn', turn: -180 },
    { name: 'Stop', file: 'Run To Stop', kind: 'stop' },
    { name: 'Jump', file: 'jump', kind: 'air' },
    { name: 'JumpRun', file: 'Running Jump', kind: 'air' },
    { name: 'Fall', file: 'Fall A Loop', kind: 'loop' },
    { name: 'LandSoft', file: 'Falling To Landing', kind: 'air' },
    { name: 'LandHard', file: 'Hard Landing', kind: 'air' },
    { name: 'LandRoll', file: 'Falling To Roll', kind: 'air' },
]

/** A clip ready to store, and what was measured on it. */
export interface MadeClip {
    clip: Animation
    role: ClipRole | null
    m: Measured
    /** Air clips: the take-off and touchdown the clip was cut at (seconds of the source). */
    takeoff?: number
    touchdown?: number
    /** Turns: the share of the clip at which its turn is complete (95%). */
    turnDone?: number
    /** The start: the acceleration its travel fits (m/s2), and the rate it plays at to match the Character's. */
    accel?: number
    /** The start's rate, as above; the landing roll's, the one its own travel speed matches a jog at. */
    rate?: number
    /** The landing roll: the share of it at which it is up enough to hand back to the run. */
    handOver?: number
}

/** What the build decides that the clips cannot measure. */
export interface ClipOptions {
    /** The sprint's speed, m/s: what the start accelerates to (the sprint clip plays faster to match it). */
    sprint: number
}

/** The lean at full weight, degrees: the whole body tilted about the ground under it (see `leanClip`). */
export const LEAN_DEGREES = 10
/** The forward lean at full weight, degrees, and how much of it tilts the whole body (see `leanForwardClip`). */
export const LEAN_FORWARD_DEGREES = 8
export const LEAN_FORWARD_HIPS_DEGREES = 4

/** The Character's acceleration: the one the Stop clip's ground travel decelerates at from a jog (clamped 8..16 m/s2). */
export function characterAcceleration(clips: Map<string, MadeClip>): number {
    const jog = clips.get('JogF')!.m.speed
    const stop = Math.hypot(...clips.get('Stop')!.m.travel)
    return Math.min(16, Math.max(8, jog * jog / (2 * Math.max(0.3, stop))))
}

/** Ground travel from rest at acceleration `a` up to `vmax`, after `t` seconds. */
const travelFromRest = (t: number, a: number, vmax: number) => {
    const t1 = vmax / a
    return t < t1 ? a * t * t / 2 : vmax * t1 / 2 + vmax * (t - t1)
}

/**
 * Hold a clip in place: its rotation untouched (no tilt, see the header), its ground travel taken out, either all
 * of it (pinned) or `travel(t)` along the clip's +Z, the ground the BODY covers at that point of the clip.
 */
function holdInPlace(skin: Skin, clip: Animation, travel?: (t: number) => number): Animation {
    const out = plain(clip)
    const hips = boneOf(skin, 'Hips')
    const ch = out.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
    if (!ch) return out
    const s = out.samplers[ch.samplerIndex]
    const o = s.output as number[]
    const [x0, , z0] = [o[0], o[1], o[2]]
    for (let k = 0; k < s.input.length; k++) {
        if (travel) o[k * 3 + 2] -= travel(s.input[k])
        else { o[k * 3] = x0; o[k * 3 + 2] = z0 }
    }
    return out
}

/** A joint's rest world rotation (the skin is in metres on rigid joints). */
function restRotation(skin: Skin, node: number): quat {
    const parents = skin.nodeParents as Map<number, number>
    const local = skin.nodeTransforms as Map<number, mat4>
    const world = (i: number): mat4 => {
        const p = parents.get(i)
        const l = local.get(i) ?? mat4.create()
        return p === undefined || p === i ? l : mat4.multiply(mat4.create(), world(p), l)
    }
    return quat.normalize(quat.create(), mat4.getRotation(quat.create(), world(node)))
}

/** A joint's rest world position. */
function restPosition(skin: Skin, node: number): vec3 {
    const parents = skin.nodeParents as Map<number, number>
    const local = skin.nodeTransforms as Map<number, mat4>
    const world = (i: number): mat4 => {
        const p = parents.get(i)
        const l = local.get(i) ?? mat4.create()
        return p === undefined || p === i ? l : mat4.multiply(mat4.create(), world(p), l)
    }
    return mat4.getTranslation(vec3.create(), world(node))
}

/**
 * A lean, as an additive clip: rest at t = 0, then from 0.05 s on the WHOLE body tilted `degrees` about the body's
 * forward axis (positive leans RIGHT, the engine's angle sign), the way a runner banks into a curve: about the
 * ground under the feet, not from the hips up.
 *
 *   - the hips rolled by the angle, and moved over and down by what that roll swings the ankles out by
 *     (h sin, h (1 - cos), h the hips' height over the ankles), so the ankles stay where they are;
 *   - the feet rolled back by the angle, so the soles stay flat for foot placement;
 *   - the spine a few degrees further into the lean, the neck and head a few back toward level.
 *
 * Rotations are about each joint's own local copy of the axis, so on an additive layer (which multiplies
 * `inverse(first) x current` onto each local rotation, and adds the translation in the parent's frame) the lean
 * follows the body's forward however the run pitches it.
 */
export function leanClip(skin: Skin, name: string, degrees: number): Animation {
    const sign = Math.sign(degrees)
    return tiltClip(skin, name, 'roll', degrees, sign * 4, sign * 3)
}

/**
 * The forward lean, as an additive clip, the weight going into the step as it sets off: the trunk pitched
 * `degrees` forward, `hipsDegrees` of it a whole-body tilt about the ankles (as `leanClip` rolls it) and the rest
 * in the spine, the head a little back toward level. Positive leans forward.
 *
 * Half of it is in the spine because a start's feet are not under its hips: one is far behind, pushing off, and
 * the hips are lower than at rest, so a whole-body tilt about where the ankles are AT REST moves the planted foot
 * as the lean comes in (8 degrees of it doubles a sprint start's foot slide). The spine moves nothing below it.
 */
export function leanForwardClip(skin: Skin, name: string, degrees: number, hipsDegrees = LEAN_FORWARD_HIPS_DEGREES): Animation {
    return tiltClip(skin, name, 'pitch', hipsDegrees, degrees - hipsDegrees, 2 * Math.sign(degrees))
}

/**
 * The whole body tilted about the ground under the ankles, rest at t = 0 and tilted from 0.05 s: the hips turned
 * by the angle about the body's forward axis (`roll`, positive to the RIGHT) or its left axis (`pitch`, positive
 * FORWARD), and moved by what that swings the ankles out by (h sin, h (1 - cos)) so they stay put; the feet turned
 * back so the soles stay flat; the spine a little further, the neck and head a little back toward level.
 */
function tiltClip(skin: Skin, name: string, kind: 'roll' | 'pitch', degrees: number, spineDegrees: number, headDegrees: number): Animation {
    const samplers: any[] = [], channels: any[] = []
    const local = skin.nodeTransforms as Map<number, mat4>
    const rad = degrees * Math.PI / 180
    // Model space: +Z the body's forward, +X its left.
    const bodyAxis: [number, number, number] = kind === 'roll' ? [0, 0, 1] : [1, 0, 0]
    const turn = (bone: string, by: number) => {
        const node = boneOf(skin, bone)
        const restLocal = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local.get(node)!))
        const axis = vec3.transformQuat(vec3.create(), bodyAxis, quat.invert(quat.create(), restRotation(skin, node)))
        const delta = quat.setAxisAngle(quat.create(), vec3.normalize(axis, axis), by)
        const leaned = quat.normalize(quat.create(), quat.multiply(quat.create(), restLocal, delta))
        samplers.push({ input: [0, 0.05, 2], output: [...restLocal, ...leaned, ...leaned], interpolation: 'LINEAR' })
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: node, targetPath: 'rotation' })
    }
    turn('Hips', rad)
    // A roll of +a about +Z swings the ankles toward +X (the body's left) by h sin a; a pitch of +a about +X swings
    // them back (-Z) by as much. The hips go the other way, and down by what the tilt takes off the leg's height.
    const hips = boneOf(skin, 'Hips')
    const h = restPosition(skin, hips)[1] - restPosition(skin, boneOf(skin, 'LeftFoot'))[1]
    const offset = kind === 'roll'
        ? vec3.fromValues(-h * Math.sin(rad), -h * (1 - Math.cos(rad)), 0)
        : vec3.fromValues(0, -h * (1 - Math.cos(rad)), h * Math.sin(rad))
    const parent = (skin.nodeParents as Map<number, number>).get(hips)
    if (parent !== undefined && parent !== hips) vec3.transformQuat(offset, offset, quat.invert(quat.create(), restRotation(skin, parent)))
    const t0 = Array.from(mat4.getTranslation(vec3.create(), local.get(hips)!))
    const t1 = t0.map((v, c) => v + offset[c])
    samplers.push({ input: [0, 0.05, 2], output: [...t0, ...t1, ...t1], interpolation: 'LINEAR' })
    channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: hips, targetPath: 'translation' })
    turn('LeftFoot', -rad)
    turn('RightFoot', -rad)
    for (const bone of ['Spine', 'Spine1', 'Spine2']) turn(bone, (spineDegrees / 3) * Math.PI / 180)
    for (const bone of ['Neck', 'Head']) turn(bone, -headDegrees * Math.PI / 180)
    return { name, samplers, channels } as unknown as Animation
}

/**
 * Move a clip's ground travel from the hips onto the Pivot above them, as root motion: the hips keep their height,
 * bend and twist (nothing about the pose changes), and the Pivot carries the travel, so the capsule moves with the
 * clip instead of the clip sliding over the ground under it.
 */
function travelToPivot(skin: Skin, clip: Animation): Animation {
    const out = plain(clip)
    const hips = boneOf(skin, 'Hips'), pivot = boneOf(skin, 'Pivot')
    const ch = out.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
    if (!ch) return out
    const s = out.samplers[ch.samplerIndex]
    const o = s.output as number[]
    const rest = (skin.nodeTransforms as Map<number, mat4>).get(pivot) ?? mat4.create()
    const restT = mat4.getTranslation(vec3.create(), rest)
    const restR = quat.normalize(quat.create(), mat4.getRotation(quat.create(), rest))
    const [x0, , z0] = [o[0], o[1], o[2]]
    const pivotOut: number[] = []
    for (let k = 0; k < s.input.length; k++) {
        const travel = vec3.transformQuat(vec3.create(), [o[k * 3] - x0, 0, o[k * 3 + 2] - z0], restR)
        pivotOut.push(restT[0] + travel[0], restT[1] + travel[1], restT[2] + travel[2])
        o[k * 3] = x0
        o[k * 3 + 2] = z0
    }
    out.samplers.push({ input: Array.from(s.input), output: pivotOut, interpolation: 'LINEAR' } as any)
    out.channels.push({ samplerIndex: out.samplers.length - 1, targetNodeIndex: pivot, targetPath: 'translation' })
    out.rootMotion = true
    return out
}

/**
 * A look, as an additive pose clip: rest at t = 0, then from 0.05 s the trunk and head turned `yaw` degrees about
 * the body's up axis (positive LEFT) and `pitch` about its left axis (positive DOWN, as an aim's pitch is), the turn
 * spread up the chain by `LOOK_SHARES` so the head ends up looking the whole way. Nine of them, at the corners, edges
 * and centre of the look range, are the Look blend space.
 */
export function lookClip(skin: Skin, name: string, yaw: number, pitch: number): Animation {
    const samplers: any[] = [], channels: any[] = []
    const local = skin.nodeTransforms as Map<number, mat4>
    LOOK_BONES.forEach((bone, k) => {
        const node = boneOf(skin, bone)
        const restLocal = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local.get(node)!))
        const toLocal = quat.invert(quat.create(), restRotation(skin, node))
        const about = (axis: [number, number, number], degrees: number) => {
            const a = vec3.transformQuat(vec3.create(), axis, toLocal)
            return quat.setAxisAngle(quat.create(), vec3.normalize(a, a), degrees * LOOK_SHARES[k] * Math.PI / 180)
        }
        // Yaw, then pitch about the turned head's own left: the way a head looks round and then up or down.
        const delta = quat.multiply(quat.create(), about([0, 1, 0], yaw), about([1, 0, 0], pitch))
        const looked = quat.normalize(quat.create(), quat.multiply(quat.create(), restLocal, delta))
        samplers.push({ input: [0, 0.05, 2], output: [...restLocal, ...looked, ...looked], interpolation: 'LINEAR' })
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: node, targetPath: 'rotation' })
    })
    return { name, samplers, channels } as unknown as Animation
}

/**
 * Where a roll is up enough to run on: the first frame after its lowest that the hips are back 60% of the way to
 * their height at its end, as a share of the clip, and how far the hips have travelled over the ground up to there.
 */
function rollHandOver(skin: Skin, clip: Animation): { handOver: number; travel: number } {
    const hips = boneOf(skin, 'Hips')
    const ch = clip.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
    if (!ch) return { handOver: 0.9, travel: 0 }
    const s = clip.samplers[ch.samplerIndex]
    const o = s.output as number[], t = s.input as number[]
    const y = (k: number) => o[k * 3 + 1]
    let low = 0
    for (let k = 1; k < t.length; k++) if (y(k) < y(low)) low = k
    const up = y(low) + 0.6 * (y(t.length - 1) - y(low))
    let at = t.length - 1
    for (let k = low; k < t.length; k++) if (y(k) >= up) { at = k; break }
    const T = t[t.length - 1] || 1
    return { handOver: Math.min(0.95, t[at] / T), travel: Math.hypot(o[at * 3] - o[0], o[at * 3 + 2] - o[2]) }
}

/** The bones a look turns, hips up: the Look bone mask. */
export const LOOK_BONES = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head']
/** The share of a look each of `LOOK_BONES` turns (they add up to 1: the head looks the whole way). */
const LOOK_SHARES = [0.15, 0.15, 0.15, 0.25, 0.3]
/** The look range: as far round (degrees, either way) and up or down as the Look blend space reaches. */
export const LOOK_YAW = 90
export const LOOK_PITCH = 45
/** The Look blend space's samples: the clip name and where it sits (yaw left +, pitch down +). */
export const LOOK_SAMPLES: [string, number, number][] = [
    ['LookC', 0, 0], ['LookL', LOOK_YAW, 0], ['LookR', -LOOK_YAW, 0], ['LookU', 0, -LOOK_PITCH], ['LookD', 0, LOOK_PITCH],
    ['LookUL', LOOK_YAW, -LOOK_PITCH], ['LookUR', -LOOK_YAW, -LOOK_PITCH], ['LookDL', LOOK_YAW, LOOK_PITCH], ['LookDR', -LOOK_YAW, LOOK_PITCH],
]

/** The bones a lean clip moves, and the arms and legs between them that ride along: the Lean bone mask. */
export const LEAN_BONES = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']

const plain = (clip: Animation): Animation => ({
    ...clip,
    samplers: clip.samplers.map(s => ({ input: Array.from(s.input), output: Array.from(s.output), interpolation: s.interpolation })),
    channels: clip.channels.map(c => ({ ...c })),
}) as Animation

const named = (clip: Animation, name: string): Animation => ({ ...plain(clip), name })

/**
 * Turn: Pivot.rotation = yaw(t) * scale, hips = yaw(t)^-1 * hips(t). The world pose is the source's (turned the
 * extra few degrees the scaling adds), and root motion, which follows the highest animated joint, sees pure yaw.
 */
function splitTurn(skin: Skin, clip: Animation, nominal: number | null, travel?: (t: number) => number): { clip: Animation; done: number } {
    const hips = boneOf(skin, 'Hips')
    const pivot = boneOf(skin, 'Pivot')
    const { times, yaw } = hipsYaw(skin, clip)
    const total = yaw[yaw.length - 1]
    if (nominal !== null && Math.abs(total - nominal) > 15) throw new Error(`${clip.name} turns ${total.toFixed(1)} degrees, not ${nominal}`)
    const scale = nominal === null ? 1 : nominal / total
    const out = plain(clip)
    const yawAt = (t: number) => {
        let i = 0
        while (i < times.length - 2 && times[i + 1] < t) i++
        const span = times[i + 1] - times[i]
        const f = span > 0 ? Math.min(1, Math.max(0, (t - times[i]) / span)) : 0
        return yaw[i] + (yaw[i + 1] - yaw[i]) * f
    }
    for (const ch of out.channels) {
        if (ch.targetNodeIndex !== hips) continue
        const s = out.samplers[ch.samplerIndex]
        const o = s.output as number[]
        for (let k = 0; k < s.input.length; k++) {
            const inv = quat.setAxisAngle(quat.create(), [0, 1, 0], -yawAt(s.input[k]) * Math.PI / 180)
            if (ch.targetPath === 'rotation') {
                const q = quat.multiply(quat.create(), inv, o.slice(k * 4, k * 4 + 4) as any)
                quat.normalize(q, q)
                for (let c = 0; c < 4; c++) o[k * 4 + c] = q[c]
            } else if (ch.targetPath === 'translation') {
                // The ground the body covers comes out first, in the clip's frame, before the turn is undone.
                const t = o.slice(k * 3, k * 3 + 3)
                if (travel) t[2] -= travel(s.input[k])
                const v = vec3.transformQuat(vec3.create(), t as any, inv)
                for (let c = 0; c < 3; c++) o[k * 3 + c] = v[c]
            }
        }
    }
    const output: number[] = []
    for (const t of times) {
        const q = quat.setAxisAngle(quat.create(), [0, 1, 0], yawAt(t) * scale * Math.PI / 180)
        output.push(q[0], q[1], q[2], q[3])
    }
    out.samplers.push({ input: times.slice(), output, interpolation: 'LINEAR' } as any)
    out.channels.push({ samplerIndex: out.samplers.length - 1, targetNodeIndex: pivot, targetPath: 'rotation' })
    out.rootMotion = true
    const seconds = clipSeconds(out)
    const doneAt = times.find((t, k) => Math.abs(yaw[k]) >= Math.abs(total) * 0.95) ?? seconds
    return { clip: out, done: doneAt / seconds }
}

/** Take the ballistic rise out of the hips over `[from, to]`: 4H s(1-s) above the line joining the ends. */
function removeArc(skin: Skin, clip: Animation, from: number, to: number): void {
    const hips = boneOf(skin, 'Hips')
    const ch = clip.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
    if (!ch) return
    const s = clip.samplers[ch.samplerIndex]
    const o = s.output as number[]
    const yAt = (t: number) => {
        let i = 0
        while (i < s.input.length - 2 && s.input[i + 1] < t) i++
        const span = s.input[i + 1] - s.input[i]
        const f = span > 0 ? Math.min(1, Math.max(0, (t - s.input[i]) / span)) : 0
        return o[i * 3 + 1] + (o[(i + 1) * 3 + 1] - o[i * 3 + 1]) * f
    }
    const y0 = yAt(from), y1 = yAt(to)
    // The bump the arc adds, never more than the clip rose: the shape left over is the tuck.
    let H = 0
    for (let k = 0; k < s.input.length; k++) {
        const t = s.input[k]
        if (t <= from || t >= to) continue
        const u = (t - from) / (to - from)
        H = Math.max(H, o[k * 3 + 1] - (y0 + (y1 - y0) * u))
    }
    for (let k = 0; k < s.input.length; k++) {
        const t = s.input[k]
        if (t <= from || t >= to) continue
        const u = (t - from) / (to - from)
        o[k * 3 + 1] -= 4 * H * u * (1 - u)
    }
}

/**
 * Condition every role's clip. `raw` maps a file stem to its prepared clip (travel kept). Returns the clips to
 * store, by project clip name.
 */
export function makeClips(skin: Skin, raw: Map<string, Animation>, warn: (s: string) => void, options: ClipOptions): Map<string, MadeClip> {
    const out = new Map<string, MadeClip>()
    const add = (clip: Animation, role: ClipRole | null, extra: Partial<MadeClip> = {}) => {
        if (out.has(clip.name)) throw new Error(`two clips are both called ${clip.name}`)
        out.set(clip.name, { clip, role, m: extra.m ?? measure(skin, clip), ...extra })
    }
    const inPlace = (clip: Animation) => holdInPlace(skin, clip)
    /**
     * A locomotion cycle in place: only its AVERAGE travel taken out of the hips, so the surge and sway within a
     * stride stay. The body moves at that average, and the feet then hold the ground as they did in the source;
     * pinning the hips outright (bakeInPlace) turns the in-stride surge into foot slide (measured: a quarter of a
     * metre a second on the run).
     */
    const cycleInPlace = (clip: Animation, m: Measured) => {
        const out = plain(clip)
        const hips = boneOf(skin, 'Hips')
        const ch = out.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
        if (!ch) return out
        const s = out.samplers[ch.samplerIndex]
        const o = s.output as number[]
        for (let k = 0; k < s.input.length; k++) {
            o[k * 3] -= m.travel[0] * s.input[k] / m.seconds
            o[k * 3 + 2] -= m.travel[1] * s.input[k] / m.seconds
        }
        return out
    }

    for (const role of ROLES) {
        const source = raw.get(role.file)
        if (!source) {
            if (role.optional) { warn(`no ${role.file}.fbx in build/LocomotionPack: ${role.name} falls back`); continue }
            throw new Error(`build/LocomotionPack has no ${role.file}.fbx (the ${role.name} clip)`)
        }
        const m = measure(skin, source)
        if (role.kind === 'start') continue   // after the loop: it needs the Character's acceleration
        if (role.kind === 'turn') {
            const { clip, done } = splitTurn(skin, named(source, role.name), role.turn!)
            add(clip, role, { m, turnDone: done })
        } else if (role.kind === 'stop') {
            // Braking from a jog at the acceleration the stop's own travel gives (characterAcceleration).
            const v = raw.has('running') ? measure(skin, raw.get('running')!).speed : 4
            const a = Math.min(16, Math.max(8, v * v / (2 * Math.max(0.3, Math.hypot(...m.travel)))))
            const braking = (t: number) => Math.min(t, v / a) * v - a * Math.min(t, v / a) ** 2 / 2
            const { clip } = splitTurn(skin, named(source, role.name), null, braking)
            add(clip, role, { m })
            // The same stop off the other foot: a stop must plant the foot that is swinging when the player lets go.
            const mirror = named(mirrorClip(clip, skin), role.name + 'Mirror')
            mirror.rootMotion = true
            add(mirror, role, { m: { ...m, travel: [-m.travel[0], m.travel[1]], direction: -m.direction } })
        } else if (role.kind === 'runTurn') {
            // The turn onto the Pivot, then its travel pinned (the hips keep their sway in the Pivot's frame).
            const { clip, done } = splitTurn(skin, named(source, role.name), role.turn!)
            const hips = boneOf(skin, 'Hips')
            const ch = clip.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
            if (ch) {
                const o = clip.samplers[ch.samplerIndex].output as number[]
                for (let k = 3; k < o.length; k += 3) { o[k] = o[0]; o[k + 2] = o[2] }
            }
            add(clip, role, { m, turnDone: done })
            const left = named(mirrorClip(clip, skin), role.name.replace(/R$/, 'L'))
            left.rootMotion = true
            add(left, role, { m, turnDone: done })
        } else if (role.kind === 'locomotion') {
            add(cycleInPlace(named(source, role.name), m), role, { m })
        } else if (role.kind === 'loop' || role.kind === 'oneShot') {
            add(inPlace(named(source, role.name)), role, { m })
        } else {
            // Air: the first airborne span is the jump (or the fall the landing clip starts in).
            const span = m.air[0]
            if (!span) throw new Error(`${role.file} has no airborne span to cut at`)
            const held = inPlace(named(source, role.name))
            if (role.name === 'LandRoll') {
                // The landing roll keeps the run going: from touchdown, held in place (the body's own speed
                // carries it, steadily, as a tumble reads), handed back to the run as it gets up, and played at the
                // rate that makes the ground it rolls over up to then a jog's.
                const cut = named(trimClip(named(source, role.name), span.to, m.seconds), role.name)
                const { handOver, travel } = rollHandOver(skin, cut)
                const jog = out.get('JogF')?.m.speed ?? 3.5
                const rate = Math.min(1.6, Math.max(0.8, jog / Math.max(0.1, travel / Math.max(0.1, handOver * clipSeconds(cut)))))
                add(inPlace(cut), role, { m, touchdown: span.to, rate: Math.round(rate * 1000) / 1000, handOver: Math.round(handOver * 1000) / 1000 })
            } else if (role.name === 'LandHard') {
                // The hard landing crouches and stands up where it came down: its own travel is root motion, and
                // its state holds the character still meanwhile, so it does not slide on with its fall or the stick.
                add(named(travelToPivot(skin, trimClip(named(source, role.name), span.to, m.seconds)), role.name), role, { m, touchdown: span.to })
            } else if (role.name.startsWith('Land')) {
                // A landing clip starts falling: keep it from touchdown.
                add(named(trimClip(held, span.to, m.seconds), role.name), role, { m, touchdown: span.to })
            } else {
                const air = plain(trimClip(held, span.from, span.to))
                removeArc(skin, air, 0, span.to - span.from)
                add(named(air, role.name + 'Air'), role, { m, takeoff: span.from, touchdown: span.to })
                add(named(trimClip(held, span.to, m.seconds), role.name + 'Land'), role, { m, takeoff: span.from, touchdown: span.to })
            }
        }
    }

    // The start: its push-off fitted with a constant acceleration, and held in place by the travel the body makes
    // meanwhile as it accelerates into a sprint (so the planted feet hold the ground). The body takes off at that
    // same acceleration (SandboxPlayer's sprintTakeoff), so the clip plays at its own speed: played faster to keep
    // up with the Character's quick acceleration, it was over in half a second and hardly seen.
    const startRole = ROLES.find(r => r.kind === 'start')!
    const startSource = raw.get(startRole.file)
    if (!startSource) throw new Error(`build/LocomotionPack has no ${startRole.file}.fbx (the Start clip)`)
    {
        const m = measure(skin, startSource)
        const accel = travelAcceleration(m)
        const rate = 1
        const clip = holdInPlace(skin, named(startSource, 'Start'), t => travelFromRest(t / rate, accel, options.sprint))
        add(clip, startRole, { m, accel, rate })
    }

    // Leans for the additive layers, one each way.
    add(leanClip(skin, 'LeanLeft', -LEAN_DEGREES), null, { m: emptyMeasure() })
    add(leanClip(skin, 'LeanRight', LEAN_DEGREES), null, { m: emptyMeasure() })
    add(leanForwardClip(skin, 'LeanForward', LEAN_FORWARD_DEGREES), null, { m: emptyMeasure() })
    // The look poses for the Look layer's blend space.
    for (const [name, yaw, pitch] of LOOK_SAMPLES) add(lookClip(skin, name, yaw, pitch), null, { m: emptyMeasure() })

    // The back diagonals have a clip of their own (back-right, and back-left as its mirror): a strafe blended
    // with a backpedal crosses the legs the wrong way (measured: the feet slide at near the travel speed). The
    // walk and creep rings play the same pair slower, under their own names (a blend space merges samples by
    // clip name).
    const br = out.get('JogBR')
    if (br) {
        const bl = named(mirrorClip(br.clip, skin), 'JogBL')
        add(bl, br.role, { m: { ...measure(skin, bl), speed: br.m.speed, travel: [-br.m.travel[0], br.m.travel[1]], direction: -br.m.direction } })
        for (const ring of ['Walk', 'Creep']) for (const side of ['BR', 'BL']) {
            const src = out.get('Jog' + side)!
            add(named(src.clip, ring + side), null, { m: src.m })
        }
        // A brisk walk at the back diagonal's speed, to the sides: without it, a strafe between the walk and the
        // jog sits nearer the back-diagonal sample (slower than either side clip) than the jog's, and blends in
        // a backpedal while going sideways.
        for (const side of ['L', 'R']) {
            const src = out.get('Walk' + side)!
            add(named(src.clip, 'Brisk' + side), null, { m: src.m })
        }
    }
    // Creep: the walk clips at half speed, for a barely pushed stick.
    for (const dir of ['F', 'L', 'R', 'B']) {
        const walk = out.get('Walk' + dir)!
        add(named(timeScaleClip(walk.clip, 2), 'Creep' + dir), null, { m: { ...walk.m, speed: walk.m.speed / 2, seconds: walk.m.seconds * 2 } })
    }

    // Foot-lock windows, on the clips as they will play: each foot locks from the ball of the foot coming down
    // until the heel has lifted 3 cm, and follows the clip through the push-off. Every clip of a state that locks;
    // the idle, its turns and the air clips have none (their states do not lock).
    // The backward diagonals hold for half of that: their crossing steps fight a long lock.
    for (const [name, made] of out) {
        if (!FOOT_LOCKED.test(name)) continue
        const found = detectFootLockWindows(made.clip, skin, { heelLift: FOOT_LOCK_HEEL_LIFT })
        made.clip = { ...made.clip, footLocks: BACK_DIAGONAL.test(name) ? shrinkFootLockSpans(found, BACK_DIAGONAL_LOCK) : found }
    }
    return out
}

/** The clips that get foot-lock windows: the blend space's samples, the start, the stops, the running turns, the landings. */
const FOOT_LOCKED = /^((Creep|Walk|Brisk|Jog|Sprint)(F|L|R|B|BL|BR)|Start|Stop|StopMirror|RunTurn[LR]|JumpLand|JumpRunLand|LandSoft|LandHard|LandRoll)$/
/** How far the heel lifts before a foot-lock window ends, metres. */
export const FOOT_LOCK_HEEL_LIFT = 0.03
/** The backward diagonals, and the share of each detected lock window they keep (centred). */
const BACK_DIAGONAL = /^(Jog|Walk|Creep)B[LR]$/
export const BACK_DIAGONAL_LOCK = 0.5

const emptyMeasure = (): Measured => ({
    seconds: 2, travel: [0, 0], speed: 0, direction: 0, strikeL: null, strikeR: null, air: [], times: [], lowest: [], hipsY: [], hipsXZ: [],
})
