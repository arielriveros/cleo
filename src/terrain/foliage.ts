import { mat4, quat } from 'gl-matrix';
import { Geometry } from '../core/geometry';
import { Model } from '../graphics/model';
import {
    Material, TerrainFoliageRule, FoliageCollision,
    FOLIAGE_DENSITY_UNIT, DEFAULT_FOLIAGE_DENSITY,
} from '../graphics/material';

export type FoliageKind = 'mesh' | 'billboard';

export interface FoliageParams {
    /** Blades/props per SQUARE METRE — the brush multiplies it by the disc area, whole-terrain
     *  generation by the terrain area, so the same number means the same look at any scale. */
    density: number;
    minScale: number;
    maxScale: number;
}

const DEFAULT_PARAMS: FoliageParams = { density: DEFAULT_FOLIAGE_DENSITY.billboard, minScale: 0.8, maxScale: 1.4 };
export const MAX_INSTANCES = 200000;

/**
 * GPU buffers left behind by layers that were disposed with their terrain. The renderer's foliage pass
 * only walks LIVE landscapes, so a detached terrain's own `collectStaleBuffers()` would never be called
 * again — this module-level queue is how those buffers still reach a `gl.deleteBuffer`.
 */
const ORPHANED_FOLIAGE_BUFFERS: WebGLBuffer[] = [];

/** Drain the buffers of disposed foliage layers. Called by the renderer, which owns the GL context. */
export function collectOrphanedFoliageBuffers(): WebGLBuffer[] {
    if (ORPHANED_FOLIAGE_BUFFERS.length === 0) return [];
    return ORPHANED_FOLIAGE_BUFFERS.splice(0, ORPHANED_FOLIAGE_BUFFERS.length);
}

/**
 * A spatial-grid cell of a foliage layer: the packed instance matrices whose XZ position falls in this
 * cell, plus a cached world-space AABB used for frustum/distance culling. Each cell owns its own static
 * GPU buffer (lazily created by the renderer's foliage pass) so off-screen/far cells can be skipped
 * without any per-frame re-upload.
 */
export interface FoliageCell {
    matrices: Float32Array;              // packed mat4s for this cell (16 floats/instance)
    count: number;
    indices: Int32Array;                 // instance indices in this cell (see forEachInstanceNear)
    min: [number, number, number];       // world AABB (instance extents, expanded by geometry size)
    max: [number, number, number];
    glBuffer: WebGLBuffer | null;         // renderer-owned; lazily created
    uploadedVersion: number;              // renderer's record of which layer.version is on the GPU
    lod: number;                          // current detail level (renderer-owned hysteresis memory)
}

/** One detail level of a mesh foliage layer: the sub-mesh models drawn per instance (transforms baked
 *  into the geometry editor-side) and the camera distance at which the level takes over. */
export interface FoliageLodLevel {
    models: Model[];
    distance: number;                     // levels[0].distance is always 0
}

/** Build a two-quad crossed billboard (an "X"), base at y=0 up to y=1, UV 0..1, up-facing normals. */
export function crossQuadGeometry(): Geometry {
    const positions: [number, number, number][] = [
        [-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0],
        [0, 0, -0.5], [0, 0, 0.5], [0, 1, 0.5], [0, 1, -0.5],
    ];
    const normals: [number, number, number][] = positions.map(() => [0, 1, 0]);
    const uvs: [number, number][] = [
        [0, 0], [1, 0], [1, 1], [0, 1],
        [0, 0], [1, 0], [1, 1], [0, 1],
    ];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    return new Geometry(positions, normals, uvs, [], [], indices);
}

/**
 * One GPU-instanced foliage layer for a terrain: either a scattered mesh prop (trees/rocks) or a textured
 * cross-quad billboard (grass). Stores compact per-instance data (position + yaw + uniform scale), bucketed
 * into a spatial grid of {@link FoliageCell}s; the renderer's foliage pass draws each visible cell (culling
 * off-screen/far ones) in its own instanced call.
 */
export class FoliageLayer {
    public readonly kind: FoliageKind;
    public name: string;
    /** The primary model — always levels[0].models[0] (kept as a field: legacy single-model paths use it). */
    public model: Model;
    public textureId: string | null;
    public params: FoliageParams;

    // Detail levels (mesh layers; billboard layers always have exactly one). Per-cell selection happens
    // in the renderer's foliage pass, by the same distance bands a mesh asset's LodGroup uses.
    public levels: FoliageLodLevel[];
    // Optional impostor: past this distance instances draw as textured cross-quads (the farthest LOD).
    public billboardModel: Model | null = null;
    public billboardTextureId: string | null = null;
    public billboardDistance = Infinity;
    /** Hide instances beyond this camera distance; 0 = use the renderer's global foliage cull distance. */
    public cullDistance = 0;
    /** Static physics proxy for nearby instances, or null for non-collidable foliage (grass). Mirrored
     *  from the rule onto the LAYER so a published build — which rebuilds layers straight from the
     *  serialized foliage blob, without re-parsing every terrain material — still gets colliders. */
    public collision: FoliageCollision | null = null;

    // Compact instance data, stride 5: [x, y, z, yaw, scale].
    private _instances: number[] = [];
    public count = 0;
    public version = 0;

    // Spatial grid over the instances (world XZ), rebuilt on scatter/erase. Cell world-unit size:
    // larger = fewer draw calls but looser culling.
    public cells: FoliageCell[] = [];
    public cellSize = 32;

    // Whether the (static) per-vertex mesh + VAO have been uploaded (set by the renderer's foliage pass).
    public initialized = false;

    // GPU buffers orphaned by a rebuild (cells are recreated), drained + deleted by the renderer.
    private _stale: WebGLBuffer[] = [];

    // Set by pushInstance(); commit() rebuilds once for a whole batch.
    private _dirty = false;

    private _q = quat.create();
    private _m = mat4.create();

    constructor(kind: FoliageKind, name: string, model: Model, textureId: string | null, params?: Partial<FoliageParams>) {
        this.kind = kind;
        this.name = name;
        this.model = model;
        this.textureId = textureId;
        this.params = { ...DEFAULT_PARAMS, ...params };
        this.levels = [{ models: [model], distance: 0 }];
    }

    public static Billboard(name: string, textureId: string, params?: Partial<FoliageParams>): FoliageLayer {
        const material = Material.Basic({ color: [1, 1, 1], texture: textureId }, { side: 'double', castShadow: false });
        return new FoliageLayer('billboard', name, new Model(crossQuadGeometry(), material), textureId, params);
    }

    public static Mesh(name: string, model: Model, params?: Partial<FoliageParams>): FoliageLayer {
        return new FoliageLayer('mesh', name, model, null, params);
    }

    /** Build a runtime layer from a terrain-material foliage rule (billboard texture or mesh model,
     *  optionally with LOD levels, a billboard impostor and a cull distance). */
    public static fromRule(rule: TerrainFoliageRule): FoliageLayer {
        const params: Partial<FoliageParams> = {};
        if (rule.density !== undefined) params.density = rule.density;
        if (rule.minScale !== undefined) params.minScale = rule.minScale;
        if (rule.maxScale !== undefined) params.maxScale = rule.maxScale;
        if (rule.kind === 'billboard') {
            const bb = FoliageLayer.Billboard(rule.name, rule.textureId || 'Null', params);
            bb.collision = rule.collision ?? null;
            return bb;
        }
        const base = (rule.models?.length ? rule.models[0] : rule.model);
        const layer = FoliageLayer.Mesh(rule.name, Model.parse(base), params);
        layer._applyMeshPrototype(rule);
        return layer;
    }

    /** (Re-)derive the mesh prototypes (LOD level models, billboard impostor, cull distance) from a rule
     *  or serialized-layer payload. `src.models`/`src.lods` hold flattened Model.serialize() JSON;
     *  legacy single-`model` payloads still load (one level, no impostor). */
    private _applyMeshPrototype(src: any): void {
        if (this.kind !== 'mesh') return;
        const baseModels: any[] | null = src.models?.length ? src.models : (src.model ? [src.model] : null);
        // Levels are only rebuilt when the payload carries a base — appending `lods` to levels that were
        // kept from before would duplicate them on every refresh.
        if (baseModels) {
            this.levels = [{ models: baseModels.map((m: any) => Model.parse(m)), distance: 0 }];
            if (Array.isArray(src.lods)) {
                for (const l of src.lods)
                    if (l?.models?.length)
                        this.levels.push({ models: l.models.map((m: any) => Model.parse(m)), distance: Math.max(0, Number(l.distance) || 0) });
            }
        }
        this.model = this.levels[0].models[0];
        if (src.billboard?.textureId) {
            const material = Material.Basic({ color: [1, 1, 1], texture: src.billboard.textureId }, { side: 'double', castShadow: false });
            this.billboardModel = new Model(crossQuadGeometry(), material);
            this.billboardTextureId = src.billboard.textureId;
            this.billboardDistance = Math.max(0, Number(src.billboard.distance) || 0);
        } else {
            this.billboardModel = null;
            this.billboardTextureId = null;
            this.billboardDistance = Infinity;
        }
        this.cullDistance = Math.max(0, Number(src.cullDistance) || 0);
        this.collision = src.collision ?? null;
        this.initialized = false; // new Model objects — the foliage pass re-uploads their meshes
    }

    /** Swap this layer's prototypes for an updated rule WITHOUT touching the scattered instances (used
     *  when the source mesh asset or terrain material was edited). Cells are re-bucketed only to refresh
     *  their AABB extents against the new geometry. */
    public setPrototype(rule: TerrainFoliageRule): void {
        if (rule.density !== undefined) this.params.density = rule.density;
        if (rule.minScale !== undefined) this.params.minScale = rule.minScale;
        if (rule.maxScale !== undefined) this.params.maxScale = rule.maxScale;
        if (this.kind === 'billboard') {
            this.collision = rule.collision ?? null;
            const tex = rule.textureId || 'Null';
            if (tex !== this.textureId) {
                this.textureId = tex;
                const material = Material.Basic({ color: [1, 1, 1], texture: tex }, { side: 'double', castShadow: false });
                this.model = new Model(crossQuadGeometry(), material);
                this.levels = [{ models: [this.model], distance: 0 }];
                this.initialized = false;
            }
            return;
        }
        this._applyMeshPrototype(rule);
        this._rebuild();
    }

    /** Append one instance at an exact position (random yaw + scale from params) without rebuilding.
     *  Call {@link commit} once after a batch of pushes. Returns false when the instance ceiling is
     *  reached, so callers can report the clipping instead of silently dropping the request. */
    public pushInstance(x: number, y: number, z: number): boolean {
        if (this._instances.length / 5 >= MAX_INSTANCES) return false;
        const yaw = Math.random() * Math.PI * 2;
        const scale = this.params.minScale + Math.random() * (this.params.maxScale - this.params.minScale);
        this._instances.push(x, y, z, yaw, scale);
        this._dirty = true;
        return true;
    }

    /** Rebuild the spatial grid if any instances were pushed since the last commit. */
    public commit(): boolean {
        if (!this._dirty) return false;
        this._dirty = false;
        this._rebuild();
        return true;
    }

    /** Remove all instances (used before regenerating foliage across the whole terrain). */
    public clear(): void {
        // Reset the pending-push flag FIRST: the early return below would otherwise leave it set and
        // cost a redundant full _rebuild() on the next commit().
        this._dirty = false;
        if (this._instances.length === 0) return;
        this._instances = [];
        this._rebuild();
    }

    /** Release this layer's GPU buffers (queued for the renderer to delete) and drop its instances. */
    public dispose(): void {
        for (const c of this.cells) if (c.glBuffer) ORPHANED_FOLIAGE_BUFFERS.push(c.glBuffer);
        for (const b of this._stale) ORPHANED_FOLIAGE_BUFFERS.push(b);
        this._stale = [];
        this.cells = [];
        this._instances = [];
        this._dirty = false;
        this.count = 0;
        this.initialized = false;
        this.version++;
    }

    /** Scatter new instances within the brush disc; Y is sampled from the terrain surface. */
    public scatter(worldX: number, worldZ: number, radius: number, sampleHeight: (x: number, z: number) => number): boolean {
        if (this.count >= MAX_INSTANCES) return false;
        // density is per m², so the disc area sets the count — the same number reads the same at any radius.
        const n = Math.max(1, Math.round(this.params.density * Math.PI * radius * radius));
        let added = 0;
        for (let i = 0; i < n && this.count + added < MAX_INSTANCES; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * radius;
            const x = worldX + Math.cos(a) * r;
            const z = worldZ + Math.sin(a) * r;
            const y = sampleHeight(x, z);
            const yaw = Math.random() * Math.PI * 2;
            const scale = this.params.minScale + Math.random() * (this.params.maxScale - this.params.minScale);
            this._instances.push(x, y, z, yaw, scale);
            added++;
        }
        if (added > 0) { this._rebuild(); return true; }
        return false;
    }

    /** Remove instances whose base is within `radius` of the brush point. */
    public erase(worldX: number, worldZ: number, radius: number): boolean {
        const r2 = radius * radius;
        const kept: number[] = [];
        let removed = 0;
        for (let i = 0; i < this._instances.length; i += 5) {
            const dx = this._instances[i] - worldX, dz = this._instances[i + 2] - worldZ;
            if (dx * dx + dz * dz <= r2) { removed++; continue; }
            kept.push(this._instances[i], this._instances[i + 1], this._instances[i + 2], this._instances[i + 3], this._instances[i + 4]);
        }
        if (removed === 0) return false;
        this._instances = kept;
        this._rebuild();
        return true;
    }

    /** Change the spatial-grid cell size (world units) and re-bucket the instances. No-op if unchanged. */
    public setCellSize(size: number): void {
        if (size > 0 && size !== this.cellSize) {
            this.cellSize = size;
            this._rebuild();
        }
    }

    /**
     * Visit every instance whose base falls within `radius` of world (x, z). The spatial grid's cell
     * AABBs reject whole buckets with one test each, so this stays cheap on a 100k-instance layer.
     *
     * `index` is only stable until the next rebuild (any scatter/erase/clear) — consumers that cache it
     * must watch {@link version} and re-query when it changes.
     */
    public forEachInstanceNear(
        x: number, z: number, radius: number,
        cb: (index: number, ix: number, iy: number, iz: number, yaw: number, scale: number) => void,
    ): void {
        const r2 = radius * radius;
        for (const cell of this.cells) {
            // Cheap AABB reject on XZ (the cell's Y extent is irrelevant to a horizontal radius query).
            const dx = x < cell.min[0] ? cell.min[0] - x : x > cell.max[0] ? x - cell.max[0] : 0;
            const dz = z < cell.min[2] ? cell.min[2] - z : z > cell.max[2] ? z - cell.max[2] : 0;
            if (dx * dx + dz * dz > r2) continue;
            for (let j = 0; j < cell.indices.length; j++) {
                const i = cell.indices[j];
                const b = i * 5;
                const ex = this._instances[b] - x, ez = this._instances[b + 2] - z;
                if (ex * ex + ez * ez > r2) continue;
                cb(i, this._instances[b], this._instances[b + 1], this._instances[b + 2],
                    this._instances[b + 3], this._instances[b + 4]);
            }
        }
    }

    /** Read one instance into `out` = [x, y, z, yaw, scale]. False if the index is out of range. */
    public instanceAt(index: number, out: number[]): boolean {
        const b = index * 5;
        if (index < 0 || b + 4 >= this._instances.length) return false;
        out[0] = this._instances[b]; out[1] = this._instances[b + 1]; out[2] = this._instances[b + 2];
        out[3] = this._instances[b + 3]; out[4] = this._instances[b + 4];
        return true;
    }

    /** WebGL buffers left over from the previous cell layout; the renderer deletes these. Returns and clears. */
    public collectStaleBuffers(): WebGLBuffer[] {
        const s = this._stale;
        this._stale = [];
        return s;
    }

    /** Largest absolute local-space coordinate of the instance geometry, scaled by the max instance scale.
     *  Used to expand each cell's AABB so it fully contains the meshes/billboards standing on it. */
    private _instanceExtent(): number {
        let e = 0;
        for (const m of this.levels[0].models) {
            const b = m.geometry.bvh.bounds;
            e = Math.max(e,
                Math.abs(b.min[0]), Math.abs(b.max[0]),
                Math.abs(b.min[1]), Math.abs(b.max[1]),
                Math.abs(b.min[2]), Math.abs(b.max[2]),
            );
        }
        return e * this.params.maxScale;
    }

    private _rebuild(): void {
        this.count = this._instances.length / 5;

        // Retire the previous cells' GPU buffers (a new cell layout gets fresh buffers).
        for (const c of this.cells) if (c.glBuffer) this._stale.push(c.glBuffer);

        // Bucket instance indices into a uniform XZ grid.
        const cs = this.cellSize;
        const buckets = new Map<string, number[]>();
        for (let i = 0; i < this.count; i++) {
            const b = i * 5;
            const key = `${Math.floor(this._instances[b] / cs)},${Math.floor(this._instances[b + 2] / cs)}`;
            let arr = buckets.get(key);
            if (!arr) { arr = []; buckets.set(key, arr); }
            arr.push(i);
        }

        const extent = this._instanceExtent();
        const cells: FoliageCell[] = [];
        for (const arr of buckets.values()) {
            const matrices = new Float32Array(arr.length * 16);
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let j = 0; j < arr.length; j++) {
                const b = arr[j] * 5;
                const x = this._instances[b], y = this._instances[b + 1], z = this._instances[b + 2];
                quat.setAxisAngle(this._q, [0, 1, 0], this._instances[b + 3]);
                const s = this._instances[b + 4];
                mat4.fromRotationTranslationScale(this._m, this._q, [x, y, z], [s, s, s]);
                matrices.set(this._m, j * 16);
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            cells.push({
                matrices,
                count: arr.length,
                indices: Int32Array.from(arr),
                min: [minX - extent, minY - extent, minZ - extent],
                max: [maxX + extent, maxY + extent, maxZ + extent],
                glBuffer: null,
                uploadedVersion: -1,
                lod: 0,
            });
        }

        this.cells = cells;
        this.version++;
    }

    public serialize(): any {
        const inst = new Float32Array(this._instances);
        const bytes = new Uint8Array(inst.buffer);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk)
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
        return {
            kind: this.kind,
            name: this.name,
            textureId: this.textureId,
            params: this.params,
            // `params.density` round-trips independently of the terrain material's rule, so it carries
            // its own unit marker (see deserialize).
            densityUnit: FOLIAGE_DENSITY_UNIT,
            collision: this.collision ?? undefined,
            // `model` stays the single primary model so older builds still load this JSON; the full
            // multi-sub-mesh + LOD payload rides in `models`/`lods`.
            model: this.kind === 'mesh' ? this.model.serialize() : undefined,
            models: this.kind === 'mesh' && this.levels[0].models.length > 1
                ? this.levels[0].models.map(m => m.serialize()) : undefined,
            lods: this.kind === 'mesh' && this.levels.length > 1
                ? this.levels.slice(1).map(l => ({ models: l.models.map(m => m.serialize()), distance: l.distance }))
                : undefined,
            billboard: this.kind === 'mesh' && this.billboardModel
                ? { textureId: this.billboardTextureId, distance: this.billboardDistance } : undefined,
            cullDistance: this.cullDistance > 0 ? this.cullDistance : undefined,
            instances: btoa(bin),
        };
    }

    public static deserialize(json: any): FoliageLayer {
        // Migrate the density unit into a COPY — `json.params` is re-read by the editor's resync paths,
        // so mutating it in place would divide a second time on the next load.
        const params = { ...(json.params || {}) };
        if (json.densityUnit !== FOLIAGE_DENSITY_UNIT && params.density !== undefined)
            params.density = Math.max(0, params.density / 100);

        let layer: FoliageLayer;
        if (json.kind === 'billboard') {
            layer = FoliageLayer.Billboard(json.name, json.textureId, params);
            layer.collision = json.collision ?? null;
        } else {
            layer = FoliageLayer.Mesh(json.name, Model.parse(json.models?.length ? json.models[0] : json.model), params);
            layer._applyMeshPrototype(json);
        }
        if (json.instances) {
            const bin = atob(json.instances);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const floats = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
            layer._instances = Array.from(floats);
            layer._rebuild();
        }
        return layer;
    }
}
