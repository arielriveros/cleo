// A stair descent rebuilt from a clip whose feet never step down.
//
// The Locomotion Pack's two descending clips (*Descending Stairs*, *Running Descending Stairs*) keep both feet at
// floor height the whole time while their hips sink two risers over the cycle: the knees fold from about 130 to 40
// degrees, and the last frame is not the first (a foot in the air at the start, on the floor at the end). Played,
// the legs fold over every cycle and snap straight at every loop. What they get right is the rest: the hips'
// lowering, step by step, and the trunk, arms and head of a body going down stairs, and the timing of the steps.
//
// So the legs are rebuilt and the rest is kept:
//
//   - the trunk, arms and head (every channel but the legs) are made to loop: each track's drift from its first
//     frame to its last is spread over the clip, so its last frame is its first;
//   - each foot steps down two risers each cycle (the feet alternate, one riser apart), the riser half of what the
//     hips sink: planted, it stands still on its tread (moving back under the body at the clip's own stance speed,
//     the clip being in place on the ground); swinging, it travels forward to its next plant, high over the nose of
//     the tread it leaves, then down to the one two below, its toe pointing down on the way;
//   - the plants are the clip's own (the left foot's landing, the right half a cycle later), and so are the stance's
//     length (to the foot's most backward point) and its stride (where it lands and where it leaves);
//   - two-bone IK sets the thigh and the shin to reach each ankle, the knee bending forward; the foot is flat on its
//     tread through the stance (as the clip's stance foot is on the floor) and turns toe-down through the swing.
//
// The result keeps its rise (as the source did), so the stair pipeline (clips.ts stairCheck, stairInPlace) takes it
// like any climb.

import { mat4, quat, vec3 } from 'gl-matrix'
import type { Animation, Skin } from '../../src/animation/animatedModel'
import { solveTwoBone } from '../../src/animation/ik'
import { boneOf, clipSeconds, poser } from './measure'
import { localOf, push, rotationOf, withRotationTracks } from './legs'

/** Samples per second of the rebuilt leg tracks. */
const FPS = 60
/** How high the swinging ankle clears the tread it leaves, m. */
const CLEARANCE = 0.07
/**
 * The longest a foot stays planted, as a share of the cycle. The clip's own stances run to the foot's most backward
 * point, by which time its hips have sunk so far that the trailing knee folds right up; a foot coming down stairs
 * leaves its tread sooner.
 */
const MAX_DUTY = 0.62
/** How far the toe points down mid-swing, degrees. */
const TOE_DOWN = 18

/** What `repairDescent` read off the clip, for the build's report. */
export interface DescentRepair {
    clip: Animation
    /** Seconds of the cycle; the left foot's plant and lift, as shares of it; the riser and stride, m. */
    seconds: number
    plant: number
    lift: number
    riser: number
    stride: number
}

const smooth = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x) }

/**
 * Rebuild the legs of a stair descent (see the header), or null when the clip does not read as one: its hips do not
 * sink, or its left foot never comes down and leaves again.
 */
export function repairDescent(skin: Skin, source: Animation): DescentRepair | null {
    const T = clipSeconds(source)
    if (!(T > 0)) return null
    const legs = ['Left', 'Right'].map(side => ({
        side, thigh: boneOf(skin, `${side}UpLeg`), shin: boneOf(skin, `${side}Leg`), foot: boneOf(skin, `${side}Foot`),
    }))
    const legNodes = new Set(legs.flatMap(l => [l.thigh, l.shin, l.foot]))
    const hips = boneOf(skin, 'Hips')

    // The trunk, arms and head, looped: each rotation's drift over the clip spread across it.
    const looped = loopTracks(source, T, legNodes)
    const pose = poser(skin, looped)

    const n = Math.max(2, Math.round(T * FPS))
    const times = Array.from({ length: n + 1 }, (_, k) => T * k / n)
    const frames = times.map(t => pose(t))
    const hipsRise = frames[n].at(hips)[1] - frames[0].at(hips)[1]
    if (!(hipsRise < -0.1)) return null
    // Two steps a cycle, one riser each: half the hips' fall.
    const riser = -hipsRise / 2

    // The left foot's stance in the clip: its landing (coming down to its lowest), and its lift (its most backward
    // point after that, where it starts forward again).
    const left = legs[0]
    const ankleY = frames.map(f => f.at(left.foot)[1]), ankleZ = frames.map(f => f.at(left.foot)[2])
    const low = Math.min(...ankleY)
    let plantK = -1
    for (let k = 1; k <= n; k++) if (ankleY[k - 1] > low + 0.02 && ankleY[k] <= low + 0.02) { plantK = k; break }
    if (plantK < 0) return null
    let liftK = plantK
    for (let k = plantK; k <= n; k++) if (ankleY[k] <= low + 0.03 && ankleZ[k] < ankleZ[liftK]) liftK = k
    const plant = times[plantK] / T, measured = (times[liftK] - times[plantK]) / T
    if (!(measured > 0.3 && measured < 0.9)) return null
    const duty = Math.min(MAX_DUTY, measured)
    // The lift where the shortened stance ends (the clip's foot is still planted there, behind the hips).
    liftK = Math.min(liftK, plantK + Math.round(duty * n))
    // Where a foot lands and leaves, ahead of and behind the hips (the left foot's), and how far out it stands.
    const zPlant = ankleZ[plantK] - frames[plantK].at(hips)[2], zLift = ankleZ[liftK] - frames[liftK].at(hips)[2]
    const footX = legs.map(l => {
        let sum = 0
        for (let k = plantK; k <= liftK; k++) sum += frames[k].at(l.foot)[0]
        return sum / (liftK - plantK + 1)
    })
    // The flat foot of the stance, per foot: the clip's own in the middle of its stance (on the floor).
    const mid = Math.round((plantK + liftK) / 2)
    const halfK = Math.round(n / 2)
    const flat = legs.map((l, i) => rotationOf(frames[(mid + (i ? halfK : 0)) % (n + 1)].world(l.foot)))
    // The stance ankle's height: the left foot's on the floor at its landing, a riser lower each step after.
    const H0 = ankleY[plantK]

    /** A foot's ankle (model space, rise kept) and its world rotation, at `t`. */
    const footAt = (i: number, t: number, outPos: vec3, outRot: quat) => {
        // Its plants: the left foot's at `plant`, the right's half a cycle later; two risers lower each cycle.
        const p0 = (plant + i * 0.5) * T
        const m = Math.floor((t - p0) / T)
        const since = t - (p0 + m * T)
        const H = (k: number) => H0 - riser * i - 2 * riser * k
        const hz = frames[Math.round(t / T * n)]?.at(hips)[2] ?? 0
        if (since <= duty * T) {
            const f = since / (duty * T)
            vec3.set(outPos, footX[i], H(m), hz + zPlant + (zLift - zPlant) * f)
            quat.copy(outRot, flat[i])
        } else {
            const u = (since - duty * T) / ((1 - duty) * T)
            // Up off its tread at once, forward over the tread's nose, then down two risers.
            const drop = smooth((u - 0.15) / 0.85)
            const y = H(m) + (H(m + 1) - H(m)) * drop + CLEARANCE * Math.sin(Math.PI * Math.sqrt(u))
            vec3.set(outPos, footX[i], y, hz + zLift + (zPlant - zLift) * smooth(u))
            const down = quat.setAxisAngle(quat.create(), [1, 0, 0], TOE_DOWN * Math.PI / 180 * Math.sin(Math.PI * u))
            quat.multiply(outRot, down, flat[i])
        }
    }

    // The legs, solved frame by frame onto those ankles.
    const tracks = new Map<number, number[]>()
    for (const l of legs) for (const node of [l.thigh, l.shin, l.foot]) tracks.set(node, [])
    const target = vec3.create(), footRot = quat.create()
    for (let k = 0; k <= n; k++) {
        const f = frames[k]
        const hipsW = rotationOf(f.world(hips))
        legs.forEach((l, i) => {
            footAt(i, times[k], target, footRot)
            const root = f.at(l.thigh), knee = f.at(l.shin), tip = f.at(l.foot)
            // The knee forward, a little out.
            const pole = vec3.fromValues((root[0] + target[0]) / 2 + (i ? -0.1 : 0.1), (root[1] + target[1]) / 2, (root[2] + target[2]) / 2 + 0.6)
            const r = solveTwoBone({ root, mid: knee, tip, target, pole } as any)
            const thighW = quat.multiply(quat.create(), r.rootDelta, rotationOf(f.world(l.thigh)))
            const shinW = quat.multiply(quat.create(), quat.multiply(quat.create(), r.midDelta, r.rootDelta), rotationOf(f.world(l.shin)))
            push(tracks.get(l.thigh)!, localOf(hipsW, thighW))
            push(tracks.get(l.shin)!, localOf(thighW, shinW))
            push(tracks.get(l.foot)!, localOf(shinW, footRot))
        })
    }

    // Into the clip: the legs' rotation tracks replaced, everything else as looped.
    const out = withRotationTracks(looped, times, tracks)
    return { clip: out, seconds: T, plant, lift: plant + duty, riser, stride: zPlant - zLift }
}

/**
 * Every rotation track but `skip`'s made to loop: the turn from its last key back to its first, spread over the
 * clip (none of it at the start, all of it at the end), so the last frame is the first and nothing jumps.
 */
function loopTracks(clip: Animation, T: number, skip: Set<number>): Animation {
    const samplers = clip.samplers.map(s => ({ input: Array.from(s.input), output: Array.from(s.output), interpolation: s.interpolation }))
    const done = new Set<number>()
    for (const c of clip.channels) {
        if (c.targetPath !== 'rotation' || skip.has(c.targetNodeIndex) || done.has(c.samplerIndex)) continue
        done.add(c.samplerIndex)
        const s = samplers[c.samplerIndex], o = s.output, last = s.input.length - 1
        if (last < 1) continue
        const first = quat.fromValues(o[0], o[1], o[2], o[3]), end = quat.fromValues(o[last * 4], o[last * 4 + 1], o[last * 4 + 2], o[last * 4 + 3])
        const fix = quat.multiply(quat.create(), first, quat.invert(quat.create(), end))
        const q = quat.create(), part = quat.create(), id = quat.create()
        for (let k = 0; k <= last; k++) {
            quat.slerp(part, id, fix, s.input[k] / T)
            quat.multiply(q, part, quat.fromValues(o[k * 4], o[k * 4 + 1], o[k * 4 + 2], o[k * 4 + 3]))
            quat.normalize(q, q)
            o.splice(k * 4, 4, q[0], q[1], q[2], q[3])
        }
    }
    return { ...clip, samplers, channels: clip.channels.map(c => ({ ...c })) } as Animation
}
