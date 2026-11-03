import type { ReplicaReport } from '../pal/replication';
import type { PhysicsBackendKind, V3 } from '../pal/types';
import type { WaterSpec } from '../waterSurface';

// The messages between the main thread's PhysicsSystem (WorkerExecutor) and the physics worker
// (workerCore). Plain structured-cloneable data plus typed arrays, which travel as transferables.
//
// The world itself travels in its backend's own format (pal/replication.ts): the main thread's WorldMirror
// diffs the engine's world each frame into `changes`, the worker's WorldReplica takes them in. Everything
// else here is the same on every backend. Bodies are addressed by SLOT, a small integer the mirror hands
// out and reuses.

export interface StepMessage {
    kind: 'step';
    epoch: number;
    seq: number;
    dt: number;
    substeps: number;
    profile: boolean;
    /** What changed in the main thread's world since the last step (MirrorDiff.changes), in its backend's format. */
    changes: unknown;
    gravity: V3;
    iterations: number;
    /** The main thread's world clock, which the step continues from. */
    time: number;
    water: WaterSpec[];
    /** Buffers the main thread is done with, handed back for the worker's next snapshot. */
    recycle: ArrayBuffer[];
}

/** Start over with an empty world on `backend`: the main thread's was cleared (a scene change), or is new. */
export interface ResetMessage { kind: 'reset'; epoch: number; backend: PhysicsBackendKind }

export type ToWorker = StepMessage | ResetMessage;

/**
 * A finished step. `bodies` holds the moving bodies in the backend's own rows (WorldReplica.report), which
 * the main thread's mirror writes back; `events` is what the step raised (ReplicaReport).
 */
export interface Snapshot extends ReplicaReport {
    kind: 'snapshot';
    epoch: number;
    seq: number;
    /** The simulated time this step covered (and, in `time`, the world clock after it). */
    dt: number;
    /** The last substep's contacts, in the world's order: rows of [slotA, slotB, nx, ny, nz] (CONTACT_ROW). */
    contacts: Float64Array;
    contactCount: number;
    /** What water buoyed: [volumeIndex, slot, fraction] per entry, the deepest fraction per pair. */
    submerged: Float64Array;
    stats: { stepMs: number; broadphaseMs: number; narrowphaseMs: number; solveMs: number; integrateMs: number };
    /** When the worker finished it, in the receiver's performance.now() clock: set for a reply read from shared memory. */
    doneAt?: number;
}

export interface WorkerError { kind: 'error'; epoch: number; message: string }

/**
 * The shared memory the worker's next replies are written to (sharedReply.ts), instead of being posted.
 * Sent once, and again whenever a snapshot outgrows it; the port keeps it and does not pass it on.
 */
export interface ReplyChannel { kind: 'channel'; buffer: SharedArrayBuffer }

export type FromWorker = Snapshot | WorkerError | ReplyChannel;

export const CONTACT_ROW = 5;
