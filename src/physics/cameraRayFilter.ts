import type { Node } from "../core/scene/node";

/**
 * The subset of a cannon `Body` the camera probe's filter looks at. Structural rather than the real
 * class so this module stays a leaf (`physicsSystem.ts` imports the cleo barrel and cannot be loaded
 * by the unit suite) — the rule below is the part worth testing, so it lives where it is testable.
 */
export interface CameraProbeBody {
    isTrigger?: boolean;
    /** The per-body "camera collision" channel. Absent means solid — see the null note below. */
    cameraCollision?: boolean;
    owner?: Node | null;
}

/**
 * Whether the camera's collision probe should ignore a hit on `body`.
 *
 * The trigger rule is the load-bearing one. cannon consults `isTrigger` only in its solver, and
 * `Ray.intersectBody` filters on `collisionResponse` and collision groups alone, so nothing on the
 * cannon side keeps a ray out of a trigger volume — `raycastClosest` will happily return a checkpoint
 * as the nearest "obstruction" and slam the camera into the character's back. It has to be rejected
 * here, per hit.
 *
 * `cameraCollision` is checked as `=== false` on purpose: bodies the engine did not create (notably
 * the terrain heightfield, a plain cannon `Body`) have no such field, and those must count as solid.
 *
 * @param reject Caller's ignore rule, receiving the owning Node — null for ownerless bodies like the
 *               terrain heightfield, which should normally be kept.
 */
export function skipCameraHit(
    body: CameraProbeBody | null | undefined,
    reject?: (owner: Node | null) => boolean
): boolean {
    if (!body) return true;
    if (body.isTrigger) return true;
    if (body.cameraCollision === false) return true;
    if (reject && reject(body.owner ?? null)) return true;
    return false;
}
