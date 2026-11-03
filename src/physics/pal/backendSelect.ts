import type { PhysicsBackendKind } from './types';

// Which physics engines this build can run. A backend choice is a REQUEST — a project's setting, a URL
// parameter — resolved against what this build implements (the RHI's rhi/backendSelect.ts is the model).
// The choice is the project's, not the machine's: backends do not simulate alike, so a game plays the same
// wherever it runs.

/** A backend a project may ask for: those this build runs, and those planned (so a picker can show them). */
export type PhysicsBackendRequest = PhysicsBackendKind | 'jolt';

/** Every backend a project may ask for, in the order a picker lists them. */
export const PHYSICS_BACKENDS: readonly { readonly request: PhysicsBackendRequest; readonly label: string; readonly implemented: boolean }[] = [
    { request: 'cannon', label: 'cannon-es', implemented: true },
    { request: 'rapier', label: 'Rapier', implemented: false },
    { request: 'jolt', label: 'Jolt', implemented: false },
];

/** The backend a request gets when it names none, or one this build cannot run. */
export const DEFAULT_PHYSICS_BACKEND: PhysicsBackendKind = 'cannon';

/**
 * Resolve a backend request: the backend to run, and why it is not the one asked for (null when it is,
 * or when nothing was asked). Read once, when the world is built: a changed setting takes effect with the
 * next engine.
 */
export function resolvePhysicsBackendRequest(requested: string | null | undefined): { kind: PhysicsBackendKind; reason: string | null } {
    if (!requested) return { kind: DEFAULT_PHYSICS_BACKEND, reason: null };
    const known = PHYSICS_BACKENDS.find(b => b.request === requested);
    if (!known) return { kind: DEFAULT_PHYSICS_BACKEND, reason: `there is no physics backend called "${requested}"` };
    if (!known.implemented) return { kind: DEFAULT_PHYSICS_BACKEND, reason: `the ${known.label} backend is not implemented yet` };
    return { kind: known.request as PhysicsBackendKind, reason: null };
}
