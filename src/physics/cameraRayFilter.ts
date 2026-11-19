import type { Node } from "../core/scene/nodes/node";

/**
 * The subset of a body the camera probe's filter looks at. Structural rather than the real class so this module
 * stays a leaf the unit suite can load.
 */
export interface CameraProbeBody {
    isTrigger?: boolean;
    /** The collision layer it is on (its Collider's Layer). Absent means the Default layer. */
    collisionFilterGroup?: number;
    owner?: Node | null;
}

/** Which layers a camera rig's probe reacts to (a CameraRig's Blocked by and See through). */
export interface CameraProbeLayers {
    /** Layers that pull the camera in along the arm. */
    blockedBy: number;
    /** Layers the camera looks through: the boom passes them, and the renderer cuts their meshes instead. */
    seeThrough: number;
}

/**
 * Whether the camera's collision probe should ignore a hit on `body`, in this order: a trigger (a ray goes
 * straight into a trigger volume, so it is rejected per hit); a body on a See through layer (the renderer
 * cuts it instead, so it blocks nothing, even when its layer is also in Blocked by); a body on no Blocked by
 * layer; and last the caller's own rule.
 * @param reject Caller's ignore rule, receiving the owning Node: null for ownerless bodies like the terrain
 *               heightfield, which should normally be kept. Those are on the Default layer.
 */
export function skipCameraHit(
    body: CameraProbeBody | null | undefined,
    layers: CameraProbeLayers,
    reject?: (owner: Node | null) => boolean,
): boolean {
    if (!body) return true;
    if (body.isTrigger) return true;
    const group = body.collisionFilterGroup ?? 1;
    if ((group & layers.seeThrough) !== 0) return true;
    if ((group & layers.blockedBy) === 0) return true;
    if (reject && reject(body.owner ?? null)) return true;
    return false;
}

/** The subset of a body the GENERAL ray filter looks at. Structural, to keep this module a leaf. */
export interface RayHitBody {
    isTrigger?: boolean;
    /** The solver's channel. `false` means the solver ignores it: a ghost. */
    collisionResponse?: boolean;
    /** Its collision layer and the layers it collides with. Absent: the Default layer, colliding with all. */
    collisionFilterGroup?: number;
    collisionFilterMask?: number;
    owner?: Node | null;
}

/** What {@link skipRayHit} is allowed to let through. Mirrors PhysicsSystem.raycast's options. */
export interface RayFilter<TBody = RayHitBody> {
    ignore?: TBody | TBody[] | null;
    includeTriggers?: boolean;
    includeGhosts?: boolean;
    /** Only bodies on one of these layers (`collisionFilterGroup & layerMask`). */
    layerMask?: number;
    /** Only what this body collides with: each one's mask holds the other's layer. */
    collidingWith?: { collisionFilterGroup?: number; collisionFilterMask?: number } | null;
    reject?: (owner: Node | null, body: TBody) => boolean;
}

/**
 * Whether a general raycast should ignore a hit on `body`. By default a trigger volume and a body the solver
 * ignores are both skipped; the camera probe overrides both.
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
    const group = body.collisionFilterGroup ?? 1;
    if (f.layerMask !== undefined && (group & f.layerMask) === 0) return true;
    const w = f.collidingWith;
    if (w && ((group & (w.collisionFilterMask ?? -1)) === 0 || ((w.collisionFilterGroup ?? 1) & (body.collisionFilterMask ?? -1)) === 0)) return true;
    if (f.reject && f.reject(body.owner ?? null, body)) return true;
    return false;
}
