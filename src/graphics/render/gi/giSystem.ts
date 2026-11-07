import { mat4, vec3 } from 'gl-matrix';
import { Frustum } from '../../../core/frustum';
import { Camera } from '../../../core/camera';
import { isEditorOnlyNode } from '../../../core/scene/editorNodes';
import type { GIVolumeNode } from '../../../core/scene/nodes/giVolumeNode';
import type { LightNode } from '../../../core/scene/nodes/lightNode';
import type { ModelNode } from '../../../core/scene/nodes/modelNode';
import { AnimatedModel } from '../../../animation/animatedModel';
import type { Scene } from '../../../core/scene/scene';
import { Logger } from '../../../core/logger';
import { Framebuffer } from '../../framebuffer';
import { device } from '../../rhi/deviceHandle';
import { DEFAULT_BLEND } from '../../rhi/types';
import type { BindGroup, RenderPipeline } from '../../rhi/resources';
import { Texture } from '../../texture';
import { ShaderManager } from '../../systems/shaderManager';
import {
    GiReduceProgram, GiVisibilityProgram, GiRadianceProgram, GiIntegrateProgram, GiResolveProgram,
    GiAmbientCubeProgram,
} from '../programs';
import type { BindGroupCache } from '../bindGroups';
import type { FrameView } from '../frameView';
import type { FrameTargets } from '../frameTargets';
import type { FullscreenPasses } from '../fullscreenPasses';
import type { LightingPasses } from '../lighting';
import type { PassEncoder } from '../passEncoder';
import type { PipelineCache } from '../pipelineCache';
import { ProbeShadowMap, type ShadowPasses } from '../shadows';
import type { ViewProjection } from '../viewProjection';
import type { RenderSubsystems } from '../subsystems';
import {
    GI_IRRADIANCE_TILE, GI_VISIBILITY_TILE, giAtlasLayout, giAtlasSizes, gridCoords, hitCacheSize,
    tileSolidAngles, type GiAtlasLayout,
} from './giLayout';
import { GI_PROBE_ACTIVE, GI_PROBE_PENDING, GI_PROBE_SKIPPED, GI_PROBE_UNCAPTURED, classifyHitRows, isUnderground } from './giClassify';
import { ModelDraw } from '../modelDraw';
import {
    GI_AMBIENT_CUBE_FLOATS, MAX_GI_VOLUMES, giAmbientAt, giLightingAt, orderGiVolumes, type GiVolumeCpu,
} from './giLighting';
import { GI_TIERS, giProbesPerFrame, giShadowMapSize } from './giSettings';
import { GiBakeFormatError, GiSignature, decodeGiBake, encodeGiBake, sameGiSignature } from './giBakeFormat';
import { GiBakeRegistry } from './giBakeRegistry';
import {
    GiSweepState, hashNumbers, isLightJump, nearestUncaptured, needsRelight, needsShadowRender,
    planRelightFrame, type GiLightInputs,
} from './giJobs';

/**
 * GI Volumes on the GPU: the capture, the relight and the apply (plans: GI Volumes, relit).
 *
 * CAPTURE. A batch of up to {@link GI_CAPTURE_SLOTS} probes of one volume, nearest the camera first, draws
 * its six cube faces through the frame's own G-buffer programs (`GeometryPass.captureInto`) into the tiles
 * of one capture atlas — six faces across, one probe a row, a viewport each — a draw budget a frame.
 * `giReduce` then turns the faces into each probe's hit cache tile and `giVisibility` its distance moments.
 * Only static geometry is drawn, and only when it changed: the capture is what a bake saves.
 *
 * RELIGHT. When the light changes (the sun turned past the tier's threshold, a baked light changed, the
 * sky), a volume's probes are relit in sweeps sized to the frame's ray budget (giJobs.ts): `giRadiance`
 * lights every ray's hit — sun with the volume's own shadow map, the baked lights, emissive, the bounce
 * from the previous result, the sky for a miss — and `giIntegrate` folds the rays into each probe's
 * irradiance tile with hysteresis. Nothing runs while nothing changes.
 *
 * APPLY. `giResolve` samples every volume in view at each G-buffer pixel (DDGI: trilinear, back-face and
 * Chebyshev visibility weights) into one texture the deferred pass takes as the indirect diffuse.
 *
 * Everything is on one STORE SCALE k (the frame's pre-exposure when the volumes were last reset), so night
 * light stays out of fp16's subnormals; the apply divides it back out.
 */

/** Probes captured per batch: one row of the capture atlas each. */
export const GI_CAPTURE_SLOTS = 8;
/** Pre-exposure drift (factor) that resets the store scale. */
const GI_SCALE_DRIFT = 4;

export interface GiSystemHost {
    readonly renderWidth: number;
    readonly renderHeight: number;
}

interface VolumeGpu {
    node: GIVolumeNode;
    /** What the GPU state was built for: a different key rebuilds it (and re-captures). */
    key: string;
    counts: [number, number, number];
    rays: number;
    side: number;
    probes: number;
    /** First global probe index in the shared atlases. */
    base: number;
    hit: Framebuffer;
    radiance: Framebuffer;
    states: Uint8Array;
    positions: Float32Array;
    sweep: GiSweepState;
    shadow: ProbeShadowMap;
    /** The light inputs this volume's last sweep began with. */
    lit: GiLightInputs | null;
    /** Captured probes waiting for their visibility. [min, max] local index, or null. */
    visibilityDirty: [number, number] | null;
    gridToWorld: mat4;
    worldToGrid: mat4;
    /** The CPU mirror: each probe's ambient cube (E/pi, store scale divided out), read back after sweeps. */
    ambient: Float32Array;
    /** A sweep ended since the last readback. */
    ambientDirty: boolean;
    /** Whether `ambient` holds a readback yet. */
    ambientValid: boolean;
    cubes: Framebuffer;
    cpu: GiVolumeCpu;
}

interface CaptureBatch {
    volume: VolumeGpu;
    /** Local probe index per slot (-1 empty). */
    probes: number[];
    slot: number;
    face: number;
    cursor: number;
}

/** The six faces, in giReduce.wgsl's order: +X, -X, +Y, -Y, +Z, -Z. */
const FACES: { dir: [number, number, number]; up: [number, number, number] }[] = [
    { dir: [1, 0, 0], up: [0, 1, 0] }, { dir: [-1, 0, 0], up: [0, 1, 0] },
    { dir: [0, 1, 0], up: [0, 0, 1] }, { dir: [0, -1, 0], up: [0, 0, 1] },
    { dir: [0, 0, 1], up: [0, 1, 0] }, { dir: [0, 0, -1], up: [0, 1, 0] },
];

export class GiSystem {
    private readonly _shaderManager = ShaderManager.Instance;
    private readonly _volumes = new Map<GIVolumeNode, VolumeGpu>();
    private _layout: GiAtlasLayout | null = null;
    private _irradiance: Framebuffer | null = null;
    private _visibility: Framebuffer | null = null;
    private _probeData: Texture | null = null;
    private _probeDataCpu = new Float32Array(0);
    private _probeDataDirty = false;
    private _atlasProbes = 0;
    private _capture: Framebuffer | null = null;
    /** The back faces of what encloses each probe, in the capture atlas's tiles (giReduce.wgsl u_capBack). */
    private _captureBack: Framebuffer | null = null;
    private _captureSide = 0;
    /** Classifications in flight (async readbacks of hit cache A). */
    private _classifying = 0;
    private _batch: CaptureBatch | null = null;
    private _target: Framebuffer | null = null;
    private _scale = 0;
    private _lastLight: GiLightInputs | null = null;
    private readonly _camera = new Camera({ type: 'perspective', fov: 90, near: 0.05, far: 50 });
    private readonly _frustum = new Frustum();
    private readonly _vp = mat4.create();
    private readonly _faceViewProj = new Float32Array(6 * 16);
    private readonly _faceInvViewProj = new Float32Array(6 * 16);
    private readonly _invScratch = mat4.create();
    private readonly _vec = vec3.create();
    private readonly _eye = vec3.create();
    private _supported: boolean | null = null;

    /** Applied this frame: the deferred pass reads {@link texture}. */
    public producedThisFrame = false;
    /** Whether GI is on (the tier's `giEnabled`, RenderSettings). */
    public enabled = true;
    /** Resolution of the apply, a fraction of the render size. */
    public resolutionScale = GI_TIERS.high.giResolutionScale;
    public raysPerFrame = GI_TIERS.high.giRaysPerFrame;
    public sunThreshold = GI_TIERS.high.giSunThreshold;
    public shadowTexel = GI_TIERS.high.giShadowTexel;
    public shadowMaxSize = GI_TIERS.high.giShadowMaxSize;
    public fillDrawsPerFrame = GI_TIERS.high.giFillDrawsPerFrame;
    public multiBounce = true;
    /** Counters for tests and the harness. */
    public readonly stats = { capturedProbes: 0, captureDraws: 0, relitProbes: 0, sweeps: 0, shadowDraws: 0, resolves: 0, loadedBakes: 0 };

    constructor(private readonly _host: GiSystemHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _shadows: ShadowPasses,
                private readonly _lighting: LightingPasses,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    /** The apply's result: rgb the claimed irradiance (E/pi, the frame's scale), a the share claimed. */
    public get texture(): Texture | null { return this.producedThisFrame && this._target ? this._target.colors[0] : null; }
    public get targetWidth(): number { return this._target?.width ?? 0; }
    public get targetHeight(): number { return this._target?.height ?? 0; }

    /** False when the device cannot render or filter half floats: GI is then off (warned once). */
    public get supported(): boolean {
        if (this._supported === null) {
            const probe = new Framebuffer({ colorAttachments: 1, colorTextureOptions: { precision: 'high', mipMap: false }, depth: false });
            probe.create(4, 4);
            this._supported = !probe.colors[0].downgraded;
            probe.destroy();
            if (!this._supported) Logger.warn('GI Volumes need half-float render targets; they are off on this device.', 'Renderer');
        }
        return this._supported;
    }

    /** Throw away every volume's light and relight from scratch (a scene load, the clock jumping hours). */
    public resetLighting(): void {
        for (const v of this._volumes.values()) v.sweep.request('reset');
    }

    // --- Per frame -----------------------------------------------------------------------------------

    /** Capture and relight: called once a frame, at its start (before any pass), as the probe bakes are. */
    public update(scene: Scene): void {
        if (!this.enabled || this._view.capturing || !device.capabilities || !this.supported) return;
        this._sync(scene);
        if (this._volumes.size === 0) return;
        this._watchLight(scene);
        try {
            this._captureStep(scene);
            this._relightStep(scene);
            this._readbackStep();
        } catch (e) {
            Logger.warn(`GI update failed: ${(e as Error)?.message ?? e}`, 'Renderer');
            this._batch = null;
        }
        this._uploadProbeData();
    }

    /**
     * The apply, after the G-buffer (and SSR): every volume in view at every pixel. False when nothing
     * was produced (no volume in view, none captured, GI off).
     */
    public resolve(scene: Scene): boolean {
        this.producedThisFrame = false;
        if (!this.enabled || !this._irradiance || this._volumes.size === 0 || !this.supported) return false;
        const cam = this._view.camera;
        const list = orderGiVolumes([...this._volumes.keys()].filter(n => this._volumes.get(n)!.states.some(s => s === GI_PROBE_ACTIVE)),
            cam.position);
        if (list.length === 0) return false;
        const w = Math.max(1, Math.round(this._host.renderWidth * this.resolutionScale));
        const h = Math.max(1, Math.round(this._host.renderHeight * this.resolutionScale));
        this._target ??= new Framebuffer({ colorAttachments: 1, colorTextureOptions: { precision: 'high', mipMap: false }, depth: false });
        if (this._target.width !== w || this._target.height !== h) this._target.create(w, h);

        const pass = this._passes.beginFullscreenPass(this._target.renderTarget, 'gi', true, [0, 0, 0, 0], false);
        const g = this._targets.gBuffer;
        const pipeline = this._fullscreen.bind(pass, 'giResolve', GiResolveProgram, [g.colors[1], g.depth]);
        pass.setBindGroup(2, this._atlasGroup(pipeline));
        this._shaderManager.bind('giResolve');
        const invVP = mat4.multiply(this._invScratch, cam.projectionMatrix, cam.viewMatrix);
        mat4.invert(invVP, invVP);
        this._shaderManager.setUniform('u_invViewProj', this._projection.uvConsuming(this._invScratch, invVP));
        this._shaderManager.setUniform('u_viewPos', cam.position);
        this._uploadVolumes(list, this._view.preExposure / this._scaleOrOne());
        this._passes.setViewport(w, h);
        this._passes.drawFullscreenAndEnd(pass);
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        this.producedThisFrame = true;
        this.stats.resolves++;
        return true;
    }

    // --- Volumes and atlases -----------------------------------------------------------------------------

    private _volumeKey(node: GIVolumeNode): string {
        const m = node.worldTransform;
        const t: number[] = [];
        for (let i = 0; i < 16; i++) t.push(Math.round(m[i] * 1e4));
        return [...node.size, ...node.probeCounts, node.rays, node.maxRayDistance, node.captureResolution, ...t].join(',');
    }

    private _sync(scene: Scene): void {
        let changed = false;
        const present = scene.giVolumes;
        for (const [node, v] of this._volumes) {
            if (!present.has(node)) { this._release(v); this._volumes.delete(node); changed = true; }
        }
        const built: VolumeGpu[] = [];
        for (const node of present) {
            const key = this._volumeKey(node);
            const v = this._volumes.get(node);
            if (v && v.key === key && !node.captureRequested) continue;
            if (v) this._release(v);
            const fresh = this._build(node, key);
            this._volumes.set(node, fresh);
            built.push(fresh);
            node.markCaptured();
            changed = true;
        }
        if (changed) this._layoutAtlases();
        // A volume with a saved capture loads it instead of capturing; one whose bake no longer matches
        // it, or the geometry round it, captures again (and the host is told).
        for (const v of built) {
            if (this._loadBake(scene, v)) this._updateVisibility(v);
        }
    }

    // --- Saved captures ------------------------------------------------------------------------------

    /**
     * What a capture of `v` depends on, as a signature: every static node it could draw within its rays'
     * reach — its id, its transform, its mesh and material — so a load can tell the scene moved on.
     */
    private _signature(scene: Scene, v: VolumeGpu): [number, number] {
        const box = v.node.getBoundingBox();
        const r = v.node.maxRayDistance;
        const sig = new GiSignature();
        const nodes: ModelNode[] = [];
        for (const node of scene.models) {
            if (!inCapture(node)) continue;
            const b = node.getBoundingBox();
            if (b.max[0] < box.min[0] - r || b.min[0] > box.max[0] + r || b.max[1] < box.min[1] - r
                || b.min[1] > box.max[1] + r || b.max[2] < box.min[2] - r || b.min[2] > box.max[2] + r) continue;
            nodes.push(node);
        }
        nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const node of nodes) {
            sig.addString(node.id).addNumbers(node.worldTransform);
            sig.addString(node.model.material.type).addNumber(node.model.mesh?.indexCount ?? 0);
        }
        return sig.value;
    }

    /** Load `v`'s saved capture from the registry. False when it has none, or none that fits. */
    private _loadBake(scene: Scene, v: VolumeGpu): boolean {
        const node = v.node;
        const bytes = GiBakeRegistry.get(node.bakeId);
        if (!bytes) return false;
        let bake;
        try {
            bake = decodeGiBake(bytes);
        } catch (e) {
            Logger.warn(`GI bake ${node.bakeId} (${node.name}) cannot be read: ${(e as GiBakeFormatError)?.message ?? e}; capturing again.`, 'Renderer');
            return false;
        }
        const sameShape = bake.counts[0] === v.counts[0] && bake.counts[1] === v.counts[1] && bake.counts[2] === v.counts[2]
            && bake.rays === v.rays && bake.captureResolution === node.captureResolution
            && Math.abs(bake.maxRayDistance - node.maxRayDistance) < 1e-3
            && bake.size.every((s, i) => Math.abs(s - node.size[i]) < 1e-3);
        if (!sameShape) {
            Logger.warn(`GI bake of ${node.name} was taken for a different grid; capturing again.`, 'Renderer');
            this.staleBakes.add(node.id);
            return false;
        }
        if (!sameGiSignature(bake.signature, this._signature(scene, v))) {
            Logger.warn(`The geometry round ${node.name} changed since its GI bake; capturing again.`, 'Renderer');
            this.staleBakes.add(node.id);
            return false;
        }
        const [w, h] = hitCacheSize(v.probes, v.rays);
        device.writeTexture(v.hit.colors[0].rhiTexture, bake.hitA, w, h);
        device.writeTexture(v.hit.colors[1].rhiTexture, bake.hitB, w, h);
        device.writeTexture(v.hit.colors[2].rhiTexture, bake.hitC, w, h);
        for (let p = 0; p < v.probes; p++) {
            const state = Math.round(bake.probeData[p * 4 + 3]);
            v.states[p] = state === GI_PROBE_ACTIVE || state === 2 || state === GI_PROBE_SKIPPED ? state : GI_PROBE_UNCAPTURED;
            this._writeProbeData(v, p);
        }
        this._probeDataDirty = true;
        this.staleBakes.delete(node.id);
        v.visibilityDirty = [0, v.probes - 1];
        v.sweep.request('reset');
        this.stats.loadedBakes++;
        return true;
    }

    /** Volumes whose saved capture no longer fits them (by node id): the editor offers to save a new one. */
    public readonly staleBakes = new Set<string>();

    /** Whether every probe of `node`'s volume is captured and classified: a bake can be saved. */
    public isCaptured(node: GIVolumeNode): boolean {
        const v = this._volumes.get(node);
        return !!v && v.states.every(s => s !== GI_PROBE_UNCAPTURED && s !== GI_PROBE_PENDING);
    }

    /**
     * The `.cgib` bytes of `node`'s capture (giBakeFormat.ts), for a host to save and name in `bakeId`.
     * Null until every probe is captured. Reads the hit caches back, so it resolves a frame or so later.
     */
    public async exportBake(node: GIVolumeNode, scene: Scene): Promise<Uint8Array | null> {
        const v = this._volumes.get(node);
        if (!v || !this.isCaptured(node)) return null;
        const [w, h] = hitCacheSize(v.probes, v.rays);
        this._passes.flushFrameEncoder(true);
        const [hitA, hitB, hitC] = await Promise.all(v.hit.colors.map(c => device.readPixels(c.attachmentView, 0, 0, w, h)));
        if (this._volumes.get(node) !== v) return null;
        const probeData = new Float32Array(v.probes * 4);
        for (let p = 0; p < v.probes; p++) probeData[p * 4 + 3] = v.states[p];
        return encodeGiBake({
            counts: [v.counts[0], v.counts[1], v.counts[2]], rays: v.rays, captureResolution: node.captureResolution,
            maxRayDistance: node.maxRayDistance, size: [node.size[0], node.size[1], node.size[2]],
            signature: this._signature(scene, v), probeData,
            hitA: new Uint8Array(hitA.buffer, hitA.byteOffset, w * h * 4),
            hitB: new Uint8Array(hitB.buffer, hitB.byteOffset, w * h * 4),
            hitC: new Uint8Array(hitC.buffer, hitC.byteOffset, w * h * 4),
        });
    }

    private _build(node: GIVolumeNode, key: string): VolumeGpu {
        const counts = [...node.probeCounts] as [number, number, number];
        const probes = counts[0] * counts[1] * counts[2];
        const rays = node.rays, side = node.raySide;
        const [w, h] = hitCacheSize(probes, rays);
        const hit = new Framebuffer({ colorAttachments: 3, depth: false,
            colorTextureOptions: { precision: 'low', mipMap: false, minFilter: 'nearest', magFilter: 'nearest', wrapping: 'clamp' } });
        hit.create(w, h);
        const radiance = new Framebuffer({ colorAttachments: 1, depth: false,
            colorTextureOptions: { precision: 'high', mipMap: false, minFilter: 'nearest', magFilter: 'nearest', wrapping: 'clamp' } });
        radiance.create(w, h);
        const gridToWorld = node.gridToWorld(mat4.create());
        const worldToGrid = mat4.invert(mat4.create(), gridToWorld) ?? mat4.create();
        const positions = new Float32Array(probes * 3);
        const p = vec3.create();
        for (let i = 0; i < probes; i++) {
            const [a, b, c] = gridCoords(i, counts);
            vec3.transformMat4(p, vec3.set(p, a, b, c), gridToWorld);
            positions.set(p, i * 3);
        }
        const sweep = new GiSweepState(probes, node.multiBounce);
        const cubes = new Framebuffer({ colorAttachments: 1, depth: false,
            colorTextureOptions: { precision: 'low', mipMap: false, minFilter: 'nearest', magFilter: 'nearest', wrapping: 'clamp' } });
        cubes.create(64 * 6, Math.max(1, Math.ceil(probes / 64)));
        const states = new Uint8Array(probes);
        const ambient = new Float32Array(probes * GI_AMBIENT_CUBE_FLOATS);
        const cpu: GiVolumeCpu = {
            counts, worldToGrid, weightAt: (p) => node.weightAt(p as vec3), get intensity() { return node.intensity; },
            states, ambient,
        };
        return {
            node, key, counts, rays, side, probes, base: 0, hit, radiance,
            states, positions, sweep, shadow: new ProbeShadowMap(), lit: null,
            visibilityDirty: null, gridToWorld, worldToGrid, ambient, ambientDirty: false, ambientValid: false, cubes, cpu,
        };
    }

    private _release(v: VolumeGpu): void {
        v.hit.destroy();
        v.radiance.destroy();
        v.cubes.destroy();
        v.shadow.delete();
        if (this._batch?.volume === v) this._batch = null;
    }

    /** Hand out global probe ranges and size the shared atlases for them; everything relights after. */
    private _layoutAtlases(): void {
        const layout = this._layout ??= giAtlasLayout(device.capabilities.maxTextureSize);
        let total = 0;
        for (const v of this._volumes.values()) { v.base = total; total += v.probes; }
        if (total > layout.capacity) {
            Logger.warn(`GI Volumes: ${total} probes are more than this device's atlases hold (${layout.capacity}); the last volumes are dropped.`, 'Renderer');
        }
        const sizes = giAtlasSizes(layout, Math.max(1, total));
        const atlas = () => new Framebuffer({ colorAttachments: 1, depth: false,
            colorTextureOptions: { precision: 'high', mipMap: false, minFilter: 'linear', magFilter: 'linear', wrapping: 'clamp' } });
        if (!this._irradiance || this._atlasProbes !== total) {
            this._irradiance?.destroy();
            this._visibility?.destroy();
            this._irradiance = atlas();
            this._irradiance.create(sizes.irradiance[0], sizes.irradiance[1]);
            this._visibility = atlas();
            this._visibility.create(sizes.visibility[0], sizes.visibility[1]);
            this._probeData?.delete();
            this._probeData = new Texture({ format: 'rgba32float', loadOnly: true, mipMap: false,
                minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest', wrapping: 'clamp' });
            this._probeData.create(null, sizes.probeData[0], sizes.probeData[1]);
            this._probeDataCpu = new Float32Array(sizes.probeData[0] * sizes.probeData[1] * 4);
            this._atlasProbes = total;
            // Cleared atlases: every captured probe's visibility is rebuilt, every volume relit from scratch.
            const clearIrr = this._passes.beginFullscreenPass(this._irradiance.renderTarget, 'giClear', true, [0, 0, 0, 1], false);
            this._passes.endFullscreenPass(clearIrr);
            const clearVis = this._passes.beginFullscreenPass(this._visibility.renderTarget, 'giClear', true, [1, 1, 0, 1], false);
            this._passes.endFullscreenPass(clearVis);
        }
        for (const v of this._volumes.values()) {
            for (let p = 0; p < v.probes; p++) this._writeProbeData(v, p);
            if (v.states.some(s => s === GI_PROBE_ACTIVE)) v.visibilityDirty = [0, v.probes - 1];
            v.sweep.request('reset');
        }
        this._probeDataDirty = true;
    }

    private _writeProbeData(v: VolumeGpu, p: number): void {
        const g = v.base + p;
        if (g * 4 + 3 >= this._probeDataCpu.length) return;
        this._probeDataCpu[g * 4] = 0;
        this._probeDataCpu[g * 4 + 1] = 0;
        this._probeDataCpu[g * 4 + 2] = 0;
        this._probeDataCpu[g * 4 + 3] = v.states[p];
    }

    private _uploadProbeData(): void {
        if (!this._probeDataDirty || !this._probeData) return;
        const tex = this._probeData;
        device.writeTexture(tex.rhiTexture, this._probeDataCpu, tex.width, tex.height);
        this._probeDataDirty = false;
    }

    // --- Capture ---------------------------------------------------------------------------------------

    private _captureStep(scene: Scene): void {
        let batch = this._batch;
        if (!batch) {
            batch = this._nextBatch(scene);
            if (!batch) return;
            this._batch = batch;
        }
        const v = batch.volume;
        const S = v.node.captureResolution;
        this._ensureCaptureAtlas(S);
        const atlas = this._capture!;
        let budget = Math.max(1, this.fillDrawsPerFrame);
        const include = (node: ModelNode) => inCapture(node);
        this._withCaptureState(v.node, () => {
            if (batch!.slot === 0 && batch!.face === 0 && batch!.cursor === 0) {
                for (const fb of [atlas, this._captureBack!]) {
                    const clear = this._passes.beginFullscreenPass(fb.renderTarget, 'giCapture', true, [0, 0, 0, 0], true, true);
                    this._passes.endFullscreenPass(clear);
                }
            }
            while (batch!.slot < GI_CAPTURE_SLOTS && budget > 0) {
                const probe = batch!.probes[batch!.slot];
                if (probe < 0) { batch!.slot++; batch!.face = 0; batch!.cursor = 0; continue; }
                this._aim(v, probe, batch!.face);
                const frustum = this._frustum;
                const pass = this._passes.beginFullscreenPass(atlas.renderTarget, 'giCapture', false, undefined, false);
                pass.setViewport(batch!.face * S, batch!.slot * S, S, S);
                const admitted = this._sys.geometry.captureInto(pass, scene, include, (node) => {
                    const s = node.getBoundingSphere();
                    return frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius);
                }, 100 + batch!.slot * 6 + batch!.face, batch!.cursor, budget);
                this._passes.endFullscreenPass(pass);
                const drawn = Math.max(0, Math.min(budget, admitted - batch!.cursor));
                this.stats.captureDraws += drawn;
                batch!.cursor += drawn;
                budget -= Math.max(1, drawn);
                if (batch!.cursor >= admitted) {
                    this._drawBackfaces(scene, v, probe, batch!.slot, batch!.face, S);
                    batch!.cursor = 0;
                    if (++batch!.face >= 6) { batch!.face = 0; batch!.slot++; }
                }
            }
        });
        if (batch.slot < GI_CAPTURE_SLOTS) return;

        // All faces drawn: the hit cache tiles and the visibility now; the states once the rays' kinds are
        // read back (a probe inside something is switched off before it ever lights anything).
        this._reduce(batch);
        let lo = Infinity, hi = -Infinity;
        for (const p of batch.probes) {
            if (p < 0) continue;
            lo = Math.min(lo, p); hi = Math.max(hi, p);
        }
        for (const p of batch.probes) if (p >= 0) { v.states[p] = GI_PROBE_PENDING; this._writeProbeData(v, p); }
        this._probeDataDirty = true;
        if (lo <= hi) {
            v.visibilityDirty = [lo, hi];
            this._updateVisibility(v);
            this._classify(v, batch.probes.filter(p => p >= 0), lo, hi);
        }
        this._batch = null;
    }

    /**
     * Read back hit cache A's rows under `probes` and set their states: active, or inactive past a quarter of
     * back-face rays (giClassify.ts). The volume relights once they land.
     */
    private _classify(v: VolumeGpu, probes: number[], lo: number, hi: number): void {
        const side = v.side;
        const firstRow = Math.floor(lo / 64) * side;
        const rows = (Math.floor(hi / 64) + 1) * side - firstRow;
        // Submit first: the readback runs on its own encoder (sky.ts does the same).
        this._passes.flushFrameEncoder(true);
        this._classifying++;
        void device.readPixels(v.hit.colors[0].attachmentView, 0, firstRow, v.hit.width, rows)
            .then((pixels) => {
                if (this._volumes.get(v.node) !== v) return;
                const states = new Uint8Array(v.probes);
                classifyHitRows(pixels, firstRow, rows, v.rays, lo, hi - lo + 1, states);
                for (const p of probes) {
                    v.states[p] = states[p] || GI_PROBE_ACTIVE;
                    this._writeProbeData(v, p);
                    this.stats.capturedProbes++;
                }
                this._probeDataDirty = true;
                v.sweep.request(v.lit ? 'relight' : 'reset');
            })
            .catch((e) => {
                Logger.warn(`GI classification failed: ${(e as Error)?.message ?? e}`, 'Renderer');
                for (const p of probes) { v.states[p] = GI_PROBE_ACTIVE; this._writeProbeData(v, p); }
                this._probeDataDirty = true;
            })
            .then(() => { this._classifying--; });
    }

    /**
     * The back faces of the static, single-sided nodes whose bounds hold the probe, into the back atlas's
     * tile: a ray that meets one nearer than any front face is a back-face hit (the probe is inside that
     * node). Double-sided materials have no inside and are left out.
     */
    private _drawBackfaces(scene: Scene, v: VolumeGpu, probe: number, slot: number, face: number, S: number): void {
        const x = v.positions[probe * 3], y = v.positions[probe * 3 + 1], z = v.positions[probe * 3 + 2];
        const eps = 1e-3;
        const holds = (node: ModelNode): boolean => {
            if (!inCapture(node) || node.model.material.config.side === 'double') return false;
            const b = node.getBoundingBox();
            return x >= b.min[0] - eps && x <= b.max[0] + eps && y >= b.min[1] - eps && y <= b.max[1] + eps
                && z >= b.min[2] - eps && z <= b.max[2] + eps;
        };
        let any = false;
        for (const node of scene.models) if (holds(node)) { any = true; break; }
        if (!any) return;
        const frustum = this._frustum;
        const pass = this._passes.beginFullscreenPass(this._captureBack!.renderTarget, 'giBackface', false, undefined, false);
        pass.setViewport(face * S, slot * S, S, S);
        ModelDraw.invertCull = true;
        try {
            this._sys.geometry.captureInto(pass, scene, holds, (node) => {
                const s = node.getBoundingSphere();
                return frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius);
            }, 200 + slot * 6 + face);
        } finally {
            ModelDraw.invertCull = false;
            this._passes.endFullscreenPass(pass);
        }
    }

    /** The next capture batch: the uncaptured probes nearest the camera, of the volume they are in. */
    private _nextBatch(scene: Scene): CaptureBatch | null {
        const cam = this._view.camera.position;
        const vols = [...this._volumes.values()].filter(v => v.base + v.probes <= (this._layout?.capacity ?? 0));
        const nearest = nearestUncaptured(vols, cam, 1);
        if (nearest.length === 0) return null;
        const v = vols[nearest[0].volume];
        const picks = nearestUncaptured([v], cam, GI_CAPTURE_SLOTS * 2);
        const probes: number[] = [];
        for (const c of picks) {
            if (probes.length >= GI_CAPTURE_SLOTS) break;
            const x = v.positions[c.probe * 3], y = v.positions[c.probe * 3 + 1], z = v.positions[c.probe * 3 + 2];
            if (isUnderground(y, this._groundAt(scene, x, z))) {
                v.states[c.probe] = GI_PROBE_SKIPPED;
                this._writeProbeData(v, c.probe);
                this._probeDataDirty = true;
                continue;
            }
            probes.push(c.probe);
        }
        if (probes.length === 0) return this._nextBatch(scene);
        while (probes.length < GI_CAPTURE_SLOTS) probes.push(-1);
        return { volume: v, probes, slot: 0, face: 0, cursor: 0 };
    }

    /** The landscape's surface height under world (x, z), or null where no landscape is. */
    private _groundAt(scene: Scene, x: number, z: number): number | null {
        for (const land of scene.landscapes) {
            const inv = mat4.invert(this._invScratch, land.worldTransform);
            if (!inv) continue;
            const local = vec3.transformMat4(this._vec, vec3.set(this._vec, x, 0, z), inv);
            const terrain = land.terrain;
            const half = terrain.size / 2;
            if (Math.abs(local[0]) > half || Math.abs(local[2]) > half) continue;
            const h = terrain.heightAt(local[0], local[2]);
            const world = vec3.transformMat4(this._vec, vec3.set(this._vec, local[0], h, local[2]), land.worldTransform);
            return world[1];
        }
        return null;
    }

    private _ensureCaptureAtlas(S: number): void {
        if (this._capture && this._captureSide === S) return;
        this._capture?.destroy();
        this._captureBack?.destroy();
        // The frame G-buffer's own layout (three rgba16f targets and depth), so the frame's geometry
        // pipelines draw into it unchanged — the back-face atlas too, for the same pipelines.
        this._capture = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._capture.create(6 * S, GI_CAPTURE_SLOTS * S);
        this._captureBack = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._captureBack.create(6 * S, GI_CAPTURE_SLOTS * S);
        this._captureSide = S;
    }

    /** Everything a capture swaps: the camera (90 degrees, square, out to the volume's ray reach), `capturing`. */
    private _withCaptureState(node: GIVolumeNode, body: () => void): void {
        const cam = this._camera;
        cam.fov = 90;
        cam.near = 0.05;
        cam.far = node.maxRayDistance;
        cam.resize(1, 1);
        const prevCamera = this._view.camera;
        this._view.capturing = true;
        this._view.camera = cam;
        try {
            body();
        } finally {
            this._view.camera = prevCamera;
            this._view.capturing = false;
            this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        }
    }

    private _aim(v: VolumeGpu, probe: number, face: number): void {
        const cam = this._camera;
        const f = FACES[face];
        const p = vec3.set(this._vec, v.positions[probe * 3], v.positions[probe * 3 + 1], v.positions[probe * 3 + 2]);
        cam.position = p;
        cam.eye = vec3.add(this._eye, p, f.dir);
        cam.up = vec3.fromValues(f.up[0], f.up[1], f.up[2]);
        mat4.multiply(this._vp, cam.projectionMatrix, cam.viewMatrix);
        this._frustum.setFromViewProjection(this._vp);
    }

    /** The faces' rotation-only view-projections (GL convention) and their inverses, for the reduce. */
    private _faceMatrices(node: GIVolumeNode): void {
        const cam = this._camera;
        cam.fov = 90; cam.near = 0.05; cam.far = node.maxRayDistance; cam.resize(1, 1);
        const view = mat4.create(), vp = mat4.create(), inv = mat4.create();
        for (let f = 0; f < 6; f++) {
            mat4.lookAt(view, [0, 0, 0], FACES[f].dir, FACES[f].up);
            mat4.multiply(vp, cam.projectionMatrix, view);
            this._faceViewProj.set(vp, f * 16);
            mat4.invert(inv, vp);
            this._faceInvViewProj.set(inv, f * 16);
        }
    }

    private _reduce(batch: CaptureBatch): void {
        const v = batch.volume, S = this._captureSide;
        this._faceMatrices(v.node);
        const atlas = this._capture!;
        const pass = this._passes.beginFullscreenPass(v.hit.renderTarget, 'giReduce', false, undefined, false);
        // Three targets: the fullscreen helper's pipelines write one.
        const pipeline = this._pipelines.get('giReduce', GiReduceProgram, { vertex: 'model', builtFor: 'giReduce', targets: 3 });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0,
            [atlas.colors[0], atlas.colors[1], atlas.colors[2], atlas.depth, this._captureBack!.depth]));
        this._shaderManager.bind('giReduce');
        this._shaderManager.setUniform('u_faceViewProj', this._faceViewProj);
        this._shaderManager.setUniform('u_faceInvViewProj', this._faceInvViewProj);
        this._shaderManager.setUniform('u_batch', batch.probes);
        this._shaderManager.setUniform('u_maxRayDistance', v.node.maxRayDistance);
        this._shaderManager.setUniform('u_raySide', v.side);
        this._shaderManager.setUniform('u_captureSide', S);
        this._shaderManager.setUniform('u_originTopLeft', device.capabilities.conventions.originTopLeft ? 1 : 0);
        this._shaderManager.setUniform('u_hasBackfaces', 1);
        this._shaderManager.setUniform('u_captureSize', [atlas.width, atlas.height]);
        this._passes.setViewport(v.hit.width, v.hit.height);
        this._passes.drawFullscreenAndEnd(pass);
    }

    private _updateVisibility(v: VolumeGpu): void {
        const range = v.visibilityDirty;
        if (!range || !this._visibility || !this._layout) return;
        const pass = this._passes.beginFullscreenPass(this._visibility.renderTarget, 'giVisibility', false, undefined, false);
        this._fullscreen.bind(pass, 'giVisibility', GiVisibilityProgram, [v.hit.colors[0], v.hit.colors[1]]);
        this._shaderManager.bind('giVisibility');
        this._shaderManager.setUniform('u_volumeBase', v.base);
        this._shaderManager.setUniform('u_first', range[0]);
        this._shaderManager.setUniform('u_count', range[1] - range[0] + 1);
        this._shaderManager.setUniform('u_raySide', v.side);
        this._shaderManager.setUniform('u_tilesPerRow', this._layout.visibilityPerRow);
        this._shaderManager.setUniform('u_power', v.side >= 16 ? 24 : 8);
        this._passes.setViewport(this._visibility.width, this._visibility.height);
        this._passes.drawFullscreenAndEnd(pass);
        v.visibilityDirty = null;
    }

    // --- Relight ---------------------------------------------------------------------------------------

    /** What the light is this frame, and what it calls for: a reset on a jump, a relight on a change. */
    private _watchLight(scene: Scene): void {
        const now = this._lightInputs(scene);
        const k = this._view.preExposure;
        const drifted = this._scale > 0 && (k / this._scale > GI_SCALE_DRIFT || this._scale / k > GI_SCALE_DRIFT);
        if (this._scale <= 0 || drifted || isLightJump(this._lastLight, now)) {
            this._scale = k;
            for (const v of this._volumes.values()) v.sweep.request('reset');
        } else {
            for (const v of this._volumes.values()) {
                if (v.lit && v.sweep.idle && needsRelight(v.lit, now)) v.sweep.request('relight');
            }
        }
        this._lastLight = now;
    }

    private _lightInputs(scene: Scene): GiLightInputs {
        let sun: LightNode | null = null;
        for (const node of scene.lights) if (node.type === 'directional' && node.bake) { sun = node; break; }
        const sunDir = sun ? this._lighting.dirOf(sun) as unknown as number[] : null;
        const sunIntensity = sun ? (this._lighting.keyLight && sun === this._lighting.keyLightNode
            ? this._lighting.keyLight.intensity : (sun.light as any).internalIntensity ?? 0) : 0;
        const sh = this._sys.sky.skySHValid ? this._sys.sky.skySH : null;
        const skyL0 = scene.skyLight && sh ? (sh[0] + sh[1] + sh[2]) * scene.skyLight.intensity : 0;
        const values: number[] = [];
        for (const node of scene.lights) {
            if (node.type === 'directional' || !node.bake) continue;
            const p = node.worldPosition;
            const l = node.light as any;
            values.push(p[0], p[1], p[2], l.internalIntensity ?? 0, l.color?.[0] ?? 0, l.color?.[1] ?? 0, l.color?.[2] ?? 0, l.range ?? 0);
        }
        return { sunDir: sunDir ? [sunDir[0], sunDir[1], sunDir[2]] : null, sunIntensity, skyL0, lightSignature: hashNumbers(values) };
    }

    private _relightStep(scene: Scene): void {
        if (!this._irradiance || !this._layout) return;
        const cam = this._view.camera.position;
        const vols = [...this._volumes.values()]
            .filter(v => v.states.some(s => s === GI_PROBE_ACTIVE))
            .sort((a, b) => a.node.distanceToVolume(cam as vec3) - b.node.distanceToVolume(cam as vec3));
        // A volume whose sun map is out of date redraws it (one a frame) and relights.
        let shadowBudget = 1;
        const now = this._lastLight;
        for (const v of vols) {
            const due = !v.shadow.ready || needsShadowRender(v.shadow.lightDir, now?.sunDir ?? null, this.sunThreshold);
            if (!due || shadowBudget <= 0 || !now?.sunDir) continue;
            const node = v.node;
            const radius = this._shadows.probeShadowRadius(true, node.size, node.worldScale);
            const size = giShadowMapSize(2 * radius, this.shadowTexel, this.shadowMaxSize);
            if (this._shadows.renderProbeShadows(scene, node.worldPosition, radius, v.shadow, size)) {
                shadowBudget--;
                this.stats.shadowDraws++;
                if (v.sweep.idle) v.sweep.request('relight');
            }
        }
        const sweeps = vols.filter(v => !v.sweep.idle).map(v => ({ state: v.sweep, rays: v.rays, v }));
        if (sweeps.length === 0) return;
        const batches = planRelightFrame(sweeps, this.raysPerFrame);
        if (batches.length === 0) return;
        const k = this._scaleOrOne();
        const prevPre = this._view.preExposure, prevDraw = this._view.drawPreExposure;
        this._view.preExposure = k;
        this._view.drawPreExposure = k;
        this._view.capturing = true;
        this._shadows.shadowsSuppressed = true;
        this._lighting.beginBakeLights(scene);
        try {
            const ordered = orderGiVolumes(vols.map(v => v.node), cam);
            for (const b of batches) {
                const v = sweeps[b.volume].v;
                if (b.first === 0 && v.sweep) v.lit = now;
                this._radiance(scene, v, b.first, b.count, b.bounce, ordered);
                this._integrate(v, b.first, b.count, b.hysteresis);
                this.stats.relitProbes += b.count;
                if (b.endsSweep) { this.stats.sweeps++; v.ambientDirty = true; }
            }
        } finally {
            this._lighting.endBakeLights();
            this._shadows.shadowsSuppressed = false;
            this._shadows.endProbeShadows();
            this._view.capturing = false;
            this._view.preExposure = prevPre;
            this._view.drawPreExposure = prevDraw;
            this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        }
    }

    private _radiance(scene: Scene, v: VolumeGpu, first: number, count: number, bounce: boolean, ordered: GIVolumeNode[]): void {
        this._shadows.activateProbeShadows(v.shadow);
        const pass = this._passes.beginFullscreenPass(v.radiance.renderTarget, 'giRadiance', false, undefined, false);
        const pipeline = this._fullscreen.bind(pass, 'giRadiance', GiRadianceProgram, [v.hit.colors[0], v.hit.colors[1], v.hit.colors[2]]);
        pass.setBindGroup(2, this._atlasGroup(pipeline));
        pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline));
        this._lighting.uploadSceneLighting('giRadiance', scene, true);
        this._shadows.uploadShadowUniforms('giRadiance');
        this._shaderManager.setUniform('u_gridToWorld', v.gridToWorld);
        this._shaderManager.setUniform('u_counts', [v.counts[0], v.counts[1], v.counts[2], v.base]);
        this._shaderManager.setUniform('u_first', first);
        this._shaderManager.setUniform('u_count', count);
        this._shaderManager.setUniform('u_raySide', v.side);
        this._shaderManager.setUniform('u_maxRayDistance', v.node.maxRayDistance);
        this._shaderManager.setUniform('u_bounce', bounce ? 1 : 0);
        this._shaderManager.setUniform('u_ownVolume', Math.min(ordered.indexOf(v.node), MAX_GI_VOLUMES - 1));
        const lights = this._lightIndices(scene, v);
        this._shaderManager.setUniform('u_lightIndex', lights);
        this._shaderManager.setUniform('u_lightCount', lights.count);
        this._uploadVolumes(ordered, 1);
        this._passes.setViewport(v.radiance.width, v.radiance.height);
        this._passes.drawFullscreenAndEnd(pass);
        this._shadows.endProbeShadows();
    }

    private _integrate(v: VolumeGpu, first: number, count: number, hysteresis: number): void {
        const atlas = this._irradiance!;
        const pass = this._passes.beginFullscreenPass(atlas.renderTarget, 'giIntegrate', false, undefined, false);
        this._fullscreen.bind(pass, 'giIntegrate', GiIntegrateProgram, [v.radiance.colors[0]], DEFAULT_BLEND);
        this._shaderManager.bind('giIntegrate');
        const weights = tileSolidAngles(v.side);
        const padded = new Float32Array(256);
        padded.set(weights);
        this._shaderManager.setUniform('u_rayWeights', padded);
        this._shaderManager.setUniform('u_volumeBase', v.base);
        this._shaderManager.setUniform('u_first', first);
        this._shaderManager.setUniform('u_count', count);
        this._shaderManager.setUniform('u_raySide', v.side);
        this._shaderManager.setUniform('u_tilesPerRow', this._layout!.irradiancePerRow);
        this._shaderManager.setUniform('u_hysteresis', hysteresis);
        this._passes.setViewport(atlas.width, atlas.height);
        this._passes.drawFullscreenAndEnd(pass);
    }

    /**
     * The baked lights volume `v` takes: those whose range meets its box and that do not stand inside a
     * smaller volume nested in it — a torch in a room lights the room's volume, not the street's.
     * Indices into the bake grid (the lights' order in `scene.lights`, directional ones skipped).
     */
    private _lightIndices(scene: Scene, v: VolumeGpu): number[] & { count: number } {
        const out = new Array(32).fill(0) as number[] & { count: number };
        let n = 0, index = 0;
        const box = v.node.getBoundingBox();
        for (const node of scene.lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            const i = index++;
            if (!node.bake || n >= 32) continue;
            const p = node.worldPosition;
            const range = (node.light as any).range ?? 0;
            if (p[0] + range < box.min[0] || p[0] - range > box.max[0] || p[1] + range < box.min[1] || p[1] - range > box.max[1]
                || p[2] + range < box.min[2] || p[2] - range > box.max[2]) continue;
            let nested = false;
            for (const other of this._volumes.values()) {
                if (other === v || other.node.volumeSize >= v.node.volumeSize) continue;
                if (other.node.weightAt(p as vec3) > 0 && v.node.weightAt(other.node.worldPosition as vec3) > 0) { nested = true; break; }
            }
            if (nested) continue;
            out[n++] = i;
        }
        out.count = n;
        return out;
    }

    /** The volume descriptors (giSample.wgsl GiVolumeBlock) for `list`, each light scaled by `scale`. */
    private _uploadVolumes(list: readonly GIVolumeNode[], scale: number): void {
        const n = Math.min(list.length, MAX_GI_VOLUMES);
        const w2g = new Float32Array(16 * 16), g2w = new Float32Array(16 * 16), inv = new Float32Array(16 * 16);
        const counts = new Array(16 * 4).fill(0), blend = new Float32Array(16 * 4), bias = new Float32Array(16 * 4);
        for (let i = 0; i < n; i++) {
            const v = this._volumes.get(list[i])!;
            w2g.set(v.worldToGrid, i * 16);
            g2w.set(v.gridToWorld, i * 16);
            inv.set(v.node.invVolumeMatrix, i * 16);
            counts[i * 4] = v.counts[0]; counts[i * 4 + 1] = v.counts[1]; counts[i * 4 + 2] = v.counts[2]; counts[i * 4 + 3] = v.base;
            const b = v.node.volumeBlend;
            blend[i * 4] = b[0]; blend[i * 4 + 1] = b[1]; blend[i * 4 + 2] = b[2]; blend[i * 4 + 3] = v.node.intensity * scale;
            const spacing = v.node.minSpacing;
            bias[i * 4] = v.node.normalBias * spacing; bias[i * 4 + 1] = v.node.viewBias * spacing;
            bias[i * 4 + 2] = v.node.maxRayDistance;
        }
        const layout = this._layout!;
        this._shaderManager.setUniform('u_giWorldToGrid', w2g);
        this._shaderManager.setUniform('u_giGridToWorld', g2w);
        this._shaderManager.setUniform('u_giInvVolume', inv);
        this._shaderManager.setUniform('u_giCounts', counts);
        this._shaderManager.setUniform('u_giBlend', blend);
        this._shaderManager.setUniform('u_giBias', bias);
        this._shaderManager.setUniform('u_giAtlas', [layout.irradiancePerRow, layout.visibilityPerRow, layout.probeDataPerRow, 0]);
        this._shaderManager.setUniform('u_giAtlasSize', [this._irradiance!.width, this._irradiance!.height, this._visibility!.width, this._visibility!.height]);
        this._shaderManager.setUniform('u_giVolumeCount', n);
    }

    private _scaleOrOne(): number { return this._scale > 0 ? this._scale : 1; }

    /**
     * Group 2, the shared atlases (chunks/giSample.wgsl), with only the bindings `pipeline` declares: an
     * auto layout drops what a shader never reads, and naming it anyway invalidates the group.
     */
    private _atlasGroup(pipeline: RenderPipeline): BindGroup {
        const declared = new Set(pipeline.resources.filter(r => r.group === 2).map(r => r.binding));
        const textures: Texture[] = [], bindings: number[] = [];
        const all: [number, Texture][] = [[0, this._irradiance!.colors[0]], [2, this._visibility!.colors[0]], [4, this._probeData!]];
        for (const [binding, texture] of all) if (declared.has(binding)) { textures.push(texture); bindings.push(binding); }
        return this._bindGroups.textureGroup(pipeline, 2, textures, bindings);
    }

    // --- The CPU mirror ----------------------------------------------------------------------------------

    private _readbackPending = false;
    private _lastReadback = 0;
    /** Seconds between ambient-cube readbacks (one volume each). */
    public static readonly READBACK_INTERVAL = 0.25;

    /**
     * One volume's ambient cubes, read back after its sweeps ended (throttled, one in flight): the CPU
     * twin's data. Called at the end of `update`, after the relight passes it reads.
     */
    private _readbackStep(): void {
        if (this._readbackPending || !this._irradiance) return;
        const now = performance.now() / 1000;
        if (now - this._lastReadback < GiSystem.READBACK_INTERVAL) return;
        const v = [...this._volumes.values()].find(x => x.ambientDirty);
        if (!v) return;
        v.ambientDirty = false;
        this._lastReadback = now;
        const fb = v.cubes;
        const pass = this._passes.beginFullscreenPass(fb.renderTarget, 'giAmbientCube', false, undefined, false);
        const pipeline = this._fullscreen.bind(pass, 'giAmbientCube', GiAmbientCubeProgram, [v.radiance.colors[0]]);
        pass.setBindGroup(2, this._atlasGroup(pipeline));
        this._shaderManager.bind('giAmbientCube');
        this._shaderManager.setUniform('u_volumeBase', v.base);
        this._shaderManager.setUniform('u_probeCount', v.probes);
        this._uploadVolumes([v.node], 1);
        this._passes.setViewport(fb.width, fb.height);
        this._passes.drawFullscreenAndEnd(pass);
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        // Submit before reading: the readback runs on its own encoder (sky.ts does the same).
        this._passes.flushFrameEncoder(true);
        const k = this._scaleOrOne();
        this._readbackPending = true;
        void device.readPixels(fb.colors[0].attachmentView, 0, 0, fb.width, fb.height)
            .then((pixels) => {
                if (!this._volumes.has(v.node) || this._volumes.get(v.node) !== v) return;
                for (let p = 0; p < v.probes; p++) {
                    const row = Math.floor(p / 64), col = (p % 64) * 6;
                    for (let d = 0; d < 6; d++) {
                        const i = (row * fb.width + col + d) * 4;
                        const a = pixels[i + 3];
                        const m = a === 0 ? 0 : Math.pow(2, a - 128) / 255 / k;
                        const o = p * GI_AMBIENT_CUBE_FLOATS + d * 3;
                        v.ambient[o] = pixels[i] * m;
                        v.ambient[o + 1] = pixels[i + 1] * m;
                        v.ambient[o + 2] = pixels[i + 2] * m;
                    }
                }
                v.ambientValid = true;
            })
            .catch((e) => Logger.warn(`GI readback failed: ${(e as Error)?.message ?? e}`, 'Renderer'))
            .then(() => { this._readbackPending = false; });
    }

    /** The volumes (enabled, read back) in claim order for a CPU lookup at the camera. */
    private _cpuVolumes(): GiVolumeCpu[] {
        const nodes = orderGiVolumes([...this._volumes.values()].filter(v => v.ambientValid).map(v => v.node),
                                     this._view.camera?.position ?? [0, 0, 0]);
        return nodes.map(n => this._volumes.get(n)!.cpu);
    }

    /**
     * The CPU twin at one point: radiance-form SH (36 floats) into `outSH`, x intensity x `scale`; returns
     * the share the volumes claimed (giLighting.ts `giLightingAt`).
     */
    public lightingAt(position: ArrayLike<number>, outSH: Float32Array, scale: number = 1): number {
        return giLightingAt(this._cpuVolumes(), position, outSH, scale);
    }

    /** The CPU twin as one flat colour (E/pi mean), for lit particles and sprites; returns the share claimed. */
    public ambientAt(position: ArrayLike<number>, out: number[] | Float32Array, scale: number = 1): number {
        return giAmbientAt(this._cpuVolumes(), position, out, scale);
    }

    /** One probe's ambient cube as read back (E/pi), for tests and the harness. */
    public ambientCubeOf(volumeName: string, probe: number): number[] | null {
        const v = [...this._volumes.values()].find(x => x.node.name === volumeName);
        if (!v || !v.ambientValid || probe < 0 || probe >= v.probes) return null;
        return [...v.ambient.subarray(probe * GI_AMBIENT_CUBE_FLOATS, (probe + 1) * GI_AMBIENT_CUBE_FLOATS)];
    }

    /** The volumes' state, for the harness and the editor. */
    public describe(): { id: string; name: string; probes: number; base: number; captured: number; active: number; idle: boolean }[] {
        return [...this._volumes.values()].map(v => ({
            id: v.node.id, name: v.node.name, probes: v.probes, base: v.base,
            captured: v.states.filter(s => s !== GI_PROBE_UNCAPTURED).length,
            active: v.states.filter(s => s === GI_PROBE_ACTIVE).length,
            idle: v.sweep.idle,
        }));
    }

    public dispose(): void {
        for (const v of this._volumes.values()) this._release(v);
        this._volumes.clear();
        this._irradiance?.destroy(); this._irradiance = null;
        this._visibility?.destroy(); this._visibility = null;
        this._probeData?.delete(); this._probeData = null;
        this._capture?.destroy(); this._capture = null;
        this._captureBack?.destroy(); this._captureBack = null;
        this._target?.destroy(); this._target = null;
    }
}

/** What a GI capture draws: visible, opaque, static scene geometry a material has not opted out of. */
function inCapture(node: ModelNode): boolean {
    if (!node.visible) return false;
    if (isEditorOnlyNode(node)) return false;
    if (node.name.startsWith('__editor__') || node.name.startsWith('__debug__')) return false;
    if (node.model instanceof AnimatedModel) return false;
    const config = node.model.material.config;
    if (config.transparent) return false;
    return config.probeable !== false;
}

// Keep the tile constants referenced for readers of this module's layout.
void GI_IRRADIANCE_TILE; void GI_VISIBILITY_TILE;
