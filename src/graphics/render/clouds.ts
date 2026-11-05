import { mat4, vec3 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import { LightNode } from '../../core/scene/nodes/lightNode';
import { VolumetricCloudsNode } from '../../core/scene/nodes/volumetricCloudsNode';
import { Scene } from '../../core/scene/scene';
import { atmosphereTransmittance, shHemisphereMeans } from '../cloudLighting';
import { Framebuffer } from '../framebuffer';
import { gl } from '../glContext';
import { device } from '../rhi/deviceHandle';
import type { RenderPipeline, BindGroup } from '../rhi/resources';
import { ShaderStage, BufferUsage } from '../rhi/types';
import type { BlendState } from '../rhi/types';
import { glDevice } from '../rhi/webgl2/webgl2Device';
import { keyLight } from '../skyNight';
import type { KeyLight } from '../skyNight';
import { GLState } from '../systems/glState';
import { Texture } from '../texture';
import { VolumetricCloudsProgram, CloudUpsampleProgram, CloudNoiseBakeComputeProgram, CloudTemporalResolveProgram } from './programs';
import { QUALITY_TIERS } from './settingsTypes';
import type { QualityPreset } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';

/** What VolumetricCloudPasses reads from the renderer that owns it, while those members still live there. */
export interface VolumetricCloudPassesHost {
    readonly clearSkySH: Float32Array;
    readonly clearSkySHValid: boolean;
    cloudSkyActive(scene: Scene): boolean;
    readonly cloudWindDir: [number, number, number];
    dirOf(node: LightNode): vec3;
    readonly keyLight: KeyLight | null;
    readonly keyLightNode: LightNode | null;
    keyLightScale(): number;
    readonly quality: QualityPreset;
    readonly renderHeight: number;
    readonly renderWidth: number;
    restoreDefaultBlend(): void;
    readonly thumbnailMode: boolean;
}

/**
 * The volumetric cloud layer in the frame: the noise volumes baked once (compute on WebGPU, raster on
 * WebGL2), the raymarch, its Bayer-interleaved temporal reconstruction and the composite over the scene,
 * plus the quality tier's cloud knobs. The clouded sky cubemap bake lives with the sky. Split out of
 * Renderer.
 */
export class VolumetricCloudPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: VolumetricCloudPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection) {}

    // Reduced-resolution volumetric-clouds raymarch target (lazily sized to the node's resolutionScale;
    // upsampled + composited into the scene buffer). Only used when resolutionScale < 1.
    public cloudsFBO!: Framebuffer;

    // Baked tileable 3D noise for the cloud raymarch, built lazily on the first frame a scene has
    // clouds enabled — a project without them never pays the ~8MB or the bake.
    public cloudBaseNoise: Texture | null = null;
    public cloudDetailNoise: Texture | null = null;
    private _cloudNoiseBaked: boolean = false;

    /** Base volume edge, and how many noise cells span it (the tiling period in lattice space). */
    private static readonly CLOUD_BASE_NOISE_SIZE = 128;
    private static readonly CLOUD_BASE_NOISE_PERIOD = 8;
    private static readonly CLOUD_DETAIL_NOISE_SIZE = 32;
    private static readonly CLOUD_DETAIL_NOISE_PERIOD = 4;

    // Temporal reprojection targets: `cloudHistoryFBOs` ping-pong at cloud render resolution, and
    // `cloudTraceFBO` holds the new samples at 1/4 per axis — 1/16 of the pixels.
    public cloudHistoryFBOs: Framebuffer[] = [];
    public cloudTraceFBO!: Framebuffer;
    private _cloudHistoryIndex: number = 0;

    // False whenever the history cannot be trusted — first frame, a resize, a quality change, a camera
    // cut. That frame traces at full cloud resolution to reseed rather than upscaling 1/16 of it.
    public cloudHistoryValid: boolean = false;

    /** Cloud-space dimensions the history was last built at, so a change can invalidate it. */
    private _cloudHistoryW: number = 0;
    private _cloudHistoryH: number = 0;

    /** Bayer subset traced this frame, and the size of the pattern (4x4). */
    private static readonly CLOUD_BAYER_SIZE = 4;

    /** Tier (and node) the cloud settings were last pushed for — see _applyQualityToClouds. */
    public cloudsTierApplied: QualityPreset | null = null;
    private _cloudsTierNode: VolumetricCloudsNode | null = null;

    // 4x4 ordered-dither ranks: frame N traces the cell whose rank is N%16. Consecutive ranks sit far
    // apart, so the image fills in evenly rather than as a band sweeping each block.
    private static readonly CLOUD_BAYER_ORDER = [
         0,  8,  2, 10,
        12,  4, 14,  6,
         3, 11,  1,  9,
        15,  7, 13,  5,
    ];

    /**
     * Premultiplied "over", for the cloud composite. The bloom-mask ALPHA uses the same factors as the
     * colour rather than DEFAULT_BLEND's mask-preserving pair — cloud coverage IS meant to reach the mask.
     */
    public static readonly CLOUD_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    /** Cloud extinction per metre at unit density and `absorption` 1 — real cumulus is ~0.02-0.1. */
    private static readonly CLOUD_SIGMA_BASE = 0.05;

    /** Sun transmittance at the cloud layer, cached against the inputs that produce it. */
    private _cloudSunT: [number, number, number] = [1, 1, 1];
    private _cloudSunTKey = '';

    /**
     * The sun and ambient light the clouds are lit by this frame.
     *
     * Following Hillaire 2016, the sun reaching the clouds is the sun as the atmosphere has attenuated
     * it AT THE CLOUD ALTITUDE, so when the scene has a SkyAtmosphere the reddening and dimming toward
     * the horizon come from the same Rayleigh/Mie medium that colours the sky — the clouds and the sky
     * can no longer disagree at sunset, and clouds keep catching the sun a little after it has set on
     * the ground. The transmittance is normalised by its zenith value, so a high sun reproduces the
     * authored colour exactly. Likewise the ambient comes from the Sky Light's projection of the real
     * sky (mean radiance of each hemisphere) when there is one and `useSkyAmbient` is on.
     *
     * Without those nodes the authored colours are tinted by hand-tuned day/sunset/night curves of the
     * sun's elevation, which is all the information there is.
     */
    private _cloudLightInputs(scene: Scene, node: VolumetricCloudsNode, sunDir: ArrayLike<number>,
                              sunColor: ArrayLike<number>) {
        // u_sunDir is the sun's TRAVEL direction, so toward-sun elevation is -y.
        const invLen = 1 / (Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1);
        const toSun = [-sunDir[0] * invLen, -sunDir[1] * invLen, -sunDir[2] * invLen];
        const elevation = toSun[1];
        const smooth01 = (a: number, b: number, x: number) => {
            const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
            return t * t * (3 - 2 * t);
        };
        const day = smooth01(0.08, 0.35, elevation);         // 1 = sun clearly above the horizon
        const night = 1 - smooth01(-0.22, -0.03, elevation); // 1 = sun clearly below it
        const sunset = (1 - day) * (1 - night);              // peaks with the sun on the horizon
        const mix1 = (a: number, b: number, t: number) => a + (b - a) * t;
        const sunsetColor = node.sunsetColor;                // user-set sunrise/sunset glow color
        // Softer cast of the sunset color (pulled halfway toward white) for the indirect terms.
        const sunsetCast = [0, 1, 2].map(i => mix1(sunsetColor[i], 1, 0.45));
        const NIGHT_AMBIENT = [0.30, 0.36, 0.55];  // cool moonlit cast
        const NIGHT_SUN_DIM = 0.04, NIGHT_AMBIENT_DIM = 0.15, NIGHT_GROUND_DIM = 0.12;

        let effSunColor: number[];
        let effSunIntensity: number;
        const atmo = scene.skyAtmosphere;
        if (atmo) {
            const rs = atmo.rayleighScatter;
            const params = {
                // The same coefficients `_bakeSkyAtmosphere` hands the sky shader.
                rayleigh: [5.8e-6 * rs, 13.5e-6 * rs, 33.1e-6 * rs] as [number, number, number],
                mie: 21e-6 * atmo.mieScatter,
                rayleighHeight: atmo.rayleighHeight, mieHeight: atmo.mieHeight,
                planetRadius: atmo.planetRadius, atmosphereRadius: atmo.atmosphereRadius,
            };
            const altitude = node.baseAltitude + node.thickness * 0.5;
            // Quantised key: a slowly animated sun recomputes about every 0.06 degrees, not every frame.
            const key = `${toSun.map(v => Math.round(v * 1000)).join(',')}|${Math.round(altitude)}|`
                      + `${rs}|${atmo.mieScatter}|${atmo.rayleighHeight}|${atmo.mieHeight}|`
                      + `${atmo.planetRadius}|${atmo.atmosphereRadius}`;
            if (key !== this._cloudSunTKey) {
                const t = atmosphereTransmittance(params, altitude, toSun);
                const z = atmosphereTransmittance(params, altitude, [0, 1, 0]);
                this._cloudSunT = [t[0] / z[0], t[1] / z[1], t[2] / z[2]];
                this._cloudSunTKey = key;
            }
            effSunColor = [0, 1, 2].map(i => sunColor[i] * this._cloudSunT[i]);
            // The key light's strength: fades out at sunset, and is the moonlight fraction at night.
            effSunIntensity = node.sunIntensity * this._host.keyLightScale();
        } else {
            effSunColor = [0, 1, 2].map(i =>
                sunColor[i] * mix1(1, sunsetColor[i], sunset) * mix1(1, NIGHT_SUN_DIM, night));
            // Sun intensity follows elevation: dimmest on the horizon (long atmospheric path), ramping
            // to the authored full value with the sun at the zenith.
            const HORIZON_SUN_INTENSITY = 0.25;
            effSunIntensity = node.sunIntensity * mix1(HORIZON_SUN_INTENSITY, 1, smooth01(0, 1, elevation));
        }

        let effAmbientColor: number[];
        let effGroundColor: number[];
        let effAmbientIntensity = node.ambientIntensity;
        // Only with an atmosphere: its sun irradiance is what puts the sky's radiance and the clouds'
        // `sunIntensity` on one scale. A skybox's SH comes in arbitrary units the clouds cannot relate to.
        const skySH = node.useSkyAmbient && atmo && scene.skyLight && this._host.clearSkySHValid ? this._host.clearSkySH : null;
        if (skySH && atmo) {
            // The real sky's radiance: it already darkens, reddens and goes blue-hour with the sun.
            // Re-expressed in the clouds' units: sky radiance per unit of the atmosphere's sun
            // irradiance, times the clouds' own sun irradiance.
            const toCloudUnits = node.sunIntensity / Math.max(1e-4, atmo.sunIntensity * atmo.exposure);
            const up = shHemisphereMeans(skySH).up.map(v => v * toCloudUnits);
            effAmbientColor = up;
            // The ground under the clouds is a Lambertian reflector of albedo `groundColor`, lit by the
            // sun (at this elevation) and by that same sky: L = albedo * (E_sun + pi * L_sky) / pi.
            // The sky's own lower hemisphere is not used — it is a stylised ground tint, not a bounce.
            const sunE = effSunIntensity * Math.max(0, elevation) / Math.PI;
            effGroundColor = [0, 1, 2].map(i => node.groundColor[i] * (effSunColor[i] * sunE + up[i]));
        } else {
            effAmbientColor = [0, 1, 2].map(i =>
                node.ambientColor[i] * mix1(1, sunsetCast[i], sunset) * mix1(1, NIGHT_AMBIENT[i], night));
            effAmbientIntensity *= mix1(1, NIGHT_AMBIENT_DIM, night);
            effGroundColor = [0, 1, 2].map(i =>
                node.groundColor[i] * mix1(1, sunsetCast[i], sunset) * mix1(1, NIGHT_GROUND_DIM, night));
        }
        return { sunColor: effSunColor, sunIntensity: effSunIntensity, ambientColor: effAmbientColor,
                 ambientIntensity: effAmbientIntensity, groundColor: effGroundColor };
    }

    /**
     * Every raymarch uniform of the cloud pass but the per-target ones (temporal slot, depth flag). Shared
     * by the live pass and the sky bake, which differ only in the view (`invViewProj`, `eye`) and clock.
     * Expects the 'volumetricClouds' program to be bound.
     */
    public setCloudUniforms(scene: Scene, node: VolumetricCloudsNode, invViewProj: mat4,
                              eye: ArrayLike<number>, time: number): void {
        this._shaderManager.setUniform('u_invViewProj', invViewProj);
        this._shaderManager.setUniform('u_viewPos', eye);
        this._shaderManager.setUniform('u_time', time);
        // Baked noise volumes. The inverse periods convert a lattice-space coordinate into the
        // volume's [0,1] UVW, and must match the periods the bake used or the field changes scale.
        this._shaderManager.setUniform('u_baseNoiseInvPeriod', 1 / VolumetricCloudPasses.CLOUD_BASE_NOISE_PERIOD);
        this._shaderManager.setUniform('u_detailNoiseInvPeriod', 1 / VolumetricCloudPasses.CLOUD_DETAIL_NOISE_PERIOD);

        // Sun: scene directional light (direction + color) by default, else the node's override.
        let sunDir: any = node.sunDirection;
        let sunColor: any = node.sunColor;
        if (node.useSceneSun) {
            for (const light of scene.lights) {
                if (light.type === 'directional') {
                    // The key light: at night that is the moon, in the moon's colour.
                    sunDir = this._host.dirOf(light);
                    const key = light === this._host.keyLightNode ? this._host.keyLight : null;
                    sunColor = key?.isMoon ? key.color : light.light.diffuse;
                    break;
                }
            }
        }
        const { sunColor: effSunColor, sunIntensity: effSunIntensity, ambientColor: effAmbientColor,
                ambientIntensity: effAmbientIntensity, groundColor: effGroundColor }
            = this._cloudLightInputs(scene, node, sunDir, sunColor);
        this._shaderManager.setUniform('u_sunDir', sunDir);
        this._shaderManager.setUniform('u_sunColor', effSunColor);

        // Shape
        this._shaderManager.setUniform('u_coverage', node.coverage);
        this._shaderManager.setUniform('u_density', node.density);
        this._shaderManager.setUniform('u_cloudType', node.cloudType);
        this._shaderManager.setUniform('u_baseAltitude', node.baseAltitude);
        this._shaderManager.setUniform('u_thickness', node.thickness);
        this._shaderManager.setUniform('u_baseScale', node.baseScale);
        this._shaderManager.setUniform('u_detailScale', node.detailScale);
        this._shaderManager.setUniform('u_detailStrength', node.detailStrength);
        this._shaderManager.setUniform('u_curlStrength', node.curlStrength);
        this._shaderManager.setUniform('u_anvilBias', node.anvilBias);
        // Lighting (sun intensity + ambient/ground carry the sunset/night modulation computed above)
        this._shaderManager.setUniform('u_sunIntensity', effSunIntensity);
        this._shaderManager.setUniform('u_ambientColor', effAmbientColor);
        this._shaderManager.setUniform('u_ambientIntensity', effAmbientIntensity);
        this._shaderManager.setUniform('u_groundColor', effGroundColor);
        this._shaderManager.setUniform('u_phaseG', node.phaseG);
        this._shaderManager.setUniform('u_silverIntensity', node.silverIntensity);
        this._shaderManager.setUniform('u_silverSpread', node.silverSpread);
        this._shaderManager.setUniform('u_powderStrength', node.powderStrength);
        this._shaderManager.setUniform('u_extinction', node.absorption * VolumetricCloudPasses.CLOUD_SIGMA_BASE);
        this._shaderManager.setUniform('u_albedo', node.albedo);
        this._shaderManager.setUniform('u_phaseBackG', node.phaseBackG);
        this._shaderManager.setUniform('u_phaseBackWeight', node.phaseBackWeight);
        this._shaderManager.setUniform('u_msOctaves', node.msOctaves);
        this._shaderManager.setUniform('u_msScatter', node.msScatter);
        this._shaderManager.setUniform('u_msExtinction', node.msExtinction);
        this._shaderManager.setUniform('u_msEccentricity', node.msEccentricity);
        this._shaderManager.setUniform('u_hazeDistance', node.hazeDistance);
        // Animation
        // The scene Wind's direction and strength when the node follows it, else its own.
        const windSpeed = node.resolveWind(scene.wind, this._host.cloudWindDir);
        this._shaderManager.setUniform('u_wind', this._host.cloudWindDir);
        this._shaderManager.setUniform('u_windSpeed', windSpeed);
        this._shaderManager.setUniform('u_detailWindFactor', node.detailWindFactor);
        // Quality
        this._shaderManager.setUniform('u_steps', node.steps);
        this._shaderManager.setUniform('u_lightSteps', node.lightSteps);
        this._shaderManager.setUniform('u_maxDistance', node.maxDistance);
        this._shaderManager.setUniform('u_jitter', node.jitter);
        // Render
        this._shaderManager.setUniform('u_opacity', node.opacity);
    }

    /** The clouds' wind clock, in seconds: frozen at the bake while they are drawn from it. */
    public cloudTime(scene: Scene, node: VolumetricCloudsNode): number {
        return this._host.cloudSkyActive(scene) ? node.bakedAt : performance.now() * 0.001;
    }

    /**
     * Volumetric cloud layer: a fullscreen raymarch bounded by the G-buffer depth, composited over
     * the sky/scene. No-op unless the scene has an enabled VolumetricCloudsNode.
     */
    public renderVolumetricClouds(scene: Scene): void {
        const node = scene.volumetricClouds;
        if (!node || !node.enabled || node.opacity <= 0) return;
        // The clouds node is scene state, so the tier's cloud knobs are pushed here rather than in the
        // quality setter — a preset can be chosen before any scene with clouds has been loaded.
        this._applyQualityToClouds(node);

        // Lazy one-time bake, so only a project that actually has clouds pays for the volumes.
        this.bakeCloudNoise();
        if (!this.cloudBaseNoise || !this.cloudDetailNoise) return;

        // Fullscreen overlay: no depth test/write (occlusion handled via the depth texture), alpha blend.
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(true);
        // Clouds are bloom-eligible, so coverage goes into the mask alpha instead of the default
        // mask-preserving blend. The shader outputs PREMULTIPLIED colour, so RGB and alpha share
        // ONE, ONE_MINUS_SRC_ALPHA. Guarded: WebGPU carries the same factors in `CLOUD_BLEND`.
        if (gl) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // One pipeline and one texture group for the raymarch, reused by whichever target it lands in.
        // The helpers open their own passes and re-apply both; the uniforms below are written once.
        this._shaderManager.bind('volumetricClouds');
        // `target` explicitly, for the same reason the sky bake passes one: this single pipeline is
        // reused across the full-res, reduced-res and Bayer trace targets, and it is built before any
        // of their passes open. They share the scene buffer's float format, so it speaks for all three.
        const rayPipeline = this._pipelines.fullscreen('volumetricClouds', VolumetricCloudsProgram,
                                                     VolumetricCloudPasses.CLOUD_BLEND, undefined,
                                                     this._targets.scene.renderTarget);
        const rayGroup = (pipe: RenderPipeline) => this._bindGroups.textureGroup(pipe, 0, [
            this._targets.gBuffer.depth, this.cloudBaseNoise!, this.cloudDetailNoise!,
        ]);
        this.setCloudUniforms(scene, node, this._view.invViewProj, this._view.camera.position,
                               performance.now() * 0.001);
        this._shaderManager.setUniform('u_ignoreDepth', false);

        const scale = node.resolutionScale;
        // Temporal reprojection is bypassed at full resolution (nothing to reconstruct), while
        // capturing a thumbnail (a one-shot offscreen render has no history to draw on), and when the
        // node/quality tier turns it off.
        const temporal = node.temporalUpscale && scale < 0.999 && !this._host.thumbnailMode;

        if (scale >= 0.999) {
            // Full resolution: raymarch straight into the bound scene buffer (premultiplied "over" set above).
            this._shaderManager.setUniform('u_temporal', false);
            this._shaderManager.setUniform('u_jitterSlot', this._view.frameIndex % 16);
            const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'clouds', false);
            pass.setPipeline(rayPipeline);
            pass.setBindGroup(0, rayGroup(rayPipeline));
            this._passes.drawFullscreen(pass);
            this._passes.endFullscreenPass(pass);
        } else {
            // Reduced resolution: raymarch into a low-res target, then bilinear-upsample + composite. Fewer
            // rays (scale per axis) is the whole point — the raymarch is the pass's dominant GPU cost.
            const w = Math.max(1, Math.round(this._host.renderWidth * scale));
            const h = Math.max(1, Math.round(this._host.renderHeight * scale));

            const source = temporal ? this._traceCloudsTemporal(node, w, h, rayPipeline, rayGroup)
                                    : this._traceCloudsDirect(w, h, rayPipeline, rayGroup);

            // Pass B: composite the low-res clouds, premultiplied "over". Not a bilinear blit —
            // cloudUpsample.fs re-decides occlusion per full-resolution pixel, against the G-buffer
            // depth the raymarch bounded itself with, and uses the low-res buffer for colour only.
            const upPass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'cloudUpsample', false);
            const upPipeline = this._pipelines.fullscreen('cloudUpsample', CloudUpsampleProgram,
                                                       VolumetricCloudPasses.CLOUD_BLEND);
            upPass.setPipeline(upPipeline);
            upPass.setBindGroup(0, this._bindGroups.textureGroup(upPipeline, 0,
                                                          [source, this._targets.gBuffer.depth]));
            this._shaderManager.bind('cloudUpsample');
            this._shaderManager.setUniform('u_cloudResolution', [w, h]);
            this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
            this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
            this._shaderManager.setUniform('u_slabBottom', node.baseAltitude);
            this._shaderManager.setUniform('u_slabTop', node.baseAltitude + node.thickness);
            this._passes.drawFullscreen(upPass);
            this._passes.endFullscreenPass(upPass);
        }

        // Restore the state the following opaque/transparent overlay passes expect (incl. the default
        // mask-preserving alpha blend so later overlays don't clobber the bloom mask).
        this._host.restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Bake the tileable 3D noise volumes the cloud raymarch samples. Idempotent and lazy, so a project
     * without clouds never allocates the ~8MB. Two implementations, picked on
     * `capabilities.hasCompute`; they share the field through `chunks/cloudNoiseField.wgsl`.
     */
    public bakeCloudNoise(): void {
        if (this._cloudNoiseBaked) return;
        this._cloudNoiseBaked = true; // set first: a failed bake must not retry every frame

        // `hasCompute`, not `backend === 'webgpu'` and not a build constant. The question the branch
        // actually asks is "can this device run a dispatch", and that is the field that answers it —
        // a backend name is a proxy that would have to be revisited the moment a third one appears.
        if (device.capabilities.hasCompute) this._bakeCloudNoiseCompute();
        else this._bakeCloudNoiseRaster();
    }

    /**
     * The WebGPU bake: one dispatch per volume, writing a `texture_storage_3d`. Not a port of
     * {@link _bakeCloudNoiseRaster} — a WebGPU render attachment cannot be a 3D texture's z-slice.
     *
     * The two paths agree to about a least-significant bit, NOT bit-for-bit: the two rounding steps
     * live in different parts of the driver. `harness:webgpu` gates this at +/-2 LSB.
     */
    private _bakeCloudNoiseCompute(): void {
        const module = device.createShaderModule({
            label: 'cloudNoiseBakeCompute',
            stage: ShaderStage.COMPUTE,
            source: CloudNoiseBakeComputeProgram.wgsl,
            entryPoints: CloudNoiseBakeComputeProgram.entryPoints,
            resources: CloudNoiseBakeComputeProgram.resources,
        });
        const pipeline = device.createComputePipeline({ label: 'cloudNoiseBake', compute: module });

        const encoder = device.createCommandEncoder('cloudNoiseBake');
        const bake = (tex: Texture, size: number, period: number, octaves: number, detail: boolean) => {
            // ONE BUFFER PER VOLUME. Both dispatches go into one encoder and `writeBuffer` is queued,
            // so a reused buffer would take BOTH writes before either dispatch ran.
            // f32, f32, i32, i32 — 16 bytes, every member 4-aligned, so no padding.
            const uniformBytes = new ArrayBuffer(16);
            new Float32Array(uniformBytes).set([size, period]);
            new Int32Array(uniformBytes, 8).set([octaves, detail ? 1 : 0]);
            const uniforms = device.createBuffer({
                label: `cloudNoiseBake.uniforms.${detail ? 'detail' : 'base'}`, size: 16,
                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
            });
            device.writeBuffer(uniforms, 0, new Uint8Array(uniformBytes));

            const pass = encoder.beginComputePass(`cloudNoiseBake.${detail ? 'detail' : 'base'}`);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({
                label: 'cloudNoiseBake',
                layout: pipeline.bindGroupLayouts[0],
                entries: [
                    { binding: 0, buffer: uniforms },
                    // The WHOLE view, not `createTextureView`'s: that one narrows a 3D texture to a
                    // `2d` view of one z-slice, which `texture_storage_3d` rejects at bind time.
                    { binding: 1, storageTextureView: device.createWholeTextureView(tex.rhiTexture) },
                ],
            }));
            // Workgroup COUNTS. @workgroup_size(4,4,4) covers 4 texels per axis; both sizes the
            // renderer bakes divide exactly, and the shader guards the remainder regardless.
            const groups = Math.ceil(size / 4);
            pass.dispatchWorkgroups(groups, groups, groups);
            pass.end();
        };

        // `size` on the config, not a later `createVolume()`: a GPUTexture's dimensions are fixed at
        // creation, and the WebGPU backend's allocate paths say so by throwing. `storage` swaps the
        // render-attachment usage this texture will never need for the STORAGE_BINDING it will.
        const volume = (size: number) => new Texture({
            target: 'texture3D', mipMap: false, wrapping: 'repeat', storage: true,
            size: { width: size, height: size, depth: size },
        });

        this.cloudBaseNoise = volume(VolumetricCloudPasses.CLOUD_BASE_NOISE_SIZE);
        bake(this.cloudBaseNoise, VolumetricCloudPasses.CLOUD_BASE_NOISE_SIZE, VolumetricCloudPasses.CLOUD_BASE_NOISE_PERIOD, 4, false);

        this.cloudDetailNoise = volume(VolumetricCloudPasses.CLOUD_DETAIL_NOISE_SIZE);
        bake(this.cloudDetailNoise, VolumetricCloudPasses.CLOUD_DETAIL_NOISE_SIZE, VolumetricCloudPasses.CLOUD_DETAIL_NOISE_PERIOD, 3, true);

        // One submission for both volumes: the dispatches are independent, and nothing reads the
        // volumes until a later frame's cloud pass samples them.
        encoder.finish();
        Logger.info('Baked cloud noise volumes (compute)', 'Renderer');
    }

    /**
     * The WebGL2 bake: a fullscreen draw per z-slice, with the attachment re-pointed between them.
     * Its output is pinned by three recorded pixel signatures (`meshClouds.deferred`,
     * `meshShading.deferred.full`, `meshBaseline.deferred.full`).
     */
    private _bakeCloudNoiseRaster(): void {
        // A private framebuffer with `framebufferTextureLayer`, not the `Framebuffer` class, which owns
        // a fixed set of 2D attachments. Deliberately NOT an RHI render pass: 160 slices through
        // `createRenderTarget` would strand that many cached framebuffers for the session.
        const bakeFbo = glDevice().createFramebuffer('cloudNoiseBake');

        // Volumes are RGBA8 (the default `precision: 'low'`): the fields are 0..1 scalars that then
        // get remapped and smoothstepped, so 8 bits per channel sits below the noise floor of the
        // result, and float would quadruple an already sizeable allocation.
        const bake = (tex: Texture, size: number, period: number, octaves: number, detail: boolean) => {
            tex.createVolume(size, size, size, 'repeat');
            this._shaderManager.bind('cloudNoiseBake');
            this._shaderManager.setUniform('u_period', period);
            this._shaderManager.setUniform('u_octaves', octaves);
            this._shaderManager.setUniform('u_detail', detail);
            bakeFbo.bind();
            this._passes.setViewport(size, size);
            for (let z = 0; z < size; z++) {
                bakeFbo.attachColorLayer(0, tex.texture, z);
                if (z === 0) {
                    // Once per volume, not per slice. The failure is silent: an incomplete framebuffer
                    // drops every draw and the volume reads back as "no clouds anywhere".
                    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                    if (status !== gl.FRAMEBUFFER_COMPLETE) {
                        Logger.print('error', ['Cloud noise bake framebuffer incomplete:', status], 'Renderer');
                        return;
                    }
                }
                // Texel centre, so the baked value lands at the point a LINEAR fetch will sample.
                this._shaderManager.setUniform('u_slice', (z + 0.5) / size);
                this._passes.screenQuad.draw(); // not _drawFullscreen: a one-off bake is not a per-frame pass
            }
        };

        GLState.depthTest(false);
        GLState.blend(false);
        GLState.depthMask(false);

        this.cloudBaseNoise = new Texture({ target: 'texture3D', mipMap: false, wrapping: 'repeat' });
        bake(this.cloudBaseNoise, VolumetricCloudPasses.CLOUD_BASE_NOISE_SIZE, VolumetricCloudPasses.CLOUD_BASE_NOISE_PERIOD, 4, false);

        this.cloudDetailNoise = new Texture({ target: 'texture3D', mipMap: false, wrapping: 'repeat' });
        bake(this.cloudDetailNoise, VolumetricCloudPasses.CLOUD_DETAIL_NOISE_SIZE, VolumetricCloudPasses.CLOUD_DETAIL_NOISE_PERIOD, 3, true);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        bakeFbo.destroy();
        GLState.depthMask(true);
        Logger.info('Baked cloud noise volumes', 'Renderer');
    }

    /** Non-temporal reduced-resolution trace: every pixel, straight into `cloudsFBO`. */
    private _traceCloudsDirect(w: number, h: number, pipeline: RenderPipeline,
                               group: (p: RenderPipeline) => BindGroup): Texture {
        if (this.cloudsFBO.width !== w || this.cloudsFBO.height !== h) this.cloudsFBO.resize(w, h);
        this._shaderManager.setUniform('u_temporal', false);
        this._shaderManager.setUniform('u_jitterSlot', this._view.frameIndex % 16);
        const tracePass = this._passes.beginFullscreenPass(this.cloudsFBO.renderTarget, 'cloudTrace',
                                                    true, [0, 0, 0, 0], false);
        tracePass.setPipeline(pipeline);
        tracePass.setBindGroup(0, group(pipeline));
        this._passes.drawFullscreen(tracePass);
        this._passes.endFullscreenPass(tracePass);
        // Whatever setting change routed us here also makes the accumulated history meaningless.
        this.cloudHistoryValid = false;
        return this.cloudsFBO.colors[0];
    }

    /**
     * Bayer-subset temporal trace + resolve. Traces 1/16 of the cloud-resolution pixels into a
     * quarter-size buffer, then reconstructs the full image from reprojected history.
     *
     * Returns the texture holding this frame's resolved clouds.
     */
    private _traceCloudsTemporal(node: VolumetricCloudsNode, w: number, h: number,
                                 pipeline: RenderPipeline,
                                 group: (p: RenderPipeline) => BindGroup): Texture {
        // Trace target: one pixel per 4x4 block of the cloud image. Ceil so the blocks cover the
        // whole image when w/h are not multiples of 4 (the resolve clamps its reads at the edges).
        const tw = Math.max(1, Math.ceil(w / VolumetricCloudPasses.CLOUD_BAYER_SIZE));
        const th = Math.max(1, Math.ceil(h / VolumetricCloudPasses.CLOUD_BAYER_SIZE));

        // Must run BEFORE the reseed test below: a resize reallocates the targets and clears
        // cloudHistoryValid, which is exactly the case the reseed exists for.
        this._ensureCloudTemporalTargets(w, h, tw, th);

        // --- Reseed: no usable history, so trace the WHOLE cloud image once ---
        // Tracing 1/16 anyway would show a blocky 4x upscale converging over ~16 frames.
        if (!this.cloudHistoryValid || !this._view.hasPrevViewProj) {
            const seed = this._cloudHistoryIndex ^ 1;
            // The raymarch shader is still bound by the caller; u_temporal false makes traceUV() the
            // identity, so this writes one ray per pixel of the history target.
            this._shaderManager.setUniform('u_temporal', false);
            this._shaderManager.setUniform('u_jitterSlot', this._view.frameIndex % 16);
            const tracePass = this._passes.beginFullscreenPass(this.cloudHistoryFBOs[seed].renderTarget, 'cloudReseed',
                                                        true, [0, 0, 0, 0], false);
            tracePass.setPipeline(pipeline);
            tracePass.setBindGroup(0, group(pipeline));
            this._passes.drawFullscreen(tracePass);
            this._passes.endFullscreenPass(tracePass);
            this._cloudHistoryIndex = seed;
            this.cloudHistoryValid = true;
            return this.cloudHistoryFBOs[seed].colors[0];
        }

        // --- Trace: 1/16 of the rays ---
        const bayerIndex = this._view.frameIndex % 16;
        const cell = VolumetricCloudPasses.CLOUD_BAYER_ORDER.indexOf(bayerIndex);
        this._shaderManager.setUniform('u_temporal', true);
        this._shaderManager.setUniform('u_traceResolution', [tw, th]);
        this._shaderManager.setUniform('u_bayerOffset', [cell % 4, Math.floor(cell / 4)]);
        // Advance the ray-start dither once per Bayer slot, so a pixel sees the same 16 offsets every
        // cycle and the resolve's accumulation averages them away instead of freezing in grain.
        this._shaderManager.setUniform('u_jitterSlot', bayerIndex);

        const tracePass = this._passes.beginFullscreenPass(this.cloudTraceFBO.renderTarget, 'cloudTraceBayer',
                                                    true, [0, 0, 0, 0], false);
        tracePass.setPipeline(pipeline);
        tracePass.setBindGroup(0, group(pipeline));
        this._passes.drawFullscreen(tracePass);
        this._passes.endFullscreenPass(tracePass);

        // --- Resolve: reconstruct full cloud resolution from history + the new samples ---
        this._passes.scope('clouds.resolve');
        const dst = this._cloudHistoryIndex ^ 1;
        const prev = this.cloudHistoryFBOs[this._cloudHistoryIndex];
        const resolvePass = this._passes.beginFullscreenPass(this.cloudHistoryFBOs[dst].renderTarget,
                                                      'clouds.resolve', false, undefined, false);
        const resolvePipeline = this._pipelines.fullscreen('cloudTemporalResolve', CloudTemporalResolveProgram);
        resolvePass.setPipeline(resolvePipeline);
        resolvePass.setBindGroup(0, this._bindGroups.textureGroup(resolvePipeline, 0, [
            this.cloudTraceFBO.colors[0], prev.colors[0], this._targets.gBuffer.depth,
        ]));
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_prevViewProj', this._projection.uvProducing(this._view.prevViewProj));
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        this._shaderManager.setUniform('u_resolution', [w, h]);
        this._shaderManager.setUniform('u_traceResolution', [tw, th]);
        this._shaderManager.setUniform('u_bayerIndex', bayerIndex);
        // History needs BOTH a seeded buffer and a previous camera to reproject through; a resize
        // invalidates the first, the first frame the second. Always true while the reseed above
        // returns early, but must stay set — an unset uniform silently reads as false.
        this._shaderManager.setUniform('u_historyValid', this.cloudHistoryValid && this._view.hasPrevViewProj);
        this._shaderManager.setUniform('u_slabMid', node.baseAltitude + node.thickness * 0.5);
        this._passes.drawFullscreen(resolvePass);
        this._passes.endFullscreenPass(resolvePass);

        this._cloudHistoryIndex = dst;
        this.cloudHistoryValid = true;
        return this.cloudHistoryFBOs[dst].colors[0];
    }

    /**
     * Size the temporal targets, invalidating history whenever they change. The invalidation is
     * mandatory: `Framebuffer.resize` reallocates its attachments, holding uninitialized memory.
     */
    private _ensureCloudTemporalTargets(w: number, h: number, tw: number, th: number): void {
        if (this.cloudHistoryFBOs.length === 0) {
            for (let i = 0; i < 2; i++)
                this.cloudHistoryFBOs.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }));
        }
        if (this._cloudHistoryW !== w || this._cloudHistoryH !== h) {
            for (const fbo of this.cloudHistoryFBOs) fbo.resize(w, h);
            this._cloudHistoryW = w;
            this._cloudHistoryH = h;
            this.cloudHistoryValid = false;
        }
        if (this.cloudTraceFBO.width !== tw || this.cloudTraceFBO.height !== th) {
            this.cloudTraceFBO.resize(tw, th);
            this.cloudHistoryValid = false;
        }
    }

    /** Cloud knobs for the active tier, applied to the scene's clouds node each frame it exists. */
    private _applyQualityToClouds(node: VolumetricCloudsNode): void {
        if (this._host.quality === 'custom') return;
        // Push the tier's values ONCE per (tier, node) rather than every frame. Re-asserting them
        // continuously would silently overwrite anything the user changed by hand a frame later —
        // including the inspector's own Temporal Upscale checkbox, which would appear to do nothing.
        if (this.cloudsTierApplied === this._host.quality && this._cloudsTierNode === node) return;
        this.cloudsTierApplied = this._host.quality;
        this._cloudsTierNode = node;
        const t = QUALITY_TIERS[this._host.quality];
        // Any of these changes what the traced image looks like, so the accumulated history stops
        // being a valid predecessor for it.
        if (node.resolutionScale !== t.cloudResolutionScale) {
            node.resolutionScale = t.cloudResolutionScale;
            this.cloudHistoryValid = false;
        }
        if (node.steps !== t.cloudSteps) { node.steps = t.cloudSteps; this.cloudHistoryValid = false; }
        if (node.lightSteps !== t.cloudLightSteps) { node.lightSteps = t.cloudLightSteps; this.cloudHistoryValid = false; }
        // Ultra traces every pixel every frame: it is the reference/still-capture tier, so it trades
        // the 16x ray saving for zero reprojection artifacts.
        const wantTemporal = this._host.quality !== 'ultra';
        if (node.temporalUpscale !== wantTemporal) {
            node.temporalUpscale = wantTemporal;
            this.cloudHistoryValid = false;
        }
    }
}
