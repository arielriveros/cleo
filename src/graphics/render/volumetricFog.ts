import { mat4, vec3 } from 'gl-matrix';
import type { Scene } from '../../core/scene/scene';
import type { VolumetricFogNode } from '../../core/scene/nodes/volumetricFogNode';
import { Framebuffer } from '../framebuffer';
import { REFERENCE_ILLUMINANCE } from '../lighting';
import { lightFlickerClock } from '../lightFlicker';
import type { BlendState } from '../rhi/types';
import { ShaderManager } from '../systems/shaderManager';
import { VolumetricFogInjectProgram, VolumetricFogIntegrateProgram, VolumetricFogApplyProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { BindGroupCache } from './bindGroups';
import type { FullscreenPasses } from './fullscreenPasses';
import type { ViewProjection } from './viewProjection';
import type { ParticlePasses } from './particlePasses';
import type { RenderSubsystems } from './subsystems';

/** What the fog reads from the renderer that owns it. */
export interface VolumetricFogHost {
    readonly renderWidth: number;
    readonly renderHeight: number;
    readonly thumbnailMode: boolean;
}

/** The most fog volumes and fog-glow emitters one frame draws (the shader's array sizes). */
export const FOG_MAX_VOLUMES = 16;
export const FOG_MAX_EMITTERS = 16;
/** Slices per atlas row: the grid's depth slices are laid out this many across. */
const ATLAS_COLUMNS = 8;
const WHITE: readonly number[] = [1, 1, 1];

/**
 * The apply blend: `colour * T + S`. The shader writes (S, T); the colour half multiplies what is there by
 * the source alpha and adds the source colour. The alpha half keeps the scene buffer's alpha — it is the
 * bloom mask, not coverage.
 */
const FOG_APPLY_BLEND: BlendState = {
    color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/**
 * Froxel volumetric fog for VolumetricFogNode volumes (Wronski 2014; Hillaire 2015): torches that glow in
 * the mist, shafts through a smoky hall, a fire lighting its own haze. The scheme is in
 * shaders/wgsl/chunks/volumetricFogCommon.wgsl; this owns the targets, the volumes' upload and the three
 * passes, run together at the point of the frame where the fog is composited (after the opaque scene and
 * the height fog, before the temporal resolve, which denoises it).
 *
 * Nothing is allocated, and nothing runs, until a scene has a fog volume in view.
 */
export class VolumetricFogPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    // --- settings (RenderSettings.volumetricFog*) ------------------------------------------------
    public enabled = true;
    /** Screen pixels per froxel column, each axis. */
    public tileSize = 16;
    /** Depth slices. */
    public slices = 64;
    /** Metres the fog reaches. */
    public distance = 128;
    /** Blend each froxel with last frame's, through the camera's motion. */
    public temporal = true;
    public historyWeight = 0.9;
    /** Scatter the clustered point and spot lights (the torches' halos). */
    public localLights = true;
    /** Shade what they scatter through their shadow maps (a quality-tier field). */
    public localShadows = true;

    private _inject: Framebuffer[] = [];
    private _integrated: Framebuffer | null = null;
    private _write = 0;
    private _historyValid = false;
    private _historyPreExposure = 1;
    private _atlasW = 0;
    private _atlasH = 0;
    private _grid: [number, number, number] = [0, 0, 0];

    /** Whether the fog drew this frame (the editor's status line, and tests). */
    public producedThisFrame = false;
    /** The volumes that drew this frame, nearest-priority first (the inspector's "not drawn" status). */
    public readonly frameVolumes: VolumetricFogNode[] = [];

    // Packed uniform arrays, reused.
    private readonly _inv = new Float32Array(16 * FOG_MAX_VOLUMES);
    private readonly _a = new Float32Array(4 * FOG_MAX_VOLUMES);
    private readonly _b = new Float32Array(4 * FOG_MAX_VOLUMES);
    private readonly _c = new Float32Array(4 * FOG_MAX_VOLUMES);
    private readonly _d = new Float32Array(4 * FOG_MAX_VOLUMES);
    private readonly _e = new Float32Array(4 * FOG_MAX_VOLUMES);
    private readonly _f = new Float32Array(4 * FOG_MAX_VOLUMES);
    private readonly _emitters = new Float32Array(4 * FOG_MAX_EMITTERS);
    private readonly _emitterColor = new Float32Array(4 * FOG_MAX_EMITTERS);
    private _volumeCount = 0;
    private _emitterCount = 0;
    private readonly _forward = vec3.create();
    private readonly _prevViewProj = mat4.create();

    constructor(private readonly _host: VolumetricFogHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _bindGroups: BindGroupCache,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _projection: ViewProjection,
                private readonly _particles: ParticlePasses,
                private readonly _sys: RenderSubsystems) {}

    /** Forget the history (a camera cut, a resize, a settings change). */
    public invalidate(): void { this._historyValid = false; }

    /** Every target, for memory accounting. */
    public get targets(): Framebuffer[] { return [...this._inject, ...(this._integrated ? [this._integrated] : [])]; }

    /**
     * Light, integrate and composite the fog over the scene buffer. Returns whether anything was drawn.
     * The caller has checked the profiler switch; this checks everything else.
     */
    public render(scene: Scene): boolean {
        this.producedThisFrame = false;
        this.frameVolumes.length = 0;
        if (!this.enabled || this._host.thumbnailMode || this._view.capturing) return false;
        const camera = this._view.camera;
        if (camera.type === 'orthographic' || scene.volumetricFogs.size === 0) return false;
        if (!this._gather(scene)) return false;

        this._ensure();
        const read = this._inject[this._write ^ 1], write = this._inject[this._write];
        const historyOk = this.temporal && this._historyValid && this._view.hasPrevViewProj;

        // 1. Inject: the medium and its light, per froxel, blended over last frame's.
        const inject = this._passes.beginFullscreenPass(write.renderTarget, 'volumetricFog.inject', false, undefined, false);
        const injectPipeline = this._fullscreen.bind(inject, 'volumetricFogInject', VolumetricFogInjectProgram, [read.colors[0]]);
        this._upload(scene, historyOk ? this.historyWeight : 0);
        this._sys.shadows.uploadShadowUniforms('volumetricFogInject');
        this._sys.lighting.lightGrid.uploadUniforms(this._shaderManager);
        // With the punctual atlases: the clustered lights scatter through their shadow maps (localShadows).
        if (this._bindGroups.declaresFrameLighting(injectPipeline))
            inject.setBindGroup(3, this._bindGroups.frameLightingGroup(injectPipeline, true));
        this._passes.drawFullscreenAndEnd(inject);

        // 2. Integrate, front to back.
        const integrate = this._passes.beginFullscreenPass(this._integrated!.renderTarget, 'volumetricFog.integrate', false, undefined, false);
        this._fullscreen.bind(integrate, 'volumetricFogIntegrate', VolumetricFogIntegrateProgram, [write.colors[0]]);
        this._upload(scene, 0);
        this._passes.drawFullscreenAndEnd(integrate);

        // 3. Apply over the opaque scene, at each pixel's depth.
        const apply = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'volumetricFog.apply', false, undefined, false);
        this._fullscreen.bind(apply, 'volumetricFogApply', VolumetricFogApplyProgram,
                              [this._integrated!.colors[0], this._targets.sceneDepth.depth], FOG_APPLY_BLEND);
        this._upload(scene, 0);
        this._passes.drawFullscreenAndEnd(apply);

        this._write ^= 1;
        this._historyValid = true;
        this._historyPreExposure = this._view.preExposure;
        this.producedThisFrame = true;
        return true;
    }

    /** The volumes and fog-glow emitters in view, packed for the shader. False when none would show. */
    private _gather(scene: Scene): boolean {
        const cam = this._view.camera.position;
        const frustum = this._sys.visibility.frustum;
        const candidates: { node: VolumetricFogNode, distance: number }[] = [];
        for (const node of scene.volumetricFogs) {
            if (!node.enabled || !node.visible || (node.density <= 0 && node.emissiveIntensity <= 0)) continue;
            const box = node.getBoundingBox();
            if (!frustum.intersectsAABB(box.min, box.max)) continue;
            // Distance from the camera to the box (0 inside), against the fog's reach.
            const dx = Math.max(box.min[0] - cam[0], 0, cam[0] - box.max[0]);
            const dy = Math.max(box.min[1] - cam[1], 0, cam[1] - box.max[1]);
            const dz = Math.max(box.min[2] - cam[2], 0, cam[2] - box.max[2]);
            const distance = Math.hypot(dx, dy, dz);
            if (distance > this.distance) continue;
            candidates.push({ node, distance });
        }
        if (candidates.length === 0) return false;
        candidates.sort((a, b) => (b.node.priority - a.node.priority) || (a.distance - b.distance));

        const k = this._view.preExposure;
        this._volumeCount = Math.min(FOG_MAX_VOLUMES, candidates.length);
        for (let i = 0; i < this._volumeCount; i++) {
            const n = candidates[i].node;
            this.frameVolumes.push(n);
            this._inv.set(n.invVolumeMatrix, i * 16);
            const height = Math.abs(n.size[1] * n.worldScale[1]);
            this._a.set([n.density, n.anisotropy, n.heightFalloff, height], i * 4);
            this._b.set([n.albedo[0], n.albedo[1], n.albedo[2], n.noiseStrength], i * 4);
            // The volume's own glow: nits on the internal scale, pre-exposed like every source.
            const e = n.emissiveIntensity / REFERENCE_ILLUMINANCE * k;
            this._c.set([n.emissiveColor[0] * e, n.emissiveColor[1] * e, n.emissiveColor[2] * e, n.noiseScale], i * 4);
            const blend = n.blendFractions;
            this._d.set([blend[0], blend[1], blend[2], n.sunScattering], i * 4);
            this._e.set([n.windVelocity[0], n.windVelocity[1], n.windVelocity[2], n.localLightScattering], i * 4);
            this._f.set([n.ambientScattering, 0, 0, 0], i * 4);
        }

        // Fog-only glow (ParticleSystemNode.fogGlow, lumens): a fire's light on its own smoke and the mist round it.
        this._emitterCount = 0;
        for (const ps of scene.particleSystems) {
            if (this._emitterCount >= FOG_MAX_EMITTERS) break;
            const glow = ps.fogGlow;
            if (!(glow > 0) || !ps.visible || !ps.isAlive) continue;
            const p = ps.worldPosition;
            if (Math.hypot(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]) > this.distance) continue;
            const box = ps.getBoundingBox();
            const radius = Math.max(2, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) * 1.5);
            const i = this._emitterCount++;
            this._emitters.set([p[0], p[1], p[2], radius], i * 4);
            // Lumens to candela on the internal scale, in the colour of the light it follows (a fire's orange:
            // the embers' own tint is usually white) times its tint, and on that light's flicker.
            const intensity = glow / (4 * Math.PI) / REFERENCE_ILLUMINANCE * ps.lightFollowScale * k;
            const lc = ps.followedLight?.light.color ?? WHITE;
            this._emitterColor.set([ps.tint[0] * lc[0] * intensity, ps.tint[1] * lc[1] * intensity, ps.tint[2] * lc[2] * intensity, 0], i * 4);
        }
        return true;
    }

    /** Every FogUniforms member, into the bound program's block. */
    private _upload(scene: Scene, historyWeight: number): void {
        const sm = this._shaderManager;
        const cam = this._view.camera;
        const v = cam.viewMatrix;
        vec3.set(this._forward, -v[2], -v[6], -v[10]);
        vec3.normalize(this._forward, this._forward);
        const light = this._particles.frameLight(scene);
        const k = this._view.preExposure;
        sm.setUniform('u_invViewProj', this._view.invViewProj);
        mat4.copy(this._prevViewProj, this._projection.uvProducing(this._view.prevViewProj));
        sm.setUniform('u_prevViewProj', this._prevViewProj);
        sm.setUniform('u_prevView', this._view.prevView);
        sm.setUniform('u_camPos', cam.position);
        sm.setUniform('u_near', Math.max(0.05, Math.min(cam.near * 2, 0.5)));
        sm.setUniform('u_camForward', this._forward);
        sm.setUniform('u_far', Math.max(1, this.distance));
        sm.setUniform('u_grid', [this._grid[0], this._grid[1], this._grid[2], ATLAS_COLUMNS]);
        sm.setUniform('u_renderSize', [this._host.renderWidth, this._host.renderHeight]);
        sm.setUniform('u_jitter', (this._view.frameIndex * 0.6180339887) % 1);
        sm.setUniform('u_historyWeight', historyWeight);
        sm.setUniform('u_sunDir', light.sunDirection);
        sm.setUniform('u_time', lightFlickerClock.time);
        sm.setUniform('u_sunColor', [light.sunColor[0] * k, light.sunColor[1] * k, light.sunColor[2] * k]);
        sm.setUniform('u_volumeCount', this._volumeCount);
        sm.setUniform('u_ambient', [light.ambient[0] * k, light.ambient[1] * k, light.ambient[2] * k]);
        sm.setUniform('u_historyRescale', k / (this._historyPreExposure > 0 ? this._historyPreExposure : 1));
        sm.setUniform('u_localLights', this.localLights ? 1 : 0);
        sm.setUniform('u_localShadows', this.localShadows ? 1 : 0);
        sm.setUniform('u_emitterCount', this._emitterCount);
        sm.setUniform('u_volumeInv', this._inv);
        sm.setUniform('u_volumeA', this._a);
        sm.setUniform('u_volumeB', this._b);
        sm.setUniform('u_volumeC', this._c);
        sm.setUniform('u_volumeD', this._d);
        sm.setUniform('u_volumeE', this._e);
        sm.setUniform('u_volumeF', this._f);
        sm.setUniform('u_emitters', this._emitters);
        sm.setUniform('u_emitterColor', this._emitterColor);
    }

    /** Size the grid from the render size and the settings, and the atlases to hold it. */
    private _ensure(): void {
        const tile = Math.max(4, Math.round(this.tileSize));
        const w = Math.max(1, Math.ceil(this._host.renderWidth / tile));
        const h = Math.max(1, Math.ceil(this._host.renderHeight / tile));
        const n = Math.max(ATLAS_COLUMNS, Math.min(128, Math.round(this.slices / ATLAS_COLUMNS) * ATLAS_COLUMNS));
        const atlasW = w * ATLAS_COLUMNS, atlasH = h * (n / ATLAS_COLUMNS);
        while (this._inject.length < 2)
            this._inject.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
        if (!this._integrated) this._integrated = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        if (atlasW !== this._atlasW || atlasH !== this._atlasH || n !== this._grid[2]) {
            for (const fbo of this._inject) fbo.create(atlasW, atlasH);
            this._integrated.create(atlasW, atlasH);
            this._atlasW = atlasW;
            this._atlasH = atlasH;
            this._historyValid = false;
        }
        this._grid = [w, h, n];
    }
}
