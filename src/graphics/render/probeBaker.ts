import { mat4, vec3 } from 'gl-matrix';
import { Frustum } from '../../core/frustum';
import { lightReachesProbe } from '../../core/scene/probeBakeState';
import { Logger } from '../../core/logger';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import type { LightBakeSnapshot } from '../../core/scene/nodes/lightNode';
import type { LightProbeNode } from '../../core/scene/nodes/lightProbeNode';
import type { ModelNode } from '../../core/scene/nodes/modelNode';
import type { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import { Texture } from '../texture';
import { PrefilterOctProgram } from './programs';
import { nextProbeJob, probeJobSteps, probesToRelightForSun } from './probeJobs';
import type { ProbeJobKind, ProbeJobStep } from './probeJobs';
import { REFLECTION_MIPS, ReflectionAtlas } from './reflectionAtlas';
import { SkyPasses } from './sky';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';
import type { ShadowPasses } from './shadows';
import type { LightingPasses } from './lighting';
import type { ForwardPass } from './forwardPass';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';
import { ShaderManager } from '../systems/shaderManager';
import { renderNow } from './renderClock';

/** What the probe baker reads from the renderer. */
export interface ProbeBakerHost {
    readonly renderWidth: number;
    readonly renderHeight: number;
    readonly clearColor: number[];
}

/** A probe's GPU side kept between jobs: its captured scene (the G-buffer faces) and its source cube. */
interface ProbeGpu {
    res: number;
    /** One G-buffer per cube face, at the probe's resolution, in the frame G-buffer's formats. */
    faces: Framebuffer[];
    /** True once all six faces hold the scene: a relight can run. */
    captured: boolean;
    /** The lit capture (linear HDR, full mip chain): installed as the probe's `envMap`. */
    source: Texture;
}

interface ProbeJob {
    probe: LightProbeNode;
    scene: Scene;
    kind: ProbeJobKind;
    steps: ProbeJobStep[];
    index: number;
    /** The atlas layer this job filters into (-1 until its first filter step). */
    layer: number;
    /** The atlas generation `layer` belongs to. */
    generation: number;
    /** What the lights this relight saw were. */
    lights: Map<string, LightBakeSnapshot> | null;
    /** The G-buffer capture's progress: the face, and how many of its nodes are drawn. */
    face: number;
    cursor: number;
}

/**
 * Nodes a G-buffer capture draws per frame. A face that sees more is finished the next frame: a horizontal
 * face of the Valley sees about 300 nodes (most of them landscape chunks), up to 8 ms of draws at once;
 * 48 keeps a frame near 2 ms.
 */
export const GBUFFER_DRAWS_PER_FRAME = 48;

/**
 * GGX samples per texel by atlas mip: a mirror needs one, and the source mip selection (each sample reads
 * the source at its own footprint) keeps the rest clean at a few hundred. Mip 1 at 384 is about 6 million
 * samples, well under a millisecond.
 */
const FILTER_SAMPLES = [1, 384, 384, 256, 256];

/**
 * Light probe bakes, time-sliced and relightable (render/probeJobs.ts has the plan, this the GPU work):
 *
 * - a BAKE captures the probe's scene into six G-buffer faces, one face a frame, drawn by the frame's own
 *   geometry programs and culled to each face's frustum;
 * - a RELIGHT lights those faces into the probe's source cube with the deferred lighting pass (the sun's
 *   shadow from a map of the probe's own, drawn the frame before), over the sky — no geometry;
 * - a FILTER prefilters the source into a free layer of the reflection atlas, over two frames, and the
 *   last step swaps the new layer and irradiance in.
 *
 * One step a frame, one probe at a time, at the start of the frame (SkyPasses.updateIBL).
 */
export class ProbeBaker {
    private readonly _shaderManager = ShaderManager.Instance;
    /** Every probe's reflection, one layer each (render/reflectionAtlas.ts). */
    public readonly atlas = new ReflectionAtlas();
    private readonly _gpu = new Map<LightProbeNode, ProbeGpu>();
    private _job: ProbeJob | null = null;
    private readonly _frustum = new Frustum();
    private readonly _viewProj = mat4.create();
    private readonly _invViewProj = mat4.create();
    private readonly _eye = vec3.create();
    private readonly _dir = vec3.create();
    private readonly _up = vec3.create();
    /** Steps run, by kind, for tests and the profiler. */
    public readonly stepsRun: Record<string, number> = {};

    constructor(private readonly _host: ProbeBakerHost,
                private readonly _view: FrameView,
                private readonly _passes: PassEncoder,
                private readonly _shadows: ShadowPasses,
                private readonly _lighting: LightingPasses,
                private readonly _sky: SkyPasses,
                private readonly _forward: ForwardPass,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    /** The job in flight, for the editor's status line: the probe and how far it has got (0..1). */
    public get progress(): { probe: LightProbeNode; kind: ProbeJobKind; fraction: number } | null {
        const job = this._job;
        return job ? { probe: job.probe, kind: job.kind, fraction: job.index / job.steps.length } : null;
    }

    /** Whether `probe` has a captured scene to relight. */
    public hasGBuffer(probe: LightProbeNode): boolean {
        const gpu = this._gpu.get(probe);
        return !!gpu && gpu.captured && gpu.res === probe.resolution;
    }

    /** Run ONE step of probe work for `scene`. Called once a frame, before any pass. */
    /** The sun direction each sun-following probe was last lit with (LightProbeNode.relightDegrees). */
    private readonly _litWithSun = new WeakMap<LightProbeNode, [number, number, number]>();

    public update(scene: Scene): void {
        if (this._view.capturing) return;
        this._sync(scene);
        // Probes that follow the sun relight once it has turned far enough: whatever turned it (a sequence, a
        // script), reflections and fill keep up with no code of their own.
        let sun: ArrayLike<number> | null = null;
        for (const light of scene.lights) if (light.type === 'directional') { sun = light.worldForward; break; }
        for (const probe of probesToRelightForSun(scene.lightProbes, sun, this._litWithSun)) probe.relight();
        let job = this._job;
        if (job && (job.scene !== scene || !scene.lightProbes.has(job.probe))) {
            this._abort(job);
            job = this._job = null;
        }
        if (!job) {
            const choice = nextProbeJob(scene.lightProbes, this._view.camera.position, renderNow(),
                                        p => this.hasGBuffer(p));
            if (!choice) return;
            // Taken now, so a request made while the job runs queues another.
            choice.probe.takeBakeRequests();
            job = this._job = {
                probe: choice.probe, scene, kind: choice.kind, steps: probeJobSteps(choice.kind),
                index: 0, layer: -1, generation: this.atlas.generation, lights: null, face: 0, cursor: 0,
            };
        }
        const step = job.steps[job.index++];
        try {
            // The capture holds its step until all six faces are drawn, a draw budget a frame.
            if (step.kind === 'gbuffer' && !this._captureSome(scene, job)) job.index--;
            else if (step.kind !== 'gbuffer') this._run(scene, job, step);
            this.stepsRun[step.kind] = (this.stepsRun[step.kind] ?? 0) + 1;
        } catch (e) {
            // NAMED: a probe that never finishes keeps its old maps, or none, and nothing else would say why.
            Logger.warn(`Light probe bake failed (${job.probe.name}, ${step.kind}): ${(e as Error)?.message ?? e}`, 'Renderer');
            this._abort(job);
            this._job = null;
            return;
        }
        if (job.index >= job.steps.length) this._job = null;
    }

    // --- Bookkeeping ---------------------------------------------------------------------------------

    /**
     * The atlas big enough for the scene's probes (a regrown atlas holds nothing: every probe re-filters,
     * `nextProbeJob` tier 1), and the GPU side of probes no longer in any scene released.
     */
    private _sync(scene: Scene): void {
        // Every probe that may hold a layer: this scene's, and any baked in another still-open scene.
        let probes = scene.lightProbes.size;
        for (const probe of this._gpu.keys()) if (!scene.lightProbes.has(probe)) probes++;
        if (this.atlas.ensureCapacity(probes)) {
            for (const probe of this._gpu.keys()) probe.reflectionLayer = -1;
            for (const probe of scene.lightProbes) probe.reflectionLayer = -1;
            // A job mid-filter starts its filtering again, into the new atlas.
            const job = this._job;
            if (job) {
                job.layer = -1;
                job.generation = this.atlas.generation;
                const firstFilter = job.steps.findIndex(s => s.kind === 'filter');
                if (job.index > firstFilter) job.index = firstFilter;
            }
        }
        for (const [probe, gpu] of this._gpu) {
            if (probe.scene) continue;
            if (probe.reflectionLayer >= 0) this.atlas.layers.release(probe.reflectionLayer);
            probe.reflectionLayer = -1;
            for (const face of gpu.faces) face.destroy();
            this._gpu.delete(probe);
        }
    }

    private _abort(job: ProbeJob): void {
        if (job.layer >= 0 && job.generation === this.atlas.generation && job.layer !== job.probe.reflectionLayer)
            this.atlas.layers.release(job.layer);
        job.layer = -1;
    }

    /** The probe's G-buffer faces and source cube at its resolution, made on first use or a resolution change. */
    private _ensureGpu(probe: LightProbeNode): ProbeGpu {
        const res = probe.resolution;
        let gpu = this._gpu.get(probe);
        if (gpu && gpu.res === res) return gpu;
        if (gpu) for (const face of gpu.faces) face.destroy();
        const faces: Framebuffer[] = [];
        for (let i = 0; i < 6; i++) {
            // The frame G-buffer's own layout (Renderer: `_targets.gBuffer`), so the frame's geometry
            // pipelines draw into it unchanged and the deferred pass reads it unchanged.
            const fb = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
            fb.create(res, res);
            faces.push(fb);
        }
        const source = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
        source.createCubemapTarget(res, Math.floor(Math.log2(res)) + 1);
        gpu = { res, faces, captured: false, source };
        this._gpu.set(probe, gpu);
        return gpu;
    }

    // --- Steps ---------------------------------------------------------------------------------------

    private _run(scene: Scene, job: ProbeJob, step: ProbeJobStep): void {
        const probe = job.probe;
        switch (step.kind) {
            case 'gbuffer':
                break;   // `_captureSome`, a frame at a time
            case 'shadow':
                // Before the capture state, as a capture always drew it: its casters draw from the light.
                this._shadows.renderProbeShadows(scene, probe.worldPosition,
                    this._shadows.probeShadowRadius(probe.bounded, probe.size, probe.worldScale));
                break;
            case 'relight': {
                const gpu = this._gpu.get(probe);
                if (!gpu || !gpu.captured) throw new Error('no captured scene to relight');
                job.lights = bakedLightSnapshots(scene, probe);
                this._relight(scene, probe, gpu);
                break;
            }
            case 'filter': {
                const source = job.kind === 'filter' ? probe.envMap : this._gpu.get(probe)?.source ?? null;
                if (!source) throw new Error('no capture to filter');
                if (job.layer < 0) {
                    job.layer = this.atlas.layers.acquire();
                    job.generation = this.atlas.generation;
                    if (job.layer < 0) throw new Error('the reflection atlas is full');
                }
                // The relit source's mips, which the filter's samples read: here rather than in the relight,
                // to keep that step small. (A filter job's source has its mips already.)
                if (step.mips[0] === 0 && job.kind !== 'filter') this._passes.generateMipsAfterRender(source);
                this._filter(source, job.layer, step.mips);
                if (step.finish) this._finish(probe, job, source);
                break;
            }
        }
    }

    /** Everything a capture swaps: the camera, the cube-face winding, pre-exposure 1, `capturing`. */
    private _withCaptureState(res: number, body: () => void): void {
        const cam = this._sky.captureCamera;
        cam.fov = 90;
        cam.resize(res, res);
        const prevCamera = this._view.camera;
        const prevPreExposure = this._view.preExposure, prevDrawPreExposure = this._view.drawPreExposure;
        this._view.capturing = true;
        this._view.camera = cam;
        // A probe is baked ABSOLUTE (pre-exposure 1): its maps are sampled by later frames at whatever
        // pre-exposure they have, through the intensity uploads that carry it (LightingPasses).
        this._view.preExposure = 1;
        this._view.drawPreExposure = 1;
        // Every draw below writes a CUBE FACE (or a face's G-buffer, read back into one): see
        // `ViewProjection.clipProjection`, the Y inversion a cube face needs on WebGPU.
        this._view.cubeFace = true;
        try {
            body();
        } finally {
            this._view.cubeFace = false;
            this._view.camera = prevCamera;
            this._view.preExposure = prevPreExposure;
            this._view.drawPreExposure = prevDrawPreExposure;
            this._view.capturing = false;
            this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        }
    }

    /** Point the capture camera down cube face `face` from the probe, and fit the face's frustum. */
    private _aimFace(probe: LightProbeNode, face: number): void {
        const cam = this._sky.captureCamera;
        const f = SkyPasses.CUBE_FACES[face];
        const p = probe.worldPosition;
        cam.position = p;
        vec3.add(this._eye, p, vec3.set(this._dir, f.dir[0], f.dir[1], f.dir[2]));
        cam.eye = this._eye;
        cam.up = vec3.set(this._up, f.up[0], f.up[1], f.up[2]);
        mat4.multiply(this._viewProj, cam.projectionMatrix, cam.viewMatrix);
        this._frustum.setFromViewProjection(this._viewProj);
    }

    /**
     * Capture the next `GBUFFER_DRAWS_PER_FRAME` nodes of the probe's scene into its G-buffer faces, each
     * face culled to its own frustum. True once all six faces are complete.
     */
    private _captureSome(scene: Scene, job: ProbeJob): boolean {
        const probe = job.probe;
        const gpu = this._ensureGpu(probe);
        if (job.face === 0 && job.cursor === 0) gpu.captured = false;
        let budget = GBUFFER_DRAWS_PER_FRAME;
        this._withCaptureState(gpu.res, () => {
            while (job.face < 6 && budget > 0) {
                const face = job.face;
                this._aimFace(probe, face);
                const frustum = this._frustum;
                // The first part of a face clears it; the parts after draw over it.
                const first = job.cursor === 0;
                const pass = this._passes.beginFullscreenPass(gpu.faces[face].renderTarget, 'probeGBuffer', first, [0, 0, 0, 0], first);
                const admitted = this._sys.geometry.captureInto(pass, scene, inCapture, (node) => {
                    const s = node.getBoundingSphere();
                    return frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius);
                }, face, job.cursor, budget);
                this._passes.endFullscreenPass(pass);
                const drawn = Math.max(0, Math.min(budget, admitted - job.cursor));
                job.cursor += drawn;
                budget -= Math.max(1, drawn);
                if (job.cursor >= admitted) { job.face++; job.cursor = 0; }
            }
        });
        if (job.face < 6) return false;
        gpu.captured = true;
        return true;
    }

    /** Light the six captured faces into the source cube, over the sky, then its mips. */
    private _relight(scene: Scene, probe: LightProbeNode, gpu: ProbeGpu): void {
        const lighting = this._lighting;
        const forwardOnly = this._forwardOnlyModels(scene);
        this._withCaptureState(gpu.res, () => {
            // The probe's sun shadow, drawn last frame (step 'shadow'), read in the cascades' place; the
            // frame's own cascades are fit to the main camera. Point and spot shadows are world-space.
            this._shadows.activateProbeShadows();
            this._shadows.shadowsSuppressed = true;
            try {
                // The BAKE light grid: one cluster holding every light set to bake. The frame's grid
                // describes the main camera's frustum; these faces look elsewhere from somewhere else.
                lighting.beginBakeLights(scene);
                if (forwardOnly.length > 0) this._prepareForwardForCapture(scene);

                const cam = this._sky.captureCamera;
                const clear = this._host.clearColor;
                for (let face = 0; face < 6; face++) {
                    this._aimFace(probe, face);
                    const target = this._sky.cubeFBO.targetFor(gpu.source, face, 0, true, gpu.res);
                    // The sky first, at depth 1.0: the lighting pass discards the background and leaves it.
                    const sky = this._passes.beginFullscreenPass(target, 'probeSky', true, [clear[0], clear[1], clear[2], clear[3]], true);
                    this._sky.renderSky(sky, scene, cam);
                    this._passes.endFullscreenPass(sky);
                    // The G-buffer face was rasterized with the cube face's Y inversion on WebGPU, which is
                    // exactly the uv mirror `uvConsuming` would undo: the two cancel, on both backends.
                    mat4.invert(this._invViewProj, this._viewProj);
                    lighting.relightProbeFace(scene, gpu.faces[face], target, this._invViewProj, probe.worldPosition, cam.viewMatrix);
                    if (forwardOnly.length > 0) this._drawForwardOnly(gpu, face, forwardOnly);
                }
            } finally {
                this._shadows.shadowsSuppressed = false;
                this._shadows.endProbeShadows();
                // The forward programs hold the capture's shadow state only if forward models were drawn.
                if (forwardOnly.length > 0) lighting.bindShadowsToForwardShaders();
                lighting.endBakeLights();
            }
        });
    }

    /** The capture's opaque models the G-buffer cannot hold (GeometryPass.inGBuffer says no). */
    private _forwardOnlyModels(scene: Scene): ModelNode[] {
        const out: ModelNode[] = [];
        for (const node of scene.models) {
            if (!inCapture(node) || this._sys.geometry.inGBuffer(node)) continue;
            // A screen material is a camera post pass, never mesh geometry.
            if (node.model.material.type.startsWith('customScreen:')) continue;
            out.push(node);
        }
        return out;
    }

    /** Forward lighting for the capture's forward-only models (Blinn-Phong, cel, forward custom). */
    private _prepareForwardForCapture(scene: Scene): void {
        const lighting = this._lighting;
        lighting.resetForwardLighting(scene);
        for (const light of scene.lights) if (light.bake) lighting.setDirectionalOnForward(light);
        lighting.bindShadowsToForwardShaders();
        lighting.bindEnvToForwardShaders(scene);
        lighting.uploadLightGridToForwardShaders();
    }

    /**
     * The opaque models the G-buffer cannot hold, drawn forward over the relit face against the face's
     * captured depth (tested, not written: the G-buffer must stay the scene's for the next relight).
     */
    private _drawForwardOnly(gpu: ProbeGpu, face: number, models: ModelNode[]): void {
        const target = device.createRenderTarget({
            label: 'probeForward',
            colorViews: [device.createTextureView(gpu.source.rhiTexture, 0, face)],
            depthView: gpu.faces[face].depth.attachmentView,
        });
        const pass = this._passes.beginFullscreenPass(target, 'probeForward', false, undefined, false);
        const write = this._forward.forwardDepthWrite;
        this._forward.forwardDepthWrite = false;
        try {
            this._forward.prepareRows(models);
            for (const node of models) this._forward.renderModel(node, pass);
        } finally {
            this._forward.forwardDepthWrite = write;
            this._passes.endFullscreenPass(pass);
        }
    }

    /** GGX-prefilter `source` into atlas `layer` at `mips`. */
    private _filter(source: Texture, layer: number, mips: readonly number[]): void {
        const res = source.width || 1;
        for (const mip of mips) {
            const pass = this._passes.beginFullscreenPass(this.atlas.targetFor(layer, mip), 'probeFilter', false);
            this._fullscreen.bind(pass, 'prefilterOct', PrefilterOctProgram, [source]);
            this._shaderManager.bind('prefilterOct');
            this._shaderManager.setUniform('u_roughness', REFLECTION_MIPS > 1 ? mip / (REFLECTION_MIPS - 1) : 0);
            this._shaderManager.setUniform('u_resolution', res);
            this._shaderManager.setUniform('u_sampleCount', FILTER_SAMPLES[mip] ?? 512);
            this._passes.drawFullscreenAndEnd(pass);
        }
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
    }

    /**
     * The job's last step: the new capture installed (its lighting is projected from it next,
     * SkyPasses.updateProbeLighting), then the new layer swapped in.
     */
    private _finish(probe: LightProbeNode, job: ProbeJob, source: Texture): void {
        if (job.kind !== 'filter') {
            probe.setBakedMaps(source);
            if (job.lights) probe.bakedLights = job.lights;
            probe.markBaked(renderNow());
        }
        if (probe.reflectionLayer >= 0 && probe.reflectionLayer !== job.layer) this.atlas.layers.release(probe.reflectionLayer);
        probe.reflectionLayer = job.layer;
        job.layer = -1;
    }
}

/** What a probe capture draws: visible, opaque, real scene geometry a material has not opted out. */
function inCapture(node: ModelNode): boolean {
    if (!node.visible) return false;
    if (isEditorOnlyNode(node)) return false;
    // The wider "hidden from the tree" set a capture has always left out, preview props included.
    if (node.name.startsWith('__editor__') || node.name.startsWith('__debug__')) return false;
    const config = node.model.material.config;
    if (config.transparent) return false;
    // ===false so legacy/default materials with the flag unset still render.
    return config.probeable !== false;
}


/**
 * What every light set to bake that can reach `probe` is now: what its bake depended on (probeBakeState.ts),
 * compared later to say the probe is out of date.
 */
export function bakedLightSnapshots(scene: Scene, probe: LightProbeNode): Map<string, LightBakeSnapshot> {
    const out = new Map<string, LightBakeSnapshot>();
    for (const light of scene.lights) if (light.bake && lightReachesProbe(light, probe)) out.set(light.id, light.bakeSnapshot());
    return out;
}
