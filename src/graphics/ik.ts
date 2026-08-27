import { quat, vec3 } from 'gl-matrix';
import { clamp } from '../core/math';

// ---------------------------------------------------------------------------
// Inverse kinematics. Pure vec3/quat maths — no GL, no scene, no engine imports.
// The two-bone solver is analytic (law of cosines), not iterative.
// ---------------------------------------------------------------------------

/**
 * How far a limb may extend towards a target, as a fraction of its own length. Never 1 — a perfectly
 * straight limb is a singularity with no bend plane.
 */
export const DEFAULT_MAX_REACH = 0.999;

export interface TwoBoneSolve {
    /** Current joint positions. Any one consistent space — the result is expressed in the same one. */
    root: vec3;
    mid: vec3;
    tip: vec3;
    /** Where the tip should end up. */
    target: vec3;
    /**
     * A point the mid joint should bend towards — a knee's "forward". Omit or null to preserve the bend
     * plane the animated pose is already in, which is what foot placement wants.
     */
    pole?: vec3 | null;
    /** Fraction of full extension the limb may reach. Default 0.99; never 1 — see {@link DEFAULT_MAX_REACH}. */
    maxReach?: number;
}

export interface TwoBoneResult {
    /** Rotation to apply ON TOP of the root bone's current orientation. */
    rootDelta: quat;
    /** Rotation to apply ON TOP of the mid bone's current orientation, after `rootDelta` has been applied. */
    midDelta: quat;
    /** False when the target was out of reach and the limb is pointing at it fully extended instead. */
    reached: boolean;
}

/** Shared defaults for the foot-placement pass. Single source of truth for the engine and the editor UI. */
export interface IkRigTuning {
    /** Distance from the ankle joint down to the sole, in model units. The ankle is placed this far up. */
    footHeight: number;
    /** How far above the animated foot the ground ray starts. Covers a foot posed below the real surface. */
    traceUp: number;
    /** How far below the animated foot the ray reaches. Beyond this the foot is treated as airborne. */
    traceDown: number;
    /**
     * How far a foot must rise above the most-planted foot before IK releases it, in model units — the
     * swing/stance split. A foot at or below its ground keeps full correction; 0 disables the release.
     */
    swingRelease: number;
    /** Most the pelvis may be lowered, in model units. Stops a hole in the ground folding the character up. */
    maxHipDrop: number;
    /** Surfaces steeper than this do not rotate the foot — past it, matching the surface looks like a break. */
    maxSlopeDeg: number;
    /** Seconds, as a time constant, for the per-foot weight and the hip offset to follow their targets. */
    smoothing: number;
}

export const IK_DEFAULTS: IkRigTuning = {
    footHeight: 0.1,
    traceUp: 0.5,
    traceDown: 0.6,
    // A full human stride lifts the ankle about this far, so a standing or idling character (where both feet
    // sit at the same height) is untouched and only a real swing releases.
    swingRelease: 0.2,
    maxHipDrop: 0.5,
    maxSlopeDeg: 45,
    smoothing: 0.12,
};

/** One leg: three joints, plus the toe when the rig has one. NODE indices, matching `Skin.joints[].nodeIndex`. */
export interface IkFootChain {
    thigh: number;
    shin: number;
    foot: number;
    toe?: number;
}

/** A character's IK setup. Lives on the {@link Skin}: the fields are joint indices into that skeleton. */
export interface IkRig extends Partial<IkRigTuning> {
    /** The pelvis. Lowered when a foot cannot reach its target. Omit to disable hip lowering. */
    hips?: number;
    feet: IkFootChain[];
}

/** A rig with every tuning value filled in. */
export function ikTuning(rig: IkRig | null | undefined): IkRigTuning {
    const num = (v: number | undefined, fallback: number) =>
        typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback;
    return {
        footHeight: num(rig?.footHeight, IK_DEFAULTS.footHeight),
        traceUp: num(rig?.traceUp, IK_DEFAULTS.traceUp),
        traceDown: num(rig?.traceDown, IK_DEFAULTS.traceDown),
        swingRelease: num(rig?.swingRelease, IK_DEFAULTS.swingRelease),
        maxHipDrop: num(rig?.maxHipDrop, IK_DEFAULTS.maxHipDrop),
        maxSlopeDeg: num(rig?.maxSlopeDeg, IK_DEFAULTS.maxSlopeDeg),
        smoothing: num(rig?.smoothing, IK_DEFAULTS.smoothing),
    };
}

/** One thing wrong with a rig, in words a person can act on. */
export interface IkRigProblem {
    /** Index into `rig.feet`, or -1 for a problem with the rig as a whole (the hips). */
    leg: number;
    message: string;
}

export interface IkRigValidation {
    /** The chains that are safe to solve. Everything else was rejected. */
    feet: IkFootChain[];
    /** The hips, or undefined when unset or unusable. */
    hips?: number;
    problems: IkRigProblem[];
}

/**
 * Check that a rig describes chains the solver can use, reporting what is wrong with the rest. Tests the
 * skeleton hierarchy, not bone names — the right names can still sit on unrelated parts of a rig.
 */
export function validateIkRig(
    rig: IkRig | null | undefined,
    topo: { jointOfNode: Map<number, number>; parentJoint: number[] },
    isAncestor: (topo: any, ancestor: number, descendant: number) => boolean,
    nameOf?: (nodeIndex: number) => string,
): IkRigValidation {
    const problems: IkRigProblem[] = [];
    if (!rig) return { feet: [], problems };

    const label = (node: number) => nameOf?.(node) ?? `node ${node}`;
    const jointOf = (node: number | undefined): number =>
        node === undefined || node < 0 ? -1 : topo.jointOfNode.get(node) ?? -1;

    const feet: IkFootChain[] = [];
    const claimed = new Map<number, number>();   // node -> the leg that already uses it

    (rig.feet ?? []).forEach((chain, i) => {
        const reject = (message: string) => { problems.push({ leg: i, message }); };

        const roles: [string, number | undefined][] = [
            ['thigh', chain.thigh], ['shin', chain.shin], ['foot', chain.foot],
        ];
        // A half-assigned chain is the normal state while someone is picking bones, so it is reported as
        // incomplete rather than as broken.
        const missing = roles.filter(([, node]) => node === undefined || node < 0).map(([role]) => role);
        if (missing.length) { reject(`incomplete — no ${missing.join(', ')} assigned`); return; }

        const nodes = [chain.thigh, chain.shin, chain.foot, ...(chain.toe !== undefined ? [chain.toe] : [])];
        const jointIdx = nodes.map(jointOf);
        const notJoints = nodes.filter((_, k) => jointIdx[k] < 0);
        if (notJoints.length) {
            reject(`${notJoints.map(label).join(', ')} ${notJoints.length > 1 ? 'are' : 'is'} not a bone of this skeleton`);
            return;
        }

        if (new Set(nodes).size !== nodes.length) { reject('the same bone is used for more than one role'); return; }

        // Strictly descending. A leg is a chain; if the shin is not beneath the thigh, rotating the thigh
        // does not move the foot and the solve is meaningless however good the numbers look.
        const order: [string, number, string, number][] = [
            ['thigh', jointIdx[0], 'shin', jointIdx[1]],
            ['shin', jointIdx[1], 'foot', jointIdx[2]],
        ];
        if (chain.toe !== undefined) order.push(['foot', jointIdx[2], 'toe', jointIdx[3]]);
        const broken = order.find(([, a, , b]) => !isAncestor(topo, a, b));
        if (broken) {
            reject(`${label(nodes[order.indexOf(broken) + 1])} (${broken[2]}) is not beneath `
                + `${label(nodes[order.indexOf(broken)])} (${broken[0]}) in the skeleton — not a connected leg`);
            return;
        }

        const shared = nodes.find(n => claimed.has(n));
        if (shared !== undefined) {
            reject(`${label(shared)} is already used by leg ${claimed.get(shared)! + 1}`);
            return;
        }
        for (const n of nodes) claimed.set(n, i);
        feet.push(chain);
    });

    // Hips last, so it is judged against the chains that survived.
    let hips = rig.hips;
    if (hips !== undefined && hips >= 0) {
        const hipsJoint = jointOf(hips);
        if (hipsJoint < 0) {
            problems.push({ leg: -1, message: `hips ${label(hips)} is not a bone of this skeleton` });
            hips = undefined;
        } else {
            const orphan = feet.find(c => !isAncestor(topo, hipsJoint, jointOf(c.thigh)));
            if (orphan) {
                problems.push({
                    leg: -1,
                    message: `hips ${label(hips)} is not above ${label(orphan.thigh)} — lowering it would not `
                        + `move that leg, so hip lowering is disabled`,
                });
                hips = undefined;
            }
        }
    }

    return { feet, hips, problems };
}

/**
 * How much of a foot's ground correction survives, given `lift` above the most-planted foot: a smoothstep
 * from 1 down to 0 over `swingRelease`. `lift <= 0` and `swingRelease <= 0` both return 1.
 */
export function swingReleaseWeight(lift: number, swingRelease: number): number {
    if (!(swingRelease > 0)) return 1;
    const t = clamp(lift / swingRelease, 0, 1);
    return 1 - t * t * (3 - 2 * t);
}

/** Any axis perpendicular to `v`. Used only when a limb is straight and has no bend plane of its own. */
function anyPerpendicular(out: vec3, v: vec3): vec3 {
    // Cross with whichever cardinal axis `v` is least aligned to, so the cross product is never degenerate.
    const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
    const axis: vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    vec3.cross(out, v, axis);
    return vec3.normalize(out, out);
}

/**
 * Bend a two-bone chain so its tip reaches `target`. Returns rotation DELTAS, not absolute orientations,
 * so the caller composes them onto the bind and animated pose it already holds.
 */
export function solveTwoBone(s: TwoBoneSolve): TwoBoneResult {
    const rootDelta = quat.create();
    const midDelta = quat.create();

    const upper = vec3.sub(vec3.create(), s.mid, s.root);
    const lower = vec3.sub(vec3.create(), s.tip, s.mid);
    const a = vec3.length(upper);
    const b = vec3.length(lower);

    const toTip = vec3.sub(vec3.create(), s.tip, s.root);
    const toTarget = vec3.sub(vec3.create(), s.target, s.root);
    const tipDist = vec3.length(toTip);
    let d = vec3.length(toTarget);

    // A zero-length bone, or a target sitting exactly on the root, leaves nothing to solve and every
    // normalization below undefined. Identity is the honest answer.
    if (a < 1e-8 || b < 1e-8 || d < 1e-8 || tipDist < 1e-8) return { rootDelta, midDelta, reached: false };

    const maxReach = (a + b) * (typeof s.maxReach === 'number' && s.maxReach > 0 ? s.maxReach : DEFAULT_MAX_REACH);
    const reached = d <= maxReach;
    if (!reached) d = maxReach;

    // Solve the joint POSITIONS first, then read the rotations off them. Composing interior-angle
    // deltas directly is a sign-and-ordering trap.

    // Bend axis: normal to the plane the joint bends in, taken from the limb's own pose
    // (`cross(upper, lower)`) and never from the target — a target-relative axis flips sign mid-motion.
    // It degenerates on a perfectly straight limb, so the fallbacks below are the common path.
    const dirTarget = vec3.normalize(vec3.create(), toTarget);
    const bendAxis = vec3.create();
    if (s.pole) {
        // An explicit pole overrides the pose: saying where the knee should point is the entire purpose of
        // supplying one.
        const toPole = vec3.sub(vec3.create(), s.pole, s.root);
        vec3.cross(bendAxis, toPole, toTarget);
    }
    if (vec3.length(bendAxis) < 1e-6) vec3.cross(bendAxis, upper, lower);

    // The axis must be perpendicular to the limb axis; a tilted one sweeps a cone and the tip lands short.
    vec3.scaleAndAdd(bendAxis, bendAxis, dirTarget, -vec3.dot(bendAxis, dirTarget));

    // Straight limb, no pole, or a pole sitting on the limb axis: nothing prefers one side, so any
    // perpendicular is equally correct.
    if (vec3.length(bendAxis) < 1e-6) anyPerpendicular(bendAxis, dirTarget);
    vec3.normalize(bendAxis, bendAxis);

    // Law of cosines. Clamp before acos: a straight limb yields 1.0000000001 and acos of that is NaN.
    const rootAngle = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));

    // NEGATIVE, so the joint swings towards the side `bendRef` is on rather than away from it. This is the
    // sign that decides whether a knee bends forwards or backwards through the character's own shin.
    const newUpperDir = vec3.transformQuat(
        vec3.create(), dirTarget, quat.setAxisAngle(quat.create(), bendAxis, -rootAngle));

    const newMid = vec3.scaleAndAdd(vec3.create(), s.root, newUpperDir, a);
    const newTip = vec3.scaleAndAdd(vec3.create(), s.root, dirTarget, d);

    // Root: where the upper bone pointed, to where it points now.
    const dirUpper = vec3.normalize(vec3.create(), upper);
    quat.rotationTo(rootDelta, dirUpper, newUpperDir);

    // Mid: the lower bone has already been carried along by the root's rotation, so the delta is measured
    // from where THAT left it — not from its original direction. Missing this is what corkscrews a shin.
    const dirLower = vec3.normalize(vec3.create(), lower);
    const dirLowerAfterRoot = vec3.transformQuat(vec3.create(), dirLower, rootDelta);
    const dirNewLower = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), newTip, newMid));
    quat.rotationTo(midDelta, dirLowerAfterRoot, dirNewLower);

    quat.normalize(rootDelta, rootDelta);
    quat.normalize(midDelta, midDelta);
    return { rootDelta, midDelta, reached };
}

/** Where the three joints end up after {@link solveTwoBone}'s deltas are applied. Positions only. */
export function applyTwoBone(s: TwoBoneSolve, r: TwoBoneResult): { root: vec3; mid: vec3; tip: vec3 } {
    const upper = vec3.sub(vec3.create(), s.mid, s.root);
    const lower = vec3.sub(vec3.create(), s.tip, s.mid);

    const newUpper = vec3.transformQuat(vec3.create(), upper, r.rootDelta);
    // `midDelta * rootDelta`, not the reverse: gl-matrix applies the right-hand factor first, and the
    // lower bone is carried by the root's rotation before it takes its own.
    const combined = quat.multiply(quat.create(), r.midDelta, r.rootDelta);
    const newLower = vec3.transformQuat(vec3.create(), lower, combined);

    const mid = vec3.add(vec3.create(), s.root, newUpper);
    const tip = vec3.add(vec3.create(), mid, newLower);
    return { root: vec3.clone(s.root), mid, tip };
}
