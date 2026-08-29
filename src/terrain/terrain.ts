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
import { heightPyramid, sampleHeightLod, displaceSplitLod, pyramidMean, pyramidResidualBounds, band,
    TILING_EPSILON, HeightField } from '../graphics/systems/displacement';
import { device } from '../graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage } from '../graphics/rhi/types';
import TerrainDisplaceComputeProgram from '../graphics/shaders/wgsl/terrainDisplaceCompute.wgsl';
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
     * Whether this layer raises the terrain's VERTICES. True exactly when it has a height map — terrain
     * always displaces, and there is no per-layer mode.
     *
     * That is a deliberate narrowing. A terrain layer used to be able to march its height field per
     * fragment instead, and keeping both meant the CPU bake and the shader had to agree on which band
     * each of them carried — through a split mip level, a headroom constant, a packed texture whose
     * size did not match the source map, and a weight set the CPU never fully resolved. Every one of
     * those was a way to be silently wrong. Geometry is now the only source of terrain relief.
     *
     * The honest limit belongs next to the flag: vertex spacing is `size / (resolution - 1)` while a
     * layer tiles 20-50x, so the grid gets roughly six vertices per tile and can only carry the lowest
     * frequencies of a height map. `renderDensity` and `resolution` are the levers.
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
    /**
     * Render vertices per repeat of a layer's height map, TARGETED. This is the control that makes
     * displacement detail independent of the terrain's height resolution: a coarse height grid is
     * compensated by a denser render mesh rather than losing the relief.
     *
     * Terrain relief is geometry now, and the vertex grid can only carry frequencies coarser than its
     * own spacing. At the editor defaults the grid gets `(129 - 1) / 20` = 6.4 vertices per repeat, so
     * the bake band-limits a 1024-texel map down to roughly 4x4 — very nearly its flat average. Asking
     * for 32 here gets the map's actual relief instead.
     *
     * Only chunks NEAR the camera pay for it; see `Terrain.densityFor`.
     */
    targetVertsPerTile?: number;
    /**
     * Hard cap on the per-axis density the target may ask for. Present so a pathological tiling cannot
     * allocate an unbounded mesh; the per-chunk vertex ceiling below is the one that usually binds.
     *
     * RENDER ONLY. `heights`, the splat, physics, `heightAt()`, picking, foliage and the saved blob all
     * stay on the authored grid — this multiplies the mesh the GPU draws and nothing else.
     *
     * It exists for ONE reason: a displaced paint layer can only carry frequencies coarser than the
     * vertex spacing, and everything finer is handed to the parallax march instead (see
     * `systems/displacement.ts`). Each doubling here moves exactly one octave of the height map out of
     * the march and into real geometry — which is what buys a silhouette and self-shadowing for it.
     * With every layer on parallax the extra vertices carry NO new information: a bilinear subdivision
     * of the height grid renders identically to the coarse mesh, so it is pure cost.
     *
     * Powers of two, capped at 4 (16x the vertices; ~14 MB of vertex data on a default 200 m terrain).
     */
    renderDensity?: number;
}

/**
 * Ceiling on the per-axis render density, and on the vertices one chunk may hold.
 *
 * The vertex ceiling is the one that usually binds and is the honest cost control: at the default
 * `chunkQuads` of 32, density 8 is 66k vertices — 3.7 MB for that chunk. Only the handful of chunks near
 * the camera are built at it, so a 200 m terrain pays roughly 22 MB rather than the 56 MB it would cost
 * to build every chunk that dense.
 */
const MAX_DENSITY = 8;
/**
 * Whole-terrain vertex budget. Every chunk is built at one density now, so the ceiling has to be about
 * the terrain rather than about a chunk: 300k vertices is roughly 16 MB of vertex data, which is density
 * 4 on a default 200 m / resolution 129 landscape and resolves relief down to about 0.78 m.
 */
const MAX_TERRAIN_VERTICES = 300000;

/** Per-layer inputs to `_displacementAt`, resolved once per bake rather than per vertex. */
interface DisplaceContext {
    /**
     * `mean` is what the layer's relief is centred on, and `residual` is the part of the map the
     * geometry cannot carry — see `Terrain._displacementAt` and `pyramidResidualBounds`.
     */
    layers: {
        i: number; L: TerrainLayer; pyramid: HeightField[]; lod: number; mean: number;
        residual: { top: number; bot: number };
    }[];
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
        // Snapped to a power of two: the vertex grid has to nest inside the height grid for
        // `_vertexGrid` to land on exact cell fractions, and the LOD decimation steps are scaled by it.
        renderDensity: Math.min(MAX_DENSITY, Math.max(1, 1 << Math.round(Math.log2(Math.max(1, c.renderDensity ?? 1))))),
        targetVertsPerTile: Math.max(0, Math.floor(c.targetVertsPerTile ?? 32)),
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
    /** Render vertices per height-grid cell, per axis. See {@link TerrainConfig.renderDensity}. */
    public get renderDensity(): number { return this._cfg.renderDensity; }
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
    // `(c0 + i, r0 + j)`. `renderDensity` breaks that one-to-one mapping, so it is expressed here once
    // and every one of those four goes through it rather than re-deriving it and drifting.

    /** A chunk's vertex extents. At density 1 these are its grid extents, exactly as before. */
    private _chunkSpan(chunk: TerrainChunk): { cols: number; rows: number; stride: number } {
        const d = this.densityFor();
        const cols = (chunk.c1 - chunk.c0) * d, rows = (chunk.r1 - chunk.r0) * d;
        return { cols, rows, stride: cols + 1 };
    }

    /** The (fractional) height-grid column a chunk's local vertex column sits on. */
    private _vertexGrid(base: number, i: number, density: number): number { return base + i / density; }

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
     * How far the displaced layers raise the surface at a fractional grid coordinate.
     *
     * THE one formula. `_rebuildRenderHeights` evaluates it on the grid to build the field that bounds,
     * LOD and the density-1 mesh all read; `_refreshChunkGeometry` evaluates it between grid points for
     * the dense mesh; and `terrainDisplaceCompute.wgsl` is a transcription of it. Three callers, one
     * expression, so they cannot drift.
     *
     * `ctx` carries the decoded pyramids and the split level per layer, because both of those are
     * per-layer constants and looking them up per vertex would dominate the loop.
     */
    private _displacementAt(gx: number, gz: number, ctx: DisplaceContext,
                            weights: [number, number, number, number]): number {
        this._resolveWeights(gx, gz, weights);
        const inv = 1 / Math.max(1, this._R - 1);
        const u = gx * inv, v = gz * inv;
        let sum = 0;
        for (const layer of ctx.layers) {
            const w = weights[layer.i];
            if (w <= 0) continue;
            // CENTRED ON THE MAP'S MEAN, and that is the whole answer to "I have to invert the height
            // map to make it look right". The polarity was never wrong — white has always been high at
            // every step. What changed when parallax gave way to geometry is the REFERENCE PLANE.
            //
            // Parallax could only carve INTO the surface: white sat at the sculpted ground and black one
            // depth below it, so a map read as pits. Displacement only adds: white sits one depth ABOVE
            // and black at the ground, so the same map reads as bumps AND the whole painted region steps
            // up against unpainted terrain beside it. Inverting turns bumps back into pits, which is why
            // it looked like a fix.
            //
            // Subtracting the mean puts the relief both above and below the sculpt. The painted ground
            // keeps the level it was sculpted at, the step at a paint boundary disappears, and `invert`
            // goes back to meaning what it says: `(1-h) - (1-mean)` is `-(h - mean)`, a negated relief
            // rather than a different offset.
            // LIFTED BY THE RESIDUAL'S PEAK, so the half of the map the geometry cannot carry has room
            // to hang below this surface. Parallax only carves inward: the march removes
            // `amplitude * (top - r)` per fragment, which averages to `amplitude * top` and cancels this
            // exactly, leaving the shaded surface at the mean-centred FULL height. Without the lift the
            // residual would have to straddle the geometry, which no inward-only march can express.
            //
            // What it costs is a constant step of `amplitude * top` — around a centimetre — in the
            // GEOMETRY at a paint boundary, well under the 0.78 m the vertex grid can resolve.
            sum += w * this._layerAmplitude(layer.L) * (sampleHeightLod(
                layer.pyramid, u * layer.L.tiling, v * layer.L.tiling, layer.lod, layer.L.invertHeight)
                - layer.mean + layer.residual.top);
        }
        return sum;
    }

    /**
     * A layer's relief depth, in WORLD METRES — which is simply what was authored.
     *
     * It used to be `dispScale * size / tiling`, converting from the layer's tiled uv. That existed for
     * exactly one reason: to agree with the parallax march, whose `blendedDepth` is `dispScale / tiling`
     * in base uv. **The march no longer runs for a displaced layer**, so there is nothing left to agree
     * with, and the conversion had become pure cost — the same authored number meant ten times more
     * relief on a 200 m terrain than on a 20 m one, and the depth slider's 0..0.5 range spanned 0 to
     * FIVE METRES at the editor defaults with a 5 cm minimum step. Three centimetres of gravel, the
     * thing this feature is for, was not expressible at all.
     *
     * Metres make the number mean one thing everywhere: 0.03 is three centimetres of relief on any
     * terrain, at any size, at any tiling. Terrains saved under the old unit are migrated on load — see
     * `deserialize` — so nothing already authored moves on screen.
     */
    private _layerAmplitude(L: TerrainLayer): number {
        return L.dispScale;
    }

    /**
     * The blend weights at a grid coordinate, resolved the way `resolveTerrainSurface` resolves them.
     *
     * The geometry has to be raised by the weights the SHADER draws with, not by the raw splat. Three
     * things stand between the two, and all three were being skipped — so a layer masked out of the
     * picture still displaced the ground under it, with nothing on screen to explain the bump:
     *
     *   1. the `u_layerCount` cut, which zeroes any slot past the last active layer;
     *   2. the automatic height/slope mask, when any layer has `auto` set;
     *   3. the divide by the weight sum.
     *
     * THE MASK READS THE SCULPTED SURFACE, not the displaced one. Displacement changes height and slope,
     * which changes the mask, which changes displacement — evaluating against the sculpt cuts that loop
     * and makes the bake a fixed point rather than something whose answer depends on how many times it
     * has run. The shader evaluates it against the drawn surface; the difference is second-order (a
     * fraction of the relief depth against bands metres wide) and buys determinism.
     */
    private _resolveWeights(gx: number, gz: number, out: [number, number, number, number]): void {
        this._splatAt(gx, gz, out);

        let count = 0;
        for (let i = 0; i < this._layers.length; i++) if (this._layerActive(this._layers[i])) count = i + 1;
        for (let i = count; i < 4; i++) out[i] = 0;

        let useAuto = false;
        for (const L of this._layers) if (L?.auto) { useAuto = true; break; }
        if (useAuto) {
            // World Y and slope of the sculpted surface, matching the shader's `fragPos.y` and
            // `1 - nGeom.y`. The origin is added because `hRange` is authored in world space.
            const height = this._bilinearAt(this._heights, gx, gz) + this._origin[1];
            // `_normalAtGrid` over `_baseAt`, NOT `_normalAt`, and it fixes two faults in one line.
            //
            // `_normalAt` indexes `Float32Array` directly, but this function runs at FRACTIONAL grid
            // coordinates on the dense path (`_vertexGrid` returns `base + i/density`). A fractional
            // index reads `undefined`, so `dhx` was NaN — and `Math.hypot(NaN,1,NaN) || 1` evaluates to
            // 1, so it returned `[NaN, 1, NaN]` and the slope came out EXACTLY 0. At density 4 that is
            // three vertices in four silently unmasked, with the fourth reading a surface that is not
            // the one being drawn.
            //
            // And it reads `_surfaceHeights` — the DISPLACED field — where the height above it reads the
            // sculpted one. The mask is deliberately evaluated on the sculpt so the bake is a fixed
            // point rather than something whose answer depends on how many times it has run; `_baseAt`
            // is that field, sampled bilinearly, at any coordinate.
            this._normalAtGrid(gx, gz, this._baseSampler, Terrain._weightNormal, 1);
            const slope = Math.min(1, Math.max(0, 1 - Terrain._weightNormal[1]));
            // Kept so the mask can be BACKED OUT if it masks everything. See below.
            const w0 = out[0], w1 = out[1], w2 = out[2], w3 = out[3];
            for (let i = 0; i < 4 && i < this._layers.length; i++) {
                const L = this._layers[i];
                if (!L?.auto) continue;
                out[i] *= band(L.hRange, height, 2.0) * band(L.sRange, slope, 0.08);
            }
            // THE MASK MAY NOT ERASE THE TERRAIN. `hRange` defaults to [0, 100] and `band` smoothsteps
            // in across `range[0] ± 2`, so it returns 0.5 at y = 0 — where a default terrain sits — and
            // 0 below about y = -2. A terrain sculpted with valleys, or a landscape node moved down (the
            // origin is added above), therefore drove every auto layer to zero, and the collapse below
            // zeroed all four weights: no displacement, and the shader's matching early-out dropped the
            // layers from the shading too. Whole regions went flat and base-coloured.
            //
            // Falling back to the UNMASKED weights is the only answer that degrades sensibly. The mask
            // exists to CHOOSE between layers — rock on slopes, grass on flats — so with nothing left to
            // choose between it has no opinion to express, and the painted splat is the better answer
            // than nothing. `resolveTerrainSurface` in chunks/terrainLayers.wgsl carries the same
            // fallback; if these two ever disagree the bake displaces ground the shader draws bare.
            const masked = out[0] + out[1] + out[2] + out[3];
            if (masked < 1e-4) { out[0] = w0; out[1] = w1; out[2] = w2; out[3] = w3; }
        }

        const sum = out[0] + out[1] + out[2] + out[3];
        if (sum < 1e-4) { out[0] = out[1] = out[2] = out[3] = 0; return; }
        for (let i = 0; i < 4; i++) out[i] /= sum;
    }

    /** Scratch for `_resolveWeights`, so the per-vertex path allocates nothing. */
    private static readonly _weightNormal: [number, number, number] = [0, 1, 0];
    /** The sculpted field as a sampler, bound once — `_resolveWeights` runs per vertex. */
    private readonly _baseSampler = (x: number, z: number): number => this._baseAt(x, z);

    /**
     * The decoded inputs `_displacementAt` needs, or null when nothing displaces or a height map has not
     * finished decoding. `density` scales the split level: a denser grid resolves a finer band, which is
     * the entire point of `renderDensity`.
     */
    /**
     * The render density EVERY chunk is built at. One number for the terrain, computed once.
     *
     * Derived from `targetVertsPerTile` rather than authored as a multiple of the height resolution,
     * which is what makes relief detail independent of the terrain's Resolution:
     *
     *     density = ceil_pow2( targetVertsPerTile * tiling / (resolution - 1) )
     *
     * over the finest-tiling displaced layer, since that is the one needing the most vertices. A terrain
     * with nothing displaced stays at 1 — extra vertices would be a bilinear subdivision of the same
     * height grid and would render identically.
     *
     * The `lod` parameter is gone in all but name. Density used to fall with a chunk's LOD level so only
     * the near field paid, which meant a chunk crossing a distance threshold had to be REBUILT — and
     * that rebuild, times every chunk on the ring that crossed together, was the frame spike. Relief is
     * baked once now and LOD decimates indices, which costs an integer.
     */
    public densityFor(_lod: number = 0): number {
        if (this._density > 0) return this._density;
        let density = this._baseDensity();
        // Capped by a WHOLE-TERRAIN vertex budget, not a per-chunk one: every chunk is now built at this
        // density, so the cost is paid across the terrain rather than only near the camera.
        const chunksPerSide = Math.ceil((this._R - 1) / this._cfg.chunkQuads);
        const chunks = chunksPerSide * chunksPerSide;
        while (density > 1 && Math.pow(this._cfg.chunkQuads * density + 1, 2) * chunks > MAX_TERRAIN_VERTICES)
            density >>= 1;
        this._density = density;
        return density;
    }

    /**
     * Memoised, and that is not just a micro-optimisation.
     *
     * This used to be evaluated per chunk PER FRAME from `LandscapeNode.updateLod` — `_baseDensity`'s
     * layer scan plus a `Math.pow` inside a `while` loop, sixteen times a frame, to answer a question
     * whose answer cannot change without a rebuild. Invalidated by `setLayer`, since the derived density
     * depends on the displaced layers' tiling.
     */
    private _density: number = 0;
    private _invalidateDensity(): void { this._density = 0; }
    /** The density the chunks in `_chunks` were actually BUILT at. */
    private _builtDensity: number = 0;

    /**
     * Rebuild every chunk's geometry if the derived density has moved since they were built.
     *
     * Needed because a terrain's chunks are constructed BEFORE any layer exists — `_buildChunks` runs in
     * the constructor — while the density is derived from the displaced layers' tiling. So the first
     * `setLayer` is normally the moment the real density becomes knowable, and the chunks built at the
     * placeholder have to catch up.
     *
     * This is the ONLY thing that changes a chunk's vertex count after construction, and it happens on
     * layer assignment — an editor action — never on the camera path. That distinction is the whole
     * point: the per-frame version of this was the frame spike.
     */
    private _rebuildChunksIfDensityChanged(): void {
        const density = this.densityFor();
        if (density === this._builtDensity || this._chunks.length === 0) return;
        this._builtDensity = density;
        for (const chunk of this._chunks) {
            chunk.model.setGeometry(
                this._buildChunkGeometry(chunk.c0, chunk.r0, chunk.c1, chunk.r1, density));
            chunk.lodSteps = null;      // the coarse index sets address the old vertex span
            this._refreshChunkGeometry(chunk);
        }
    }

    /** The density the near field wants, before the chunk ceiling and the LOD falloff. */
    private _baseDensity(): number {
        // 0 hands control back to the authored multiplier, which is the escape hatch for anyone who
        // wants to pin it — and what the density tests use to talk about the multiplier itself.
        const target = this._cfg.targetVertsPerTile;
        if (target <= 0) return this._cfg.renderDensity;

        let tiling = 0;
        for (const L of this._layers) if (this._layerDisplaces(L)) tiling = Math.max(tiling, L.tiling);
        if (tiling <= 0) return 1;   // nothing displaces: extra vertices would carry no new information

        const wanted = (target * tiling) / Math.max(1, this._R - 1);
        return Math.min(MAX_DENSITY, Math.max(1, 1 << Math.ceil(Math.log2(Math.max(1, wanted)))));
    }

    /**
     * The decoded inputs `_displacementAt` needs, or null when nothing displaces, a height map has not
     * finished decoding, or the density is 0 (a chunk far enough out to be flat).
     */
    private _displaceContext(density: number): DisplaceContext | null {
        if (density <= 0) return null;
        const displaced = this._layers
            .map((L, i) => ({ L, i }))
            .filter(({ L }) => this._layerDisplaces(L));
        if (displaced.length === 0) return null;

        const layers: DisplaceContext['layers'] = [];
        for (const { L, i } of displaced) {
            const pyramid = heightPyramid(L.heightId as string);
            if (!pyramid) return null;   // still decoding: retry next frame rather than baking a partial
            // The RAW map's width, not the packed texture's. Band-limiting still matters — it is what
            // stops an undersampled height map folding into low-frequency blobs — but it no longer has
            // to line up with a mip the shader samples, because the shader no longer marches these
            // layers at all. That removes two silent failures at once: `TexturePacker` sizes a pack as
            // the MAX of its sources, so a 2048 normal beside a 1024 height shifted every level by an
            // octave; and the packed width was not in the rebuild key, so a bake done against the
            // fallback guess was never redone once the real pack landed.
            const lod = displaceSplitLod(pyramid[0].width, L.tiling, this._R, density);
            layers.push({
                i, L, pyramid, lod,
                mean: pyramidMean(pyramid, L.invertHeight),
                residual: pyramidResidualBounds(pyramid, lod, L.invertHeight),
            });
        }
        return { layers };
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
        // The RENDERED surface, so the normal picks up the layer gradient for free: the central
        // difference over the total field already includes it, and nothing extra has to be derived.
        const h = this._surfaceHeights;
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
                const geometry = this._buildChunkGeometry(c0, r0, c1, r1, this.densityFor());
                const chunk: TerrainChunk = {
                    model: new Model(geometry, this._material),
                    c0, r0, c1, r1, dirty: false,
                    minY: 0, maxY: 0, lod: 0, lodSteps: null,
                };
                this._updateChunkBounds(chunk);
                this._chunks.push(chunk);
                this._builtDensity = this.densityFor();
            }
        }
    }

    /** Build a chunk geometry spanning global grid cols [c0..c1], rows [r0..r1] (vertices inclusive). */
    private _buildChunkGeometry(c0: number, r0: number, c1: number, r1: number, d: number): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const tangents: [number, number, number][] = [];
        const bitangents: [number, number, number][] = [];
        const indices: number[] = [];
        const half = this._cfg.size / 2, e = this._element, R = this._R;
        const cols = (c1 - c0) * d, rows = (r1 - r0) * d;
        const n: [number, number, number] = [0, 1, 0];
        const base = (x: number, z: number) => this._baseAt(x, z);

        // Over the VERTEX span, which is the grid span times the density. Every quantity here is already
        // a continuous function of the grid coordinate — the world position is `grid * elementSize`, the
        // uv is `grid / (R - 1)` — so a fractional grid coordinate needs no special case. Only the
        // height and the normal do, and both have continuous forms above.
        for (let j = 0; j <= rows; j++) {
            const gz = this._vertexGrid(r0, j, d);
            for (let i = 0; i <= cols; i++) {
                const gx = this._vertexGrid(c0, i, d);
                positions.push([-half + gx * e, this._baseAt(gx, gz), -half + gz * e]);
                if (d === 1) this._normalAt(gx, gz, n);
                else this._normalAtGrid(gx, gz, base, n, d);
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

    /**
     * The height field the RENDERED surface uses: the sculpted heights plus every displaced layer.
     *
     * `_heights` itself is never modified, and that is the load-bearing rule of the whole terrain half.
     * It is the sculpted, serialized, physics-authoritative field: the terrain blob round-trips from it,
     * the heightfield collider is built from it, and `heightAt()` answers from it. Layer displacement is
     * RENDER-ONLY, which keeps all three stable and means a material tweak never rebuilds a physics body.
     *
     * A DISPLACED TERRAIN IS NOT WALKED ON. The collider follows `_heights`, so a character stands on
     * the sculpted surface while the eye sees the displaced one. For the centimetre relief this is meant
     * for that is right and cheap; for anything larger the answer is to sculpt, not to displace.
     *
     * Aliased to `_heights` outright when no layer displaces, so the common case allocates nothing and
     * every read below is the same array it always was.
     */
    private _renderHeights: Float32Array | null = null;
    private get _surfaceHeights(): Float32Array { return this._renderHeights ?? this._heights; }

    /**
     * The RENDERED height field when layer displacement has produced one, else null.
     *
     * Read-only and diagnostic — the harness compares it against {@link heights} to prove a bake ran,
     * which a screenshot cannot do: a displaced layer that never baked renders exactly like one that
     * was never displaced. Nothing in the engine should route through this; use `heightAt()`, which
     * deliberately answers from the SCULPTED field that physics and picking share.
     */
    public get renderHeights(): Float32Array | null { return this._renderHeights; }
    /** Bumped wherever `_heights` or `_splat` changes, so the derived field knows to recompute. */
    private _surfaceRev: number = 0;
    /** The inputs `_renderHeights` was last built from. Empty while a rebuild is still owed. */
    private _renderHeightsKey: string = '';

    /**
     * Recompute {@link _surfaceHeights} from `_heights` and the displaced layers, then refresh every
     * chunk through the EXISTING rewrite path.
     *
     * The splat map is one RGBA texel per height-grid point (`_splatRes === _R`), so the layer weights
     * line up with the grid exactly and there is no resampling to get wrong. Weights are read from the
     * CPU-side `_splat`, so nothing here needs a GPU readback.
     */
    private _rebuildRenderHeights(): void {
        const displaced = this._layers
            .map((L, i) => ({ L, i }))
            .filter(({ L }) => L.displace && L.heightId && L.dispScale !== 0);

        // Called every frame, so it has to be cheap when nothing moved. The key covers everything the
        // accumulation reads: the sculpted heights and the splat (through `_surfaceRev`) and each
        // displaced layer's parameters. Without it this would recompute a 129x129 field and re-upload
        // every chunk on every frame a terrain had one displaced layer.
        const key = displaced.length === 0 ? '' : this._surfaceRev + '|' + displaced
            // `auto`/`hRange`/`sRange` are in the key because the bake resolves the same masked weights
            // the shader shades with — without them, editing an auto band would never re-bake.
            .map(({ L, i }) => `${i}:${L.heightId}:${L.dispScale}:${L.tiling}:${L.invertHeight ? 1 : 0}`
                + `:${L.auto ? 1 : 0}:${L.hRange[0]},${L.hRange[1]}:${L.sRange[0]},${L.sRange[1]}`)
            .join(',');

        if (displaced.length === 0) {
            if (this._renderHeights === null) return;
            this._renderHeights = null;
            this._renderHeightsKey = key;
            for (const ch of this._chunks) this._refreshChunkGeometry(ch);
            return;
        }
        if (key === this._renderHeightsKey && this._renderHeights) return;

        // A layer whose height map has not decoded yet leaves the context null, and the bake retries on
        // a later call — the same idiom the packer uses, and the reason nothing here awaits anything.
        // The key is NOT recorded until every field read, so a partial bake keeps retrying.
        //
        // BAND-LIMITED at the GRID's spacing, which is the difference between relief and blobs: the grid
        // samples a layer's map `(R - 1) / tiling` times per repeat — 6.4 at the editor defaults — and a
        // point sample of a 1024-texel map at that rate folds its detail down into low-frequency beats.
        // `_displacementAt` samples the mip whose texel covers one vertex instead. Detail finer than
        // that is genuinely gone — nothing marches it any more — which is what `targetVertsPerTile`
        // exists to buy back, by giving the near field enough vertices to carry it.
        const ctx = this._displaceContext(1);
        if (!ctx) return;

        const R = this._R;
        const out = new Float32Array(this._heights.length);
        out.set(this._heights);
        const weights: [number, number, number, number] = [0, 0, 0, 0];

        for (let r = 0; r < R; r++)
            for (let c = 0; c < R; c++)
                out[r * R + c] += this._displacementAt(c, r, ctx, weights);

        this._renderHeights = out;
        this._renderHeightsKey = key;
        for (const ch of this._chunks) this._refreshChunkGeometry(ch);
    }

    /** Re-bake one chunk's vertices. Public for `LandscapeNode.updateLod`, which re-bakes on a level change. */
    public refreshChunk(chunk: TerrainChunk): void { this._refreshChunkGeometry(chunk); }

    /** Rewrite a chunk geometry's Y + normals in place from the current heights and flag it dirty. */
    private _refreshChunkGeometry(chunk: TerrainChunk): void {
        const g = chunk.model.geometry;
        const positions = g.positions, normals = g.normals;
        const R = this._R;
        const n: [number, number, number] = [0, 1, 0];
        let i = 0;

        // DENSITY 1 IS THE UNCHANGED PATH, deliberately. It reads the precomputed grid field and the
        // grid normal, which is both cheaper and bit-identical to what terrain has always produced — so
        // adding the density option cannot move a terrain that never asked for it. The continuous
        // sampling below only runs where there are vertices between grid points.
        // At density 1 AND LOD 0 the answer is already in `_renderHeights`, which the whole terrain
        // shares — read it rather than recomputing per chunk. Any other combination is chunk-specific
        // (a coarser band for a distant chunk, or vertices between grid points) and takes the general
        // path below.
        if (this.densityFor() === 1) {
            for (let r = chunk.r0; r <= chunk.r1; r++) {
                for (let c = chunk.c0; c <= chunk.c1; c++) {
                    const i3 = i * 3;
                    positions[i3 + 1] = this._surfaceHeights[r * R + c];
                    this._normalAt(c, r, n);
                    normals[i3] = n[0]; normals[i3 + 1] = n[1]; normals[i3 + 2] = n[2];
                    i++;
                }
            }
        } else {
            // The dense mesh evaluates the displacement at its OWN spacing, with a split level one
            // octave finer per doubling — that extra octave becoming real geometry is the entire reason
            // the option exists. `_renderHeights` is not read here: it is the grid-resolution field, and
            // interpolating it would reproduce the coarse surface at 16x the vertex cost.
            const ctx = this._displaceContext(this.densityFor());
            const weights: [number, number, number, number] = [0, 0, 0, 0];
            const { cols, rows } = this._chunkSpan(chunk);

            // ONE SAMPLER, on the CPU, on every device. There used to be two: a compute dispatch
            // overwrote Y and the normal on WebGPU, so this wrote only the grid-level surface there and
            // the full displacement everywhere else.
            //
            // That dispatch is gone, and dropping it was measured rather than assumed. Forcing both
            // backends onto this sampler collapsed `harness:backenddiff`'s deferred.every debugAO from
            // 24/128 differing cells at a worst delta of 100/255 to ZERO, and cleared fourteen of the
            // fifteen configurations that had moved. The two bakes ran the same ALGORITHM — a parity
            // test pinned that — over DIFFERENT DATA: the dispatch sampled the packed layer texture's
            // GPU-generated mips while this samples a pyramid built here from the raw height map, and a
            // 32x32 linear-ramp test fixture had hidden the difference for as long as it existed.
            //
            // What made it affordable to delete is that the bake no longer runs on the camera path.
            // Relief is baked once when chunks are built, and again only on a sculpt, a paint stroke or
            // a layer change — so the dispatch was optimising something that happens a handful of times
            // in a session, at the cost of an entire class of cross-backend divergence.
            const sample = (x: number, z: number) => this._baseAt(x, z)
                + (ctx ? this._displacementAt(x, z, ctx, weights) : 0);

            for (let j = 0; j <= rows; j++) {
                const gz = this._vertexGrid(chunk.r0, j, this.densityFor());
                for (let k = 0; k <= cols; k++) {
                    const gx = this._vertexGrid(chunk.c0, k, this.densityFor());
                    const i3 = i * 3;
                    positions[i3 + 1] = sample(gx, gz);
                    this._normalAtGrid(gx, gz, sample, n, this.densityFor());
                    normals[i3] = n[0]; normals[i3 + 1] = n[1]; normals[i3 + 2] = n[2];
                    i++;
                }
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
                // The rendered surface: these bounds feed terrain LOD and culling, and a chunk whose
                // layers pushed it up would otherwise be measured at the sculpted height it no longer
                // draws at.
                const h = this._surfaceHeights[r * R + c];
                if (h < min) min = h;
                if (h > max) max = h;
            }
        }
        chunk.minY = isFinite(min) ? min : 0;
        chunk.maxY = isFinite(max) ? max : 0;

        // A dense mesh carries relief BETWEEN grid points, which the loop above cannot see. Expanding by
        // the deepest displaced layer is conservative — the splat weights sum to 1, so no vertex can be
        // raised by more than the largest single layer contributes — and costs nothing but a slightly
        // early LOD transition. Without it a chunk is measured at a height it no longer draws at.
        if (this.densityFor() > 1) {
            let reach = 0;
            // Both directions, because relief is centred on the map's mean — it reaches below the
            // sculpted surface as well as above it. The `+ 1` covers the residual LIFT on top of that:
            // the bake adds `amplitude * residualTop`, and `top` is bounded by 1 since both halves of
            // the residual are samples of a 0..1 field. Doubling the reach keeps the claim this bound
            // rests on literally true — no vertex can leave the box — rather than true in the common
            // case. It costs a slightly early LOD transition and nothing else; the geometry's own
            // bounding sphere, which is what culls, is recomputed from the moved vertices.
            for (const L of this._layers)
                if (this._layerDisplaces(L)) reach = Math.max(reach, Math.abs(this._layerAmplitude(L)));

            chunk.minY -= 2 * reach;
            chunk.maxY += 2 * reach;
        }
    }

    private _markRegionDirty(cMin: number, rMin: number, cMax: number, rMax: number): void {
        // The sculpted field moved, so the derived one is stale. `_rebuildRenderHeights` runs from the
        // per-frame `syncPackedLayers` rather than here: sculpting marks many regions per stroke, and
        // rebuilding the whole field on each of them would make the brush unusable.
        this._surfaceRev++;
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
        this._surfaceRev++;   // the splat drives the displaced-layer weights
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
        // INVERTED BY DEFAULT, because the slot is a DEPTH map (white = deep). That is what
        // `displacementMap` is documented as in four separate places — here in material.ts, on
        // `TerrainMaterial.invertHeight`, in chunks/terrainLayers.wgsl, and in chunks/parallax.wgsl
        // ("ship a DEPTH map, `*_disp.png`, white = deep. The two are indistinguishable from the
        // bytes"). Terrain used to read it as a HEIGHT map, so an untouched checkbox pushed relief IN
        // and authors had to tick Invert to get it to pop out — the control meaning the opposite of its
        // label.
        //
        // THIS IS THE ONLY PLACE THE FLIP MAY LIVE. Everything downstream reads `L.invertHeight`: the
        // CPU bake through `_displacementAt`, `pyramidMean` and `pyramidResidualBounds`, and the GPU
        // through `_writeLayerUniforms` -> `u_invertHeight{i}`. Flipping at any single one of those
        // would leave the two halves of the split disagreeing about which way relief goes, which is the
        // failure this area produces every time it is touched. Stored values are migrated once by
        // `TerrainMaterial.parse` (`heightPolarity`), so nothing already authored changes on screen.
        //
        // Standard materials still read the slot as a height map; the divergence is deliberate.
        const invertHeight = !tm.invertHeight;
        // Terrain always displaces: having a height map IS the condition. No mode to read.
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
        // Written HERE rather than in `_writeLayerUniforms` because it needs the resolved pack: the
        // split level has to be expressed in the PACKED texture's mip space, and the pack is what this
        // function just produced. Per frame, which is also the retry for a height map still decoding.
        //
        // `u_hasHeight{i}` stays set for a displaced layer. It drives `layerHeights`, which feeds the
        // height-aware layer BLEND as well as the march, so clearing it to change what the march does
        // (the obvious move, and what this used to do) would silently switch a separate feature off.
        this._writeMarchUniforms(index, L);
        m.properties.set(`u_hasHeight${index}`, L.heightId ? 1 : 0);
    }

    /** Re-resolve every layer's packed normal+height texture. Called once per frame by the renderer, to
     *  pick up layers whose maps had not finished decoding when they were assigned. */
    public syncPackedLayers(frame: number): void {
        for (let i = 0; i < this._layers.length && i < 4; i++) {
            this._syncAlbedoPack(i, this._layers[i], frame);
            this._syncLayerPack(i, this._layers[i], frame);
        }
        // Retried per frame for the same reason the pack is: a displaced layer's height map decodes
        // asynchronously, so the first few calls find nothing to read and the rebuild is a no-op.
        // `_rebuildRenderHeights` is idempotent once the pixels land — it recomputes from `_heights`
        // rather than accumulating — so calling it every frame is safe, and it early-outs when no layer
        // displaces, which is the only cost a normal terrain pays.
        this._rebuildRenderHeights();
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
        m.properties.set(`u_dispScale${index}`, L.dispScale);
        this._writeMarchUniforms(index, L);
        m.properties.set(`u_invertHeight${index}`, L.invertHeight ? 1 : 0);
        m.properties.set(`u_heightBlend${index}`, L.heightBlend);
        m.properties.set(`u_tiling${index}`, L.tiling);
        m.properties.set(`u_auto${index}`, L.auto ? 1 : 0);
        m.properties.set(`u_hRange${index}`, [L.hRange[0], L.hRange[1]]);
        m.properties.set(`u_sRange${index}`, [L.sRange[0], L.sRange[1]]);
    }

    /**
     * Tell the shader WHERE this layer's height map is cut in two, and how deep the half it owns is.
     *
     * A layer's relief is split at the mip whose texel covers one terrain vertex: at or below that
     * frequency it becomes geometry, above it the parallax march carries it. This writes the march's
     * side of that contract — the split level, the residual's range and floor, and the depth in base uv.
     *
     * It replaced a single `u_displaces{i}` flag that told `blendedDepth` to SKIP a displaced layer, so
     * the fine half of every terrain height map was computed, band-limited away and then drawn by
     * nothing at all. On a 200 m terrain at tiling 20 the split falls at mip 5.3, which left the
     * geometry a 26x26 reduction of a 1024 map and put every rock in it out of reach.
     *
     * Called from `_syncLayerPack`, per frame, which is what makes the two retries below safe: a height
     * map that has not decoded, or a pack that has not resolved, writes zeros this frame — the march
     * contributes nothing rather than something wrong — and is picked up on a later one.
     */
    private _writeMarchUniforms(index: number, L: TerrainLayer): void {
        const m = this._material;
        const zero = () => {
            m.properties.set(`u_splitLod${index}`, 0);
            m.properties.set(`u_residRange${index}`, 0);
            m.properties.set(`u_residBot${index}`, 0);
            m.properties.set(`u_marchDepth${index}`, 0);
        };
        if (!this._layerDisplaces(L)) { zero(); return; }
        const pyramid = heightPyramid(L.heightId as string);
        if (!pyramid) { zero(); return; }

        const raw = pyramid[0].width;
        // The SAME number `_displaceContext` bakes at, density included — the two halves of a split
        // that do not agree on where it is either double-count a band or leave a gap in one.
        const split = displaceSplitLod(raw, L.tiling, this._R, this.densityFor());
        const { top, bot } = pyramidResidualBounds(pyramid, split, L.invertHeight);

        // IN THE PACKED TEXTURE'S MIP SPACE. `split` is derived from the raw height map's width, but the
        // shader samples the pack, and `TexturePacker` sizes a pack as the MAX of its sources — so a
        // 2048 normal beside a 1024 height map puts every level an octave out. `_displaceContext` says
        // it can use the raw width because nothing sampled a matching mip; the march does now.
        const packId = m.textures.get(`u_normal${index}`);
        const packed = packId ? (TextureManager.Instance.getTexture(packId)?.width || raw) : raw;
        const octaves = Math.log2(Math.max(1, packed) / Math.max(1, raw));

        m.properties.set(`u_splitLod${index}`, split + octaves);
        m.properties.set(`u_residRange${index}`, top - bot);
        m.properties.set(`u_residBot${index}`, bot);
        // METRES TO BASE UV. The march offsets `baseUv`, which spans the terrain's `size`; depth is
        // authored in world metres. Scaled by the residual's range because that is the fraction of the
        // map this half carries — the geometry has the rest.
        // METRES TO BASE UV, dividing by the TERRAIN SIZE — the same unit `_displacementAt` bakes the
        // geometry half in, so `dispScale` means one thing on the slider and the two halves compose.
        //
        // It was briefly `/ tiling`, to match a standard material's "depth in UV units"
        // (chunks/pbrGBuffer.wgsl). That is wrong here, and the arithmetic says so plainly: dividing by
        // the tiling multiplies the WORLD depth by the repeat size in metres. On a 400 m terrain at
        // tiling 31 the repeat is 12.9 m, so an authored 0.06 m became 0.62 m of marched relief — POM
        // offsetting uv by half a metre at grazing angles, which reads as smearing. It looked right when
        // checked against a mesh only because a mesh's texture repeats about every metre, making that
        // factor ~1.
        //
        // Two things settle the direction. The formulas AGREE wherever the repeat is about a metre, and
        // `/ size` stays bounded where the tiling is coarse while `/ tiling` explodes. And under
        // `/ tiling` the number needed for 5 cm of relief at these settings is 0.004 — below the
        // slider's own 0.005 step, so the correct value was not even expressible.
        //
        // What DOES make relief read like a mesh's is the texture's world scale, not this conversion:
        // at tiling 31 one brick spans 3.2 m and 6 cm of depth is 2% of it, where the same map on a mesh
        // gives 25 cm bricks and 24%. The inspector surfaces the repeat in metres so that is visible.
        m.properties.set(`u_marchDepth${index}`,
            this._layerAmplitude(L) * this._layerReliefDetail(L) * (top - bot)
            / Math.max(this._cfg.size, 1e-6));
    }

    /**
     * The marched half's extra depth, 1 when the layer has no material to read it from.
     *
     * Deliberately NOT folded into `_layerAmplitude`: that number is the physical relief depth in
     * metres and the geometry bake depends on it meaning exactly that. See `TerrainMaterial.reliefDetail`.
     */
    private _layerReliefDetail(L: TerrainLayer): number {
        return Math.max(0, L.material?.reliefDetail ?? 1);
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

        // The derived density reads the displaced layers' tiling, so a layer change invalidates it —
        // and may change it, which means the chunks have to be rebuilt at the new one.
        this._invalidateDensity();
        this._rebuildChunksIfDensityChanged();
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
            this._surfaceRev++;   // the splat drives the displaced-layer weights
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
            renderDensity: this._cfg.renderDensity,
            targetVertsPerTile: this._cfg.targetVertsPerTile,
            // Marks the unit each layer's `displacementScale` is stored in. Absent means the blob
            // predates the change and `deserialize` migrates it — see there.
            depthUnit: 'metres',
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
            size: json.size, resolution: json.resolution, chunkQuads: json.chunkQuads,
            // Absent in anything saved before the option existed, and `resolveConfig` defaults it to 1 —
            // which is the unchanged mesh, so an old terrain reloads exactly as it was.
            renderDensity: json.renderDensity,
            // Absent before the control existed; `resolveConfig` defaults it, so an old terrain reloads
            // with the same detail target a new one gets.
            targetVertsPerTile: json.targetVertsPerTile,
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
                    // the number in the Depth box changes, from something whose meaning depended on the
                    // terrain's size to something that reads as a distance.
                    //
                    // It lands on the parsed COPY, which is what this terrain uses. The library asset it
                    // came from is migrated separately, by `migrateTerrainMaterialDepth` on the editor
                    // side — an earlier version of this comment called that "unavoidable" and it was
                    // not: the conversion needs a terrain size, and every path that assigns a library
                    // material to a layer has a terrain in hand. Skipping it there meant re-saving a
                    // material re-applied the raw pre-metres number, ten times too shallow.
                    //
                    // Guarded by the MATERIAL's own stamp as well as the terrain's, so that whichever
                    // side converted it first, the other cannot convert it again and square the factor.
                    if (json.depthUnit !== 'metres' && !tm.depthIsMetres) {
                        tm.displacementScale *= json.size / Math.max(lj.tiling ?? tm.tiling, TILING_EPSILON);
                        tm.depthIsMetres = true;
                    }
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
