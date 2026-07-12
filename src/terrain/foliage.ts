import { mat4, quat } from 'gl-matrix';
import { Geometry } from '../core/geometry';
import { Model } from '../graphics/model';
import { Material, TerrainFoliageRule } from '../graphics/material';

export type FoliageKind = 'mesh' | 'billboard';

export interface FoliageParams {
    /** Blades/props added per brush application. */
    density: number;
    minScale: number;
    maxScale: number;
}

const DEFAULT_PARAMS: FoliageParams = { density: 8, minScale: 0.8, maxScale: 1.4 };
const MAX_INSTANCES = 200000;

/**
 * A spatial-grid cell of a foliage layer: the packed instance matrices whose XZ position falls in this
 * cell, plus a cached world-space AABB used for frustum/distance culling. Each cell owns its own static
 * GPU buffer (lazily created by the renderer's foliage pass) so off-screen/far cells can be skipped
 * without any per-frame re-upload.
 */
export interface FoliageCell {
    matrices: Float32Array;              // packed mat4s for this cell (16 floats/instance)
    count: number;
    min: [number, number, number];       // world AABB (instance extents, expanded by geometry size)
    max: [number, number, number];
    glBuffer: WebGLBuffer | null;         // renderer-owned; lazily created
    uploadedVersion: number;              // renderer's record of which layer.version is on the GPU
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
    public model: Model;
    public textureId: string | null;
    public params: FoliageParams;

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
    }

    public static Billboard(name: string, textureId: string, params?: Partial<FoliageParams>): FoliageLayer {
        const material = Material.Basic({ color: [1, 1, 1], texture: textureId }, { side: 'double', castShadow: false });
        return new FoliageLayer('billboard', name, new Model(crossQuadGeometry(), material), textureId, params);
    }

    public static Mesh(name: string, model: Model, params?: Partial<FoliageParams>): FoliageLayer {
        return new FoliageLayer('mesh', name, model, null, params);
    }

    /** Build a runtime layer from a terrain-material foliage rule (billboard texture or mesh model). */
    public static fromRule(rule: TerrainFoliageRule): FoliageLayer {
        const params: Partial<FoliageParams> = {};
        if (rule.density !== undefined) params.density = rule.density;
        if (rule.minScale !== undefined) params.minScale = rule.minScale;
        if (rule.maxScale !== undefined) params.maxScale = rule.maxScale;
        if (rule.kind === 'billboard') return FoliageLayer.Billboard(rule.name, rule.textureId || 'Null', params);
        return FoliageLayer.Mesh(rule.name, Model.parse(rule.model), params);
    }

    /** Append one instance at an exact position (random yaw + scale from params) without rebuilding.
     *  Call {@link commit} once after a batch of pushes. */
    public pushInstance(x: number, y: number, z: number): void {
        if (this._instances.length / 5 >= MAX_INSTANCES) return;
        const yaw = Math.random() * Math.PI * 2;
        const scale = this.params.minScale + Math.random() * (this.params.maxScale - this.params.minScale);
        this._instances.push(x, y, z, yaw, scale);
        this._dirty = true;
    }

    /** Rebuild the spatial grid if any instances were pushed since the last commit. */
    public commit(): boolean {
        if (!this._dirty) return false;
        this._dirty = false;
        this._rebuild();
        return true;
    }

    /** Scatter new instances within the brush disc; Y is sampled from the terrain surface. */
    public scatter(worldX: number, worldZ: number, radius: number, sampleHeight: (x: number, z: number) => number): boolean {
        if (this.count >= MAX_INSTANCES) return false;
        const n = Math.max(1, Math.floor(this.params.density));
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

    /** WebGL buffers left over from the previous cell layout; the renderer deletes these. Returns and clears. */
    public collectStaleBuffers(): WebGLBuffer[] {
        const s = this._stale;
        this._stale = [];
        return s;
    }

    /** Largest absolute local-space coordinate of the instance geometry, scaled by the max instance scale.
     *  Used to expand each cell's AABB so it fully contains the meshes/billboards standing on it. */
    private _instanceExtent(): number {
        const b = this.model.geometry.bvh.bounds;
        const e = Math.max(
            Math.abs(b.min[0]), Math.abs(b.max[0]),
            Math.abs(b.min[1]), Math.abs(b.max[1]),
            Math.abs(b.min[2]), Math.abs(b.max[2]),
        );
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
                min: [minX - extent, minY - extent, minZ - extent],
                max: [maxX + extent, maxY + extent, maxZ + extent],
                glBuffer: null,
                uploadedVersion: -1,
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
            model: this.kind === 'mesh' ? this.model.serialize() : undefined,
            instances: btoa(bin),
        };
    }

    public static deserialize(json: any): FoliageLayer {
        let layer: FoliageLayer;
        if (json.kind === 'billboard') layer = FoliageLayer.Billboard(json.name, json.textureId, json.params);
        else layer = FoliageLayer.Mesh(json.name, Model.parse(json.model), json.params);
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
