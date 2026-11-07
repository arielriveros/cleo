import { vec3, mat4 } from 'gl-matrix';
import type { FluidVolumeNode } from '../../core/scene/nodes/fluidVolumeNode';
import { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import { TemporalHistory } from './temporalHistory';
import { DirectionalLight } from '../lighting';
import { skyAmbient } from '../particles/particleLighting';
import { keyLight } from '../skyNight';
import { VolumetricCloudPasses } from './clouds';
import { FluidVolumeProgram, FluidVolumeResolveProgram, FluidVolumeCompositeProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';

/** What FluidVolumePasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface FluidVolumePassesHost {
    readonly renderHeight: number;
    readonly renderWidth: number;
}

/**
 * Smoke-and-fire volumes (FluidVolumeNode): a box-bounded raymarch of each voxel texture over the
 * resolved image, its optional temporal history, and the composite back into the scene buffer. Split
 * out of Renderer.
 */
export class FluidVolumePasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: FluidVolumePassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    /**
     * Draw every enabled {@link FluidVolumeNode} over the scene buffer, in three steps:
     *
     *   1. TRACE: each box's back faces with no depth test (one fragment per covered pixel, from outside
     *      or inside), raymarched by `fluidVolume.wgsl` against the opaque depth snapshot, into the
     *      volume trace target -- colour and coverage-weighted depth, both premultiplied, far to near.
     *      At `resolutionScale` of the render size.
     *   2. RESOLVE (temporal volumes only): reproject last frame's image through that depth, clamp it to
     *      the new samples' neighbourhood, blend (`fluidVolumeResolve.wgsl`).
     *   3. COMPOSITE: depth-aware upsample onto the scene buffer (`fluidVolumeComposite.wgsl`).
     *
     * After the TAA resolve, so the STABLE inverse view-projection reconstructs the rays. The first
     * volume's resolution and temporal settings apply to the whole pass (it shares one target).
     */
    public renderFluidVolumes(scene: Scene): void {
        const volumes: FluidVolumeNode[] = [];
        for (const node of scene.fluidVolumes)
            if (node.enabled && node.visible && node.volume && !this._outsideFrustumBox(node)
                && !this._sys.visibility.volumeCulled(node)) volumes.push(node);
        if (volumes.length === 0) return;
        const camPos = this._view.camera.position;
        const key = new Map<FluidVolumeNode, number>();
        for (const v of volumes) key.set(v, vec3.squaredDistance(camPos, v.worldPosition));
        volumes.sort((a, b) => key.get(b)! - key.get(a)!);

        const lead = volumes[0];
        const scale = Math.min(1, Math.max(0.125, lead.resolutionScale || 1));
        const temporal = lead.temporal;
        const w = Math.max(1, Math.ceil(this._host.renderWidth * scale));
        const h = Math.max(1, Math.ceil(this._host.renderHeight * scale));
        this._ensureFluidTargets(w, h, temporal);
        // The camera moved this frame: draw cheaply now, and let the history (if any) catch up.
        const moving = this._view.hasPrevViewProj && !FluidVolumePasses._matricesClose(this._view.viewProj, this._view.prevViewProj);

        const { sunColor, ambient, sunDir } = this._fluidVolumeLight(scene);
        const depth = this._targets.sceneDepth.depth;
        const sm = this._shaderManager;
        const cam = this._view.camera;
        // Sub-pixel ray jitter (Halton 2,3) so accumulated frames sample the whole pixel.
        const slot = this._view.frameIndex % 16;
        const jitter = temporal ? [FluidVolumePasses._halton(slot + 1, 2) - 0.5, FluidVolumePasses._halton(slot + 1, 3) - 0.5] : [0, 0];

        // --- 1. Trace ---
        const trace = this._passes.beginFullscreenPass(this._fluidTraceFBO!.renderTarget, 'fluidVolumes', true,
                                                [0, 0, 0, 0], false, true);
        for (const node of volumes) {
            sm.bind('fluidVolume');
            const pipeline = this._pipelines.get('fluidVolume', FluidVolumeProgram, {
                // Back faces: `Geometry.Cube` winds counter-clockwise from outside (see `DecalPasses._decalCull`).
                cullMode: FluidVolumePasses._volumeMirrored(node) ? 'back' : 'front',
                blend: VolumetricCloudPasses.CLOUD_BLEND,
                targets: 2,
                vertex: 'model',
                builtFor: 'irradiance',   // `SkyPasses.iblCubeMesh` is position-only, built from that program's attributes
            });
            trace.setPipeline(pipeline);
            const cheap = moving || node.interacting;
            // Temporal volumes take longer steps every frame; accumulation recovers the detail.
            const step = node.stepScale * (temporal ? 1.6 : 1) * (cheap ? node.interactiveStepScale : 1);
            sm.setUniform('u_model', node.volumeMatrix);
            sm.setUniform('u_view', cam.viewMatrix);
            sm.setUniform('u_projection', this._projection.rasterProjection(cam.projectionMatrix));
            sm.setUniform('u_volumeInvModel', node.invVolumeMatrix);
            sm.setUniform('u_invViewProj', this._view.invViewProjStable);
            sm.setUniform('u_voxels', [...node.resolution]);
            sm.setUniform('u_smokeColor', node.smokeColor);
            sm.setUniform('u_sunColor', sunColor);
            sm.setUniform('u_sunAmbient', ambient);
            // Toward the light, in the box's own frame (the march runs in box space).
            const inv = node.invVolumeMatrix;
            const ld = [inv[0] * sunDir[0] + inv[4] * sunDir[1] + inv[8] * sunDir[2],
                        inv[1] * sunDir[0] + inv[5] * sunDir[1] + inv[9] * sunDir[2],
                        inv[2] * sunDir[0] + inv[6] * sunDir[1] + inv[10] * sunDir[2]];
            const len = Math.hypot(ld[0], ld[1], ld[2]) || 1;
            sm.setUniform('u_sunDir', [ld[0] / len, ld[1] / len, ld[2] / len]);
            sm.setUniform('u_viewPos', cam.position);
            sm.setUniform('u_bricks', [...node.bricks]);
            sm.setUniform('u_targetSize', [w, h]);
            sm.setUniform('u_traceJitter', jitter);
            sm.setUniform('u_absorption', node.absorption);
            sm.setUniform('u_emission', node.emission);
            sm.setUniform('u_emissionRange', node.emissionRange);
            sm.setUniform('u_ignition', node.ignition);
            sm.setUniform('u_fireOpacity', node.fireOpacity);
            sm.setUniform('u_ambient', node.ambient);
            // Sprite.exposureWeight's rule: divide by the share of the exposure the fire does not take.
            const fw = Math.min(1, Math.max(0, node.fireExposureWeight));
            sm.setUniform('u_fireScale', fw < 1 && this._view.exposure > 0 ? Math.pow(this._view.exposure, fw - 1) : 1);
            sm.setUniform('u_preExposure', this._view.preExposure);
            sm.setUniform('u_stepScale', step);
            sm.setUniform('u_blend', node.previousVolume ? Math.min(1, Math.max(0, node.blend)) : 1);
            sm.setUniform('u_anisotropy', node.anisotropy);
            sm.setUniform('u_fireGlow', node.fireGlow);
            sm.setUniform('u_detailStrength', node.detailStrength);
            sm.setUniform('u_detailScale', node.detailScale);
            sm.setUniform('u_time', node.time);
            sm.setUniform('u_albedo', node.albedo);
            sm.setUniform('u_powder', node.powder);
            sm.setUniform('u_skyOcclusion', node.skyOcclusion);
            sm.setUniform('u_fireIntensity', node.fireIntensity);
            sm.setUniform('u_absorptionScale', node.absorptionScale);
            sm.setUniform('u_blueCoreColor', node.blueCoreColor);
            sm.setUniform('u_sootMask', node.sootMask);
            sm.setUniform('u_blueCore', node.blueCore);
            sm.setUniform('u_sharpen', node.sharpen);
            sm.setUniform('u_smoothSampling', node.smoothSampling ? 1 : 0);
            sm.setUniform('u_detailBlend', node.detailBlend);
            sm.setUniform('u_hasDetail', node.hasDetail && node.detailA && node.detailB ? 1 : 0);
            sm.setUniform('u_scatterOctaves', Math.max(1, Math.round(node.scatterOctaves)));
            sm.setUniform('u_jitterSlot', this._view.frameIndex % 64);
            sm.setUniform('u_hasLut', node.fireLut ? 1 : 0);
            sm.setUniform('u_hasOccupancy', node.occupancy ? 1 : 0);
            sm.setUniform('u_shading', node.shading === 'liquid' ? 1 : 0);
            sm.setUniform('u_liquidIso', node.liquidIso);
            sm.setUniform('u_liquidRoughness', node.liquidRoughness);
            sm.setUniform('u_liquidSpecular', node.liquidSpecular);
            sm.setUniform('u_liquidFoam', node.liquidFoam);
            sm.setUniform('u_liquidMetallic', node.liquidMetallic);
            trace.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                depth, node.volume!, node.fireLut ?? this._bindGroups.fallbackTexture,
                node.previousVolume ?? node.volume!, node.occupancy ?? node.volume!,
                node.detailA ?? node.volume!, node.detailB ?? node.volume!,
            ]));
            this._passes.recordDraw(trace, this._sys.sky.iblCubeMesh, 0, 0);
        }
        this._passes.endFullscreenPass(trace);

        // --- 2. Resolve ---
        let image = this._fluidTraceFBO!.colors[0];
        if (temporal) {
            const prev = this.fluidHistory.read;
            const pass = this._passes.beginFullscreenPass(this.fluidHistory.write.renderTarget, 'fluidVolumes.resolve', false, undefined, false);
            this._fullscreen.bind(pass, 'fluidVolumeResolve', FluidVolumeResolveProgram, [
                this._fluidTraceFBO!.colors[0], this._fluidTraceFBO!.colors[1], prev.colors[0],
            ]);
            sm.bind('fluidVolumeResolve');
            sm.setUniform('u_invViewProj', this._view.invViewProjStable);
            sm.setUniform('u_prevViewProj', this._projection.uvProducing(this._view.prevViewProj));
            // Moving or editing: lean on the new samples so nothing smears; still: accumulate.
            sm.setUniform('u_feedback', moving || lead.interacting ? 0.6 : 0.9);
            sm.setUniform('u_historyValid', this.fluidHistory.valid && this._view.hasPrevViewProj ? 1 : 0);
            sm.setUniform('u_historyRescale', this.fluidHistory.rescale(this._view.preExposure));
            this._passes.drawFullscreenAndEnd(pass);
            this.fluidHistory.swap(this._view.preExposure);
            image = this.fluidHistory.read.colors[0];
        }

        // --- 3. Composite ---
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'fluidVolumes.composite', false, undefined, false);
        this._fullscreen.bind(pass, 'fluidVolumeComposite', FluidVolumeCompositeProgram, [image, this._fluidTraceFBO!.colors[1], depth], VolumetricCloudPasses.CLOUD_BLEND);
        sm.bind('fluidVolumeComposite');
        sm.setUniform('u_invViewProj', this._view.invViewProjStable);
        this._passes.drawFullscreenAndEnd(pass);

    }

    /**
     * The volume trace target (colour + weighted depth, RGBA16F) and, for temporal volumes, the two
     * history targets, all at the trace size. A resize drops the history: `Framebuffer.resize` recreates
     * every attachment, so history that survived it would be uninitialised memory.
     */
    private _ensureFluidTargets(w: number, h: number, temporal: boolean): void {
        if (!this._fluidTraceFBO)
            this._fluidTraceFBO = new Framebuffer({ colorAttachments: 2, colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        if (this._fluidTraceFBO.width !== w || this._fluidTraceFBO.height !== h) this._fluidTraceFBO.resize(w, h);
        if (!temporal) { this.fluidHistory.invalidate(); return; }
        this.fluidHistory.ensure(w, h);
    }

    private _fluidTraceFBO: Framebuffer | null = null;

    /** The volume trace target, once a volume has drawn; for memory accounting. */
    public get traceFBO(): Framebuffer | null { return this._fluidTraceFBO; }
    public readonly fluidHistory = new TemporalHistory({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });

    /** Element-wise closeness of two matrices: "the camera did not move this frame". */
    private static _matricesClose(a: mat4, b: mat4): boolean {
        for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-5 * Math.max(1, Math.abs(a[i]))) return false;
        return true;
    }

    /** The `index`-th element of the Halton sequence in `base`, 0..1. */
    private static _halton(index: number, base: number): number {
        let f = 1, r = 0;
        for (let i = index; i > 0; i = Math.floor(i / base)) { f /= base; r += f * (i % base); }
        return r;
    }

    /** True when the volume's box is entirely outside the view frustum (and culling is on). */
    private _outsideFrustumBox(node: FluidVolumeNode): boolean {
        if (!this._sys.visibility.frustumCulling) return false;
        const box = node.getBoundingBox();
        return !this._sys.visibility.frustum.intersectsAABB(box.min, box.max);
    }

    /** A negative determinant reverses the box's winding, so the other face set is the back one. */
    private static _volumeMirrored(node: FluidVolumeNode): boolean {
        return mat4.determinant(node.worldTransform) < 0;
    }

    /**
     * The light a volume's smoke scatters: the key light's illuminance and the scene's ambient, exactly
     * as `_particleDrawFrame` gathers them for lit particles.
     */
    private _fluidVolumeLight(scene: Scene): { sunColor: number[]; ambient: number[]; sunDir: number[] } {
        const sunColor = [0, 0, 0];
        const sunDir = [0, 1, 0];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            const light = node.light as DirectionalLight;
            const key = node === this._sys.lighting.keyLightNode ? this._sys.lighting.keyLight : null;
            const k = key ? key.intensity : light.internalIntensity;
            const c = key ? key.color : light.color;
            sunColor[0] = c[0] * k; sunColor[1] = c[1] * k; sunColor[2] = c[2] * k;
            const f = this._sys.lighting.dirOf(node);
            sunDir[0] = -f[0]; sunDir[1] = -f[1]; sunDir[2] = -f[2];
            break;
        }
        const ambient = this._sys.lighting.internalAmbient(scene);
        const skyNode = scene.skyLight;
        if (skyNode && this._sys.sky.skySHValid) {
            const grade = this._sys.lighting.cloudGrade(scene);
            const sky = skyAmbient(this._sys.sky.skySH, skyNode.intensity * grade.sky);
            ambient[0] += sky[0]; ambient[1] += sky[1]; ambient[2] += sky[2];
        }
        return { sunColor, ambient, sunDir };
    }
}
