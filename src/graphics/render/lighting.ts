import { vec3, mat4 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import { LightNode } from '../../core/scene/nodes/lightNode';
import { Scene } from '../../core/scene/scene';
import { spotBoundingSphere, DEFAULT_CLUSTER_GRID } from '../clusters';
import type { ClusterLight } from '../clusters';
import { NO_SHADOW_SLOT, POINT_CONE_SCALE, POINT_CONE_OFFSET } from '../lightData';
import { LightGrid, MAX_LIGHTS } from '../lightGrid';
import { DirectionalLight, Spotlight, PointLight, DEFAULT_SCENE_AMBIENT_LUX, REFERENCE_ILLUMINANCE } from '../lighting';
import { device } from '../rhi/deviceHandle';
import type { ShaderProgram } from '../rhi/shaderProgram';
import { keyLight, moonDirection } from '../skyNight';
import type { KeyLight } from '../skyNight';
import { customForwardTypes } from '../systems/customShaders';
import { Texture } from '../texture';
import { DeferredLightingProgram } from './programs';
import { ShadowPasses } from './shadows';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { Visibility } from './visibility';
import type { SsilPasses } from './ssil';
import { ShaderManager } from '../systems/shaderManager';
import type { RenderSubsystems } from './subsystems';

/** The material shader keys that receive per-frame forward lighting/shadow/env uploads. Custom
 *  forward materials are appended at runtime via `customForwardTypes()`. */
const FORWARD_SHADERS = ['blinn_phong', 'blinn_phongSkinned', 'pbr', 'pbrSkinned', 'pbrPom', 'pbrSkinnedPom', 'terrainForward',
                         'cel', 'celSkinned'];

let _forwardShaderCache: string[] = [...FORWARD_SHADERS];
let _forwardShaderCustomKey: string | null = null;
function allForwardShaders(): string[] {
    const custom = customForwardTypes();
    // Keyed on the NAMES, not the count. Editing a custom material swaps its key for a new one and
    // releases the old, which leaves the count unchanged — a count-keyed cache then kept handing out the
    // released key, `bind` threw "ShaderProgram custom:… not found" on every frame, and the viewport
    // went black until reload.
    const key = custom.join('|');
    if (key !== _forwardShaderCustomKey) {
        _forwardShaderCustomKey = key;
        _forwardShaderCache = [...FORWARD_SHADERS, ...custom];
    }
    return _forwardShaderCache;
}

/** What LightingPasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface LightingPassesHost {
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
    readonly clearColor: number[];
}

/**
 * The frame's lights: the key light (sun by day, moon at night), the clustered grid every point and
 * spot light is assigned through, the cloud grade applied at upload time, the per-frame lighting
 * uploads to the forward programs, and the deferred pass that lights the G-buffer. Split out of
 * Renderer.
 */
export class LightingPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: LightingPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _shadows: ShadowPasses,
                private readonly _visibility: Visibility,
                private readonly _ssil: SsilPasses,
                private readonly _sys: RenderSubsystems) {}

    /**
     * The scene's directional light AS UPLOADED this frame — the sun by day, the moon at night — when a
     * SkyAtmosphere drives it (see skyNight.ts). Null means "upload the node as authored". The node is
     * never written to: a save must keep the light the user placed.
     */
    public keyLight: KeyLight | null = null;
    public keyLightNode: LightNode | null = null;
    public readonly keyLightDir: vec3 = vec3.create();

    /**
     * The clustered light grid: every point and spot light in the scene, assigned to the parts of the
     * frustum they can actually reach. Replaces the fixed 16-point / 8-spot uniform arrays.
     */
    public readonly lightGrid: LightGrid = new LightGrid();

    /**
     * How far the cluster grid reaches, in world units.
     *
     * NOT the camera's far plane, for the same reason `_shadows.shadowDistance` is not: the editor camera runs
     * `far = 10000`, and an exponential slicing over that range spends most of its slices on empty
     * space beyond anything lit. A light past this distance is dropped from the grid entirely.
     */
    public clusterDistance: number = 500;

    /** Reused per-frame scratch: one bounding sphere per punctual light, in the grid's own vocabulary. */
    private readonly _clusterLights: ClusterLight[] = [];

    /** Backing store for the spheres above, so a frame allocates nothing. */
    private readonly _clusterCenters: Float32Array[] = [];

    /** Scratch for a spot light's cone sphere. */
    public readonly coneSphere = { center: new Float32Array(3), radius: 0 };
    public specularOcclusionEnabled: boolean = true;
    public horizonOcclusionEnabled: boolean = true;
    private static readonly _IDENTITY_MAT4: mat4 = mat4.create();

    /**
     * The forward programs that exist: a published game builds only the ones it uses, and the per-frame
     * uploads must not build the rest by binding them. One built later is caught up by the next frame's
     * uploads, which run before any draw.
     */
    private _forwardShaders(): string[] {
        const all = allForwardShaders();
        const generation = this._shaderManager.generation;
        if (all === this._forwardSource && generation === this._forwardGeneration) return this._forwardList;
        // ONE name per program: several names can alias one program (a logical name and its variant,
        // `pbrPom` and `pbr` when no variant splits them), and every name listed costs a full set of
        // lighting, shadow and environment uploads per frame — into a program that already has them.
        const seen = new Set<ShaderProgram>();
        const out: string[] = [];
        for (const name of all) {
            const program = this._shaderManager.find(name);
            if (program) {
                if (seen.has(program)) continue;
                seen.add(program);
                out.push(name);
            } else if (!this._sys.programs.programList) {
                // The editor builds everything: a name not registered yet is one the bind below should
                // build (or report), as it always did.
                out.push(name);
            }
        }
        this._forwardSource = all;
        this._forwardGeneration = generation;
        this._forwardList = out;
        return out;
    }

    private _forwardSource: string[] | null = null;
    private _forwardGeneration = -1;
    private _forwardList: string[] = [];

    // Zero the forward shaders' directional slot and light counts before this frame's lights are
    // applied. Required every frame, even with none: a removed light's uniforms persist in the program.
    public resetForwardLighting(scene: Scene): void {
        for (const shaderName of this._forwardShaders()) {
            this._shaderManager.bind(shaderName);
            this.lightGrid.uploadUniforms(this._shaderManager);
            this._clearDirectional();
            this._shaderManager.setUniform('u_sceneAmbient', this.internalAmbient(scene));
            // The forward path has no SSAO, but it does have the material AO map, so it needs the same
            // flag. Declared in chunks/pbrForward.wgsl and uploaded nowhere would mean it read 0 and
            // specular occlusion was silently off in every forward material.
            this._shaderManager.setUniform('u_specularOcclusion', this.specularOcclusionEnabled);
            this._shaderManager.setUniform('u_horizonOcclusion', this.horizonOcclusionEnabled);
            // The sky light is not a light NODE, so the per-light loop that follows never reaches it and
            // this is where it has to be uploaded. A scene with a sky light and no directional light is
            // perfectly ordinary — an overcast day is exactly that.
            this._uploadSkyLight();
        }
    }

    /** Push every shadow uniform to all forward material programs (including custom materials). */
    public bindShadowsToForwardShaders(): void {
        for (const shaderName of this._forwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shadows.uploadShadowUniforms(shaderName);
        }
    }

    public bindEnvToForwardShaders(scene: Scene): void {
        // Frame-default probe: the one whose volume covers the camera. Uses its SHARP linear-HDR
        // capture rather than the convolved prefilter, falling back to the sRGB scene environment;
        // `u_envMapLinear` tells the shader which decode to apply.
        const probe = scene.probeForPoint(this._view.camera.position, true);
        const probeCube = probe ? (probe.envMap ?? probe.prefiltered) : null;
        const linearCube = probeCube ?? (scene.environmentMap ? null : this._sys.sky.skyReflectionCube);
        const envCube = linearCube ?? scene.environmentMap;
        for (const shaderName of this._forwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_useEnvMap', envCube ? true : false);
            this._shaderManager.setUniform('u_envMapLinear', linearCube ? true : false);
        }
    }

    private readonly _probeLobes: [number[], number[]] = [[1, 1], [1, 1]];
    private readonly _skyReflectionScale: Float32Array = new Float32Array(3);

    public deferredLightingPass(scene: Scene, shadowLight: LightNode | null): void {
        const w = this._host.renderWidth, h = this._host.renderHeight;

        // Copy the opaque depth into the scene FBO so forward passes depth-test correctly.
        this._passes.copyDepth(this._targets.gBuffer.depth, this._targets.scene.depth, w, h);

        // Depth was blitted in; clear only colour. Alpha clears to 0 so the background starts with an
        // empty bloom mask. Thumbnails clear to transparent black, so no fringe bleeds in.
        const cc = this._host.clearColor;
        const bg = this._host.thumbnailMode ? [0, 0, 0] : cc;
        // This pass binds its shadows through group 3, but the unit reservation stays: CUSTOM materials
        // still sample the cascade array at 6 and the spot atlas at 15, bound once per frame.
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'deferredLighting', true,
                                               [bg[0], bg[1], bg[2], 0.0], false);
        const pipeline = this._pipelines.fullscreen('deferredLighting', DeferredLightingProgram);
        pass.setPipeline(pipeline);

        // Group 0: the G-buffer plus SSIL and SSR. Both always bind a complete texture even when disabled —
        // the shader gates on u_ssaoEnabled / u_ssrEnabled, but the sampler still has to point somewhere valid.
        const ssr = this._sys.ssr;
        const ssrLive = ssr.ssrProducedThisFrame && ssr.ssrResult !== null;
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
            this._targets.gBuffer.colors[0], this._targets.gBuffer.colors[1], this._targets.gBuffer.colors[2],
            this._targets.gBuffer.depth, (this._ssil.ssaoResult ?? this._ssil.ssaoBlurFBO).colors[0],
            ssrLive ? ssr.ssrResult!.colors[0] : this._bindGroups.fallbackTexture,
        ]));

        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);

        // Upload all lights once for the whole screen.
        this._setDeferredLighting(scene);

        // Shadows
        this._shaderManager.bind('deferredLighting');
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shadows.uploadShadowUniforms('deferredLighting');
        pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline));

        // Split-sum IBL from up to 2 probe volumes, blended per pixel by feathered containment;
        // uncovered pixels fall back to flat ambient plus the `u_envMap` reflection: the scene's
        // environment map, else the sky light's sky, prefiltered (SkyPasses.updateSkyReflection).
        // EVERY sampler unit is assigned every frame, used or not — an unassigned cube sampler aliases
        // the 2D G-buffer sampler on unit 0, which is a draw-time type collision.
        const skyReflection = scene.environmentMap ? null : this._sys.sky.skyReflectionCube;
        const skyLight = scene.skyLight;
        this._shaderManager.setUniform('u_envMapMode', scene.environmentMap ? 1 : skyReflection ? 2 : 0);
        if (skyReflection && skyLight) {
            const k = skyLight.intensity, tint = skyLight.tint;
            this._skyReflectionScale[0] = k * tint[0];
            this._skyReflectionScale[1] = k * tint[1];
            this._skyReflectionScale[2] = k * tint[2];
            this._shaderManager.setUniform('u_skyReflectionScale', this._skyReflectionScale);
        }
        const probes = scene.probesForFrame(this._view.camera.position, 2);
        this._shaderManager.setUniform('u_probeCount', probes.length);

        // Group 2: the IBL cubes, the BRDF LUT and the environment fallback. Every slot resolves to a
        // COMPLETE cubemap — the probe's, else the other probe's, else the scene environment, else the
        // 1x1 fallback — because a bind group has no way to say "leave this one unbound".
        const cubes: Texture[] = [];
        for (let i = 0; i < 2; i++) {
            const fill = probes[i] ?? probes[0] ?? null;
            const irradiance = fill?.irradiance ?? scene.environmentMap ?? this._bindGroups.fallbackCube;
            const prefiltered = fill?.prefiltered ?? scene.environmentMap ?? this._bindGroups.fallbackCube;
            cubes.push(irradiance, prefiltered);
        }
        pass.setBindGroup(2, this._bindGroups.textureGroup(pipeline, 2, [
            cubes[0], cubes[1], cubes[2], cubes[3],
            this._sys.sky.brdfFBO.colors[0], scene.environmentMap ?? skyReflection ?? this._bindGroups.fallbackCube,
        ]));

        for (let i = 0; i < 2; i++) {
            const slot = probes[i] ?? null;
            this._shaderManager.setUniform(`u_iblIntensity${i}`, slot ? slot.intensity : 0);
            this._shaderManager.setUniform(`u_probeUnbounded${i}`, slot ? !slot.bounded : false);
            this._shaderManager.setUniform(`u_probeInvVolume${i}`, slot && slot.bounded ? slot.invVolumeMatrix : LightingPasses._IDENTITY_MAT4);
            this._shaderManager.setUniform(`u_probeBlend${i}`, slot && slot.bounded ? slot.volumeBlend : [0, 0, 0]);
            // Which lobes the probe claims: x = lighting (diffuse), y = reflections (specular).
            const lobes = this._probeLobes[i];
            lobes[0] = slot && slot.affectsLighting ? 1 : 0;
            lobes[1] = slot && slot.affectsReflections ? 1 : 0;
            this._shaderManager.setUniform(`u_probeLobes${i}`, lobes);
        }

        // SSIL. Always bind a complete texture so the sampler is valid; the shader only reads it when
        // u_ssaoEnabled is true. The bounce is scaled to nothing when it was not gathered this frame.
        this._shaderManager.setUniform('u_ssaoEnabled', this._ssil.ssaoProducedThisFrame);
        this._shaderManager.setUniform('u_ssilIntensity', this._ssil.ssilBounceThisFrame ? this._ssil.ssilIntensity : 0);
        this._shaderManager.setUniform('u_specularOcclusion', this.specularOcclusionEnabled);
        this._shaderManager.setUniform('u_horizonOcclusion', this.horizonOcclusionEnabled);
        // Texel size drives the depth-aware upsample. Zero when the AO buffer is already full
        // resolution, which tells the shader to take the plain (and then exact) bilinear fetch.
        this._shaderManager.setUniform('u_ssaoTexelSize',
            this._ssil.ssaoResolutionScale >= 0.999 ? [0, 0] : [1 / this._ssil.ssaoWidth, 1 / this._ssil.ssaoHeight]);
        this._shaderManager.setUniform('u_ssrEnabled', ssrLive);
        this._shaderManager.setUniform('u_ssrTexelSize',
            ssr.ssrResolutionScale >= 0.999 ? [0, 0] : [1 / ssr.ssrWidth, 1 / ssr.ssrHeight]);

        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);
    }

    private _setDeferredLighting(scene: Scene): void {
        this._shaderManager.bind('deferredLighting');
        this._uploadSkyLight();
        const grade = this.cloudGrade(scene);
        this.lightGrid.uploadUniforms(this._shaderManager);
        this._shaderManager.setUniform('u_sceneAmbient', this.internalAmbient(scene));
        // Punctual lights are in the grid; only the sun still travels as uniforms.
        let hasDirectional = false;
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            hasDirectional = true;
            this._uploadDirectional(node, grade);
        }

        // The shader applies the directional light whenever its direction is non-zero — there is no
        // count to gate it — so deleting the light means zeroing the direction here.
        if (!hasDirectional) this._clearDirectional();
    }

    // How overcast the sky is, 0..1, from the scene's cloud node. CPU-side and analytic because clouds
    // composite AFTER deferred lighting — the lighting cannot sample them, only be told about them.
    public cloudiness(scene: Scene): number {
        const node = scene.volumetricClouds;
        if (!node || !node.enabled) return 0;
        const shape = node.coverage * (0.7 + 0.6 * node.cloudType);
        return Math.max(0, Math.min(1, shape * Math.min(1, node.density) * node.opacity));
    }

    /**
     * The cloud grade — what an overcast sky does to a scene — applied at UPLOAD time. A cloud layer
     * diffuses: the key light weakens and loses its warm cast while the sky gains strength and loses
     * direction. Must NOT mutate `node.light.diffuse`: the authored colour would not survive a save.
     */
    public cloudGrade(scene: Scene): { sun: number, white: number, sky: number, flat: number } {
        const skyLight = scene.skyLight;
        const c = this.cloudiness(scene) * (skyLight ? skyLight.cloudResponse : 0);
        const bakedSky = this._sys.sky.skySHSource !== null && this._sys.sky.skySHSource === this._sys.sky.cloudSkyFrontCube();
        return {
            sun: 1 - LightingPasses.CLOUD_SUN_DIM * c,
            white: LightingPasses.CLOUD_SUN_WHITEN * c,
            // Once the sky light projects the clouded sky, the clouds are IN the coefficients: grading
            // them as well would apply the overcast twice.
            sky: bakedSky ? 1 : 1 + LightingPasses.CLOUD_SKY_FILL * c,
            flat: bakedSky ? 0 : LightingPasses.CLOUD_SKY_FLATTEN * c,
        };
    }

    /** Fraction of the sun's intensity a fully overcast sky takes away. */
    private static readonly CLOUD_SUN_DIM = 0.78;

    /** How far the sun's colour is pulled toward white at full cloud — its warm cast is scattered out. */
    private static readonly CLOUD_SUN_WHITEN = 0.85;

    /** How much brighter the sky dome gets, having received what the sun lost. */
    private static readonly CLOUD_SKY_FILL = 1.1;

    /** How far the sky collapses toward its own L0 — a uniform dome, which is what overcast IS. */
    private static readonly CLOUD_SKY_FLATTEN = 0.9;

    /** Scratch for the flattened coefficients, so the projected ones are never mutated. */
    private _skySHGraded: Float32Array = new Float32Array(9 * 4);

    /**
     * Push the SUN's uniforms to the currently bound program.
     *
     * The only light that still travels this way. Point and spot lights go into the clustered light
     * grid instead (see `buildLightGrid`), because there is no longer a fixed array for them to have
     * a slot in — which also retired the `u_pointLights[i].<field>` name tables this used to index,
     * and the O(lights x forward shaders x fields) `setUniform` storm that came with them.
     *
     * A directional light has no position, reaches every cluster by definition, and there is exactly
     * one of it, so clustering it would be pure overhead.
     */
    private _uploadDirectional(node: LightNode, grade: { sun: number, white: number }): void {
        const light = node.light as DirectionalLight;
        const key = node === this.keyLightNode ? this.keyLight : null;
        // Graded, not mutated — see `cloudGrade`. The node keeps what the user authored. The
        // grade splits in two: cloud whitening is a COLOUR change and dimming is an INTENSITY
        // change, which is what those two things physically are.
        this._shaderManager.setUniform('u_dirLight.color', this._whitenedSun(key ? key.color : light.color, grade));
        this._shaderManager.setUniform('u_dirLight.intensity', (key ? key.intensity : light.internalIntensity) * grade.sun);
        this._shaderManager.setUniform('u_dirLight.angularRadius', light.angularRadius);
        this._shaderManager.setUniform('u_dirLight.direction', this.dirOf(node));
    }

    /**
     * Decide this frame's key light. Only a SkyAtmosphere that takes its sun from the scene light can
     * turn that light into the moon — with a manual atmosphere sun the two are unrelated, and the light
     * stays exactly as authored.
     */
    public updateKeyLight(scene: Scene): void {
        this.keyLight = null;
        this.keyLightNode = null;
        const atmo = scene.skyAtmosphere;
        if (!atmo || !atmo.useSceneSun) return;
        let node: LightNode | null = null;
        for (const l of scene.lights) if (l.type === 'directional') { node = l; break; }
        if (!node) return;
        const f = node.worldForward;
        const len = Math.hypot(f[0], f[1], f[2]) || 1;
        const toSun = [-f[0] / len, -f[1] / len, -f[2] / len];
        const toMoon = moonDirection(toSun, atmo.moonOffsetYaw, atmo.moonOffsetPitch);
        const light = node.light as DirectionalLight;
        this.keyLight = keyLight(toSun, toMoon, light.color, light.internalIntensity, atmo);
        this.keyLightNode = node;
        vec3.set(this.keyLightDir, this.keyLight.dir[0], this.keyLight.dir[1], this.keyLight.dir[2]);
    }

    /** A directional light's TRAVEL direction as lit this frame: the key light's for the key node. */
    public dirOf(node: LightNode): vec3 {
        return node === this.keyLightNode && this.keyLight ? this.keyLightDir : node.worldForward;
    }

    /**
     * How strongly the key light shines relative to the authored light, 0..1 by day and the moonlight
     * fraction at night. Scales the clouds' own `sunIntensity`, which is authored in cloud units.
     */
    public keyLightScale(): number {
        const node = this.keyLightNode;
        if (!node || !this.keyLight) return 1;
        const authored = (node.light as DirectionalLight).internalIntensity;
        return authored > 0 ? this.keyLight.intensity / authored : 0;
    }

    /**
     * Assign every punctual light in the scene to the clusters it can reach, pack the records, and
     * upload the frame's light data texture.
     *
     * Runs once per frame, after the shadow passes (which are what hand out the atlas slots each
     * record carries) and before anything shades. What it replaced was a `setUniform` per FIELD per
     * light per forward shader, capped at 16 point and 8 spot lights because that was the size of a
     * std140 array.
     *
     * The camera's far plane is not the grid's. An editor camera runs `far = 10000`, which would spend
     * every depth slice on empty space; `clusterDistance` caps it exactly as `_shadows.shadowDistance` caps
     * the cascades.
     */
    public buildLightGrid(scene: Scene): void {
        const camera = this._view.camera;
        const lights = scene.lights;

        // Collect the punctual lights, in the order Scene numbered them — `node.index` IS the record
        // index, so the two loops below must walk the same sequence.
        let count = 0;
        for (const node of lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (count >= MAX_LIGHTS) break;

            let center = this._clusterCenters[count];
            if (!center) { center = new Float32Array(3); this._clusterCenters[count] = center; }

            if (node.type === 'spotlight') {
                const spot = node.light as Spotlight;
                // The CONE's bounding sphere, not the range sphere. A narrow spot fills a fiftieth of
                // the sphere around its own position, and clustering that sphere would light every
                // wall behind the fixture.
                spotBoundingSphere(node.worldPosition, node.worldForward, spot.range,
                                   spot.outerCutOff * Math.PI / 180, this.coneSphere);
                center.set(this.coneSphere.center);
                // A light whose whole reach is hidden keeps its record (its index is fixed) but reaches
                // no cluster: radius 0 is "reaches nothing" to buildClusters.
                const r = this.coneSphere.radius;
                this._setClusterLight(count, center, this._visibility.lightOccluded(node, center, r) ? 0 : r);
            } else {
                const point = node.light as PointLight;
                const p = node.worldPosition;
                center[0] = p[0]; center[1] = p[1]; center[2] = p[2];
                // The windowed falloff reaches EXACTLY zero at `range`, which is what makes this a
                // cull rather than an approximation. See `distanceAttenuation`.
                this._setClusterLight(count, center, this._visibility.lightOccluded(node, center, point.range) ? 0 : point.range);
            }
            count++;
        }
        this._clusterLights.length = count;

        // An ORTHOGRAPHIC camera gets one cluster holding everything, and is the honest answer rather
        // than a silently wrong one. The screen extent of a light is found by the tangent lines from
        // the EYE to its bounding sphere, which is a statement about a perspective projection; under
        // an orthographic one a sphere's extent is its own diameter wherever it sits, and running the
        // perspective solve would put lights in the wrong tiles. An ortho camera is an editor and
        // 2D-scene tool here, where the light counts are small and the acceleration is not missed.
        if (camera.type === 'orthographic') {
            this.lightGrid.buildSingle(count);
        } else {
            this.lightGrid.restoreGrid(DEFAULT_CLUSTER_GRID);
            // The last argument is the Y flip: WebGPU's fragment coordinate runs top-down while
            // `_projection.clipProjection` leaves an ordinary camera's Y alone, so row 0 there is the grid's LAST
            // tile row rather than its first. `clusterTileScaleBias` carries the derivation.
            this.lightGrid.build(this._clusterLights, {
                view: camera.viewMatrix,
                near: camera.near,
                far: Math.min(camera.far, this.clusterDistance),
                fovY: camera.fov * Math.PI / 180,
                aspect: camera.ratio,
            }, this._targets.scene.width, this._targets.scene.height, device.capabilities.conventions.originTopLeft);
        }

        this.packLightRecords(scene);
        this.lightGrid.upload();
    }

    /** Punctual lights the grid will carry: everything but the sun, capped at `MAX_LIGHTS`. */
    public punctualLightCount(scene: Scene): number {
        let n = 0;
        for (const node of scene.lights)
            if (node.type !== 'directional' && node.index >= 0 && n < MAX_LIGHTS) n++;
        return n;
    }

    /** Push the grid's addressing uniforms to every forward program. */
    public uploadLightGridToForwardShaders(): void {
        for (const shaderName of this._forwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this.lightGrid.uploadUniforms(this._shaderManager);
            } catch (_) { /* an unlit program has no cluster block; see BindGroupCache.declaresLightGrid */ }
        }
    }

    /** Set scratch entry `i` without allocating one. */
    private _setClusterLight(i: number, center: Float32Array, radius: number): void {
        const existing = this._clusterLights[i];
        if (existing) { existing.position = center; existing.radius = radius; }
        else this._clusterLights[i] = { position: center, radius };
    }

    /**
     * Write every punctual light's record into the grid's staging buffer.
     *
     * Everything photometric is converted to the engine's internal radiance scale here, and everything
     * derived — the inverse-square range, the cone's scale/offset — is computed once per light rather
     * than once per pixel. That division of labour is unchanged; only its destination is.
     *
     * A POINT LIGHT IS WRITTEN AS A SPOT whose cone covers everything, so the shader runs one loop
     * with no branch on light type. `spotAttenuation` returns exactly 1.0 for that cone, and the two
     * evaluate functions differ by nothing else — see chunks/clusteredLights.wgsl.
     */
    public packLightRecords(scene: Scene): void {
        let i = 0;
        for (const node of scene.lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (i >= MAX_LIGHTS) break;

            if (node.type === 'spotlight') {
                const spot = node.light as Spotlight;
                const [coneScale, coneOffset] = spot.coneScaleOffset;
                this.lightGrid.packRecord(i, node.worldPosition, spot.invRangeSquared,
                                           spot.color, spot.internalIntensity,
                                           node.worldForward, spot.sourceRadius,
                                           coneScale, coneOffset,
                                           this._shadows.spotSlots.layerOf(node.id), NO_SHADOW_SLOT);
            } else {
                const point = node.light as PointLight;
                this.lightGrid.packRecord(i, node.worldPosition, point.invRangeSquared,
                                           point.color, point.internalIntensity,
                                           ShadowPasses.POINT_DIRECTION, point.sourceRadius,
                                           POINT_CONE_SCALE, POINT_CONE_OFFSET,
                                           NO_SHADOW_SLOT, this._shadows.pointSlots.layerOf(node.id));
            }
            i++;
        }
    }

    /** Zero the directional slot on the currently bound program: no light, not a black one. */
    private _clearDirectional(): void {
        this._shaderManager.setUniform('u_dirLight.direction', [0, 0, 0]);
        this._shaderManager.setUniform('u_dirLight.color', [0, 0, 0]);
        this._shaderManager.setUniform('u_dirLight.intensity', 0);
        this._shaderManager.setUniform('u_dirLight.angularRadius', 0);
    }

    /**
     * The scene's indirect fill on the internal radiance scale.
     *
     * NOT cloud-graded, deliberately. The overcast fill the grade describes is already delivered by the
     * sky light, which receives what the sun loses (see _uploadSkyLight and CLOUD_SKY_FILL); applying
     * the same grade here as well would count it twice. This term is the floor for a scene that has
     * no sky light at all.
     *
     * A sky light, when there is one, owns how much of that floor survives: its `ambient` scale and its
     * `nightAmbient` share. Unlike the sky's own projection, the floor does not darken with the sky, so
     * without that a moonless night stays as lit as the shade at noon.
     */
    public internalAmbient(scene: Scene | null): number[] {
        const lux = scene ? scene.ambientLight : [DEFAULT_SCENE_AMBIENT_LUX, DEFAULT_SCENE_AMBIENT_LUX, DEFAULT_SCENE_AMBIENT_LUX];
        const sky = scene?.skyLight ?? null;
        const k = (sky ? sky.ambientScale(this._sunElevation(scene!)) : 1) / REFERENCE_ILLUMINANCE;
        return [lux[0] * k, lux[1] * k, lux[2] * k];
    }

    /**
     * Sine of the sun's elevation as the sky shows it, or null when the scene has no sun. The
     * atmosphere's baked sun when it has one — that is the sky actually drawn, and a manual atmosphere
     * sun need not match any light. Otherwise the first directional light, read off the node itself:
     * `dirOf` hands back the moon at night.
     */
    private _sunElevation(scene: Scene): number | null {
        const atmo = scene.skyAtmosphere;
        if (atmo && atmo.cubemap) return atmo.lastSunDir[1];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            const f = node.worldForward;
            return -f[1] / (Math.hypot(f[0], f[1], f[2]) || 1);
        }
        return null;
    }

    /** A directional light's colour after the cloud grade: whitened, but NOT dimmed — see _uploadDirectional. */
    private _whitenedSun(colour: ArrayLike<number>, grade: { white: number }): number[] {
        const lum = 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
        return [
            colour[0] + (lum - colour[0]) * grade.white,
            colour[1] + (lum - colour[1]) * grade.white,
            colour[2] + (lum - colour[2]) * grade.white,
        ];
    }

    /** Upload the sky-light coefficients to the CURRENTLY BOUND program. */
    private _uploadSkyLight(): void {
        const scene = this._view.scene;
        const node = scene?.skyLight ?? null;
        const on = !!node && this._sys.sky.skySHValid;
        const grade = scene ? this.cloudGrade(scene) : { sun: 1, white: 0, sky: 1, flat: 0 };

        this._shaderManager.setUniform('u_skyLight.enabled', on ? 1 : 0);
        this._shaderManager.setUniform('u_skyLight.intensity', node ? node.intensity * grade.sky : 0);

        let sh = LightingPasses._ZERO_SH;
        if (on) {
            sh = this._sys.sky.skySH;
            if (grade.flat > 0) {
                // Collapse toward L0 ALONE — the sky's mean radiance, a uniform dome. Scaling all nine
                // instead would dim a still-directional sky rather than flattening it.
                const keep = 1 - grade.flat;
                this._skySHGraded.set(this._sys.sky.skySH);
                for (let k = 1; k < 9; k++)
                    for (let ch = 0; ch < 3; ch++) this._skySHGraded[k * 4 + ch] *= keep;
                sh = this._skySHGraded;
            }
        }
        // Uploaded even when off: the block member exists either way, and leaving it unwritten would
        // hand the shader whatever the previous scene's sky was.
        this._shaderManager.setUniform('u_skyLight.sh', sh);
    }

    private static readonly _ZERO_SH: Float32Array = new Float32Array(9 * 4);

    /**
     * Push the sun to every forward program.
     *
     * This used to run once per LIGHT per forward shader, writing five to eight named uniforms each
     * time — the single largest source of `setUniform` traffic in a frame. Punctual lights now reach
     * the shader through one texture upload, so all that is left is the one light there can only be
     * one of.
     */
    public setDirectionalOnForward(node: LightNode): void {
        if (node.type !== 'directional') return;
        const grade = this._view.scene ? this.cloudGrade(this._view.scene)
                                         : { sun: 1, white: 0, sky: 1, flat: 0 };
        for (const shaderName of this._forwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this._uploadDirectional(node, grade);
            } catch (error) {
                // Shader may not have lighting uniforms (e.g., basic shader)
                Logger.print('warn', [`Could not set lighting uniforms for shader ${shaderName}:`, error], 'Renderer');
            }
        }
    }
}
