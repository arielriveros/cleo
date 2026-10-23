/**
 * Simulation range: dynamic bodies far from the camera are frozen in place rather than simulated.
 *
 * Pure and dependency-free so the rules can be tested without a world (physicsSystem.ts reaches the cleo
 * barrel and cannot be unit-tested — the same reason cameraRayFilter.ts is its own module).
 *
 * ## What "frozen" means
 *
 * cannon's manual sleep: the body stays in the world, so rays, the camera boom, triggers and other bodies
 * still hit it, but it is not integrated and is skipped against static geometry (terrain, foliage colliders,
 * level meshes) — which is where nearly all of a resting body's cost goes. Its velocity is kept and given
 * back when it wakes, so something in mid-flight resumes its arc instead of dropping dead.
 *
 * ## Why a hysteresis band
 *
 * A body parked exactly on the boundary would freeze and wake on sub-centimetre camera jitter, paying a
 * wake (and a velocity restore) every frame. It wakes at the range and freezes only past
 * `range * SIMULATION_RANGE_HYSTERESIS` — asymmetric in the cheap direction, like the foliage cull.
 */

/** How a body picks its range: the project's, never frozen, or its own. */
export type SimulationMode = 'project' | 'always' | 'custom';

export const SIMULATION_MODES: readonly SimulationMode[] = ['project', 'always', 'custom'];

/** A body freezes only this far past its range, and wakes back inside it. */
export const SIMULATION_RANGE_HYSTERESIS = 1.1;

/** Seconds a frozen body woken by something else (a hit, an impulse) is left awake before it may refreeze. */
export const SIMULATION_WAKE_GRACE = 1.0;

/** Parse a stored mode tolerantly; anything unknown is the project default. */
export function parseSimulationMode(value: unknown): SimulationMode {
    return value === 'always' || value === 'custom' ? value : 'project';
}

/**
 * The distance past which a body freezes, or Infinity for never. `0` (or anything non-positive) means
 * unlimited at both levels: a project with no range set, and a custom range left at 0, simulate everything.
 */
export function effectiveSimulationRange(mode: SimulationMode, bodyRange: number, projectRange: number): number {
    if (mode === 'always') return Infinity;
    const range = mode === 'custom' ? bodyRange : projectRange;
    return range > 0 && Number.isFinite(range) ? range : Infinity;
}

/**
 * Whether a body should be frozen this frame, given whether it is now, its squared distance to the camera
 * and its range. Wakes at `range`, freezes past `range * hysteresis`, holds its state in between.
 */
export function shouldFreeze(frozen: boolean, distanceSq: number, range: number,
                             hysteresis: number = SIMULATION_RANGE_HYSTERESIS): boolean {
    if (!Number.isFinite(range)) return false;
    if (frozen) return distanceSq > range * range;
    const far = range * hysteresis;
    return distanceSq > far * far;
}
