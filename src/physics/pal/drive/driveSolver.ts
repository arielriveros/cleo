import type { BodyHandle, BodyPin, JointDrive, MassProperties, Out, V3 } from '../types';

// Joint drives (muscles) and body pins (puppet strings), the same on every backend: what a reactive ragdoll
// moves by. Each world keeps one DriveSolver and runs `apply` at the start of every substep, BEFORE the
// backend's own step, so the solver sees the torques it adds (cannon's preStep hook comes after its solver).
//
// A drive is an implicit (stable) spring-damper between two jointed bodies, solved on their relative rotation
// and applied as equal and opposite torques:
//
//     ω' = (ω + h·Ω²·e) / (1 + 2ζΩh + Ω²h²),   impulse = M·(ω' − ω)
//
// with Ω = 2πf, e the rotation still to go, ω the relative angular velocity measured from the target's own,
// and M the joint's effective inertia: what it actually turns, everything it holds up (the record's subtree)
// about its pivot against the parent about the same pivot. That is the inertia the spring meets once the joint
// carries the subtree round with it, so `frequency` and `damping` mean what they say on a hand and a thigh
// alike. A backend with its own motors (Jolt) is handed the same stiffness and damping in N·m/rad
// (k = I·Ω², c = 2ζIΩ, I along each motor axis), so the numbers mean the same there. Gravity compensation and
// pins are applied here on every backend.
//
// Everything runs in ascending id order, so a world and its copy in the physics worker (drive/driveCopy.ts)
// step alike bit for bit. A world with no drives and no pins does nothing here at all: worlds without them
// step exactly as before.

/** What the solver reads and pushes through: a PhysicsWorld (any backend's). */
export interface DriveBodies {
    readonly gravity: V3;
    isEnabled(h: BodyHandle): boolean;
    getTransform(h: BodyHandle, out: Out): void;
    getVelocity(h: BodyHandle, out: Out): void;
    getMassProperties(h: BodyHandle, out: MassProperties): MassProperties;
    applyTorque(h: BodyHandle, torque: ArrayLike<number>): void;
    applyForce(h: BodyHandle, force: ArrayLike<number>, relativePoint?: ArrayLike<number>): void;
    isSleeping(h: BodyHandle): boolean;
    wakeUp(h: BodyHandle): void;
    /**
     * The frame the principal inertia of getMassProperties is measured in, [x y z w] in the body's frame, where
     * it is not the body's own (Jolt and Rapier sort the principal axes). Absent: the body's frame.
     */
    inertiaFrame?(h: BodyHandle, out: Out): void;
}

/** Where a drive acts, in its bodies' frames (from each node ORIGIN, like a JointDesc). */
export interface DriveRecord {
    /** The driven body (the joint's A: a limb) and the one it turns against (B: its parent). */
    a: BodyHandle;
    b: BodyHandle;
    /** 'hinge': only about `axisB`; 'swing': every way (ball and cone joints). */
    kind: 'swing' | 'hinge';
    /** The joint's pivot in B. */
    anchorB: readonly number[];
    /** A hinge's axis in B (unit). */
    axisB: readonly number[];
    /** The bodies this joint holds up (A and everything hanging from it): what gravity compensation weighs. */
    subtree: readonly BodyHandle[];
}

export interface DriveEntry {
    /** The key the drive is set and ordered by: the joint's handle in the world it was made in. */
    readonly id: number;
    /** The joint in THIS world (a copy in the physics worker keys its drives by the original's handles). */
    joint: number;
    record: DriveRecord;
    drive: JointDrive;
    /** A's rotation in B's frame to reach, [x y z w]. */
    readonly target: number[];
    /** The target's own angular velocity, in B's frame (what the spring damps relative to). */
    readonly omega: number[];
    /** [torque N·m, saturation 0..1, angle still to go rad] after the last substep. */
    readonly report: Float64Array;
    /** Params changed since a backend that drives natively last configured its motor. */
    dirty: boolean;
}

export interface PinEntry {
    readonly body: BodyHandle;
    /** What pins are ordered by: the body's handle in the world it was made in (a copy's own differ). */
    order: number;
    pin: BodyPin;
    /** The node-origin pose to pull toward, [px py pz qx qy qz qw]. */
    readonly target: number[];
    /** The target's velocity [vx vy vz wx wy wz] (centre of mass, world). */
    readonly velocity: number[];
}

/**
 * A backend's own spring for a drive (Jolt's motors). Given the drive and its effective INVERSE inertia K
 * (row-major 3x3, world: the spring along unit axis `a` meets an inertia of 1/(aᵀKa)), true when it took the
 * spring; the solver then skips its own (gravity compensation stays here).
 */
export type NativeDrive = (entry: DriveEntry, inverseInertia: readonly number[], rotationA: readonly number[], dt: number) => boolean;

interface Mass { mass: number; invMass: number; com: number[]; inertia: number[]; frame: number[] }
interface State {
    stamp: number;
    /** Centre of mass, rotation, linear and angular velocity. */
    readonly com: number[];
    readonly q: number[];
    readonly v: number[];
    readonly w: number[];
    /** World inertia and its inverse, row-major 3x3. */
    readonly I: number[];
    readonly invI: number[];
    mass: number;
    invMass: number;
    enabled: boolean;
    woken: boolean;
}

/** Most a spring may be asked per substep: Ωh past 1 stops being a muscle and starts being a constraint the solver fights. */
export const MAX_OMEGA_H = 1;
const TWO_PI = Math.PI * 2;

export class DriveSolver {
    private readonly _drives = new Map<number, DriveEntry>();
    private readonly _pins = new Map<BodyHandle, PinEntry>();
    private _driveOrder: DriveEntry[] | null = null;
    private _pinOrder: PinEntry[] | null = null;
    private readonly _mass = new Map<BodyHandle, Mass>();
    private readonly _states = new Map<BodyHandle, State>();
    private _stamp = 0;
    private readonly _mp: MassProperties = { mass: 0, centerOfMass: [0, 0, 0], inertia: [0, 0, 0] };
    private readonly _pose = [0, 0, 0, 0, 0, 0, 1];
    private readonly _vel = [0, 0, 0, 0, 0, 0];
    private readonly _frame = [0, 0, 0, 1];
    private readonly _pivot = [0, 0, 0];
    private readonly _t3 = [0, 0, 0];
    private readonly _u3 = [0, 0, 0];
    private readonly _e3 = [0, 0, 0];
    private readonly _k9 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    private readonly _m9 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    private readonly _s9 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    private readonly _c9 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    private readonly _k9b = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    private readonly _k9c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    private readonly _v3a = [0, 0, 0];
    private readonly _q4 = [0, 0, 0, 1];
    private readonly _r4 = [0, 0, 0, 1];
    private _warned = false;
    /** Told of each drive taken away (a backend switching its own motor off). */
    public onRemove: ((entry: DriveEntry) => void) | null = null;

    /** Drives and pins in all: 0 means `apply` does nothing. */
    public get size(): number { return this._drives.size + this._pins.size; }
    public get driveCount(): number { return this._drives.size; }
    public get pinCount(): number { return this._pins.size; }

    // ---- drives ----

    /**
     * Drive joint `id` (the world's handle) with `drive`, acting as `record` says; null stops it. The target
     * starts at the rotation the bodies hold now unless one was set before.
     */
    public setDrive(id: number, record: DriveRecord | null, drive: JointDrive | null, bodies?: DriveBodies, joint = id): void {
        if (!drive || !record) {
            const gone = this._drives.get(id);
            if (gone) { this._drives.delete(id); this._driveOrder = null; this.onRemove?.(gone); }
            return;
        }
        let entry = this._drives.get(id);
        if (!entry) {
            entry = {
                id, joint, record, drive: { ...drive }, target: [0, 0, 0, 1], omega: [0, 0, 0],
                report: new Float64Array(3), dirty: true,
            };
            if (bodies) this._currentRelative(bodies, record, entry.target);
            this._drives.set(id, entry);
            this._driveOrder = null;
        } else {
            if (!sameDrive(entry.drive, drive)) { entry.drive = { ...drive }; entry.dirty = true; }
            // The same joint driven again: new gains only, unless what it acts on changed.
            if (sameRecord(entry.record, record)) return;
            entry.record = record;
        }
        if (bodies) {
            this._refreshMass(bodies, record.a);
            this._refreshMass(bodies, record.b);
            for (const h of record.subtree) this._refreshMass(bodies, h);
        }
    }

    public drive(id: number): DriveEntry | undefined { return this._drives.get(id); }

    /** A's rotation in B's frame to turn toward, and that target's own angular velocity (in B's frame). */
    public setTarget(id: number, rotation: ArrayLike<number>, angularVelocity?: ArrayLike<number> | null): void {
        const e = this._drives.get(id);
        if (!e) return;
        let x = rotation[0], y = rotation[1], z = rotation[2], w = rotation[3];
        const n = Math.hypot(x, y, z, w);
        if (!(n > 0) || !Number.isFinite(n)) return;
        x /= n; y /= n; z /= n; w /= n;
        e.target[0] = x; e.target[1] = y; e.target[2] = z; e.target[3] = w;
        if (angularVelocity && Number.isFinite(angularVelocity[0] + angularVelocity[1] + angularVelocity[2])) {
            e.omega[0] = angularVelocity[0]; e.omega[1] = angularVelocity[1]; e.omega[2] = angularVelocity[2];
        } else {
            e.omega[0] = e.omega[1] = e.omega[2] = 0;
        }
    }

    /**
     * Write a drive's target and a pin's as they are held elsewhere, already normalised: what a copy does, so
     * normalising twice cannot move a bit.
     */
    public writeTarget(id: number, rotation: ArrayLike<number>, angularVelocity: ArrayLike<number>): void {
        const e = this._drives.get(id);
        if (!e) return;
        for (let i = 0; i < 4; i++) e.target[i] = rotation[i];
        for (let i = 0; i < 3; i++) e.omega[i] = angularVelocity[i];
    }

    public writePinTarget(body: BodyHandle, pose: ArrayLike<number>, velocity: ArrayLike<number>): void {
        const e = this._pins.get(body);
        if (!e) return;
        for (let i = 0; i < 7; i++) e.target[i] = pose[i];
        for (let i = 0; i < 6; i++) e.velocity[i] = velocity[i];
    }

    /** [torque N·m, saturation 0..1, angle to go rad] after the last substep, into `out`. */
    public report(id: number, out: Out): void {
        const r = this._drives.get(id)?.report;
        out[0] = r ? r[0] : 0; out[1] = r ? r[1] : 0; out[2] = r ? r[2] : 0;
    }

    /** Write a report measured elsewhere (the physics worker's step). */
    public land(id: number, torque: number, saturation: number, error: number): void {
        const r = this._drives.get(id)?.report;
        if (r) { r[0] = torque; r[1] = saturation; r[2] = error; }
    }

    // ---- pins ----

    public setPin(body: BodyHandle, pin: BodyPin | null, bodies?: DriveBodies, order: number = body): void {
        if (!pin) {
            if (this._pins.delete(body)) this._pinOrder = null;
            return;
        }
        let entry = this._pins.get(body);
        if (!entry) {
            const target = [0, 0, 0, 0, 0, 0, 1];
            if (bodies) bodies.getTransform(body, target);
            entry = { body, order, pin: { ...pin }, target, velocity: [0, 0, 0, 0, 0, 0] };
            this._pins.set(body, entry);
            this._pinOrder = null;
            if (bodies) this._refreshMass(bodies, body);
        } else if (!samePin(entry.pin, pin)) entry.pin = { ...pin };
    }

    public pin(body: BodyHandle): PinEntry | undefined { return this._pins.get(body); }

    public setPinTarget(body: BodyHandle, pose: ArrayLike<number>, velocity?: ArrayLike<number> | null): void {
        const e = this._pins.get(body);
        if (!e) return;
        for (let i = 0; i < 7; i++) if (!Number.isFinite(pose[i])) return;
        for (let i = 0; i < 7; i++) e.target[i] = pose[i];
        const n = Math.hypot(e.target[3], e.target[4], e.target[5], e.target[6]) || 1;
        for (let i = 3; i < 7; i++) e.target[i] /= n;
        for (let i = 0; i < 6; i++) e.velocity[i] = velocity && Number.isFinite(velocity[i]) ? velocity[i] : 0;
    }

    // ---- lifetime ----

    /** Drop every drive and pin on a body leaving the world. */
    public removeBody(h: BodyHandle): void {
        if (this._pins.delete(h)) this._pinOrder = null;
        for (const [id, e] of this._drives) {
            if (e.record.a === h || e.record.b === h) { this._drives.delete(id); this._driveOrder = null; this.onRemove?.(e); }
        }
        this._mass.delete(h);
        this._states.delete(h);
    }

    public clear(): void {
        this._drives.clear();
        this._pins.clear();
        this._driveOrder = this._pinOrder = null;
        this._mass.clear();
        this._states.clear();
    }

    /** Every drive, in id order (what a copy sends). */
    public drives(): readonly DriveEntry[] {
        return this._driveOrder ??= [...this._drives.values()].sort((x, y) => x.id - y.id);
    }

    /** Every pin, in the order of the bodies' handles where they were made. */
    public pins(): readonly PinEntry[] {
        return this._pinOrder ??= [...this._pins.values()].sort((x, y) => x.order - y.order);
    }

    // ---- the substep ----

    /**
     * Push every drive and pin for a substep of `dt` seconds: torques and forces the coming step integrates.
     * `native` takes a drive's spring where the backend has its own (its gravity compensation stays here).
     */
    public apply(bodies: DriveBodies, dt: number, native?: NativeDrive): void {
        if (this.size === 0 || !(dt > 0)) return;
        this._stamp++;
        const g = bodies.gravity;
        for (const e of this.drives()) this._applyDrive(bodies, e, dt, g, native);
        for (const p of this.pins()) this._applyPin(bodies, p, dt);
    }

    private _applyDrive(bodies: DriveBodies, e: DriveEntry, h: number, g: V3, native?: NativeDrive): void {
        const r = e.record;
        const A = this._state(bodies, r.a), B = this._state(bodies, r.b);
        const report = e.report;
        report[0] = report[1] = report[2] = 0;
        if (!A || !B || !A.enabled || !B.enabled || (A.invMass === 0 && B.invMass === 0)) return;
        const d = e.drive;
        const maxJ = Math.max(0, d.maxTorque) * h;

        // The rotation still to go, in world space: target·relative⁻¹ as a rotation vector in B, turned by B.
        const qRel = this._q4, rr = this._r4, err = this._e3;
        conjMul(B.q, A.q, qRel);                        // inv(qB)·qA
        mulConj(e.target, qRel, rr);                    // qT·inv(qRel)
        rotationVector(rr, this._t3);
        rotate(B.q, this._t3[0], this._t3[1], this._t3[2], err);
        report[2] = Math.hypot(err[0], err[1], err[2]);

        const pivot = this._pivot;
        this._originPoint(B, r.b, r.anchorB, pivot);

        // Gravity's moment about the pivot on what this joint holds up; compensation cancels `gc` of it.
        const gc = d.gravityCompensation ?? 0;
        let gx = 0, gy = 0, gz = 0;
        const add = (S: State | undefined) => {
            if (!S || !S.enabled || S.mass <= 0) return;
            const fx = S.mass * g[0], fy = S.mass * g[1], fz = S.mass * g[2];
            const rx = S.com[0] - pivot[0], ry = S.com[1] - pivot[1], rz = S.com[2] - pivot[2];
            gx += ry * fz - rz * fy; gy += rz * fx - rx * fz; gz += rx * fy - ry * fx;
        };
        if (r.subtree.length === 0) add(A);
        else for (const s of r.subtree) add(this._state(bodies, s));
        let torqueSum = 0;
        if (gc > 0 && maxJ > 0) {
            let tx = -gc * gx, ty = -gc * gy, tz = -gc * gz;
            const t = Math.hypot(tx, ty, tz), cap = Math.max(0, d.maxTorque);
            if (t > cap && t > 0) { const s = cap / t; tx *= s; ty *= s; tz *= s; }
            if (Number.isFinite(tx + ty + tz) && (tx !== 0 || ty !== 0 || tz !== 0)) {
                this._torque(bodies, r.a, A, tx, ty, tz);
                this._torque(bodies, r.b, B, -tx, -ty, -tz);
                torqueSum = Math.hypot(tx, ty, tz);
                // What gravity still turns the joint with.
                gx += tx; gy += ty; gz += tz;
            }
        }
        if (!Number.isFinite(gx + gy + gz)) gx = gy = gz = 0;

        // K: the joint's effective inverse inertia (see the header).
        const K = this._k9;
        if (!this._jointInverseInertia(bodies, r, A, B, pivot, K)) return;

        if (native && native(e, K, A.q, h)) { report[0] += torqueSum; return; }

        // Relative angular velocity, measured from the target's own.
        const om = this._u3;
        rotate(B.q, e.omega[0], e.omega[1], e.omega[2], om);
        const wx = A.w[0] - B.w[0] - om[0], wy = A.w[1] - B.w[1] - om[1], wz = A.w[2] - B.w[2] - om[2];

        // Kc: the pair's own inverse inertia about their centres, what a torque on them meets in the instant it is
        // applied (the joint carries the rest round only through the solver). The spring's gains come from the
        // joint's inertia (K above); it is solved implicitly against Kc, so it stays stable however stiff.
        const Kc = this._c9;
        for (let i = 0; i < 9; i++) Kc[i] = A.invI[i] + B.invI[i];

        let jx = 0, jy = 0, jz = 0;
        const f = Math.max(0, d.frequency);
        if (f > 0 && maxJ > 0) {
            let omega = TWO_PI * f;
            if (omega * h > MAX_OMEGA_H) omega = MAX_OMEGA_H / h;
            const zeta = Math.max(0, d.damping);
            // k = I·Ω², c = 2ζIΩ with I the joint's inertia; (Ic + h·c + h²·k)·ω' = Ic·ω + h·(k·e + τ), τ what
            // gravity still turns the joint with; the impulse is Ic·(ω' − ω) less τ's own, which the step adds:
            // so a weight is held at exactly k, as a motor holds it.
            const kScale = omega * omega, cScale = 2 * zeta * omega;
            if (r.kind === 'hinge') {
                const a = this._t3;
                rotate(B.q, r.axisB[0], r.axisB[1], r.axisB[2], a);
                const ea = err[0] * a[0] + err[1] * a[1] + err[2] * a[2];
                const wa = wx * a[0] + wy * a[1] + wz * a[2];
                const ta = gx * a[0] + gy * a[1] + gz * a[2];
                const kp = quadratic(K, a), kc = quadratic(Kc, a);
                if (kp > 0 && kc > 0) {
                    const Ip = 1 / kp, Ic = 1 / kc, k = Ip * kScale, c = Ip * cScale * dampingFor(Ic, Ip * h * cScale, Ip * h * h * kScale);
                    const w2 = (Ic * wa + h * (k * ea + ta)) / (Ic + h * c + h * h * k);
                    const j = Ic * (w2 - wa) - h * ta;
                    jx = j * a[0]; jy = j * a[1]; jz = j * a[2];
                }
            } else {
                const Ip = this._m9, Ic = this._s9, S = this._k9b;
                if (invert3(K, Ip) && invert3(Kc, Ic)) {
                    // S = Ic + h·c + h²·k, rhs = Ic·ω + h·(k·e + τ)
                    const tc = Ic[0] + Ic[4] + Ic[8], tp = Ip[0] + Ip[4] + Ip[8];
                    const cs = cScale * dampingFor(tc, tp * h * cScale, tp * h * h * kScale);
                    for (let i = 0; i < 9; i++) S[i] = Ic[i] + (h * cs + h * h * kScale) * Ip[i];
                    const ke = this._v3a;
                    ke[0] = kScale * (Ip[0] * err[0] + Ip[1] * err[1] + Ip[2] * err[2]) + gx;
                    ke[1] = kScale * (Ip[3] * err[0] + Ip[4] * err[1] + Ip[5] * err[2]) + gy;
                    ke[2] = kScale * (Ip[6] * err[0] + Ip[7] * err[1] + Ip[8] * err[2]) + gz;
                    const rx = Ic[0] * wx + Ic[1] * wy + Ic[2] * wz + h * ke[0];
                    const ry = Ic[3] * wx + Ic[4] * wy + Ic[5] * wz + h * ke[1];
                    const rz = Ic[6] * wx + Ic[7] * wy + Ic[8] * wz + h * ke[2];
                    const Si = this._k9c;
                    if (invert3(S, Si)) {
                        const w2x = Si[0] * rx + Si[1] * ry + Si[2] * rz;
                        const w2y = Si[3] * rx + Si[4] * ry + Si[5] * rz;
                        const w2z = Si[6] * rx + Si[7] * ry + Si[8] * rz;
                        const dx = w2x - wx, dy = w2y - wy, dz = w2z - wz;
                        jx = Ic[0] * dx + Ic[1] * dy + Ic[2] * dz - h * gx;
                        jy = Ic[3] * dx + Ic[4] * dy + Ic[5] * dz - h * gy;
                        jz = Ic[6] * dx + Ic[7] * dy + Ic[8] * dz - h * gz;
                    }
                }
            }
        } else if ((d.friction ?? 0) > 0) {
            // No spring: resist the joint's motion, up to the friction torque.
            const M = this._m9;
            if (invert3(Kc, M)) {
                jx = -(M[0] * wx + M[1] * wy + M[2] * wz);
                jy = -(M[3] * wx + M[4] * wy + M[5] * wz);
                jz = -(M[6] * wx + M[7] * wy + M[8] * wz);
                const cap = d.friction! * h, j = Math.hypot(jx, jy, jz);
                if (j > cap) { const s = cap / j; jx *= s; jy *= s; jz *= s; }
            }
        }
        if (!Number.isFinite(jx + jy + jz)) {
            if (!this._warned) { this._warned = true; console.warn(`physics: drive ${e.id} went non-finite; skipped`); }
            return;
        }
        const j = Math.hypot(jx, jy, jz);
        if (j === 0) { report[0] = torqueSum; return; }
        let saturation = maxJ > 0 ? j / maxJ : 1;
        if (maxJ > 0 && j > maxJ) { const s = maxJ / j; jx *= s; jy *= s; jz *= s; saturation = 1; }
        const tx = jx / h, ty = jy / h, tz = jz / h;
        this._torque(bodies, r.a, A, tx, ty, tz);
        this._torque(bodies, r.b, B, -tx, -ty, -tz);
        report[0] = torqueSum + Math.hypot(tx, ty, tz);
        report[1] = saturation > 1 ? 1 : saturation;
    }

    /**
     * K = I_A*⁻¹ + I_B*⁻¹ into `out`: I_A* the inertia of what the joint holds up (its subtree, else A alone)
     * about the pivot, I_B* the parent's about the same point (none for an immovable parent). False when
     * nothing can turn.
     */
    private _jointInverseInertia(bodies: DriveBodies, r: DriveRecord, A: State, B: State, pivot: number[], out: number[]): boolean {
        const S = this._s9, inv = this._m9;
        for (let i = 0; i < 9; i++) S[i] = 0;
        if (r.subtree.length === 0) addAbout(S, A, pivot);
        else for (const h of r.subtree) { const s = this._state(bodies, h); if (s && s.enabled && s.mass > 0) addAbout(S, s, pivot); }
        if (!invert3(S, inv)) return false;
        for (let i = 0; i < 9; i++) out[i] = inv[i];
        if (B.mass > 0) {
            for (let i = 0; i < 9; i++) S[i] = 0;
            addAbout(S, B, pivot);
            if (invert3(S, inv)) for (let i = 0; i < 9; i++) out[i] += inv[i];
        }
        return true;
    }

    private _applyPin(bodies: DriveBodies, p: PinEntry, h: number): void {
        const S = this._state(bodies, p.body);
        if (!S || !S.enabled || S.invMass === 0) return;
        const pin = p.pin, t = p.target, vel = p.velocity;
        // The target pose's centre of mass.
        const m = this._mass.get(p.body)!;
        const c = this._t3, tq = this._q4;
        tq[0] = t[3]; tq[1] = t[4]; tq[2] = t[5]; tq[3] = t[6];
        rotate(tq, m.com[0], m.com[1], m.com[2], c);
        const cx = t[0] + c[0], cy = t[1] + c[1], cz = t[2] + c[2];

        const lf = Math.max(0, pin.linearFrequency);
        if (lf > 0 && pin.maxForce > 0) {
            let omega = TWO_PI * lf;
            if (omega * h > MAX_OMEGA_H) omega = MAX_OMEGA_H / h;
            const zeta = Math.max(0, pin.damping);
            const denom = 1 + 2 * zeta * omega * h + omega * omega * h * h, kh = h * omega * omega;
            const ex = cx - S.com[0], ey = cy - S.com[1], ez = cz - S.com[2];
            const vx = S.v[0] - vel[0], vy = S.v[1] - vel[1], vz = S.v[2] - vel[2];
            let fx = S.mass * ((vx + kh * ex) / denom - vx) / h;
            let fy = S.mass * ((vy + kh * ey) / denom - vy) / h;
            let fz = S.mass * ((vz + kh * ez) / denom - vz) / h;
            const f = Math.hypot(fx, fy, fz);
            if (f > pin.maxForce) { const s = pin.maxForce / f; fx *= s; fy *= s; fz *= s; }
            if (Number.isFinite(fx + fy + fz) && f > 0) {
                const force = this._u3;
                force[0] = fx; force[1] = fy; force[2] = fz;
                bodies.applyForce(p.body, force);
                this._wake(bodies, p.body, S);
            }
        }

        const af = Math.max(0, pin.angularFrequency);
        if (af > 0 && pin.maxTorque > 0) {
            let omega = TWO_PI * af;
            if (omega * h > MAX_OMEGA_H) omega = MAX_OMEGA_H / h;
            const zeta = Math.max(0, pin.damping);
            const denom = 1 + 2 * zeta * omega * h + omega * omega * h * h, kh = h * omega * omega;
            const rr = this._r4, err = this._e3;
            mulConj(tq, S.q, rr);
            rotationVector(rr, err);
            const wx = S.w[0] - vel[3], wy = S.w[1] - vel[4], wz = S.w[2] - vel[5];
            const dx = (wx + kh * err[0]) / denom - wx, dy = (wy + kh * err[1]) / denom - wy, dz = (wz + kh * err[2]) / denom - wz;
            // τ = I·Δω/h, I the body's world inertia.
            const I = S.I;
            let tx = (I[0] * dx + I[1] * dy + I[2] * dz) / h;
            let ty = (I[3] * dx + I[4] * dy + I[5] * dz) / h;
            let tz = (I[6] * dx + I[7] * dy + I[8] * dz) / h;
            const tt = Math.hypot(tx, ty, tz);
            if (tt > pin.maxTorque) { const s = pin.maxTorque / tt; tx *= s; ty *= s; tz *= s; }
            if (Number.isFinite(tx + ty + tz) && tt > 0) this._torque(bodies, p.body, S, tx, ty, tz);
        }
    }

    // ---- bodies ----

    private _torque(bodies: DriveBodies, h: BodyHandle, s: State, x: number, y: number, z: number): void {
        if (s.invMass === 0) return;
        const t = this._u3;
        t[0] = x; t[1] = y; t[2] = z;
        bodies.applyTorque(h, t);
        this._wake(bodies, h, s);
    }

    private _wake(bodies: DriveBodies, h: BodyHandle, s: State): void {
        if (s.woken) return;
        s.woken = true;
        if (bodies.isSleeping(h)) bodies.wakeUp(h);
    }

    private _refreshMass(bodies: DriveBodies, h: BodyHandle): void {
        const mp = bodies.getMassProperties(h, this._mp);
        const m = this._mass.get(h) ?? { mass: 0, invMass: 0, com: [0, 0, 0], inertia: [0, 0, 0], frame: [0, 0, 0, 1] };
        m.mass = mp.mass > 0 && Number.isFinite(mp.mass) ? mp.mass : 0;
        m.invMass = m.mass > 0 ? 1 / m.mass : 0;
        m.com[0] = mp.centerOfMass[0]; m.com[1] = mp.centerOfMass[1]; m.com[2] = mp.centerOfMass[2];
        for (let i = 0; i < 3; i++) m.inertia[i] = m.mass > 0 && mp.inertia[i] > 0 ? mp.inertia[i] : 0;
        const f = this._frame;
        f[0] = 0; f[1] = 0; f[2] = 0; f[3] = 1;
        if (bodies.inertiaFrame && m.mass > 0) bodies.inertiaFrame(h, f);
        const n = Math.hypot(f[0], f[1], f[2], f[3]) || 1;
        for (let i = 0; i < 4; i++) m.frame[i] = f[i] / n;
        this._mass.set(h, m);
    }

    /** A body's state this substep, read once. */
    private _state(bodies: DriveBodies, h: BodyHandle): State | undefined {
        let s = this._states.get(h);
        if (s && s.stamp === this._stamp) return s;
        let m = this._mass.get(h);
        if (!m) { this._refreshMass(bodies, h); m = this._mass.get(h)!; }
        if (!s) {
            s = {
                stamp: 0, com: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0],
                I: [0, 0, 0, 0, 0, 0, 0, 0, 0], invI: [0, 0, 0, 0, 0, 0, 0, 0, 0], mass: 0, invMass: 0, enabled: false, woken: false,
            };
            this._states.set(h, s);
        }
        s.stamp = this._stamp;
        s.woken = false;
        s.enabled = bodies.isEnabled(h);
        if (!s.enabled) return s;
        const pose = this._pose, vel = this._vel;
        bodies.getTransform(h, pose);
        bodies.getVelocity(h, vel);
        s.q[0] = pose[3]; s.q[1] = pose[4]; s.q[2] = pose[5]; s.q[3] = pose[6];
        rotate(s.q, m.com[0], m.com[1], m.com[2], s.com);
        s.com[0] += pose[0]; s.com[1] += pose[1]; s.com[2] += pose[2];
        s.v[0] = vel[0]; s.v[1] = vel[1]; s.v[2] = vel[2];
        s.w[0] = vel[3]; s.w[1] = vel[4]; s.w[2] = vel[5];
        s.mass = m.mass;
        s.invMass = m.invMass;
        // The principal frame in the world: body rotation · inertia frame. I = R·diag·Rᵀ, I⁻¹ = R·diag⁻¹·Rᵀ.
        const fq = this._r4;
        quatMul(s.q, m.frame, fq);
        const qx = fq[0], qy = fq[1], qz = fq[2], qw = fq[3];
        const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
        const r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz), r02 = 2 * (xz + wy);
        const r10 = 2 * (xy + wz), r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
        const r20 = 2 * (xz - wy), r21 = 2 * (yz + wx), r22 = 1 - 2 * (xx + yy);
        const ix = m.inertia[0], iy = m.inertia[1], iz = m.inertia[2];
        sandwich(s.I, r00, r01, r02, r10, r11, r12, r20, r21, r22, ix, iy, iz);
        sandwich(s.invI, r00, r01, r02, r10, r11, r12, r20, r21, r22, ix > 0 ? 1 / ix : 0, iy > 0 ? 1 / iy : 0, iz > 0 ? 1 / iz : 0);
        return s;
    }

    /** A point given from body `h`'s origin, in the world. */
    private _originPoint(s: State, h: BodyHandle, local: readonly number[], out: number[]): void {
        const m = this._mass.get(h)!;
        // origin = com − R·comLocal; point = origin + R·local = com + R·(local − comLocal)
        rotate(s.q, local[0] - m.com[0], local[1] - m.com[1], local[2] - m.com[2], out);
        out[0] += s.com[0]; out[1] += s.com[1]; out[2] += s.com[2];
    }

    /** A's rotation in B's frame as the two stand now, into `out`. */
    private _currentRelative(bodies: DriveBodies, r: DriveRecord, out: number[]): void {
        const pa = [0, 0, 0, 0, 0, 0, 1], pb = [0, 0, 0, 0, 0, 0, 1];
        bodies.getTransform(r.a, pa);
        bodies.getTransform(r.b, pb);
        conjMul([pb[3], pb[4], pb[5], pb[6]], [pa[3], pa[4], pa[5], pa[6]], out);
    }
}

// ---- arithmetic ----

/**
 * How much more damping the spring needs to keep its damping ratio once the implicit solve against the bodies'
 * own inertia (`ic`) has softened it: the solve scales stiffness and damping both by ic / (ic + hc + h²k), which
 * leaves the stiffness lower (stable) and the ratio lower by the square root of that; this puts the ratio back.
 * `hc`, `hhk`: h·c and h²·k at the asked damping.
 */
function dampingFor(ic: number, hc: number, hhk: number): number {
    if (!(ic > 0)) return 1;
    let s = 1;
    for (let i = 0; i < 3; i++) s = Math.sqrt((ic + hc * s + hhk) / ic);
    return Number.isFinite(s) ? s : 1;
}

/** `out` = R·diag(a, b, c)·Rᵀ, row-major, R given by its rows. */
function sandwich(out: number[], r00: number, r01: number, r02: number, r10: number, r11: number, r12: number,
    r20: number, r21: number, r22: number, a: number, b: number, c: number): void {
    out[0] = r00 * r00 * a + r01 * r01 * b + r02 * r02 * c;
    out[1] = r00 * r10 * a + r01 * r11 * b + r02 * r12 * c;
    out[2] = r00 * r20 * a + r01 * r21 * b + r02 * r22 * c;
    out[3] = out[1];
    out[4] = r10 * r10 * a + r11 * r11 * b + r12 * r12 * c;
    out[5] = r10 * r20 * a + r11 * r21 * b + r12 * r22 * c;
    out[6] = out[2];
    out[7] = out[5];
    out[8] = r20 * r20 * a + r21 * r21 * b + r22 * r22 * c;
}

/** Add a body's inertia about `pivot` (its own world inertia plus m·(|r|²E − r·rᵀ)) into `out`. */
function addAbout(out: number[], s: State, pivot: ArrayLike<number>): void {
    const rx = s.com[0] - pivot[0], ry = s.com[1] - pivot[1], rz = s.com[2] - pivot[2], m = s.mass;
    const r2 = rx * rx + ry * ry + rz * rz;
    const I = s.I;
    out[0] += I[0] + m * (r2 - rx * rx); out[1] += I[1] - m * rx * ry; out[2] += I[2] - m * rx * rz;
    out[3] += I[3] - m * ry * rx; out[4] += I[4] + m * (r2 - ry * ry); out[5] += I[5] - m * ry * rz;
    out[6] += I[6] - m * rz * rx; out[7] += I[7] - m * rz * ry; out[8] += I[8] + m * (r2 - rz * rz);
}

/** inv(a)·b into `out`. */
export function conjMul(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]): number[] {
    const ax = -a[0], ay = -a[1], az = -a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

/** a·inv(b) into `out`. */
export function mulConj(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]): number[] {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = -b[0], by = -b[1], bz = -b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

/** a·b into `out`. */
export function quatMul(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]): number[] {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}

/** The rotation vector (axis × angle, the short way round) of a unit quaternion, into `out`. */
export function rotationVector(q: ArrayLike<number>, out: number[]): number[] {
    let x = q[0], y = q[1], z = q[2], w = q[3];
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const s = Math.hypot(x, y, z);
    if (s < 1e-12) { out[0] = 2 * x; out[1] = 2 * y; out[2] = 2 * z; return out; }
    const angle = 2 * Math.atan2(s, w);
    const k = angle / s;
    out[0] = x * k; out[1] = y * k; out[2] = z * k;
    return out;
}

/** `q` applied to (x, y, z), into `out`. */
export function rotate(q: ArrayLike<number>, x: number, y: number, z: number, out: number[]): number[] {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return out;
}

/** kᵀ·M·k for a row-major 3x3. */
export function quadratic(M: ArrayLike<number>, k: ArrayLike<number>): number {
    const x = k[0], y = k[1], z = k[2];
    return x * (M[0] * x + M[1] * y + M[2] * z) + y * (M[3] * x + M[4] * y + M[5] * z) + z * (M[6] * x + M[7] * y + M[8] * z);
}

/** The inverse of a row-major 3x3 into `out`; false when singular. */
function invert3(m: ArrayLike<number>, out: number[]): boolean {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-30) || !Number.isFinite(det)) return false;
    const inv = 1 / det;
    out[0] = A * inv; out[1] = -(b * i - c * h) * inv; out[2] = (b * f - c * e) * inv;
    out[3] = B * inv; out[4] = (a * i - c * g) * inv; out[5] = -(a * f - c * d) * inv;
    out[6] = C * inv; out[7] = -(a * h - b * g) * inv; out[8] = (a * e - b * d) * inv;
    return true;
}

function sameRecord(a: DriveRecord, b: DriveRecord): boolean {
    if (a === b) return true;
    if (a.a !== b.a || a.b !== b.b || a.kind !== b.kind || a.subtree.length !== b.subtree.length) return false;
    for (let i = 0; i < 3; i++) if (a.anchorB[i] !== b.anchorB[i] || a.axisB[i] !== b.axisB[i]) return false;
    for (let i = 0; i < a.subtree.length; i++) if (a.subtree[i] !== b.subtree[i]) return false;
    return true;
}

function sameDrive(a: JointDrive, b: JointDrive): boolean {
    return a.frequency === b.frequency && a.damping === b.damping && a.maxTorque === b.maxTorque
        && (a.friction ?? 0) === (b.friction ?? 0) && (a.gravityCompensation ?? 0) === (b.gravityCompensation ?? 0);
}

function samePin(a: BodyPin, b: BodyPin): boolean {
    return a.linearFrequency === b.linearFrequency && a.angularFrequency === b.angularFrequency && a.damping === b.damping
        && a.maxForce === b.maxForce && a.maxTorque === b.maxTorque;
}
