// Loading camera settings saved before camera rigs chose collision layers (player contract 45). The camera used
// to have channels of its own:
//
//  - a Collider's `cameraCollision: false` let every camera rig's boom pass through it;
//  - a node's `cameraDither: true` ("See-through to camera", fanned out to its children) and a foliage rule's
//    let a rig in 'dither' mode see through it: the boom passed its body and the renderer cut its meshes;
//  - a rig's `collisionMode` was 'retract' (pull in for everything solid) or 'dither' (see through what opted in,
//    pull in for the rest).
//
// Now a rig names the layers it is Blocked by and the ones it Sees through, and what it sees through is what a
// Collider ON one of those layers holds. So a Collider that asked to be seen through moves to the See Through
// layer, one out of the camera's way to No Camera, and a rig's mode becomes the two masks that do what it did.
// Only a Collider on the Default layer moves: one already on a layer of its own keeps it, the flag dropped.
// A mesh that asked for the hole with no Collider round it has no layer to go by; its flag is dropped.
//
// Pure JSON, like physicsLegacy.ts: the engine's parsers call the per-node pieces, the example tools the
// whole-tree one.

import { ALL_LAYERS, DEFAULT_CAMERA_BLOCKED_BY, LAYER } from "../../../physics/collisionLayers";

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A node JSON that is (or, in the old form, will become) a body of its own: where a Collider's reach stops. */
const isBodyJson = (json: any): boolean => json?.type === 'collider' || isObject(json?.body);

/**
 * Whether a Collider's JSON asked for the camera's see-through hole: its own `cameraDither`, or that of anything
 * under it, down to (not into) a nested Collider.
 */
export function colliderAskedSeeThrough(json: any): boolean {
    if (json?.cameraDither === true) return true;
    const walk = (children: unknown): boolean => Array.isArray(children) && children.some(c =>
        isObject(c) && !isBodyJson(c) && (c.cameraDither === true || walk(c.children)));
    return walk(json?.children);
}

/**
 * The layer a Collider saved with `json` is on, the old camera channels read into it (see the module comment):
 * See Through when it or a mesh in it asked for the hole, else No Camera when the camera passed through it.
 * `settings` is its `collider` block.
 */
export function legacyColliderLayer(json: any, settings: any = json?.collider): number {
    const layer = typeof settings?.layer === 'number' && Number.isFinite(settings.layer) ? Math.trunc(settings.layer) : LAYER.DEFAULT;
    if (layer !== LAYER.DEFAULT) return layer;
    if (colliderAskedSeeThrough(json)) return LAYER.SEE_THROUGH;
    if (settings?.cameraCollision === false) return LAYER.NO_CAMERA;
    return layer;
}

/** Whether a node JSON outside any Collider still asks for the hole it can no longer have. */
export const asksLooseSeeThrough = (json: any): boolean => json?.cameraDither === true && !isBodyJson(json);

/** A camera rig's layers from its JSON: its own, or what its old `collisionMode` did. */
export function legacyRigLayers(json: any): { blockedBy: number; seeThrough: number } {
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (num(json?.collisionLayers) && num(json?.seeThroughLayers))
        return { blockedBy: Math.trunc(json.collisionLayers), seeThrough: Math.trunc(json.seeThroughLayers) };
    // 'dither': pulled in for everything but what opted in, which is on See Through now. 'retract': pulled in for
    // every solid body, the opted-in ones (now on See Through) included; what the camera passed is on No Camera.
    return json?.collisionMode === 'dither'
        ? { blockedBy: DEFAULT_CAMERA_BLOCKED_BY, seeThrough: LAYER.SEE_THROUGH }
        : { blockedBy: ALL_LAYERS & ~LAYER.NO_CAMERA, seeThrough: 0 };
}

/**
 * A foliage rule's collision layer from its JSON: its own, or See Through when the old rule asked for the hole and
 * has collision to put on the layer. Undefined: the Default layer.
 */
export function legacyFoliageCollisionLayer(rule: any): number | undefined {
    const c = rule?.collision;
    if (isObject(c) && typeof c.layer === 'number' && Number.isFinite(c.layer)) return Math.trunc(c.layer);
    return rule?.cameraDither === true && isObject(c) ? LAYER.SEE_THROUGH : undefined;
}

/** What {@link migrateCameraLayersTree} changed. */
export interface CameraLayersMigration {
    /** Colliders moved off the Default layer. */
    colliders: number;
    /** Rigs whose mode became layers. */
    rigs: number;
    /** Meshes that asked for the hole outside any Collider: flag dropped. */
    loose: number;
}

/**
 * A whole saved subtree in the new form (a copy; `json` is untouched): every Collider on its layer, every rig on
 * its masks, no `cameraCollision` / `cameraDither` / `collisionMode` left. Expects colliders already in the node
 * form (physicsLegacy.ts's migrateLegacyPhysicsTree first). `counts` accumulates what changed.
 */
export function migrateCameraLayersTree(json: any, counts: CameraLayersMigration = { colliders: 0, rigs: 0, loose: 0 }, inCollider = false): any {
    if (!isObject(json)) return json;
    const out: Record<string, any> = { ...json };
    const isCollider = out.type === 'collider';
    if (isCollider && isObject(out.collider)) {
        const layer = legacyColliderLayer(json);
        const { cameraCollision: _c, ...settings } = out.collider;
        if (layer !== (settings.layer ?? LAYER.DEFAULT)) counts.colliders++;
        out.collider = { ...settings, layer };
    }
    if (out.type === 'cameraRig' && (out.collisionMode !== undefined || out.collisionLayers === undefined || out.seeThroughLayers === undefined)) {
        const { blockedBy, seeThrough } = legacyRigLayers(out);
        delete out.collisionMode;
        out.collisionLayers = blockedBy;
        out.seeThroughLayers = seeThrough;
        counts.rigs++;
    }
    if ('cameraDither' in out) {
        if (out.cameraDither === true && !isCollider && !inCollider) counts.loose++;
        delete out.cameraDither;
    }
    if (Array.isArray(out.children))
        out.children = out.children.map((c: any) => migrateCameraLayersTree(c, counts, inCollider || isCollider));
    return out;
}
