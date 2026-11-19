import { quat, vec3 } from 'gl-matrix';
import { clamp, nonNegativeOr, smoothstep } from '../core/math';

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
     * The collision layers the foot rays land on (a mask, collisionLayers.ts; -1, the default, is every layer).
     * Leave out the layer of a walking ramp laid over stairs for the character's capsule, and keep the layer
     * of the steps themselves (which the capsule's Collides with leaves out): the body climbs the ramp, the
     * feet stand on the treads.
     */
    traceLayers: number;
    /**
     * How far the ANIMATION must lift a foot above the lowest foot before IK releases it, in model units —
     * the swing/stance split. Measured in the clip, not against the ground, so a slope is never mistaken for a
     * stride. A foot inside its ground is pushed out even mid-swing; 0 disables the release.
     */
    swingRelease: number;
    /** Most the pelvis may be lowered, in model units. Stops a hole in the ground folding the character up. */
    maxHipDrop: number;
    /** Surfaces steeper than this do not rotate the foot — past it, matching the surface looks like a break. */
    maxSlopeDeg: number;
    /** Seconds, as a time constant, for the per-foot weight and the hip offset to follow their targets. */
    smoothing: number;
    /**
     * Foot locking, 0..1 (Advanced Locomotion System's): how firmly a foot the animation has planted holds its
     * spot and heading on the ground while the body moves or turns over it. Without it a planted foot rides
     * round with a turning body and the character glides. 0, the default, is off.
     */
    footLock: number;
    /**
     * World units per second. A foot plants when the animation lifts or lowers it slower than this, and moves it
     * over the ground slower than this plus 1.5 times the body's own speed: a swing crosses the ground at twice
     * the body's speed, a planted foot at none (or, while a blend catches up with a turn, at the slide it is
     * given, which is the foot to hold).
     */
    lockSpeed: number;
    /** ...and holds it no higher than this above the lowest animated foot (the swing-release reference). */
    lockHeight: number;
    /** Seconds a lifted foot takes to blend from where it was planted back to where the animation has it. */
    lockRelease: number;
    /**
     * Seconds a foot takes to blend INTO its lock once it plants: its slide eased to a stop rather than caught in
     * one frame. 0, the default, locks at once.
     */
    lockBlendIn: number;
    /** How the lock weight runs between 0 and 1, both ways: straight (`'linear'`, the default) or eased (`'smooth'`). */
    lockBlendCurve: FootLockCurve;
    /**
     * The fastest a foot may be sliding over the ground (world units a second) for a lock to catch it. A foot the
     * animation slides faster (a cross-fade into a run still blending in the standing pose, a blend catching up
     * with a turn) plants once it has slowed. Catching it stops the foot dead in a few frames and leaves the leg
     * stretched after it until the lock lets go: a snap each way. 0, the default, catches any.
     */
    lockCatchSpeed: number;
    /**
     * The farthest a planted foot may be left from where the animation has it (world units) before it lets go.
     * Its heading is held up to {@link FOOT_LOCK_MAX_TWIST} degrees off the animation's, and turns with the
     * animation past that. A body that jumps further than this in one frame (a teleport) lets go at once.
     */
    lockDistance: number;
}

export const IK_DEFAULTS: IkRigTuning = {
    footHeight: 0.1,
    traceUp: 0.5,
    traceDown: 0.6,
    traceLayers: -1,
    // A full human stride lifts the ankle about this far, so a standing or idling character (where the clip
    // keeps both feet at the same height, whatever the ground under them does) is untouched and only a real
    // swing releases.
    swingRelease: 0.2,
    maxHipDrop: 0.5,
    maxSlopeDeg: 45,
    smoothing: 0.12,
    footLock: 0,
    lockSpeed: 0.5,
    lockHeight: 0.03,
    lockRelease: 0.15,
    lockDistance: 0.35,
    lockBlendIn: 0,
    lockBlendCurve: 'linear',
    lockCatchSpeed: 0,
};

/** The shape of a foot lock's blend: see `IkRigTuning.lockBlendCurve`. */
export type FootLockCurve = 'linear' | 'smooth';
export const FOOT_LOCK_CURVES: readonly FootLockCurve[] = ['linear', 'smooth'];

/** A lock's weight for its 0..1 progress, by the rig's curve. */
export function footLockWeight(alpha: number, curve: FootLockCurve): number {
    const a = clamp(alpha, 0, 1);
    return curve === 'smooth' ? a * a * (3 - 2 * a) : a;
}

/** The most a locked foot is turned from its animated heading, in degrees; past it the foot turns with the clip. */
export const FOOT_LOCK_MAX_TWIST = 40;

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
    return {
        footHeight: nonNegativeOr(rig?.footHeight, IK_DEFAULTS.footHeight),
        traceUp: nonNegativeOr(rig?.traceUp, IK_DEFAULTS.traceUp),
        traceDown: nonNegativeOr(rig?.traceDown, IK_DEFAULTS.traceDown),
        traceLayers: typeof rig?.traceLayers === 'number' && Number.isFinite(rig.traceLayers) ? Math.trunc(rig.traceLayers) : IK_DEFAULTS.traceLayers,
        swingRelease: nonNegativeOr(rig?.swingRelease, IK_DEFAULTS.swingRelease),
        maxHipDrop: nonNegativeOr(rig?.maxHipDrop, IK_DEFAULTS.maxHipDrop),
        maxSlopeDeg: nonNegativeOr(rig?.maxSlopeDeg, IK_DEFAULTS.maxSlopeDeg),
        smoothing: nonNegativeOr(rig?.smoothing, IK_DEFAULTS.smoothing),
        footLock: clamp(nonNegativeOr(rig?.footLock, IK_DEFAULTS.footLock), 0, 1),
        lockSpeed: nonNegativeOr(rig?.lockSpeed, IK_DEFAULTS.lockSpeed),
        lockHeight: nonNegativeOr(rig?.lockHeight, IK_DEFAULTS.lockHeight),
        lockRelease: nonNegativeOr(rig?.lockRelease, IK_DEFAULTS.lockRelease),
        lockDistance: Math.max(1e-3, nonNegativeOr(rig?.lockDistance, IK_DEFAULTS.lockDistance)),
        lockBlendIn: nonNegativeOr(rig?.lockBlendIn, IK_DEFAULTS.lockBlendIn),
        lockBlendCurve: FOOT_LOCK_CURVES.includes(rig?.lockBlendCurve as FootLockCurve) ? rig!.lockBlendCurve as FootLockCurve : IK_DEFAULTS.lockBlendCurve,
        lockCatchSpeed: nonNegativeOr(rig?.lockCatchSpeed, IK_DEFAULTS.lockCatchSpeed),
    };
}

/** What a foot lock does this frame: see {@link stepFootLock}. */
export type FootLockStep = 'plant' | 'hold' | 'release' | 'drop';

/**
 * One frame of a foot lock: its 0..1 progress `alpha` (the weight, through the rig's curve) and whether the foot is
 * `planted` (between its plant and its release, whatever the weight has reached).
 *
 *   `lockable`  the animation has the foot planted this frame (its window, or detection);
 *   `stray`     how far the animated foot has got from the lock, as a share of `lockDistance`. Ignored while
 *               nothing is locked.
 *
 * Updates `lock` and returns what to do with the lock point:
 *
 *   plant    take a new one, where the foot is SHOWN now, so nothing jumps;
 *   hold     keep it (alpha rising over `lockBlendIn`, or already 1);
 *   release  keep it while alpha falls over `lockRelease`: the foot lifted, or was left too far behind;
 *   drop     forget it, alpha 0 (faded out, or a planted foot strayed past twice the limit: a teleport).
 *
 * With a blend-in, a foot planted again while its last lock is still fading keeps that lock and rises again from
 * where it is: the foot is shown part-way to that point, so any other point would make it jump. Without one (the
 * default) it re-plants where it is shown, at full weight, as foot locking always has.
 */
export function stepFootLock(
    lock: { alpha: number; planted?: boolean },
    lockable: boolean,
    stray: number,
    dt: number,
    tuning: Pick<IkRigTuning, 'lockRelease'> & Partial<Pick<IkRigTuning, 'lockBlendIn'>>,
): FootLockStep {
    const held = lock.alpha > 0;
    const blendIn = tuning.lockBlendIn ?? 0;
    // Only a foot still planted in the animation is dropped for straying: one already lifting swings away from
    // its lock fast by nature, and must finish fading out rather than snap.
    if (held && lockable && stray > 2) { lock.alpha = 0; lock.planted = false; return 'drop'; }
    if (lockable && (!held || stray <= 1)) {
        lock.planted = true;
        if (blendIn > 0) {
            lock.alpha = Math.min(1, lock.alpha + Math.max(0, dt) / blendIn);
            return held ? 'hold' : 'plant';
        }
        if (lock.alpha >= 1) return 'hold';
        lock.alpha = 1;
        return 'plant';
    }
    lock.planted = false;
    if (!held) return 'drop';
    lock.alpha = tuning.lockRelease > 0 ? Math.max(0, lock.alpha - Math.max(0, dt) / tuning.lockRelease) : 0;
    return lock.alpha > 0 ? 'release' : 'drop';
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

/**
 * Where a leg's knee should point, as a POLE for {@link solveTwoBone}.
 *
 * A knee animated with a clear bend keeps the clip's own bend plane — a walk cycle's knee already knows
 * where it goes. But a leg animated near-straight (a standing frame, a T-pose bind, the planted leg of a
 * stride) has no bend plane worth reading: `cross(upper, lower)` is noise, and the two legs of one rig
 * disagree — one folding forward, the other out sideways or back through the shin. Below
 * `minBend` (a fraction of the leg's length), or when the clip's knee points BEHIND the character, the
 * knee is sent along `forward` instead: both legs fold the same way, the way knees do.
 *
 * Never by a switch: the pole turns from the clip's bend to `forward` over a band of bend size (half `minBend` to
 * `minBend`) and of direction (a knee out to the side, even a little behind it, is a strafe's real step; one
 * pointing well behind, past about 115 degrees, is a straight leg's noise). A hard switch at "behind" flipped a
 * strafing knee that swung out sideways from its bend to straight ahead and back as it crossed the line: the knee
 * jumped 20 to 30 cm in a frame whenever a foot lock or foot placement was solving the leg.
 *
 * `forward` is the character's facing in the same space as the joints, flattened onto the ground plane.
 * Returns undefined when there is nothing to go on, so the solver falls back to the pose.
 */
export function kneePole(root: vec3, mid: vec3, tip: vec3, forward: vec3, minBend = 0.05): vec3 | undefined {
    const axis = vec3.sub(vec3.create(), tip, root);
    const axisLen = vec3.length(axis);
    const legLen = vec3.distance(root, mid) + vec3.distance(mid, tip);
    if (axisLen < 1e-8 || legLen < 1e-8) return undefined;
    vec3.scale(axis, axis, 1 / axisLen);
    const toMid = vec3.sub(vec3.create(), mid, root);
    // The knee's offset from the hip-ankle line: the direction the clip bends it.
    const bend = vec3.scaleAndAdd(vec3.create(), toMid, axis, -vec3.dot(toMid, axis));
    const bendLen = vec3.length(bend);
    const forwardLen = vec3.length(forward);
    if (forwardLen <= 1e-8) return bendLen > minBend * legLen ? vec3.scaleAndAdd(vec3.create(), mid, bend, legLen / bendLen) : undefined;
    const ahead = vec3.scale(vec3.create(), forward, 1 / forwardLen);
    if (bendLen <= 1e-8) return vec3.scaleAndAdd(vec3.create(), mid, ahead, legLen);
    const along = vec3.scale(vec3.create(), bend, 1 / bendLen);
    // How far to trust the clip's bend: by its size, and by how far round from `forward` it points (fully to about
    // 105 degrees, not at all past about 150).
    const cos = vec3.dot(along, ahead);
    const trust = smoothstep(minBend * 0.5, minBend, bendLen / legLen) * smoothstep(-0.85, -0.25, cos);
    // Turned from `forward` toward the bend by that share of the angle between them, about their common axis: a
    // straight blend of two far-apart directions would do most of its turning in the middle of the band.
    const turnAxis = vec3.cross(vec3.create(), ahead, along);
    const sin = vec3.length(turnAxis);
    const dir = vec3.copy(vec3.create(), trust >= 1 ? along : ahead);
    if (trust > 0 && trust < 1 && sin > 1e-6) {
        const angle = Math.atan2(sin, cos) * trust;
        vec3.transformQuat(dir, ahead, quat.setAxisAngle(quat.create(), vec3.scale(turnAxis, turnAxis, 1 / sin), angle));
    } else if (trust > 0 && trust < 1 && cos > 0) vec3.copy(dir, along);
    return vec3.scaleAndAdd(vec3.create(), mid, dir, legLen);
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
