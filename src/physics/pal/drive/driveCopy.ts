import type { BodyHandle } from '../types';
import type { DriveBodies, DriveSolver } from './driveSolver';

// Copying a world's drives and pins into the physics worker (see pal/replication.ts). They change every frame
// (a reactive ragdoll retargets every muscle), so they go out whole each frame there are any, the way vehicle
// inputs do: one row per drive and per pin, bodies named by slot. The replica keys its drives by the
// original's joint handles and orders its pins by the original's body handles, so its solver adds the same
// torques in the same order and the copy steps as the original would, bit for bit.
//
// What a drive did (DriveSolver.report) is not sent back: in worker mode readJointDrive reads zeros.

/** A frame's drives and pins, rows as laid out below. Empty arrays: none any more. */
export interface DriveChanges {
    /**
     * Per drive: [id, slotA, slotB, kind (0 swing, 1 hinge), anchorB×3, axisB×3, frequency, damping, maxTorque,
     * friction, gravityCompensation, inertia (0: the joint's own), target×4, omega×3, torque×3, n, n subtree slots,
     * m, m chain slots].
     */
    drives: Float64Array;
    /** Per pin: [slot, order, linearFrequency, angularFrequency, damping, maxForce, maxTorque, target×7, velocity×6]. */
    pins: Float64Array;
}

/** A drive row's fixed part: its subtree's slots follow it, then its chain's (counted). */
const DRIVE_HEAD = 27;
const PIN_ROW = 20;

/** The main thread's end: what the world's drives and pins are this frame. */
export class DriveMirror {
    private _sent = false;
    constructor(
        private readonly _world: { readonly drives: DriveSolver },
        private readonly _slotOf: (h: BodyHandle) => number | undefined,
    ) {}

    /** The drives and pins to send with this frame's step; undefined while there are none and none were sent. */
    public diff(): DriveChanges | undefined {
        const solver = this._world.drives;
        if (solver.size === 0) {
            if (!this._sent) return undefined;
            this._sent = false;
            return { drives: new Float64Array(0), pins: new Float64Array(0) };
        }
        this._sent = true;
        const rows: number[] = [];
        for (const e of solver.drives()) {
            const r = e.record, a = this._slotOf(r.a), b = this._slotOf(r.b);
            if (a === undefined || b === undefined) continue;
            const subtree: number[] = [], chain: number[] = [];
            let whole = true;
            for (const h of r.subtree) { const s = this._slotOf(h); if (s === undefined) { whole = false; break; } subtree.push(s); }
            if (!whole) continue;
            for (const h of r.chain ?? []) { const s = this._slotOf(h); if (s === undefined) { chain.length = 0; break; } chain.push(s); }
            const d = e.drive;
            rows.push(e.id, a, b, r.kind === 'hinge' ? 1 : 0, r.anchorB[0], r.anchorB[1], r.anchorB[2], r.axisB[0], r.axisB[1], r.axisB[2],
                d.frequency, d.damping, d.maxTorque, d.friction ?? 0, d.gravityCompensation ?? 0, d.inertia ?? 0,
                e.target[0], e.target[1], e.target[2], e.target[3], e.omega[0], e.omega[1], e.omega[2], e.torque[0], e.torque[1], e.torque[2],
                subtree.length, ...subtree, chain.length, ...chain);
        }
        const pins: number[] = [];
        for (const p of solver.pins()) {
            const s = this._slotOf(p.body);
            if (s === undefined) continue;
            const q = p.pin;
            pins.push(s, p.order, q.linearFrequency, q.angularFrequency, q.damping, q.maxForce, q.maxTorque, ...p.target, ...p.velocity);
        }
        return { drives: Float64Array.from(rows), pins: Float64Array.from(pins) };
    }

    public clear(): void { this._sent = false; }
}

/** The worker's end: the replica world's drives and pins made what the mirror sent. */
export class DriveReplica {
    private readonly _target = [0, 0, 0, 1];
    private readonly _omega = [0, 0, 0];
    private readonly _torque = [0, 0, 0];
    private readonly _pose = [0, 0, 0, 0, 0, 0, 1];
    private readonly _vel = [0, 0, 0, 0, 0, 0];

    constructor(
        private readonly _world: DriveBodies & { readonly drives: DriveSolver },
        private readonly _handleOf: (slot: number) => BodyHandle | undefined,
        /** The replica's own joint for the original's joint handle, where it has joints of its own (Jolt's motors drive them). */
        private readonly _jointOf?: (id: number) => number | undefined,
    ) {}

    public receive(changes: DriveChanges | undefined): void {
        if (!changes) return;
        const solver = this._world.drives, rows = changes.drives;
        const seen = new Set<number>();
        for (let i = 0; i + DRIVE_HEAD <= rows.length;) {
            const id = rows[i], n = rows[i + DRIVE_HEAD - 1];
            const at = i;
            const m = rows[i + DRIVE_HEAD + n];
            i += DRIVE_HEAD + n + 1 + m;
            const a = this._handleOf(rows[at + 1]), b = this._handleOf(rows[at + 2]);
            if (a === undefined || b === undefined) continue;
            const subtree: BodyHandle[] = [], chain: BodyHandle[] = [];
            for (let k = 0; k < n; k++) { const h = this._handleOf(rows[at + DRIVE_HEAD + k]); if (h !== undefined) subtree.push(h); }
            for (let k = 0; k < m; k++) { const h = this._handleOf(rows[at + DRIVE_HEAD + n + 1 + k]); if (h !== undefined) chain.push(h); }
            const record = {
                a, b, kind: rows[at + 3] === 1 ? 'hinge' as const : 'swing' as const,
                anchorB: [rows[at + 4], rows[at + 5], rows[at + 6]], axisB: [rows[at + 7], rows[at + 8], rows[at + 9]], subtree,
                ...(chain.length ? { chain } : {}),
            };
            const drive = {
                frequency: rows[at + 10], damping: rows[at + 11], maxTorque: rows[at + 12],
                friction: rows[at + 13], gravityCompensation: rows[at + 14],
                ...(rows[at + 15] > 0 ? { inertia: rows[at + 15] } : {}),
            };
            const joint = this._jointOf?.(id) ?? id;
            const entry = solver.drive(id);
            if (entry && entry.joint !== joint) solver.setDrive(id, null, null);
            solver.setDrive(id, record, drive, this._world, joint);
            const t = this._target, o = this._omega, q = this._torque;
            for (let k = 0; k < 4; k++) t[k] = rows[at + 16 + k];
            for (let k = 0; k < 3; k++) o[k] = rows[at + 20 + k];
            for (let k = 0; k < 3; k++) q[k] = rows[at + 23 + k];
            solver.writeTarget(id, t, o, q);
            seen.add(id);
        }
        for (const e of [...solver.drives()]) if (!seen.has(e.id)) solver.setDrive(e.id, null, null);

        const pins = changes.pins, held = new Set<BodyHandle>();
        for (let i = 0; i + PIN_ROW <= pins.length; i += PIN_ROW) {
            const h = this._handleOf(pins[i]);
            if (h === undefined) continue;
            solver.setPin(h, {
                linearFrequency: pins[i + 2], angularFrequency: pins[i + 3], damping: pins[i + 4], maxForce: pins[i + 5], maxTorque: pins[i + 6],
            }, this._world, pins[i + 1]);
            for (let k = 0; k < 7; k++) this._pose[k] = pins[i + 7 + k];
            for (let k = 0; k < 6; k++) this._vel[k] = pins[i + 14 + k];
            solver.writePinTarget(h, this._pose, this._vel);
            held.add(h);
        }
        for (const p of [...solver.pins()]) if (!held.has(p.body)) solver.setPin(p.body, null);
    }

    public clear(): void { this._world.drives.clear(); }
}
