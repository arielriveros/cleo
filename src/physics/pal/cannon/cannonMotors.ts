import { Constraint, RotationalMotorEquation, type Body, type World } from 'cannon-es';
import { motorVelocity, rotate, type DriveEntry, type NativeDriveState } from '../drive/driveSolver';

// Joint drives on cannon as velocity motors its own solver meets (RotationalMotorEquation, what its hinge motor
// is made of), rather than torques added to the step: solved with the joints, so a muscle on a limb that carries
// others moves it as stiffly as the numbers say — as Jolt's motors do — where a torque on the limb alone was held
// back to stay stable. Each drive is a constraint of three motor equations (one along a hinge's axis), retargeted
// every substep to the relative angular velocity its implicit spring asks for (drive/driveSolver.ts
// motorVelocity), and capped by the drive's torque.

interface Motor { constraint: Constraint; eqs: RotationalMotorEquation[]; h: number }

export class CannonMotors {
    private readonly _motors = new Map<number, Motor>();
    private readonly _w = [0, 0, 0];
    private readonly _a = [0, 0, 0];

    constructor(private readonly _world: World, private readonly _bodyOf: (h: number) => Body | undefined) {}

    /** Drive `e` this substep; false when it has no spring to drive (the shared solver takes its friction). */
    public drive(e: DriveEntry, s: NativeDriveState): boolean {
        const d = e.drive;
        if (!(d.frequency > 0) || !(d.maxTorque > 0)) { this.remove(e); return false; }
        const m = this._motorFor(e);
        if (!m) return false;
        const h = s.dt, cap = Math.max(0, d.maxTorque) * h;
        // The motor's softness is cannon's SPOOK, tuned for the step it is solved in.
        if (m.h !== h) { for (const q of m.eqs) q.setSpookParams(1e7, 4, h); m.h = h; }
        const w = motorVelocity(d.frequency, d.damping, h, s.omega, s.error, s.inverseInertia, s.gravity, this._w);
        // The motors hold the relative velocity measured from the target's spin: add that spin back.
        const target = this._a;
        const bq = this._bodyOf(e.record.b)!.quaternion;
        rotate([bq.x, bq.y, bq.z, bq.w], e.omega[0], e.omega[1], e.omega[2], target);
        if (e.record.kind === 'hinge') {
            const axis = rotate([bq.x, bq.y, bq.z, bq.w], e.record.axisB[0], e.record.axisB[1], e.record.axisB[2], [0, 0, 0]);
            this._set(m.eqs[0], axis[0], axis[1], axis[2], w[0] * axis[0] + w[1] * axis[1] + w[2] * axis[2] + target[0] * axis[0] + target[1] * axis[1] + target[2] * axis[2], cap);
            this._set(m.eqs[1], 0, 1, 0, 0, 0);
            this._set(m.eqs[2], 0, 0, 1, 0, 0);
        } else {
            this._set(m.eqs[0], 1, 0, 0, w[0] + target[0], cap);
            this._set(m.eqs[1], 0, 1, 0, w[1] + target[1], cap);
            this._set(m.eqs[2], 0, 0, 1, w[2] + target[2], cap);
        }
        // Readback: the impulses the last substep's solve used, as a torque.
        const lambda = Math.hypot(...m.eqs.map(q => (q as unknown as { multiplier?: number }).multiplier ?? 0));
        e.report[0] += lambda;
        e.report[1] = Math.min(1, lambda / Math.max(1e-9, d.maxTorque));
        return true;
    }

    public remove(e: DriveEntry): void {
        const m = this._motors.get(e.id);
        if (!m) return;
        this._world.removeConstraint(m.constraint);
        this._motors.delete(e.id);
    }

    public clear(): void { this._motors.clear(); }

    private _motorFor(e: DriveEntry): Motor | null {
        let m = this._motors.get(e.id);
        const a = this._bodyOf(e.record.a), b = this._bodyOf(e.record.b);
        if (!a || !b) return null;
        if (m && (m.constraint.bodyA !== a || m.constraint.bodyB !== b)) { this.remove(e); m = undefined; }
        if (m) return m;
        const constraint = new Constraint(a, b, { collideConnected: false, wakeUpBodies: true });
        const eqs = [0, 1, 2].map(() => new RotationalMotorEquation(a, b, 0));
        for (const q of eqs) { q.minForce = 0; q.maxForce = 0; }
        constraint.equations.push(...eqs);
        // The axes and targets are set each substep (drive), not from the bodies.
        constraint.update = () => {};
        this._world.addConstraint(constraint);
        m = { constraint, eqs, h: 0 };
        this._motors.set(e.id, m);
        return m;
    }

    private _set(q: RotationalMotorEquation, x: number, y: number, z: number, velocity: number, cap: number): void {
        // The motor holds axisA·ωA − axisB·ωB at the target: A's spin relative to B's along the axis.
        q.axisA.set(x, y, z);
        q.axisB.set(x, y, z);
        q.targetVelocity = velocity;
        q.maxForce = cap;
        q.minForce = -cap;
        q.enabled = cap > 0;
    }
}
