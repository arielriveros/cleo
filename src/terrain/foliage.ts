import { mat4, quat } from 'gl-matrix';
import type { Buffer as RhiBuffer } from '../graphics/rhi/resources';
import { Geometry } from '../core/geometry';
import { Model } from '../graphics/model';
import type { Mesh } from '../graphics/mesh';
import {
    Material, TerrainFoliageRule, FoliageCollision, foliageRuleKey,
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
 * Squared distance at which a cell should be culled, given whether it is currently drawn.
 *
 * The foliage distance cull is a step function: the frame a cell crosses it, the whole cell's instance
 * count appears (or vanishes) at once. Undamped, a cell parked on the boundary flips every frame on
 * sub-metre camera jitter and pays that cost repeatedly. The band is asymmetric in the cheap direction —
 * appear at the threshold, disappear only past `threshold × hysteresis` — so the expensive transition
 * (coming in) happens at the authored distance and the free one is what gets delayed.
 *
 * Lives here rather than in the renderer so it can be tested without a GL context; the per-cell LOD band
 * a few lines below its call site has used the same ×0.9 shape all along.
 */
export function foliageCullLimitSq(maxD2: number, wasVisible: boolean, hysteresis: number): number {
    if (!isFinite(maxD2)) return maxD2;
    return wasVisible ? maxD2 * hysteresis * hysteresis : maxD2;
}

/**
 * How many newly-visible cells to admit this frame, from `pending.length` waiting.
 *
 * `firstSight` — no cell of the layer was up last frame — means a scene load or the camera arriving at a
 * new landscape. Budgeting there would not smooth a spike, it would fade the whole layer in over a
 * second, so everything is admitted at once and the load cost is paid as it always was. The budget is for
 * the steady state, where a moving camera crosses a few cell boundaries at a time.
 */
export function foliageAdmitCount(pendingCount: number, budget: number, firstSight: boolean): number {
    if (firstSight || budget <= 0) return pendingCount;
    return Math.min(budget, pendingCount);
}

/**
 * GPU buffers left behind by layers disposed with their terrain. The renderer's foliage pass only walks
 * LIVE landscapes, so this queue is the only way those buffers still reach a `destroy()`.
 */
const ORPHANED_FOLIAGE_BUFFERS: RhiBuffer[] = [];

/** Drain the buffers of disposed foliage layers. Called by the renderer, which owns the GL context. */
export function collectOrphanedFoliageBuffers(): RhiBuffer[] {
    if (ORPHANED_FOLIAGE_BUFFERS.length === 0) return [];
    return ORPHANED_FOLIAGE_BUFFERS.splice(0, ORPHANED_FOLIAGE_BUFFERS.length);
}

/**
 * Prototype meshes of disposed layers. The same story as ORPHANED_FOLIAGE_BUFFERS, for the other half
 * of a layer's GPU footprint: `_applyMeshPrototype` replaces `levels`/`billboardModel` wholesale, and
 * a dropped JS reference frees no VBO, IBO or VAO.
 */
const ORPHANED_FOLIAGE_MESHES: Mesh[] = [];

/** Drain the prototype meshes of disposed foliage layers. Called by the renderer. */
export function collectOrphanedFoliageMeshes(): Mesh[] {
    if (ORPHANED_FOLIAGE_MESHES.length === 0) return [];
    return ORPHANED_FOLIAGE_MESHES.splice(0, ORPHANED_FOLIAGE_MESHES.length);
}

/**
 * A spatial-grid cell of a foliage layer: the packed instance matrices whose XZ position falls in it,
 * plus a cached world-space AABB for frustum/distance culling. Each cell owns a static GPU buffer,
 * lazily created by the renderer's foliage pass.
 */
export interface FoliageCell {
    matrices: Float32Array;              // packed mat4s for this cell (16 floats/instance)
    count: number;
    indices: Int32Array;                 // instance indices in this cell (see forEachInstanceNear)
    min: [number, number, number];       // world AABB (instance extents, expanded by geometry size)
    max: [number, number, number];
    glBuffer: RhiBuffer | null;        // renderer-owned; lazily created
    uploadedVersion: number;              // renderer's record of which layer.version is on the GPU
    lod: number;                          // current detail level (renderer-owned hysteresis memory)
    /**
     * Was this cell drawn last frame? Renderer-owned, like `lod`.
     *
     * Two jobs, both about the DISTANCE CULL being a step function. It is the state the cull's hysteresis
     * band tests against, so a cell hovering on the boundary cannot flip in and out on sub-metre camera
     * jitter; and it is how the renderer tells a cell that is merely still visible from one that is
     * newly visible and therefore subject to the per-frame admission budget.
     */
    visible: boolean;
}

/** One detail level of a mesh foliage layer: the sub-mesh models drawn per instance (transforms baked
 *  into the geometry editor-side) and the camera distance at which the level takes over. */
export interface FoliageLodLevel {
    models: Model[];
    distance: number;                     // levels[0].distance is always 0
}

/**
 * Build a two-quad crossed billboard (an "X"), base at y=0, UV 0..1, up-facing normals. Unit-sized by
 * default, which is the BILLBOARD layer contract: per-instance scale is then the tuft height in metres.
 * A mesh layer's impostor passes the prototype's authored footprint instead (`_applyMeshPrototype`).
 */
export function crossQuadGeometry(width: number = 1, height: number = 1): Geometry {
    const hw = width * 0.5;
    const positions: [number, number, number][] = [
        [-hw, 0, 0], [hw, 0, 0], [hw, height, 0], [-hw, height, 0],
        [0, 0, -hw], [0, 0, hw], [0, height, hw], [0, height, -hw],
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
    /**
     * Display name. Mutable, and what exclude lists match on — so it is not this layer's identity.
     * A rename follows the rule; see `key`.
     */
    public name: string;
    /**
     * Stable identity, the map key `Terrain._foliageByKey` files this layer under.
     *
     * Separate from `name` because a rename used to orphan a populated layer: the terrain looked the
     * layer up by the rule's new name, missed, and built a second one — leaving the scattered instances
     * drawn by a layer nothing could reach, and which `pruneFoliage` would not collect because it was
     * not empty. Defaults to the name so a layer with no rule behind it behaves exactly as before.
     */
    public key: string;
    /** The primary model — always levels[0].models[0]. */
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
    /**
     * Whether these instances rasterize into the shadow cascades. Off by default: switching it on adds
     * one instanced draw per cell PER CASCADE. This flag drives the shadow pass directly — the impostor
     * materials stay authored `castShadow: false` for the colour pass.
     */
    public castShadows = false;
    /** Static physics proxy for nearby instances, or null for non-collidable foliage. Mirrored from the
     *  rule onto the LAYER, since a published build rebuilds layers from the serialized foliage blob
     *  without re-parsing terrain materials. */
    public collision: FoliageCollision | null = null;

    // Compact instance data, stride 5: [x, y, z, yaw, scale].
    private _instances: number[] = [];
    public count = 0;
    public version = 0;

    // Spatial grid over the instances (world XZ), rebuilt on scatter/erase. Cell world-unit size:
    // larger = fewer draw calls but looser culling.
    public cells: FoliageCell[] = [];
    /**
     * Grid cell size for culling and instance bucketing.
     *
     * MUST match the renderer's `_foliageCellSize`. The renderer reconciles any mismatch on its first
     * frame (`layer.cellSize !== this._foliageCellSize` -> `setCellSize`), and that call is a full
     * `_rebuild()` over every instance plus a re-upload of every cell buffer — so a default that differs
     * buys a guaranteed hitch on the first frame after every scene load. `deserialize` restores the
     * stored value for the same reason.
     */
    public cellSize = 13;

    // Whether the (static) per-vertex mesh + VAO have been uploaded (set by the renderer's foliage pass).
    public initialized = false;

    // GPU buffers orphaned by a rebuild (cells are recreated), drained + deleted by the renderer.
    private _stale: RhiBuffer[] = [];

    // Prototype meshes orphaned by a prototype swap, drained + disposed by the renderer.
    //
    // Separate from `_stale` because these are Meshes, not raw buffers: a Mesh owns a VAO and several
    // buffers and knows how to release them. Before this queue existed, every refresh leaked the whole
    // outgoing LOD chain — which mattered little when the only trigger was a manual re-sync, and
    // matters now that a model or material save re-derives automatically.
    private _retiredMeshes: Mesh[] = [];

    // Set by pushInstance(); commit() rebuilds once for a whole batch.
    private _dirty = false;

    private _q = quat.create();
    private _m = mat4.create();

    constructor(kind: FoliageKind, name: string, model: Model, textureId: string | null, params?: Partial<FoliageParams>) {
        this.kind = kind;
        this.name = name;
        this.key = name;   // callers that build from a rule overwrite this with foliageRuleKey(rule)
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
            bb.key = foliageRuleKey(rule);
            bb.collision = rule.collision ?? null;
            bb.castShadows = !!rule.castShadows;
            // Must be read here as well as in `_applyMeshPrototype`, or a billboard rule's cull distance
            // is dropped and the layer falls back to the renderer's global.
            bb.cullDistance = Math.max(0, Number(rule.cullDistance) || 0);
            return bb;
        }
        const base = (rule.models?.length ? rule.models[0] : rule.model);
        const layer = FoliageLayer.Mesh(rule.name, Model.parse(base), params);
        layer.key = foliageRuleKey(rule);
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
            this._retireMeshes(this.levels.flatMap(l => l.models));
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
            // Sized to the prototype it replaces, NOT 1x1: an instance scale MULTIPLIES the authored size
            // on the mesh but IS the size in metres on a unit quad, so a unit card would not match.
            const [w, h] = this._prototypeFootprint();
            if (this.billboardModel) this._retireMeshes([this.billboardModel]);
            this.billboardModel = new Model(crossQuadGeometry(w, h), material);
            this.billboardTextureId = src.billboard.textureId;
            this.billboardDistance = Math.max(0, Number(src.billboard.distance) || 0);
        } else {
            if (this.billboardModel) this._retireMeshes([this.billboardModel]);
            this.billboardModel = null;
            this.billboardTextureId = null;
            this.billboardDistance = Infinity;
        }
        this.cullDistance = Math.max(0, Number(src.cullDistance) || 0);
        this.collision = src.collision ?? null;
        this.castShadows = !!src.castShadows;
        this.initialized = false; // new Model objects — the foliage pass re-uploads their meshes
    }

    /**
     * Authored width and height of LOD0, in the prototype's own space — the box the impostor must match.
     * Width is the LARGER horizontal extent.
     */
    private _prototypeFootprint(): [number, number] {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const model of this.levels[0]?.models ?? []) {
            const bb = model.geometry.boundingBox;
            minX = Math.min(minX, bb.min[0]); maxX = Math.max(maxX, bb.max[0]);
            minY = Math.min(minY, bb.min[1]); maxY = Math.max(maxY, bb.max[1]);
            minZ = Math.min(minZ, bb.min[2]); maxZ = Math.max(maxZ, bb.max[2]);
        }
        const w = Math.max(maxX - minX, maxZ - minZ);
        const h = maxY - minY;
        // A degenerate or empty prototype falls back to the unit quad rather than collapsing the card.
        return [Number.isFinite(w) && w > 1e-4 ? w : 1, Number.isFinite(h) && h > 1e-4 ? h : 1];
    }

    /**
     * Swap this layer's prototypes for an updated rule WITHOUT touching the scattered instances (used
     * when the source mesh asset, its material, or the terrain material was edited).
     *
     * Instance matrices carry only position, yaw and scale — a prototype's own transform is baked into
     * its vertices editor-side — so a geometry or material edit cannot invalidate one. That is what
     * lets hand-painted placement survive an edit, and it is why this refreshes cell EXTENTS rather
     * than rebuilding: the AABBs pad by the prototype's size, so only they depend on the new geometry.
     *
     * `density` is the one field this cannot absorb, because it decides how many instances should
     * exist rather than what they look like. It is reported back instead; the caller owns the choice
     * to re-scatter, since that is the one operation here that discards the user's placement.
     */
    public setPrototype(rule: TerrainFoliageRule): { densityChanged: boolean } {
        const prevDensity = this.params.density;
        const prevMin = this.params.minScale, prevMax = this.params.maxScale;
        if (rule.density !== undefined) this.params.density = rule.density;
        if (rule.minScale !== undefined) this.params.minScale = rule.minScale;
        if (rule.maxScale !== undefined) this.params.maxScale = rule.maxScale;
        this.castShadows = !!rule.castShadows;

        // A scale RANGE change is different from every other field here: per-instance scale really is
        // baked into the matrices. Re-rolling it in place keeps each instance's position and yaw, so
        // the pattern is untouched while the plants take their new sizes.
        const scaleChanged = this.params.minScale !== prevMin || this.params.maxScale !== prevMax;

        if (this.kind === 'billboard') {
            this.collision = rule.collision ?? null;
            this.cullDistance = Math.max(0, Number(rule.cullDistance) || 0);
            const tex = rule.textureId || 'Null';
            if (tex !== this.textureId) {
                this.textureId = tex;
                const material = Material.Basic({ color: [1, 1, 1], texture: tex }, { side: 'double', castShadow: false });
                this._retireMeshes(this.levels.flatMap(l => l.models));
                this.model = new Model(crossQuadGeometry(), material);
                this.levels = [{ models: [this.model], distance: 0 }];
                this.initialized = false;
            }
            // A billboard's card is a unit quad, so its geometry extent never changes — but
            // `_instanceExtent` multiplies by `params.maxScale`, which just might have. This branch
            // used to return without refreshing anything, leaving the cell AABBs too tight and
            // culling tall tufts at the screen edge.
            if (scaleChanged) this._rerollScales();
            else this._refreshExtents();
            return { densityChanged: this.params.density !== prevDensity };
        }

        this._applyMeshPrototype(rule);
        if (scaleChanged) this._rerollScales();
        else this._refreshExtents();
        return { densityChanged: this.params.density !== prevDensity };
    }

    /** Queue prototype meshes for the renderer to dispose. Safe on models never uploaded. */
    private _retireMeshes(models: Model[]): void {
        for (const m of models) if (m.mesh) this._retiredMeshes.push(m.mesh);
    }

    /** Prototype meshes orphaned by a prototype swap; the renderer disposes these. Returns and clears. */
    public collectRetiredMeshes(): Mesh[] {
        const m = this._retiredMeshes;
        this._retiredMeshes = [];
        return m;
    }

    /**
     * Re-pad every cell's AABB against the current prototype, touching nothing else.
     *
     * The cheap half of `_rebuild`. A prototype swap does not move an instance, so re-bucketing them,
     * reallocating every matrix array and bumping `version` — which forces the renderer to re-upload
     * every cell's buffer — is all work whose result is identical to what was already there. Only the
     * extent padding actually depends on the new geometry.
     *
     * `cell.lod` MUST be reset when the level count or the impostor changes: the renderer indexes the
     * billboard bucket at `layer.levels.length`, so a cell remembering a level that no longer exists
     * would select past the end. `_rebuild` got this for free by allocating fresh cells.
     */
    private _refreshExtents(): void {
        const extent = this._instanceExtent();
        const buckets = this.levels.length + (this.billboardModel ? 1 : 0);
        for (const c of this.cells) {
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let j = 0; j < c.indices.length; j++) {
                const b = c.indices[j] * 5;
                const x = this._instances[b], y = this._instances[b + 1], z = this._instances[b + 2];
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            c.min = [minX - extent, minY - extent, minZ - extent];
            c.max = [maxX + extent, maxY + extent, maxZ + extent];
            if (c.lod >= buckets) c.lod = 0;
        }
    }

    /**
     * Draw a fresh scale for every instance from the current range, keeping position and yaw.
     *
     * The narrow case where instance data genuinely has to change without the layout changing: scale
     * IS in the matrix. Re-scattering would achieve the same visual result and throw the placement
     * away with it.
     */
    private _rerollScales(): void {
        const { minScale, maxScale } = this.params;
        for (let i = 0; i < this._instances.length; i += 5)
            this._instances[i + 4] = minScale + Math.random() * (maxScale - minScale);
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
        // Must be reset before the early return below, or the next commit() pays a redundant _rebuild().
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
        // Prototype meshes too: the renderer's foliage pass only walks LIVE landscapes, so once this
        // layer is off a terrain nothing else can reach them.
        this._retireMeshes(this.levels.flatMap(l => l.models));
        if (this.billboardModel) this._retireMeshes([this.billboardModel]);
        for (const m of this._retiredMeshes) ORPHANED_FOLIAGE_MESHES.push(m);
        this._retiredMeshes = [];
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
        // density is per m², so the disc area sets the count.
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
     * Visit every instance whose base falls within `radius` of world (x, z). `index` is only stable until
     * the next rebuild (any scatter/erase/clear); consumers that cache it must watch {@link version}.
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
    public collectStaleBuffers(): RhiBuffer[] {
        const s = this._stale;
        this._stale = [];
        return s;
    }

    /** Largest absolute local-space coordinate of the instance geometry, scaled by the max instance scale.
     *  Expands each cell's AABB so it fully contains the meshes/billboards standing on it. */
    private _instanceExtent(): number {
        let e = 0;
        for (const m of this.levels[0].models) {
            // `boundingBox`, NEVER `bvh.bounds`: reading `bvh` force-builds the whole hierarchy over the
            // prototype's triangles (geometry.ts warns about this twice). For a heavy tree across several
            // prototypes that is a multi-hundred-millisecond hitch, and it is re-paid on every prototype
            // refresh and every brush stroke, because _applyMeshPrototype allocates fresh Model objects
            // and discards the memoised hierarchy. The sibling _prototypeFootprint already does this.
            const b = m.geometry.boundingBox;
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
                visible: false,
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
            // Persisted, or a reload would file every layer under its name again and undo the re-key.
            key: this.key !== this.name ? this.key : undefined,
            textureId: this.textureId,
            params: this.params,
            // `params.density` round-trips independently of the terrain material's rule, so it carries
            // its own unit marker (see deserialize).
            densityUnit: FOLIAGE_DENSITY_UNIT,
            collision: this.collision ?? undefined,
            // `model` is the single primary model, for older builds; the full multi-sub-mesh + LOD
            // payload rides in `models`/`lods`.
            model: this.kind === 'mesh' ? this.model.serialize() : undefined,
            models: this.kind === 'mesh' && this.levels[0].models.length > 1
                ? this.levels[0].models.map(m => m.serialize()) : undefined,
            lods: this.kind === 'mesh' && this.levels.length > 1
                ? this.levels.slice(1).map(l => ({ models: l.models.map(m => m.serialize()), distance: l.distance }))
                : undefined,
            billboard: this.kind === 'mesh' && this.billboardModel
                ? { textureId: this.billboardTextureId, distance: this.billboardDistance } : undefined,
            cullDistance: this.cullDistance > 0 ? this.cullDistance : undefined,
            castShadows: this.castShadows || undefined,
            cellSize: this.cellSize,
            instances: btoa(bin),
        };
    }

    public static deserialize(json: any): FoliageLayer {
        // Migrate the density unit into a COPY: `json.params` is re-read by the editor's resync paths,
        // so mutating it in place would divide a second time on the next load.
        const params = { ...(json.params || {}) };
        if (json.densityUnit !== FOLIAGE_DENSITY_UNIT && params.density !== undefined)
            params.density = Math.max(0, params.density / 100);

        let layer: FoliageLayer;
        if (json.kind === 'billboard') {
            layer = FoliageLayer.Billboard(json.name, json.textureId, params);
            layer.collision = json.collision ?? null;
            layer.cullDistance = Math.max(0, Number(json.cullDistance) || 0);
        } else {
            layer = FoliageLayer.Mesh(json.name, Model.parse(json.models?.length ? json.models[0] : json.model), params);
            layer._applyMeshPrototype(json);
        }
        layer.castShadows = !!json.castShadows;
        // Restored BEFORE the instance rebuild below: setting it after would bucket every instance at the
        // default size and leave the renderer to notice the mismatch and rebuild the whole grid again on
        // its first frame. A layer saved before this was persisted keeps whatever default it loads with.
        if (Number(json.cellSize) > 0) layer.cellSize = Number(json.cellSize);
        // Absent on anything saved before layers had a stable key; the name is what it was filed under
        // then, and Terrain migrates it onto the rule's key the first time it resolves one.
        layer.key = json.key ?? json.name;
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
