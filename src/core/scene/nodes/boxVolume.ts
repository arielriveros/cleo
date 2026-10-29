import { mat4, vec3 } from "gl-matrix";
import type { ReadonlyMat4, ReadonlyVec3 } from "gl-matrix";

/**
 * Oriented-box influence volumes, shared by every node that applies "inside this box, fading out over
 * `blendDistance` at its faces" — light probes and exposure volumes.
 *
 * The box is centred on the node, sized `size` (full extents at scale 1) along the node's own axes and
 * carried by its world transform, so rotating or scaling the node turns or stretches the volume.
 * Pure helpers: no node state, no allocation beyond the module scratch.
 */

const _volScratch = mat4.create();
const _pointScratch = vec3.create();

/** world -> box unit cube (containment = |xyz| <= 0.5), written into `out`. */
export function boxInverseMatrix(out: mat4, world: ReadonlyMat4, size: ReadonlyVec3): mat4 {
    mat4.scale(_volScratch, world, [size[0], size[1], size[2]]);
    return mat4.invert(out, _volScratch) ?? mat4.identity(out);
}

/** Per-axis feather as a fraction of the unit cube (blendDistance / world size, capped at 0.5). */
export function boxBlendFractions(size: ReadonlyVec3, worldScale: ReadonlyVec3, blendDistance: number): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const worldSize = Math.abs(size[i] * worldScale[i]);
        out[i] = worldSize > 0 ? Math.min(0.5, blendDistance / worldSize) : 0;
    }
    return out;
}

/**
 * Feathered containment weight of a world point: 1 well inside, smoothstepping to 0 at the faces over
 * the feather, 0 outside.
 */
export function boxWeight(p: ReadonlyVec3, invVolume: ReadonlyMat4, blend: ReadonlyVec3): number {
    const local = vec3.transformMat4(_pointScratch, p, invVolume);
    let w = 1;
    for (let i = 0; i < 3; i++) {
        const edge = 0.5 - Math.abs(local[i]); // distance to the boundary in unit-cube space
        if (edge <= 0) return 0;
        if (blend[i] > 0) {
            const t = Math.min(1, edge / blend[i]);
            w = Math.min(w, t * t * (3 - 2 * t)); // smoothstep
        }
    }
    return w;
}

/** World AABB of the oriented box. */
export function boxWorldBounds(world: ReadonlyMat4, size: ReadonlyVec3): { min: vec3, max: vec3 } {
    const m = mat4.scale(_volScratch, world, [size[0], size[1], size[2]]);
    const min = vec3.fromValues(Infinity, Infinity, Infinity);
    const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
    const corner = _pointScratch;
    for (let i = 0; i < 8; i++) {
        vec3.set(corner, (i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5);
        vec3.transformMat4(corner, corner, m);
        vec3.min(min, min, corner);
        vec3.max(max, max, corner);
    }
    return { min, max };
}
