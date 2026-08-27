import type { Node } from "../core/scene/nodes/node";

/**
 * The subset of a cannon `Body` the camera probe's filter looks at. Structural rather than the real class
 * so this module stays a leaf the unit suite can load.
 */
export interface CameraProbeBody {
    isTrigger?: boolean;
    /** The per-body "camera collision" channel. Absent means solid. */
    cameraCollision?: boolean;
    owner?: Node | null;
}

/**
 * Whether the camera's collision probe should ignore a hit on `body`. Triggers must be rejected here, per
 * hit: cannon consults `isTrigger` only in its solver, so a ray goes straight into a trigger volume.
 * `cameraCollision` is tested as `=== false` so bodies without the field (e.g. terrain) count as solid.
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

/** The subset of a cannon `Body` the GENERAL ray filter looks at. Structural, to keep this module a leaf. */
export interface RayHitBody {
    isTrigger?: boolean;
    /** cannon's own solidity channel. `false` means the solver ignores it — a ghost. */
    collisionResponse?: boolean;
    owner?: Node | null;
}

/** What {@link skipRayHit} is allowed to let through. Mirrors PhysicsSystem.raycast's options. */
export interface RayFilter<TBody = RayHitBody> {
    ignore?: TBody | TBody[] | null;
    includeTriggers?: boolean;
    includeGhosts?: boolean;
    reject?: (owner: Node | null, body: TBody) => boolean;
}

/**
 * Whether a general raycast should ignore a hit on `body`. By default a trigger volume and a body the
 * solver ignores are both skipped; the camera probe overrides both.
 */
export function skipRayHit<TBody extends RayHitBody>(
    body: TBody | null | undefined,
    filter?: RayFilter<TBody>
): boolean {
    if (!body) return true;
    const f = filter ?? {};
    const ignore = f.ignore;
    if (ignore && (Array.isArray(ignore) ? ignore.includes(body) : ignore === body)) return true;
    if (!f.includeTriggers && body.isTrigger) return true;
    if (!f.includeGhosts && body.collisionResponse === false) return true;
    if (f.reject && f.reject(body.owner ?? null, body)) return true;
    return false;
}
