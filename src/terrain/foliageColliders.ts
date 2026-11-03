import { vec3 } from 'gl-matrix';
import { FoliageCollision } from '../graphics/material';
import { Shape } from '../physics/shape';
import { PhysicsBody } from '../physics/physicsBody';
import { quatFromEuler } from '../physics/pal/math';
import type { PhysicsSystem } from '../physics/physicsSystem';
import { FoliageLayer } from './foliage';
import { foliageColliderPose } from './foliageColliderPose';

// Re-exported: the pose lives in a module of its own so the navmesh baker can carve trunks without
// pulling physics in with it.
export { foliageColliderPose };

/** Activation policy for a terrain's pooled foliage colliders. */
export interface FoliageColliderSettings {
    /** Off = no bodies at all, and any live ones are torn down on the next update. */
    enabled: boolean;
    /** Instances within this world-unit radius of the camera get a body. */
    radius: number;
    /** Hard ceiling on simultaneous bodies. The nearest instances win. */
    maxBodies: number;
}

export const DEFAULT_FOLIAGE_COLLIDERS: FoliageColliderSettings = {
    enabled: true, radius: 40, maxBodies: 256,
};

/** How far the camera must move before the active set is recomputed (fraction of the radius). */
const REFRESH_TRAVEL = 0.25;
/** Upper bound on how long a stale active set may persist even if nothing appears to have changed. */
const REFRESH_INTERVAL_MS = 250;

/** `see`: the layer's `cameraDither`, stamped on the body (a pooled body may serve any layer of its shape). */
interface Wanted { sig: string; x: number; y: number; z: number; yaw: number; scale: number; d2: number; see: boolean }

/** The pool bucket each body was built for. */
const signatures = new WeakMap<PhysicsBody, string>();
/** Scratch for a body's yaw rotation. */
const yawRotation = [0, 0, 0, 1];

/**
 * Static physics proxies for the collidable foliage instances near the camera, materialised only inside
 * an activation disc and recycled as it slides. Bodies are pooled by SHAPE SIGNATURE (post-scale
 * dimensions, rounded), not by instance, so a recycled body only ever changes position — nothing rebuilds
 * its shapes or recomputes mass properties: an evicted body stays built in the world, disabled.
 */
export class FoliageColliderField {
    private _physics: PhysicsSystem | null = null;
    /** Instance key -> the body currently representing it in the world. */
    private _active = new Map<string, PhysicsBody>();
    /** Shape signature -> bodies evicted from the world, ready to be re-placed. */
    private _free = new Map<string, PhysicsBody[]>();
    /** Layer KEY -> the layer.version the active set was computed against. Keyed by the stable
     *  identity, not the name: renaming a rule is not a reason to rebuild every collider. */
    private _versions = new Map<string, number>();
    private _lastCam: vec3 = [NaN, NaN, NaN];
    private _lastOrigin: vec3 = [NaN, NaN, NaN];
    private _lastRefresh = 0;

    /** Bodies currently in the world. Read by the editor/HUD; also the pool's occupancy. */
    public get activeCount(): number { return this._active.size; }

    public update(
        physics: PhysicsSystem,
        layers: FoliageLayer[],
        camPos: vec3 | null,
        origin: vec3,
        settings: FoliageColliderSettings,
    ): void {
        this._physics = physics;

        if (!settings.enabled || !camPos) {
            if (this._active.size > 0) this._deactivateAll(physics);
            return;
        }

        if (!this._due(camPos, origin, layers, settings)) return;
        this._lastRefresh = Date.now();
        vec3.copy(this._lastCam as vec3, camPos);
        vec3.copy(this._lastOrigin as vec3, origin);
        for (const layer of layers) this._versions.set(layer.key, layer.version);

        // 1. Collect every collidable instance inside the activation disc.
        const wanted = new Map<string, Wanted>();
        for (const layer of layers) {
            const col = layer.collision;
            if (!col || layer.count === 0) continue;
            layer.forEachInstanceNear(camPos[0], camPos[2], settings.radius, (index, ix, iy, iz, yaw, scale) => {
                const dx = ix - camPos[0], dy = iy - camPos[1], dz = iz - camPos[2];
                wanted.set(`${layer.key}#${index}`, {
                    sig: signatureOf(col, scale), x: ix, y: iy, z: iz, yaw, scale,
                    d2: dx * dx + dy * dy + dz * dz, see: layer.cameraDither,
                });
            });
        }

        // 2. Enforce the ceiling by keeping the nearest. Only pay for the sort when it actually overflows.
        let keep: Map<string, Wanted> = wanted;
        if (wanted.size > settings.maxBodies) {
            const entries = [...wanted.entries()].sort((a, b) => a[1].d2 - b[1].d2);
            keep = new Map(entries.slice(0, settings.maxBodies));
        }

        // 3. Evict what left the set, back into the pool keyed by the shape it already carries.
        for (const [key, body] of this._active) {
            if (keep.has(key)) continue;
            physics.removeBody(body, true);
            const sig = signatures.get(body)!;
            let bucket = this._free.get(sig);
            if (!bucket) { bucket = []; this._free.set(sig, bucket); }
            bucket.push(body);
            this._active.delete(key);
        }

        // 4. Materialise what entered it, reusing a pooled body of the same signature when one exists.
        for (const [key, w] of keep) {
            const active = this._active.get(key);
            // Read by the camera probe (cameraRayFilter): a 'dither' rig sees through this rule's trees.
            if (active) { active.cameraDither = w.see; continue; }
            const body = this._free.get(w.sig)?.pop() ?? buildBody(w.sig, layerCollisionFor(layers, key), w.scale);
            if (!body) continue;
            body.position.set(w.x, w.y, w.z);
            quatFromEuler(0, w.yaw, 0, yawRotation);
            body.quaternion.set(yawRotation[0], yawRotation[1], yawRotation[2], yawRotation[3]);
            body.cameraDither = w.see;
            physics.addBody(body);
            this._active.set(key, body);
        }
    }

    /** Remove every body this field owns from the world and forget the pool. Safe to call twice. */
    public dispose(physics?: PhysicsSystem): void {
        const p = physics || this._physics;
        if (p) {
            for (const body of this._active.values()) p.removeBody(body);
            for (const bucket of this._free.values()) for (const body of bucket) p.removeBody(body);
        }
        this._active.clear();
        this._free.clear();
        this._versions.clear();
        this._physics = null;
    }

    /** Whether anything happened that could change which instances should be active. */
    private _due(camPos: vec3, origin: vec3, layers: FoliageLayer[], settings: FoliageColliderSettings): boolean {
        if (!isFinite(this._lastCam[0])) return true;
        if (Date.now() - this._lastRefresh > REFRESH_INTERVAL_MS) return true;
        if (vec3.squaredDistance(camPos, this._lastCam as vec3) >= (settings.radius * REFRESH_TRAVEL) ** 2) return true;
        // Instances are stored in world space, so moving the terrain invalidates every cached position.
        if (vec3.squaredDistance(origin, this._lastOrigin as vec3) > 1e-8) return true;
        for (const layer of layers)
            if (this._versions.get(layer.key) !== layer.version) return true;
        return false;
    }

    private _deactivateAll(physics: PhysicsSystem): void {
        for (const [, body] of this._active) {
            physics.removeBody(body, true);
            const sig = signatures.get(body)!;
            let bucket = this._free.get(sig);
            if (!bucket) { bucket = []; this._free.set(sig, bucket); }
            bucket.push(body);
        }
        this._active.clear();
    }
}

/** The pool bucket a given collision descriptor + instance scale falls into. */
function signatureOf(col: FoliageCollision, scale: number): string {
    const r = (col.radius ?? 0.5) * scale;
    const h = (col.height ?? 2) * scale;
    const w = (col.width ?? col.radius ?? 0.5) * 2 * scale;
    const d = (col.depth ?? col.radius ?? 0.5) * 2 * scale;
    const o = (col.offsetY ?? (col.shape === 'sphere' ? (col.radius ?? 0.5) : (col.height ?? 2) / 2)) * scale;
    // Rounded so the continuous minScale..maxScale range collapses into a handful of reusable buckets.
    return `${col.shape}|${r.toFixed(2)}|${h.toFixed(2)}|${w.toFixed(2)}|${d.toFixed(2)}|${o.toFixed(2)}`;
}

/** The collision descriptor of the layer an instance key belongs to. */
function layerCollisionFor(layers: FoliageLayer[], key: string): FoliageCollision | null {
    // The prefix is the layer's stable key, which is what `wanted` composed these from. Matching on
    // the display name would lose every active body the moment a rule was renamed.
    const layerKey = key.slice(0, key.lastIndexOf('#'));
    for (const l of layers) if (l.key === layerKey) return l.collision;
    return null;
}

/** The static body for one instance's collider (exported for tests). It collides as the default surface. */
export function buildFoliageColliderBody(col: FoliageCollision, scale: number): PhysicsBody {
    const body = new PhysicsBody({ name: 'foliage', type: 'static' });
    const pose = foliageColliderPose(col, scale);
    const offset: [number, number, number] = [0, pose.offsetY, 0];
    if (pose.shape === 'sphere') body.addCollider({ shape: Shape.Sphere(pose.size[0] / 2).desc, offset });
    else if (pose.shape === 'box') body.addCollider({ shape: Shape.Box(pose.size[0], pose.size[1], pose.size[2]).desc, offset });
    // A cylinder is Y-up (like the node colliders in physics/shape.ts). The -90° X turn this used to add
    // laid every foliage trunk on its side.
    else body.addCollider({ shape: Shape.Cylinder(pose.size[0] / 2, pose.size[0] / 2, pose.size[1], 8).desc, offset });
    return body;
}

function buildBody(sig: string, col: FoliageCollision | null, scale: number): PhysicsBody | null {
    if (!col) return null;
    const body = buildFoliageColliderBody(col, scale);
    signatures.set(body, sig);
    return body;
}
