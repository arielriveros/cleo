// Aliased: `Material` in this file already means the graphics material imported below.
import { Body, Heightfield, World, Material as PhysicsMaterial } from 'cannon-es';
import { vec3 } from 'gl-matrix';
import { v4 as uuidv4 } from 'uuid';
import { Geometry } from '../core/geometry';
import { bytesToBase64, base64ToBytes } from '../core/base64';
import { Model } from '../graphics/model';
import { Material, TerrainMaterial, TerrainFoliageRule, foliageRuleKey } from '../graphics/material';
import { Texture } from '../graphics/texture';
import { TextureManager } from '../graphics/systems/textureManager';
import { TexturePacker } from '../graphics/systems/texturePacker';
import { Loader } from '../graphics/loader';
import { Logger } from '../core/logger';
import { authoring } from '../core/eventBus';
import { FoliageLayer } from './foliage';
import { DEFAULT_FOLIAGE_DENSITY } from '../graphics/material';
import { FoliageColliderField, FoliageColliderSettings, DEFAULT_FOLIAGE_COLLIDERS } from './foliageColliders';

/** Ceiling on candidate points a single brush application may try, so a wide brush at grass density
 *  can't stall the pointer handler. Whole-terrain generation is not capped (it is an explicit action). */
const MAX_SCATTER_PER_CALL = 20000;

/** What a whole-terrain foliage regeneration actually did, so the editor can report it. */
export interface FoliageGenerateResult {
    /** Instances placed. */
    placed: number;
    /** Distinct foliage layers that received at least one instance. */
    layers: number;
    /** Instances destroyed by the wipe that precedes a regeneration. */
    cleared: number;
    /** Why nothing (or not everything) was placed. Absent on a clean full run. */
    reason?: 'no-rules' | 'no-coverage' | 'clipped';
}

/** One paintable terrain material layer (splat channel 0..3). */
export interface TerrainLayer {
    /** Derived albedo texture id (TextureManager) or null. */
    albedoId: string | null;
    /** Derived ambient-occlusion id or null (r = occlusion). Packed into the ALBEDO map's alpha. */
    aoId: string | null;
    /** Derived normal-map id or null. */
    normalId: string | null;
    /** Derived height map id or null (r = height 0..1). Packed into the normal map's alpha. */
    heightId: string | null;
    /** Parallax depth for the height map, in the layer's tiled uv. Same units a PBR material uses. */
    dispScale: number;
    /** The height map is a DEPTH map (white = deep). */
    invertHeight: boolean;
    /**
     * Whether this layer has relief to march. True exactly when it has a height map.
     *
     * It used to mean "raises the terrain's VERTICES", and for a while terrain relief was geometry
     * only: a layer's height map was cut at the mip covering one vertex, the coarse half was baked into
     * the mesh and the fine half marched. Two mechanisms sharing one authored number could not be made
     * to agree — vertex spacing and texture footprint are unrelated quantities — so the same map never
     * read the same on terrain as on a mesh. Terrain marches its whole height map now, exactly as a
     * standard material does, and the terrain's own sculpted heightfield is its only geometry.
     */
    displace: boolean;
    /** Height-aware blend sharpness (0 = linear splat blend). */
    heightBlend: number;
    /** Albedo tint / base color (multiplies the albedo texture). */
    color: number[];
    metallic: number;
    roughness: number;
    /** UV repeat across the whole terrain. */
    tiling: number;
    /** Enable automatic height/slope masking for this layer. */
    auto: boolean;
    /** World-Y band the layer is visible in (auto blend). */
    hRange: [number, number];
    /** Slope band (0 flat .. 1 vertical) the layer is visible in (auto blend). */
    sRange: [number, number];
    /** Assigned terrain material (surface + foliage rules), if any. */
    material: TerrainMaterial | null;
    /** Terrain-material asset id (for scene serialize + edit-propagation). */
    materialId: string | null;
    /** @deprecated Legacy plain-albedo id; accepted by setLayer for back-compat with old scenes. */
    textureId?: string | null;
}

export type PaintBrush = { radius: number; strength: number; falloff: number; layer: number };

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';

export interface SculptBrush {
    /** Brush radius in world units. */
    radius: number;
    /** Height change per second at the brush centre (world units). */
    strength: number;
    /** 0 = hard edge, 1 = fully feathered falloff. */
    falloff: number;
    mode: SculptMode;
    /** Target height for the 'flatten' mode (terrain-local Y). */
    flattenHeight?: number;
}

export interface TerrainConfig {
    /** World size of one side of the (square) terrain. */
    size?: number;
    /** Number of vertices per side (resolution). Heightfield is resolution x resolution. */
    resolution?: number;
    /** Quads per side of each render chunk (keeps each chunk under the 65k Uint16 index limit). */
    chunkQuads?: number;
}

/**
 * Smallest usable tiling. Mirrors `TILING_EPSILON` in chunks/terrainLayers.wgsl, where a layer's
 * `log2(tiling)` mip shift and its `dispScale / tiling` depth conversion both divide by it.
 */
export const TILING_EPSILON = 0.01;

/**
 * TERRAIN LAYER RELIEF IS OFF.
 *
 * Turned off deliberately, not broken and not half-removed. A terrain layer's height map still loads,
 * still packs into `u_normal{i}`'s alpha, and still drives the height-aware blend (`u_heightBlend{i}`) —
 * only the parallax march is suppressed, by writing a depth of zero in `_writeLayerUniforms`. That is
 * the single switch: `marchTerrain` early-returns on a zero depth, so the ray, the self-shadow and the
 * per-step fetches all stop with it, and nothing else in the pipeline changes.
 *
 * Why a flag rather than a deletion: the feature is being deferred, not abandoned. It has been through
 * a vertex bake, a geometry/march split and a full-map march, and each rewrite cost more than it
 * returned; the code that survives here is the version that is at least self-consistent, and flipping
 * this back to `true` is the whole of re-enabling it. The editor hides the authoring controls behind
 * the same decision — see `MaterialEditor`'s height section — so nothing is exposed that does nothing.
 *
 * Not a runtime setting on purpose. A per-terrain toggle would mean saving it, migrating it and
 * supporting both paths, which is the cost this exists to avoid.
 */
export const TERRAIN_RELIEF_ENABLED = false;

/**
 * A smooth 0..1 window over `range`, with `edge` of feather at each end — the auto height/slope mask.
 *
 * The CPU twin of `band()` in chunks/terrainLayers.wgsl. The two used to have to agree exactly, because
 * a vertex bake resolved the same masked weights the shader shaded with and would otherwise displace
 * ground the shader drew bare. There is no bake now, so the shader is the only consumer that matters;
 * this stays for callers that want to predict a layer's coverage without rendering it.
 */
export function band(range: readonly number[], v: number, edge: number): number {
    const lo = range[0], hi = range[1];
    if (hi <= lo) return 0;
    const e = Math.max(edge, 1e-6);
    return Math.min(Math.max((v - lo) / e, 0), 1) * Math.min(Math.max((hi - v) / e, 0), 1);
}

/** One render tile of the terrain: a Model whose geometry Y is driven by the shared height field. */
export interface TerrainChunk {
    model: Model;
    /** Inclusive global grid column/row range this chunk covers. */
    c0: number; r0: number; c1: number; r1: number;
    /** Marked when its geometry has been re-deformed and needs a GPU re-upload. */
    dirty: boolean;
    /** Terrain-local Y extent of this chunk (its AABB, kept in sync with the heights). */
    minY: number; maxY: number;
    /** Detail level currently selected for this chunk (0 = full). */
    lod: number;
    /** Vertex steps of the coarse index buffers currently uploaded, or null if none are. */
    lodSteps: [number, number] | null;
}

/** Distance-based terrain LOD configuration (owned by the Renderer, applied per chunk per frame). */
export interface TerrainLodSettings {
    enabled: boolean;
    /** World distance past which a chunk drops to level 1 / level 2. */
    distance1: number;
    distance2: number;
    /** Vertex step of level 1 / level 2 (2, 4 or 8): triangles scale by 1/step². */
    step1: number;
    step2: number;
}

const ATTRIBUTES = ['position', 'normal', 'uv', 'tangent', 'bitangent'];

function resolveConfig(c: TerrainConfig): Required<TerrainConfig> {
    return {
        size: c.size ?? 200,
        resolution: Math.max(2, Math.floor(c.resolution ?? 129)),
        chunkQuads: Math.max(4, Math.floor(c.chunkQuads ?? 32)),
    };
}

/**
 * Heightfield terrain: heights + physics + render chunks, independent of the scene graph. Owned by a
 * LandscapeNode which wraps each chunk Model in a child ModelNode. One static cannon-es Heightfield
 * body provides walkable collision, rebuilt on demand rather than every frame.
 *
 * Assumes the owning node has identity rotation and scale, so terrain-local space differs from world
 * space only by the node's translation.
 */
export class Terrain {
    private _cfg: Required<TerrainConfig>;
    private _R: number;              // vertices per side
    private _element: number;        // world spacing between samples
    private _heights: Float32Array;  // row-major [r * R + c]
    private _chunks: TerrainChunk[] = [];
    private _material: Material;

    private _world: World | null = null;
    private _body: Body | null = null;
    /** Surface the heightfield collides as; supplied by PhysicsSystem. See ensureRegistered. */
    private _physicsMaterial: PhysicsMaterial | null = null;
    private _bodyDirty = false;
    private _lastBodyBuild = 0;       // throttles heightfield rebuilds during a sculpt drag
    private _origin = vec3.create();  // node world position, terrain centre
    private _disposed = false;        // dispose() is called repeatedly for a markForRemoval landscape
    /** Pooled static colliders for nearby collidable foliage instances; created on first use. */
    private _colliders: FoliageColliderField | null = null;
    /** Activation policy for {@link _colliders}. Serialized with the terrain. */
    public foliageColliders: FoliageColliderSettings = { ...DEFAULT_FOLIAGE_COLLIDERS };

    // Texture painting (splat map + up to 4 layers).
    private _splatRes: number;
    private _splat: Uint8Array;       // RGBA per texel, row-major
    private _splatTex: Texture;
    private _splatId: string;
    private _layers: TerrainLayer[] = [];
    private _foliage: FoliageLayer[] = [];
    // Runtime foliage layers created on demand for material-driven scatter, keyed by the rule's STABLE
    // key (see foliageRuleKey) — not its name, which the user can change at any time.
    private _foliageByKey: Map<string, FoliageLayer> = new Map();

    constructor(config: TerrainConfig = {}, material?: Material) {
        this._cfg = resolveConfig(config);
        this._R = this._cfg.resolution;
        this._element = this._cfg.size / (this._R - 1);
        this._heights = new Float32Array(this._R * this._R);
        this._material = material ?? Material.Terrain({ baseColor: [0.38, 0.5, 0.28] }, { side: 'front' });

        // Splat map: same resolution as the height grid. Default: full weight in layer 0 (R channel).
        this._splatRes = this._R;
        this._splat = new Uint8Array(this._splatRes * this._splatRes * 4);
        for (let i = 0; i < this._splatRes * this._splatRes; i++) this._splat[i * 4] = 255;
        this._splatTex = new Texture({ mipMap: false, wrapping: 'clamp' });
        this._splatTex.createFromData(this._splat, this._splatRes, this._splatRes);
        this._splatId = `__editor__terrain_splat_${uuidv4()}`;
        TextureManager.Instance.addTexture(this._splatTex, this._splatId);
        this._material.textures.set('u_splat', this._splatId);

        this._buildChunks();
    }

    public get config(): Required<TerrainConfig> { return this._cfg; }
    public get chunks(): TerrainChunk[] { return this._chunks; }
    public get heights(): Float32Array { return this._heights; }
    public get resolution(): number { return this._R; }
    public get size(): number { return this._cfg.size; }
    public get elementSize(): number { return this._element; }
    public set material(m: Material) {
        this._material = m;
        for (const ch of this._chunks) ch.model.material = m;
    }
    public get material(): Material { return this._material; }
    /** World position of the terrain centre (the owning LandscapeNode's world position). */
    public get origin(): vec3 { return this._origin; }
    public get splatResolution(): number { return this._splatRes; }
    public setOrigin(worldPos: vec3): void { vec3.copy(this._origin, worldPos); }

    // --- the vertex grid ------------------------------------------------------------------------
    //
    // Four functions have always shared one convention: `cols = c1 - c0`, `stride = cols + 1`, row-major
    // with inclusive endpoints, and chunk vertex `k` at local `(i, j)` being height-grid cell
    // `(c0 + i, r0 + j)`. There was briefly a render-density multiplier that broke that one-to-one
    // mapping; it existed to buy vertices for the displacement bake and went with it.

    /** A chunk's vertex extents — one vertex per height-grid point. */
    private _chunkSpan(chunk: TerrainChunk): { cols: number; rows: number; stride: number } {
        const cols = chunk.c1 - chunk.c0, rows = chunk.r1 - chunk.r0;
        return { cols, rows, stride: cols + 1 };
    }

    // --- height sampling ----------------------------------------------------------------------

    /** Bilinear height at terrain-local (x, z). Returns 0 outside the terrain footprint. */
    public heightAt(localX: number, localZ: number): number {
        const half = this._cfg.size / 2;
        const gx = (localX + half) / this._element;
        const gz = (localZ + half) / this._element;
        if (gx < 0 || gz < 0 || gx > this._R - 1 || gz > this._R - 1) return 0;
        const c0 = Math.floor(gx), r0 = Math.floor(gz);
        const c1 = Math.min(c0 + 1, this._R - 1), r1 = Math.min(r0 + 1, this._R - 1);
        const fx = gx - c0, fz = gz - r0;
        const R = this._R;
        const h00 = this._heights[r0 * R + c0], h10 = this._heights[r0 * R + c1];
        const h01 = this._heights[r1 * R + c0], h11 = this._heights[r1 * R + c1];
        const a = h00 + (h10 - h00) * fx;
        const b = h01 + (h11 - h01) * fx;
        return a + (b - a) * fz;
    }

    /**
     * Bilinear SCULPTED height at a fractional grid coordinate. `heightAt` in grid space rather than
     * terrain-local space, and clamped rather than returning 0 outside — a chunk's last vertex sits
     * exactly on `R - 1`, and a border that fell to zero would tear the terrain along its own edge.
     */
    private _baseAt(gx: number, gz: number): number { return this._bilinearAt(this._heights, gx, gz); }

    /** Bilinear read of any grid-resolution field at a fractional grid coordinate, clamped at the border. */
    private _bilinearAt(h: Float32Array, gx: number, gz: number): number {
        const R = this._R;
        const x = Math.min(Math.max(gx, 0), R - 1), z = Math.min(Math.max(gz, 0), R - 1);
        const c0 = Math.floor(x), r0 = Math.floor(z);
        const c1 = Math.min(c0 + 1, R - 1), r1 = Math.min(r0 + 1, R - 1);
        const fx = x - c0, fz = z - r0;
        const a = h[r0 * R + c0] + (h[r0 * R + c1] - h[r0 * R + c0]) * fx;
        const b = h[r1 * R + c0] + (h[r1 * R + c1] - h[r1 * R + c0]) * fx;
        return a + (b - a) * fz;
    }

    /**
     * Bilinear splat weights at a fractional grid coordinate, into `out`.
     *
     * `sampleSplat` is nearest-texel and stays that way — it answers gameplay queries where a texel is
     * the unit. A dense vertex needs weights BETWEEN texels, or every layer boundary stair-steps at
     * exactly the scale the extra vertices were added to resolve. The splat is one RGBA texel per grid
     * cell (`_splatRes === _R`), so this is the same interpolation as `_baseAt` over four channels.
     */
    private _splatAt(gx: number, gz: number, out: [number, number, number, number]): void {
        const S = this._splatRes;
        const x = Math.min(Math.max(gx, 0), S - 1), z = Math.min(Math.max(gz, 0), S - 1);
        const c0 = Math.floor(x), r0 = Math.floor(z);
        const c1 = Math.min(c0 + 1, S - 1), r1 = Math.min(r0 + 1, S - 1);
        const fx = x - c0, fz = z - r0;
        const sp = this._splat;
        for (let k = 0; k < 4; k++) {
            const a = sp[(r0 * S + c0) * 4 + k] + (sp[(r0 * S + c1) * 4 + k] - sp[(r0 * S + c0) * 4 + k]) * fx;
            const b = sp[(r1 * S + c0) * 4 + k] + (sp[(r1 * S + c1) * 4 + k] - sp[(r1 * S + c0) * 4 + k]) * fx;
            out[k] = (a + (b - a) * fz) / 255;
        }
    }










    /**
     * Surface normal at a fractional grid coordinate, from central differences over the DISPLACED
     * surface at one vertex spacing.
     *
     * Separate from `_normalAt` rather than replacing it. `_normalAt` differences the grid array
     * directly with clamped neighbours, which is both cheaper and exactly what density 1 has always
     * done — and keeping it means the default terrain is bit-identical. This variant only runs when
     * there are vertices between grid points, where rounding to the nearest cell would give every
     * `density x density` block one normal and shade the terrain in facets.
     */
    private _normalAtGrid(gx: number, gz: number, at: (x: number, z: number) => number,
                          out: [number, number, number], density: number): void {
        const step = 1 / density;
        const e = this._element * step;
        const dhx = (at(gx + step, gz) - at(gx - step, gz)) / (2 * e);
        const dhz = (at(gx, gz + step) - at(gx, gz - step)) / (2 * e);
        const nx = -dhx, ny = 1, nz = -dhz;
        const len = Math.hypot(nx, ny, nz) || 1;
        out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    }

    /** Analytic (seamless) surface normal at grid indices via central differences. */
    private _normalAt(c: number, r: number, out: [number, number, number]): void {
        const R = this._R, e = this._element;
        const cl = Math.max(0, c - 1), cr = Math.min(R - 1, c + 1);
        const rd = Math.max(0, r - 1), ru = Math.min(R - 1, r + 1);
        const h = this._heights;
        const dhx = (h[r * R + cr] - h[r * R + cl]) / ((cr - cl) * e || e);
        const dhz = (h[ru * R + c] - h[rd * R + c]) / ((ru - rd) * e || e);
        const nx = -dhx, ny = 1, nz = -dhz;
        const len = Math.hypot(nx, ny, nz) || 1;
        out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    }

    // --- chunk geometry -----------------------------------------------------------------------

    private _buildChunks(): void {
        this._chunks = [];
        const quads = this._R - 1;
        const step = this._cfg.chunkQuads;
        for (let r0 = 0; r0 < quads; r0 += step) {
            for (let c0 = 0; c0 < quads; c0 += step) {
                const c1 = Math.min(c0 + step, quads);
                const r1 = Math.min(r0 + step, quads);
                const geometry = this._buildChunkGeometry(c0, r0, c1, r1);
                const chunk: TerrainChunk = {
                    model: new Model(geometry, this._material),
                    c0, r0, c1, r1, dirty: false,
                    minY: 0, maxY: 0, lod: 0, lodSteps: null,
                };
                this._updateChunkBounds(chunk);
                this._chunks.push(chunk);
            }
        }
    }

    /** Build a chunk geometry spanning global grid cols [c0..c1], rows [r0..r1] (vertices inclusive). */
    private _buildChunkGeometry(c0: number, r0: number, c1: number, r1: number): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const tangents: [number, number, number][] = [];
        const bitangents: [number, number, number][] = [];
        const indices: number[] = [];
        const half = this._cfg.size / 2, e = this._element, R = this._R;
        const cols = c1 - c0, rows = r1 - r0;
        const n: [number, number, number] = [0, 1, 0];

        // One vertex per height-grid point. A `density` multiplier used to subdivide this span so a
        // layer's height map could be evaluated between grid points and carried as real geometry; with
        // the bake gone the extra vertices carry no information a bilinear subdivision would not.
        for (let j = 0; j <= rows; j++) {
            const gz = r0 + j;
            for (let i = 0; i <= cols; i++) {
                const gx = c0 + i;
                positions.push([-half + gx * e, this._baseAt(gx, gz), -half + gz * e]);
                this._normalAt(gx, gz, n);
                normals.push([n[0], n[1], n[2]]);
                uvs.push([gx / (R - 1), gz / (R - 1)]);
                // UVs are axis-aligned (u -> +X, v -> +Z), so the tangent frame is constant. Must be
                // supplied explicitly: Geometry._calculateTangents mis-aligns tangents on indexed meshes.
                //
                // MINUS Z, and the sign is decidable only once the chart's handedness is stated. This
                // chart is LEFT-handed: `dP/du = +X`, `dP/dv = +Z`, `N = +Y`, so `dP/du x dP/dv = -N`.
                // `chunks/modelVarying.wgsl` negates the bitangent unconditionally, for the convention
                // mesh importers produce — so passing +Z landed `tbn[1]` on `-dP/dv`, and `addLayer`'s
                // plain `*2-1` normal decode then drove the shading normal AGAINST the direction v
                // increases. That is the green-channel flip: it renders every bump as a dent, in place,
                // wherever the normal map carries the relief rather than the vertices.
                //
                // Passing -Z makes the negation produce `B = +Z = dP/dv`, so the normal map finally
                // agrees with the chart AND with the height field the bake displaces by. `parallaxFrame`
                // is unaffected either way — it derives its own basis from `dpdx(fragPos)`.
                tangents.push([1, 0, 0]);
                bitangents.push([0, 0, -1]);
            }
        }
        const stride = cols + 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tl = r * stride + c, tr = tl + 1;
                const bl = (r + 1) * stride + c, br = bl + 1;
                indices.push(tl, bl, tr, tr, bl, br);
            }
        }
        return new Geometry(positions, normals, uvs, tangents, bitangents, indices);
    }





    /** Rewrite a chunk geometry's Y + normals in place from the current heights and flag it dirty. */
    private _refreshChunkGeometry(chunk: TerrainChunk): void {
        const g = chunk.model.geometry;
        const positions = g.positions, normals = g.normals;
        const R = this._R;
        const n: [number, number, number] = [0, 1, 0];
        let i = 0;

        // One vertex per height-grid point, straight off the sculpted field. This used to fork: a
        // density-1 fast path reading a baked `_renderHeights`, and a dense path that evaluated a
        // layer's height map BETWEEN grid points so the extra vertices carried an octave of it as real
        // geometry. Both are gone with the bake — terrain's shape is what was sculpted, and a layer's
        // relief is marched per fragment like any other material's.
        for (let r = chunk.r0; r <= chunk.r1; r++) {
            for (let c = chunk.c0; c <= chunk.c1; c++) {
                const i3 = i * 3;
                positions[i3 + 1] = this._heights[r * R + c];
                this._normalAt(c, r, n);
                normals[i3] = n[0]; normals[i3 + 1] = n[1]; normals[i3 + 2] = n[2];
                i++;
            }
        }

        this._updateChunkBounds(chunk);
        // `_updateChunkBounds` only feeds terrain LOD; the geometry's own cached bounding sphere/box
        // (and BVH) drive frustum culling and picking, and the loop above moved every vertex under it.
        g.invalidateBounds();
        chunk.dirty = true;
    }

    /** Refresh a chunk's terrain-local Y extent from the height grid (the Y half of its LOD-distance AABB). */
    private _updateChunkBounds(chunk: TerrainChunk): void {
        const R = this._R;
        let min = Infinity, max = -Infinity;
        for (let r = chunk.r0; r <= chunk.r1; r++) {
            for (let c = chunk.c0; c <= chunk.c1; c++) {
                const h = this._heights[r * R + c];
                if (h < min) min = h;
                if (h > max) max = h;
            }
        }
        chunk.minY = isFinite(min) ? min : 0;
        chunk.maxY = isFinite(max) ? max : 0;

        // No inflation. There used to be one here, because a displaced layer moved vertices above and
        // below the sculpted field — including BETWEEN grid points, which the loop above cannot see.
        // The drawn surface is the sculpted one again, so these bounds are exact.
    }

    private _markRegionDirty(cMin: number, rMin: number, cMax: number, rMax: number): void {
        for (const ch of this._chunks) {
            if (ch.c1 < cMin || ch.c0 > cMax || ch.r1 < rMin || ch.r0 > rMax) continue;
            this._refreshChunkGeometry(ch);
        }
        this._bodyDirty = true;
    }

    // --- level of detail ----------------------------------------------------------------------

    /**
     * Coarse index set for a chunk at the given vertex `step` (2/4/8), over the chunk's UNCHANGED
     * full-resolution vertex buffer: an LOD level decimates the triangulation, never the vertices.
     * The border ring stays at full resolution and is fan-stitched to the decimated interior, so
     * neighbours at different levels always agree on their shared edge without any bookkeeping.
     */
    public buildLodIndices(chunk: TerrainChunk, step: number): number[] {
        const { cols, rows, stride } = this._chunkSpan(chunk);
        // NOT scaled by the density, and that multiply was destroying the relief this whole feature
        // exists to produce.
        //
        // It made sense while density fell with distance: a LOD-1 chunk was BUILT at half the density,
        // so the index step had to scale for a level to mean the same visual decimation. Density is
        // uniform across the terrain now, so scaling multiplies a step that is already correct — at
        // density 4 the renderer's default `step1` of 2 became a vertex step of 8, which is COARSER
        // THAN THE HEIGHT GRID ITSELF, and `step2` of 4 became 16. Since `distance1` is 120 m and a
        // 200 m terrain is mostly beyond that, every chunk drew at a level that decimated away every
        // vertex between grid points — the entire sub-grid band. The border ring keeps its vertices,
        // so chunk edges stayed detailed while their interiors flattened.
        //
        // A level now decimates the DENSE mesh by `step`, which is what "level of detail" meant before
        // density existed: it removes the same FRACTION of triangles it always did, and level 1 at
        // density 4 lands on 0.78 m spacing rather than 3.1 m.
        const v = (i: number, j: number) => j * stride + i;
        const indices: number[] = [];

        // Too small to decimate (the stitching needs at least a 2x2 grid of coarse cells): stay full-res.
        if (step < 2 || cols < 2 * step || rows < 2 * step) {
            for (let j = 0; j < rows; j++)
                for (let i = 0; i < cols; i++)
                    indices.push(v(i, j), v(i, j + 1), v(i + 1, j), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1));
            return indices;
        }

        // Cell boundaries along each axis. The last cell absorbs the remainder when the chunk is not a
        // whole number of steps across.
        const cuts = (n: number): number[] => {
            const out: number[] = [];
            for (let x = 0; x < n; x += step) out.push(x);
            out.push(n);
            return out;
        };
        const cutsX = cuts(cols), cutsZ = cuts(rows);

        for (let b = 0; b < cutsZ.length - 1; b++) {
            for (let a = 0; a < cutsX.length - 1; a++) {
                const x0 = cutsX[a], x1 = cutsX[a + 1];
                const z0 = cutsZ[b], z1 = cutsZ[b + 1];
                const onBorder = x0 === 0 || x1 === cols || z0 === 0 || z1 === rows;
                if (!onBorder) {
                    // Interior: a plain quad, same winding as the full-res builder.
                    indices.push(v(x0, z0), v(x0, z1), v(x1, z0), v(x1, z0), v(x0, z1), v(x1, z1));
                    continue;
                }

                // Walk the cell's outline (x0,z0) -> (x0,z1) -> (x1,z1) -> (x1,z0), subdividing into single
                // grid steps every edge that lies on the chunk border so it keeps all its real vertices.
                const ring: number[] = [];
                const edge = (
                    fromI: number, fromJ: number, toI: number, toJ: number, subdivide: boolean,
                ) => {
                    ring.push(v(fromI, fromJ));
                    if (!subdivide) return;
                    const di = Math.sign(toI - fromI), dj = Math.sign(toJ - fromJ);
                    const n = Math.abs(toI - fromI) + Math.abs(toJ - fromJ);
                    for (let k = 1; k < n; k++) ring.push(v(fromI + di * k, fromJ + dj * k));
                };
                edge(x0, z0, x0, z1, x0 === 0);
                edge(x0, z1, x1, z1, z1 === rows);
                edge(x1, z1, x1, z0, x1 === cols);
                edge(x1, z0, x0, z0, z0 === 0);

                // Fan from the corner on no subdivided edge (the 2*step guard above guarantees one exists),
                // so no fan triangle degenerates onto a border edge.
                const xa = x0 === 0 ? x1 : x0;
                const za = z0 === 0 ? z1 : z0;
                const apex = ring.indexOf(v(xa, za));
                const n = ring.length;
                for (let k = 1; k <= n - 2; k++)
                    indices.push(ring[apex], ring[(apex + k) % n], ring[(apex + k + 1) % n]);
            }
        }
        return indices;
    }

    /** Detail level (0/1/2) for a chunk at this camera position, with hysteresis around the thresholds. */
    public lodFor(chunk: TerrainChunk, camPos: vec3, s: TerrainLodSettings): number {
        const half = this._cfg.size / 2, e = this._element;
        const minX = this._origin[0] - half + chunk.c0 * e, maxX = this._origin[0] - half + chunk.c1 * e;
        const minZ = this._origin[2] - half + chunk.r0 * e, maxZ = this._origin[2] - half + chunk.r1 * e;
        const minY = this._origin[1] + chunk.minY, maxY = this._origin[1] + chunk.maxY;
        // Distance to the closest point of the chunk's world AABB (0 when the camera is inside it).
        const dx = camPos[0] < minX ? minX - camPos[0] : (camPos[0] > maxX ? camPos[0] - maxX : 0);
        const dy = camPos[1] < minY ? minY - camPos[1] : (camPos[1] > maxY ? camPos[1] - maxY : 0);
        const dz = camPos[2] < minZ ? minZ - camPos[2] : (camPos[2] > maxZ ? camPos[2] - maxZ : 0);
        const d = Math.hypot(dx, dy, dz);

        let lod = 0;
        if (d >= s.distance2) lod = 2;
        else if (d >= s.distance1) lod = 1;
        // Refine only once comfortably inside the threshold, or a camera on a boundary flips a chunk's
        // triangulation every frame.
        if (lod < chunk.lod) {
            if (chunk.lod === 2 && d >= s.distance2 * 0.9) return 2;
            if (lod === 0 && d >= s.distance1 * 0.9) return 1;
        }
        return lod;
    }

    // --- editing ------------------------------------------------------------------------------

    /**
     * Apply a sculpt brush at a world-space point (dt-scaled). Returns true if any height changed.
     * Marks affected chunks dirty (the node re-uploads them) and the physics body for rebuild.
     */
    public sculpt(worldPoint: vec3, brush: SculptBrush, dt: number): boolean {
        const half = this._cfg.size / 2, e = this._element, R = this._R;
        const lx = worldPoint[0] - this._origin[0];
        const lz = worldPoint[2] - this._origin[2];
        const rad = brush.radius;
        const cMin = Math.max(0, Math.floor((lx - rad + half) / e));
        const cMax = Math.min(R - 1, Math.ceil((lx + rad + half) / e));
        const rMin = Math.max(0, Math.floor((lz - rad + half) / e));
        const rMax = Math.min(R - 1, Math.ceil((lz + rad + half) / e));
        if (cMin > cMax || rMin > rMax) return false;

        const amount = brush.strength * dt;
        const flatten = brush.flattenHeight ?? this.heightAt(lx, lz);
        let changed = false;

        // For smoothing, snapshot the region so neighbour averaging is order-independent.
        const snapshot = brush.mode === 'smooth' ? this._heights.slice() : null;

        for (let r = rMin; r <= rMax; r++) {
            for (let c = cMin; c <= cMax; c++) {
                const vx = -half + c * e, vz = -half + r * e;
                const d = Math.hypot(vx - lx, vz - lz);
                if (d > rad) continue;
                // Smooth falloff: 1 at centre, ->0 at edge (falloff controls softness).
                const t = d / rad;
                const w = brush.falloff <= 0 ? 1 : Math.pow(1 - t, brush.falloff * 3);
                const idx = r * R + c;
                let h = this._heights[idx];
                switch (brush.mode) {
                    case 'raise': h += amount * w; break;
                    case 'lower': h -= amount * w; break;
                    case 'flatten': h += (flatten - h) * Math.min(1, Math.abs(amount) * w); break;
                    case 'smooth': {
                        const s = snapshot!;
                        const cl = Math.max(0, c - 1), cr = Math.min(R - 1, c + 1);
                        const rd = Math.max(0, r - 1), ru = Math.min(R - 1, r + 1);
                        const avg = (s[r * R + cl] + s[r * R + cr] + s[rd * R + c] + s[ru * R + c] + s[idx]) / 5;
                        h += (avg - h) * Math.min(1, Math.abs(amount) * w);
                        break;
                    }
                }
                if (h !== this._heights[idx]) { this._heights[idx] = h; changed = true; }
            }
        }
        if (changed) this._markRegionDirty(cMin, rMin, cMax, rMax);
        return changed;
    }

    /** Fill this terrain's height field by resampling another terrain's surface (bilinear), stretching its
     *  shape to this grid. Used by "Update Terrain" to preserve sculpting across a size/resolution change. */
    public resampleHeightsFrom(other: Terrain): void {
        const R = this._R, oldSize = other.size;
        for (let r = 0; r < R; r++) {
            for (let c = 0; c < R; c++) {
                const fracX = R > 1 ? c / (R - 1) : 0;
                const fracZ = R > 1 ? r / (R - 1) : 0;
                this._heights[r * R + c] = other.heightAt((fracX - 0.5) * oldSize, (fracZ - 0.5) * oldSize);
            }
        }
        for (const ch of this._chunks) this._refreshChunkGeometry(ch);
        this._bodyDirty = true;
    }

    /**
     * Fill this terrain's splat map by resampling another terrain's (bilinear on RGBA, renormalized),
     * stretching the painted pattern to this grid. The companion to {@link resampleHeightsFrom}.
     */
    public resampleSplatFrom(other: Terrain): void {
        const S = this._splatRes, oS = other._splatRes, oSplat = other._splat;
        for (let r = 0; r < S; r++) {
            const fz = (S > 1 ? r / (S - 1) : 0) * (oS - 1);
            const z0 = Math.min(oS - 1, Math.floor(fz)), z1 = Math.min(oS - 1, z0 + 1), tz = fz - z0;
            for (let c = 0; c < S; c++) {
                const fx = (S > 1 ? c / (S - 1) : 0) * (oS - 1);
                const x0 = Math.min(oS - 1, Math.floor(fx)), x1 = Math.min(oS - 1, x0 + 1), tx = fx - x0;
                const i00 = (z0 * oS + x0) * 4, i10 = (z0 * oS + x1) * 4;
                const i01 = (z1 * oS + x0) * 4, i11 = (z1 * oS + x1) * 4;
                const out = (r * S + c) * 4;
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    const top = oSplat[i00 + k] + (oSplat[i10 + k] - oSplat[i00 + k]) * tx;
                    const bot = oSplat[i01 + k] + (oSplat[i11 + k] - oSplat[i01 + k]) * tx;
                    const v = top + (bot - top) * tz;
                    this._splat[out + k] = v;
                    sum += v;
                }
                // Renormalize to 255 so the shader's weight sum stays 1 after the interpolation.
                if (sum > 0) {
                    const s = 255 / sum;
                    for (let k = 0; k < 4; k++) this._splat[out + k] = Math.round(this._splat[out + k] * s);
                } else this._splat[out] = 255;
            }
        }
        this._splatTex.updateRegion(0, 0, S, S, this._splat);
    }

    /**
     * Re-place another terrain's scattered foliage onto this one, re-sampling Y from the new heights, so
     * hand-painted foliage survives a size/resolution change. Positions are normalized by size.
     */
    public resampleFoliageFrom(other: Terrain): void {
        const scale = other.size > 0 ? this._cfg.size / other.size : 1;
        const inst: number[] = [0, 0, 0, 0, 0];
        for (const src of other.foliage) {
            if (src.count === 0) continue;
            // Reuse this terrain's own layer for the same KEY when its material still declares the
            // rule, so prototypes stay linked; otherwise carry the source layer's prototype verbatim.
            let dst = this._foliageByKey.get(src.key);
            if (!dst) {
                dst = FoliageLayer.deserialize({ ...src.serialize(), instances: undefined });
                dst.key = src.key;
                this._foliageByKey.set(dst.key, dst);
                this._foliage.push(dst);
            }
            for (let i = 0; i < src.count; i++) {
                if (!src.instanceAt(i, inst)) continue;
                const lx = (inst[0] - other.origin[0]) * scale;
                const lz = (inst[2] - other.origin[2]) * scale;
                const y = this._origin[1] + this.heightAt(lx, lz);
                if (!dst.pushInstance(this._origin[0] + lx, y, this._origin[2] + lz)) break;
            }
            dst.commit();
        }
    }

    /** Replace the height field from a heightmap image's red channel, scaled to [0, amplitude]. */
    public async importHeightmap(path: string, amplitude: number): Promise<void> {
        const image = await Loader.ImageToArray(path);
        const R = this._R;
        for (let r = 0; r < R; r++) {
            for (let c = 0; c < R; c++) {
                const sx = Math.min(image.width - 1, Math.floor((c / (R - 1)) * (image.width - 1)));
                const sy = Math.min(image.height - 1, Math.floor((r / (R - 1)) * (image.height - 1)));
                const red = image.data[(sy * image.width + sx) * 4] / 255;
                this._heights[r * R + c] = red * amplitude;
            }
        }
        for (const ch of this._chunks) this._refreshChunkGeometry(ch);
        this._bodyDirty = true;
    }

    /** Render the current height field to a grayscale PNG data URL (normalized to its own min..max). */
    public exportHeightmap(): string {
        const R = this._R;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < this._heights.length; i++) {
            const h = this._heights[i];
            if (h < min) min = h;
            if (h > max) max = h;
        }
        if (!isFinite(min)) { min = 0; max = 0; }
        const span = (max - min) || 1;
        const canvas = document.createElement('canvas');
        canvas.width = R; canvas.height = R;
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(R, R);
        for (let i = 0; i < R * R; i++) {
            const v = Math.round(((this._heights[i] - min) / span) * 255);
            img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL('image/png');
    }

    // --- texture layers & painting ------------------------------------------------------------

    public get layers(): TerrainLayer[] { return this._layers; }
    public get splatId(): string { return this._splatId; }

    private _defaultLayer(): TerrainLayer {
        return {
            albedoId: null, aoId: null, normalId: null, heightId: null, dispScale: 0.05, invertHeight: false, displace: false, heightBlend: 0,
            color: [1, 1, 1], metallic: 0, roughness: 1,
            tiling: 20, auto: false, hRange: [0, 100], sRange: [0, 1],
            material: null, materialId: null,
        };
    }

    /** Read the per-layer surface (albedo/normal/height + scalar factors) out of a paint-layer
     *  material. The height map is terrain-specific and lives under `displacementMap` — the authoring
     *  key, kept for compatibility — for every base type. */
    private _deriveLayerSurface(tm: TerrainMaterial): {
        albedoId: string | null; aoId: string | null; normalId: string | null; heightId: string | null;
        dispScale: number; invertHeight: boolean; displace: boolean;
        heightBlend: number; color: number[]; metallic: number; roughness: number;
    } {
        const p = tm.properties, t = tm.textures, bt = tm.type as unknown as string;
        const heightId = t.get('displacementMap') ?? null;
        // The same key a standard PBR material uses, so a terrain layer picks up an occlusion map
        // through the material editor's existing Occlusion slot with nothing new to author.
        const aoId = t.get('occlusionMap') ?? null;
        const dispScale = tm.displacementScale;
        // CARRIED THROUGH UNCHANGED, and this used to be a negation.
        //
        // Terrain read the slot as a DEPTH map (white = deep) while every standard material read it as a
        // HEIGHT map, so `invertHeight` meant opposite things on the two paths and the same texture came
        // out inside-out depending on what it was applied to. That divergence was recorded as deliberate
        // "until that path is revisited" — it existed because terrain's relief was geometry, which only
        // ADDS, while a parallax march only CARVES, so the two needed opposite reference planes.
        //
        // Terrain marches now, like everything else, so there is one reference plane and one meaning.
        // Existing terrain materials flip on load, which is the point: the old appearance was the bug.
        const invertHeight = tm.invertHeight;
        // A layer has relief exactly when it has a height map. No mode to read.
        const displace = !!heightId;
        const heightBlend = tm.heightBlend;
        if (bt === 'basic') {
            return {
                albedoId: t.get('texture') ?? null, aoId, normalId: null, heightId, dispScale, invertHeight, displace, heightBlend,
                color: p.get('color') ?? [1, 1, 1], metallic: 0, roughness: 1,
            };
        }
        if (bt === 'pbr') {
            return {
                albedoId: t.get('baseColorTexture') ?? null,
                aoId,
                normalId: t.get('normalMap') ?? null,
                heightId, dispScale, invertHeight, displace, heightBlend,
                color: p.get('baseColor') ?? [1, 1, 1],
                metallic: p.get('metallic') ?? 0,
                roughness: p.get('roughness') ?? 1,
            };
        }
        // blinn_phong
        return {
            albedoId: t.get('baseTexture') ?? null,
            aoId,
            normalId: t.get('normalMap') ?? null,
            heightId, dispScale, invertHeight, displace, heightBlend,
            color: p.get('diffuse') ?? [1, 1, 1],
            metallic: 0, roughness: 0.7,
        };
    }

    /**
     * Combine a layer's normal map and height map into the single packed texture bound at
     * `u_normal{index}`: rgb = tangent-space normal, a = height. Source textures decode asynchronously,
     * so a pack that cannot resolve yet leaves the layer without normal/height this frame and is retried
     * by {@link syncPackedLayers}; `Renderer._applyTerrainMaterial` binds a fallback to every layer
     * sampler, so an empty slot cannot leave one unbound.
     */
    private _syncLayerPack(index: number, L: TerrainLayer, frame: number): void {
        const m = this._material;
        const clear = () => {
            m.textures.delete(`u_normal${index}`);
            m.properties.set(`u_hasNormal${index}`, 0);
            m.properties.set(`u_hasHeight${index}`, 0);
        };
        if (!L.normalId && !L.heightId) { clear(); return; }

        const id = TexturePacker.Instance.resolve({
            // A flat tangent-space normal where there is no normal map. `ignored` so a layer with only a
            // normal map takes the packer's identity path and reuses that texture untouched.
            r: L.normalId ? { textureId: L.normalId, channel: 0 } : { constant: 0.5, ignored: true },
            g: L.normalId ? { textureId: L.normalId, channel: 1 } : { constant: 0.5, ignored: true },
            b: L.normalId ? { textureId: L.normalId, channel: 2 } : { constant: 1.0, ignored: true },
            a: L.heightId ? { textureId: L.heightId, channel: 0 } : { constant: 0.0, ignored: true },
            // REPEAT, stated rather than inherited. A layer is sampled at `baseUv * u_tiling{i}` with
            // tiling typically 20-50; a clamped pack would show one instance in the first tile and a
            // stretched edge texel over the whole rest of the terrain, so the normal and height would
            // appear tens of times larger than the albedo beside them, which repeats.
            wrapping: 'repeat',
        }, frame);

        if (!id) { clear(); return; }
        m.textures.set(`u_normal${index}`, id);
        m.properties.set(`u_hasNormal${index}`, L.normalId ? 1 : 0);
        // `u_hasHeight{i}` gates BOTH the march and the height-aware layer blend, so it tracks whether
        // the layer has a height map and nothing else. Clearing it to change what the march does is the
        // obvious move and silently switches a separate feature off.
        m.properties.set(`u_hasHeight${index}`, L.heightId ? 1 : 0);
    }

    /** Re-resolve every layer's packed normal+height texture. Called once per frame by the renderer, to
     *  pick up layers whose maps had not finished decoding when they were assigned. */
    public syncPackedLayers(frame: number): void {
        for (let i = 0; i < this._layers.length && i < 4; i++) {
            this._syncAlbedoPack(i, this._layers[i], frame);
            this._syncLayerPack(i, this._layers[i], frame);
        }
    }

    /**
     * Albedo (rgb) + ambient occlusion (a), packed into `u_albedo{i}`.
     *
     * The twin of {@link _syncLayerPack}, and it exists for the same reason: terrain's layer samplers
     * occupy units 0-8, so a fifth per-layer texture is not available at any price. Folding height
     * into the normal map's unused alpha is what took terrain from 13 units to 9; folding occlusion
     * into the albedo's unused alpha is the same move, and it is why terrain AO turned out not to
     * need a G-buffer change at all — `gEmissiveAO.a` was always there, terrain simply had nothing
     * to put in it.
     */
    private _syncAlbedoPack(index: number, L: TerrainLayer, frame: number): void {
        const m = this._material;
        const clear = () => {
            m.textures.delete(`u_albedo${index}`);
            m.properties.set(`u_hasAlbedo${index}`, 0);
            m.properties.set(`u_hasAO${index}`, 0);
        };
        if (!L.albedoId && !L.aoId) { clear(); return; }

        const id = TexturePacker.Instance.resolve({
            // White where there is no albedo map: the layer tint is applied on top either way, so a
            // layer with only an occlusion map still reads as its authored colour.
            r: L.albedoId ? { textureId: L.albedoId, channel: 0 } : { constant: 1.0, ignored: true },
            g: L.albedoId ? { textureId: L.albedoId, channel: 1 } : { constant: 1.0, ignored: true },
            b: L.albedoId ? { textureId: L.albedoId, channel: 2 } : { constant: 1.0, ignored: true },
            a: L.aoId ? { textureId: L.aoId, channel: 0 } : { constant: 1.0, ignored: true },
            // REPEAT for the same reason the normal pack states it — see there.
            wrapping: 'repeat',
        }, frame);

        if (!id) { clear(); return; }
        m.textures.set(`u_albedo${index}`, id);
        m.properties.set(`u_hasAlbedo${index}`, L.albedoId ? 1 : 0);
        m.properties.set(`u_hasAO${index}`, L.aoId ? 1 : 0);
    }

    /** Push a resolved layer's surface + blend uniforms into the composite terrain material. */
    private _writeLayerUniforms(index: number, L: TerrainLayer): void {
        const m = this._material;
        const setTex = (key: string, id: string | null, hasKey: string) => {
            if (id) { m.textures.set(key, id); m.properties.set(hasKey, 1); }
            else { m.textures.delete(key); m.properties.set(hasKey, 0); }
        };
        // Albedo and AO share one packed texture, exactly as normal and height do below. The alpha
        // channel was free — `addLayer` only ever sampled `.rgb` — so terrain gains an occlusion map
        // for ZERO extra texture units, which is the constraint that made this look blocked. With no
        // AO map the packer takes its identity path and reuses the albedo texture untouched.
        this._syncAlbedoPack(index, L, 0);
        // Normal and height share one packed texture; it may not be bakeable yet (its sources decode
        // asynchronously), so syncPackedLayers owns both slots and retries per frame.
        this._syncLayerPack(index, L, 0);
        m.properties.set(`u_color${index}`, [L.color[0], L.color[1], L.color[2]]);
        m.properties.set(`u_metallic${index}`, L.metallic);
        m.properties.set(`u_roughness${index}`, L.roughness);
        // THE SWITCH. Zero here is what turns terrain relief off: `marchTerrain` early-returns on a
        // zero blended depth, so the ray, its self-shadow and every per-step fetch stop with it. The
        // height map itself is untouched — it still packs, and `u_hasHeight{i}` still drives the
        // height-aware blend, which is a separate feature that must not go with it.
        //
        // The authored value's unit, for when this comes back: the layer's own TILED uv, exactly as a
        // standard material's `dispScale` is authored in its own uv. `blendedDepth` divides by the
        // tiling to reach the base uv the ray travels in.
        m.properties.set(`u_dispScale${index}`, TERRAIN_RELIEF_ENABLED ? L.dispScale : 0);
        m.properties.set(`u_invertHeight${index}`, L.invertHeight ? 1 : 0);
        m.properties.set(`u_heightBlend${index}`, L.heightBlend);
        m.properties.set(`u_tiling${index}`, L.tiling);
        m.properties.set(`u_auto${index}`, L.auto ? 1 : 0);
        m.properties.set(`u_hRange${index}`, [L.hRange[0], L.hRange[1]]);
        m.properties.set(`u_sRange${index}`, [L.sRange[0], L.sRange[1]]);
    }



    /** A layer contributes vertex relief exactly when it has a height map and a non-zero depth. */
    private _layerDisplaces(L: TerrainLayer): boolean {
        return !!(L.displace && L.heightId && L.dispScale !== 0);
    }

    /**
     * Configure a layer slot (0..3) and push its uniforms/textures into the composite terrain material.
     * @param source A {@link TerrainMaterial}, or a legacy `{ textureId, tiling, auto, ... }` object read
     *               as a plain Basic albedo. Null/undefined keeps the current surface.
     * @param opts Overrides for the blend params (tiling/auto/hRange/sRange) and the linked `materialId`.
     */
    public setLayer(index: number, source?: TerrainMaterial | Partial<TerrainLayer> | null, opts: Partial<TerrainLayer> = {}): void {
        if (index < 0 || index > 3) return;
        while (this._layers.length <= index) this._layers.push(this._defaultLayer());
        const L = this._layers[index];

        if (source instanceof TerrainMaterial) {
            const s = this._deriveLayerSurface(source);
            L.material = source; L.materialId = null;
            L.albedoId = s.albedoId; L.aoId = s.aoId; L.normalId = s.normalId; L.heightId = s.heightId;
            L.dispScale = s.dispScale; L.invertHeight = s.invertHeight; L.heightBlend = s.heightBlend;
            L.displace = s.displace;
            L.color = s.color; L.metallic = s.metallic; L.roughness = s.roughness;
            L.tiling = source.tiling; L.auto = source.auto;
            L.hRange = [source.hRange[0], source.hRange[1]];
            L.sRange = [source.sRange[0], source.sRange[1]];
        } else if (source && 'textureId' in source) {
            // Legacy plain-albedo layer (old scenes / basic texture pick).
            L.material = null; L.materialId = null;
            L.albedoId = source.textureId ?? null;
            L.aoId = null;
            L.normalId = null; L.heightId = null;
            L.dispScale = 0.05; L.invertHeight = false; L.heightBlend = 0; L.displace = false;
            L.color = [1, 1, 1]; L.metallic = 0; L.roughness = 1;
            if (source.tiling !== undefined) L.tiling = source.tiling;
            if (source.auto !== undefined) L.auto = source.auto;
            if (source.hRange) L.hRange = [source.hRange[0], source.hRange[1]];
            if (source.sRange) L.sRange = [source.sRange[0], source.sRange[1]];
        }
        // else: keep existing surface/material; only opts below take effect.

        if (opts.tiling !== undefined) L.tiling = opts.tiling;
        if (opts.auto !== undefined) L.auto = opts.auto;
        if (opts.hRange) L.hRange = [opts.hRange[0], opts.hRange[1]];
        if (opts.sRange) L.sRange = [opts.sRange[0], opts.sRange[1]];
        if (opts.materialId !== undefined) L.materialId = opts.materialId;

        this._writeLayerUniforms(index, L);
        this._syncLayerUniforms();
    }

    /** Clear a layer slot (0..3): drop its material/surface and its composite uniforms. */
    public clearLayer(index: number): void {
        if (index < 0 || index > 3 || index >= this._layers.length) return;
        this._layers[index] = this._defaultLayer();
        this._writeLayerUniforms(index, this._layers[index]);
        this._syncLayerUniforms();
    }

    private _layerActive(L: TerrainLayer | undefined): boolean {
        return !!L && (!!L.material || !!L.albedoId);
    }

    private _syncLayerUniforms(): void {
        let count = 0;
        for (let i = 0; i < this._layers.length; i++) if (this._layerActive(this._layers[i])) count = i + 1;
        this._material.properties.set('u_layerCount', count);
        let useAuto = 0;
        for (const L of this._layers) if (L?.auto) useAuto = 1;
        this._material.properties.set('u_useAuto', useAuto);
    }

    /**
     * Paint the active layer's weight into the splat map at a world point (dt-scaled), renormalizing the
     * four channel weights to sum to 1, then upload the dirty sub-rectangle. Returns true if anything changed.
     */
    public paint(worldPoint: vec3, brush: PaintBrush, dt: number): boolean {
        const layer = brush.layer;
        if (layer < 0 || layer > 3) return false;
        const S = this._splatRes, half = this._cfg.size / 2, e = this._cfg.size / (S - 1);
        const lx = worldPoint[0] - this._origin[0], lz = worldPoint[2] - this._origin[2];
        const rad = brush.radius;
        const cMin = Math.max(0, Math.floor((lx - rad + half) / e));
        const cMax = Math.min(S - 1, Math.ceil((lx + rad + half) / e));
        const rMin = Math.max(0, Math.floor((lz - rad + half) / e));
        const rMax = Math.min(S - 1, Math.ceil((lz + rad + half) / e));
        if (cMin > cMax || rMin > rMax) return false;

        const gain = Math.min(1, brush.strength * dt);
        const ch = [0, 0, 0, 0];
        let changed = false;
        for (let r = rMin; r <= rMax; r++) {
            for (let c = cMin; c <= cMax; c++) {
                const vx = -half + c * e, vz = -half + r * e;
                const d = Math.hypot(vx - lx, vz - lz);
                if (d > rad) continue;
                const t = d / rad;
                const w = brush.falloff <= 0 ? 1 : Math.pow(1 - t, brush.falloff * 3);
                const add = gain * w;
                const idx = (r * S + c) * 4;
                ch[0] = this._splat[idx] / 255; ch[1] = this._splat[idx + 1] / 255;
                ch[2] = this._splat[idx + 2] / 255; ch[3] = this._splat[idx + 3] / 255;
                ch[layer] = ch[layer] + (1 - ch[layer]) * add;
                const remaining = 1 - ch[layer];
                const othersSum = ch[0] + ch[1] + ch[2] + ch[3] - ch[layer];
                if (othersSum > 1e-5) {
                    const scale = remaining / othersSum;
                    for (let k = 0; k < 4; k++) if (k !== layer) ch[k] *= scale;
                }
                this._splat[idx] = Math.round(ch[0] * 255); this._splat[idx + 1] = Math.round(ch[1] * 255);
                this._splat[idx + 2] = Math.round(ch[2] * 255); this._splat[idx + 3] = Math.round(ch[3] * 255);
                changed = true;
            }
        }
        if (changed) {
            const w = cMax - cMin + 1, h = rMax - rMin + 1;
            const sub = new Uint8Array(w * h * 4);
            for (let r = 0; r < h; r++) {
                const srcStart = ((rMin + r) * S + cMin) * 4;
                sub.set(this._splat.subarray(srcStart, srcStart + w * 4), r * w * 4);
            }
                this._splatTex.updateRegion(cMin, rMin, w, h, sub);
        }
        return changed;
    }

    // --- foliage ------------------------------------------------------------------------------

    public get foliage(): FoliageLayer[] { return this._foliage; }

    public addFoliage(layer: FoliageLayer): FoliageLayer { this._foliage.push(layer); return layer; }

    private _heightSampler = (wx: number, wz: number): number =>
        this._origin[1] + this.heightAt(wx - this._origin[0], wz - this._origin[2]);

    /** Scatter foliage instances for a layer at a world point. */
    public scatterFoliage(index: number, worldPoint: vec3, radius: number): boolean {
        const layer = this._foliage[index];
        if (!layer) return false;
        return layer.scatter(worldPoint[0], worldPoint[2], radius, this._heightSampler);
    }

    /** Erase foliage instances for a layer near a world point. */
    public eraseFoliage(index: number, worldPoint: vec3, radius: number): boolean {
        const layer = this._foliage[index];
        if (!layer) return false;
        return layer.erase(worldPoint[0], worldPoint[2], radius);
    }

    /** Nearest-texel RGBA splat weights (0..1) at a terrain-local point, matching paint()'s mapping. */
    public sampleSplat(localX: number, localZ: number, out: [number, number, number, number]): void {
        const S = this._splatRes, half = this._cfg.size / 2, e = this._cfg.size / (S - 1);
        let c = Math.round((localX + half) / e);
        let r = Math.round((localZ + half) / e);
        c = Math.max(0, Math.min(S - 1, c));
        r = Math.max(0, Math.min(S - 1, r));
        const idx = (r * S + c) * 4;
        out[0] = this._splat[idx] / 255; out[1] = this._splat[idx + 1] / 255;
        out[2] = this._splat[idx + 2] / 255; out[3] = this._splat[idx + 3] / 255;
    }

    /** Every foliage prototype contributed by an assigned layer material, tagged with its layer index. */
    private _activeFoliageRules(): { rule: TerrainFoliageRule; layerIndex: number }[] {
        const out: { rule: TerrainFoliageRule; layerIndex: number }[] = [];
        for (let i = 0; i < this._layers.length; i++) {
            const m = this._layers[i]?.material;
            if (!m) continue;
            for (const rule of m.foliageInclude) out.push({ rule, layerIndex: i });
        }
        return out;
    }

    /** True if any layer present (weight above threshold) at this point excludes the named foliage. */
    private _foliageExcludedAt(name: string, splat: [number, number, number, number]): boolean {
        for (let k = 0; k < 4; k++) {
            if (splat[k] < 0.15) continue;
            const m = this._layers[k]?.material;
            if (m && m.foliageExclude.includes(name)) return true;
        }
        return false;
    }

    /**
     * The layer already filed for this rule, migrating one still filed under the pre-key scheme.
     *
     * The migration is the whole point of looking up in two steps. Every layer saved before rules had
     * stable keys is filed under the rule's NAME, so resolving only by key would miss it, build a
     * second layer, and strand the user's scattered instances in the first — the exact failure the
     * re-key exists to prevent, caused by the re-key itself.
     *
     * One case it cannot rescue: a rule renamed BEFORE this change already lost its layer, because
     * neither the new key nor the new name matches what that layer was filed under. Nothing here can
     * recover an association that was never recorded.
     */
    private _findFoliageLayer(rule: TerrainFoliageRule): FoliageLayer | undefined {
        const key = foliageRuleKey(rule);
        let layer = this._foliageByKey.get(key);
        if (!layer && key !== rule.name) {
            layer = this._foliageByKey.get(rule.name);
            if (layer) {
                this._foliageByKey.delete(rule.name);
                layer.key = key;
                this._foliageByKey.set(key, layer);
            }
        }
        // A rename is now just a display change: the layer was found by a key the name has no part in.
        if (layer && layer.name !== rule.name) layer.name = rule.name;
        return layer;
    }

    /** Lazily create (or reuse) the runtime foliage layer for a prototype. */
    private _resolveFoliageLayer(rule: TerrainFoliageRule): FoliageLayer {
        let layer = this._findFoliageLayer(rule);
        if (!layer) {
            layer = FoliageLayer.fromRule(rule);
            this._foliageByKey.set(layer.key, layer);
            this._foliage.push(layer);
        }
        return layer;
    }

    /**
     * Re-derive every active foliage layer's prototypes (LOD models, billboard impostor, cull distance,
     * scatter params) from its current rule, PRESERVING the scattered instances.
     *
     * `rescatterOnDensityChange` is the one opt-in that can discard placement, and only for a layer
     * whose rule density actually moved — see regenerateFoliageForRule. Callers propagating an asset
     * edit pass it; callers restoring a scene do not, because nothing changed there to warrant it.
     * An empty layer is never scattered into: that is generateFoliageEverywhere's job, and the
     * `skipAutoGenerate` contract exists precisely to keep an edit from populating a bare terrain.
     */
    public refreshFoliagePrototypes(opts?: { rescatterOnDensityChange?: boolean }): void {
        for (const { rule } of this._activeFoliageRules()) {
            const layer = this._findFoliageLayer(rule);
            if (!layer) continue;
            const had = layer.count;
            const { densityChanged } = layer.setPrototype(rule);
            if (densityChanged && opts?.rescatterOnDensityChange && had > 0)
                this.regenerateFoliageForRule(rule);
        }
    }

    /**
     * Material-driven foliage scatter: for each foliage prototype an assigned layer material includes,
     * place instances (density-controlled) at random disc points where that layer is the dominant one
     * in the splat — skipping any point where a present material excludes that prototype. Instances go
     * into per-prototype runtime layers (created lazily) so the renderer's foliage pass draws them.
     */
    public scatterFoliageFromMaterials(worldPoint: vec3, radius: number): boolean {
        const rules = this._activeFoliageRules();
        if (rules.length === 0) return false;
        const wx = worldPoint[0], wz = worldPoint[2];
        const splat: [number, number, number, number] = [0, 0, 0, 0];
        const touched = new Set<FoliageLayer>();
        const area = Math.PI * radius * radius;
        for (const { rule, layerIndex } of rules) {
            // density is per m², so a wide brush scatters proportionally more. Capped: this runs from a
            // pointer handler and a 100-unit brush at grass density is >60k candidate points.
            const count = Math.min(MAX_SCATTER_PER_CALL,
                Math.max(1, Math.round((rule.density ?? DEFAULT_FOLIAGE_DENSITY.mesh) * area)));
            for (let i = 0; i < count; i++) {
                const a = Math.random() * Math.PI * 2;
                const rr = Math.sqrt(Math.random()) * radius;
                const px = wx + Math.cos(a) * rr;
                const pz = wz + Math.sin(a) * rr;
                this.sampleSplat(px - this._origin[0], pz - this._origin[2], splat);
                // Place only where this rule's own layer dominates, and nowhere a present material excludes it.
                let dom = -1, best = 0;
                for (let k = 0; k < 4; k++) if (splat[k] > best) { best = splat[k]; dom = k; }
                if (dom !== layerIndex || best < 1e-3) continue;
                if (this._foliageExcludedAt(rule.name, splat)) continue;
                const y = this._origin[1] + this.heightAt(px - this._origin[0], pz - this._origin[2]);
                const layer = this._resolveFoliageLayer(rule);
                layer.pushInstance(px, y, pz);
                touched.add(layer);
            }
        }
        for (const l of touched) l.commit();
        return touched.size > 0;
    }

    /** Erase foliage instances of every layer near a world point (the material-driven erase brush). */
    public eraseAllFoliage(worldPoint: vec3, radius: number): boolean {
        let any = false;
        for (const layer of this._foliage) if (layer.erase(worldPoint[0], worldPoint[2], radius)) any = true;
        return any;
    }

    /** Erase foliage near a world point EXCEPT layers whose name is in keepNames. */
    public eraseFoliageExcept(worldPoint: vec3, radius: number, keepNames: string[]): boolean {
        let any = false;
        for (const layer of this._foliage) {
            if (keepNames.includes(layer.name)) continue;
            if (layer.erase(worldPoint[0], worldPoint[2], radius)) any = true;
        }
        return any;
    }

    /** Fraction (0..1) of splat texels where layer `index` is the dominant channel. */
    public layerCoverage(index: number): number {
        if (index < 0 || index > 3) return 0;
        const S = this._splatRes;
        let count = 0;
        const total = S * S;
        for (let i = 0; i < total; i++) {
            const b = i * 4;
            let dom = 0, best = this._splat[b];
            for (let k = 1; k < 4; k++) if (this._splat[b + k] > best) { best = this._splat[b + k]; dom = k; }
            if (dom === index) count++;
        }
        return total > 0 ? count / total : 0;
    }

    /**
     * Regenerate material-driven foliage across the ENTIRE terrain: for each foliage prototype an
     * assigned layer material includes, scatter `density * area` jittered points over the whole surface,
     * placing where that rule's layer dominates and no present material excludes it. Existing instances
     * must only be wiped once there is something to replace them with.
     */
    public generateFoliageEverywhere(): FoliageGenerateResult {
        const rules = this._activeFoliageRules();
        if (rules.length === 0)
            return { placed: 0, layers: 0, cleared: 0, reason: 'no-rules' };

        let cleared = 0;
        for (const layer of this._foliage) { cleared += layer.count; layer.clear(); }

        const half = this._cfg.size / 2, size = this._cfg.size;
        const splat: [number, number, number, number] = [0, 0, 0, 0];
        const touched = new Set<FoliageLayer>();
        let placed = 0, clipped = false;
        for (const { rule, layerIndex } of rules) {
            const r = this._scatterRule(rule, layerIndex, splat);
            placed += r.placed;
            if (r.clipped) clipped = true;
            if (r.layer) touched.add(r.layer);
        }
        for (const l of this._foliage) l.commit();
        this.pruneFoliage();
        return {
            placed,
            layers: touched.size,
            cleared,
            reason: placed === 0 ? 'no-coverage' : clipped ? 'clipped' : undefined,
        };
    }

    /**
     * Scatter ONE rule over the whole terrain, wherever its paint layer is dominant. Does not commit —
     * the caller batches that, because a full generate touches every layer.
     *
     * Extracted so a single rule can be re-scattered on its own (see regenerateFoliageForRule); the
     * body is what generateFoliageEverywhere always ran per rule.
     */
    private _scatterRule(rule: TerrainFoliageRule, layerIndex: number,
                         splat: [number, number, number, number]): { placed: number; clipped: boolean; layer: FoliageLayer | null } {
        const half = this._cfg.size / 2, size = this._cfg.size;
        // density is instances per m² — the same unit the brush uses.
        const count = Math.max(1, Math.round((rule.density ?? DEFAULT_FOLIAGE_DENSITY.mesh) * size * size));
        let placed = 0, clipped = false, layer: FoliageLayer | null = null;
        for (let i = 0; i < count; i++) {
            const lx = -half + Math.random() * size;
            const lz = -half + Math.random() * size;
            this.sampleSplat(lx, lz, splat);
            let dom = -1, best = 0;
            for (let k = 0; k < 4; k++) if (splat[k] > best) { best = splat[k]; dom = k; }
            if (dom !== layerIndex || best < 1e-3) continue;
            if (this._foliageExcludedAt(rule.name, splat)) continue;
            const y = this._origin[1] + this.heightAt(lx, lz);
            layer = this._resolveFoliageLayer(rule);
            if (!layer.pushInstance(this._origin[0] + lx, y, this._origin[2] + lz)) { clipped = true; break; }
            placed++;
        }
        return { placed, clipped, layer };
    }

    /**
     * Re-scatter a single rule's layer from scratch, discarding its current instances.
     *
     * Only density warrants this. Everything else about a rule — geometry, material, LODs, impostor,
     * cull distance — is absorbed by setPrototype with the placement left intact, and re-scattering
     * for those would throw away hand-painted foliage for no visual gain. Density is different: it
     * says how many instances should exist, and the existing ones cannot answer for a new number.
     */
    public regenerateFoliageForRule(rule: TerrainFoliageRule): number {
        const key = foliageRuleKey(rule);
        const entry = this._activeFoliageRules().find(r => foliageRuleKey(r.rule) === key);
        if (!entry) return 0;
        const layer = this._findFoliageLayer(entry.rule);
        if (!layer) return 0;
        layer.clear();
        const splat: [number, number, number, number] = [0, 0, 0, 0];
        const r = this._scatterRule(entry.rule, entry.layerIndex, splat);
        layer.commit();
        return r.placed;
    }

    /**
     * Drop empty runtime foliage layers no active rule names any more, e.g. the residue of a renamed
     * rule. Layers that still hold instances survive.
     */
    public pruneFoliage(): number {
        // Keys, not names: a renamed rule's layer is the same layer, and collecting it as "no rule
        // names this any more" is what used to leave a duplicate behind.
        const live = new Set(this._activeFoliageRules().map(r => foliageRuleKey(r.rule)));
        let removed = 0;
        for (let i = this._foliage.length - 1; i >= 0; i--) {
            const layer = this._foliage[i];
            if (live.has(layer.key) || layer.count > 0) continue;
            layer.dispose();
            this._foliage.splice(i, 1);
            if (this._foliageByKey.get(layer.key) === layer) this._foliageByKey.delete(layer.key);
            removed++;
        }
        return removed;
    }

    // --- picking ------------------------------------------------------------------------------

    /**
     * Analytic ray march against the terrain surface. `origin`/`dir` are world space; returns the
     * world-space hit point or null. Independent of the physics step, so it works in the editor.
     */
    public raycast(origin: vec3, dir: vec3, maxDistance = 10000): vec3 | null {
        const step = this._element * 0.5;
        let prevT = 0;
        let prevDiff = origin[1] - (this._origin[1] + this.heightAt(origin[0] - this._origin[0], origin[2] - this._origin[2]));
        for (let t = step; t <= maxDistance; t += step) {
            const px = origin[0] + dir[0] * t;
            const py = origin[1] + dir[1] * t;
            const pz = origin[2] + dir[2] * t;
            const surf = this._origin[1] + this.heightAt(px - this._origin[0], pz - this._origin[2]);
            const diff = py - surf;
            if (diff <= 0 && prevDiff > 0) {
                // Crossed the surface between prevT and t: linear-interpolate the crossing.
                const f = prevDiff / (prevDiff - diff);
                const ht = prevT + (t - prevT) * f;
                const hx = origin[0] + dir[0] * ht, hy = origin[1] + dir[1] * ht, hz = origin[2] + dir[2] * ht;
                // Reject crossings outside the terrain footprint (where heightAt clamps to 0).
                const half = this._cfg.size / 2;
                if (Math.abs(hx - this._origin[0]) <= half && Math.abs(hz - this._origin[2]) <= half)
                    return vec3.fromValues(hx, hy, hz);
            }
            prevT = t; prevDiff = diff;
        }
        return null;
    }

    // --- physics ------------------------------------------------------------------------------

    /** Build the cannon-es data grid (data[i][j], i along +X, j along -Z after the body rotation). */
    private _heightfieldData(): number[][] {
        const R = this._R, data: number[][] = new Array(R);
        for (let i = 0; i < R; i++) {
            const col = new Array(R);
            for (let j = 0; j < R; j++) col[j] = this._heights[(R - 1 - j) * R + i];
            data[i] = col;
        }
        return data;
    }

    /**
     * Create/refresh the static Heightfield body and register it with the world (self-heals).
     * @param material The surface the terrain collides as. Required even though terrain has no friction
     *                 settings of its own: cannon only honors a ContactMaterial when BOTH bodies carry a
     *                 material. Kept on the instance so a sculpt rebuild re-applies it.
     */
    public ensureRegistered(world: World, material?: PhysicsMaterial): void {
        this._world = world;
        if (material) this._physicsMaterial = material;
        if (!this._body) {
            const shape = new Heightfield(this._heightfieldData(), { elementSize: this._element });
            const body = new Body({ mass: 0, material: this._physicsMaterial ?? undefined });
            body.addShape(shape);
            body.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // field XY (Z up) -> world XZ (Y up)
            const half = this._cfg.size / 2;
            body.position.set(this._origin[0] - half, this._origin[1], this._origin[2] + half);
            this._body = body;
            world.addBody(body);
            this._bodyDirty = false;
            this._lastBodyBuild = Date.now();
            return;
        }
        if (this._physicsMaterial && this._body.material !== this._physicsMaterial) this._body.material = this._physicsMaterial;
        if (world.bodies.indexOf(this._body) === -1) world.addBody(this._body);
        // Rebuild at most a few times per second so a continuous sculpt drag doesn't rebuild every frame.
        if (this._bodyDirty && Date.now() - this._lastBodyBuild > 200) this._rebuildBody();
    }

    /**
     * Refresh the pooled static colliders around `camPos` for collidable foliage. Driven once per step by
     * PhysicsSystem, so colliders only exist in play mode, never while authoring.
     */
    public updateFoliageColliders(world: World, camPos: vec3 | null, material?: PhysicsMaterial): void {
        if (!this.foliageColliders.enabled && !this._colliders) return;
        if (!this._colliders) this._colliders = new FoliageColliderField();
        this._colliders.update(world, this._foliage, camPos, this._origin,
            material ?? this._physicsMaterial, this.foliageColliders);
    }

    /** Bodies the foliage collider pool currently has in the world (0 when disabled or in the editor). */
    public get foliageColliderCount(): number { return this._colliders?.activeCount ?? 0; }

    private _rebuildBody(): void {
        if (!this._world || !this._body) return;
        try {
            this._world.removeBody(this._body);
            const shape = new Heightfield(this._heightfieldData(), { elementSize: this._element });
            const body = new Body({ mass: 0, material: this._physicsMaterial ?? undefined });
            body.addShape(shape);
            body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
            const half = this._cfg.size / 2;
            body.position.set(this._origin[0] - half, this._origin[1], this._origin[2] + half);
            this._body = body;
            this._world.addBody(body);
            this._bodyDirty = false;
            this._lastBodyBuild = Date.now();
        } catch (e) {
            Logger.error((e as Error).toString(), 'Terrain');
        }
    }

    /**
     * Release every GPU/physics resource this terrain owns. Must stay idempotent: PhysicsSystem calls it
     * once per frame for a landscape flagged `markForRemoval` until the node leaves the scene.
     */
    public dispose(world?: World): void {
        if (this._disposed) return;
        this._disposed = true;
        const w = world || this._world;
        if (w && this._body) w.removeBody(this._body);
        this._body = null;
        this._colliders?.dispose(w ?? undefined);
        this._colliders = null;
        // Foliage cell buffers reach the renderer through the module-level orphan queue: the foliage
        // pass only walks LIVE landscapes to drain collectStaleBuffers().
        for (const layer of this._foliage) layer.dispose();
        this._foliage = [];
        this._foliageByKey.clear();
        for (const ch of this._chunks) ch.model.mesh.dispose();
        this._chunks = [];
        // The splat texture is exclusively ours (built in the constructor under a synthetic id), so it is
        // safe to free the GL object too; removeTexture alone only drops the registry entry.
        this._splatTex.delete();
        TextureManager.Instance.removeTexture(this._splatId);
        this._world = null;
    }

    // --- serialization ------------------------------------------------------------------------

    public serialize(): any {
        // Heights quantize to Uint16 across their own [min,max] range: half the size of Float32, with
        // sub-millimetre precision for typical terrains.
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < this._heights.length; i++) {
            const h = this._heights[i];
            if (h < min) min = h;
            if (h > max) max = h;
        }
        if (!isFinite(min)) { min = 0; max = 0; }
        const span = (max - min) || 1;
        const u16 = new Uint16Array(this._heights.length);
        for (let i = 0; i < this._heights.length; i++)
            u16[i] = Math.round(((this._heights[i] - min) / span) * 65535);

        return {
            size: this._cfg.size,
            resolution: this._cfg.resolution,
            chunkQuads: this._cfg.chunkQuads,
            heightFormat: 'u16',
            heightMin: min,
            heightMax: max,
            heights: bytesToBase64(new Uint8Array(u16.buffer)),
            splatRes: this._splatRes,
            splat: bytesToBase64(this._splat),
            layers: this._layers.map(L => ({
                materialId: L.materialId,
                material: L.material ? L.material.serialize() : null,
                textureId: L.material ? null : L.albedoId, // legacy plain-albedo layers
                tiling: L.tiling,
                auto: L.auto,
                hRange: [L.hRange[0], L.hRange[1]],
                sRange: [L.sRange[0], L.sRange[1]],
            })),
            foliage: this._foliage.map(f => f.serialize()),
            foliageColliders: { ...this.foliageColliders },
        };
    }

    public static deserialize(json: any, material?: Material): Terrain {
        const terrain = new Terrain({
            // `renderDensity` and `targetVertsPerTile` may be present in a blob saved while terrain
            // relief was geometry. They are ignored: the mesh is one vertex per height-grid point again.
            size: json.size, resolution: json.resolution, chunkQuads: json.chunkQuads,
        }, material);
        // `heightsU16` / `splatData` are pre-decoded typed arrays supplied by the published-game loader
        // (which inflates them out of game.bin); `heights` / `splat` are the base64 form the editor saves.
        if (json.heightsU16 || json.heights) {
            const bytes: Uint8Array | null = json.heights ? base64ToBytes(json.heights) : null;
            if (json.heightsU16 || json.heightFormat === 'u16') {
                const u16: Uint16Array = json.heightsU16
                    ? (json.heightsU16 instanceof Uint16Array
                        ? json.heightsU16
                        : new Uint16Array(json.heightsU16.buffer ?? json.heightsU16))
                    : new Uint16Array(bytes!.buffer, bytes!.byteOffset, Math.floor(bytes!.byteLength / 2));
                const min = json.heightMin ?? 0, max = json.heightMax ?? 1;
                const span = (max - min) || 1;
                const n = Math.min(terrain._heights.length, u16.length);
                for (let i = 0; i < n; i++) terrain._heights[i] = min + (u16[i] / 65535) * span;
            } else {
                // Legacy Float32 heights (scenes saved before the Uint16 format).
                const floats = new Float32Array(bytes!.buffer, bytes!.byteOffset, Math.floor(bytes!.byteLength / 4));
                terrain._heights.set(floats.subarray(0, terrain._heights.length));
            }
            for (const ch of terrain._chunks) terrain._refreshChunkGeometry(ch);
        }
        const splatBytes: Uint8Array | null =
            json.splatData ? new Uint8Array(json.splatData.buffer ?? json.splatData)
                : json.splat ? base64ToBytes(json.splat) : null;
        if (splatBytes) {
            const srcRes = json.splatRes ?? terrain._splatRes;
            if (srcRes === terrain._splatRes) terrain._splat.set(splatBytes.subarray(0, terrain._splat.length));
            else {
                // Nearest-neighbour resample across a resolution change; approximate beats erased.
                const S = terrain._splatRes;
                for (let r = 0; r < S; r++) {
                    const sr = Math.min(srcRes - 1, Math.round((S > 1 ? r / (S - 1) : 0) * (srcRes - 1)));
                    for (let c = 0; c < S; c++) {
                        const sc = Math.min(srcRes - 1, Math.round((S > 1 ? c / (S - 1) : 0) * (srcRes - 1)));
                        const si = (sr * srcRes + sc) * 4, di = (r * S + c) * 4;
                        for (let k = 0; k < 4; k++) terrain._splat[di + k] = splatBytes[si + k] ?? 0;
                    }
                }
                Logger.warn(
                    `Terrain splat map was saved at ${srcRes}x${srcRes} but this terrain is ` +
                    `${terrain._splatRes}x${terrain._splatRes} — resampled.`, 'Terrain');
            }
            terrain._splatTex.updateRegion(0, 0, terrain._splatRes, terrain._splatRes, terrain._splat);
        }
        if (json.foliageColliders)
            terrain.foliageColliders = { ...DEFAULT_FOLIAGE_COLLIDERS, ...json.foliageColliders };
        if (Array.isArray(json.layers)) {
            for (let i = 0; i < json.layers.length && i < 4; i++) {
                const lj = json.layers[i];
                if (!lj) continue;
                if (lj.material) {
                    const tm = TerrainMaterial.parse(lj.material);
                    // MIGRATION. Relief depth used to be authored in the layer's tiled uv and converted
                    // to metres with `size / tiling`; it is now metres outright. Scaling by the factor
                    // that used to be applied means the terrain draws exactly what it drew before — only
                     // UN-MIGRATED, not migrated. There was a conversion here that multiplied
                    // `displacementScale` by `size / tiling` to turn a tiled-uv depth into world
                    // metres, because relief was geometry and geometry works in metres. Relief is a
                    // parallax march again and the authored number is a fraction of one texture repeat,
                    // exactly as on a mesh — the unit these blobs used before the bake existed.
                    //
                    // So a blob WITHOUT the stamp is already correct as stored and is left alone; one
                    // WITH it was mechanically converted and gets that exact factor divided back out.
                    // This is the only place both the marker and the terrain size are in hand.
                    if (json.depthUnit === 'metres')
                        tm.displacementScale *= Math.max(lj.tiling ?? tm.tiling, TILING_EPSILON)
                            / Math.max(json.size ?? 200, 1e-6);
                    terrain.setLayer(i, tm, {
                        tiling: lj.tiling, auto: lj.auto, hRange: lj.hRange, sRange: lj.sRange,
                        materialId: lj.materialId ?? null,
                    });
                } else {
                    terrain.setLayer(i, lj); // legacy plain-albedo (lj.textureId)
                }
            }
        }
        if (Array.isArray(json.foliage)) {
            for (const f of json.foliage) {
                const layer = FoliageLayer.deserialize(f);
                terrain.addFoliage(layer);
                terrain._foliageByKey.set(layer.key, layer); // reuse on further material-driven scatter
            }
            // A serialized layer embeds its own prototype copy, and the layer materials parsed just
            // above carry their own — the two are written at different times, and the rule is the newer
            // of the pair whenever the source model was edited while this scene was closed. Re-deriving
            // here is what keeps a scene from opening stale.
            //
            // AUTHORING ONLY, and that gate is about cost rather than correctness: the two copies can
            // only diverge if something edited one of them, which cannot happen in a published build —
            // where this would just re-parse every prototype's geometry a second time at load.
            //
            // NOT rescatterOnDensityChange: opening a file must never re-roll a user's placement.
            if (authoring.enabled) terrain.refreshFoliagePrototypes();
        }
        return terrain;
    }
}
