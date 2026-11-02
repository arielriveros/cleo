import type { Body } from 'cannon-es';

// Where the physics step runs. PhysicsSystem owns the scene-facing half — the bodies' nodes, triggers,
// grounding, queries — and hands the step itself to a backend:
//
//   InlineBackend   steps the cannon World on this thread, inside physics.update (the default)
//   WorkerBackend   keeps that World as a mirror that never steps, and steps a copy in a Web Worker
//
// Either way the World PhysicsSystem holds is the one every query, raycast and `node.body` reads.

/** One contact of the last substep, as ground stamping reads it: `ni` points out of `bi`, toward `bj`. */
export interface ContactLike {
    bi: Body;
    bj: Body;
    ni: { x: number; y: number; z: number };
}

export interface StepResult {
    /**
     * Seconds of simulation this frame's update applied. The inline backend always steps the frame's own
     * delta; the worker applies its last finished step, or nothing (0) while that step is still running.
     */
    dt: number;
    /** The last substep's contacts. Only valid until the next step. */
    contacts: ArrayLike<ContactLike>;
}

export interface PhysicsBackend {
    readonly kind: 'inline' | 'worker';
    /** Start of physics.update: step (inline) or apply the worker's finished step (worker). */
    step(dt: number): StepResult;
    /** End of the frame, after scripts: hand the worker this frame's changes and its step. */
    endFrame(dt: number): void;
    /** The world was cleared (a scene change): forget every body. */
    reset(): void;
    dispose(): void;
}
