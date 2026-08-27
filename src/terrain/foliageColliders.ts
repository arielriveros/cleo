import { Body, World, Vec3, Quaternion, Material as PhysicsMaterial } from 'cannon-es';
import { vec3 } from 'gl-matrix';
import { FoliageCollision } from '../graphics/material';
import { Shape } from '../physics/shape';
import { FoliageLayer } from './foliage';

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

interface Wanted { sig: string; x: number; y: number; z: number; yaw: number; scale: number; d2: number }

/**
 * Static physics proxies for the collidable foliage instances near the camera, materialised only inside
 * an activation disc and recycled as it slides. Bodies are pooled by SHAPE SIGNATURE (post-scale
 * dimensions, rounded), not by instance, so a recycled body only ever changes position — nothing mutates
 * `body.shapes` or recomputes mass properties.
 */
export class FoliageColliderField {
    private _world: World | null = null;
    /** Instance key -> the body currently representing it in the world. */
    private _active = new Map<string, Body>();
    /** Shape signature -> bodies evicted from the world, ready to be re-placed. */
    private _free = new Map<string, Body[]>();
    /** Layer name -> the layer.version the active set was computed against. */
    private _versions = new Map<string, number>();
    private _lastCam: vec3 = [NaN, NaN, NaN];
    private _lastOrigin: vec3 = [NaN, NaN, NaN];
    private _lastRefresh = 0;

    /** Bodies currently in the world. Read by the editor/HUD; also the pool's occupancy. */
    public get activeCount(): number { return this._active.size; }

    public update(
        world: World,
        layers: FoliageLayer[],
        camPos: vec3 | null,
        origin: vec3,
        material: PhysicsMaterial | null,
        settings: FoliageColliderSettings,
    ): void {
        this._world = world;

        if (!settings.enabled || !camPos) {
            if (this._active.size > 0) this._deactivateAll(world);
            return;
        }

        if (!this._due(camPos, origin, layers, settings)) return;
        this._lastRefresh = Date.now();
        vec3.copy(this._lastCam as vec3, camPos);
        vec3.copy(this._lastOrigin as vec3, origin);
        for (const layer of layers) this._versions.set(layer.name, layer.version);

        // 1. Collect every collidable instance inside the activation disc.
        const wanted = new Map<string, Wanted>();
        for (const layer of layers) {
            const col = layer.collision;
            if (!col || layer.count === 0) continue;
            layer.forEachInstanceNear(camPos[0], camPos[2], settings.radius, (index, ix, iy, iz, yaw, scale) => {
                const dx = ix - camPos[0], dy = iy - camPos[1], dz = iz - camPos[2];
                wanted.set(`${layer.name}#${index}`, {
                    sig: signatureOf(col, scale), x: ix, y: iy, z: iz, yaw, scale,
                    d2: dx * dx + dy * dy + dz * dz,
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
            world.removeBody(body);
            const sig = (body as any).__foliageSig as string;
            let bucket = this._free.get(sig);
            if (!bucket) { bucket = []; this._free.set(sig, bucket); }
            bucket.push(body);
            this._active.delete(key);
        }

        // 4. Materialise what entered it, reusing a pooled body of the same signature when one exists.
        for (const [key, w] of keep) {
            if (this._active.has(key)) continue;
            const body = this._free.get(w.sig)?.pop() ?? buildBody(w.sig, layerCollisionFor(layers, key), w.scale, material);
            if (!body) continue;
            body.position.set(w.x, w.y, w.z);
            body.quaternion.setFromEuler(0, w.yaw, 0);
            world.addBody(body);
            this._active.set(key, body);
        }
    }

    /** Remove every body this field owns from the world and forget the pool. Safe to call twice. */
    public dispose(world?: World): void {
        const w = world || this._world;
        if (w) {
            for (const body of this._active.values()) w.removeBody(body);
            for (const bucket of this._free.values()) for (const body of bucket) w.removeBody(body);
        }
        this._active.clear();
        this._free.clear();
        this._versions.clear();
        this._world = null;
    }

    /** Whether anything happened that could change which instances should be active. */
    private _due(camPos: vec3, origin: vec3, layers: FoliageLayer[], settings: FoliageColliderSettings): boolean {
        if (!isFinite(this._lastCam[0])) return true;
        if (Date.now() - this._lastRefresh > REFRESH_INTERVAL_MS) return true;
        if (vec3.squaredDistance(camPos, this._lastCam as vec3) >= (settings.radius * REFRESH_TRAVEL) ** 2) return true;
        // Instances are stored in world space, so moving the terrain invalidates every cached position.
        if (vec3.squaredDistance(origin, this._lastOrigin as vec3) > 1e-8) return true;
        for (const layer of layers)
            if (this._versions.get(layer.name) !== layer.version) return true;
        return false;
    }

    private _deactivateAll(world: World): void {
        for (const [, body] of this._active) {
            world.removeBody(body);
            const sig = (body as any).__foliageSig as string;
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
    const name = key.slice(0, key.lastIndexOf('#'));
    for (const l of layers) if (l.name === name) return l.collision;
    return null;
}

function buildBody(sig: string, col: FoliageCollision | null, scale: number, material: PhysicsMaterial | null): Body | null {
    if (!col) return null;
    const body = new Body({ mass: 0, material: material ?? undefined, type: Body.STATIC });
    const r = (col.radius ?? 0.5) * scale;
    const h = (col.height ?? 2) * scale;
    const offsetY = (col.offsetY ?? (col.shape === 'sphere' ? (col.radius ?? 0.5) : (col.height ?? 2) / 2)) * scale;

    if (col.shape === 'sphere') {
        body.addShape(Shape.Sphere(r).cShape, new Vec3(0, offsetY, 0));
    } else if (col.shape === 'box') {
        const w = (col.width ?? col.radius ?? 0.5) * 2 * scale;
        const d = (col.depth ?? col.radius ?? 0.5) * 2 * scale;
        body.addShape(Shape.Box(w, h, d).cShape, new Vec3(0, offsetY, 0));
    } else {
        // cannon's Cylinder is Z-aligned; stand it up along Y like every other trunk-shaped collider.
        const upright = new Quaternion();
        upright.setFromEuler(-Math.PI / 2, 0, 0);
        body.addShape(Shape.Cylinder(r, r, h, 8).cShape, new Vec3(0, offsetY, 0), upright);
    }
    (body as any).__foliageSig = sig;
    return body;
}
