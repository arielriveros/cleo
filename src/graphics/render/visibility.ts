import { mat4, vec3 } from 'gl-matrix';
import { Camera } from '../../core/camera';
import { Frustum } from '../../core/frustum';
import { LightNode } from '../../core/scene/nodes/lightNode';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Scene } from '../../core/scene/scene';
import { TerrainLodSettings } from '../../terrain/terrain';
import type { Terrain } from '../../terrain/terrain';
import { GpuOcclusion, GPU_OCCLUSION_BUDGET } from '../gpuOcclusion';
import { OcclusionBuffer } from '../occlusion/occlusionBuffer';
import { OcclusionVolumes } from '../occlusion/occlusionVolumes';
import type { VolumeContentSource, VolumeLike, VolumeQueries } from '../occlusion/occlusionVolumes';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import type { SpriteNode } from '../../core/scene/nodes/spriteNode';
import type { ParticleSystemNode } from '../../core/scene/nodes/particleSystemNode';
import type { DecalNode } from '../../core/scene/nodes/decalNode';
import type { FluidVolumeNode } from '../../core/scene/nodes/fluidVolumeNode';
import { OcclusionReuseKey } from '../occlusion/occlusionReuse';
import { TerrainOccluder } from '../occlusion/terrainOccluder';
import type { OccluderGrid } from '../occlusion/terrainOccluder';
import { frameStats } from '../renderStats';
import { device } from '../rhi/deviceHandle';
import type { OcclusionQuerySet } from '../rhi/resources';
import { OcclusionBoxProgram } from './programs';
import type { OcclusionMode } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { BindGroupCache } from './bindGroups';
import { DEPTH_TEST } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';
import type { RenderSubsystems } from './subsystems';
import { renderNow } from './renderClock';

/** Built frames in a row that hid nothing before occlusion backs off, and how often it probes then. */
const OCCLUSION_IDLE_FRAMES = 30;
const OCCLUSION_IDLE_PROBE = 8;

/** What Visibility reads from the renderer that owns it: its own state, not another subsystem's. */
export interface VisibilityHost {
    readonly selectedNodeId: string | null;
    readonly thumbnailMode: boolean;
}

/**
 * What the current view can see: the camera frustum, the CPU occlusion buffer (landscapes), GPU
 * occlusion queries for nodes and light reaches, occlusion volumes (whose contents are skipped while
 * the volume's box cannot be seen), the distance LOD of landscapes and LOD groups, and the animation
 * LOD stamp. Every per-view visibility test goes
 * through here, which keeps the geometry pass, the forward overlay and the velocity pass in
 * agreement. Split out of Renderer.
 */
export class Visibility {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: VisibilityHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _sys: RenderSubsystems) {}

    // Per-object camera frustum culling for the main color passes. Rebuilt each frame from _view.viewProj.
    public frustum: Frustum = new Frustum();
    public frustumCulling: boolean = true;

    /** See RenderSettings.occlusionCulling. */
    public occlusionMode: OcclusionMode = 'all';

    /** This frame's occluders, rasterized on the CPU (graphics/occlusion/occlusionBuffer.ts). */
    public readonly occlusion = new OcclusionBuffer(256, 144);

    /** Whether `occlusion` describes the view being drawn right now (never during a capture). */
    private _occlusionActive = false;

    /** The camera `occlusion` was built for: a probe or thumbnail capture draws through another. */
    private _occlusionCamera: Camera | null = null;

    /** Per landscape: its lowered occluder mesh, rebuilt when its heights change. */
    private readonly _terrainOccluders = new WeakMap<Terrain, { version: number; builtAt: number;
                                                               origin: [number, number, number]; occluder: TerrainOccluder }>();

    /** Per node, this frame: whether it is occluded (`outsideFrustum` asks up to four times a frame). */
    private readonly _occludedMemo = new Map<ModelNode, boolean>();
    private readonly _occMin = [0, 0, 0];
    private readonly _occMax = [0, 0, 0];
    public readonly occlusionFrameStats = { triangles: 0, ms: 0 };

    /** See RenderSettings.occlusionQueries, and graphics/gpuOcclusion.ts. */
    public occlusionQueriesEnabled = true;

    /** See RenderSettings.lightOcclusionCulling. */
    public lightOcclusionCulling = true;

    /** Per light, this frame: whether its reach is hidden (see `lightOccluded`). */
    public readonly lightOccludedMemo = new Map<LightNode, boolean>();
    public readonly gpuOcclusion = new GpuOcclusion();
    private _occlusionQueries: OcclusionQuerySet | null = null;

    /** Whether this frame's view takes and acts on GPU occlusion queries, and for which camera. */
    private _gpuOcclusionActive = false;
    private _gpuOcclusionCamera: Camera | null = null;
    private readonly _gpuOcclusionForward = [0, 0, -1];
    private readonly _gpuOcclusionModel = mat4.create();
    /**
     * Per query slot, the owner its box record is kept under in the per-object table, and this frame's
     * record. A token per SLOT, not the node: the node's own record (its world matrix) must not be
     * displaced by its box, and the table compares by value, so a slot that changes node stays correct.
     */
    private readonly _gpuOcclusionOwners: object[] = [];
    private readonly _gpuOcclusionRecords: number[] = [];

    /**
     * Occlusion volumes (graphics/occlusion/occlusionVolumes.ts): this frame's answer for the main view —
     * what is hidden because the box it lies inside cannot be seen. Decided by `updateOcclusionVolumes`,
     * read through `volumeCulled` / `volumeShadowCulled`.
     */
    public readonly volumes = new OcclusionVolumes();
    /** Whether `volumes` holds an answer, and for which camera (a capture draws through another). */
    private _volumesActive = false;
    private _volumeCamera: Camera | null = null;
    /** The volume counters, kept for the HUD past `resetFrameStats` (which runs later in the frame). */
    public readonly volumeFrameStats = { tested: 0, hidden: 0, culledNodes: 0 };

    /** Consecutive built frames in which occlusion hid nothing, and the frames skipped since (see `buildOcclusion`). */
    private _occlusionIdleFrames = 0;
    private _occlusionSkipped = 0;

    /** What `occlusion` was last fully built from: a frame with the same inputs keeps it (see `buildOcclusion`). */
    private readonly _occlusionKey = new OcclusionReuseKey();

    // Distance-based terrain LOD: chunks past distance1/distance2 drop to a grid decimated by step1/step2
    // (triangles scale by 1/step²). Applied per chunk, per frame, before the shadow passes.
    public terrainLodEnabled: boolean = true;
    public terrainLodDistance1: number = 120;
    public terrainLodDistance2: number = 300;
    public terrainLodStep1: number = 2;
    public terrainLodStep2: number = 4;

    /**
     * Tell every animated model whether the camera can see it and how far away it is, for the animation
     * LOD next frame's update picks (ModelNode.update -> Animator.setLod). One frame stale by design: the
     * scene updates before it renders. Uses the same cached bounding sphere the frustum cull does.
     */
    public stampAnimationView(scene: Scene): void {
        const eye = this._view.lodEye;
        for (const node of scene.models) {
            if (!node.animator) continue;
            const s = node.getBoundingSphere();
            // A model its occlusion volume hid LAST frame counts as off screen too: the stamp is one frame
            // stale anyway, and this runs before this frame's volumes are decided.
            node.cameraVisible = !this.frustumCulling
                || (this.frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius) && !this.volumeCulled(node));
            node.cameraDistance = Math.max(0, vec3.distance(eye, s.center) - s.radius);
        }
    }

    /**
     * Whether the camera cannot see `node`: outside the frustum, inside an occlusion volume whose box it
     * cannot see ({@link volumeCulled}), or hidden behind this frame's occluders (see
     * {@link buildOcclusion}). Every per-view visibility test goes through here,
     * which is what keeps the geometry pass, the forward overlay and the velocity pass in agreement.
     *
     * PURE — no stat side effect, so use it only where a node was already counted this frame;
     * {@link culled} is the counting variant.
     */
    public outsideFrustum(node: ModelNode): boolean {
        if (!this.frustumCulling) return false;
        // A viewmodel is drawn with its own projection, at its own depth: the world's frustum and
        // occluders say nothing about it.
        if (node.viewmodel) return false;
        const s = node.getBoundingSphere();
        if (!this.frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) return true;
        // Before the occlusion tests: a node its volume hides is never offered for a query of its own.
        if (this.volumeCulled(node)) return true;
        return this._nodeOccluded(node, s);
    }

    /**
     * Occlusion half of {@link outsideFrustum}, memoised per node for the frame: the CPU occluders first
     * (same frame, exact), then a fresh GPU occlusion query result (graphics/gpuOcclusion.ts). A node the
     * CPU test lets through is offered for this frame's queries whatever its last result, so a node that
     * was hidden is found again the moment it is uncovered.
     */
    private _nodeOccluded(node: ModelNode, s: { center: ArrayLike<number>; radius: number }): boolean {
        if (this._view.cubeFace) return false;
        const cpu = this._occlusionActive && this._view.camera === this._occlusionCamera;
        const gpu = this._gpuOcclusionActive && this._view.camera === this._gpuOcclusionCamera;
        if (!cpu && !gpu) return false;
        // The selected node is redrawn by the outline mask whatever happens; keep it honest everywhere.
        if (this._host.selectedNodeId && node.id === this._host.selectedNodeId) return false;
        const memo = this._occludedMemo.get(node);
        if (memo !== undefined) return memo;
        const r = s.radius, c = s.center;
        let hidden = false;
        if (cpu) {
            const min = this._occMin, max = this._occMax;
            min[0] = c[0] - r; min[1] = c[1] - r; min[2] = c[2] - r;
            max[0] = c[0] + r; max[1] = c[1] + r; max[2] = c[2] + r;
            hidden = this.occlusion.isBoxOccluded(min, max);
        }
        if (!hidden && gpu && Visibility._worthQuerying(node, c, r, this._view.camera)) {
            const triangles = node.model.geometry.indices.length / 3;
            if (this.gpuOcclusion.consider(node, r, triangles) && this.gpuOcclusion.isHidden(node)) {
                hidden = true;
                frameStats.queryOccludedObjects++;
            }
        }
        this._occludedMemo.set(node, hidden);
        return hidden;
    }

    /**
     * Whether nothing on screen is within reach of `light`: a fresh GPU occlusion query found the box
     * around its influence sphere (`center`, `radius`) hidden behind the frame's depth. Such a light can
     * light no visible pixel, so it is left out of the light grid and passed over for a shadow map. The
     * light is offered for this frame's queries either way, so it is found again the moment that changes.
     * Never true with the eye inside (or near) the sphere, whose box the near plane would clip, nor in a
     * capture, nor with `lightOcclusionCulling` off. Memoised for the frame.
     */
    public lightOccluded(node: LightNode, center: ArrayLike<number>, radius: number): boolean {
        if (!this.lightOcclusionCulling || !this._gpuOcclusionActive || this._view.cubeFace
            || this._view.camera !== this._gpuOcclusionCamera) return false;
        const memo = this.lightOccludedMemo.get(node);
        if (memo !== undefined) return memo;
        const eye = this._view.camera.position;
        const d = Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]);
        const hidden = d > radius * 1.2 + 1
            && this.gpuOcclusion.considerLight(node, center, radius)
            && this.gpuOcclusion.isLightHidden(node);
        this.lightOccludedMemo.set(node, hidden);
        return hidden;
    }

    /**
     * Whether a node is worth an occlusion query at all. A query is a draw of its box, and its cost is the
     * box's screen area: a box filling half the screen costs a full-screen depth test and is almost never
     * hidden, which in the Valley made the query pass 5 ms on WebGL2 — the near landscape chunks, two
     * hundred metres across as boxes, were each a full-screen test. The FAR chunks stay candidates: one
     * behind a ridge is exactly what the queries are for, and those are small on screen. Never the eye
     * inside the box either: its near faces would be clipped and the query could report nothing.
     */
    private static _worthQuerying(node: ModelNode, c: ArrayLike<number>, r: number, cam: Camera): boolean {
        const eye = cam.position;
        const d = Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]);
        if (d < r * 1.2 + 1) return false;
        // Projected radius as a fraction of the screen height: r * cot(fov/2) / d under perspective.
        const p = cam.projectionMatrix;
        const screen = p[11] !== 0 ? r * Math.abs(p[5]) / d : r * Math.abs(p[5]);
        return screen < 0.15;
    }

    /**
     * Start the frame's GPU occlusion: collect whatever query results have come back, decide whether this
     * view uses them. The main view only — a capture or a thumbnail never reads the main view's verdicts.
     */
    public beginGpuOcclusion(): void {
        const active = this.occlusionQueriesEnabled && this.occlusionMode !== 'off' && this.frustumCulling
            && !this._host.thumbnailMode && !this._view.capturing && !this._view.cubeFace
            && !!device.capabilities.hasOcclusionQuery && !!device.createOcclusionQuerySet;
        if (active && !this._occlusionQueries)
            this._occlusionQueries = device.createOcclusionQuerySet!(GPU_OCCLUSION_BUDGET, 'occlusionQueries');
        const view = this._view.camera.viewMatrix, f = this._gpuOcclusionForward;
        f[0] = -view[2]; f[1] = -view[6]; f[2] = -view[10];
        this.gpuOcclusion.beginFrame(active ? this._occlusionQueries : null, this._view.camera.position, f);
        this.lightOccludedMemo.clear();
        this._gpuOcclusionActive = active;
        this._gpuOcclusionCamera = this._view.camera;
    }

    /**
     * Draw every candidate node's box against the depth the geometry pass just wrote, each inside its own
     * occlusion query, and record the readback (graphics/gpuOcclusion.ts). No colour, no depth write: it
     * changes nothing on screen. The box is the bounding sphere's cube, a tenth larger — loose on purpose,
     * so a node about to come into view already reads as visible.
     */
    public gpuOcclusionPass(): void {
        const set = this._occlusionQueries, nodes = this.gpuOcclusion.candidates;
        if (!this._gpuOcclusionActive || !set || nodes.length === 0 || this._view.camera !== this._gpuOcclusionCamera) return;
        // Its own scope, so the boxes' cost is a row of its own rather than part of the foliage pass's.
        this._passes.scope('occlusion.queries');
        const target = device.createRenderTarget({
            label: 'occlusionQueries', colorViews: [], depthView: this._targets.gBuffer.depth.attachmentView,
        });
        this._passes.encoder = this._passes.acquireEncoder('occlusionQueries');
        this._passes.target = target;
        const pass = this._passes.encoder.beginRenderPass(target, {
            label: 'occlusionQueries',
            colorAttachments: [],
            depthAttachment: { loadOp: 'load', storeOp: 'store' },
            occlusionQuerySet: set,
        });
        // Every box's record first, uploaded in one go: the draws then change nothing but the query and
        // `firstInstance`, and the block below holds the camera alone, written once.
        const objects = this._sys.objects, owners = this._gpuOcclusionOwners, records = this._gpuOcclusionRecords;
        const model = this._gpuOcclusionModel;
        for (let i = 0; i < nodes.length; i++) {
            // An occlusion volume is tested by its own oriented box, not inflated: what it hides lies
            // inside the box already, and a box grown through the walls it was fitted inside would be
            // seen from outside them.
            const box = this.gpuOcclusion.volumeBoxes.get(nodes[i]);
            if (box) {
                records[i] = objects.ensure(owners[i] ??= {}, box, 0, false);
                continue;
            }
            // A light is tested by its influence sphere, stored when it was offered; a node by its own.
            const light = this.gpuOcclusion.lightSpheres.get(nodes[i]);
            const s = light ? { center: light, radius: light[3] } : (nodes[i] as ModelNode).getBoundingSphere();
            const size = s.radius * 2 * 1.1;
            mat4.fromTranslation(model, s.center as vec3);
            mat4.scale(model, model, [size, size, size]);
            records[i] = objects.ensure(owners[i] ??= {}, model, 0, false);
        }
        objects.flush();
        const cam = this._view.camera;
        this._shaderManager.bind('occlusionBox');
        this._shaderManager.setUniform('u_view', cam.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(cam.projectionMatrix));
        const pipeline = this._pipelines.get('occlusionBox', OcclusionBoxProgram, {
            cullMode: 'none',
            depthStencil: DEPTH_TEST,
            targets: 0,
            vertex: 'model',
            builtFor: 'irradiance',   // `SkyPasses.iblCubeMesh` is position-only, built from that program's attributes
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(2, this._bindGroups.objectDataGroup(pipeline, objects.texture));
        const cube = this._sys.sky.iblCubeMesh;
        for (let i = 0; i < nodes.length; i++) {
            pass.beginOcclusionQuery(i);
            this._passes.recordDraw(pass, cube, 0, 0, -1, records[i]);
            pass.endOcclusionQuery();
        }
        pass.end();
        frameStats.occlusionQueries += nodes.length;
        // Into the encoder that holds the pass, after it; then finish that encoder only if this owns it.
        set.resolve(this._passes.encoder, nodes.length, this.gpuOcclusion.submitted());
        this._passes.finishIfOwned(this._passes.encoder);
        this._passes.encoder = null;
        this._passes.target = null;
    }

    /**
     * {@link outsideFrustum}, additionally incrementing the `culledObjects` stat (and `occludedObjects` for
     * the ones only an occluder hid) so the editor HUD can report savings. Every node must reach this at
     * most once per frame or the HUD double-counts.
     */
    public culled(node: ModelNode): boolean {
        const outside = this.outsideFrustum(node);
        if (outside) {
            frameStats.culledObjects++;
            if (this._occludedMemo.get(node)) frameStats.occludedObjects++;
        }
        return outside;
    }

    /**
     * Rasterize this frame's occluders into the CPU occlusion buffer (graphics/occlusion): every visible
     * landscape as its lowered occluder mesh. Conservative throughout — see OcclusionBuffer — so nothing
     * it hides is visible.
     *
     * A landscape the camera is BELOW (a cave, a noclip camera) is left out: the lowering argument holds
     * only for a viewer above the surface.
     */
    public buildOcclusion(scene: Scene): void {
        // What the last built buffer achieved, read before begin() zeroes it.
        const lastHits = this._occlusionActive ? this.occlusion.stats.occluded : -1;
        this._occludedMemo.clear();
        this._occlusionActive = false;
        this.occlusionFrameStats.triangles = 0;
        this.occlusionFrameStats.ms = 0;
        if (this.occlusionMode === 'off' || !this.frustumCulling || this._host.thumbnailMode) return;
        // A view in which nothing is hidden — the editor's high overview, open ground — would pay for the
        // buffer every frame for nothing. After a run of such frames it is built only every few frames, as
        // a probe, until one hides something again. Not building is always safe: it only culls less.
        if (lastHits === 0) this._occlusionIdleFrames++;
        else if (lastHits > 0) this._occlusionIdleFrames = 0;
        if (this._occlusionIdleFrames >= OCCLUSION_IDLE_FRAMES && ++this._occlusionSkipped < OCCLUSION_IDLE_PROBE) return;
        this._occlusionSkipped = 0;
        const start = performance.now();
        const eye = this._view.camera.position;

        // Everything the buffer is built from. When all of it equals what the last COMPLETE build saw — the
        // editor's parked camera, every frame — the buffer already holds this frame's answer: keep it and
        // only start its query counters again (they feed `lastHits` above). Rasterizing the same occluders
        // again cost ~1.4 ms in the Valley. The frustum and the terrain tiles' order and strides all derive
        // from `viewProj` and the eye; a terrain occluder is rebuilt only on a heights or origin change.
        const key = this._occlusionKey;
        key.begin();
        key.ref(this._view.camera);
        key.ref(scene.landscapes);              // reallocated whenever the scene's node lists rebuild
        key.nums(this._view.viewProj, 16);
        key.nums(eye, 3);
        for (const landscape of scene.landscapes) {
            key.num(landscape.visible ? 1 : 0);
            key.num(landscape.terrain.heightsVersion);
            key.nums(landscape.terrain.origin, 3);
        }
        if (key.matches()) {
            this.occlusion.resetQueryStats();
            this._occlusionActive = true;
            this._occlusionCamera = this._view.camera;
            this.occlusionFrameStats.triangles = this.occlusion.stats.triangles;
            this.occlusionFrameStats.ms = performance.now() - start;
            return;
        }

        this.occlusion.begin(this._view.viewProj);
        let any = false;
        // False when a landscape sat out this build (its occluder is waiting to be rebuilt): the buffer then
        // lacks an occluder its key describes, so it must not be kept.
        let complete = true;
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            const terrain = landscape.terrain;
            const o = terrain.origin;
            if (terrain.heightAt(eye[0] - o[0], eye[2] - o[2]) + o[1] > eye[1]) continue;
            let entry = this._terrainOccluders.get(terrain);
            // Built in world space, so a moved landscape needs a new one as much as a sculpted one.
            const moved = !!entry && (entry.origin[0] !== o[0] || entry.origin[1] !== o[1] || entry.origin[2] !== o[2]);
            if (!entry || entry.version !== terrain.heightsVersion || moved) {
                // A rebuild walks the whole height grid (tens of ms for a 2k landscape), so a sculpt drag
                // rebuilds at most twice a second — and until it does, this landscape occludes nothing:
                // a stale mesh could stand above ground the brush just lowered.
                const now = renderNow();
                if (entry && now - entry.builtAt < 500) { complete = false; continue; }
                entry = {
                    version: terrain.heightsVersion,
                    builtAt: now,
                    origin: [o[0], o[1], o[2]],
                    occluder: new TerrainOccluder({ heights: terrain.heights, resolution: terrain.resolution,
                                                    size: terrain.size, origin: [o[0], o[1], o[2]] }),
                };
                this._terrainOccluders.set(terrain, entry);
            }
            entry.occluder.emit(this.frustum, eye, this._rasterOccluder, undefined, this._occluderHidden);
            any = true;
        }
        if (!any) { key.invalidate(); return; }
        this.occlusion.finish();
        if (complete) key.commit(); else key.invalidate();
        this._occlusionActive = true;
        this._occlusionCamera = this._view.camera;
        // Kept until after resetFrameStats, which runs later in the frame. Inside the `prepare` scope
        // (scopes never nest), so the time gets a counter of its own instead of a profiler row.
        this.occlusionFrameStats.triangles = this.occlusion.stats.triangles;
        this.occlusionFrameStats.ms = performance.now() - start;
    }

    /** `buildOcclusion`'s callbacks into the terrain occluder, bound once rather than per frame. */
    private readonly _rasterOccluder = (grid: OccluderGrid) => this.occlusion.rasterizeGrid(grid.positions, grid.cols, grid.rows);
    private readonly _occluderHidden = (min: ArrayLike<number>, max: ArrayLike<number>) => this.occlusion.isBoxHiddenSoFar(min, max);

    /** Whether a foliage cell's box is hidden behind this frame's occluders. */
    public cellOccluded(min: ArrayLike<number>, max: ArrayLike<number>): boolean {
        if (!this._occlusionActive || this._view.camera !== this._occlusionCamera) return false;
        return this.occlusion.isBoxOccluded(min, max);
    }

    /**
     * Decide this frame's occlusion volumes for the main view (graphics/occlusion/occlusionVolumes.ts):
     * which boxes the camera cannot see, and so which of their contents every pass skips. After
     * `buildOcclusion` and `beginGpuOcclusion` (it reads the CPU buffer and the query verdicts, and
     * offers each box for this frame's queries), before anything draws.
     *
     * Only with `occlusionCulling` at `'all'` and frustum culling on, never in a thumbnail, a capture or
     * a cube face: those draw everything.
     */
    public updateOcclusionVolumes(scene: Scene): void {
        const s = this.volumeFrameStats;
        s.tested = s.hidden = s.culledNodes = 0;
        this._volumesActive = false;
        if (this.occlusionMode !== 'all' || !this.frustumCulling || this._host.thumbnailMode
            || this._view.capturing || this._view.cubeFace || scene.occlusionVolumes.size === 0) {
            this.volumes.clear();
            return;
        }
        const camera = this._view.camera;
        const sources = this._volumeSources;
        sources[0].nodes = scene.modelsExceptTerrain;
        sources[1].nodes = scene.sprites;
        sources[2].nodes = scene.particleSystems;
        sources[3].nodes = scene.lights;
        sources[4].nodes = scene.decals;
        sources[5].nodes = scene.fluidVolumes;
        const selected = this._host.selectedNodeId ? scene.getNodeById(this._host.selectedNodeId) : null;
        this.volumes.update({
            volumes: scene.occlusionVolumes as Iterable<VolumeLike>,
            sources,
            eye: camera.position,
            near: camera.near,
            planes: this.frustum.planes,
            cpuOccluded: this._occlusionActive && camera === this._occlusionCamera ? this._volumeCpuOccluded : null,
            queries: this._gpuOcclusionActive && camera === this._gpuOcclusionCamera ? this._volumeQueries : null,
            exempt: selected ?? null,
        });
        this._volumesActive = true;
        this._volumeCamera = camera;
        s.tested = this.volumes.stats.tested;
        s.hidden = this.volumes.stats.hidden;
        s.culledNodes = this.volumes.stats.culledNodes;
    }

    /**
     * Whether `node` is skipped this frame because it lies inside an occlusion volume whose box the camera
     * cannot see (and the volume hides that kind of content). False in any view but the one the volumes
     * were decided for.
     */
    public volumeCulled(node: object): boolean {
        return this._volumesActive && this._view.camera === this._volumeCamera && !this._view.cubeFace
            && this.volumes.hidden.has(node);
    }

    /** Whether a model casts no shadow this frame: its occlusion volume is hidden and hides shadows too. */
    public volumeShadowCulled(node: object): boolean {
        return this._volumesActive && this.volumes.shadowHidden.has(node);
    }

    private readonly _volumeCpuOccluded = (min: ArrayLike<number>, max: ArrayLike<number>) => this.occlusion.isBoxOccluded(min, max);
    private readonly _volumeQueries: VolumeQueries = {
        consider: (volume, box) => this.gpuOcclusion.considerVolume(volume, box),
        isHidden: volume => this.gpuOcclusion.isVolumeHidden(volume),
    };

    /**
     * What each kind of content is, for the volumes: its bounds and when they change. Editor chrome and
     * a sun never belong to a volume; the landscapes' chunks are left out by the model list itself.
     */
    private readonly _volumeSources: VolumeSources = [
        {
            kind: 'models', nodes: [],
            version: n => n.transformVersion,
            // A new mesh is new bounds without the transform moving.
            ref: n => n.model?.geometry ?? null,
            bounds: (n, min, max) => {
                if (isEditorOnlyNode(n)) return false;
                const b = n.getBoundingBox();
                return copyBox(b.min, b.max, min, max);
            },
        },
        {
            kind: 'sprites', nodes: [],
            version: n => n.transformVersion,
            bounds: (n, min, max) => {
                if (isEditorOnlyNode(n)) return false;
                // A billboard quad `worldScale` across, turned to the camera: any way round, its corners
                // stay within half its diagonal of the centre.
                const p = n.worldPosition, sc = n.worldScale;
                const r = 0.5 * Math.hypot(sc[0], sc[1], sc[2]);
                return copyBox([p[0] - r, p[1] - r, p[2] - r], [p[0] + r, p[1] + r, p[2] + r], min, max);
            },
        },
        {
            // Every frame: a system's bounds follow its parameters, not just its transform.
            kind: 'particles', nodes: [],
            version: () => NaN,
            bounds: (n, min, max) => {
                if (isEditorOnlyNode(n)) return false;
                const b = n.getBoundingBox();
                return copyBox(b.min, b.max, min, max);
            },
        },
        {
            // A light by its position: what it lights is the user's call (the volume's Lights switch).
            kind: 'lights', nodes: [],
            version: n => n.transformVersion,
            bounds: (n, min, max) => {
                if (n.type === 'directional' || isEditorOnlyNode(n)) return false;
                const p = n.worldPosition;
                return copyBox(p, p, min, max);
            },
        },
        {
            kind: 'decals', nodes: [],
            version: () => NaN,
            bounds: (n, min, max) => {
                if (isEditorOnlyNode(n)) return false;
                const b = n.getBoundingBox();
                return copyBox(b.min, b.max, min, max);
            },
        },
        {
            kind: 'fluids', nodes: [],
            version: () => NaN,
            bounds: (n, min, max) => {
                if (isEditorOnlyNode(n)) return false;
                const b = n.getBoundingBox();
                return copyBox(b.min, b.max, min, max);
            },
        },
    ];

    // Distance-based terrain LOD: every landscape re-picks its chunks' detail levels. The levels are
    // alternate index buffers over one unchanged vertex buffer, so this is a distance test per chunk.
    public updateTerrainLOD(scene: Scene): void {
        if (scene.landscapes.size === 0) return;
        const settings: TerrainLodSettings = {
            enabled: this.terrainLodEnabled,
            distance1: this.terrainLodDistance1,
            distance2: this.terrainLodDistance2,
            step1: this.terrainLodStep1,
            step2: this.terrainLodStep2,
        };
        for (const landscape of scene.landscapes) landscape.updateLod(this._view.lodEye, settings);
    }

    // Distance-based model LOD: every LodGroupNode picks its visible level subtree, or hides past its
    // cull distance; every node with a drawDistance hides its subtree past it (×0.9 hysteresis on the
    // way back, like the LOD groups). Visibility flags are rewritten only on a transition.
    public updateModelLOD(scene: Scene): void {
        const eye = this._view.lodEye;
        for (const group of scene.lodGroups) group.updateLod(eye);
        for (const node of scene.drawDistanceNodes) node.updateDrawCull(eye);
    }

    /** Squared distance from point `p` to the closest point of the AABB [min, max] (0 if inside). */
    public aabbDistSq(p: vec3, min: ArrayLike<number>, max: ArrayLike<number>): number {
        let d2 = 0;
        for (let a = 0; a < 3; a++) {
            const v = p[a];
            if (v < min[a]) d2 += (min[a] - v) * (min[a] - v);
            else if (v > max[a]) d2 += (v - max[a]) * (v - max[a]);
        }
        return d2;
    }
}

/** The content kinds the volumes look through, in this order; `nodes` is pointed at the scene each frame. */
type VolumeSources = [
    VolumeContentSource<ModelNode>, VolumeContentSource<SpriteNode>, VolumeContentSource<ParticleSystemNode>,
    VolumeContentSource<LightNode>, VolumeContentSource<DecalNode>, VolumeContentSource<FluidVolumeNode>,
];

/** `[srcMin, srcMax]` into `[min, max]`; false for an empty or non-finite box (it belongs to no volume). */
function copyBox(srcMin: ArrayLike<number>, srcMax: ArrayLike<number>, min: vec3, max: vec3): boolean {
    for (let a = 0; a < 3; a++) {
        min[a] = srcMin[a]; max[a] = srcMax[a];
        if (!Number.isFinite(min[a]) || !Number.isFinite(max[a]) || min[a] > max[a]) return false;
    }
    return true;
}
