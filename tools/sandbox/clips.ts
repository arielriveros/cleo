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
//   run turn    a turn (yaw onto the Pivot, scaled to 180) whose travel is held in place;
//   car         getting into the car (its walk in and its turn onto the Pivot, as root motion: the capsule is carried
//               from the door into the seat), driving (a seated loop, in place) and getting out (root motion again,
//               seat to door), each set so the next starts in the pose the last one ends in (`carClips`);
//   stairs      a stair climb or descent, in place on the ground already, its RISE taken out of the hips (the
//               capsule climbs the ramp over the flight) and the hips set so the planted feet stand at sole height
//               on average; its foot-lock windows found against each stance's own height. Checked first: a clip
//               whose feet do not step a riser each step, or whose last frame does not match its first, is left
//               out with a warning (`stairCheck`), and the flight plays the walk blend instead.
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
import { detectFootLockWindows, shrinkFootLockSpans, type FootLockWindows } from '../../src/animation/footLockWindows'
import { boneOf, clipSeconds, hipsYaw, measure, poser, thighHeading, travelAcceleration, type Measured } from './measure'
import { rotateByYaw, yawPoseInvert, yawPoseMul, type YawPose } from '../../src/core/math'
import { repairDescent, type DescentRepair } from './descent'
import { alignKnees, kneeSpacing } from './legs'

export type ClipKind = 'loop' | 'locomotion' | 'turn' | 'air' | 'oneShot' | 'stop' | 'start' | 'runTurn' | 'stairs' | 'car'

export interface ClipRole {
    /** The clip's name in the project (what states and blend-space samples name). */
    name: string
    /** File stem in build/LocomotionPack (or build/car, for the car's clips). */
    file: string
    kind: ClipKind
    /** A turn: the angle it must turn by (positive = left), within 15 degrees. */
    turn?: number
    /** Stairs: +1 a climb, -1 a descent. */
    climb?: 1 | -1
    /** Stairs: a descent whose feet do not step down may have its legs rebuilt (descent.ts) rather than be left out. */
    repair?: boolean
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
    // Stairs, walking and running, up and down: each played on the flight its direction climbs (machine.ts).
    { name: 'StairsUpWalk', file: 'Ascending Stairs', kind: 'stairs', climb: 1, optional: true },
    { name: 'StairsUpRun', file: 'Running Ascending Stairs', kind: 'stairs', climb: 1, optional: true },
    // The pack's descents keep their feet on the floor while the hips sink: their legs are rebuilt (descent.ts).
    { name: 'StairsDownWalk', file: 'Descending Stairs', kind: 'stairs', climb: -1, optional: true, repair: true },
    { name: 'StairsDownRun', file: 'Running Descending Stairs', kind: 'stairs', climb: -1, optional: true, repair: true },
    // The car (build/car): getting in, driving, getting out. Conditioned together (carClips).
    { name: 'CarEnter', file: 'Entering Car', kind: 'car' },
    { name: 'CarDrive', file: 'Driving', kind: 'car' },
    { name: 'CarExit', file: 'Exiting Car', kind: 'car' },
]

/** What a stair clip was measured to be (`stairCheck`), on the clip as it plays. */
export interface StairStats {
    /** Steps a second: one foot onto the next tread each step. */
    stepsPerSecond: number
    /** Its riser: how far each step rises (or falls), m. */
    rise: number
    /** Ground a planted foot covers under the body per step, m: its stride as authored. */
    step: number
}

/** A creep up or down the stairs: the walk at this share of its pace (it clears the machine's "moving" gate). */
export const STAIR_CREEP = 0.6
/**
 * How far each stair clip's knees are turned toward straight ahead (about the hip-ankle line, the feet left where
 * they are): the pack's walking climb splays them (23 cm apart over hips 16 cm apart, the flat walk 18).
 */
export const STAIR_KNEE_IN = 0.75
/** How much higher than sole height the stair clips' planted feet stand on average: IK can only lower the pelvis. */
const STAIR_HIPS_MARGIN = 0.02
/** The least a stair clip must step up (or down) each step, m, and how closely its ends must match. */
const STAIR_MIN_RISE = 0.1, STAIR_LOOP_TOLERANCE = 0.06

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
    /** Stairs: the clip's steps (see `stairCheck`). */
    stairs?: StairStats
    /** Stairs: its legs were rebuilt (descent.ts). */
    repaired?: boolean
    /** The car's clips: see `CarMotion`. */
    car?: CarMotion
}

/** Where a car clip leaves the Character, as upright poses (`[x, y, z, yaw]`, the clip's frame: it starts facing +Z). */
export interface CarMotion {
    /**
     * The hips, seated, in the Character's frame (the Pivot at rest): where the seat must put them. Getting in ends
     * in it; driving and getting out start in it.
     */
    seated: YawPose
    /** The root motion the clip carries the Character by, from its start to its end (none while driving). */
    motion: YawPose
}

/** What the build decides that the clips cannot measure. */
export interface ClipOptions {
    /** The sprint's speed, m/s: what the start accelerates to (the sprint clip plays faster to match it). */
    sprint: number
    /** The ankle's height over the sole at rest, m: where a planted foot's ankle stands over its ground. */
    footHeight: number
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

/** A stair clip as `stairCheck` reads it: usable or not (and why), its windows, its steps. */
export interface StairReading {
    ok: boolean
    reason?: string
    /** Foot-lock windows, against each stance's own height (`ground: 'stance'`), seconds. */
    windows: FootLockWindows
    /** Every stance in time order: its foot, when it starts (s) and the ankle's height in it (m). */
    stances: { foot: string; t: number; y: number }[]
    /** The hips' rise over the clip (negative going down), m. */
    hipsRise: number
    stats: StairStats
}

/**
 * Read a stair clip with its rise kept (the source as prepare.mjs leaves it): its stances against their own
 * heights, and whether it really climbs (or descends) a riser each step and loops. A clip that keeps its feet on
 * one level while its hips sink, or whose last frame is not its first, is not one: it would fold the legs over
 * every cycle and snap them straight at the loop.
 */
export function stairCheck(skin: Skin, clip: Animation, climb: 1 | -1): StairReading {
    const T = clipSeconds(clip)
    const windows = detectFootLockWindows(clip, skin, { heelLift: FOOT_LOCK_HEEL_LIFT, ground: 'stance' })
    const pose = poser(skin, clip)
    const hips = boneOf(skin, 'Hips')
    const ankle: Record<string, number> = { 'foot.L': boneOf(skin, 'LeftFoot'), 'foot.R': boneOf(skin, 'RightFoot') }
    const toe: Record<string, number> = { 'foot.L': boneOf(skin, 'LeftToeBase'), 'foot.R': boneOf(skin, 'RightToeBase') }
    const stances: { foot: string; t: number; y: number }[] = []
    for (const [foot, spans] of Object.entries(windows)) {
        if (ankle[foot] === undefined) continue
        for (const [a, b] of spans) stances.push({ foot, t: a, y: pose((a + b) / 2).at(ankle[foot])[1] })
    }
    stances.sort((x, y) => x.t - y.t)
    const hipsRise = pose(T).at(hips)[1] - pose(0).at(hips)[1]
    // One step: the next foot down, onto the next tread.
    const steps: number[] = []
    for (let k = 1; k < stances.length; k++) if (stances[k].foot !== stances[k - 1].foot) steps.push(stances[k].y - stances[k - 1].y)
    const rise = steps.length ? steps.reduce((sum, d) => sum + Math.abs(d), 0) / steps.length : 0
    const perCycle = rise > 0 ? Math.max(1, Math.round(Math.abs(hipsRise) / rise)) : 2
    // The ground a planted foot covers under the body: its ball's travel over its windows, per step.
    let travel = 0, time = 0
    for (const [foot, spans] of Object.entries(windows)) for (const [a, b] of spans) {
        if (toe[foot] === undefined || b - a < 0.05) continue
        const p = pose(a).at(toe[foot]), q = pose(b).at(toe[foot])
        travel += Math.hypot(q[0] - p[0], q[2] - p[2]); time += b - a
    }
    const stats: StairStats = { stepsPerSecond: perCycle / T, rise, step: time > 0 ? travel / time * T / perCycle : 0 }
    const reading = { windows, stances, hipsRise, stats }
    const fail = (reason: string): StairReading => ({ ok: false, reason, ...reading })
    const dir = climb > 0 ? 'up' : 'down'
    if (stances.length < 2 || !steps.length) return fail(`its feet plant ${stances.length} time(s): no step ${dir} to read`)
    const wrong = steps.find(d => d * climb < STAIR_MIN_RISE)
    if (wrong !== undefined) {
        const heights = stances.map(x => (x.y * 100).toFixed(0)).join(', ')
        return fail(`its feet do not step ${dir} a riser each step (a step of ${(wrong * 100).toFixed(0)} cm; the feet plant at ${heights} cm)`)
    }
    if (hipsRise * climb < STAIR_MIN_RISE) return fail(`its hips ${hipsRise > 0 ? 'rise' : 'fall'} ${(Math.abs(hipsRise) * 100).toFixed(0)} cm over the clip`)
    // The loop: each leg as long at the end as at the start (the rise does not change that).
    const reach = (t: number, foot: string) => {
        const p = pose(t), h = p.at(hips), f = p.at(ankle[foot])
        return Math.hypot(h[0] - f[0], h[1] - f[1], h[2] - f[2])
    }
    for (const foot of Object.keys(ankle)) {
        const d = Math.abs(reach(T, foot) - reach(0, foot))
        if (d > STAIR_LOOP_TOLERANCE) return fail(`its last frame does not match its first (the ${foot === 'foot.L' ? 'left' : 'right'} leg ${(d * 100).toFixed(0)} cm off)`)
    }
    return { ok: true, ...reading }
}

/**
 * A stair clip in place: the hips' rise over the clip taken out of them linearly (the step-to-step bob stays: the
 * capsule climbs the ramp at an even pace), any ground travel too, and the whole pose raised or lowered so the
 * planted ankles stand at `footHeight` over the capsule's ground on average, a touch high (foot IK lowers the
 * pelvis for a foot that must reach down, but cannot raise it).
 */
function stairInPlace(skin: Skin, clip: Animation, reading: StairReading, footHeight: number): Animation {
    const out = plain(clip)
    const hips = boneOf(skin, 'Hips')
    const ch = out.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
    if (!ch) return out
    const s = out.samplers[ch.samplerIndex]
    const o = s.output as number[]
    const T = clipSeconds(clip)
    const n = s.input.length - 1
    const dx = o[n * 3] - o[0], dz = o[n * 3 + 2] - o[2]
    for (let k = 0; k <= n; k++) {
        const f = s.input[k] / T
        o[k * 3] -= dx * f
        o[k * 3 + 1] -= reading.hipsRise * f
        o[k * 3 + 2] -= dz * f
    }
    // Where the planted ankles stand now, on average over every window.
    const pose = poser(skin, out)
    const ankle: Record<string, number> = { 'foot.L': boneOf(skin, 'LeftFoot'), 'foot.R': boneOf(skin, 'RightFoot') }
    let sum = 0, count = 0
    for (const [foot, spans] of Object.entries(reading.windows)) for (const [a, b] of spans) {
        if (ankle[foot] === undefined) continue
        for (let t = a; t <= b; t += 1 / 60) { sum += pose(t).at(ankle[foot])[1]; count++ }
    }
    const shift = count ? footHeight + STAIR_HIPS_MARGIN - sum / count : 0
    for (let k = 0; k <= n; k++) o[k * 3 + 1] += shift
    return out
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
export function makeClips(skin: Skin, raw: Map<string, Animation>, warn: (s: string) => void, options: ClipOptions,
    note: (s: string) => void = () => {}): Map<string, MadeClip> {
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
        if (role.kind === 'car') continue   // after the loop: the three are conditioned together
        const source = raw.get(role.file)
        if (!source) {
            if (role.optional) { warn(`no ${role.file}.fbx in build/LocomotionPack: ${role.name} falls back`); continue }
            throw new Error(`build/LocomotionPack has no ${role.file}.fbx (the ${role.name} clip)`)
        }
        const m = measure(skin, source)
        if (role.kind === 'start') continue   // after the loop: it needs the Character's acceleration
        if (role.kind === 'stairs') {
            // Read with its rise kept: its stances stand at their own heights only there.
            let stairSource = source
            let reading = stairCheck(skin, source, role.climb!)
            let repaired: DescentRepair | null = null
            if (!reading.ok && role.repair) {
                // A descent whose feet never step down: its legs rebuilt, the rest of it kept.
                repaired = repairDescent(skin, source)
                if (repaired) {
                    const again = stairCheck(skin, repaired.clip, role.climb!)
                    note(`${role.file}.fbx: ${reading.reason}; its legs are rebuilt (descent.ts: plants at ${(repaired.plant * 100).toFixed(0)}% and ${((repaired.plant + 0.5) * 100).toFixed(0)}%, `
                        + `a ${(repaired.riser * 100).toFixed(0)} cm riser, a ${(repaired.stride * 100).toFixed(0)} cm stride)${again.ok ? '' : `, and still fails: ${again.reason}`}`)
                    if (again.ok) { stairSource = repaired.clip; reading = again }
                }
            }
            if (!reading.ok) { warn(`${role.file}.fbx is left out: ${reading.reason}. Its flights play the walk blend instead.`); continue }
            // Its knees turned in toward straight ahead: the feet, and so its windows, stay where they were.
            const before = kneeSpacing(skin, stairSource)
            stairSource = alignKnees(skin, stairSource, STAIR_KNEE_IN)
            note(`${role.name}: knees ${(before * 100).toFixed(1)} cm apart on average, ${(kneeSpacing(skin, stairSource) * 100).toFixed(1)} once turned in`)
            const clip = { ...named(stairInPlace(skin, stairSource, reading, options.footHeight), role.name), footLocks: reading.windows }
            add(clip, role, { m, stairs: reading.stats, ...(repaired ? { repaired: true } : {}) })
            // The creep: the walk at STAIR_CREEP of its pace, its windows stretched with it.
            if (role.name.endsWith('Walk')) {
                const slow = 1 / STAIR_CREEP
                const footLocks: FootLockWindows = {}
                for (const [k, spans] of Object.entries(reading.windows)) footLocks[k] = spans.map(([a, b]) => [a * slow, b * slow])
                const creep = { ...named(timeScaleClip(clip, slow), role.name.replace(/Walk$/, 'Creep')), footLocks }
                add(creep, null, { m: { ...m, seconds: m.seconds * slow }, stairs: { ...reading.stats, stepsPerSecond: reading.stats.stepsPerSecond * STAIR_CREEP } })
            }
            continue
        }
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

    // The car: in, driving, out.
    for (const made of carClips(skin, raw, note)) add(made.clip, made.role, made)

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

// =====================================================================================================
// The car
// =====================================================================================================

/** The clip with its Pivot channels taken off: posed with the Pivot at rest, as the root-motion pin shows it. */
function withoutPivot(skin: Skin, clip: Animation): Animation {
    const pivot = boneOf(skin, 'Pivot')
    const out = plain(clip)
    out.channels = out.channels.filter(c => c.targetNodeIndex !== pivot)
    return out
}

/** Where the hips are at `t`, and which way the body faces (the line through the thighs), the Pivot at rest. */
function restPose(skin: Skin, clip: Animation, t: number): YawPose {
    const at = withoutPivot(skin, clip)
    const p = poser(skin, at)(t).at(boneOf(skin, 'Hips'))
    return [p[0], p[1], p[2], thighHeading(skin, at, [t])[0]]
}

/** The Pivot must be where the skin's root is, unturned: the clips below are written in its frame. */
function assertPivotAtRest(skin: Skin): void {
    const pivot = boneOf(skin, 'Pivot')
    const parents = skin.nodeParents as Map<number, number>
    const local = skin.nodeTransforms as Map<number, mat4>
    let m = mat4.create()
    for (let i: number | undefined = pivot; i !== undefined; i = parents.get(i) === i ? undefined : parents.get(i))
        m = mat4.multiply(mat4.create(), local.get(i) ?? mat4.create(), m)
    for (let k = 0; k < 16; k++) if (Math.abs(m[k] - (k % 5 === 0 ? 1 : 0)) > 1e-5)
        throw new Error('the Pivot joint is not at the origin, unturned: the car clips assume it is')
}

/** Every hips key moved and turned by the upright pose `g` (in the Pivot's frame): the whole clip placed elsewhere. */
function placed(skin: Skin, clip: Animation, g: YawPose): Animation {
    const out = plain(clip)
    const hips = boneOf(skin, 'Hips')
    const turn = quat.setAxisAngle(quat.create(), [0, 1, 0], g[3] * Math.PI / 180)
    for (const ch of out.channels) {
        if (ch.targetNodeIndex !== hips) continue
        const o = out.samplers[ch.samplerIndex].output as number[]
        if (ch.targetPath === 'translation') for (let k = 0; k < o.length; k += 3) {
            const [x, y, z] = rotateByYaw(o[k], o[k + 1], o[k + 2], g[3])
            o[k] = x + g[0]; o[k + 1] = y + g[1]; o[k + 2] = z + g[2]
        } else if (ch.targetPath === 'rotation') for (let k = 0; k < o.length; k += 4) {
            const q = quat.normalize(quat.create(), quat.multiply(quat.create(), turn, o.slice(k, k + 4) as any))
            for (let c = 0; c < 4; c++) o[k + c] = q[c]
        }
    }
    return out
}

/**
 * A clip that walks AND turns (into the car, out of it), as root motion: the hips' ground travel AND their yaw moved
 * onto the Pivot (travelToPivot does the one, splitTurn the other), so the capsule is carried along the path and
 * turned with it, and the hips keep their height, bend and tilt over a Character that faces where the body faces.
 * Returns the root motion it carries, start to end, in its starting frame.
 */
function travelAndTurnToPivot(skin: Skin, clip: Animation): { clip: Animation; motion: YawPose } {
    const hips = boneOf(skin, 'Hips'), pivot = boneOf(skin, 'Pivot')
    const out = plain(clip)
    const tCh = out.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
    const rCh = out.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'rotation')
    if (!tCh || !rCh) throw new Error(`${clip.name} does not move and turn the hips`)
    const { times, yaw } = hipsYaw(skin, clip)
    const yawAt = (t: number) => {
        let i = 0
        while (i < times.length - 2 && times[i + 1] < t) i++
        const span = times[i + 1] - times[i]
        const f = span > 0 ? Math.min(1, Math.max(0, (t - times[i]) / span)) : 0
        return yaw[i] + (yaw[i + 1] - yaw[i]) * f
    }
    // The travel onto the Pivot (in the clip's frame); the hips held over its start, turned back by the yaw.
    const ts = out.samplers[tCh.samplerIndex], to = ts.output as number[]
    const [x0, , z0] = [to[0], to[1], to[2]]
    const pivotT: number[] = []
    for (let k = 0; k < ts.input.length; k++) {
        pivotT.push(to[k * 3] - x0, 0, to[k * 3 + 2] - z0)
        const [x, y, z] = rotateByYaw(x0, to[k * 3 + 1], z0, -yawAt(ts.input[k]))
        to[k * 3] = x; to[k * 3 + 1] = y; to[k * 3 + 2] = z
    }
    const rs = out.samplers[rCh.samplerIndex], ro = rs.output as number[]
    for (let k = 0; k < rs.input.length; k++) {
        const inv = quat.setAxisAngle(quat.create(), [0, 1, 0], -yawAt(rs.input[k]) * Math.PI / 180)
        const q = quat.normalize(quat.create(), quat.multiply(quat.create(), inv, ro.slice(k * 4, k * 4 + 4) as any))
        for (let c = 0; c < 4; c++) ro[k * 4 + c] = q[c]
    }
    const pivotR: number[] = []
    for (const t of times) pivotR.push(...quat.setAxisAngle(quat.create(), [0, 1, 0], yawAt(t) * Math.PI / 180))
    out.samplers.push({ input: Array.from(ts.input), output: pivotT, interpolation: 'LINEAR' } as any)
    out.channels.push({ samplerIndex: out.samplers.length - 1, targetNodeIndex: pivot, targetPath: 'translation' })
    out.samplers.push({ input: times.slice(), output: pivotR, interpolation: 'LINEAR' } as any)
    out.channels.push({ samplerIndex: out.samplers.length - 1, targetNodeIndex: pivot, targetPath: 'rotation' })
    out.rootMotion = true
    const n = ts.input.length - 1
    return { clip: out, motion: [pivotT[n * 3], 0, pivotT[n * 3 + 2], yaw[yaw.length - 1]] }
}

/**
 * The car's three clips, made to chain. Getting in walks into the seat and turns to face ahead, as root motion; where
 * its hips end, in the Character's frame, is the SEATED pose (the car's Seat is placed so the hips land on its
 * cushion). Driving and getting out are each placed so their first frame is that pose: the Character sits still on
 * the Seat from the end of getting in to the start of getting out, and the hand-overs blend poses, not places (the
 * Mixamo driving loop sits 22 cm lower than the end of getting in, its hands 10 cm apart). Driving is held in place.
 */
export function carClips(skin: Skin, raw: Map<string, Animation>, note: (s: string) => void = () => {}): MadeClip[] {
    const role = (name: string) => ROLES.find(r => r.name === name)!
    const source = (name: string) => {
        const r = role(name), clip = raw.get(r.file)
        if (!clip) throw new Error(`no ${r.file}.fbx in build/car (the ${name} clip): run prepare.mjs`)
        return named(clip, name)
    }
    assertPivotAtRest(skin)
    const enterSource = source('CarEnter'), driveSource = source('CarDrive'), exitSource = source('CarExit')

    const enter = travelAndTurnToPivot(skin, enterSource)
    const seated = restPose(skin, enter.clip, clipSeconds(enter.clip))

    const exitStart = restPose(skin, exitSource, 0)
    const exit = travelAndTurnToPivot(skin, placed(skin, exitSource, yawPoseMul(seated, yawPoseInvert(exitStart))))
    const driveStart = restPose(skin, driveSource, 0)
    const drive = holdInPlace(skin, placed(skin, driveSource, yawPoseMul(seated, yawPoseInvert(driveStart))))

    // Each hand-over starts where the last one ended: checked, not assumed.
    const gap = (a: YawPose, b: YawPose) => ({ m: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), deg: Math.abs(((a[3] - b[3] + 540) % 360) - 180) })
    for (const [name, clip] of [['CarDrive', drive], ['CarExit', exit.clip]] as const) {
        const g = gap(restPose(skin, clip, 0), seated)
        if (g.m > 0.01 || g.deg > 1) throw new Error(`${name} does not start seated: ${(g.m * 100).toFixed(1)} cm, ${g.deg.toFixed(1)} deg off`)
    }
    const fmt = (p: YawPose) => `(${p.slice(0, 3).map(v => v.toFixed(3)).join(', ')}) at ${p[3].toFixed(1)} deg`
    note(`car: seated hips ${fmt(seated)}; getting in carries the Character by ${fmt(enter.motion)} over ${clipSeconds(enter.clip).toFixed(2)} s, `
        + `getting out by ${fmt(exit.motion)} over ${clipSeconds(exit.clip).toFixed(2)} s; driving placed ${((seated[1] - driveStart[1]) * 100).toFixed(1)} cm higher`)

    const m = (clip: Animation) => measure(skin, clip)
    return [
        { clip: enter.clip, role: role('CarEnter'), m: m(enterSource), car: { seated, motion: enter.motion } },
        { clip: drive, role: role('CarDrive'), m: m(driveSource), car: { seated, motion: [0, 0, 0, 0] } },
        { clip: exit.clip, role: role('CarExit'), m: m(exitSource), car: { seated, motion: exit.motion } },
    ]
}
