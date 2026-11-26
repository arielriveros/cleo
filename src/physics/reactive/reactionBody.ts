import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skin } from '../../animation/animatedModel';
import type { AnimationPose } from '../../animation/animationPose';
import { solveTwoBone } from '../../animation/ik';
import { normalizeBoneName } from '../../animation/boneNames';
import { quatFromToTuple, quatMultiplyTuple, quatConjugateTuple, quatRotateTuple, quatSlerpTuple } from '../../core/math';
import type { Ragdoll, RagdollPartInfo } from '../ragdoll';
import { rigidRotation } from '../ragdollProfile';

// The reacting body as behaviours see it: every part's pose as simulated and as animated, the muscles' target
// for each part (its rotation in its parent's frame), and the ways to aim one — turn a part to a world
// rotation, reach a hand or a foot for a point (two-bone IK on the simulated arm or leg), look at a point, take
// a pose. Behaviours write here through weights; the controller sends the result to the muscles.

/** A limb's three parts: the root (upper arm, thigh), the middle (forearm, shin), the end (hand, foot). */
export interface Limb { root: number; mid: number; end: number }

export class ReactionBody {
    /** World poses [px py pz qx qy qz qw], per part: as simulated, as animated. */
    public readonly sim: number[][] = [];
    public readonly anim: number[][] = [];
    /** The muscles' target per part: its rotation in its parent's frame. */
    public readonly target: number[][] = [];
    /** The target's own spin, per part, in its parent's frame. */
    public readonly spin: number[][] = [];
    /** Per part: stiffness (Hz), damping ratio, strength (N·m), gravity compensation, friction. */
    public readonly frequency: Float64Array;
    public readonly damping: Float64Array;
    public readonly torque: Float64Array;
    public readonly holdUp: Float64Array;
    public readonly friction: Float64Array;
    /** Per part: how firmly its strings hold it to the animation (0..1), and how much of it is drawn simulated. */
    public readonly pin: Float64Array;
    public readonly mapping: Float64Array;
    /**
     * Per part: a string to a point in the world rather than to the animation (`pull`), and how firmly (0..1 of the
     * set's strings). What gets a hand onto a wound on every backend: the arm's muscles aim it, the string lands it.
     */
    public readonly goal: number[][] = [];
    public readonly goalWeight: Float64Array;
    /** Each limb by side. */
    public readonly arms: Partial<Record<'L' | 'R', Limb>> = {};
    public readonly legs: Partial<Record<'L' | 'R', Limb>> = {};
    public readonly pelvis: number;
    public readonly chest: number;
    public readonly head: number;
    public readonly parts: readonly RagdollPartInfo[];
    /** Per part, its joint's cone in body frames: the child's axis (in its own frame), the parent's, and the half-angle. */
    private readonly _cone: { child: number[]; parent: number[]; angle: number }[] = [];

    constructor(public readonly ragdoll: Ragdoll) {
        const parts = this.parts = ragdoll.parts;
        const n = parts.length;
        for (let i = 0; i < n; i++) {
            this.sim.push([0, 0, 0, 0, 0, 0, 1]); this.anim.push([0, 0, 0, 0, 0, 0, 1]);
            this.target.push([0, 0, 0, 1]); this.spin.push([0, 0, 0]); this.goal.push([0, 0, 0]);
        }
        this.goalWeight = new Float64Array(n);
        this.frequency = new Float64Array(n); this.damping = new Float64Array(n); this.torque = new Float64Array(n);
        this.holdUp = new Float64Array(n); this.friction = new Float64Array(n);
        this.pin = new Float64Array(n); this.mapping = new Float64Array(n).fill(1);
        const role = (r: string) => parts.findIndex(p => p.role === r);
        for (const s of ['L', 'R'] as const) {
            const arm = { root: role(`upperArm.${s}`), mid: role(`foreArm.${s}`), end: role(`hand.${s}`) };
            if (arm.root >= 0 && arm.mid >= 0 && arm.end >= 0) this.arms[s] = arm;
            const leg = { root: role(`upLeg.${s}`), mid: role(`leg.${s}`), end: role(`foot.${s}`) };
            if (leg.root >= 0 && leg.mid >= 0 && leg.end >= 0) this.legs[s] = leg;
        }
        for (const p of parts) {
            const lc = p.layout.rotation, lp = p.parent >= 0 ? parts[p.parent].layout.rotation : p.layout.rotation;
            const c = quatRotateTuple([-lc[0], -lc[1], -lc[2], lc[3]], [p.layout.childAxis[0], p.layout.childAxis[1], p.layout.childAxis[2]]);
            const q = quatRotateTuple([-lp[0], -lp[1], -lp[2], lp[3]], [p.layout.parentAxis[0], p.layout.parentAxis[1], p.layout.parentAxis[2]]);
            this._cone.push({ child: c, parent: q, angle: p.layout.coneAngle });
        }
        this.pelvis = Math.max(0, parts.findIndex(p => p.parent < 0));
        this.chest = [role('chest'), role('spine'), this.pelvis].find(i => i >= 0)!;
        this.head = [role('neck'), role('head')].find(i => i >= 0) ?? -1;
    }

    /** Read the simulated and animated poses, and start the targets from the animation's. */
    public begin(): void {
        const r = this.ragdoll;
        for (const p of this.parts) r.simulatedPose(p.index, this.sim[p.index]);
        r.animatedPartPoses(this.anim);
        for (const p of this.parts) {
            r.relativeRotation(this.anim, p.index, this.target[p.index]);
            const s = this.spin[p.index]; s[0] = s[1] = s[2] = 0;
        }
        this.goalWeight.fill(0);
    }

    /** A string from part `i`'s centre to a world point, `w` (0..1) of the set's strings; its rotation left free. */
    public pull(i: number, point: ArrayLike<number>, w: number): void {
        if (!(w > 0) || i < 0) return;
        const g = this.goal[i];
        g[0] = point[0]; g[1] = point[1]; g[2] = point[2];
        this.goalWeight[i] = Math.max(this.goalWeight[i], Math.min(1, w));
    }

    // ---- poses ----

    /** Part `i`'s world rotation as simulated. */
    public simRotation(i: number): [number, number, number, number] { const s = this.sim[i]; return [s[3], s[4], s[5], s[6]]; }
    public simPosition(i: number): [number, number, number] { const s = this.sim[i]; return [s[0], s[1], s[2]]; }
    public animRotation(i: number): [number, number, number, number] { const s = this.anim[i]; return [s[3], s[4], s[5], s[6]]; }

    /** A point given in part `i`'s frame (from its centre), in the world as simulated. */
    public simPoint(i: number, local: ArrayLike<number>): [number, number, number] {
        const r = quatRotateTuple(this.simRotation(i), [local[0], local[1], local[2]]), s = this.sim[i];
        return [s[0] + r[0], s[1] + r[1], s[2] + r[2]];
    }

    /** Part `i`'s joint pivot in the world, as simulated (on its own body). */
    public pivot(i: number): [number, number, number] { return this.simPoint(i, this.parts[i].pivotSelf); }

    /** The end of part `i` away from its joint (a hand's fingertips, a foot's toes), as simulated. */
    public tip(i: number): [number, number, number] {
        const p = this.parts[i], y = Math.sign(-p.pivotSelf[1]) || 1;
        return this.simPoint(i, [0, y * p.halfLength, 0]);
    }

    // ---- writing targets ----

    /** Turn part `i`'s target toward rotation `rel` (in its parent's frame) by `w` (0..1). */
    public blend(i: number, rel: ArrayLike<number>, w: number): void {
        if (!(w > 0) || i < 0) return;
        const t = this.target[i];
        const q = w >= 1 ? [rel[0], rel[1], rel[2], rel[3]] : quatSlerpTuple(t, rel, w);
        t[0] = q[0]; t[1] = q[1]; t[2] = q[2]; t[3] = q[3];
    }

    /**
     * Turn part `i`'s target toward WORLD rotation `world` by `w`: measured against its parent as simulated, so
     * the part ends up turned that way in the world whatever its parent is doing.
     */
    public blendWorld(i: number, world: ArrayLike<number>, w: number): void {
        const p = this.parts[i];
        if (!p || p.parent < 0) return;
        this.blend(i, quatMultiplyTuple(quatConjugateTuple(this.simRotation(p.parent)), [world[0], world[1], world[2], world[3]]), w);
    }

    /** Muscle settings of part `i` moved toward these by `w`. */
    public tune(i: number, w: number, s: { frequency?: number; damping?: number; torque?: number; holdUp?: number; friction?: number }): void {
        if (!(w > 0) || i < 0) return;
        const k = Math.min(1, w);
        if (s.frequency !== undefined) this.frequency[i] += (s.frequency - this.frequency[i]) * k;
        if (s.damping !== undefined) this.damping[i] += (s.damping - this.damping[i]) * k;
        if (s.torque !== undefined) this.torque[i] += (s.torque - this.torque[i]) * k;
        if (s.holdUp !== undefined) this.holdUp[i] += (s.holdUp - this.holdUp[i]) * k;
        if (s.friction !== undefined) this.friction[i] += (s.friction - this.friction[i]) * k;
    }

    /** Every part in `parts` (indices) tuned the same way. */
    public tuneAll(parts: Iterable<number>, w: number, s: Parameters<ReactionBody['tune']>[2]): void {
        for (const i of parts) this.tune(i, w, s);
    }

    /** Hold part `i` where it is now (its simulated rotation relative to its parent), by `w`. */
    public hold(i: number, w: number): void {
        const p = this.parts[i];
        if (!p || p.parent < 0) return;
        this.blend(i, quatMultiplyTuple(quatConjugateTuple(this.simRotation(p.parent)), this.simRotation(i)), w);
    }

    /** A part's target turned further by `rotation` (in its parent's frame, applied on the parent's side). */
    public turn(i: number, rotation: ArrayLike<number>, w: number): void {
        if (i < 0) return;
        this.blend(i, quatMultiplyTuple([rotation[0], rotation[1], rotation[2], rotation[3]], this.target[i]), w);
    }

    /**
     * Reach a limb's end for a world point: two-bone IK on the limb as simulated (its root pivot, its middle
     * joint, its end's pivot), its two parts turned toward the solution by `w`. `pole`: where the middle joint
     * should point (an elbow out and down, a knee forward); null keeps the bend the limb has. `endRotation`: the
     * end part's world rotation to take as well (a flat foot, an open palm toward a surface).
     */
    public reach(limb: Limb, target: ArrayLike<number>, w: number, pole: ArrayLike<number> | null = null, endRotation: ArrayLike<number> | null = null): boolean {
        if (!(w > 0)) return false;
        const root = this.pivot(limb.root), mid = this.pivot(limb.mid), tip = this.pivot(limb.end);
        const solve = solveTwoBone({
            root: root as vec3, mid: mid as vec3, tip: tip as vec3, target: vec3.fromValues(target[0], target[1], target[2]),
            pole: pole ? vec3.fromValues(pole[0], pole[1], pole[2]) : null, maxReach: 0.98,
        });
        const qRoot = quatMultiplyTuple(Array.from(solve.rootDelta), this.simRotation(limb.root));
        const qMid = quatMultiplyTuple(quatMultiplyTuple(Array.from(solve.midDelta), Array.from(solve.rootDelta)), this.simRotation(limb.mid));
        // Root against its parent as simulated; middle against the ROOT'S solved rotation, so the two agree.
        this.blendWorld(limb.root, qRoot, w);
        this.blend(limb.mid, quatMultiplyTuple(quatConjugateTuple(qRoot), qMid), w);
        if (endRotation) this.blend(limb.end, quatMultiplyTuple(quatConjugateTuple(qMid), [endRotation[0], endRotation[1], endRotation[2], endRotation[3]]), w);
        return solve.reached;
    }

    /**
     * Turn the head (and a little of the chest) to face a world point, by `w`, at most `maxAngle` from where it
     * faces now. Part frames face +Z.
     */
    public look(point: ArrayLike<number>, w: number, maxAngle = 1.1): void {
        if (!(w > 0) || this.head < 0) return;
        const h = this.sim[this.head];
        const to = [point[0] - h[0], point[1] - h[1], point[2] - h[2]];
        const len = Math.hypot(to[0], to[1], to[2]);
        if (len < 1e-3) return;
        const fwd = quatRotateTuple(this.simRotation(this.head), [0, 0, 1]);
        const dir = [to[0] / len, to[1] / len, to[2] / len];
        let turn = quatFromToTuple(fwd, dir);
        const angle = 2 * Math.acos(Math.min(1, Math.abs(turn[3])));
        if (angle > maxAngle) turn = quatSlerpTuple([0, 0, 0, 1], turn, maxAngle / angle);
        const headTurn = quatSlerpTuple([0, 0, 0, 1], turn, 0.65), chestTurn = quatSlerpTuple([0, 0, 0, 1], turn, 0.35);
        this.blendWorld(this.head, quatMultiplyTuple(headTurn, this.simRotation(this.head)), w);
        if (this.chest >= 0 && this.chest !== this.pelvis) this.blendWorld(this.chest, quatMultiplyTuple(chestTurn, this.simRotation(this.chest)), w);
    }

    /**
     * Bend a hinged part (a knee, an elbow) by `angle` radians the way it folds (its profile's bend direction),
     * on top of its target, by `w`. A part without a hinge is left alone.
     */
    public bend(i: number, angle: number, w: number): void {
        const p = this.parts[i];
        if (!p || p.parent < 0 || !p.layout.hingeAxis) return;
        // The hinge axis is in bind model space; the target is in the parent's body frame, which at bind is the
        // parent's layout rotation.
        const pr = this.parts[p.parent].layout.rotation;
        const h = p.layout.hingeAxis;
        const axis = quatRotateTuple([-pr[0], -pr[1], -pr[2], pr[3]], [h[0], h[1], h[2]]);
        const s = Math.sin(angle / 2);
        this.turn(i, [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)], w);
    }

    /**
     * Part `i`'s target held inside its joint's cone (a hinge's cone is its bend range): a muscle asked past a limit
     * only presses the limb into it, where a motor that clamps its target (Jolt's) settles at the edge.
     */
    public clampTarget(i: number): void {
        const p = this.parts[i], cone = this._cone[i];
        if (!p || p.parent < 0 || !cone || !(cone.angle > 0) || cone.angle >= Math.PI - 1e-3) return;
        const t = this.target[i];
        const axis = quatRotateTuple(t, cone.child), ref = cone.parent;
        const cos = Math.max(-1, Math.min(1, axis[0] * ref[0] + axis[1] * ref[1] + axis[2] * ref[2]));
        const swing = Math.acos(cos);
        const limit = cone.angle * 0.97;
        if (swing <= limit) return;
        // Turn the child's axis back onto the cone's edge, the short way, about the axis square to both.
        const turnAxis = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]];
        const n = Math.hypot(turnAxis[0], turnAxis[1], turnAxis[2]);
        if (n < 1e-9) return;
        const back = swing - limit, s = Math.sin(back / 2) / n;
        const q = quatMultiplyTuple([turnAxis[0] * s, turnAxis[1] * s, turnAxis[2] * s, Math.cos(back / 2)], t);
        t[0] = q[0]; t[1] = q[1]; t[2] = q[2]; t[3] = q[3];
    }

    /** Take a pose's part rotations (posePartTargets) for the parts in `mask`, by `w`. */
    public pose(rel: readonly (number[] | null)[], mask: Iterable<number>, w: number): void {
        for (const i of mask) { const q = rel[i]; if (q) this.blend(i, q, w); }
    }

    /** The parts of these regions (and sides). */
    public partsOf(regions: readonly string[], side?: 'L' | 'R' | null): number[] {
        return this.parts.filter(p => regions.includes(p.region) && (!side || p.side === side)).map(p => p.index);
    }
}

const POSE_CACHE = new WeakMap<AnimationPose, WeakMap<Ragdoll, (number[] | null)[]>>();

/**
 * A pose's rotation for each part of a ragdoll, in its parent's frame (what the muscles take): the pose's bone
 * deltas applied to the skeleton's rest locals and carried up from part to part. Parts the pose does not turn
 * come out at rest, so a pose of the arms leaves the rest; a part whose chain from its parent the pose never
 * names is null (left to the animation). Cached per pose and ragdoll.
 */
export function posePartTargets(ragdoll: Ragdoll, skin: Skin, pose: AnimationPose): (number[] | null)[] {
    let byRagdoll = POSE_CACHE.get(pose);
    const hit = byRagdoll?.get(ragdoll);
    if (hit) return hit;
    const names = skin.nodeNames;
    const delta = new Map<number, [number, number, number, number]>();
    if (names) {
        const byName = new Map<string, number>(), byNorm = new Map<string, number>();
        for (const [node, name] of names) { byName.set(name, node); byNorm.set(normalizeBoneName(name), node); }
        for (const b of pose.bones) {
            const node = byName.get(b.name) ?? byNorm.get(normalizeBoneName(b.name));
            if (node !== undefined && b.rotation) delta.set(node, [b.rotation[0], b.rotation[1], b.rotation[2], b.rotation[3]]);
        }
    }
    const parentOf = skin.nodeParents ?? new Map<number, number>();
    const restRot = (node: number): [number, number, number, number] => {
        const m = skin.nodeTransforms?.get(node);
        if (!m) return [0, 0, 0, 1];
        const q = rigidRotation(quat.create(), m as mat4);
        return [q[0], q[1], q[2], q[3]];
    };
    const out = ragdoll.parts.map(p => {
        if (p.parent < 0) return null;
        const parentNode = ragdoll.parts[p.parent].layout.node;
        // inv(R_parent)·R_child: the locals from below the parent's bone down to the part's own, top-down.
        let rel: [number, number, number, number] = [0, 0, 0, 1];
        let named = false, ok = false;
        for (let n: number | undefined = p.layout.node; n !== undefined; n = parentOf.get(n)) {
            if (n === parentNode) { ok = true; break; }
            const d = delta.get(n);
            if (d) named = true;
            const local = d ? quatMultiplyTuple(d, restRot(n)) : restRot(n);
            rel = quatMultiplyTuple(local, rel);
        }
        if (!ok || !named) return null;
        // Body frames: q_body = R_bone · inv(bind) · layoutRotation, so inv(q_parent)·q_child is
        // inv(L_p)·B_p·rel·inv(B_c)·L_c.
        const Lp = ragdoll.parts[p.parent].layout, Lc = p.layout;
        const lp = [Lp.rotation[0], Lp.rotation[1], Lp.rotation[2], Lp.rotation[3]], bp = [Lp.boneRotation[0], Lp.boneRotation[1], Lp.boneRotation[2], Lp.boneRotation[3]];
        const lc = [Lc.rotation[0], Lc.rotation[1], Lc.rotation[2], Lc.rotation[3]], bc = [Lc.boneRotation[0], Lc.boneRotation[1], Lc.boneRotation[2], Lc.boneRotation[3]];
        let q = quatMultiplyTuple(quatConjugateTuple(lp), bp);
        q = quatMultiplyTuple(q, rel);
        q = quatMultiplyTuple(q, quatConjugateTuple(bc));
        q = quatMultiplyTuple(q, lc);
        return q;
    });
    if (!byRagdoll) { byRagdoll = new WeakMap(); POSE_CACHE.set(pose, byRagdoll); }
    byRagdoll.set(ragdoll, out);
    return out;
}
