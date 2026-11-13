import { mat4 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import { VolumetricCloudsNode } from '../../core/scene/nodes/volumetricCloudsNode';
import { Scene } from '../../core/scene/scene';
import { atmosphereTransmittance, shHemisphereMeans } from '../cloudLighting';
import { Framebuffer } from '../framebuffer';
import { TemporalHistory } from './temporalHistory';
import { device } from '../rhi/deviceHandle';
import type { RenderPipeline, BindGroup } from '../rhi/resources';
import { ShaderStage, BufferUsage } from '../rhi/types';
import type { BlendState } from '../rhi/types';
import { keyLight } from '../skyNight';
import { Texture } from '../texture';
import { VolumetricCloudsProgram, CloudUpsampleProgram, CloudNoiseBakeProgram, CloudNoiseBakeComputeProgram, CloudTemporalResolveProgram } from './programs';
import { QUALITY_TIERS } from './settingsTypes';
import type { QualityPreset } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';
import { smoothstep } from '../../core/math';

/** What VolumetricCloudPasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface VolumetricCloudPassesHost {
    readonly quality: QualityPreset;
    readonly renderHeight: number;
    readonly renderWidth: number;
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
                private readonly _projection: ViewProjection,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

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

    // Temporal reprojection targets: `cloudHistory` ping-pong at cloud render resolution, and
    // `cloudTraceFBO` holds the new samples at 1/4 per axis — 1/16 of the pixels. The history is
    // untrusted whenever it cannot be relied on — first frame, a resize, a quality change, a camera
    // cut — and that frame traces at full cloud resolution to reseed rather than upscaling 1/16 of it.
    // WITH a depth attachment, unlike the other histories: the reseed draws into it through the shared
    // raymarch pipeline, built against the depth-bearing scene target, and WebGPU rejects a pipeline
    // with depth state in a pass that has no depth attachment.
    public readonly cloudHistory = new TemporalHistory({ colorTextureOptions: { mipMap: false, precision: 'high' } });
    public cloudTraceFBO!: Framebuffer;

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
        const day = smoothstep(0.08, 0.35, elevation);         // 1 = sun clearly above the horizon
        const night = 1 - smoothstep(-0.22, -0.03, elevation); // 1 = sun clearly below it
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
                // The same coefficients `SkyPasses._bakeSkyAtmosphere` hands the sky shader.
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
            // The key light's strength: fades out at sunset, and is the moonlight fraction at night. Not
            // rescaled to the sky's units: the clouds are lit by the sun that lights the ground, and were
            // tuned against that ground. A physical sky now converges to the radiance the artistic one
            // was tuned at, so the balance against the sky holds as well.
            effSunIntensity = node.sunIntensity * this._sys.lighting.keyLightScale();
        } else {
            effSunColor = [0, 1, 2].map(i =>
                sunColor[i] * mix1(1, sunsetColor[i], sunset) * mix1(1, NIGHT_SUN_DIM, night));
            // Sun intensity follows elevation: dimmest on the horizon (long atmospheric path), ramping
            // to the authored full value with the sun at the zenith.
            const HORIZON_SUN_INTENSITY = 0.25;
            effSunIntensity = node.sunIntensity * mix1(HORIZON_SUN_INTENSITY, 1, smoothstep(0, 1, elevation));
        }

        let effAmbientColor: number[];
        let effGroundColor: number[];
        let effAmbientIntensity = node.ambientIntensity;
        // Only with an atmosphere: its sun irradiance is what puts the sky's radiance and the clouds'
        // `sunIntensity` on one scale. A skybox's SH comes in arbitrary units the clouds cannot relate to.
        const skySH = node.useSkyAmbient && atmo && scene.skyLight && this._sys.sky.clearSkySHValid ? this._sys.sky.clearSkySH : null;
        if (skySH && atmo) {
            // The real sky's radiance: it already darkens, reddens and goes blue-hour with the sun.
            // Re-expressed in the clouds' units: sky radiance per unit of the atmosphere's sun
            // irradiance, times the clouds' own sun irradiance.
            const toCloudUnits = node.sunIntensity / Math.max(1e-4, this._sys.sky.skySunScale(atmo));
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
     * by the live pass and the sky bake, which differ only in the view (`invViewProj`, `eye`) and the wind's
     * drift (`windOffset`, the bake's frozen one). Expects the 'volumetricClouds' program to be bound.
     */
    public setCloudUniforms(scene: Scene, node: VolumetricCloudsNode, invViewProj: mat4,
                              eye: ArrayLike<number>, windOffset: ArrayLike<number>): void {
        this._shaderManager.setUniform('u_invViewProj', invViewProj);
        this._shaderManager.setUniform('u_viewPos', eye);
        this._shaderManager.setUniform('u_time', this._view.windTime);
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
                    sunDir = this._sys.lighting.dirOf(light);
                    const key = light === this._sys.lighting.keyLightNode ? this._sys.lighting.keyLight : null;
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
        // Animation: how far the wind has carried the clouds (`advanceCloudWind`), not a speed times a
        // clock. The speed and the clock are still uploaded for the struct, but the shader reads the drift.
        const windSpeed = node.resolveWind(scene.wind, this._sys.shadows.cloudWindDir);
        this._shaderManager.setUniform('u_wind', windOffset);
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

    /**
     * How far the wind has carried the clouds, world metres: the sum of direction × speed × dt over every
     * frame, on the render clock. Integrated rather than `speed × time` so that a wind that strengthens,
     * slows or turns (a preset blending from clear to storm) carries the clouds on from where they are; a
     * product of a changing speed and a clock already minutes along would race them across the sky.
     */
    public readonly windOffset: [number, number, number] = [0, 0, 0];
    private readonly _windDir: [number, number, number] = [0, 0, 0];

    /** Carry the clouds on by `dt` seconds of the render clock, with the node's wind as it is now. */
    public advanceCloudWind(scene: Scene, dt: number): void {
        const node = scene.volumetricClouds;
        if (!node || !(dt > 0)) return;
        const speed = node.resolveWind(scene.wind, this._windDir);
        if (!Number.isFinite(speed)) return;
        const o = this.windOffset, d = this._windDir;
        o[0] += d[0] * speed * dt; o[1] += d[1] * speed * dt; o[2] += d[2] * speed * dt;
    }

    /** The clouds' drift as drawn: frozen at the bake while they are drawn from it. */
    public cloudWindOffset(scene: Scene, node: VolumetricCloudsNode): ArrayLike<number> {
        return this._sys.sky.cloudSkyActive(scene) ? node.bakedWindOffset : this.windOffset;
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

        // Fullscreen overlay with no depth (occlusion is handled through the depth texture), blended by
        // `CLOUD_BLEND`: clouds are bloom-eligible, so coverage goes into the mask alpha instead of the
        // default mask-preserving blend, and the shader outputs PREMULTIPLIED colour, so RGB and alpha
        // share ONE, ONE_MINUS_SRC_ALPHA.

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
        this.setCloudUniforms(scene, node, this._view.invViewProj, this._view.camera.position, this.windOffset);
        this._shaderManager.setUniform('u_ignoreDepth', false);
        this._shaderManager.setUniform('u_preExposure', this._view.preExposure);

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
            this._passes.drawFullscreenAndEnd(pass);
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
            this._fullscreen.bind(upPass, 'cloudUpsample', CloudUpsampleProgram, [source, this._targets.gBuffer.depth], VolumetricCloudPasses.CLOUD_BLEND);
            this._shaderManager.bind('cloudUpsample');
            this._shaderManager.setUniform('u_cloudResolution', [w, h]);
            this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
            this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
            this._shaderManager.setUniform('u_slabBottom', node.baseAltitude);
            this._shaderManager.setUniform('u_slabTop', node.baseAltitude + node.thickness);
            this._passes.drawFullscreenAndEnd(upPass);
        }

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
     * The raster bake, for a device without compute: a fullscreen draw per z-slice, one render pass per
     * slice into ONE target over the whole volume (`depthSlice` picks the slice). Its output is pinned
     * by three recorded pixel signatures (`meshClouds.deferred`, `meshShading.deferred.full`,
     * `meshBaseline.deferred.full`).
     */
    private _bakeCloudNoiseRaster(): void {
        // Volumes are RGBA8 (the default `precision: 'low'`): the fields are 0..1 scalars that then
        // get remapped and smoothstepped, so 8 bits per channel sits below the noise floor of the
        // result, and float would quadruple an already sizeable allocation.
        const bake = (tex: Texture, size: number, period: number, octaves: number, detail: boolean) => {
            tex.createVolume(size, size, size, 'repeat');
            // An incomplete target is reported by `createRenderTarget`'s completeness check — the
            // failure that would otherwise read back as "no clouds anywhere".
            const target = device.createRenderTarget({
                label: 'cloudNoiseBake', colorViews: [device.createWholeTextureView(tex.rhiTexture)],
            });
            // No depth, no blend, no culling, every channel written: the state the bake always wanted,
            // now stated rather than inherited from whichever pipeline ran before it.
            const pipeline = this._pipelines.fullscreen('cloudNoiseBake', CloudNoiseBakeProgram, undefined, undefined, target);
            this._shaderManager.bind('cloudNoiseBake');
            this._shaderManager.setUniform('u_period', period);
            this._shaderManager.setUniform('u_octaves', octaves);
            this._shaderManager.setUniform('u_detail', detail);
            const encoder = device.createCommandEncoder('cloudNoiseBake');
            for (let z = 0; z < size; z++) {
                const pass = encoder.beginRenderPass(target, {
                    label: 'cloudNoiseBake',
                    colorAttachments: [{ target: 0, loadOp: 'load', storeOp: 'store', depthSlice: z }],
                });
                pass.setPipeline(pipeline);
                // Texel centre, so the baked value lands at the point a LINEAR fetch will sample.
                this._shaderManager.setUniform('u_slice', (z + 0.5) / size);
                // Not `drawFullscreen`: a one-off bake is not a per-frame pass for the fill-rate stats.
                this._passes.recordDraw(pass, this._passes.screenQuad, 0, 0);
                pass.end();
            }
            encoder.finish();
        };

        this.cloudBaseNoise = new Texture({ target: 'texture3D', mipMap: false, wrapping: 'repeat' });
        bake(this.cloudBaseNoise, VolumetricCloudPasses.CLOUD_BASE_NOISE_SIZE, VolumetricCloudPasses.CLOUD_BASE_NOISE_PERIOD, 4, false);

        this.cloudDetailNoise = new Texture({ target: 'texture3D', mipMap: false, wrapping: 'repeat' });
        bake(this.cloudDetailNoise, VolumetricCloudPasses.CLOUD_DETAIL_NOISE_SIZE, VolumetricCloudPasses.CLOUD_DETAIL_NOISE_PERIOD, 3, true);

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
        this._passes.drawFullscreenAndEnd(tracePass);
        // Whatever setting change routed us here also makes the accumulated history meaningless.
        this.cloudHistory.invalidate();
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
        // `cloudHistory.valid`, which is exactly the case the reseed exists for.
        this._ensureCloudTemporalTargets(w, h, tw, th);

        // --- Reseed: no usable history, so trace the WHOLE cloud image once ---
        // Tracing 1/16 anyway would show a blocky 4x upscale converging over ~16 frames.
        if (!this.cloudHistory.valid || !this._view.hasPrevViewProj) {
            // The raymarch shader is still bound by the caller; u_temporal false makes traceUV() the
            // identity, so this writes one ray per pixel of the history target.
            this._shaderManager.setUniform('u_temporal', false);
            this._shaderManager.setUniform('u_jitterSlot', this._view.frameIndex % 16);
            const tracePass = this._passes.beginFullscreenPass(this.cloudHistory.write.renderTarget, 'cloudReseed',
                                                        true, [0, 0, 0, 0], false);
            tracePass.setPipeline(pipeline);
            tracePass.setBindGroup(0, group(pipeline));
            this._passes.drawFullscreenAndEnd(tracePass);
            this.cloudHistory.swap(this._view.preExposure);
            return this.cloudHistory.read.colors[0];
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
        this._passes.drawFullscreenAndEnd(tracePass);

        // --- Resolve: reconstruct full cloud resolution from history + the new samples ---
        this._passes.scope('clouds.resolve');
        const prev = this.cloudHistory.read;
        const resolvePass = this._passes.beginFullscreenPass(this.cloudHistory.write.renderTarget,
                                                      'clouds.resolve', false, undefined, false);
        this._fullscreen.bind(resolvePass, 'cloudTemporalResolve', CloudTemporalResolveProgram, [
            this.cloudTraceFBO.colors[0], prev.colors[0], this._targets.gBuffer.depth,
        ]);
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_prevViewProj', this._projection.uvProducing(this._view.prevViewProj));
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        this._shaderManager.setUniform('u_resolution', [w, h]);
        this._shaderManager.setUniform('u_traceResolution', [tw, th]);
        this._shaderManager.setUniform('u_bayerIndex', bayerIndex);
        // History needs BOTH a seeded buffer and a previous camera to reproject through; a resize
        // invalidates the first, the first frame the second. Always true while the reseed above
        // returns early, but must stay set — an unset uniform silently reads as false.
        this._shaderManager.setUniform('u_historyValid', this.cloudHistory.valid && this._view.hasPrevViewProj);
        this._shaderManager.setUniform('u_slabMid', node.baseAltitude + node.thickness * 0.5);
        this._shaderManager.setUniform('u_historyRescale', this.cloudHistory.rescale(this._view.preExposure));
        this._passes.drawFullscreenAndEnd(resolvePass);

        this.cloudHistory.swap(this._view.preExposure);
        return this.cloudHistory.read.colors[0];
    }

    /**
     * Size the temporal targets, invalidating history whenever they change. The invalidation is
     * mandatory: `Framebuffer.resize` reallocates its attachments, holding uninitialized memory.
     */
    private _ensureCloudTemporalTargets(w: number, h: number, tw: number, th: number): void {
        this.cloudHistory.ensure(w, h);
        if (this.cloudTraceFBO.width !== tw || this.cloudTraceFBO.height !== th) {
            this.cloudTraceFBO.resize(tw, th);
            this.cloudHistory.invalidate();
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
            this.cloudHistory.invalidate();
        }
        if (node.steps !== t.cloudSteps) { node.steps = t.cloudSteps; this.cloudHistory.invalidate(); }
        if (node.lightSteps !== t.cloudLightSteps) { node.lightSteps = t.cloudLightSteps; this.cloudHistory.invalidate(); }
        // Ultra traces every pixel every frame: it is the reference/still-capture tier, so it trades
        // the 16x ray saving for zero reprojection artifacts.
        const wantTemporal = this._host.quality !== 'ultra';
        if (node.temporalUpscale !== wantTemporal) {
            node.temporalUpscale = wantTemporal;
            this.cloudHistory.invalidate();
        }
    }
}
