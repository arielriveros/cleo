// How the Sandbox mannequin holds its pistol and its rifle: the stances, worked out once by IK at build time, and the
// clips the weapon layers play (see weaponClips). Pure maths over the skin, like legs.ts and descent.ts.
//
// THE GRIP. The right hand closes round the weapon's grip exactly as the rifle pack's does round its rifle's (Mixamo
// Pro Rifle Pack, `Rifle idle aiming`). There the rifle is aimed, level and upright, its grip in the right fist and its
// handguard in the left: so the rifle's frame is the one that runs its grip-to-handguard line from fist to fist, its
// top up, and the right hand's joint read in it is the hand's place on the rifle's grip; turned from the rifle's grip
// axis onto the pistol's, on the pistol's. So the weapon is fixed in the hand: one SOCKET per weapon on the right hand
// (`Rifle Grip`, `Pistol Grip`) is the weapon's grip frame, and every stance places the WEAPON and then puts the hand
// on it. The support hand closes round the rifle's handguard as the pack's left hand does round its own; on the
// pistol it wraps the grip hand (the right hand's grip, mirrored). It may roll round the weapon's bore through its
// hold, as a hand on a handguard does.
//
// The elbows go where the wrists bend least (`bestElbow`), kept down: a hand on a grip leaves its forearm one way to
// come from. Held right, the wrists bend 3 to 25 degrees, as the pack's own holds do (`--report` prints them).
//
// A STANCE is a chest and a weapon placed off the chest: the chest's turn from upright (the rifle bladed a little to
// the right), and the weapon by what holds it there (a rifle's butt in the shoulder pocket and its sight line through
// the right eye, aiming; where the rifle pack's idle and sprint hold it off the chest, carrying; a pistol pushed out
// under the eye, and that aim swung down about the shoulders, carrying). Both arms are then solved onto it by two-bone
// IK (the forearm taking most of the wrist's twist), and are constant relative to the chest: an override layer
// holding the arms rides whatever the spine beneath does.
//
// THE LAYER'S CLIPS (`<Weapon> <Carry|Aim> <sample>`). The arms are constant, but the chest is not: the weapon layer
// overrides the spine too, so that the weapon is held steady over the stride, and an override in local space means
// a spine bone's local turn over whatever the HIPS below it do. So each clip is built against one clip of the base
// layer's Locomotion (or Stairs) blend space, on that clip's own timeline: frame by frame, the spine is turned so
// the chest is the stance's, carrying the base clip's lean into its direction of travel and a share of its chest's
// sway over the stride (a jog's chest swings, the rifle at the shoulder hardly does). The layer's blend spaces are
// mirrors of the base's (the same samples, rates and phase offsets) and follow its phase (AnimationState.syncGroup),
// so each clip plays with the very frame of the hips it was built for. The legs, and so foot placement and locking,
// are never touched.
//
// THE AIM. An additive blend space like the Look layer's: 25 poses on a 5 x 5 grid of the aim's yaw and pitch off the
// body, each the aiming stance turned there, the chest taking part of the turn and the arms the rest (about the
// shoulder pocket for the rifle, the eye for the pistol), the head following the sights.

import { mat3, mat4, quat, vec3 } from 'gl-matrix'
import type { Animation, Skin } from '../../../src/animation/animatedModel'
import { solveTwoBone } from '../../../src/animation/ik'
import { clipSeconds } from '../measure'
import type { WeaponKind, WeaponModel } from './models'

const D = Math.PI / 180
const r3 = (v: number) => Math.round(v * 1000) / 1000

// =====================================================================================================
// The skeleton, posed by local rotations
// =====================================================================================================

/** The skin's joints, in an order where a parent comes before its children. */
export class Body {
    readonly order: number[] = []
    readonly parent = new Map<number, number>()
    readonly restR = new Map<number, quat>()
    readonly restT = new Map<number, vec3>()
    readonly names = new Map<number, string>()

    constructor(readonly skin: Skin) {
        const parents = skin.nodeParents as Map<number, number>
        const local = skin.nodeTransforms as Map<number, mat4>
        for (const [i, m] of local) {
            this.restT.set(i, mat4.getTranslation(vec3.create(), m))
            this.restR.set(i, quat.normalize(quat.create(), mat4.getRotation(quat.create(), m)))
        }
        for (const [c, p] of parents) if (c !== p) this.parent.set(c, p)
        for (const [i, n] of skin.nodeNames ?? []) this.names.set(i, n)
        const seen = new Set<number>()
        const visit = (i: number) => {
            if (seen.has(i)) return
            const p = this.parent.get(i)
            if (p !== undefined) visit(p)
            seen.add(i)
            this.order.push(i)
        }
        for (const i of local.keys()) visit(i)
    }

    /** The joint whose name ends `:<base>` (or is `base`). */
    bone(base: string): number {
        for (const [i, n] of this.names) if (n === base || n.endsWith(':' + base)) return i
        throw new Error(`the skeleton has no ${base} bone`)
    }
    has(base: string): boolean {
        for (const n of this.names.values()) if (n === base || n.endsWith(':' + base)) return true
        return false
    }
}

/** A pose: every joint's local rotation and translation. */
export interface Pose { R: Map<number, quat>; T: Map<number, vec3> }
/** A pose in model space: every joint's world rotation and position. */
export interface World { R: Map<number, quat>; P: Map<number, vec3> }

export function restPose(body: Body): Pose {
    const R = new Map<number, quat>(), T = new Map<number, vec3>()
    for (const i of body.order) { R.set(i, quat.clone(body.restR.get(i)!)); T.set(i, vec3.clone(body.restT.get(i)!)) }
    return { R, T }
}

export function clonePose(p: Pose): Pose {
    return { R: new Map([...p.R].map(([k, q]) => [k, quat.clone(q)])), T: new Map([...p.T].map(([k, v]) => [k, vec3.clone(v)])) }
}

/** A sampler's value at `time` (linear, clamped; rotations slerped). */
function sampleTrack(input: ArrayLike<number>, output: ArrayLike<number>, n: 3 | 4, time: number): number[] {
    const last = input.length - 1
    if (last <= 0 || time <= input[0]) return Array.from({ length: n }, (_, c) => output[c])
    if (time >= input[last]) return Array.from({ length: n }, (_, c) => output[last * n + c])
    let lo = 0, hi = last
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (input[mid] <= time) lo = mid; else hi = mid }
    const f = (time - input[lo]) / Math.max(1e-9, input[hi] - input[lo])
    const a = Array.from({ length: n }, (_, c) => output[lo * n + c]), b = Array.from({ length: n }, (_, c) => output[hi * n + c])
    if (n === 4) return Array.from(quat.slerp(quat.create(), a as any, b as any, f))
    return a.map((v, c) => v + (b[c] - v) * f)
}

/** The pose a clip holds at `time`, over the rest pose. */
export function clipPose(body: Body, clip: Animation, time: number): Pose {
    const p = restPose(body)
    for (const ch of clip.channels) {
        const s = clip.samplers[ch.samplerIndex]
        if (ch.targetPath === 'rotation') p.R.set(ch.targetNodeIndex, quat.normalize(quat.create(), sampleTrack(s.input, s.output, 4, time) as any))
        else if (ch.targetPath === 'translation') p.T.set(ch.targetNodeIndex, vec3.fromValues(...(sampleTrack(s.input, s.output, 3, time) as [number, number, number])))
    }
    return p
}

export function worldOf(body: Body, p: Pose): World {
    const R = new Map<number, quat>(), P = new Map<number, vec3>()
    for (const i of body.order) {
        const parent = body.parent.get(i)
        const lr = p.R.get(i)!, lt = p.T.get(i)!
        if (parent === undefined) { R.set(i, quat.clone(lr)); P.set(i, vec3.clone(lt)); continue }
        const pr = R.get(parent)!, pp = P.get(parent)!
        R.set(i, quat.normalize(quat.create(), quat.multiply(quat.create(), pr, lr)))
        P.set(i, vec3.add(vec3.create(), pp, vec3.transformQuat(vec3.create(), lt, pr)))
    }
    return { R, P }
}

/** Give joint `i` the world rotation `q` (its parent's world rotation as `w` holds it). */
export function setWorldRotation(body: Body, p: Pose, w: World, i: number, q: quat): void {
    const parent = body.parent.get(i)
    const pr = parent === undefined ? quat.create() : w.R.get(parent)!
    p.R.set(i, quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), pr), q)))
}

/** `q` raised to `t` (a share of its turn). */
export function qpow(q: quat, t: number): quat {
    return quat.slerp(quat.create(), quat.create(), q, t)
}

/** The twist part of `q` about the unit `axis` (swing-twist). */
export function twistAbout(q: quat, axis: vec3): quat {
    const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2]
    const t = quat.fromValues(axis[0] * d, axis[1] * d, axis[2] * d, q[3])
    return quat.length(t) < 1e-9 ? quat.create() : quat.normalize(t, t)
}

/** The sign-aligned mean of rotations. */
export function meanRotation(qs: quat[]): quat {
    const m = quat.fromValues(0, 0, 0, 0)
    for (const q of qs) { const s = quat.dot(q, qs[0]) < 0 ? -1 : 1; for (let k = 0; k < 4; k++) m[k] += q[k] * s }
    return quat.normalize(m, m)
}

export const rotY = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * D)
export const rotX = (deg: number) => quat.setAxisAngle(quat.create(), [1, 0, 0], deg * D)
const rotZ = (deg: number) => quat.setAxisAngle(quat.create(), [0, 0, 1], deg * D)

/** The rotation taking the frame (a1, b1, a1 x b1) onto (a2, b2, a2 x b2): unit, a ⟂ b. */
function frameToFrame(a1: vec3, b1: vec3, a2: vec3, b2: vec3): quat {
    const c1 = vec3.cross(vec3.create(), a1, b1), c2 = vec3.cross(vec3.create(), a2, b2)
    const m1 = mat3.fromValues(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], c1[0], c1[1], c1[2])
    const m2 = mat3.fromValues(a2[0], a2[1], a2[2], b2[0], b2[1], b2[2], c2[0], c2[1], c2[2])
    const m = mat3.multiply(mat3.create(), m2, mat3.transpose(mat3.create(), m1))
    return quat.normalize(quat.create(), quat.fromMat3(quat.create(), m))
}
const orthoUnit = (v: vec3, to: vec3) => vec3.normalize(vec3.create(), vec3.scaleAndAdd(vec3.create(), v, to, -vec3.dot(v, to)))

/** A rigid transform: rotation then translation. */
export interface Rigid { R: quat; P: vec3 }
export const compose = (a: Rigid, b: Rigid): Rigid => ({
    R: quat.normalize(quat.create(), quat.multiply(quat.create(), a.R, b.R)),
    P: vec3.add(vec3.create(), a.P, vec3.transformQuat(vec3.create(), b.P, a.R)),
})
export const invert = (a: Rigid): Rigid => {
    const R = quat.invert(quat.create(), a.R)
    return { R, P: vec3.negate(vec3.create(), vec3.transformQuat(vec3.create(), a.P, R)) }
}
export const apply = (a: Rigid, v: vec3) => vec3.add(vec3.create(), a.P, vec3.transformQuat(vec3.create(), v, a.R))

/** A joint's world transform. */
export const jointOf = (w: World, i: number): Rigid => ({ R: quat.clone(w.R.get(i)!), P: vec3.clone(w.P.get(i)!) })

// =====================================================================================================
// Bones
// =====================================================================================================

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
const ARM = ['Shoulder', 'Arm', 'ForeArm', 'Hand'] as const
type Side = 'Left' | 'Right'

/** The spine and head: what the weapon layers turn so the chest is the stance's. */
export const SPINE_BONES = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head']

/** One side's arm and fingers, as the skeleton has them. */
export function armBones(body: Body, side: Side): string[] {
    const out: string[] = ARM.map(b => side + b)
    for (const f of FINGERS) for (const k of [1, 2, 3, 4]) if (body.has(`${side}Hand${f}${k}`)) out.push(`${side}Hand${f}${k}`)
    return out
}

/** The bones a weapon's override layers play, by layer: the spine with the arms that hold it. */
export function weaponLayerBones(body: Body, kind: WeaponKind): { main: string[]; support: string[] } {
    return kind === 'rifle'
        ? { main: [...SPINE_BONES, ...armBones(body, 'Left'), ...armBones(body, 'Right')], support: [] }
        : { main: [...SPINE_BONES, ...armBones(body, 'Right')], support: armBones(body, 'Left') }
}

/** The bones an aim pose moves: the upper spine, the head, and both arms (not the fingers). */
export function aimBones(): string[] {
    return ['Spine1', 'Spine2', 'Neck', 'Head', ...(['Left', 'Right'] as const).flatMap(s => ARM.map(b => s + b))]
}

// =====================================================================================================
// The hands on the weapon
// =====================================================================================================

/** The middle of a hand's twelve finger joints: what the fist closes round. */
function fistOf(body: Body, w: World, side: Side): { centre: vec3 } {
    const pts: vec3[] = []
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) for (const k of [1, 2, 3]) pts.push(w.P.get(body.bone(`${side}Hand${f}${k}`))!)
    const centre = vec3.scale(vec3.create(), pts.reduce((s, v) => vec3.add(s, s, v), vec3.create()), 1 / pts.length)
    return { centre }
}

/** A weapon's grip frame: its grip axis, and the bore square to it (weapon space). */
function gripFrame(weapon: WeaponModel): { a: vec3; b: vec3 } {
    const a = vec3.clone(weapon.gripAxis)
    return { a, b: orthoUnit(vec3.fromValues(0, 0, 1), a) }
}

/** Mirror a rotation (as a matrix) across the plane x = 0 of its own frame. */
function mirrorX(q: quat): quat {
    return quat.fromValues(q[0], -q[1], -q[2], q[3])
}

/**
 * How the hands hold a weapon, in weapon space: the right hand's joint (the socket's inverse) and the support hand's,
 * and the fingers' locals of both, read off the rifle pack's aim.
 */
export interface Grip {
    right: Rigid
    left: Rigid
    /** Local rotations of every finger joint, by bone name. */
    fingers: Map<string, quat>
    /** The right fist's middle in weapon space: where the grip is closed round, for the report. */
    fist: vec3
    /** The point on the bore's line the support hand rolls round (weapon space): the handguard's axis, the grip's. */
    supportAxis: vec3
}

/**
 * The grips, off the pack's aim (`aimPose`): the rifle's straight from it, the pistol's by the same hand on the
 * pistol's grip (the grip's own axis and the bore) and the support hand wrapped round it.
 */
export function grips(body: Body, aimPose: Pose, rifle: WeaponModel, pistol: WeaponModel): Record<WeaponKind, Grip> {
    const w = worldOf(body, aimPose)
    const right = fistOf(body, w, 'Right'), left = fistOf(body, w, 'Left')
    // The pack's rifle, aimed: level and upright (not canted), its grip in the right fist and its handguard in the
    // left, so the line from the grip to the support point runs from the one fist to the other. (Not the knuckles'
    // line: that is not the grip's axis, and a frame off it held the rifle 35 degrees muzzle-up in the pack's own aim.)
    const rf = gripFrame(rifle)
    const along = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), left.centre, right.centre))
    const toSupport = vec3.normalize(vec3.create(), rifle.support)
    const packR = frameToFrame(toSupport, orthoUnit(vec3.fromValues(0, 1, 0), toSupport), along, orthoUnit(vec3.fromValues(0, 1, 0), along))
    const pack: Rigid = { R: packR, P: right.centre }
    const toWeapon = invert(pack)
    const rightHand = compose(toWeapon, jointOf(w, body.bone('RightHand')))
    let leftHand = compose(toWeapon, jointOf(w, body.bone('LeftHand')))
    // The left fist moved onto this rifle's handguard (the pack's rifle is not this one).
    const leftFist = apply(toWeapon, left.centre)
    leftHand = { R: leftHand.R, P: vec3.add(vec3.create(), leftHand.P, vec3.sub(vec3.create(), rifle.support, leftFist)) }
    const fingers = new Map<string, quat>()
    for (const side of ['Left', 'Right'] as const) for (const b of armBones(body, side).slice(ARM.length)) fingers.set(b, quat.clone(aimPose.R.get(body.bone(b))!))

    // The pistol: the same right hand, its fist's axis on the pistol's grip axis (the rifle's grip frame turned onto
    // the pistol's).
    const pf = gripFrame(pistol)
    const rifleToPistol = frameToFrame(rf.a, rf.b, pf.a, pf.b)
    const turn = (h: Rigid): Rigid => ({ R: quat.multiply(quat.create(), rifleToPistol, h.R), P: vec3.transformQuat(vec3.create(), h.P, rifleToPistol) })
    const pistolRight = turn(rightHand)
    // The support hand: the grip hand mirrored across the pistol's middle (palms facing), then wrapped forward and
    // down round the front of the grip hand's fingers, and turned a little thumbs-forward.
    const restR = body.restR, rest = worldOf(body, restPose(body))
    const restRight = rest.R.get(body.bone('RightHand'))!, restLeft = rest.R.get(body.bone('LeftHand'))!
    // L = M R M · (M restR M)^-1 · restL, M the mirror across x = 0 (rest mirrored across the body's middle).
    const flip = quat.multiply(quat.create(), quat.invert(quat.create(), mirrorX(restRight)), restLeft)
    void restR
    const mirrored = quat.multiply(quat.create(), mirrorX(pistolRight.R), flip)
    const wrap = quat.multiply(quat.create(), rotX(18), rotY(-12))
    const pistolLeft: Rigid = {
        R: quat.normalize(quat.create(), quat.multiply(quat.create(), wrap, mirrored)),
        P: vec3.add(vec3.create(), vec3.fromValues(-pistolRight.P[0], pistolRight.P[1], pistolRight.P[2]), PISTOL_SUPPORT_OFFSET),
    }
    return {
        rifle: { right: rightHand, left: leftHand, fingers, fist: apply(toWeapon, right.centre), supportAxis: vec3.clone(rifle.support) },
        pistol: {
            right: pistolRight, left: pistolLeft, fingers, fist: vec3.transformQuat(vec3.create(), apply(toWeapon, right.centre), rifleToPistol),
            supportAxis: vec3.fromValues(0, -0.02, 0),
        },
    }
}

/** Where the pistol's support hand's wrist sits off the grip hand's, mirrored: ahead, below and further left (m, weapon space). */
const PISTOL_SUPPORT_OFFSET = vec3.fromValues(0.012, -0.02, 0.03)

// =====================================================================================================
// Stances
// =====================================================================================================

/** Where on the body a stance holds its weapon from, all in the chest's frame (Spine2), worked out at rest. */
interface Anchors {
    /** The right shoulder pocket: where a rifle's butt sits. */
    pocket: vec3
    /** The right eye, in the HEAD's frame. */
    eye: vec3
}

export function anchorsOf(body: Body): Anchors {
    const w = worldOf(body, restPose(body))
    const chest = jointOf(w, body.bone('Spine2')), head = jointOf(w, body.bone('Head'))
    // The pocket: in from the shoulder joint, a little down and forward of it (between the deltoid and the chest).
    const shoulder = w.P.get(body.bone('RightArm'))!
    const pocket = vec3.add(vec3.create(), shoulder, [0.055, -0.035, 0.065])
    // The right eye: up and forward of the head joint (the base of the skull), right of the middle.
    const eye = vec3.add(vec3.create(), head.P, [-0.032, 0.085, 0.09])
    return { pocket: apply(invert(chest), pocket), eye: apply(invert(head), eye) }
}

/** What a stance is: the chest's turn off upright, the head's, and where the weapon is held. */
export interface StanceSpec {
    /** The chest's turn from the reference (upright), degrees: yaw (left +), pitch (forward +), roll (right shoulder down +). */
    chest: [number, number, number]
    /** The head's turn on top of the chest's, degrees, the same way; null leaves the head to the base clip (model space). */
    head: [number, number, number] | null
    /** The weapon's bore direction off straight ahead, degrees: yaw (left +), pitch (down +). */
    bore: [number, number]
    /** How the weapon's place is found. */
    hold:
        | { kind: 'shoulder'; drop?: number; sightThroughEye: boolean }   // a rifle: butt in the pocket (dropped `drop` m), sights through the eye
        | { kind: 'eye'; distance: number; about?: 'shoulders' | 'rightShoulder' }   // the sights `distance` m ahead of the eye, level; `about`: then turned down by the bore about there (the aimed arms swung down)
        | { kind: 'frame'; inChest: Rigid }                              // held where a clip of the rifle pack holds it, off the chest (bore ignored)
    /** Which hands hold it (the pistol's sprint carries it in the right alone). */
    hands: 'both' | 'right'
    /**
     * How much the elbows are kept down, against keeping the wrists straight (see `bestElbow`): 0 lets the wrists alone
     * decide, 1 (the default) weighs an elbow raised all the way out like 30 degrees of wrist bend.
     */
    elbowsDown?: number
}

export interface Stance {
    spec: StanceSpec
    /** Locals of every bone the layer plays (arms constant; spine and head as solved here, over the reference). */
    locals: Map<string, quat>
    /** The chest's (Spine2's) model rotation in the reference: what the clips turn the chest to. */
    chest: quat
    /** The weapon's frame relative to the chest. */
    weaponInChest: Rigid
    /** Measured: how far each hand ended from its target (m), and the butt from the pocket. */
    report: string
}

/**
 * Solve a stance over `reference` (a standing pose: the base Idle's mean): turn the chest and head, place the weapon,
 * put the hands on it.
 */
export function solveStance(body: Body, reference: Pose, weapon: WeaponModel, grip: Grip, spec: StanceSpec, anchors = anchorsOf(body)): Stance {
    const p = clonePose(reference)
    let w = worldOf(body, p)
    const spine = ['Spine', 'Spine1', 'Spine2'].map(b => body.bone(b))
    const neck = body.bone('Neck'), head = body.bone('Head')
    // The chest, turned in model space (yaw about up, pitch about the left axis, roll about forward), spread up the
    // spine bottom-heavy (as weaponClips spreads the per-frame correction).
    const turn = quat.multiply(quat.create(), quat.multiply(quat.create(), rotY(spec.chest[0]), rotX(spec.chest[1])), rotZ(spec.chest[2]))
    const headWorld = quat.clone(w.R.get(head)!), neckWorld = quat.clone(w.R.get(neck)!)
    turnSpine(body, p, spine, turn)
    w = worldOf(body, p)
    // The head: the stance's own turn on the chest's, or kept as the reference held it in model space.
    if (spec.head) {
        const h = quat.multiply(quat.create(), quat.multiply(quat.create(), rotY(spec.head[0]), rotX(spec.head[1])), rotZ(spec.head[2]))
        setWorldRotation(body, p, w, neck, quat.multiply(quat.create(), quat.multiply(quat.create(), qpow(h, 0.4), turn), neckWorld))
        w = worldOf(body, p)
        setWorldRotation(body, p, w, head, quat.multiply(quat.create(), quat.multiply(quat.create(), h, turn), headWorld))
    } else {
        setWorldRotation(body, p, w, neck, neckWorld)
        w = worldOf(body, p)
        setWorldRotation(body, p, w, head, headWorld)
    }
    w = worldOf(body, p)
    const chest = jointOf(w, body.bone('Spine2'))
    const headJ = jointOf(w, head)

    // The weapon: its bore, level (no cant), and its place.
    const R = quat.multiply(quat.create(), rotY(spec.bore[0]), rotX(spec.bore[1]))
    let P: vec3
    const h = spec.hold
    if (h.kind === 'shoulder') {
        const pocket = apply(chest, anchors.pocket)
        pocket[1] -= h.drop ?? 0
        // The butt in the pocket; aiming, raised or lowered (and moved in or out) so the sight line goes through the
        // eye, as the head comes down onto the stock: the pocket fixes how far back it sits.
        P = vec3.sub(vec3.create(), pocket, vec3.transformQuat(vec3.create(), weapon.butt, R))
        if (h.sightThroughEye) {
            const eye = apply(headJ, anchors.eye)
            const sight = apply({ R, P }, weapon.sight)
            const up = vec3.transformQuat(vec3.create(), [0, 1, 0], R), left = vec3.transformQuat(vec3.create(), [1, 0, 0], R)
            const off = vec3.sub(vec3.create(), eye, sight)
            vec3.scaleAndAdd(P, P, up, vec3.dot(off, up))
            vec3.scaleAndAdd(P, P, left, vec3.dot(off, left))
        }
    } else if (h.kind === 'eye') {
        const eye = apply(headJ, anchors.eye)
        if (h.about) {
            // Aimed level, then the whole hold (weapon and arms) swung down about the shoulders by the bore's turn.
            const level = vec3.sub(vec3.create(), vec3.add(vec3.create(), eye, [0, 0, h.distance]), weapon.sight)
            const rs = w.P.get(body.bone('RightArm'))!, ls = w.P.get(body.bone('LeftArm'))!
            const pivot = h.about === 'rightShoulder' ? vec3.clone(rs) : vec3.lerp(vec3.create(), rs, ls, 0.5)
            P = vec3.add(vec3.create(), pivot, vec3.transformQuat(vec3.create(), vec3.sub(vec3.create(), level, pivot), R))
        } else {
            // The sights `distance` ahead of the eye on the bore's line.
            const fwd = vec3.transformQuat(vec3.create(), [0, 0, 1], R)
            P = vec3.sub(vec3.create(), vec3.scaleAndAdd(vec3.create(), eye, fwd, h.distance), vec3.transformQuat(vec3.create(), weapon.sight, R))
        }
    } else {
        const f = compose(chest, h.inChest)
        quat.copy(R, f.R)
        P = f.P
    }
    const weaponFrame: Rigid = { R, P }
    const misses = holdWeapon(body, p, grip, spec, weaponFrame)

    w = worldOf(body, p)
    const chestNow = jointOf(w, body.bone('Spine2'))
    const locals = new Map<string, quat>()
    for (const b of [...SPINE_BONES, ...armBones(body, 'Left'), ...armBones(body, 'Right')]) locals.set(b, quat.clone(p.R.get(body.bone(b))!))
    const butt = apply(weaponFrame, weapon.butt)
    const pocket = apply(chestNow, anchors.pocket)
    const report = `hands off by ${misses.join(', ')}; butt ${(vec3.distance(butt, pocket) * 100).toFixed(1)} cm from the pocket; `
        + `wrist bend R ${wristBend(body, p, 'Right').toFixed(0)}°${spec.hands === 'both' ? `, L ${wristBend(body, p, 'Left').toFixed(0)}°` : ''}`
    return { spec, locals, chest: quat.clone(chestNow.R), weaponInChest: compose(invert(chestNow), weaponFrame), report }
}

/** Put the hands on the weapon at `weaponFrame` (model space), and close the fingers: how far each hand ended off. */
function holdWeapon(body: Body, p: Pose, grip: Grip, spec: StanceSpec, weaponFrame: Rigid): string[] {
    const misses: string[] = []
    for (const side of (spec.hands === 'both' ? ['Right', 'Left'] : ['Right']) as Side[]) {
        let w = worldOf(body, p)
        // The right hand holds the grip as the socket says. The support hand may roll round the bore through where it
        // holds (a hand round a handguard, or round the grip hand, turns on it), up to SUPPORT_ROLL either way: the
        // roll and the elbow that cost least (`bestElbow`), a turned hand counting a little against.
        let target = compose(weaponFrame, grip.right), elbow: vec3 | null = null
        if (side === 'Left') {
            let cost = Infinity
            const shoulder = body.bone('LeftShoulder'), saved = quat.clone(p.R.get(shoulder)!)
            for (let roll = -SUPPORT_ROLL; roll <= SUPPORT_ROLL + 1e-6; roll += 10) {
                const t = compose(weaponFrame, rollAbout(grip.left, grip.supportAxis, roll))
                reachWithShoulder(body, p, side, t.P)
                const e = bestElbow(body, p, side, t, spec.elbowsDown ?? 1)
                const c = e.cost + Math.abs(roll) * 0.15
                if (c < cost) { cost = c; target = t; elbow = e.at }
                p.R.set(shoulder, quat.clone(saved))
            }
        }
        reachWithShoulder(body, p, side, target.P)
        // The elbow where the wrist bends least, kept down (`elbowsDown`).
        solveArm(body, p, side, target, elbow ?? bestElbow(body, p, side, target, spec.elbowsDown ?? 1).at)
        w = worldOf(body, p)
        const miss = vec3.distance(w.P.get(body.bone(`${side}Hand`))!, target.P)
        misses.push(`${side[0]} ${(miss * 100).toFixed(1)} cm`)
    }
    // The fingers closed round it.
    for (const [b, q] of grip.fingers) if (spec.hands === 'both' || b.startsWith('Right')) p.R.set(body.bone(b), quat.clone(q))
    return misses
}

/**
 * An aim pose: the aiming stance (`stance`, over `reference`) turned to aim `yaw` degrees left and `pitch` down
 * off it. The chest takes `chestShare` of each (spread over Spine1 and Spine2), the head the rest; the weapon is
 * turned the whole way, about the butt (a rifle: it stays in the shoulder) or the eye (a pistol: the sight picture
 * holds), and the arms re-solved onto it. The locals of `aimBones()`, and the aim's error (degrees): how far the bore
 * the right hand ends up holding is from the aim.
 */
export function aimPose(body: Body, reference: Pose, weapon: WeaponModel, grip: Grip, stance: Stance, yaw: number, pitch: number,
    chestShare: { yaw: number; pitch: number }, anchors = anchorsOf(body)): { locals: Map<string, quat>; miss: number } {
    const p = clonePose(reference)
    for (const [b, q] of stance.locals) p.R.set(body.bone(b), quat.clone(q))
    let w = worldOf(body, p)
    const chest0 = jointOf(w, body.bone('Spine2'))
    const weapon0 = compose(chest0, stance.weaponInChest)
    const neck = body.bone('Neck'), head = body.bone('Head')
    const neck0 = quat.clone(w.R.get(neck)!), head0 = quat.clone(w.R.get(head)!)
    const eye0 = apply(jointOf(w, head), anchors.eye)
    const butt0 = apply(weapon0, weapon.butt)
    // The chest's part, up the upper spine.
    const A = quat.multiply(quat.create(), rotY(yaw * chestShare.yaw), rotX(pitch * chestShare.pitch))
    turnSpine(body, p, [body.bone('Spine1'), body.bone('Spine2')], A, [0.5, 1])
    w = worldOf(body, p)
    const chest1 = jointOf(w, body.bone('Spine2'))
    const carried = compose(chest1, invert(chest0))
    // The head's: the rest of the turn, the neck taking 40% of it.
    const F = quat.multiply(quat.create(), rotY(yaw), rotX(pitch))
    const rest = quat.multiply(quat.create(), F, quat.invert(quat.create(), A))
    setWorldRotation(body, p, w, neck, quat.multiply(quat.create(), quat.multiply(quat.create(), qpow(rest, 0.4), A), neck0))
    w = worldOf(body, p)
    setWorldRotation(body, p, w, head, quat.multiply(quat.create(), quat.multiply(quat.create(), rest, A), head0))
    w = worldOf(body, p)
    // The weapon turned the whole way, about the butt or the eye.
    const R = quat.multiply(quat.create(), F, weapon0.R)
    let P: vec3
    if (weapon.kind === 'rifle') {
        const butt = apply(carried, butt0)
        P = vec3.sub(vec3.create(), butt, vec3.transformQuat(vec3.create(), weapon.butt, R))
    } else {
        const eye = apply(jointOf(w, head), anchors.eye)
        P = vec3.add(vec3.create(), eye, vec3.transformQuat(vec3.create(), vec3.sub(vec3.create(), weapon0.P, eye0), F))
    }
    holdWeapon(body, p, grip, stance.spec, { R, P })
    // The bore the hand ended up holding (the weapon is fixed in the right hand).
    w = worldOf(body, p)
    const held = compose(jointOf(w, body.bone('RightHand')), invert(grip.right))
    const bore = vec3.transformQuat(vec3.create(), [0, 0, 1], held.R)
    const want = vec3.transformQuat(vec3.create(), [0, 0, 1], R)
    const miss = Math.acos(Math.min(1, vec3.dot(bore, want))) / D
    const locals = new Map<string, quat>()
    for (const b of aimBones()) locals.set(b, quat.clone(p.R.get(body.bone(b))!))
    return { locals, miss }
}

/** Turn the chest by the model-space rotation `turn`, spread up the spine: Spine 0.6, Spine1 0.9, Spine2 all of it. */
export function turnSpine(body: Body, p: Pose, spine: number[], turn: quat, shares = [0.6, 0.9, 1]): void {
    const w = worldOf(body, p)
    const targets = spine.map((i, k) => quat.multiply(quat.create(), qpow(turn, shares[k]), w.R.get(i)!))
    // Down the chain: each from its parent's NEW world rotation.
    let parentR = w.R.get(body.parent.get(spine[0])!)!
    for (let k = 0; k < spine.length; k++) {
        p.R.set(spine[k], quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), parentR), targets[k])))
        parentR = targets[k]
    }
}

/**
 * One arm onto `target` (the hand joint's world transform): the upper arm and forearm by two-bone IK, the elbow
 * toward `pole` (model space, off the elbow), the hand turned to the target, and most of the hand's twist taken by
 * the forearm (a wrist does not twist; the forearm does).
 */
function solveArm(body: Body, p: Pose, side: Side, target: Rigid, pole: vec3): void {
    const arm = body.bone(`${side}Arm`), fore = body.bone(`${side}ForeArm`), hand = body.bone(`${side}Hand`)
    let w = worldOf(body, p)
    const elbow = w.P.get(fore)!
    const r = solveTwoBone({ root: w.P.get(arm)!, mid: elbow, tip: w.P.get(hand)!, target: target.P, pole })
    const armW = quat.multiply(quat.create(), r.rootDelta, w.R.get(arm)!)
    const foreW = quat.multiply(quat.create(), quat.multiply(quat.create(), r.midDelta, r.rootDelta), w.R.get(fore)!)
    setWorldRotation(body, p, w, arm, armW)
    w = worldOf(body, p)
    setWorldRotation(body, p, w, fore, foreW)
    w = worldOf(body, p)
    // The hand's twist about the forearm, mostly moved into the forearm.
    const axis = vec3.normalize(vec3.create(), vec3.clone(body.restT.get(hand)!))   // the forearm's own axis, in its frame
    const handLocal = quat.multiply(quat.create(), quat.invert(quat.create(), foreW), target.R)
    const twist = twistAbout(handLocal, axis)
    const foreTwisted = quat.multiply(quat.create(), foreW, qpow(twist, FOREARM_TWIST))
    setWorldRotation(body, p, w, fore, foreTwisted)
    w = worldOf(body, p)
    setWorldRotation(body, p, w, hand, target.R)
}

/**
 * Where the elbow goes for the hand at `hand` (its joint's world transform): of the circle of places the elbow can be
 * with the hand there, the one where the wrist bends least (the forearm most along the hand's own line, from the wrist
 * toward the middle finger), the elbow's height weighed in by `down` (an elbow raised all the way, out to the side or
 * up, counts like 30 degrees of wrist bend at 1). A wrist bends 60 to 70 degrees at most; an elbow held out sideways
 * is a chicken wing.
 */
function bestElbow(body: Body, p: Pose, side: Side, hand: Rigid, down: number): { at: vec3; cost: number } {
    const w = worldOf(body, p)
    const S = w.P.get(body.bone(`${side}Arm`))!, E0 = w.P.get(body.bone(`${side}ForeArm`))!, W0 = w.P.get(body.bone(`${side}Hand`))!
    const a = vec3.distance(S, E0), b = vec3.distance(E0, W0)
    const toTarget = vec3.sub(vec3.create(), hand.P, S)
    const d = Math.min(vec3.length(toTarget), (a + b) * 0.999)
    const axis = vec3.normalize(vec3.create(), toTarget)
    const x = (a * a - b * b + d * d) / (2 * d)
    const r = Math.sqrt(Math.max(0, a * a - x * x))
    const centre = vec3.scaleAndAdd(vec3.create(), S, axis, x)
    const u = orthoUnit(vec3.fromValues(0, -1, 0), axis)
    const v = vec3.cross(vec3.create(), axis, u)
    const middle = body.bone(`${side}HandMiddle1`)
    const handDir = vec3.normalize(vec3.create(), vec3.transformQuat(vec3.create(), body.restT.get(middle)!, hand.R))
    const wrist = vec3.scaleAndAdd(vec3.create(), S, axis, d)
    let best = vec3.clone(E0), cost = Infinity
    for (let k = 0; k < 120; k++) {
        const t = k / 120 * Math.PI * 2
        const E = vec3.add(vec3.create(), centre, vec3.add(vec3.create(), vec3.scale(vec3.create(), u, r * Math.cos(t)), vec3.scale(vec3.create(), v, r * Math.sin(t))))
        const fore = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), wrist, E))
        const bend = Math.acos(Math.max(-1, Math.min(1, vec3.dot(fore, handDir)))) / D
        // 0 with the elbow at the bottom of its circle, 1 at the top.
        const raised = (1 - Math.cos(t)) / 2
        // A wrist bends freely to about 25 degrees, and less and less willingly past it; an elbow raised out to the
        // side costs like 25 degrees more of it, raised overhead like 50.
        const c = 0.3 * bend + 1.2 * Math.max(0, bend - 25) + down * 50 * raised
        if (c < cost) { cost = c; best = E }
    }
    return { at: best, cost }
}

/** How far the support hand may roll round the bore through its hold, degrees either way. */
const SUPPORT_ROLL = 70

/** `h` (a hand's joint in weapon space) rolled `deg` degrees round the line along the bore (+Z) through `at`. */
function rollAbout(h: Rigid, at: vec3, deg: number): Rigid {
    const q = quat.setAxisAngle(quat.create(), [0, 0, 1], deg * D)
    return {
        R: quat.multiply(quat.create(), q, h.R),
        P: vec3.add(vec3.create(), at, vec3.transformQuat(vec3.create(), vec3.sub(vec3.create(), h.P, at), q)),
    }
}

/**
 * The shoulder (clavicle) turned a little toward where the hand must reach: a share of the turn that would point it
 * there, at most SHOULDER_REACH_MAX degrees. Reaching forward, the shoulders come forward; reaching up, they rise.
 */
function reachWithShoulder(body: Body, p: Pose, side: Side, target: vec3): void {
    const shoulder = body.bone(`${side}Shoulder`), arm = body.bone(`${side}Arm`)
    const w = worldOf(body, p)
    const from = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), w.P.get(arm)!, w.P.get(shoulder)!))
    const to = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), target, w.P.get(shoulder)!))
    const full = quat.rotationTo(quat.create(), from, to)
    const angle = 2 * Math.acos(Math.min(1, Math.abs(full[3]))) / D
    const share = Math.min(SHOULDER_REACH, SHOULDER_REACH_MAX / Math.max(1e-6, angle))
    setWorldRotation(body, p, w, shoulder, quat.multiply(quat.create(), qpow(full, share), w.R.get(shoulder)!))
}
const SHOULDER_REACH = 0.25, SHOULDER_REACH_MAX = 20

/** The share of a hand's twist the forearm takes. */
const FOREARM_TWIST = 0.7

/**
 * Where a clip of the rifle pack holds its rifle off its chest, on average over the clip: the right hand's joint with
 * the grip's inverse (the rifle is fixed in that hand), in the chest's (Spine2's) frame.
 */
export function packHold(body: Body, clip: Animation, grip: Grip): Rigid {
    const T = clipSeconds(clip), n = 24
    const rs: quat[] = [], ps: vec3[] = []
    for (let k = 0; k < n; k++) {
        const w = worldOf(body, clipPose(body, clip, T * k / n))
        const f = compose(invert(jointOf(w, body.bone('Spine2'))), compose(jointOf(w, body.bone('RightHand')), invert(grip.right)))
        rs.push(f.R); ps.push(f.P)
    }
    return { R: meanRotation(rs), P: vec3.scale(vec3.create(), ps.reduce((s, v) => vec3.add(s, s, v), vec3.create()), 1 / n) }
}

/**
 * How far a wrist bends (degrees): between the forearm (elbow to wrist) and the hand (wrist to the middle finger's
 * base). The rest pose holds it at 9, a relaxed hand 10 to 20; the rifle pack's own holds bend it 10 to 35.
 */
function wristBend(body: Body, p: Pose, side: Side): number {
    const w = worldOf(body, p)
    const E = w.P.get(body.bone(`${side}ForeArm`))!, W = w.P.get(body.bone(`${side}Hand`))!, M = w.P.get(body.bone(`${side}HandMiddle1`))!
    const f = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), W, E)), h = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), M, W))
    return Math.acos(Math.max(-1, Math.min(1, vec3.dot(f, h)))) / D
}

// =====================================================================================================
// The stances of each weapon
// =====================================================================================================

/**
 * Each weapon's stances, by what the layer does: carrying it (low ready), aiming it, and carrying it at a sprint.
 *
 *   rifle   carry: the rifle pack's idle (across the body, low, the muzzle ahead to the left), bladed 8 degrees; aim:
 *           bladed 15, leaning in, the butt in the pocket and the head down onto the stock (the sight line through
 *           the eye); sprint: the rifle pack's sprint (across the chest)
 *   pistol  carry: the aim swung 45 degrees down about the shoulders, arms out; aim: square and leaning in, arms out,
 *           the sights 0.42 m ahead of the eye; sprint: the aim swung 68 degrees down about the right shoulder, in the
 *           right hand by the thigh, the left arm free
 */
export function stanceSpecs(kind: WeaponKind): Record<'carry' | 'aim' | 'sprint', StanceSpec> {
    return kind === 'rifle'
        ? {
            // Where the rifle pack's idle carries it, off the chest: across the body, the muzzle down to the left
            // (weaponClips fills it in from `Rifle idle`).
            carry: { chest: [-8, 3, 0], head: null, bore: [0, 0], hold: { kind: 'frame', inChest: { R: quat.create(), P: vec3.create() } }, hands: 'both' },
            aim: { chest: [-15, 7, 0], head: [10, 15, 12], bore: [0, 0], hold: { kind: 'shoulder', sightThroughEye: true }, hands: 'both' },
            // Where the rifle pack's sprint carries it, off the chest (weaponClips fills it in from `Rifle sprint forward`).
            sprint: { chest: [0, 0, 0], head: null, bore: [0, 0], hold: { kind: 'frame', inChest: { R: quat.create(), P: vec3.create() } }, hands: 'both' },
        }
        : {
            carry: { chest: [0, 4, 0], head: null, bore: [0, 45], hold: { kind: 'eye', distance: 0.42, about: 'shoulders' }, hands: 'both' },
            aim: { chest: [0, 8, 0], head: [0, 4, 0], bore: [0, 0], hold: { kind: 'eye', distance: 0.42 }, hands: 'both' },
            sprint: { chest: [0, 0, 0], head: null, bore: [8, 68], hold: { kind: 'eye', distance: 0.3, about: 'rightShoulder' }, hands: 'right' },
        }
}

export const r = r3
