import { quat, vec3 } from 'gl-matrix';
import { clamp } from '../core/math';

// ---------------------------------------------------------------------------
// Inverse kinematics.
//
// Pure vec3/quat maths — no GL, no scene, no engine imports — for the same reason animationField.ts is:
// the interesting part is the geometry, and geometry is worth unit-testing on its own.
//
// The solver is ANALYTIC rather than iterative (no FABRIK, no CCD). A two-bone chain has a closed-form
// answer: two lengths and a target distance determine the interior angles by the law of cosines, and the
// only remaining freedom is which way the joint bends. Iterating would be slower, frame-rate dependent in
// its convergence, and no more accurate.
// ---------------------------------------------------------------------------

/**
 * How far a limb may extend towards a target, as a fraction of its own length.
 *
 * Not 1: a perfectly straight limb is a singularity — the bend plane collapses and the joint's direction
 * becomes undefined. Held a hair short, the joint keeps a well-defined side all the way to the limit (at
 * 0.999 the knee is still bent ~2.5 degrees, which is plenty to define a plane) while the shortfall is
 * ~2mm on a metre-long leg, an order of magnitude below anything visible.
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
     * A point the mid joint should bend towards — a knee's "forward". Omit (or null) to preserve the bend
     * plane the animated pose is already in, which is what foot placement wants: the animator decided which
     * way the knee points, and IK should move the leg without arguing about it.
     */
    pole?: vec3 | null;
    /**
     * Fraction of full extension the limb may reach before it stops trying. Default 0.99.
     *
     * Never 1: a perfectly straight limb is a singularity — the bend plane collapses and the knee's
     * direction becomes undefined — and real legs do not lock straight either. Holding a hair short of full
     * extension keeps the joint's direction meaningful all the way to the limit.
     */
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
    /**
     * Distance from the ankle joint down to the sole, in model units. The ankle is placed this far above the
     * surface the ray hit — without it the ankle itself lands on the ground and the foot sinks.
     */
    footHeight: number;
    /** How far above the animated foot the ground ray starts. Covers a foot posed below the real surface. */
    traceUp: number;
    /** How far below the animated foot the ray reaches. Beyond this the foot is treated as airborne. */
    traceDown: number;
    /**
     * How far a foot must rise ABOVE the most-planted foot before IK lets go of it entirely, in model units.
     *
     * This is the swing/stance split, and the reason a stride is not fought. Without it, a foot the animation
     * lifted mid-step still finds ground under it — `traceDown` reaches further than a stride lifts — and is
     * pulled straight back down to it. That destroys the animated lift for the whole swing phase and, because
     * the swing foot is then the one demanding the most reach, drags the pelvis down by the same amount once
     * per step. On screen it reads as the animation fighting the IK.
     *
     * Measured RELATIVE to the lowest foot, because absolutely it is not knowable: a foot 0.3 above its ground
     * is mid-stride if the other foot is down, and is a character standing on ground 0.3 lower than the
     * animation assumed if the other foot is up there too. The first wants releasing, the second wants the
     * whole pelvis lowered — and only the other foot says which.
     *
     * A foot at or below its ground keeps the FULL correction whatever this is set to; that is the
     * ground-penetration case the feature exists for. 0 disables the release entirely.
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

/**
 * A character's IK setup. Lives on the {@link Skin} because it is joint indices INTO that skeleton — it
 * cannot be meaningful for any other rig, so it belongs with the skeleton rather than with a placed node.
 */
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
 * Check that a rig describes chains the solver can actually use, and say what is wrong with the rest.
 *
 * Bone NAMES cannot answer this. Three bones can carry exactly the right names, land in exactly the right
 * slots, and still belong to three unrelated parts of the rig — a control bone, a twist helper, a pole target
 * — at which point the solver produces a mathematically valid pose with no relation to the character. Only
 * the hierarchy knows, so this asks the hierarchy.
 *
 * Pure, and separate from the solver, so the editor can warn while authoring and the runtime can skip while
 * playing without the two disagreeing about what "valid" means.
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
 * How much of a foot's ground correction survives, given how far it has lifted above the most-planted foot.
 *
 * 1 while the foot is down, falling to 0 once it has lifted `swingRelease`. `lift <= 0` — a foot at or through
 * the surface — always returns 1: pushing a foot out of the ground is the whole point of the feature and must
 * not be faded by anything.
 *
 * Smoothstep rather than a linear ramp, for two reasons that both matter on screen. It is flat at `t = 0`, so
 * a foot a centimetre off the ground still gets ~97% correction and uneven ground is still planted rather than
 * half-abandoned. And it is flat at `t = 1`, so there is no crease at the moment the foot is let go.
 *
 * `swingRelease <= 0` (or NaN) means the release is off and IK owns the foot throughout, which is how this
 * behaved before the value existed.
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
 * Bend a two-bone chain so its tip reaches `target`.
 *
 * Returns DELTAS, not absolute orientations. Bones carry a bind orientation and an animated pose that the
 * solver has no business reconstructing; the caller has both and applies these on top. That also makes the
 * result independent of whatever axis convention the rig was authored with — which varies by exporter and
 * is the usual reason a hand-rolled IK solver produces a corkscrewed limb.
 *
 * The maths: with limb lengths `a` and `b` and a target distance `d`, the angle at the root between the limb
 * axis and the upper bone is `acos((a² + d² - b²) / 2ad)`, and the interior angle at the mid joint follows
 * the same way. Both are clamped before `acos` — floating point routinely produces 1.0000000001 for a
 * straight limb, and `acos` of that is NaN, which propagates into the quaternions and collapses the skeleton.
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

    // SOLVE THE POSITIONS FIRST, then read the rotations off them.
    //
    // The tempting alternative — compute the two interior-angle changes and compose them as deltas — is a
    // sign-and-ordering minefield: the swing that aims the limb at the target has to be measured against the
    // tip position AFTER the joint has bent, not before, and getting that backwards produces a limb that
    // reaches past its target and folds the wrong way. Placing the joints and then asking "what rotation
    // takes each bone from where it was to where it now is" has no such ordering to get wrong, and is
    // verifiable by inspection: the answer is the positions.

    // The bend axis: normal to the plane the joint bends in.
    //
    // Taken from the limb's OWN current pose — `cross(upper, lower)` — and deliberately not from anything
    // involving the target. A target-relative reference looks equivalent and is not: it collapses whenever
    // the knee happens to point along the direction of the target, and on the far side of that it comes back
    // with the opposite sign, snapping the knee through the character. That configuration is ordinary (a
    // raised foot with a forward-pointing knee reaches it), so the flip would be too.
    //
    // The pose-only axis degenerates in exactly one place — a perfectly straight limb, which has no bend
    // plane at all — and that is the pose a standing character is in, so the fallbacks below are the common
    // path rather than a rarity.
    const dirTarget = vec3.normalize(vec3.create(), toTarget);
    const bendAxis = vec3.create();
    if (s.pole) {
        // An explicit pole overrides the pose: saying where the knee should point is the entire purpose of
        // supplying one.
        const toPole = vec3.sub(vec3.create(), s.pole, s.root);
        vec3.cross(bendAxis, toPole, toTarget);
    }
    if (vec3.length(bendAxis) < 1e-6) vec3.cross(bendAxis, upper, lower);

    // The axis has to be PERPENDICULAR to the limb axis, so remove any component along it. Rotating about a
    // tilted axis sweeps a cone: the angle it opens between the target direction and the upper bone is then
    // smaller than the one the law of cosines asked for, the triangle does not close, and the tip lands short
    // of the target. Only shows up once a target leaves the plane the limb is currently bent in, which is to
    // say the moment IK does anything interesting.
    vec3.scaleAndAdd(bendAxis, bendAxis, dirTarget, -vec3.dot(bendAxis, dirTarget));

    // Straight limb, no pole, or a pole sitting on the limb axis: nothing prefers one side, so any
    // perpendicular is equally correct.
    if (vec3.length(bendAxis) < 1e-6) anyPerpendicular(bendAxis, dirTarget);
    vec3.normalize(bendAxis, bendAxis);

    // Interior angle at the root between the upper bone and the limb axis, by the law of cosines. Clamped
    // before acos: floating point routinely yields 1.0000000001 for a straight limb, and acos of that is
    // NaN, which spreads into the quaternions and collapses the whole skeleton.
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

/**
 * Where the three joints end up after {@link solveTwoBone}'s deltas are applied. Positions only — the caller
 * needs orientations, but a test (and a debug overlay) wants to know where the joints actually landed.
 */
export function applyTwoBone(s: TwoBoneSolve, r: TwoBoneResult): { root: vec3; mid: vec3; tip: vec3 } {
    const upper = vec3.sub(vec3.create(), s.mid, s.root);
    const lower = vec3.sub(vec3.create(), s.tip, s.mid);

    const newUpper = vec3.transformQuat(vec3.create(), upper, r.rootDelta);
    // The lower bone is carried by the root's rotation FIRST and takes its own on top — which is
    // `midDelta * rootDelta`, not the other way round: gl-matrix applies the right-hand factor first, and
    // `midDelta` was measured from where the root had already left the bone. This mirrors what the skeleton
    // does, where the shin's global has the thigh's rotation baked in before any IK touches it.
    const combined = quat.multiply(quat.create(), r.midDelta, r.rootDelta);
    const newLower = vec3.transformQuat(vec3.create(), lower, combined);

    const mid = vec3.add(vec3.create(), s.root, newUpper);
    const tip = vec3.add(vec3.create(), mid, newLower);
    return { root: vec3.clone(s.root), mid, tip };
}
