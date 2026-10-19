/**
 * Ragdoll profiles: which bones become bodies, how big and heavy each one is, and how each joint bends.
 *
 * The generic ragdoll (`ragdoll.ts`, no profile) put a 1 kg sphere on every long-ish joint and gave
 * every joint the same 45 degree cone, centred on whatever pose the character died in. That falls like
 * a coat: beads on strings, knees and elbows bending both ways, hands as heavy as the pelvis.
 *
 * A profile is the anatomical version:
 *  - one body per body SEGMENT (pelvis, two torso pieces, head, upper/fore arms, hands, thighs, shins,
 *    feet), shaped along the bone (capsules and boxes) instead of a ball on its joint;
 *  - masses from anthropometric segment fractions (Winter, "Biomechanics of Human Movement");
 *  - joint limits framed in the BIND pose, so a cone is centred on an anatomical neutral, and knees and
 *    elbows are HINGES that only bend the way they do.
 *
 * Bones are named, never indexed, for the reason sockets are (`sockets.ts`): indices are stable only
 * per export, names survive a re-import. Sizes are in the skeleton's bind MODEL space -- the space
 * `inverse(inverseBindMatrix)` lives in -- so a profile is independent of how a model is scaled.
 */

import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skin } from '../animation/animatedModel';
import { humanoidRigOf } from '../animation/animationRetarget';
import { normalizeBoneName } from '../animation/boneNames';
import { skeletonTopology } from '../animation/skeletonTopology';

export type RagdollShape = 'capsule' | 'box' | 'sphere';
export type RagdollJointType = 'cone' | 'hinge' | 'fixed';

export interface RagdollJoint {
    type: RagdollJointType;
    /** Cone: half-angle (degrees) the bone may swing away from its neutral direction. */
    swing: number;
    /** Cone: twist limit (degrees) about the bone. Keep it loose -- a tight cannon twist limit jitters. */
    twist: number;
    /** Hinge: bend range in degrees, 0 = the bind direction, positive = toward `bendDir`. */
    hingeMin: number;
    hingeMax: number;
    /**
     * Cone: where the cone is centred, as a turn of the bind direction -- [toward the character's front,
     * toward the ground], in degrees. An arm bound in a T-pose rests 45 degrees lower than its bind.
     */
    tilt?: [number, number];
    /** Hinge: the way the joint folds, in bind model space (a knee folds backwards, an elbow forwards). */
    bendDir?: [number, number, number];
}

export interface RagdollPart {
    /** Display name ("Thigh L"). */
    name: string;
    /** The bone the body rides on. Everything below it without a part of its own rides along. */
    bone: string;
    /** Where the segment ends (the next bone down the limb). None: the segment is `length` long, along the bone. */
    tipBone?: string;
    shape: RagdollShape;
    /** Capsule/sphere radius; a box's half-width. Bind model units. */
    radius: number;
    /** Segment length (capsule end-to-end including caps; box height). Defaults to bone -> tip. */
    length?: number;
    /** Box: full depth (front to back). Defaults to the width. */
    depth?: number;
    /** Share of the profile's total mass. Normalized at build time, so they need not sum to 1. */
    massFraction: number;
    /** How this part hangs from its parent part. Ignored on the root part. */
    joint: RagdollJoint;
}

export interface RagdollProfile {
    version: 1;
    /** kg. 70 is an adult. */
    totalMass: number;
    parts: RagdollPart[];
    /** Limbs collide with each other and the torso (directly jointed parts never do). */
    selfCollision: boolean;
    linearDamping: number;
    angularDamping: number;
    /** Solver iterations while this ragdoll is alive. 10 (cannon's default) lets long chains sag. */
    solverIterations: number;
}

export const RAGDOLL_PROFILE_DEFAULTS: Omit<RagdollProfile, 'parts'> = {
    version: 1,
    totalMass: 70,
    selfCollision: true,
    linearDamping: 0.02,
    angularDamping: 0.2,
    solverIterations: 20,
};

export function defaultJoint(type: RagdollJointType = 'cone'): RagdollJoint {
    return { type, swing: 45, twist: 30, hingeMin: 0, hingeMax: 120 };
}

// ---------------------------------------------------------------------------------------------------
// Bind-pose layout
// ---------------------------------------------------------------------------------------------------

/** A part resolved against a skin, in bind MODEL space. What the runtime builds and the editor draws. */
export interface RagdollLayoutPart {
    part: RagdollPart;
    index: number;
    /** Joint index (into skin.joints) and node index of `part.bone`. */
    joint: number;
    node: number;
    /** Index of the parent part in the layout, or -1 for the root. */
    parent: number;
    /** Bind-space bone origin, segment centre, and the body frame (Y along the segment). */
    bonePos: vec3;
    center: vec3;
    rotation: quat;
    /** Bind rigid rotation of the bone itself (for mapping a live pose onto the part). */
    boneRotation: quat;
    /** Segment length and radius actually used. */
    length: number;
    radius: number;
    depth: number;
    /** Normalized mass fraction. */
    mass: number;
    /** Joint geometry, bind space: pivot (this part's bone origin), child axis, parent axis, hinge axis. */
    pivot: vec3;
    childAxis: vec3;
    parentAxis: vec3;
    hingeAxis: vec3 | null;
    /** Half-angle of the limit cone (radians), centred on parentAxis. */
    coneAngle: number;
    twistAngle: number;
}

export interface RagdollLayout {
    parts: RagdollLayoutPart[];
    /** Character axes in bind model space. */
    up: vec3;
    forward: vec3;
    left: vec3;
}

const DEG = Math.PI / 180;

/** Find a joint by bone name: exact first, then by normalized name. */
export function findBoneJoint(skin: Skin, name: string | undefined): number {
    if (!name) return -1;
    const names = skin.nodeNames;
    if (!names) return -1;
    let normHit = -1;
    const norm = normalizeBoneName(name);
    for (let j = 0; j < skin.joints.length; j++) {
        const nm = names.get(skin.joints[j].nodeIndex);
        if (!nm) continue;
        if (nm === name) return j;
        if (normHit < 0 && normalizeBoneName(nm) === norm) normHit = j;
    }
    return normHit;
}

/** Rigid rotation of a (possibly scaled) matrix's upper 3x3, by Gram-Schmidt. Never mat4.getRotation. */
export function rigidRotation(out: quat, m: mat4): quat {
    const x = vec3.normalize(vec3.create(), [m[0], m[1], m[2]]);
    const yRaw = vec3.fromValues(m[4], m[5], m[6]);
    const y = vec3.normalize(vec3.create(), vec3.scaleAndAdd(vec3.create(), yRaw, x, -vec3.dot(yRaw, x)));
    const z = vec3.cross(vec3.create(), x, y);
    // A mirrored matrix: keep the frame right-handed rather than inventing a reflection quat.
    return basisToQuat(out, x, y, z);
}

function basisToQuat(out: quat, x: vec3, y: vec3, z: vec3): quat {
    const m3 = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]] as unknown as Parameters<typeof quat.fromMat3>[1];
    quat.fromMat3(out, m3);
    return quat.normalize(out, out);
}

/** Bind model-space transform of every joint: inverse(inverseBindMatrix). */
function bindMatrices(skin: Skin): mat4[] {
    return skin.joints.map(j => {
        const m = mat4.create();
        if (!mat4.invert(m, j.inverseBindMatrix as mat4)) mat4.identity(m);
        return m;
    });
}

/** Rotate `v` toward `target` by `deg` degrees (in the plane they span). */
function turnToward(out: vec3, v: vec3, target: vec3, deg: number): vec3 {
    const axis = vec3.cross(vec3.create(), v, target);
    if (vec3.length(axis) < 1e-6 || Math.abs(deg) < 1e-6) return vec3.copy(out, v);
    vec3.normalize(axis, axis);
    const q = quat.setAxisAngle(quat.create(), axis, deg * DEG);
    return vec3.normalize(out, vec3.transformQuat(out, v, q));
}

/**
 * Resolve a profile against a skin in its bind pose. Parts naming a bone the skin does not have are
 * skipped; a part's parent is the nearest part up the skeleton.
 */
export function ragdollLayout(skin: Skin, profile: RagdollProfile): RagdollLayout {
    const bind = bindMatrices(skin);
    const topo = skeletonTopology(skin);
    const pos = bind.map(m => vec3.fromValues(m[12], m[13], m[14]));
    const axes = characterAxes(skin, pos);

    // Joint -> part index, for the parent walk.
    const resolved: { part: RagdollPart; joint: number; index: number }[] = [];
    const partOfJoint = new Map<number, number>();
    for (const part of profile.parts) {
        const j = findBoneJoint(skin, part.bone);
        if (j < 0 || partOfJoint.has(j)) continue;
        partOfJoint.set(j, resolved.length);
        resolved.push({ part, joint: j, index: resolved.length });
    }
    const massSum = resolved.reduce((s, r) => s + Math.max(0, r.part.massFraction), 0) || 1;

    const parts: RagdollLayoutPart[] = [];
    for (const { part, joint, index } of resolved) {
        let parent = -1;
        for (let p = topo.parentJoint[joint]; p >= 0; p = topo.parentJoint[p]) {
            const hit = partOfJoint.get(p);
            if (hit !== undefined) { parent = hit; break; }
        }

        const bonePos = pos[joint];
        const boneRotation = rigidRotation(quat.create(), bind[joint]);
        const tipJoint = findBoneJoint(skin, part.tipBone);
        const dir = vec3.create();
        let bindLength = 0;
        if (tipJoint >= 0) {
            vec3.sub(dir, pos[tipJoint], bonePos);
            bindLength = vec3.length(dir);
        }
        if (bindLength < 1e-6) {
            // No tip: along the bone's own Y axis, which is the bone direction on every common exporter.
            vec3.set(dir, bind[joint][4], bind[joint][5], bind[joint][6]);
            bindLength = 0;
        }
        if (vec3.length(dir) < 1e-9) vec3.copy(dir, axes.up);
        vec3.normalize(dir, dir);

        const radius = Math.max(1e-4, part.radius);
        let length = part.length ?? (bindLength > 0 ? bindLength : radius * 2);
        if (part.shape === 'sphere') length = radius * 2;
        length = Math.max(length, part.shape === 'capsule' ? radius * 2 : 1e-3);
        const depth = part.depth ?? radius * 2;

        // Body frame: Y along the segment, X toward the character's left where that is defined.
        const y = vec3.clone(dir);
        let x = vec3.scaleAndAdd(vec3.create(), axes.left, y, -vec3.dot(axes.left, y));
        if (vec3.length(x) < 1e-3) x = vec3.scaleAndAdd(vec3.create(), axes.forward, y, -vec3.dot(axes.forward, y));
        vec3.normalize(x, x);
        const z = vec3.cross(vec3.create(), x, y);
        const rotation = basisToQuat(quat.create(), x, y, z);
        // The segment starts at the joint: a capsule's cap and a box's end sit on it.
        const center = vec3.scaleAndAdd(vec3.create(), bonePos, dir, length / 2);

        // Joint frame.
        const jt = part.joint ?? defaultJoint();
        const childAxis = vec3.clone(dir);
        const parentAxis = vec3.clone(dir);
        let hingeAxis: vec3 | null = null;
        let coneAngle = Math.max(0, jt.swing) * DEG;
        const twistAngle = Math.max(0, jt.twist) * DEG;
        if (jt.type === 'hinge') {
            const bend = vec3.fromValues(...(jt.bendDir ?? [axes.forward[0], axes.forward[1], axes.forward[2]]));
            hingeAxis = vec3.cross(vec3.create(), dir, bend);
            if (vec3.length(hingeAxis) < 1e-6) hingeAxis = vec3.clone(axes.left);
            vec3.normalize(hingeAxis, hingeAxis);
            const lo = Math.min(jt.hingeMin, jt.hingeMax), hi = Math.max(jt.hingeMin, jt.hingeMax);
            const mid = quat.setAxisAngle(quat.create(), hingeAxis, (lo + hi) / 2 * DEG);
            vec3.transformQuat(parentAxis, dir, mid);
            coneAngle = Math.max(1, (hi - lo) / 2) * DEG;
        } else if (jt.type === 'cone' && jt.tilt) {
            turnToward(parentAxis, parentAxis, axes.forward, jt.tilt[0]);
            turnToward(parentAxis, parentAxis, vec3.negate(vec3.create(), axes.up), jt.tilt[1]);
        }

        parts.push({
            part, index, joint, node: skin.joints[joint].nodeIndex, parent,
            bonePos: vec3.clone(bonePos), center, rotation, boneRotation,
            length, radius, depth,
            mass: Math.max(0, part.massFraction) / massSum,
            pivot: vec3.clone(bonePos), childAxis, parentAxis, hingeAxis, coneAngle, twistAngle,
        });
    }
    return { parts, ...axes };
}

/**
 * Where a part's body sits for a live pose: its bone's world transform (`nodeWorld * boneMatrix *
 * bind`, where `boneMatrix` is the animator's final bone matrix) carried onto the part's bind frame.
 * Rigid rotation + uniform scale (model units -> world). Shared by the ragdoll and the editor preview.
 */
export function ragdollPartPose(skin: Skin, lp: RagdollLayoutPart, nodeWorld: mat4, boneMatrix: mat4):
        { center: vec3; rotation: quat; scale: number } {
    const bind = mat4.create();
    if (!mat4.invert(bind, skin.joints[lp.joint].inverseBindMatrix as mat4)) mat4.identity(bind);
    const world = mat4.multiply(mat4.create(), nodeWorld, boneMatrix);
    mat4.multiply(world, world, bind);
    const scale = Math.hypot(world[0], world[1], world[2]) / (Math.hypot(bind[0], bind[1], bind[2]) || 1);
    const boneRot = rigidRotation(quat.create(), world);
    const rel = quat.multiply(quat.create(), boneRot, quat.invert(quat.create(), lp.boneRotation));
    const offset = vec3.scale(vec3.create(), vec3.sub(vec3.create(), lp.center, lp.bonePos), scale);
    vec3.transformQuat(offset, offset, rel);
    const center = vec3.add(vec3.create(), [world[12], world[13], world[14]], offset);
    const rotation = quat.multiply(quat.create(), rel, lp.rotation);
    return { center, rotation, scale };
}

/**
 * The character's up / forward / left in bind model space. Up is +Y (every importer normalizes to it);
 * left comes from the sided bones (upper arms, else thighs), and forward completes the frame.
 */
function characterAxes(skin: Skin, pos: vec3[]): { up: vec3; forward: vec3; left: vec3 } {
    const up = vec3.fromValues(0, 1, 0);
    const rig = humanoidRigOf(skin);
    const left = vec3.fromValues(1, 0, 0);
    for (const [l, r] of [['upperArm.L', 'upperArm.R'], ['upLeg.L', 'upLeg.R'], ['shoulder.L', 'shoulder.R']]) {
        const a = rig.get(l), b = rig.get(r);
        if (a === undefined || b === undefined) continue;
        const ja = skin.joints.findIndex(j => j.nodeIndex === a), jb = skin.joints.findIndex(j => j.nodeIndex === b);
        if (ja < 0 || jb < 0) continue;
        const d = vec3.sub(vec3.create(), pos[ja], pos[jb]);
        d[1] = 0;
        if (vec3.length(d) > 1e-6) { vec3.normalize(left, d); break; }
    }
    const forward = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), left, up));
    return { up, forward, left };
}

// ---------------------------------------------------------------------------------------------------
// The automatic humanoid profile
// ---------------------------------------------------------------------------------------------------

/**
 * Anthropometric segment masses (Winter), as fractions of body mass. The trunk's 49.7% is split into
 * pelvis / abdomen / thorax; head includes the neck.
 */
const MASS = {
    pelvis: 0.142, spine: 0.139, chest: 0.216, head: 0.081,
    upperArm: 0.028, foreArm: 0.016, hand: 0.006,
    thigh: 0.100, shin: 0.0465, foot: 0.0145,
};

/**
 * A 15-part human ragdoll fitted to a skeleton, or null when the skeleton is not recognizably humanoid
 * (no hips, no legs). Sizes are fractions of the bones they cover, so any scale or proportion fits.
 */
export function autoHumanoidProfile(skin: Skin): RagdollProfile | null {
    const rig = humanoidRigOf(skin);
    const names = skin.nodeNames;
    if (!names) return null;
    const need = ['hips', 'upLeg.L', 'upLeg.R', 'leg.L', 'leg.R'];
    if (need.some(s => !rig.has(s))) return null;

    const bind = bindMatrices(skin);
    const pos = bind.map(m => vec3.fromValues(m[12], m[13], m[14]));
    const jointOfNode = new Map(skin.joints.map((j, i) => [j.nodeIndex, i] as const));
    const nameOf = (slot: string) => { const n = rig.get(slot); return n === undefined ? undefined : names.get(n); };
    const posOf = (slot: string) => { const n = rig.get(slot); const j = n === undefined ? undefined : jointOfNode.get(n); return j === undefined ? null : pos[j]; };
    const dist = (a: string, b: string) => { const p = posOf(a), q = posOf(b); return p && q ? vec3.distance(p, q) : 0; };
    const axes = characterAxes(skin, pos);
    const topo = skeletonTopology(skin);

    // A child joint of `slot` (the first one, or the one furthest along) -- for tips with no slot.
    const childOf = (slot: string, pick: 'first' | 'far' = 'far'): string | undefined => {
        const n = rig.get(slot);
        const j = n === undefined ? undefined : jointOfNode.get(n);
        if (j === undefined) return undefined;
        let best = -1, bestD = -1;
        for (let c = 0; c < skin.joints.length; c++) {
            if (topo.parentJoint[c] !== j) continue;
            const d = vec3.distance(pos[c], pos[j]);
            if (pick === 'first') { best = c; break; }
            if (d > bestD) { bestD = d; best = c; }
        }
        return best >= 0 ? names.get(skin.joints[best].nodeIndex) : undefined;
    };

    const height = (() => {
        const head = posOf('head') ?? posOf('neck') ?? posOf('chest') ?? posOf('hips')!;
        const foot = posOf('foot.L') ?? posOf('leg.L')!;
        return Math.max(1e-3, head[1] - foot[1] + dist('neck', 'head') * 2);
    })();
    const hipWidth = dist('upLeg.L', 'upLeg.R') || height * 0.1;
    const shoulderWidth = dist('upperArm.L', 'upperArm.R') || hipWidth * 1.8;

    const parts: RagdollPart[] = [];
    const cone = (swing: number, twist: number, tilt?: [number, number]): RagdollJoint =>
        ({ type: 'cone', swing, twist, hingeMin: 0, hingeMax: 0, ...(tilt ? { tilt } : {}) });
    const hinge = (min: number, max: number, bend: vec3): RagdollJoint =>
        ({ type: 'hinge', swing: 0, twist: 0, hingeMin: min, hingeMax: max, bendDir: [bend[0], bend[1], bend[2]] });

    // ----- torso ----------------------------------------------------------------------------------
    const hasSpine = rig.has('spine');
    const hasChest = rig.has('chest');
    const neckSlot = rig.has('neck') ? 'neck' : rig.has('head') ? 'head' : null;
    const torsoTop = neckSlot ? posOf(neckSlot)! : vec3.scaleAndAdd(vec3.create(), posOf('hips')!, axes.up, height * 0.3);
    const pelvisTip = hasSpine ? 'spine' : hasChest ? 'chest' : neckSlot;
    parts.push({
        name: 'Pelvis', bone: nameOf('hips')!, tipBone: pelvisTip ? nameOf(pelvisTip) : undefined, shape: 'box',
        radius: hipWidth * 0.8, length: Math.max(dist('hips', pelvisTip ?? 'hips'), height * 0.09), depth: hipWidth * 1.1,
        massFraction: MASS.pelvis + (hasSpine ? 0 : MASS.spine) + (hasSpine || hasChest ? 0 : MASS.chest),
        joint: cone(0, 0),
    });
    if (hasSpine) {
        const tip = hasChest ? 'chest' : neckSlot;
        const len = tip ? dist('spine', tip) : height * 0.15;
        parts.push({
            name: 'Spine', bone: nameOf('spine')!, tipBone: tip ? nameOf(tip) : undefined, shape: 'capsule',
            radius: Math.min(shoulderWidth * 0.34, Math.max(hipWidth * 0.6, len * 0.4)),
            massFraction: MASS.spine + (hasChest ? 0 : MASS.chest), joint: cone(25, 45, [0, 0]),
        });
    }
    if (hasChest) {
        const chestLen = vec3.distance(posOf('chest')!, torsoTop);
        parts.push({
            name: 'Chest', bone: nameOf('chest')!, tipBone: neckSlot ? nameOf(neckSlot) : undefined, shape: 'box',
            radius: shoulderWidth * 0.42, length: Math.max(chestLen, height * 0.12), depth: shoulderWidth * 0.55,
            massFraction: MASS.chest, joint: cone(20, 45),
        });
    }

    // ----- head -------------------------------------------------------------------------------------
    if (rig.has('head')) {
        // On the NECK when there is one, so the neck bends; the capsule runs up to the top of the skull.
        const headTop = childOf('head');
        const topJ = findBoneJoint(skin, headTop);
        const span = topJ >= 0 ? vec3.distance(posOf('head')!, pos[topJ]) : height * 0.11;
        const bone = rig.has('neck') ? 'neck' : 'head';
        const r = Math.max(span * 0.5, height * 0.05);
        const len = topJ >= 0 ? vec3.distance(posOf(bone)!, pos[topJ]) : span + dist(bone, 'head');
        parts.push({
            name: 'Head', bone: nameOf(bone)!, ...(headTop ? { tipBone: headTop } : {}), shape: 'capsule',
            radius: r, length: Math.max(len, r * 2), massFraction: MASS.head, joint: cone(35, 60),
        });
    }

    // ----- limbs ------------------------------------------------------------------------------------
    const down = vec3.negate(vec3.create(), axes.up);
    const back = vec3.negate(vec3.create(), axes.forward);
    for (const side of ['L', 'R'] as const) {
        const S = side === 'L' ? 'L' : 'R';
        if (rig.has(`upperArm.${S}`) && rig.has(`foreArm.${S}`)) {
            const upLen = dist(`upperArm.${S}`, `foreArm.${S}`);
            // The neutral arm hangs 45 degrees below horizontal; tilt whatever the bind is toward that.
            const armDir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), posOf(`foreArm.${S}`)!, posOf(`upperArm.${S}`)!));
            const below = Math.asin(Math.max(-1, Math.min(1, vec3.dot(armDir, down)))) / DEG;
            parts.push({
                name: `Upper Arm ${side}`, bone: nameOf(`upperArm.${S}`)!, tipBone: nameOf(`foreArm.${S}`), shape: 'capsule',
                radius: upLen * 0.17, massFraction: MASS.upperArm, joint: cone(80, 50, [20, Math.max(0, 45 - below)]),
            });
            if (rig.has(`hand.${S}`)) {
                const foreLen = dist(`foreArm.${S}`, `hand.${S}`);
                parts.push({
                    name: `Forearm ${side}`, bone: nameOf(`foreArm.${S}`)!, tipBone: nameOf(`hand.${S}`), shape: 'capsule',
                    radius: foreLen * 0.14, massFraction: MASS.foreArm, joint: hinge(0, 140, axes.forward),
                });
                const finger = nameOf(`middle1.${S}`) ?? nameOf(`index1.${S}`) ?? childOf(`hand.${S}`, 'first');
                const fingerJ = findBoneJoint(skin, finger);
                const palm = fingerJ >= 0 ? vec3.distance(pos[fingerJ], posOf(`hand.${S}`)!) : foreLen * 0.35;
                parts.push({
                    name: `Hand ${side}`, bone: nameOf(`hand.${S}`)!, tipBone: finger, shape: 'capsule',
                    radius: Math.max(palm * 0.36, foreLen * 0.08), length: palm * 1.6, depth: Math.max(palm * 0.35, foreLen * 0.07),
                    massFraction: MASS.hand, joint: cone(55, 90),
                });
            }
        }

        const thighLen = dist(`upLeg.${S}`, `leg.${S}`);
        parts.push({
            name: `Thigh ${side}`, bone: nameOf(`upLeg.${S}`)!, tipBone: nameOf(`leg.${S}`), shape: 'capsule',
            radius: thighLen * 0.17, massFraction: MASS.thigh, joint: cone(65, 45, [25, 0]),
        });
        if (rig.has(`foot.${S}`)) {
            const shinLen = dist(`leg.${S}`, `foot.${S}`);
            parts.push({
                name: `Shin ${side}`, bone: nameOf(`leg.${S}`)!, tipBone: nameOf(`foot.${S}`), shape: 'capsule',
                radius: shinLen * 0.12, massFraction: MASS.shin, joint: hinge(0, 140, back),
            });
            const toe = nameOf(`toe.${S}`) ?? childOf(`foot.${S}`, 'first');
            const toeJ = findBoneJoint(skin, toe);
            const footLen = toeJ >= 0 ? vec3.distance(pos[toeJ], posOf(`foot.${S}`)!) : shinLen * 0.3;
            parts.push({
                name: `Foot ${side}`, bone: nameOf(`foot.${S}`)!, tipBone: toe, shape: 'capsule',
                radius: Math.max(footLen * 0.22, shinLen * 0.07), length: footLen * 1.35,
                massFraction: MASS.foot, joint: cone(30, 90),
            });
        }
    }

    return { ...RAGDOLL_PROFILE_DEFAULTS, parts };
}

/** The profile a skin ragdolls with: its authored one, else the automatic humanoid, else none. */
export function effectiveRagdollProfile(skin: Skin): { profile: RagdollProfile | null; source: 'rig' | 'auto' | 'generic' } {
    if (skin.ragdollProfile && skin.ragdollProfile.parts?.length) return { profile: skin.ragdollProfile, source: 'rig' };
    const auto = autoHumanoidProfile(skin);
    return auto ? { profile: auto, source: 'auto' } : { profile: null, source: 'generic' };
}

/** Tolerant reader for a stored profile: anything unusable is null rather than a throw. */
export function parseRagdollProfile(raw: unknown): RagdollProfile | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Partial<RagdollProfile>;
    if (!Array.isArray(r.parts)) return undefined;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const parts: RagdollPart[] = [];
    for (const p of r.parts as Partial<RagdollPart>[]) {
        if (!p || typeof p.bone !== 'string') continue;
        const j = (p.joint ?? {}) as Partial<RagdollJoint>;
        parts.push({
            name: typeof p.name === 'string' ? p.name : p.bone,
            bone: p.bone,
            ...(typeof p.tipBone === 'string' ? { tipBone: p.tipBone } : {}),
            shape: p.shape === 'box' || p.shape === 'sphere' ? p.shape : 'capsule',
            radius: num(p.radius, 0.05),
            ...(typeof p.length === 'number' ? { length: p.length } : {}),
            ...(typeof p.depth === 'number' ? { depth: p.depth } : {}),
            massFraction: num(p.massFraction, 0.05),
            joint: {
                type: j.type === 'hinge' || j.type === 'fixed' ? j.type : 'cone',
                swing: num(j.swing, 45), twist: num(j.twist, 30),
                hingeMin: num(j.hingeMin, 0), hingeMax: num(j.hingeMax, 120),
                ...(Array.isArray(j.tilt) && j.tilt.length === 2 ? { tilt: [num(j.tilt[0], 0), num(j.tilt[1], 0)] as [number, number] } : {}),
                ...(Array.isArray(j.bendDir) && j.bendDir.length === 3 ? { bendDir: j.bendDir.map(v => num(v, 0)) as [number, number, number] } : {}),
            },
        });
    }
    return {
        version: 1,
        totalMass: num(r.totalMass, RAGDOLL_PROFILE_DEFAULTS.totalMass),
        parts,
        selfCollision: typeof r.selfCollision === 'boolean' ? r.selfCollision : RAGDOLL_PROFILE_DEFAULTS.selfCollision,
        linearDamping: num(r.linearDamping, RAGDOLL_PROFILE_DEFAULTS.linearDamping),
        angularDamping: num(r.angularDamping, RAGDOLL_PROFILE_DEFAULTS.angularDamping),
        solverIterations: num(r.solverIterations, RAGDOLL_PROFILE_DEFAULTS.solverIterations),
    };
}
