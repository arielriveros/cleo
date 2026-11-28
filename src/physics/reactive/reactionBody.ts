import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skin } from '../../animation/animatedModel';
import type { AnimationPose } from '../../animation/animationPose';
import { solveTwoBone } from '../../animation/ik';
import { normalizeBoneName } from '../../animation/boneNames';
import { quatFromToTuple, quatMultiplyTuple, quatConjugateTuple, quatRotateTuple, quatSlerpTuple, quatSwingTwistTuple, quatToRotationVector, rotationVectorToQuat } from '../../core/math';
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
    /**
     * Off its feet, the pose the muscles follow, per part (its rotation in its parent's frame): the pose it fell in,
     * eased toward a brace or a clip, relaxed once it lies still (ReactionController._evolveRef). Behaviours compose
     * on it, so a bend or a flex is an offset from a pose that stays put, never a turn from wherever the limb already
     * is, which would never end.
     */
    public readonly ref: number[][] = [];
    /**
     * The target's own spin, per part, in its parent's frame: the animation's, measured between this frame's pose and
     * the last (begin), so a muscle follows a swinging arm rather than trailing it; less as a behaviour blends the
     * target away from the animation. Smoothed (SPIN_TAU) and scaled by `followSpin` (Euphoria's angVelScale): a
     * frame difference of a pose with a fast layer in it is mostly that layer's jerk, and a muscle fed it as a velocity
     * passes it on as a wobble.
     */
    public readonly spin: number[][] = [];
    /** How much of the animation's smoothed spin the muscles are fed (0..1; the set's Follow spin). */
    public followSpin = 1;
    private readonly _spinF: number[][] = [];
    /** Per part, the animation's world velocity [vx vy vz wx wy wz] (what a kinematic part is moved by). */
    public readonly animVel: number[][] = [];
    /** Per part: 1 while it is kinematic on the animation (the legs of a character on its feet). */
    public readonly kinematic: Uint8Array;
    /** Per part: stiffness (Hz), damping ratio, strength (N·m), gravity compensation, friction. */
    public readonly frequency: Float64Array;
    public readonly damping: Float64Array;
    public readonly torque: Float64Array;
    public readonly holdUp: Float64Array;
    public readonly friction: Float64Array;
    /**
     * Per part: the inertia its muscle's spring is sized for (kg·m², JointDrive.inertia), 0 for the joint's own: a
     * planted leg's on the weight it carries. Zeroed each frame (begin).
     */
    public readonly inertia: Float64Array;
    /** Per part: how firmly its strings hold it to the animation (0..1), and how much of it is drawn simulated. */
    public readonly pin: Float64Array;
    public readonly mapping: Float64Array;
    /**
     * Per part: a string to a point in the world rather than to the animation (`pull`), and how firmly (0..1 of the
     * set's strings). What gets a hand onto a wound on every backend: the arm's muscles aim it, the string lands it.
     */
    public readonly goal: number[][] = [];
    public readonly goalWeight: Float64Array;
    /** Per part: how fast its string's point moves (world m/s): a hand held on a wound rides the wound. */
    public readonly goalVel: number[][] = [];
    /**
     * Per part: a torque its joint adds on top of its muscle's spring (world N·m, on the part; its opposite on the
     * parent): what a balance controller asks of a joint. Zeroed each frame (begin).
     */
    public readonly jointTorque: number[][] = [];
    /**
     * Per part, this frame: 1 to pass through the rest of the body (no self-collision), as an arm reaching across
     * the chest for a wound must: the chest's contacts would hold it off what it reaches for.
     */
    public readonly passThrough: Uint8Array;
    /** Each limb by side. */
    public readonly arms: Partial<Record<'L' | 'R', Limb>> = {};
    public readonly legs: Partial<Record<'L' | 'R', Limb>> = {};
    public readonly pelvis: number;
    public readonly chest: number;
    public readonly head: number;
    public readonly parts: readonly RagdollPartInfo[];
    /** Per part, its joint's cone in body frames: the child's axis (in its own frame), the parent's, and the half-angle. */
    private readonly _cone: { child: number[]; parent: number[]; angle: number }[] = [];
    /**
     * Per part: its rotation in its parent's frame at the bind pose, and how far it may twist about its own axis from
     * there (radians; 0: unclamped, as a hinge's twist is its hinge's).
     */
    private readonly _bindRel: number[][] = [];
    private readonly _twist: number[] = [];
    /**
     * Per part: where its joint's twist is zero, its rotation in its parent's frame as the body was made (the
     * physics' joint frames are measured from the pose they were made in, not the bind pose).
     */
    private readonly _twistZero: number[][] = [];

    constructor(public readonly ragdoll: Ragdoll) {
        const parts = this.parts = ragdoll.parts;
        const n = parts.length;
        for (let i = 0; i < n; i++) {
            this.sim.push([0, 0, 0, 0, 0, 0, 1]); this.anim.push([0, 0, 0, 0, 0, 0, 1]);
            this.target.push([0, 0, 0, 1]); this.ref.push([0, 0, 0, 1]); this.spin.push([0, 0, 0]); this.goal.push([0, 0, 0]);
            this.animVel.push([0, 0, 0, 0, 0, 0]); this._prevAnim.push([0, 0, 0, 0, 0, 0, 1]); this._prevRel.push([0, 0, 0, 1]);
            this._spinF.push([0, 0, 0]); this.goalVel.push([0, 0, 0]); this.jointTorque.push([0, 0, 0]);
        }
        this.kinematic = new Uint8Array(n);
        this.goalWeight = new Float64Array(n);
        this.passThrough = new Uint8Array(n);
        this.frequency = new Float64Array(n); this.damping = new Float64Array(n); this.torque = new Float64Array(n);
        this.holdUp = new Float64Array(n); this.friction = new Float64Array(n); this.inertia = new Float64Array(n);
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
            // Body frames at the bind pose are the layout rotations, so the bind relative rotation is inv(Lp)·Lc.
            this._bindRel.push(quatMultiplyTuple([-lp[0], -lp[1], -lp[2], lp[3]], [lc[0], lc[1], lc[2], lc[3]]));
            const hinge = p.layout.part.joint?.type === 'hinge' || !!p.layout.hingeAxis;
            this._twist.push(p.parent >= 0 && !hinge && p.layout.twistAngle > 0 && p.layout.twistAngle < Math.PI - 1e-3 ? p.layout.twistAngle : 0);
            if (p.parent >= 0) {
                const qa = p.body.quaternion, qb = parts[p.parent].body.quaternion;
                const z = quatMultiplyTuple([-qb.x, -qb.y, -qb.z, qb.w], [qa.x, qa.y, qa.z, qa.w]);
                this._twistZero.push(Number.isFinite(z[0] + z[1] + z[2] + z[3]) ? z : this._bindRel[this._bindRel.length - 1]);
            } else this._twistZero.push([0, 0, 0, 1]);
        }
        this.pelvis = Math.max(0, parts.findIndex(p => p.parent < 0));
        this.chest = [role('chest'), role('spine'), this.pelvis].find(i => i >= 0)!;
        this.head = [role('neck'), role('head')].find(i => i >= 0) ?? -1;
    }

    /**
     * Read the simulated and animated poses, and start the targets from the animation's. Given the frame's `dt`, the
     * animation's motion since the last call too: each target's spin and each part's animated velocity (none across
     * a jump of the animated hips of half a metre or more: a teleport, a new clip's first frame).
     */
    public begin(dt = 0, ahead = 0): void {
        const r = this.ragdoll;
        for (const p of this.parts) r.simulatedPose(p.index, this.sim[p.index]);
        // With the physics worker the pose read here is a step old: carried on by its velocity to where it is now,
        // so what reaches, pulls and looks from it does not chase where the body was.
        if (ahead > 0) for (const p of this.parts) {
            const s = this.sim[p.index], v = p.body.velocity, w = p.body.angularVelocity;
            s[0] += v.x * ahead; s[1] += v.y * ahead; s[2] += v.z * ahead;
            const q = quatMultiplyTuple(rotationVectorToQuat([w.x * ahead, w.y * ahead, w.z * ahead]), [s[3], s[4], s[5], s[6]]);
            s[3] = q[0]; s[4] = q[1]; s[5] = q[2]; s[6] = q[3];
        }
        r.animatedPartPoses(this.anim);
        const pa = this.anim[this.pelvis], pp = this._prevAnim[this.pelvis];
        const moving = dt > 1e-4 && this._begun && Math.hypot(pa[0] - pp[0], pa[1] - pp[1], pa[2] - pp[2]) < 0.5;
        const smooth = moving ? 1 - Math.exp(-dt / SPIN_TAU) : 0;
        for (const p of this.parts) {
            const i = p.index, t = this.target[i], s = this.spin[i], v = this.animVel[i], f = this._spinF[i];
            r.relativeRotation(this.anim, i, t);
            s[0] = s[1] = s[2] = 0;
            for (let k = 0; k < 6; k++) v[k] = 0;
            const prevRel = this._prevRel[i], prev = this._prevAnim[i], a = this.anim[i];
            if (!moving) f[0] = f[1] = f[2] = 0;
            if (moving) {
                // ω in the parent's frame: rel_now = exp(ω·dt)·rel_prev, so ω = log(rel_now·inv(rel_prev)) / dt;
                // smoothed, scaled and capped for the muscles (see `spin`).
                if (p.parent >= 0) {
                    const w = quatToRotationVector(quatMultiplyTuple(t, quatConjugateTuple(prevRel)));
                    clampInto(s, w[0] / dt, w[1] / dt, w[2] / dt, MAX_SPIN);
                    for (let k = 0; k < 3; k++) f[k] += (s[k] - f[k]) * smooth;
                    clampInto(s, f[0] * this.followSpin, f[1] * this.followSpin, f[2] * this.followSpin, MAX_TARGET_SPIN);
                }
                v[0] = (a[0] - prev[0]) / dt; v[1] = (a[1] - prev[1]) / dt; v[2] = (a[2] - prev[2]) / dt;
                const ww = quatToRotationVector(quatMultiplyTuple([a[3], a[4], a[5], a[6]], quatConjugateTuple([prev[3], prev[4], prev[5], prev[6]])));
                const sv = [0, 0, 0];
                clampInto(sv, ww[0] / dt, ww[1] / dt, ww[2] / dt, MAX_SPIN);
                v[3] = sv[0]; v[4] = sv[1]; v[5] = sv[2];
            }
            for (let k = 0; k < 4; k++) prevRel[k] = t[k];
            for (let k = 0; k < 7; k++) prev[k] = a[k];
        }
        this._begun = true;
        this.goalWeight.fill(0);
        this.passThrough.fill(0);
        for (const q of this.jointTorque) q[0] = q[1] = q[2] = 0;
        this.inertia.fill(0);
    }
    private readonly _prevAnim: number[][] = [];
    private readonly _prevRel: number[][] = [];
    private _begun = false;

    /** A string from part `i`'s centre to a world point, `w` (0..1) of the set's strings; its rotation left free. */
    public pull(i: number, point: ArrayLike<number>, w: number, velocity?: ArrayLike<number> | null): void {
        if (!(w > 0) || i < 0) return;
        const g = this.goal[i], v = this.goalVel[i];
        g[0] = point[0]; g[1] = point[1]; g[2] = point[2];
        v[0] = velocity?.[0] ?? 0; v[1] = velocity?.[1] ?? 0; v[2] = velocity?.[2] ?? 0;
        this.goalWeight[i] = Math.max(this.goalWeight[i], Math.min(1, w));
    }

    /** Add a torque to part `i`'s joint (world N·m on the part, its opposite on its parent): see `jointTorque`. */
    public addJointTorque(i: number, x: number, y: number, z: number): void {
        const q = this.jointTorque[i];
        if (!q || !Number.isFinite(x + y + z)) return;
        q[0] += x; q[1] += y; q[2] += z;
    }

    /** How fast a point of part `i` moves (world): its body's velocity there, v + ω × r. */
    public pointVelocity(i: number, point: ArrayLike<number>): [number, number, number] {
        const b = this.parts[i].body, v = b.velocity, w = b.angularVelocity, s = this.sim[i];
        const rx = point[0] - s[0], ry = point[1] - s[1], rz = point[2] - s[2];
        return [v.x + w.y * rz - w.z * ry, v.y + w.z * rx - w.x * rz, v.z + w.x * ry - w.y * rx];
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

    /**
     * Turn part `i`'s target toward rotation `rel` (in its parent's frame) by `w` (0..1). `keepSpin`: an offset on
     * top of the animation (a turn, a lean), which still moves as the animation does.
     */
    public blend(i: number, rel: ArrayLike<number>, w: number, keepSpin = false): void {
        if (!(w > 0) || i < 0) return;
        const t = this.target[i];
        const q = w >= 1 ? [rel[0], rel[1], rel[2], rel[3]] : quatSlerpTuple(t, rel, w);
        t[0] = q[0]; t[1] = q[1]; t[2] = q[2]; t[3] = q[3];
        // The animation's spin goes with as much of the target as is still the animation's.
        if (keepSpin) return;
        const s = this.spin[i], k = 1 - Math.min(1, w);
        s[0] *= k; s[1] *= k; s[2] *= k;
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
    public tune(i: number, w: number, s: { frequency?: number; damping?: number; torque?: number; holdUp?: number; friction?: number; inertia?: number }): void {
        if (!(w > 0) || i < 0) return;
        const k = Math.min(1, w);
        if (s.inertia !== undefined) this.inertia[i] = w >= 0.5 ? s.inertia : this.inertia[i];
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

    // ---- the reference pose (off its feet) ----

    /** Part `i`'s rotation in its parent's frame as simulated now. */
    public simRelative(i: number): number[] {
        const p = this.parts[i];
        if (!p || p.parent < 0) return [0, 0, 0, 1];
        return quatMultiplyTuple(quatConjugateTuple(this.simRotation(p.parent)), this.simRotation(i));
    }

    /** The reference pose set to the body as simulated now. */
    public captureRef(): void {
        for (const p of this.parts) { const q = this.simRelative(p.index), r = this.ref[p.index]; r[0] = q[0]; r[1] = q[1]; r[2] = q[2]; r[3] = q[3]; }
    }

    /** Part `i`'s reference moved toward rotation `rel` (in its parent's frame) by `k` (0..1). */
    public refToward(i: number, rel: ArrayLike<number>, k: number): void {
        if (!(k > 0) || i < 0) return;
        const r = this.ref[i], q = k >= 1 ? [rel[0], rel[1], rel[2], rel[3]] : quatSlerpTuple(r, [rel[0], rel[1], rel[2], rel[3]], k);
        r[0] = q[0]; r[1] = q[1]; r[2] = q[2]; r[3] = q[3];
    }

    /** Part `i`'s reference let go toward the pose it holds now (a body lying still), by `k`. */
    public relaxRef(i: number, k: number): void { this.refToward(i, this.simRelative(i), k); }

    /** Every target from the reference pose, by `w` (1: the reference exactly, with no spin). */
    public fromRef(w = 1): void {
        for (const p of this.parts) if (p.parent >= 0) this.blend(p.index, this.ref[p.index], w);
    }

    /** How far part `i`'s target is from where it is (radians). */
    public targetError(i: number): number {
        const q = this.simRelative(i), t = this.target[i];
        const d = Math.abs(q[0] * t[0] + q[1] * t[1] + q[2] * t[2] + q[3] * t[3]);
        return 2 * Math.acos(Math.min(1, d));
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
        // An offset on what the target is: the animation's spin stays (a lean on a swinging arm still swings).
        this.blend(i, quatMultiplyTuple([rotation[0], rotation[1], rotation[2], rotation[3]], this.target[i]), w, true);
    }

    /**
     * A part's target turned further by `rotation` given in the WORLD (about a world axis: away from a hit, about
     * up, the way the body leans), as its parent is simulated now. `turn` takes the parent's own frame, which is the
     * world's only for an upright body facing +Z: given a world axis, a body facing elsewhere, or lying down, bent
     * and twisted the wrong way.
     */
    public turnWorld(i: number, rotation: ArrayLike<number>, w: number): void {
        const p = this.parts[i];
        if (!p || p.parent < 0) return;
        const qp = this.simRotation(p.parent);
        const local = quatMultiplyTuple(quatMultiplyTuple(quatConjugateTuple(qp), [rotation[0], rotation[1], rotation[2], rotation[3]]), qp);
        this.turn(i, local, w);
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
    public look(point: ArrayLike<number>, w: number, maxAngle = 1.1, chestShare = 0.35): void {
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
        const headTurn = quatSlerpTuple([0, 0, 0, 1], turn, 1 - chestShare), chestTurn = quatSlerpTuple([0, 0, 0, 1], turn, chestShare);
        this.blendWorld(this.head, quatMultiplyTuple(headTurn, this.simRotation(this.head)), w);
        if (chestShare > 0 && this.chest >= 0 && this.chest !== this.pelvis) this.blendWorld(this.chest, quatMultiplyTuple(chestTurn, this.simRotation(this.chest)), w);
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
        if (!p || p.parent < 0 || !cone) return;
        if (p.hingeJoint) { this._projectHinge(i); return; }
        this._clampTwist(i);
        if (!(cone.angle > 0) || cone.angle >= Math.PI - 1e-3) return;
        const t = this.target[i];
        const axis = quatRotateTuple(t, cone.child), ref = cone.parent;
        const cos = Math.max(-1, Math.min(1, axis[0] * ref[0] + axis[1] * ref[1] + axis[2] * ref[2]));
        const swing = Math.acos(cos);
        // Inside the cone by a margin: a muscle aimed at its very edge presses the joint into its stop and shudders.
        const limit = Math.max(0, cone.angle - Math.max(HINGE_MARGIN, cone.angle * 0.05));
        if (swing <= limit) return;
        // Turn the child's axis back onto the cone's edge, the short way, about the axis square to both.
        const turnAxis = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]];
        const n = Math.hypot(turnAxis[0], turnAxis[1], turnAxis[2]);
        if (n < 1e-9) return;
        const back = swing - limit, s = Math.sin(back / 2) / n;
        const q = quatMultiplyTuple([turnAxis[0] * s, turnAxis[1] * s, turnAxis[2] * s, Math.cos(back / 2)], t);
        t[0] = q[0]; t[1] = q[1]; t[2] = q[2]; t[3] = q[3];
    }

    /**
     * Part `i`'s target twisted about its own axis no further from the bind pose than its joint's twist allows: a
     * spine asked to turn a long way (a look, a reach and a snap together) turns as far as a spine does, and no
     * muscle presses the joint into its stop and makes it shudder.
     */
    private _clampTwist(i: number): void {
        const limit = this._twist[i];
        if (!(limit > 0)) return;
        const t = this.target[i], bind = this._twistZero[i] ?? this._bindRel[i], axis = this._cone[i].child;
        // The target from where the joint's twist is zero, in the part's own frame, split into twist about its axis
        // and the rest.
        const d = quatMultiplyTuple(quatConjugateTuple(bind), t);
        const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
        let tw = [axis[0] * along, axis[1] * along, axis[2] * along, d[3]];
        const n = Math.hypot(tw[0], tw[1], tw[2], tw[3]);
        if (n < 1e-9) return;
        tw = [tw[0] / n, tw[1] / n, tw[2] / n, tw[3] / n];
        if (tw[3] < 0) tw = [-tw[0], -tw[1], -tw[2], -tw[3]];
        const angle = 2 * Math.acos(Math.min(1, tw[3]));
        const max = limit * 0.95;
        if (angle <= max) return;
        const swing = quatMultiplyTuple(d, quatConjugateTuple(tw));
        const sign = (tw[0] * axis[0] + tw[1] * axis[1] + tw[2] * axis[2]) >= 0 ? 1 : -1;
        const s = Math.sin(max / 2) * sign;
        const clamped = quatMultiplyTuple(quatMultiplyTuple(bind, swing), [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(max / 2)]);
        t[0] = clamped[0]; t[1] = clamped[1]; t[2] = clamped[2]; t[3] = clamped[3];
    }

    /**
     * A knee's or an elbow's target turned about its hinge alone: what is left of it is a bend, inside the bend's range
     * by a margin. Off-hinge content (a forearm's roll in the animation, a reach's solve) would otherwise sit on the
     * joint's cone of a couple of degrees, a motor pressing into its stop: a shudder at the elbow.
     */
    private _projectHinge(i: number): void {
        const h = this.parts[i].hingeJoint!, t = this.target[i];
        const e = quatMultiplyTuple(quatConjugateTuple(h.rest), t);
        const { angle } = quatSwingTwistTuple(e, h.axis);
        if (!Number.isFinite(angle)) return;
        const lo = Math.min(h.lo, h.hi) + HINGE_MARGIN, hi = Math.max(h.lo, h.hi) - HINGE_MARGIN;
        const a = hi > lo ? Math.max(lo, Math.min(hi, angle)) : 0.5 * (h.lo + h.hi);
        const s = Math.sin(a / 2);
        const q = quatMultiplyTuple(h.rest, [h.axis[0] * s, h.axis[1] * s, h.axis[2] * s, Math.cos(a / 2)]);
        t[0] = q[0]; t[1] = q[1]; t[2] = q[2]; t[3] = q[3];
        // Its spin about the hinge alone too (the motor leads the target along it).
        const w = this.spin[i], ax = quatRotateTuple(q, h.axis), d = w[0] * ax[0] + w[1] * ax[1] + w[2] * ax[2];
        w[0] = ax[0] * d; w[1] = ax[1] * d; w[2] = ax[2] * d;
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

/** The fastest an animation's part is taken to turn (rad/s): past it, a measurement across a cut, not a motion. */
const MAX_SPIN = 20;
/** The fastest spin a muscle's target is given to follow (rad/s), and how it is smoothed (s). */
const MAX_TARGET_SPIN = 8;
/** How far inside a joint's limit a muscle's target is kept (rad). */
const HINGE_MARGIN = 3 * Math.PI / 180;
const SPIN_TAU = 0.06;

function clampInto(out: number[], x: number, y: number, z: number, max: number): void {
    const n = Math.hypot(x, y, z);
    const k = n > max ? max / n : 1;
    out[0] = Number.isFinite(x) ? x * k : 0; out[1] = Number.isFinite(y) ? y * k : 0; out[2] = Number.isFinite(z) ? z * k : 0;
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
