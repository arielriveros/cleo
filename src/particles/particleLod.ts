// Particle LOD: which detail level a particle system runs at, from its distance to the camera.
//
// Pure, so the renderer's per-frame pass and the tests share one rule. The rule is LodGroupNode's:
// distance is measured to the SURFACE of the system's bounds (a big fog bank 30 m away is not "far"
// while you stand at its edge), coarsening is immediate, and refining waits until the camera is 10%
// inside the threshold — so a camera hovering at a boundary does not flip levels every frame. The cull
// has the same 10% band.

import type { ParticleLod } from './particleSystemAsset';

export interface ParticleLodState {
    /** 0 = full detail; n = `lod.levels[n - 1]`. */
    level: number;
    /** Past the cull distance: not drawn, and a looping system stops simulating. */
    culled: boolean;
}

export const FULL_DETAIL: ParticleLodState = { level: 0, culled: false };

/** Refinement / un-cull hysteresis: the camera must come this fraction of a threshold back inside it. */
export const PARTICLE_LOD_HYSTERESIS = 0.9;

/** Distance from `camera` to the surface of a bounding sphere (0 inside it). */
export function particleLodDistance(center: ArrayLike<number>, radius: number, camera: ArrayLike<number>): number {
    const d = Math.hypot(camera[0] - center[0], camera[1] - center[1], camera[2] - center[2]);
    return Math.max(0, d - Math.max(0, radius));
}

/**
 * The level and cull state at `distance`, given the state the system was in. Every threshold is
 * multiplied by `distanceScale` (the renderer's global particle LOD distance: 2 keeps full detail twice
 * as far). LOD switched off, or no levels and no cull, is always full detail.
 */
export function selectParticleLod(lod: ParticleLod | undefined, distance: number, prev: ParticleLodState,
    distanceScale = 1): ParticleLodState {
    if (!lod || !lod.enabled) return FULL_DETAIL;
    const scale = Math.max(0, distanceScale);
    const h = PARTICLE_LOD_HYSTERESIS;

    let culled = false;
    if (lod.cullDistance > 0) {
        const cull = lod.cullDistance * scale;
        culled = prev.culled ? distance > cull * h : distance > cull;
    }

    // The coarsest level whose threshold the camera has passed...
    let level = 0;
    for (let i = 0; i < lod.levels.length; i++) if (distance > lod.levels[i].distance * scale) level = i + 1;
    // ...but a level finer than the previous one only once the camera is well inside its boundary.
    if (level < prev.level) {
        let held = prev.level;
        while (held > level && distance < lod.levels[held - 1].distance * scale * h) held--;
        level = held;
    }
    level = Math.min(level, lod.levels.length);
    return level === prev.level && culled === prev.culled ? prev : { level, culled };
}

/** What a level does: continuous spawning × `spawnScale`, simulating `stepScale` times less often. */
export function particleLodFactors(lod: ParticleLod | undefined, level: number): { spawnScale: number; stepScale: number } {
    const l = level > 0 ? lod?.levels[level - 1] : undefined;
    return l ? { spawnScale: l.spawnScale, stepScale: l.stepScale } : { spawnScale: 1, stepScale: 1 };
}
