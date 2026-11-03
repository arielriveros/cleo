import type { BodyHandle } from '../pal/types';

// Where the physics step runs. PhysicsSystem owns the scene-facing half — the bodies' nodes, triggers,
// grounding, queries — and hands the step itself to an executor:
//
//   InlineExecutor   steps the world on this thread, inside physics.update (the default)
//   WorkerExecutor   keeps that World as a mirror that never steps, and steps a copy in a Web Worker
//
// Either way the world PhysicsSystem holds (a PhysicsWorld, see pal/) is the one every query, raycast and
// `node.body` reads.

/** The last substep's contacts, as ground stamping reads them: (a, b, normal pointing out of a toward b). */
export interface ContactSource {
    readonly contactCount: number;
    forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void;
}

/** No contacts (a frame whose worker step has not come back). */
export const NO_CONTACTS: ContactSource = { contactCount: 0, forEachContact() {} };

export interface StepResult {
    /**
     * Seconds of simulation this frame's update applied. The inline executor always steps the frame's own
     * delta; the worker applies its last finished step, or nothing (0) while that step is still running.
     */
    dt: number;
    /** The last substep's contacts. Only valid until the next step. */
    contacts: ContactSource;
}

export interface PhysicsExecutor {
    readonly kind: 'inline' | 'worker';
    /**
     * Start of physics.update: step (inline) or apply the worker's finished step (worker). `timeScale` is the
     * engine's for this frame (dt is already scaled by it); the worker predicts its next step with it.
     */
    step(dt: number, timeScale?: number): StepResult;
    /**
     * End of the frame, after scripts: hand the worker this frame's changes and its step. `nextTimeScale`
     * is the scale the next frame will start at (a hit-stop set this frame has already lowered it).
     */
    endFrame(dt: number, nextTimeScale?: number): void;
    /** The world was cleared (a scene change): forget every body. */
    reset(): void;
    dispose(): void;
}
