// The POSES the Sandbox's weapon layers hold, built from the stances (poses.ts); build.ts writes them as one Pose
// asset per weapon and machine.ts plays them. A developer edits them in the editor, and everything follows:
//
//   Carry, Aim, Sprint         the stances: the spine and head turned, both arms (and the fingers) on the weapon, and
//                              the Hips as the standing reference has them (what a Steady layer measures its chest
//                              by). Held by the weapon's override layer at Steady (`AnimationState.meshSpace`): the
//                              chest keeps the pose's turn over every gait and flight, so one pose is the whole hold
//   Aim <yaw> <pitch>          the aim's directions, VARIANTS of Aim: each stores only what it changes from Aim (the
//                              upper spine, the head, the arms), so editing Aim moves every direction with it. The
//                              additive aim layer's blend space adds what each changes from Aim over the hold
//
// The support hand is kept on the weapon at runtime by the layers' hand IK (`AnimationLayer.handIk`), not by these.

import { quat, vec3 } from 'gl-matrix'
import type { Animation, Skin } from '../../../src/animation/animatedModel'
import type { AnimationPoseBone } from '../../../src/animation/animationPose'
import { clipSeconds } from '../measure'
import { readWeapon, mm, type WeaponKind, type WeaponModel } from './models'
import {
    Body, aimBones, aimPose, clipPose, grips, invert, meanRotation, packHold, solveStance, stanceSpecs, weaponLayerBones,
    type Grip, type Pose,
} from './poses'

/** The weapons' names, as their assets and layers have them. */
export const WEAPON_NAMES: Record<WeaponKind, 'Pistol' | 'Rifle'> = { pistol: 'Pistol', rifle: 'Rifle' }
/** Each weapon's grip socket on the right hand (its frame is the weapon's: models.ts). */
export const WEAPON_SOCKETS: Record<WeaponKind, string> = { pistol: 'Pistol Grip', rifle: 'Rifle Grip' }

/** The aim's directions: yaw left +, pitch down +, degrees. */
export const AIM_YAWS = [-90, -45, 0, 45, 90]
export const AIM_PITCHES = [-60, -30, 0, 30, 60]
/** The share of the aim's yaw and pitch the chest takes (the arms and head the rest). */
const AIM_CHEST: Record<WeaponKind, { yaw: number; pitch: number }> = { rifle: { yaw: 0.8, pitch: 0.4 }, pistol: { yaw: 0.8, pitch: 0.3 } }

/** An aim direction's pose name: `Aim Left 45 Up 30`, `Aim Centre`. */
export function aimVariantName(yaw: number, pitch: number): string {
    const parts = [yaw > 0 ? `Left ${yaw}` : yaw < 0 ? `Right ${-yaw}` : '', pitch < 0 ? `Up ${-pitch}` : pitch > 0 ? `Down ${pitch}` : ''].filter(Boolean)
    return `Aim ${parts.length ? parts.join(' ') : 'Centre'}`
}

/** A weapon's poses: the three stances (bones as deltas from rest) and the aim's directions (bones relative to Aim). */
export interface WeaponPoseSet {
    carry: AnimationPoseBone[]
    aim: AnimationPoseBone[]
    sprint: AnimationPoseBone[]
    aims: { yaw: number; pitch: number; bones: AnimationPoseBone[] }[]
}

export interface WeaponBuild {
    models: Record<WeaponKind, WeaponModel>
    /** The grip sockets, for the rig and the skin: on the right hand, offset to the weapon's frame. */
    sockets: { name: string; bone: string; offset: { t: number[]; r: number[] } }[]
    poses: Record<WeaponKind, WeaponPoseSet>
    /** Each layer's bones (full names): Pistol, Pistol Support, Rifle, and the aim layers'. */
    masks: { pistol: string[]; support: string[]; rifle: string[]; aim: string[] }
    /** The muzzle and the grip's point on each weapon (weapon space), for the scene and the tests. */
    report: string[]
}

/**
 * Every weapon pose. `base` is the base layer's clips by name; `idle` its standing clip (the stances are solved over
 * its mean pose); `pack` the rifle pack's poses by stem (`Rifle idle`, `Rifle idle aiming`, `Rifle sprint forward`).
 */
export function weaponPoses(skin: Skin, base: Map<string, Animation>, idle: string, pack: Map<string, Animation>, root: string): WeaponBuild {
    const body = new Body(skin)
    const report: string[] = []
    const models = { pistol: readWeapon(root, 'pistol'), rifle: readWeapon(root, 'rifle') }
    for (const m of Object.values(models))
        report.push(`${m.name} (${m.file}): ${((m.max[2] - m.min[2]) * 100).toFixed(1)} cm long; grip axis ${(Math.atan2(m.gripAxis[2], m.gripAxis[1]) * 180 / Math.PI).toFixed(0)} degrees off upright; support ${mm(m.support)}; muzzle ${mm(m.muzzle)}; butt ${mm(m.butt)}; sights ${mm(m.sight)}`)
    const need = (name: string) => { const c = pack.get(name); if (!c) throw new Error(`no ${name} clip: run tools/sandbox/prepare.mjs (it reads the rifle pack's holds)`); return c }
    const aimPack = need('Rifle idle aiming'), sprintPack = need('Rifle sprint forward'), idlePack = need('Rifle idle')
    const grip = grips(body, clipPose(body, aimPack, clipSeconds(aimPack) / 2), models.rifle, models.pistol)
    const reference = meanPose(body, base.get(idle)!)

    const sockets: WeaponBuild['sockets'] = []
    const poses = {} as Record<WeaponKind, WeaponPoseSet>
    const fullName = (b: string) => body.names.get(body.bone(b))!
    for (const kind of ['pistol', 'rifle'] as const) {
        const model = models[kind], g = grip[kind]
        const specs = stanceSpecs(kind)
        if (specs.sprint.hold.kind === 'frame') specs.sprint.hold.inChest = packHold(body, sprintPack, g)
        if (specs.carry.hold.kind === 'frame') specs.carry.hold.inChest = packHold(body, idlePack, g)
        const stances = {
            carry: solveStance(body, reference, model, g, specs.carry),
            aim: solveStance(body, reference, model, g, specs.aim),
            sprint: solveStance(body, reference, model, g, specs.sprint),
        }
        for (const [k, s] of Object.entries(stances)) report.push(`${model.name} ${k}: ${s.report}`)
        const socket = invert(g.right)
        sockets.push({ name: WEAPON_SOCKETS[kind], bone: fullName('RightHand'), offset: { t: Array.from(socket.P, v => r6(v)), r: Array.from(quat.normalize(quat.create(), socket.R), v => r6(v)) } })

        // The aim's directions, as what each changes from the aim.
        let worstMiss = 0
        const aims: WeaponPoseSet['aims'] = []
        for (const yaw of AIM_YAWS) for (const pitch of AIM_PITCHES) {
            const { locals, miss } = aimPose(body, reference, model, g, stances.aim, yaw, pitch, AIM_CHEST[kind])
            worstMiss = Math.max(worstMiss, miss)
            aims.push({ yaw, pitch, bones: relativeBones(body, locals, stances.aim.locals) })
        }
        report.push(`${model.name} aim directions: ${aims.length}, the bore within ${worstMiss.toFixed(2)} degrees of each aim`)
        poses[kind] = {
            carry: stanceBones(body, reference, stances.carry.locals),
            aim: stanceBones(body, reference, stances.aim.locals),
            sprint: stanceBones(body, reference, stances.sprint.locals),
            aims,
        }
    }
    const names = (bones: string[]) => bones.map(fullName)
    const pistolBones = weaponLayerBones(body, 'pistol'), rifleBones = weaponLayerBones(body, 'rifle')
    return {
        models, sockets, poses, report,
        masks: { pistol: names(pistolBones.main), support: names(pistolBones.support), rifle: names(rifleBones.main), aim: names(aimBones()) },
    }
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6

/** A rotation as a pose stores it: rounded, w >= 0. */
function stored(q: quat): number[] {
    quat.normalize(q, q)
    if (q[3] < 0) quat.scale(q, q, -1)
    return Array.from(q, r6)
}

/**
 * A stance as a pose: every bone it holds (spine, head, arms, fingers) and the standing reference's Hips, each as its
 * delta from rest in the parent frame (`local = delta x rest`, the editor's pose convention).
 */
function stanceBones(body: Body, reference: Pose, locals: Map<string, quat>): AnimationPoseBone[] {
    const delta = (node: number, local: quat): AnimationPoseBone => ({
        name: body.names.get(node)!,
        rotation: stored(quat.multiply(quat.create(), local, quat.invert(quat.create(), body.restR.get(node)!))),
    })
    const hips = body.bone('Hips')
    return [delta(hips, reference.R.get(hips)!), ...[...locals].map(([b, q]) => delta(body.bone(b), q))]
}

/** What a direction changes from the aim, per bone it moves (`rel = local x inv(aim's local)`; a bone it leaves, none). */
function relativeBones(body: Body, locals: Map<string, quat>, base: Map<string, quat>): AnimationPoseBone[] {
    const out: AnimationPoseBone[] = []
    for (const [b, q] of locals) {
        const rel = quat.multiply(quat.create(), q, quat.invert(quat.create(), base.get(b)!))
        if (Math.hypot(rel[0], rel[1], rel[2]) < 1e-6) continue
        out.push({ name: body.names.get(body.bone(b))!, rotation: stored(rel) })
    }
    return out
}

/** The mean of a clip's pose over its length (rotations sign-aligned): a standing reference. */
export function meanPose(body: Body, clip: Animation): Pose {
    const T = clipSeconds(clip), n = 30
    const poses = Array.from({ length: n }, (_, k) => clipPose(body, clip, T * k / n))
    const out = poses[0]
    for (const i of body.order) {
        out.R.set(i, meanRotation(poses.map(p => p.R.get(i)!)))
        const t = vec3.create()
        for (const p of poses) vec3.add(t, t, p.T.get(i)!)
        out.T.set(i, vec3.scale(t, t, 1 / n))
    }
    return out
}

export type { Grip }
