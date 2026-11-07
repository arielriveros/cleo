import { vec3, mat4 } from 'gl-matrix';
import type { Frustum } from '../../core/frustum';
import { Scene } from '../../core/scene/scene';
import { FOLIAGE_DENSITY_FALLOFF, collectOrphanedFoliageBuffers, collectOrphanedFoliageMeshes, foliageEffectiveCull, foliageLodBands, foliageCullLimitSq, foliageAdmitCount, FOLIAGE_SORT_REFRESH, sortFoliageFrontToBack, foliageKeepFraction, createFoliageBatch, foliageBatchStale, foliageBatchInstances, rememberFoliageBatch, foliageChunkBounds, foliageChunkLimit, packFoliageInstances } from '../../terrain/foliage';
import type { FoliageCell, FoliageLayer, FoliageBand, FoliageBatch } from '../../terrain/foliage';
import { FoliageGpuCuller } from '../foliageGpuCulling';
import type { GpuCullBucket, GpuFoliageSegment } from '../foliageGpuCulling';
import { FoliageInteraction } from '../foliageInteraction';
import { isFoliageMaterial, Material } from '../material';
import { Mesh } from '../mesh';
import { Model } from '../model';
import { usesParallax, foliageProgramFor } from '../programVariants';
import { frameStats } from '../renderStats';
import type { RenderPassEncoder } from '../rhi/device';
import { device } from '../rhi/deviceHandle';
import type { Buffer as RhiBuffer } from '../rhi/resources';
import { BufferUsage } from '../rhi/types';
import { shadowTouchesSphere, shadowFarthestFrom } from '../shadowCasters';
import { CascadeSphere, HASH_SEED, mixNumber } from '../shadowMath';
import { TextureManager } from '../systems/textureManager';
import { TexturePacker } from '../systems/texturePacker';
import { ShadowMapImpostorProgram, ShadowMapInstancedCutoutProgram, ShadowMapInstancedProgram, GEOMETRY_PROGRAMS, GeometryFoliageBillboardProgram, GeometryFoliageImpostorProgram } from './programs';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';
import { DEPTH_WRITE } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';
import { ModelDraw } from './modelDraw';
import type { RenderSubsystems } from './subsystems';

/** A foliage layer's cells bucketed on the ground plane, for the shadow pass's range query. */
export interface FoliageCellGrid {
    cells: readonly FoliageCell[];
    version: number;
    minX: number; minZ: number; size: number; cols: number; rows: number;
    /** The largest cell's half-extent on the ground: how far past a bucket its cells can reach. */
    reach: number;
    start: Int32Array;
    items: Int32Array;
}

/** How a foliage layer moves and looks this frame (Renderer._foliageWind). */
export interface FoliageState {
    /** Whether its foliage materials draw through the foliage variants (false: a billboard's wind alone). */
    foliage: boolean;
    lean: number; stiffness: number; minY: number; height: number; radius: number; fadeEnd: number;
    bend: number; recovery: number;
    /**
     * How far the plant bows under a full load of rain or snow, as a fraction of its height (its materials'
     * weightDroop). The weather AT each plant scales it, in the vertex stage (chunks/instancedVertex.wgsl).
     */
    droop: number;
}

/** What FoliagePasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface FoliagePassesHost {
    readonly thumbnailMode: boolean;
}

/**
 * Landscape foliage in the frame: per-layer GPU upload, the cell scan with distance hysteresis,
 * frustum and occlusion tests and LOD bands (or the GPU culler on WebGPU), wind, weather and
 * interaction uniforms, octahedral impostors, the shadow casters per cascade, and the colour pass with
 * its depth prepass. Split out of Renderer.
 */
export class FoliagePasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: FoliagePassesHost,
                private readonly _view: FrameView,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection,
                private readonly _sys: RenderSubsystems) {}

    /** See RenderSettings.foliageShadowDistance. */
    public foliageShadowDistance = 0;

    /** See RenderSettings.foliagePrepass. */
    public foliagePrepass = false;

    /** See RenderSettings.foliageGpuCulling. */
    public foliageGpuCulling = true;
    private readonly _foliageGpu = new FoliageGpuCuller();

    /** The frame the GPU culler last ran: it may run once per frame (see foliageGpuCulling.ts). */
    private _foliageGpuFrame = -1;

    // Foliage cells beyond this camera distance are skipped (world units; 0 = disabled).
    public foliageCullDistance: number = 65;

    // Foliage spatial-grid cell size (world units); smaller = tighter culling, more draw calls.
    // MUST match FoliageLayer.cellSize's default, or the first frame after every load rebuilds the grid.
    public foliageCellSize: number = 13;

    /**
     * Hysteresis on the foliage DISTANCE CULL: a visible cell stays visible out to
     * `cullDistance × this`, while a hidden one only appears at `cullDistance`.
     *
     * Without a band the cull is a bare `d2 > maxD2` and a cell sitting on the boundary flips in and out
     * on sub-metre camera jitter — each flip costing its whole instance count in draws. The per-cell LOD
     * band immediately below the cull already damps itself by ×0.9 for the same reason, as does
     * LodGroupNode; the cull was the one transition left undamped.
     */
    private _foliageCullHysteresis: number = 1.1;

    /**
     * How many NEWLY visible foliage cells may be admitted per frame, per layer.
     *
     * Crossing the cull boundary is a step change: the frame a cell is admitted must draw its entire
     * instance count × every prototype, with nothing amortising it. Admitting the nearest few per frame
     * spreads that ramp over a handful of frames. A cell that was already visible is NEVER delayed, so
     * this can only ever hold back the far edge of the view, where a cell arriving two frames late is
     * imperceptible. 0 disables the budget.
     */
    private _foliageAdmitPerFrame: number = 4;

    /**
     * Density scaling: how much of a detail level's instances survive, per level away from the base.
     *
     * LOD reduces what ONE instance costs; this reduces how many there are. Neither bounds a scatter on
     * its own — density times area can ask for hundreds of millions of triangles and nothing
     * downstream refuses. 1.0 turns it off and draws every instance, which is what happened before it
     * existed. See `foliageKeepFraction`.
     */
    public foliageDensityFalloff: number = FOLIAGE_DENSITY_FALLOFF;

    /**
     * Bring every foliage layer's GPU state up to date. Must run BEFORE the shadow pass. Every foliage
     * mesh is packed with `blinn_phongGeometry`'s five attributes, whichever program later draws it —
     * which is why its pipelines say `builtFor: 'blinn_phongGeometry'`.
     */
    public ensureFoliageUploaded(scene: Scene): void {
        // Buffers of layers disposed with their terrain. Drained ahead of the landscape loop — no live
        // landscape can reach them per-layer.
        for (const buf of collectOrphanedFoliageBuffers()) buf.destroy();
        for (const mesh of collectOrphanedFoliageMeshes()) mesh.dispose();

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.count === 0) continue;

                if (!layer.initialized) FoliagePasses._initLayer(layer);

                // Keep the layer's grid at the current global cell size (re-buckets only on change).
                if (layer.cellSize !== this.foliageCellSize) layer.setCellSize(this.foliageCellSize);

                // The prototype meshes a prototype swap retired. Freed here rather than at the swap
                // because this pass owns the GL context and the edit does not.
                for (const mesh of layer.collectRetiredMeshes()) mesh.dispose();

                // Instance matrices are NOT uploaded here. They go up per DRAW BUCKET, merged across
                // the cells that survive culling — see `_prepareFoliage`. A per-cell buffer would be
                // a second copy of the same matrices, and the buffers of the ~90% of cells outside the
                // cull distance would sit in VRAM for a frame that never draws them.
            }
        }

        this._prepareFoliage(scene);
    }

    /** Create a layer's prototype meshes (every level and its billboard) the first time it is drawn. */
    private static _initLayer(layer: FoliageLayer): void {
        const initModel = (model: Model) => {
            const g = model.geometry;
            model.mesh.create(g.getData(['position', 'normal', 'uv', 'tangent', 'bitangent']), g.vertexCount, g.indices);
        };
        for (const level of layer.levels) for (const m of level.models) initModel(m);
        if (layer.billboardModel) initModel(layer.billboardModel);
        layer.initialized = true;
    }

    /**
     * Cull every foliage layer's cells, bucket them by detail level, and upload each bucket's merged
     * instance buffer.
     *
     * Separated from `foliagePass`, which now only binds and draws, for one reason: **an instance
     * upload must never happen while a render pass is open.** `reallocateBuffer`/`writeBuffer` land on a
     * buffer that a pass may already have bound as a vertex source, and asking a driver to re-specify or
     * map one mid-pass is how a frame ends in `mapResource` failing and the D3D11 device being removed.
     * The per-cell buffers this replaced were uploaded here for the same reason; merging them must not
     * quietly give that invariant up.
     *
     * It also has to run before the SHADOW pass, because `cell.visible` is the state the shadow cull's
     * hysteresis reads.
     */
    private _prepareFoliage(scene: Scene): void {
        const camPos = this._view.camera.position;
        // The GPU path for the main view only, once a frame: its per-bucket parameters go up with
        // `writeBuffer`, which a second cull in the same unsubmitted frame would overwrite under the first.
        const gpu = this.foliageGpuCulling && FoliageGpuCuller.supported && this._sys.visibility.frustumCulling
            && !this._host.thumbnailMode && !this._view.capturing && !this._view.cubeFace
            && this._foliageGpuFrame !== this._view.frameIndex;
        if (gpu) this._foliageGpuFrame = this._view.frameIndex;

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                layer.buckets.length = 0;
                if (layer.count === 0 || !layer.initialized) continue;

                // How far this layer draws: its own cull, or past its last LOD/impostor band (see
                // foliageEffectiveCull — "unset" used to mean the scene's 65 m, which hid every LOD level
                // and the impostor of anything taller than a bush).
                const cullDistance = foliageEffectiveCull(layer, this.foliageCullDistance);
                const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;

                // Visible cells bucketed by detail level so shader/material binds stay one-per-level.
                // Bucket index levels.length is the billboard-impostor bucket.
                const billboardBucket = layer.levels.length;
                const buckets = layer.buckets;
                // Where each bucket fades in and out, per instance (chunks/instancedVertex.wgsl). A cell
                // straddling a band edge goes into BOTH neighbouring buckets; the dissolve does the rest.
                const bands = foliageLodBands(layer, cullDistance);
                this._foliageBands.set(layer, bands);
                const camX = camPos[0], camY = camPos[1], camZ = camPos[2];
                const place = (cell: FoliageCell) => {
                    // The cell's distance SPAN, from its instance origins (not the geometry-padded box).
                    const dn = Math.sqrt(this._sys.visibility.aabbDistSq(camPos, cell.pmin, cell.pmax));
                    const fx = Math.max(Math.abs(camX - cell.pmin[0]), Math.abs(camX - cell.pmax[0]));
                    const fy = Math.max(Math.abs(camY - cell.pmin[1]), Math.abs(camY - cell.pmax[1]));
                    const fz = Math.max(Math.abs(camZ - cell.pmin[2]), Math.abs(camZ - cell.pmax[2]));
                    const df = Math.sqrt(fx * fx + fy * fy + fz * fz);
                    let first = -1;
                    for (let slot = 0; slot <= billboardBucket; slot++) {
                        const band = bands[slot];
                        if (!band || band.lo > df || band.hi < dn) continue;
                        (buckets[slot] ??= []).push(cell);
                        if (first < 0) first = slot;
                    }
                    cell.lod = Math.max(0, first);
                };

                // Newly in-range cells, nearest first. Off-screen ones are admitted for free (nothing is
                // drawn, so nothing pops); only on-screen arrivals spend the budget — which is what keeps
                // turning around from revealing trees that trickle in a few cells per frame.
                const pending: { cell: FoliageCell; d2: number; onScreen: boolean }[] = [];
                // Was ANY cell of this layer already up? If not, this is the layer's first sight — a
                // scene load, the camera reaching a new landscape, or a rebuild after a brush stroke —
                // and everything is admitted at once rather than faded in over a second.
                let anyWasVisible = false;
                frameStats.foliageCellsScanned += layer.cells.length;
                for (const cell of layer.cells) {
                    // Read BEFORE any cull branch: a cell that is up but frustum-culled this frame still
                    // proves the layer is up.
                    const wasVisible = cell.visible;
                    anyWasVisible ||= wasVisible;
                    const d2 = this._sys.visibility.aabbDistSq(camPos, cell.min, cell.max);
                    // Distance cull with a hysteresis band, so a cell on the boundary cannot flip every
                    // frame. Instances themselves dissolve out before the cull (the last band's ramp), so
                    // the step here is never seen.
                    const limit2 = foliageCullLimitSq(maxD2, wasVisible, this._foliageCullHysteresis);
                    if (d2 > limit2) {
                        frameStats.culledInstances += cell.count;
                        cell.visible = false;
                        continue;
                    }
                    // Off screen also when an occluder hides it: an occluded cell is ADMITTED like an
                    // off-screen one (so it appears at once when revealed) and simply not drawn.
                    let onScreen = !this._sys.visibility.frustumCulling || this._sys.visibility.frustum.intersectsAABB(cell.min, cell.max);
                    if (onScreen && this._sys.visibility.cellOccluded(cell.min, cell.max)) {
                        onScreen = false;
                        frameStats.occludedCells++;
                    }
                    // `visible` means ADMITTED: in range, whether or not it is on screen this frame.
                    if (!wasVisible && this._foliageAdmitPerFrame > 0) {
                        pending.push({ cell, d2, onScreen });
                        if (onScreen) frameStats.culledInstances += cell.count;
                        continue;
                    }
                    cell.visible = true;
                    if (!onScreen) { frameStats.culledInstances += cell.count; continue; }
                    place(cell);
                }

                // Admit the waiting cells and draw the admitted on-screen ones THIS frame (they used to
                // wait one more, which is a frame of missing trees on every arrival).
                if (pending.length) {
                    pending.sort((a, b) => a.d2 - b.d2);
                    let onScreenPending = 0;
                    for (const p of pending) if (p.onScreen) onScreenPending++;
                    let budget = foliageAdmitCount(onScreenPending, this._foliageAdmitPerFrame, !anyWasVisible);
                    for (const p of pending) {
                        if (!p.onScreen) { p.cell.visible = true; continue; }
                        if (budget <= 0) continue;
                        budget--;
                        p.cell.visible = true;
                        place(p.cell);
                        frameStats.culledInstances -= p.cell.count;
                    }
                }

                // The two nearest detail levels nearest first (see sortFoliageFrontToBack): that is where
                // trees overlap on screen and overdraw costs. The order is taken from an eye that only
                // moves every few metres, so a walking camera does not repack the batches every frame.
                if (!layer.sortEye || vec3.distance(layer.sortEye, camPos) > FOLIAGE_SORT_REFRESH)
                    layer.sortEye = [camPos[0], camPos[1], camPos[2]];
                for (let slot = 0; slot < Math.min(2, billboardBucket); slot++)
                    if (buckets[slot]) sortFoliageFrontToBack(buckets[slot], layer.sortEye);

                if (gpu) {
                    this._cullFoliageOnGpu(layer, bands);
                    continue;
                }
                layer.gpuCulled = false;

                // Merge and upload while no pass is open. A bucket left null by the loop above still has
                // to be visited, or its batch keeps last frame's cells and draws them again.
                for (let slot = 0; slot <= billboardBucket; slot++) {
                    const models = slot === billboardBucket
                        ? (layer.billboardModel ? [layer.billboardModel] : [])
                        : layer.levels[slot].models;
                    // Density scaling rides on the BUCKET, not on raw distance: `cell.lod` is already
                    // hysteresis-damped and already decides membership, so the fraction is constant
                    // within a bucket and the batch's own staleness check covers a change for free.
                    const keep = foliageKeepFraction(slot, layer.levels.length, this.foliageDensityFalloff, layer.kind);
                    this._packFoliageBucket(layer, layer.batches, slot, buckets[slot] ??= [], models, keep);
                }
            }
        }
    }

    /**
     * The GPU half of {@link _prepareFoliage} for one layer: hand each colour bucket's cells to the compute
     * cull (graphics/foliageGpuCulling.ts) instead of packing their matrices here. Recorded into the
     * frame's encoder, so it runs before the geometry pass that draws its output.
     */
    private _cullFoliageOnGpu(layer: FoliageLayer, bands: (FoliageBand | null)[]): void {
        const billboardBucket = layer.levels.length;
        const buckets: GpuCullBucket[] = [];
        for (let slot = 0; slot <= billboardBucket; slot++) {
            const models = slot === billboardBucket
                ? (layer.billboardModel ? [layer.billboardModel] : [])
                : layer.levels[slot].models;
            const octa = slot === billboardBucket ? layer.billboardOctahedral : null;
            buckets.push({
                cells: layer.buckets[slot] ?? [],
                models,
                band: bands[slot] ?? null,
                keep: foliageKeepFraction(slot, layer.levels.length, this.foliageDensityFalloff, layer.kind),
                sphere: octa ? [octa.center[0], octa.center[1], octa.center[2], octa.radius * 1.05] : FoliagePasses._modelsSphere(models),
            });
        }
        layer.gpuBatches = this._foliageGpu.cull(this._passes.acquireEncoder('foliage.cull'), layer, buckets,
                                                 this._sys.visibility.frustum.planes, this._view.camera.position);
        layer.gpuCulled = true;
    }

    /** The bounding sphere (model space) of a set of sub-models: centre and radius of their union box. */
    private static _modelsSphere(models: readonly Model[]): [number, number, number, number] {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const m of models) {
            const b = m.geometry.boundingBox;
            for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.min[a]); hi[a] = Math.max(hi[a], b.max[a]); }
        }
        if (!(hi[0] >= lo[0])) return [0, 0, 0, 0];
        const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
        return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, r];
    }

    /**
     * The shadow half of {@link _prepareFoliage}: pick and upload the cells one cascade will rasterize,
     * and return a hash of what it picked for the cascade's layer cache.
     *
     * Called from `_renderCascades` BEFORE the cascade's depth pass opens, for the upload reason given
     * there. It sets `_shadowFrustum` itself rather than borrowing the one `_renderShadowCasters`
     * builds, because that runs inside the pass, after this. A cell is kept on the same terms as a model
     * caster: its shadow volume must reach the cascade's `sphere` and, past cascade 0, the receiver shell
     * (`eye`, `inner`) — see graphics/shadowCasters.ts.
     */
    public prepareFoliageShadow(scene: Scene, lightSpace: mat4, cascade: number,
                                  sphere: CascadeSphere, eye: ArrayLike<number>, inner: number): number {
        this._sys.shadows.shadowFrustum.setFromViewProjection(lightSpace);
        const d = this._sys.shadows.shadowLightUnit;
        let hash = HASH_SEED;

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (!this._foliageCastsShadows(layer)) continue;

                // Each cell's shadow volume must reach this cascade's sphere and, past cascade 0, its
                // receiver shell — the cells a model caster would keep — and sit in its light frustum.
                const candidates = this._foliageShadowCandidates(layer);
                const visible = this._foliageScratchCells;
                visible.length = 0;
                for (let i = 0; i < candidates.count; i++) {
                    const cell = candidates.cells[i];
                    const o = i * 5, b = candidates.bounds;
                    const cx = b[o], cy = b[o + 1], cz = b[o + 2], r = b[o + 3], reach = b[o + 4];
                    if (!shadowTouchesSphere(cx, cy, cz, r, d, reach, sphere)) continue;
                    if (inner > 0 && shadowFarthestFrom(cx, cy, cz, r, d, reach, eye) < inner) continue;
                    if (!this._sys.shadows.shadowFrustum.intersectsAABB(cell.min, cell.max)) continue;
                    visible.push(cell);
                }
                // Nearest the sun first, so a tree in front fills the depth before the needles behind it
                // reach the early depth test. Order only: the same cells, the same shadow.
                if (visible.length > 1)
                    visible.sort((a, b) =>
                        (a.min[0] + a.max[0]) * d[0] + (a.min[1] + a.max[1]) * d[1] + (a.min[2] + a.max[2]) * d[2]
                        - ((b.min[0] + b.max[0]) * d[0] + (b.min[1] + b.max[1]) * d[1] + (b.min[2] + b.max[2]) * d[2]));
                // The cheapest real level is what casts, so it decides the chunk size too — or, in an outer
                // cascade, the impostor's one quad.
                const impostor = this._impostorCasts(layer, cascade);
                if (impostor) this._impostorModels[0] = layer.billboardModel!;
                const models = impostor ? this._impostorModels
                    : layer.kind === 'billboard' ? layer.levels[0].models
                    : layer.levels[layer.levels.length - 1].models;
                // The SAME fraction the cheapest colour level keeps. Thinning the two differently would
                // leave shadows with no tree above them, or trees with no shadow beneath them, and the
                // prefix rule makes the two sets identical rather than merely the same size.
                const keep = foliageKeepFraction(layer.levels.length - 1, layer.levels.length,
                                                 this.foliageDensityFalloff, layer.kind);
                this._packFoliageBucket(layer, layer.shadowBatches, cascade, visible, models, keep);

                // What this layer puts in the cascade: which cells, at which version and thinning, drawn
                // from which meshes — and, where the cascade sways it, the wind's clock.
                hash = mixNumber(mixNumber(mixNumber(hash, this._sys.modelDraw.objectId(layer)), layer.version), keep);
                hash = mixNumber(hash, visible.length);
                for (const cell of visible) hash = mixNumber(hash, cell.index);
                for (const model of models)
                    hash = mixNumber(mixNumber(hash, this._sys.modelDraw.objectId(model.mesh)), model.mesh.activeIndexCount);
                if (cascade === 0) {
                    const w = this._foliageWind(scene, layer);
                    // The droop is per plant now, from the weather volumes: their hash moves the bend.
                    if (w) hash = mixNumber(mixNumber(mixNumber(hash, this._view.windTime), w.droop),
                                            w.droop > 0 ? this.weatherHash : 0);
                }
            }
        }
        this._impostorModels[0] = undefined!;
        return hash;
    }

    /** The one-model list an impostor-cast bucket is chunked by. Never holds a model past the call. */
    private readonly _impostorModels: Model[] = [undefined!];

    /** From this cascade out, a layer with an octahedral impostor casts through it. See `_impostorCasts`. */
    private static readonly IMPOSTOR_SHADOW_CASCADE = 1;

    /**
     * Does `layer` cast into `cascade` through its octahedral impostor (shadowMapImpostor.wgsl) rather than
     * its cheapest mesh level? From IMPOSTOR_SHADOW_CASCADE out, where a texel is a few centimetres and the
     * shadow's penumbra wider still, so the impostor's own resolution never shows; never in cascade 0. Only
     * once its atlas is decoded, and never for a card impostor, which has no view from the sun.
     */
    private _impostorCasts(layer: FoliageLayer, cascade: number): boolean {
        if (cascade < FoliagePasses.IMPOSTOR_SHADOW_CASCADE || layer.kind === 'billboard') return false;
        if (!layer.billboardModel || !layer.billboardOctahedral || !layer.billboardTextureId) return false;
        return !!TextureManager.Instance.getTexture(layer.billboardTextureId);
    }

    /**
     * Draw one layer's packed shadow chunks as light-facing impostor quads: one instanced draw per chunk,
     * the atlas's coverage cut out, each texel at the depth of a round canopy (shadowMapImpostor.wgsl).
     */
    private _drawImpostorShadows(layer: FoliageLayer, chunks: FoliageBatch[], lightSpace: mat4,
                                 pass: RenderPassEncoder): void {
        const model = layer.billboardModel!, info = layer.billboardOctahedral!;
        const albedo = TextureManager.Instance.getTexture(layer.billboardTextureId!);
        if (!albedo) return;
        const pipeline = this._pipelines.get('shadowMapImpostorInstanced', ShadowMapImpostorProgram, {
            // The quad is rebuilt facing the light in the vertex stage, so it never shows its back.
            cullMode: 'none',
            depthStencil: DEPTH_WRITE,
            targets: 0,
            vertex: 'model+instance',
            builtFor: 'blinn_phongGeometry',
        });
        pass.setPipeline(pipeline);
        const clip = this._projection.clipProjection(lightSpace);
        this._shaderManager.setUniform('u_lightSpace', clip);
        // Window depth per world unit along the light: the clip matrix's z row against the light direction,
        // halved where clip depth spans [-1, 1] (WebGL2) rather than [0, 1].
        const d = this._sys.shadows.shadowLightUnit, v = this._impostorShadowVec;
        v[0][0] = d[0]; v[0][1] = d[1]; v[0][2] = d[2];
        v[0][3] = (clip[2] * d[0] + clip[6] * d[1] + clip[10] * d[2]) * (device.capabilities.conventions.clipDepthZeroToOne ? 1 : 0.5);
        v[1][0] = info.frames; v[1][1] = info.radius; v[1][2] = albedo.config.flipY ? 1 : 0;
        v[2][0] = info.center[0]; v[2][1] = info.center[1]; v[2][2] = info.center[2];
        this._shaderManager.setUniform('u_lightDir', v[0]);
        this._shaderManager.setUniform('u_impostor', v[1]);
        this._shaderManager.setUniform('u_impostorCenter', v[2]);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [albedo]));
        for (const batch of chunks) {
            if (batch.count === 0 || !batch.buffer) continue;
            this.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
            frameStats.foliageShadowDraws++;
        }
    }

    private readonly _impostorShadowVec: [number[], number[], number[]] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    /**
     * The cells of one layer that cast at all this frame — inside the colour pass's cull distance and the
     * foliage shadow distance — with each one's bounding sphere and shadow reach, found ONCE per frame.
     * Every cascade used to walk every cell of the layer for this, and a large terrain has tens of
     * thousands of them; each cascade now tests only these.
     */
    private _foliageShadowCandidates(layer: FoliageLayer): { count: number; cells: FoliageCell[]; bounds: Float32Array } {
        let entry = this._foliageCandidates.get(layer);
        if (!entry) { entry = { frame: -1, count: 0, cells: [], bounds: new Float32Array(0) }; this._foliageCandidates.set(layer, entry); }
        if (entry.frame === this._view.frameIndex) return entry;
        entry.frame = this._view.frameIndex;

        const camPos = this._view.camera.position;
        const cullDistance = foliageEffectiveCull(layer, this.foliageCullDistance);
        const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;
        // The shadow distance, with its own hysteresis band (appear inside it, vanish 10% past it).
        const shadowD = this.foliageShadowDistance;
        const shadowIn2 = shadowD > 0 ? shadowD * shadowD : Infinity;
        const shadowOut2 = shadowD > 0 ? (shadowD * 1.1) * (shadowD * 1.1) : Infinity;

        // Only the cells near enough to pass both tests, through a coarse grid over the layer; a cell the
        // grid skips is one the tests below would reject.
        const reachMax = Math.min(Math.sqrt(foliageCullLimitSq(maxD2, true, this._foliageCullHysteresis)),
                                  Math.sqrt(shadowOut2));
        const near = this._foliageCellsNear(layer, camPos, reachMax);
        const stamp = this._foliageCellStamp(layer);
        const frame = this._view.frameIndex;
        // Last frame's candidates, before this frame's overwrite them: see the clean-up below.
        const previous = this._foliagePreviousCells;
        previous.length = 0;
        for (let k = 0; k < entry.count; k++) previous.push(entry.cells[k]);
        let n = 0;
        for (let k = 0; k < near.count; k++) {
            const cell = near.cells[k];
            stamp[cell.index] = frame;
            // The same distance cull as the colour pass, hysteresis band included, so a cell on the
            // boundary does not flicker its shadow in and out. `cell.visible` is READ, never written, here:
            // `_prepareFoliage` owns that flag and clears it on the distance test alone, which makes it
            // exactly "inside the damped cull range".
            const limit2 = foliageCullLimitSq(maxD2, cell.visible, this._foliageCullHysteresis);
            const d2 = this._sys.visibility.aabbDistSq(camPos, cell.min, cell.max);
            if (d2 > limit2) continue;
            const casts = d2 <= (cell.shadowCast ? shadowOut2 : shadowIn2);
            cell.shadowCast = casts;
            if (!casts) continue;
            if (entry.bounds.length < (n + 1) * 5) {
                const grown = new Float32Array(Math.max(64, entry.bounds.length * 2) * 5);
                grown.set(entry.bounds);
                entry.bounds = grown;
            }
            const lo = cell.min, hi = cell.max, o = n * 5;
            const cx = (lo[0] + hi[0]) * 0.5, cy = (lo[1] + hi[1]) * 0.5, cz = (lo[2] + hi[2]) * 0.5;
            const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.5;
            entry.bounds[o] = cx; entry.bounds[o + 1] = cy; entry.bounds[o + 2] = cz; entry.bounds[o + 3] = r;
            entry.bounds[o + 4] = this._sys.shadows.shadowReachOf(cx, cy, cz, r);
            entry.cells[n++] = cell;
        }
        // A cell that cast last frame and is now past the grid's reach was not visited: it is past the
        // shadow distance, so its hysteresis memory goes, as the full scan used to clear it.
        for (const cell of previous) if (stamp[cell.index] !== frame) cell.shadowCast = false;
        previous.length = 0;
        entry.cells.length = n;
        entry.count = n;
        frameStats.foliageCellsScanned += near.count;
        return entry;
    }

    /**
     * The cells of `layer` whose centre lies within `radius` (plus the largest cell's half-extent) of `p`
     * on the ground plane, through a 64 m bucket grid built once per layer version. Unbounded radius:
     * every cell.
     */
    private _foliageCellsNear(layer: FoliageLayer, p: ArrayLike<number>, radius: number): { count: number; cells: FoliageCell[] } {
        const out = this._foliageNearScratch;
        out.count = 0;
        const cells = layer.cells;
        if (!Number.isFinite(radius)) {
            for (const cell of cells) out.cells[out.count++] = cell;
            return out;
        }
        let grid = this._foliageCellGrids.get(layer);
        if (!grid || grid.cells !== cells || grid.version !== layer.version) {
            grid = FoliagePasses._buildCellGrid(cells, layer.version);
            this._foliageCellGrids.set(layer, grid);
        }
        if (grid.cols === 0) return out;
        const r = radius + grid.reach;
        const c0 = Math.max(0, Math.floor((p[0] - r - grid.minX) / grid.size));
        const c1 = Math.min(grid.cols - 1, Math.floor((p[0] + r - grid.minX) / grid.size));
        const r0 = Math.max(0, Math.floor((p[2] - r - grid.minZ) / grid.size));
        const r1 = Math.min(grid.rows - 1, Math.floor((p[2] + r - grid.minZ) / grid.size));
        for (let row = r0; row <= r1; row++)
            for (let col = c0; col <= c1; col++) {
                const b = row * grid.cols + col;
                for (let i = grid.start[b]; i < grid.start[b + 1]; i++) out.cells[out.count++] = cells[grid.items[i]];
            }
        return out;
    }

    private readonly _foliageNearScratch: { count: number; cells: FoliageCell[] } = { count: 0, cells: [] };

    private readonly _foliagePreviousCells: FoliageCell[] = [];
    private readonly _foliageCellGrids = new WeakMap<FoliageLayer, FoliageCellGrid>();
    private readonly _foliageCellStamps = new WeakMap<FoliageLayer, Int32Array>();

    /** Per cell of `layer`, the frame the candidate scan last visited it. */
    private _foliageCellStamp(layer: FoliageLayer): Int32Array {
        let stamp = this._foliageCellStamps.get(layer);
        if (!stamp || stamp.length < layer.cells.length) {
            stamp = new Int32Array(Math.max(16, layer.cells.length)).fill(-1);
            this._foliageCellStamps.set(layer, stamp);
        }
        return stamp;
    }

    /** Bucket `cells` by centre into 64 m squares (counting sort: `start` per bucket, then `items`). */
    private static _buildCellGrid(cells: readonly FoliageCell[], version: number): FoliageCellGrid {
        const size = 64;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, reach = 0;
        for (const c of cells) {
            const x = (c.min[0] + c.max[0]) * 0.5, z = (c.min[2] + c.max[2]) * 0.5;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            reach = Math.max(reach, Math.hypot(c.max[0] - c.min[0], c.max[2] - c.min[2]) * 0.5);
        }
        if (cells.length === 0)
            return { cells, version, minX: 0, minZ: 0, size, cols: 0, rows: 0, reach: 0,
                     start: new Int32Array(1), items: new Int32Array(0) };
        const cols = Math.max(1, Math.floor((maxX - minX) / size) + 1);
        const rows = Math.max(1, Math.floor((maxZ - minZ) / size) + 1);
        const bucketOf = (c: FoliageCell) => {
            const col = Math.min(cols - 1, Math.floor(((c.min[0] + c.max[0]) * 0.5 - minX) / size));
            const row = Math.min(rows - 1, Math.floor(((c.min[2] + c.max[2]) * 0.5 - minZ) / size));
            return row * cols + col;
        };
        const start = new Int32Array(cols * rows + 1);
        for (const c of cells) start[bucketOf(c) + 1]++;
        for (let b = 0; b < cols * rows; b++) start[b + 1] += start[b];
        const fill = start.slice(0, cols * rows);
        const items = new Int32Array(cells.length);
        for (let i = 0; i < cells.length; i++) items[fill[bucketOf(cells[i])]++] = i;
        return { cells, version, minX, minZ, size, cols, rows, reach, start, items };
    }

    private readonly _foliageCandidates = new WeakMap<FoliageLayer,
        { frame: number; count: number; cells: FoliageCell[]; bounds: Float32Array }>();

    /** Whether this layer rasterizes into the shadow cascades at all. One test, two call sites. */
    private _foliageCastsShadows(layer: FoliageLayer): boolean {
        return layer.castShadows && layer.count > 0 && layer.initialized;
    }

    /**
     * Rasterize opted-in foliage layers into the bound cascade layer.
     *
     * Four departures from the colour pass: cells cull against the LIGHT's frustum; `cell.lod` is never
     * written, since the colour pass reads it back for hysteresis; the detail level is fixed rather
     * than distance-picked; and the batch is keyed on `cascade`, because each cascade sees a different
     * set of cells and the distant ones are rasterized on different frames (they are staggered).
     *
     * The cell scan is hoisted ABOVE the model loop. It used to run inside it, so a tree with three
     * sub-models paid three full walks of every cell in the layer, per cascade, to reach the same
     * answer each time.
     */
    public foliageShadowPass(scene: Scene, lightSpace: mat4, cascade: number,
                               pass: RenderPassEncoder): void {
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (!this._foliageCastsShadows(layer)) continue;
                // Packed by `prepareFoliageShadow` before this pass opened, in chunks small enough to
                // keep one submission bounded.
                const chunks = layer.shadowBatches[cascade];
                if (!chunks || chunks.length === 0) continue;
                if (this._impostorCasts(layer, cascade)) {
                    this._drawImpostorShadows(layer, chunks, lightSpace, pass);
                    continue;
                }

                const billboard = layer.kind === 'billboard';
                // Only the nearest cascade sways: farther cascades' texels are larger than the motion, and
                // keeping them static bounds the shadow cost of wind to the near field.
                const wind = cascade === 0 ? this._foliageWind(scene, layer) : null;
                // Billboards route every level through the cutout shader (they have only one level);
                // mesh layers cast from their CHEAPEST real level.
                const models = billboard ? layer.levels[0].models : layer.levels[layer.levels.length - 1].models;

                for (const model of models) {
                    // Per-MODEL, never per-layer: a tree's solid bark and its cut-out leaves arrive as
                    // two sub-models of the same prototype and need different programs.
                    //
                    // A billboard's shape IS its texture's alpha and it has no material to consult, so
                    // 0.5 stays the threshold there — it is the impostor's own convention. Mesh foliage
                    // goes through the SAME resolver every other caster uses, so a leaf material's mask
                    // and its real threshold apply instead.
                    const cut = billboard
                        ? (() => {
                            const tex = layer.textureId ? TextureManager.Instance.getTexture(layer.textureId) : null;
                            return tex ? { texture: tex, cutoff: 0.5, useRed: false } : null;
                        })()
                        : this._sys.shadows.shadowCutoutOf(model.material);
                    const cutout = !!cut;
                    // A cut-out caster culls nothing — its shape is in the texture and its card is
                    // two-sided; a solid prop keeps the FRONT-face culling the rest of the shadow pass
                    // uses to push acne out of view.
                    // A foliage material moves its shadow (wind, interaction, droop); a billboard's card sways
                    // with its rule's wind; anything else on the layer casts still.
                    const moves = !!wind && (billboard ? !wind.foliage : wind.foliage && isFoliageMaterial(model.material));
                    const program = (cutout ? 'shadowMapInstancedCutout' : 'shadowMapInstanced')
                        + (!moves ? '' : billboard ? 'Wind' : 'Foliage');
                    const pipeline = this._pipelines.get(
                        program,
                        cutout ? ShadowMapInstancedCutoutProgram : ShadowMapInstancedProgram, {
                        cullMode: cutout || model.material.config.side === 'double' ? 'none' : 'front',
                        depthStencil: DEPTH_WRITE,
                        targets: 0,
                        vertex: 'model+instance',
                        builtFor: 'blinn_phongGeometry',
                    });
                    pass.setPipeline(pipeline);
                    this._shaderManager.setUniform('u_lightSpace', this._projection.clipProjection(lightSpace));
                    if (moves) this._setWindUniforms(scene, wind!, model.material);
                    if (cutout) {
                        this._shaderManager.setUniform('u_cutoff', cut!.cutoff);
                        this._shaderManager.setUniform('u_useRed', cut!.useRed);
                        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [cut!.texture]));
                    }

                    for (const batch of chunks) {
                        if (batch.count === 0 || !batch.buffer) continue;
                        this.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
                        frameStats.foliageShadowDraws++;
                    }
                }
            }
        }
    }

    private _windClock: number = -1;

    /** This frame's foliage interaction stamps (graphics/foliageInteraction.ts). */
    public readonly foliageInteraction = new FoliageInteraction();

    /** A layer prototype's [base height, plant height] in object space, keyed on its first model. */
    private readonly _windShapes = new WeakMap<Model, [number, number, number]>();

    public advanceWindTime(): void {
        const now = performance.now();
        const dt = this._windClock < 0 ? 0 : Math.min(0.1, Math.max(0, (now - this._windClock) / 1000));
        this._windClock = now;
        this._view.windTimePrev = this._view.windTime;
        this._view.windTime += dt;
    }

    /**
     * How `layer` moves and looks this frame, or null when nothing of it runs the foliage path.
     *
     * A MESH layer answers only through its FOLIAGE materials (Material.Foliage): with none it is null, and
     * no foliage code runs for it at all. With any, `foliage` is true and its foliage models draw through
     * the foliage variants -- wind (0 without a WindNode), interaction (0 without stamps), the weather's
     * droop, and the surface's variation and weather. A BILLBOARD layer (far cards, a foliage rule's own
     * wind) takes the wind-only variant, and only while it actually sways.
     *
     * Per LAYER, never per sub-model. A tree's bark and needles are separate models, and they stay
     * attached only if they bend by exactly the same function — so the strongest material speaks for
     * the whole prototype, and the bend is measured against the whole prototype's height.
     */
    private _foliageWind(scene: Scene, layer: FoliageLayer): FoliageState | null {
        const node = scene.wind;
        const windOn = !!node && node.visible && node.strength > 0;
        const pushed = this.foliageInteraction.count > 0;
        const billboard = layer.kind === 'billboard';
        const models = billboard ? [layer.model] : layer.levels[0]?.models ?? [];
        if (models.length === 0) return null;
        let lean = 0, stiffness = 1, flutters = false, bend = 0, recovery = 1, droop = 0, foliage = false;
        for (const model of models)
            for (const material of model.materials) {
                // A billboard's card carries its rule's wind; a mesh layer listens to foliage materials only.
                if (!billboard && !isFoliageMaterial(material)) continue;
                foliage = foliage || !billboard;
                const give = Number(material.properties.get('interactBend') ?? 0);
                if (give > bend) {
                    bend = give;
                    recovery = Number(material.properties.get('interactRecovery') ?? 1) || 1;
                }
                const strength = Number(material.properties.get('windStrength') ?? 0);
                if (strength > lean) {
                    lean = strength;
                    stiffness = Number(material.properties.get('windStiffness') ?? 1) || 1;
                }
                if (material.properties.get('windRole') === 'leaves' && Number(material.properties.get('windFlutter') ?? 0.5) > 0)
                    flutters = true;
                droop = Math.max(droop, Number(material.properties.get('weightDroop') ?? 0) || 0);
            }
        // Leaves that flutter on a plant that does not lean still move: the trunk simply stays put.
        if (!windOn) { lean = 0; flutters = false; }
        if (!pushed) bend = 0;
        // No weather volume in the frame: nothing bows, whatever the materials could.
        if (this.weatherHash === 0) droop = 0;
        if (!foliage && !(lean > 0) && !flutters) return null;
        let shape = this._windShapes.get(models[0]);
        if (!shape) {
            let minY = Infinity, maxY = -Infinity, radius = 0;
            for (const model of models) {
                const box = model.geometry.boundingBox;
                minY = Math.min(minY, box.min[1]);
                maxY = Math.max(maxY, box.max[1]);
                // Horizontal reach from the trunk axis (the prototype's local Y), for the leaf weighting.
                radius = Math.max(radius, Math.abs(box.min[0]), Math.abs(box.max[0]), Math.abs(box.min[2]), Math.abs(box.max[2]));
            }
            // A billboard card has no trunk: radius 0 tells the shader to weight its flutter by height alone.
            if (billboard) radius = 0;
            shape = Number.isFinite(minY) && maxY > minY ? [minY, maxY - minY, radius] : [0, 1, 0];
            this._windShapes.set(models[0], shape);
        }
        // The motion fades by the wind's own distances; interaction alone, as far as stamps are made
        // (foliageInteraction INTERACT_RANGE).
        const fadeEnd = windOn ? Math.max(node!.fadeEnd, pushed ? 45 : 0) : 45;
        return { foliage, lean, stiffness, minY: shape[0], height: shape[1], radius: shape[2], fadeEnd, bend, recovery,
                 droop };
    }

    private readonly _windVec: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    /**
     * The vertex-stage wind block of the program just bound; see WindParams in foliageWind.wgsl. Per
     * MODEL: the bend is the layer's, but whether these surfaces add leaf motion is their material's.
     * A foliage program also gets the interaction stamps, the droop and (for the surface) the weather.
     */
    private _setWindUniforms(scene: Scene, w: FoliageState, material: Material): void {
        const node = scene.wind;
        const windOn = !!node && node.visible && node.strength > 0;
        const [dx, dz] = windOn ? node!.directionXZ : [1, 0];
        const cam = this._view.camera.position;
        const [g, t, r, sh, c] = this._windVec;
        g[0] = dx; g[1] = dz; g[2] = windOn ? node!.strength : 0; g[3] = windOn ? node!.gustScale : 18;
        t[0] = this._view.windTime; t[1] = this._view.windTimePrev; t[2] = windOn ? node!.gustSpeed : 4; t[3] = w.fadeEnd;
        r[0] = w.lean; r[1] = w.stiffness;
        const leaves = material.properties.get('windRole') === 'leaves';
        r[2] = leaves ? Math.max(0, Number(material.properties.get('windFlutter') ?? 0.5) || 0) : 0;
        r[3] = leaves ? 1 : 0;
        sh[0] = w.minY; sh[1] = w.height; sh[2] = windOn ? Math.min(node!.fadeStart, w.fadeEnd - 1) : w.fadeEnd - 10; sh[3] = w.radius;
        c[0] = cam[0]; c[1] = cam[1]; c[2] = cam[2];
        this._shaderManager.setUniform('u_windGlobal', g);
        this._shaderManager.setUniform('u_windTime', t);
        this._shaderManager.setUniform('u_windResponse', r);
        this._shaderManager.setUniform('u_windShape', sh);
        this._shaderManager.setUniform('u_windCamera', c);
        if (!w.foliage) return;
        const ix = this._interactVec;
        ix[0] = w.bend > 0 ? this.foliageInteraction.count : 0; ix[1] = w.bend; ix[2] = w.recovery; ix[3] = w.radius;
        this._shaderManager.setUniform('u_interact', ix);
        this._shaderManager.setUniform('u_interactStamps', this.foliageInteraction.stamps);
        this._droopVec[0] = w.droop;
        this._shaderManager.setUniform('u_foliageDroop', this._droopVec);
    }

    private readonly _droopVec: number[] = [0, 0, 0, 0];

    /**
     * The frame's weather volumes (render/weather.ts), as foliage needs them: their hash (0 with none),
     * which the shadow cache keys the droop on, and the snow's colour (linear rgb) and roughness.
     */
    public weatherHash: number = 0;
    public readonly snowColor: number[] = [0.9, 0.9, 0.9, 0.85];

    /**
     * The surface half of the weather (chunks/foliageSurface.wgsl), after the material block is written:
     * the snow's colour. How wet and how snowy each plant is arrives per plant from the vertex stage.
     */
    private _setFoliageWeather(_w: FoliageState): void {
        this._shaderManager.setUniform('u_material.foliageSnow', this.snowColor);
    }

    private readonly _interactVec: number[] = [0, 0, 0, 0];

    /** Each foliage layer's per-bucket fade bands, as `_prepareFoliage` last computed them. */
    private readonly _foliageBands = new WeakMap<FoliageLayer, (FoliageBand | null)[]>();
    private readonly _lodVec: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    /**
     * The per-instance LOD crossfade block of the instanced program just bound (u_lodBand/Camera/Frame
     * in chunks/instancedVertex.wgsl). Billboard GRASS layers shrink out instead of dissolving.
     */
    private _setLodFadeUniforms(layer: FoliageLayer, slot: number): void {
        const band = this._foliageBands.get(layer)?.[slot] ?? null;
        const [b, c, f] = this._lodVec;
        if (band) { b[0] = band.inStart; b[1] = band.inEnd; b[2] = band.outStart; b[3] = band.outEnd; }
        else { b[0] = b[1] = b[2] = b[3] = 0; }
        const cam = this._view.camera.position;
        c[0] = cam[0]; c[1] = cam[1]; c[2] = cam[2];
        c[3] = !band ? 0 : layer.kind === 'billboard' ? 2 : 1;
        // A different dither phase every frame, so TAA resolves the screen-door into a smooth blend.
        f[0] = ((this._view.frameIndex * 7) % 16) / 16;
        // The leaf translucency the impostor program writes into the G-buffer (the mesh
        // levels read it off their own materials instead).
        f[1] = layer.farTranslucency;
        this._shaderManager.setUniform('u_lodBand', b);
        this._shaderManager.setUniform('u_lodCamera', c);
        this._shaderManager.setUniform('u_lodFrame', f);
        // Every foliage program reads the hole block too, so it is written on every bind, never only on
        // the layers that opt in: a uniform keeps its last value.
        this._materials.setCameraHole(layer.cameraDither);
    }

    /** The (slot, model) pairs whose prepass depth went down this layer: see `foliagePass`. */
    private readonly _prepassScratch = new Set<number>();

    /** Whether every material maps by its mesh uv (no box or triplanar projection): the lean foliage test. */
    private static _meshUvOnly(materials: readonly Material[]): boolean {
        return materials.every(m => !((m.properties.get('uvProjection') as number) > 0));
    }

    // --- GI Volume captures ------------------------------------------------------------------------------

    /**
     * A GI capture face, before its pass opens: each layer's cells within `reach` of `eye` that `frustum`
     * sees, packed into capture slot `index`'s OWN buffers. Every face of a capture batch is drawn in one
     * frame, and a buffer written twice before the frame's submit would hold only the second write.
     * Mesh layers pack their cheapest real level; billboard layers (grass) only when `grass`. Whatever the
     * main camera's distance culls, LOD bands and density thinning, a probe sees every plant in reach.
     * Returns whether there is anything to draw.
     */
    public prepareCapture(scene: Scene, index: number, eye: ArrayLike<number>, frustum: Frustum,
                          reach: number, grass: boolean): boolean {
        let any = false;
        const reach2 = reach * reach;
        for (const landscape of scene.landscapes) {
            if (!landscape.authoredVisible) continue;
            for (const layer of landscape.terrain.foliage) {
                let lists = this._captureBatches.get(layer);
                if (!lists) { lists = []; this._captureBatches.set(layer, lists); }
                const chunks = lists[index];
                if (chunks) for (const c of chunks) c.count = 0;
                if (layer.count === 0 || layer.levels.length === 0) continue;
                if (!grass && (layer.kind === 'billboard' || this._grassLike(layer))) continue;
                // A capture can run before the frame first draws the layer (a bake loading with the scene).
                if (!layer.initialized) FoliagePasses._initLayer(layer);
                const near = this._foliageCellsNear(layer, eye, reach);
                const cells = this._captureCells;
                cells.length = 0;
                for (let k = 0; k < near.count; k++) {
                    const cell = near.cells[k];
                    if (this._sys.visibility.aabbDistSq(eye as vec3, cell.min, cell.max) > reach2) continue;
                    if (!frustum.intersectsAABB(cell.min, cell.max)) continue;
                    cells.push(cell);
                }
                if (cells.length === 0) continue;
                // A fresh version each time: the batch's own change test compares cell lists, and this
                // slot's list is another probe's every batch.
                if (chunks) for (const c of chunks) c.version = -1;
                this._packFoliageBucket(layer, lists, index, cells, FoliagePasses._captureModels(layer), 1);
                any = true;
            }
        }
        return any;
    }

    /**
     * A GI capture face's plants into the capture G-buffer (`pass`, its viewport set), through the frame's
     * instanced G-buffer programs with no wind, no LOD band and no camera hole: what `prepareCapture` packed
     * for `index`. The view is the frame view's camera, which the capture has swapped for its own.
     */
    public drawCapture(scene: Scene, pass: RenderPassEncoder, index: number): number {
        let draws = 0;
        const cam = this._view.camera;
        for (const landscape of scene.landscapes) {
            if (!landscape.authoredVisible) continue;
            for (const layer of landscape.terrain.foliage) {
                const chunks = this._captureBatches.get(layer)?.[index];
                if (!chunks || !chunks.some(c => c.count > 0 && !!c.buffer)) continue;
                const billboard = layer.kind === 'billboard';
                for (const model of FoliagePasses._captureModels(layer)) {
                    const pbr = model.material.type === 'pbr';
                    const parallax = !billboard && pbr && usesParallax(model.materials);
                    const lean = !parallax && FoliagePasses._meshUvOnly(model.materials);
                    const shaderType = foliageProgramFor({ billboard, sway: false, foliage: false, parallax,
                                                           afterPrepass: false, lean, pbr });
                    const reflection = billboard ? GeometryFoliageBillboardProgram : GEOMETRY_PROGRAMS[shaderType];
                    this._shaderManager.bind(shaderType);
                    this._shaderManager.setUniform('u_view', cam.viewMatrix);
                    this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(cam.projectionMatrix));
                    this._setCaptureLodUniforms(layer);
                    const pipeline = this._pipelines.get(shaderType, reflection, {
                        cullMode: billboard ? 'none' : ModelDraw.cullFor(model.material.config.side),
                        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                        targets: 3,
                        vertex: 'model+instance',
                        builtFor: 'blinn_phongGeometry',
                    });
                    pass.setPipeline(pipeline);
                    if (billboard) {
                        const tex = layer.textureId ? TextureManager.Instance.getTexture(layer.textureId) : null;
                        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [tex ?? this._bindGroups.fallbackTexture]));
                    } else {
                        this._materials.applyProperties(model.material);
                        pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, model.material));
                    }
                    for (const batch of chunks) {
                        if (batch.count === 0 || !batch.buffer) continue;
                        this.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
                        draws++;
                    }
                }
            }
        }
        return draws;
    }

    /**
     * Whether a mesh layer is grass in all but name: a prototype under 0.8 m tall (meadow tufts, the
     * Foliage Creator's grass), which a GI capture leaves out with the billboard grass unless asked.
     */
    private _grassLike(layer: FoliageLayer): boolean {
        let known = this._grassLayers.get(layer);
        if (known !== undefined) return known;
        let lo = Infinity, hi = -Infinity;
        for (const model of layer.levels[0]?.models ?? []) {
            const pos = model.geometry?.positions;
            if (!pos) continue;
            for (let i = 1; i < pos.length; i += 3) { if (pos[i] < lo) lo = pos[i]; if (pos[i] > hi) hi = pos[i]; }
        }
        known = Number.isFinite(lo) && hi - lo < 0.8;
        this._grassLayers.set(layer, known);
        return known;
    }

    private readonly _grassLayers = new WeakMap<FoliageLayer, boolean>();

    /** What a capture draws of `layer`: a billboard layer's cards, a mesh layer's cheapest real level. */
    private static _captureModels(layer: FoliageLayer): Model[] {
        return layer.kind === 'billboard' ? layer.levels[0].models : layer.levels[layer.levels.length - 1].models;
    }

    /** The LOD block of a capture draw: no band (every plant whole), no dither phase, no camera hole. */
    private _setCaptureLodUniforms(layer: FoliageLayer): void {
        const [b, c, f] = this._lodVec;
        b[0] = b[1] = b[2] = b[3] = 0;
        const cam = this._view.camera.position;
        c[0] = cam[0]; c[1] = cam[1]; c[2] = cam[2]; c[3] = 0;
        f[0] = 0;
        f[1] = layer.farTranslucency;
        this._shaderManager.setUniform('u_lodBand', b);
        this._shaderManager.setUniform('u_lodCamera', c);
        this._shaderManager.setUniform('u_lodFrame', f);
        this._materials.setCameraHole(false);
    }

    /** Per layer, per GI capture slot: the batches `prepareCapture` packed. */
    private readonly _captureBatches = new WeakMap<FoliageLayer, FoliageBatch[][]>();
    private readonly _captureCells: FoliageCell[] = [];

    public foliagePass(scene: Scene, pass: RenderPassEncoder): void {
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.buckets.length === 0) continue;

                // Bucket index levels.length is the billboard-impostor bucket. Everything here was
                // culled, merged and uploaded by `_prepareFoliage`, before this pass opened — see the
                // note there for why that separation is load-bearing rather than tidiness.
                const billboardBucket = layer.levels.length;
                const wind = this._foliageWind(scene, layer);
                // Which buckets take the depth prepass: the two nearest real levels of a MESH layer, where
                // leaves overlap on screen. Billboards gain nothing — their colour pass is already one fetch.
                // Nor a layer the camera hole is cutting into: the colour pass after a prepass has no
                // discard, so the depth the prepass wrote would show through as a solid silhouette.
                const prepassSlots = this.foliagePrepass && layer.kind !== 'billboard' && !this._materials.cameraHoleOn(layer.cameraDither)
                    ? Math.min(2, billboardBucket) : 0;
                const prepassed = (model: Model, slot: number) => slot < prepassSlots && model.material.type === 'pbr'
                    && !usesParallax(model.materials) && FoliagePasses._meshUvOnly(model.materials);

                // The prepass itself, every eligible model of those buckets before any is shaded, so one
                // sub-model's leaves already occlude another's when the colour pass runs. A model whose
                // depth did NOT go down (a draw the RHI path refused) must not be shaded 'equal' after it.
                const depthWritten = this._prepassScratch;
                depthWritten.clear();
                for (let slot = 0; slot < prepassSlots; slot++) {
                    const cells = layer.buckets[slot];
                    const chunks = this.colourChunks(layer, slot);
                    if (!cells?.length || !chunks?.length) continue;
                    for (const model of layer.levels[slot].models) {
                        if (!prepassed(model, slot)) continue;
                        const sway = !!wind?.foliage && isFoliageMaterial(model.material);
                        const shaderType = sway ? 'pbrGeometryInstancedPrepassFoliage' : 'pbrGeometryInstancedPrepass';
                        this._shaderManager.bind(shaderType);
                        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
                        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
                        if (sway) this._setWindUniforms(scene, wind!, model.material);
                        this._setLodFadeUniforms(layer, slot);
                        const pipeline = this._pipelines.get(shaderType, GEOMETRY_PROGRAMS[shaderType], {
                            cullMode: ModelDraw.cullFor(model.material.config.side),
                            depthStencil: DEPTH_WRITE,
                            targets: 3, colorWrite: false,
                            vertex: 'model+instance', builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        this._materials.applyProperties(model.material);
                        if (sway) this._setFoliageWeather(wind!);
                        pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, model.material));
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            this.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
                            frameStats.foliageDraws++;
                        }
                        depthWritten.add(slot * 4096 + layer.levels[slot].models.indexOf(model));
                    }
                }

                const drawBucket = (models: Model[], billboard: boolean, slot: number) => {
                    const cells = layer.buckets[slot];
                    if (!cells || cells.length === 0) return;
                    const chunks = this.colourChunks(layer, slot);
                    if (!chunks || chunks.length === 0) return;
                    frameStats.foliageCells += cells.length;

                    // Real levels only: the impostor never sways. A billboard layer's cards sway with their rule's
                    // wind while a level starts inside the fade (past it the displacement is exactly zero).
                    const real = !!wind && slot < billboardBucket;
                    const windy = real && layer.levels[slot].distance < wind!.fadeEnd;
                    for (const model of models) {
                        const parallax = !billboard && model.material.type === 'pbr' && usesParallax(model.materials);
                        // FOLIAGE materials take the foliage variants at every real level: variation and weather
                        // are part of how they look, not only motion, so they must not pop off with distance.
                        // A marching (POM) foliage prop stays still and plain rather than drop its relief.
                        const foliage = real && !billboard && wind!.foliage && isFoliageMaterial(model.material)
                            && model.material.type === 'pbr' && !parallax;
                        const sway = billboard ? windy && !wind!.foliage : foliage;
                        // A mesh-uv PBR prop takes the LEAN program: no projection charts, no parallax frame,
                        // no specular AA — the derivative work every foliage fragment paid for nothing.
                        const lean = !parallax && FoliagePasses._meshUvOnly(model.materials);
                        // After a prepass: no discard (the depth it wrote, tested 'equal', does the cutting),
                        // which is what lets this one keep early-Z and shade each pixel once.
                        const afterPrepass = !billboard && prepassed(model, slot)
                            && depthWritten.has(slot * 4096 + models.indexOf(model));
                        const shaderType = foliageProgramFor({ billboard, sway, foliage, parallax, afterPrepass, lean,
                                                               pbr: model.material.type === 'pbr' });
                        const reflection = billboard ? GeometryFoliageBillboardProgram
                                                     : GEOMETRY_PROGRAMS[shaderType];
                        this._shaderManager.bind(shaderType);
                        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
                        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
                        if (sway) this._setWindUniforms(scene, wind!, model.material);
                        this._setLodFadeUniforms(layer, slot);
                        const pipeline = this._pipelines.get(shaderType, reflection, {
                            // Billboard cross quads are two-sided; a mesh prop keeps its material side.
                            cullMode: billboard ? 'none' : ModelDraw.cullFor(model.material.config.side),
                            depthStencil: afterPrepass
                                ? { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'equal' }
                                : { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                            targets: 3,   // the G-buffer
                            vertex: 'model+instance',
                            builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        if (billboard) {
                            const texId = layer.kind === 'billboard' ? layer.textureId : layer.billboardTextureId;
                            // The edge-padded copy once `_ensurePackedTextures` has baked it.
                            const padded = texId ? TexturePacker.Instance.dilatedId(texId, 0.5) : null;
                            const tex = (padded ? TextureManager.Instance.getTexture(padded) : null)
                                ?? (texId ? TextureManager.Instance.getTexture(texId) : null);
                            pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0,
                                                                       [tex ?? this._bindGroups.fallbackTexture]));
                        } else {
                            this._materials.applyProperties(model.material);
                            if (foliage) this._setFoliageWeather(wind!);
                            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, model.material));
                        }

                        // Every chunk shares the binds above; only the instance buffer differs.
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            this.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
                            frameStats.foliageDraws++;
                        }
                    }
                };

                for (let i = 0; i < layer.levels.length; i++)
                    drawBucket(layer.levels[i].models, layer.kind === 'billboard', i);
                if (layer.billboardModel && layer.billboardOctahedral)
                    this._drawOctahedralImpostors(layer, billboardBucket, pass);
                else if (layer.billboardModel)
                    drawBucket([layer.billboardModel], true, billboardBucket);
            }
        }
    }

    /**
     * A mesh layer's OCTAHEDRAL impostor bucket: one camera-facing quad per instance, its baked views picked
     * and blended per instance (geometryFoliageImpostor.wgsl). Drawn like the card it replaces — same
     * chunks, same crossfade band — with the atlas and its normals bound instead of a material.
     */
    private _drawOctahedralImpostors(layer: FoliageLayer, slot: number, pass: RenderPassEncoder): void {
        const cells = layer.buckets[slot], chunks = this.colourChunks(layer, slot);
        const model = layer.billboardModel, info = layer.billboardOctahedral;
        if (!cells?.length || !chunks?.length || !model || !info) return;
        frameStats.foliageCells += cells.length;
        const albedo = layer.billboardTextureId ? TextureManager.Instance.getTexture(layer.billboardTextureId) : null;
        const normal = layer.billboardNormalTextureId ? TextureManager.Instance.getTexture(layer.billboardNormalTextureId) : null;
        // Nothing to draw it with yet (still decoding): skip rather than draw black quads.
        if (!albedo || !normal) return;

        this._shaderManager.bind('foliageImpostorInstanced');
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
        this._setLodFadeUniforms(layer, slot);
        const v = this._impostorVec;
        // Which way up the atlas sits in its texture: see `atlasUv` in geometryFoliageImpostor.wgsl.
        v[0][0] = info.frames; v[0][1] = info.radius; v[0][2] = albedo.config.flipY ? 1 : 0;
        v[1][0] = info.center[0]; v[1][1] = info.center[1]; v[1][2] = info.center[2];
        this._shaderManager.setUniform('u_impostor', v[0]);
        this._shaderManager.setUniform('u_impostorCenter', v[1]);
        const pipeline = this._pipelines.get('foliageImpostorInstanced', GeometryFoliageImpostorProgram, {
            // The quad is rebuilt facing the camera in the vertex stage, so it can never show its back.
            cullMode: 'none',
            depthStencil: DEPTH_WRITE,
            targets: 3,   // the G-buffer
            vertex: 'model+instance',
            builtFor: 'blinn_phongGeometry',
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [albedo, normal]));
        for (const batch of chunks) {
            if (batch.count === 0 || !batch.buffer) continue;
            this.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
            frameStats.foliageDraws++;
        }
    }

    private readonly _impostorVec: [number[], number[]] = [[0, 0, 0, 0], [0, 0, 0, 0]];
    public static readonly LOD_OFF = [0, 0, 0, 0];

    /**
     * Merge a draw bucket's visible cells into ONE instance buffer, and return it ready to draw.
     *
     * Null when the bucket is empty. `batches` is the layer's colour or shadow list and `slot` the
     * bucket within it (detail level, impostor, or cascade), so each keeps its own buffer and its own
     * memory of which cells it holds.
     *
     * The repack is skipped whenever the cell set and the layer version are unchanged, which is the
     * common case: the distance cull's hysteresis band and the admission budget exist precisely to keep
     * that set stable, so a parked camera uploads nothing at all and a moving one pays one upload per
     * bucket that actually changed. `reallocateBuffer` re-specifies the storage in place, so the VAO
     * built over this buffer survives — and because there is now ONE buffer per bucket instead of one
     * per cell, that VAO is also built once instead of once per cell per sub-model.
     */
    private _packFoliageBatch(layer: FoliageLayer, batches: FoliageBatch[], slot: number,
                              cells: FoliageCell[], keep: number = 1): FoliageBatch | null {
        let batch = batches[slot];
        if (!batch) batch = batches[slot] = createFoliageBatch();
        if (!foliageBatchStale(batch, cells, layer.version, keep)) return batch.count > 0 ? batch : null;

        const instances = foliageBatchInstances(cells, keep);
        rememberFoliageBatch(batch, cells, layer.version, keep);
        batch.count = instances;
        if (instances === 0) return null;

        if (!batch.buffer)
            batch.buffer = device.createBuffer({ label: 'foliage.batchMatrices', size: 0,
                                                usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        if (instances > batch.capacity) {
            // Grow, with slack: a camera crossing a cell boundary changes the set by one cell, and
            // re-specifying the whole buffer for that would make the driver rename it every frame.
            const capacity = Math.max(instances, Math.ceil(batch.capacity * 1.5), 64);
            this._packFoliageScratch(layer, cells, capacity, keep);
            batch.buffer = device.reallocateBuffer(batch.buffer,
                                                   layer.batchScratch.subarray(0, capacity * 16));
            batch.capacity = capacity;
        } else {
            this._packFoliageScratch(layer, cells, instances, keep);
            device.writeBuffer(batch.buffer, 0, layer.batchScratch.subarray(0, instances * 16));
        }
        return batch;
    }

    /**
     * Merge one draw bucket's cells into as few instance buffers as a bounded submission allows.
     *
     * ONE buffer would be ideal and is what the draw-call count wants, but a merged draw has no upper
     * bound on its work: `generateFoliageEverywhere` plus a layer's first sight puts every cell on
     * screen in the same frame, and a heavy prototype at that scale is a multi-second submission — a
     * TDR timeout and a removed device. The bucket is therefore cut into chunks sized from the
     * prototype's own triangle count. Grass stays one or two draws; a 200k-triangle tree gets many, and
     * still fewer than the one-per-cell it replaced.
     *
     * `models` is the bucket's sub-models: the heaviest decides, because each is drawn separately over
     * the same instances, so the per-DRAW cost is instances x that model's triangles.
     */
    private _packFoliageBucket(layer: FoliageLayer, lists: FoliageBatch[][], slot: number,
                               cells: FoliageCell[], models: Model[], keep: number = 1): void {
        const chunks = lists[slot] ??= [];

        let trianglesPerInstance = 0;
        for (const m of models)
            trianglesPerInstance = Math.max(trianglesPerInstance, m.mesh.activeIndexCount / 3);
        const bounds = foliageChunkBounds(cells, foliageChunkLimit(trianglesPerInstance),
                                          this._foliageChunkBounds);

        let start = 0;
        for (let k = 0; k < bounds.length; k++) {
            if (!chunks[k]) chunks[k] = createFoliageBatch();
            // `slice` allocates, but only once per chunk per frame and only when the set moved — the
            // batch below returns early on an unchanged one.
            this._packFoliageBatch(layer, chunks, k, cells.slice(start, bounds[k]), keep);
            start = bounds[k];
        }
        // Chunks the bucket no longer needs: emptied rather than destroyed, so a set that oscillates
        // across a boundary reuses their storage instead of reallocating it.
        for (let k = bounds.length; k < chunks.length; k++) {
            chunks[k].count = 0;
            chunks[k].cellCount = 0;
            chunks[k].version = -1;
        }
    }

    private readonly _foliageChunkBounds: number[] = [];

    /** Pack `cells` into the layer's staging array, sized for at least `capacity` instances. */
    private _packFoliageScratch(layer: FoliageLayer, cells: FoliageCell[], capacity: number,
                                keep: number): void {
        const floats = capacity * 16;
        if (layer.batchScratch.length < floats) layer.batchScratch = new Float32Array(floats);
        packFoliageInstances(cells, layer.batchScratch, keep);
    }

    /**
     * Reused list of the cells one prepare step is about to pack. Never held across steps — the shadow
     * prepare refills it per layer per cascade, and the colour prepare has the layer's own buckets.
     */
    private readonly _foliageScratchCells: FoliageCell[] = [];

    // Record one foliage cell's instanced draw. The pipeline MUST be told
    // `builtFor: 'blinn_phongGeometry'` — every foliage mesh is initialised from its five attributes,
    // whatever program later draws it.
    public recordFoliageDraw(pass: RenderPassEncoder, mesh: Mesh,
                               instances: RhiBuffer, count: number, batch?: FoliageBatch): void {
        // LODs are NOT a special case: a level is an alternate index buffer over the same vertices,
        // and `activeIndexBuffer` names the selected one.
        const indices = mesh.activeIndexBuffer;
        const indirect = (batch as GpuFoliageSegment | undefined)?.indirect;
        // A GPU-culled segment's instance count exists only on the GPU, so it needs an indexed mesh.
        if (indirect) {
            const offset = indirect.offsets.get(mesh);
            if (offset === undefined || mesh.isAnimated || !indices) return;
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setVertexBuffer(1, instances, indirect.vertexOffset);
            pass.setIndexBuffer(indices, mesh.activeIndexFormat);
            pass.drawIndexedIndirect(indirect.args, offset);
            return;
        }
        this._passes.recordInstancedDraw(pass, mesh, instances, count);
    }

    /**
     * A colour bucket's draw chunks: the GPU-culled segments when this frame's prepare culled the layer
     * on the GPU, else the CPU-packed batches. Kept apart so a capture drawn on the CPU path in the same
     * frame can never repack a segment the main view's draws were recorded against.
     */
    public colourChunks(layer: FoliageLayer, slot: number): FoliageBatch[] | undefined {
        return layer.gpuCulled ? layer.gpuBatches[slot] : layer.batches[slot];
    }
}
