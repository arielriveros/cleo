import { mat4 } from 'gl-matrix';
import { Camera } from '../../core/camera';
import { authoring } from '../../core/eventBus';
import { Geometry } from '../../core/geometry';
import { Logger } from '../../core/logger';
import { SkyAtmosphereNode, DEFAULT_MOONLIGHT_INTENSITY } from '../../core/scene/nodes/skyAtmosphereNode';
import { SkyboxNode } from '../../core/scene/nodes/skyboxNode';
import { VolumetricCloudsNode } from '../../core/scene/nodes/volumetricCloudsNode';
import { Scene } from '../../core/scene/scene';
import { CubeFramebuffer } from '../cubeFramebuffer';
import { Framebuffer } from '../framebuffer';
import { gl } from '../rhi/webgl2/glContext';
import { Mesh } from '../mesh';
import type { RenderPassEncoder } from '../rhi/device';
import { device } from '../rhi/deviceHandle';
import { DEFAULT_BLEND } from '../rhi/types';
import type { ShaderResource } from '../rhi/types';
import { nightFactor, moonDirection } from '../skyNight';
import { GLState } from '../rhi/webgl2/glState';
import { TextureManager } from '../systems/textureManager';
import { Texture } from '../texture';
import { VolumetricCloudPasses } from './clouds';
import { BRDFProgram, SkyProjectProgram, SkyAtmosphereProgram, SkyFogProgram, SkyboxProgram, VolumetricCloudsProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import { DEPTH_TEST } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import type { LightingPasses } from './lighting';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';

/** What SkyPasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface SkyPassesHost {
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
}

/**
 * Everything the sky contributes: the IBL bake (BRDF LUT, irradiance and prefiltered cubes), the
 * probe refresh, the sky light's spherical harmonics projected from the sky cube, the atmosphere
 * bake, the cloud-sky bake that paints the clouds into a copy of it, the sky draw and the sky fog.
 * Split out of Renderer.
 */
export class SkyPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: SkyPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _clouds: VolumetricCloudPasses,
                private readonly _lighting: LightingPasses,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    // IBL (image-based lighting). Shared BRDF LUT + a cube framebuffer/mesh/camera for baking, plus a
    // scene-wide IBL cache built from scene.environmentMap when no light probe is active.
    public brdfFBO!: Framebuffer;
    public cubeFBO!: CubeFramebuffer;
    public iblCubeMesh!: Mesh;
    public captureCamera!: Camera;
    private _captureProj: mat4 = mat4.create();
    private _iblFaceViews: mat4[] = [];

    // Standard cube-map capture directions (dir, up) in the OpenGL convention.
    public static readonly CUBE_FACES: { dir: [number, number, number], up: [number, number, number] }[] = [
        { dir: [ 1,  0,  0], up: [0, -1,  0] }, // +X
        { dir: [-1,  0,  0], up: [0, -1,  0] }, // -X
        { dir: [ 0,  1,  0], up: [0,  0,  1] }, // +Y
        { dir: [ 0, -1,  0], up: [0,  0, -1] }, // -Y
        { dir: [ 0,  0,  1], up: [0, -1,  0] }, // +Z
        { dir: [ 0,  0, -1], up: [0, -1,  0] }, // -Z
    ];

    public static readonly IRRADIANCE_SIZE = 32;
    public static readonly PREFILTER_SIZE = 128;
    public static readonly PREFILTER_MIPS = 5;
    private static readonly BRDF_LUT_SIZE = 512;

    // Previous frame's view-projection, used by the camera-reprojection motion blur pass.
    // --- Sky light -----------------------------------------------------------------------------
    // Nine L2 spherical-harmonic coefficients, rgb each, padded to vec4 for WGSL's 16-byte uniform
    // array stride. Derived from an equirect unwrap of the scene's sky cubemap.
    public skySH: Float32Array = new Float32Array(9 * 4);
    public skySHValid: boolean = false;

    /** One readback in flight at a time; the sky can re-bake while the previous projection resolves. */
    private _skyProjectionPending: boolean = false;

    /** Set by every sky re-bake; `updateSkyLight` turns it into a throttled re-projection. */
    private _skyLightReprojectPending = false;
    private _skyLightReprojectAt = -Infinity;

    /** The CLEAR (cloud-free) atmosphere's coefficients, which the clouds' own ambient is lit by. */
    public clearSkySH: Float32Array = new Float32Array(9 * 4);
    public clearSkySHValid = false;
    private _clearSkySource: Texture | null = null;
    private _clearSkyStale = true;

    /** The cube the current coefficients came from, so a sky swap re-derives even with the sun still. */
    public skySHSource: Texture | null = null;
    public skyProjectFBO!: Framebuffer;

    /** Equirect unwrap size. 512 texels is ample for an L2 fit and keeps the readback trivial. */
    private static readonly SKY_PROJECT_W = 32;
    private static readonly SKY_PROJECT_H = 16;

    /** Must match RGBM_RANGE in skyProject.wgsl. */
    private static readonly SKY_RGBM_RANGE = 64.0;

    // One-time IBL setup: cube capture camera/mesh/framebuffer, per-face view matrices, and the
    // shared BRDF integration LUT.
    public initializeIBL(): void {
        // 90-degree perspective for cube-face rendering (camera sits inside the unit cube).
        mat4.perspective(this._captureProj, Math.PI / 2, 1, 0.1, 10);
        // Flip Y on WebGPU: framebuffer row 0 is the BOTTOM on WebGL2 and the TOP on WebGPU. UV-sampled
        // targets survive that (the screen quad undoes it at present); a CUBEMAP, sampled by
        // direction, does not.
        if (device.backend === 'webgpu') this._captureProj[5] *= -1;
        for (const f of SkyPasses.CUBE_FACES) {
            const view = mat4.create();
            mat4.lookAt(view, [0, 0, 0], f.dir, f.up);
            this._iblFaceViews.push(view);
        }

        const cubeGeo = Geometry.Cube();
        this.iblCubeMesh = new Mesh();
        this.iblCubeMesh.create(cubeGeo.getData(['position']), cubeGeo.indices.length, cubeGeo.indices);

        this.cubeFBO = new CubeFramebuffer();
        this.captureCamera = new Camera({ type: 'perspective', fov: 90, near: 0.05, far: 2000 });

        this.brdfFBO.create(SkyPasses.BRDF_LUT_SIZE, SkyPasses.BRDF_LUT_SIZE);
        this._renderBRDFLUT();

        // A 1x1 complete cubemap for any IBL slot a frame does not fill. A bind group cannot express
        // "nothing", and an unset sampler aliases the 2D G-buffer sampler on unit 0.
        // `target: 'cubemap'` is NOT optional: without it this is a 2D texture, which is the exact
        // aliasing it exists to prevent. `allocateCube` throws on the mismatch.
        this._bindGroups.fallbackCube = new Texture({ target: 'cubemap', mipMap: false });
        this._bindGroups.fallbackCube.createCubemapTarget(1, 1);

        // White rather than black: a material with no base colour map multiplies by this, and black
        // would render every untextured object invisible rather than merely unmapped.
        this._bindGroups.fallbackTexture = new Texture({ mipMap: false });
        this._bindGroups.fallbackTexture.createFromData(new Uint8Array([255, 255, 255, 255]), 1, 1);
    }

    private _renderBRDFLUT(): void {
        // No bind groups at all: the LUT is pure computation from the fragment coordinate.
        const pass = this._passes.beginFullscreenPass(this.brdfFBO.renderTarget, 'brdf', true, [0, 0, 0, 1]);
        pass.setPipeline(this._pipelines.fullscreen('brdf', BRDFProgram));
        this._passes.drawFullscreenAndEnd(pass);
    }

    // Render a convolution shader (irradiance/prefilter) into all 6 faces of `target` at a mip level.
    public convolveCubeFaces(shaderName: string, reflection: { resources: readonly ShaderResource[] },
                               sourceCube: Texture, target: Texture, mip: number, size: number,
                               perFace?: () => void): void {
        // One pass PER FACE, because a face is a different render target — the cube framebuffer
        // re-points its colour attachment at each one, and `createRenderTarget` dedupes them so six
        // faces cost six cached framebuffers rather than six per bake.
        this._shaderManager.bind(shaderName);
        // One pipeline across six faces, so it must be TOLD its target: otherwise `_pipelines.get` falls
        // back to `_passes.target` — whatever the previous pass left — and derives the wrong colour format,
        // which WebGPU rejects. Face 0's target stands for all six, and `createRenderTarget` dedupes.
        const faceTarget = this.cubeFBO.targetFor(target, 0, mip, false, size);
        const pipeline = this._pipelines.get(shaderName, reflection, { cullMode: 'none', vertex: 'model',
                                                                    // The unit cube carries position
                                                                    // only; see initializeIBL.
                                                                    builtFor: 'irradiance',
                                                                    target: faceTarget });
        this._shaderManager.setUniform('u_projection', this._projection.clipProjection(this._captureProj));
        if (perFace) perFace();
        for (let face = 0; face < 6; face++) {
            const pass = this._passes.beginFullscreenPass(
                this.cubeFBO.targetFor(target, face, mip, false, size),
                'iblConvolve', true, [0, 0, 0, 1], false);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [sourceCube]));
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            this._passes.recordDraw(pass, this.iblCubeMesh, 0, 0);
            this._passes.endFullscreenPass(pass);
        }
    }

    /**
     * The cubemap the sky light derives from: the baked atmosphere, else a user skybox, else the scene
     * environment map. Returns the cube and whether it is already linear HDR.
     */
    private _skySource(scene: Scene): { cube: Texture, linear: boolean } | null {
        const atmo = scene.skyAtmosphere;
        // The clouded sky while it is what the scene draws: overcast ambient then comes from the real
        // clouds, not from the analytic grade.
        const clouded = this.cloudSkyActive(scene) ? this.cloudSkyFrontCube() : null;
        if (clouded) return { cube: clouded, linear: true };
        if (atmo?.cubemap) return { cube: atmo.cubemap, linear: true };
        const skybox = scene.skybox as SkyboxNode | null;
        if (skybox) {
            if (!skybox.initialized) skybox.initializeSkybox();
            if (skybox.skybox.texture) return { cube: skybox.skybox.texture, linear: false };
        }
        if (scene.environmentMap) return { cube: scene.environmentMap, linear: false };
        return null;
    }

    // Re-derive the sky light's spherical harmonics when the sky changes. Rides the sky's own re-bake
    // cadence rather than testing the sun again — two tests of one thing eventually disagree.
    // The readback is async, so the coefficients land a frame or two late; nothing here blocks.
    public updateSkyLight(scene: Scene): void {
        if (this._view.capturing) return;
        const node = scene.skyLight;
        if (!node) {
            // Leaving the coefficients behind would keep lighting a scene whose sky light was deleted.
            this.skySHValid = false;
            this.skySHSource = null;
            return;
        }

        const source = this._skySource(scene);
        if (!source) { this.skySHValid = false; this.skySHSource = null; return; }
        if (this._skyProjectionPending) return;

        // A sky re-bake asks for a re-projection; at most once a second, since each one is a readback.
        // Kept pending rather than dropped, so the LAST position of a moving sun is always projected.
        if (this._skyLightReprojectPending) {
            const now = performance.now();
            if (now - this._skyLightReprojectAt >= 1000) {
                node.markDirty();
                this._skyLightReprojectPending = false;
                this._skyLightReprojectAt = now;
            }
        }

        const atmo = scene.skyAtmosphere;
        const atmoCube = atmo?.cubemap ?? null;
        // A night sky is orders of magnitude darker than a day one; scale it up for the 8-bit readback.
        const projectScale = atmo ? 1 + 15 * nightFactor(atmo.lastSunDir[1]) : 1;
        // The clear sky's coefficients are what the CLOUDS are lit by. While the scene's come from the
        // clouded sky, they are projected on their own, so the clouds never light themselves.
        if (atmoCube && source.cube !== atmoCube && (this._clearSkyStale || this._clearSkySource !== atmoCube)) {
            this._clearSkyStale = false;
            this._clearSkySource = atmoCube;
            this._skyProjectionPending = true;
            void this._projectSkyLight(atmoCube, true, [1, 1, 1], 'clear', projectScale)
                .catch((e) => Logger.warn(`Sky light projection failed: ${(e && e.message) || e}`, 'Runtime'))
                .then(() => { this._skyProjectionPending = false; });
            return;
        }

        const stale = node.needsProjection || !this.skySHValid || this.skySHSource !== source.cube;
        if (!stale) return;

        this._skyProjectionPending = true;
        node.markProjected();
        this.skySHSource = source.cube;
        if (source.cube === atmoCube) { this._clearSkyStale = false; this._clearSkySource = atmoCube; }
        void this._projectSkyLight(source.cube, source.linear, node.tint,
                                   source.cube === atmoCube ? 'both' : 'scene', projectScale)
            // NAMED, not swallowed. A failed projection leaves the scene lit by nothing but the flat
            // ambient, which looks exactly like a dark sky — the one failure mode that hides itself.
            .catch((e) => Logger.warn(`Sky light projection failed: ${(e && e.message) || e}`, 'Runtime'))
            .then(() => { this._skyProjectionPending = false; });
    }

    /** Unwrap, read back, project. Split out only so `updateSkyLight` itself stays synchronous. */
    private async _projectSkyLight(cube: Texture, linear: boolean, tint: [number, number, number],
                                   target: 'scene' | 'clear' | 'both' = 'scene', scale = 1): Promise<void> {
        const w = SkyPasses.SKY_PROJECT_W, h = SkyPasses.SKY_PROJECT_H;
        if (this.skyProjectFBO.width !== w || this.skyProjectFBO.height !== h)
            this.skyProjectFBO.create(w, h);

        const pass = this._passes.beginFullscreenPass(this.skyProjectFBO.renderTarget, 'skyProject', false);
        this._fullscreen.bind(pass, 'skyProject', SkyProjectProgram, [cube]);
        this._shaderManager.bind('skyProject');
        this._shaderManager.setUniform('u_linearInput', linear ? 1 : 0);
        this._shaderManager.setUniform('u_projectScale', scale);
        this._passes.drawFullscreenAndEnd(pass);

        // Restored before the await, for the same reason `renderProbePreview` does it: a game-loop
        // frame that lands while this is suspended must find the live viewport, not the 32x16 one.
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);

        // SUBMIT BEFORE READING — the one place in the frame that must. `readPixels` copies on its own
        // encoder and submits immediately, so without this it runs ahead of the pass above and reads a
        // target nothing has written.
        this._passes.flushFrameEncoder(true);

        const pixels = await device.readPixels(this.skyProjectFBO.colors[0].attachmentView, 0, 0, w, h);
        const k = 1 / scale;
        if (target !== 'clear') {
            this.skySH.set(SkyPasses._projectEquirectToSH(pixels, w, h, [tint[0] * k, tint[1] * k, tint[2] * k]));
            this.skySHValid = true;
        }
        if (target !== 'scene') {
            // Untinted: the sky light's tint is an artistic grade on the SCENE's ambient, not the sky.
            this.clearSkySH.set(SkyPasses._projectEquirectToSH(pixels, w, h, [k, k, k]));
            this.clearSkySHValid = true;
        }
    }

    // Project an RGBM equirect map onto L2 spherical harmonics. Row 0 is the south pole on BOTH
    // backends, so no per-backend flip. The `cos(lat)` weight is the solid angle a texel subtends —
    // without it the oversampled poles dominate the integral.
    private static _projectEquirectToSH(pixels: Uint8Array, w: number, h: number,
                                        tint: [number, number, number]): Float32Array {
        const sh = new Float32Array(9 * 4);
        let weightSum = 0;
        for (let row = 0; row < h; row++) {
            const v = (row + 0.5) / h;
            const lat = (v - 0.5) * Math.PI;
            const cosLat = Math.cos(lat);
            const sinLat = Math.sin(lat);
            for (let col = 0; col < w; col++) {
                const u = (col + 0.5) / w;
                const lon = (u - 0.5) * 2 * Math.PI;
                const x = cosLat * Math.sin(lon);
                const y = sinLat;
                const z = -cosLat * Math.cos(lon);

                const i = (row * w + col) * 4;
                const m = pixels[i + 3] / 255 * SkyPasses.SKY_RGBM_RANGE;
                const r = (pixels[i] / 255) * m * tint[0];
                const g = (pixels[i + 1] / 255) * m * tint[1];
                const b = (pixels[i + 2] / 255) * m * tint[2];

                const weight = cosLat;
                weightSum += weight;

                // Real SH basis, l = 0..2, in the order chunks/pbrLighting.wgsl evaluates them.
                const basis = [
                    0.282095,
                    0.488603 * y, 0.488603 * z, 0.488603 * x,
                    1.092548 * x * y, 1.092548 * y * z,
                    0.315392 * (3 * z * z - 1),
                    1.092548 * x * z, 0.546274 * (x * x - y * y),
                ];
                for (let k = 0; k < 9; k++) {
                    const c = basis[k] * weight;
                    sh[k * 4] += r * c;
                    sh[k * 4 + 1] += g * c;
                    sh[k * 4 + 2] += b * c;
                }
            }
        }
        // 4*PI is the sphere's solid angle and the weight sum is its discrete counterpart, so this turns
        // the Riemann sum into the integral the coefficients are defined as.
        const norm = weightSum > 0 ? (4 * Math.PI) / weightSum : 0;
        for (let k = 0; k < 9 * 4; k++) sh[k] *= norm;
        return sh;
    }

    // Bake any light probe flagged for baking or due for a realtime refresh. IBL applies only where
    // the user has placed a probe; a scene without one keeps flat ambient plus the crude env map.
    public updateIBL(scene: Scene): void {
        if (this._view.capturing) return;

        const now = performance.now();
        for (const probe of scene.lightProbes) {
            const due = probe.mode === 'realtime' && (now - probe.lastBakeTime) >= probe.updateFrequency * 1000;
            if (probe.needsBake || due) {
                this._sys.capture.captureProbe(scene, probe);
                probe.markBaked(now);
            }
        }
    }

    // Direction TOWARD the sun for a SkyAtmosphere node: the scene directional light (negated travel
    // direction) when useSceneSun, else the node's manual override. Always normalized.
    public atmosphereSunDir(scene: Scene, node: SkyAtmosphereNode): [number, number, number] {
        let s: [number, number, number] = [node.sunDirection[0], node.sunDirection[1], node.sunDirection[2]];
        if (node.useSceneSun) {
            for (const light of scene.lights) {
                if (light.type === 'directional') {
                    const f = light.worldForward; // light travels along +forward, so the sun is at -forward
                    s = [-f[0], -f[1], -f[2]];
                    break;
                }
            }
        }
        const len = Math.hypot(s[0], s[1], s[2]) || 1;
        return [s[0] / len, s[1] / len, s[2] / len];
    }

    /**
     * Sun direction + screen-space UV + visibility fade for the scene's sun: the first directional
     * light (negated travel direction), else the SkyAtmosphere sun. `visible` is 0 when there is no
     * sun or it is behind the camera, fading to 0 as it leaves the viewport. Shared by the god-rays
     * pass and the camera's screen-space material passes (u_sunDir/u_sunUV/u_sunVisible).
     */
    public sunScreenInfo(scene: Scene): { dir: [number, number, number], uv: [number, number], visible: number } {
        let dir: [number, number, number] | null = null;
        for (const light of scene.lights) {
            if (light.type === 'directional') {
                const f = this._lighting.dirOf(light); // light travels along +forward, so the sun is at -forward
                dir = [-f[0], -f[1], -f[2]];
                break;
            }
        }
        if (!dir && scene.skyAtmosphere) dir = this.atmosphereSunDir(scene, scene.skyAtmosphere);
        if (!dir) return { dir: [0, 0, 0], uv: [0, 0], visible: 0 };
        const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        dir = [dir[0] / len, dir[1] / len, dir[2] / len];

        // Project the sun as a point at infinity: clip = viewProj * vec4(dirTowardSun, 0).
        const m = this._view.viewProj;
        const clipX = m[0] * dir[0] + m[4] * dir[1] + m[8] * dir[2];
        const clipY = m[1] * dir[0] + m[5] * dir[1] + m[9] * dir[2];
        const clipW = m[3] * dir[0] + m[7] * dir[1] + m[11] * dir[2];
        if (clipW <= 0.0) return { dir, uv: [0, 0], visible: 0 }; // sun is behind the camera
        const uv: [number, number] = [(clipX / clipW) * 0.5 + 0.5, (clipY / clipW) * 0.5 + 0.5];
        const dx = Math.max(0, Math.max(-uv[0], uv[0] - 1));
        const dy = Math.max(0, Math.max(-uv[1], uv[1] - 1));
        const visible = Math.max(0, 1 - Math.hypot(dx, dy) / 0.5);
        return { dir, uv, visible };
    }

    // Re-bake the SkyAtmosphere cubemap when needed: on first use / parameter change (needsBake) or
    // when the sun direction has moved past a small epsilon. No-op when no atmosphere node exists.
    public updateSkyAtmosphere(scene: Scene): void {
        if (this._view.capturing) return;
        const node = scene.skyAtmosphere;
        if (!node) return;

        const sun = this.atmosphereSunDir(scene, node);
        const last = node.lastSunDir;
        const dot = sun[0] * last[0] + sun[1] * last[1] + sun[2] * last[2];
        const SUN_EPS = Math.cos(0.3 * Math.PI / 180); // re-bake once the sun rotates ~0.3 degrees
        if (this._skyTexturesPending
            && (!node.nightSkyTexture || TextureManager.Instance.getTexture(node.nightSkyTexture))
            && (!node.moonTexture || TextureManager.Instance.getTexture(node.moonTexture))) node.markDirty();
        if (node.needsBake || dot < SUN_EPS)
            this._bakeSkyAtmosphere(node, sun);
    }

    // Bake the Nishita single-scattering atmosphere into the node's cubemap (6 faces via the IBL cube
    // machinery: _captureProj + _iblFaceViews + iblCubeMesh + cubeFBO). Stores a display-referred
    // (tonemapped) cubemap so the existing 'skybox' draw can sample it unchanged.
    private _bakeSkyAtmosphere(node: SkyAtmosphereNode, sun: [number, number, number]): void {
        const res = node.resolution;
        if (!node.cubemap || node.cubemapResolution !== res) {
            const levels = Math.floor(Math.log2(res)) + 1;
            const cube = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
            cube.createCubemapTarget(res, levels);
            node.setCubemap(cube, res);
        }
        const cube = node.cubemap!;
        this._renderAtmosphereFaces(node, sun, cube, res, SkyPasses._ALL_FACES);
        this._passes.generateMipsAfterRender(cube);
        node.markBaked(sun);
        // The sky light follows the sky. Nothing used to tell it to, so ambient froze at the first sun
        // position; the re-projection is throttled because it is a readback.
        this._skyLightReprojectPending = true;
        this._clearSkyStale = true;
    }

    private static readonly _ALL_FACES: readonly number[] = [0, 1, 2, 3, 4, 5];

    /** The last atmosphere bake named a night-sky or moon texture the manager did not have yet. */
    private _skyTexturesPending = false;

    /**
     * Render the atmosphere — the day sky and, after sunset, the night sky (stars or a custom texture,
     * airglow, the moon and the moonlit sky) — into `faces` of `cube`, `res` texels square. Shared by the
     * atmosphere's own bake and the cloud-sky bake, which paints the clouds over a fresh copy of it.
     */
    private _renderAtmosphereFaces(node: SkyAtmosphereNode, sun: ArrayLike<number>, cube: Texture, res: number,
                                   faces: readonly number[]): void {
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(false);
        GLState.cull(false);

        this._shaderManager.bind('skyAtmosphere');
        // One pipeline for all six faces. `builtFor: 'irradiance'` — the unit cube's stride comes from
        // THAT program, not the drawing one. `target` explicitly: built before any pass opens.
        const skyPipeline = this._pipelines.get('skyAtmosphere', SkyAtmosphereProgram,
                                              { cullMode: 'none', vertex: 'model',
                                                builtFor: 'irradiance',
                                                target: this.cubeFBO.targetFor(cube, faces[0] ?? 0, 0, false) });
        this._shaderManager.setUniform('u_projection', this._projection.clipProjection(this._captureProj));
        this._shaderManager.setUniform('u_sunDir', sun);
        this._shaderManager.setUniform('u_sunColor', node.sunColor);
        this._shaderManager.setUniform('u_sunIntensity', node.sunIntensity);
        // Earth Rayleigh scattering coefficients (per metre), scaled by the user multiplier.
        const rs = node.rayleighScatter;
        this._shaderManager.setUniform('u_rayleigh', [5.8e-6 * rs, 13.5e-6 * rs, 33.1e-6 * rs]);
        this._shaderManager.setUniform('u_mie', 21e-6 * node.mieScatter);
        this._shaderManager.setUniform('u_rayleighHeight', node.rayleighHeight);
        this._shaderManager.setUniform('u_mieHeight', node.mieHeight);
        this._shaderManager.setUniform('u_mieG', node.mieG);
        this._shaderManager.setUniform('u_planetRadius', node.planetRadius);
        this._shaderManager.setUniform('u_atmosphereRadius', node.atmosphereRadius);
        this._shaderManager.setUniform('u_sunDiskSize', node.sunDiskSize);
        this._shaderManager.setUniform('u_exposure', node.exposure);
        this._shaderManager.setUniform('u_groundColor', node.groundColor);
        this._shaderManager.setUniform('u_viewSteps', node.viewSteps);
        this._shaderManager.setUniform('u_lightSteps', node.lightSteps);

        // Night sky. `u_night` is 0 by day, which is what keeps a day bake from paying for any of it.
        const DEG = Math.PI / 180;
        const nightTex = node.nightSkyTexture ? TextureManager.Instance.getTexture(node.nightSkyTexture) : null;
        const moonTex = node.moonTexture ? TextureManager.Instance.getTexture(node.moonTexture) : null;
        this._shaderManager.setUniform('u_night', node.nightEnabled ? nightFactor(sun[1]) : 0);
        this._shaderManager.setUniform('u_moonDir', moonDirection(sun, node.moonOffsetYaw, node.moonOffsetPitch));
        this._shaderManager.setUniform('u_moonColor', node.moonColor);
        this._shaderManager.setUniform('u_airglowColor', node.airglowColor);
        this._shaderManager.setUniform('u_starIntensity', node.starIntensity);
        this._shaderManager.setUniform('u_starDensity', node.starDensity);
        this._shaderManager.setUniform('u_starColorVariance', node.starColorVariance);
        this._shaderManager.setUniform('u_nightSkyIntensity', node.nightSkyIntensity);
        this._shaderManager.setUniform('u_nightSkyRotation', node.nightSkyRotation * DEG);
        this._shaderManager.setUniform('u_moonSize', node.moonSize * DEG);
        this._shaderManager.setUniform('u_moonPhase', node.moonPhase);
        this._shaderManager.setUniform('u_moonIntensity', node.moonIntensity);
        this._shaderManager.setUniform('u_airglowIntensity', node.airglowIntensity);
        this._shaderManager.setUniform('u_nightTexture', !!nightTex);
        this._shaderManager.setUniform('u_moonTexture', !!moonTex);
        this._shaderManager.setUniform('u_moonEnabled', node.moonEnabled);
        this._shaderManager.setUniform('u_nightScale', node.moonlightIntensity / DEFAULT_MOONLIGHT_INTENSITY);
        const nightGroup = this._bindGroups.textureGroup(skyPipeline, 2, [nightTex ?? this._bindGroups.fallbackTexture,
                                                                    moonTex ?? this._bindGroups.fallbackTexture]);
        // A texture still loading bakes the procedural fallback; remember to bake again once it is in.
        this._skyTexturesPending = (!!node.nightSkyTexture && !nightTex) || (!!node.moonTexture && !moonTex);

        this._passes.setViewport(res, res);
        for (const face of faces) {
            // A pass per face, like `convolveCubeFaces`: a face is a different render target.
            const pass = this._passes.beginFullscreenPass(this.cubeFBO.targetFor(cube, face, 0, false),
                                                   'skyAtmosphereBake', true, [0, 0, 0, 1], false);
            pass.setPipeline(skyPipeline);
            pass.setBindGroup(2, nightGroup);
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            this._passes.recordDraw(pass, this.iblCubeMesh, 0, 0);
            this._passes.endFullscreenPass(pass);
        }
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        GLState.depthMask(true);
        GLState.depthTest(true);
    }

    // Height fog for the SkyAtmosphere node: a fullscreen pass that integrates the fog along each view
    // ray and tints toward the atmosphere's horizon colour (see skyFog.wgsl), over the opaque scene and
    // the sky's horizon band. Reads the scene-depth snapshot, not the G-buffer, so forward Blinn-Phong
    // opaques fog at their own depth too.
    public renderSkyFog(scene: Scene): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.fogEnabled || !node.cubemap || node.fogMaxOpacity <= 0 || node.fogDensity <= 0) return;

        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'skyFog', false);
        this._fullscreen.bind(pass, 'skyFog', SkyFogProgram, [this._targets.sceneDepth.depth, node.cubemap], DEFAULT_BLEND);

        this._shaderManager.bind('skyFog');
        // The CLEAN atmosphere, never the cloud-baked sky: fog is the colour of the air at the horizon, and
        // sampling clouds into it painted them onto every fogged hillside.
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        this._shaderManager.setUniform('u_fogDensity', node.fogDensity);
        this._shaderManager.setUniform('u_fogStart', node.fogStart);
        this._shaderManager.setUniform('u_fogHeight', node.fogHeight);
        this._shaderManager.setUniform('u_fogHeightFalloff', node.fogHeightFalloff);
        this._shaderManager.setUniform('u_fogMaxOpacity', node.fogMaxOpacity);
        this._shaderManager.setUniform('u_fogColor', node.fogColor);
        this._shaderManager.setUniform('u_fogColorBlend', node.fogColorBlend);
        // Sample the atmosphere well up the mip chain so fog is a smooth colour haze (no crisp sun disk
        // or sky detail in it). ~8px-per-face target regardless of the baked cubemap resolution.
        const res = node.cubemapResolution || node.resolution;
        this._shaderManager.setUniform('u_fogSkyLod', Math.max(0, Math.log2(res) - 3));
        this._passes.drawFullscreenAndEnd(pass);

        // Restore the state the following overlay passes expect.
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Draw a sky cube — a baked atmosphere cubemap or a user skybox — into `pass`.
     *
     * Depth WRITES off, test on: the cube renders at NDC z = w, and interpolation error would put
     * some pixels a hair below 1.0 for every depth-reading pass downstream. Culling off — the cube is
     * viewed from inside. Both meshes carry position only, so both use `builtFor: 'skybox'` (12 bytes).
     */
    private _drawSky(pass: RenderPassEncoder, cubemap: Texture, mesh: Mesh,
                     view: mat4, proj: mat4, linearInput: boolean): void {
        const pipeline = this._pipelines.get('skybox', SkyboxProgram, {
            cullMode: 'none',
            depthStencil: DEPTH_TEST,
            vertex: 'model',
            builtFor: 'skybox',
        });
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_view', view);
        // Jittered like every other pass that lands in the TAA input — the sky is where the horizon
        // aliases hardest. The probe/IBL callers are neutralised inside `_projection.rasterProjection` by the
        // cube-face and capture guards rather than by picking call sites.
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(proj));
        this._shaderManager.setUniform('u_linearInput', linearInput);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [cubemap]));
        this._passes.recordDraw(pass, mesh, 0, 0);
    }

    /**
     * The sky for one camera view, whichever kind the scene has. Returns false when there is none.
     * The perspective override is mandatory: an orthographic projection has no valid sky direction.
     */
    public renderSky(pass: RenderPassEncoder, scene: Scene, camera: Camera): boolean {
        const prevType = camera.type;
        camera.type = 'perspective';
        const proj = camera.projectionMatrix;
        camera.type = prevType;

        const atmo = scene.skyAtmosphere;
        const sky = this._atmosphereSkyCube(scene);
        if (atmo && sky) {
            // A baked atmosphere cube is linear HDR; a user cubemap is sRGB-authored.
            this._drawSky(pass, sky, this.iblCubeMesh, camera.viewMatrix, proj, true);
            return true;
        }
        if (scene.skybox) {
            const node = scene.skybox as SkyboxNode;
            if (!node.initialized) node.initializeSkybox();
            this._drawSky(pass, node.skybox.texture, node.skybox.mesh, camera.viewMatrix, proj, false);
            return true;
        }
        return false;
    }

    // ---- Cloud sky bake ----------------------------------------------------------------------------
    // With `bakeIntoSky`, play mode (and a published game) does not raymarch the clouds every frame:
    // they are painted once over a copy of the atmosphere, into a cubemap that is then drawn, fogged
    // with and projected into the sky light exactly like the atmosphere's own. The bake is redone at
    // load rather than saved, so it costs the project nothing; a moving sun re-bakes it a face a frame.

    /** Front/back cubes, so the sky keeps drawing the old bake while the next one fills in. */
    private _cloudSkyCubes: (Texture | null)[] = [null, null];
    private _cloudSkyRes: number[] = [0, 0];
    private _cloudSkyFront = -1;

    /** The bake in progress: target cube, next face, and the sun, clock and eye it is made with. */
    private _cloudSkyBake: {
        cube: number; face: number; perFrame: number;
        sun: [number, number, number]; time: number; eye: [number, number, number]; signature: string;
    } | null = null;

    private _cloudSkyWait = 0;
    private readonly _cloudFaceView: mat4 = mat4.create();
    private readonly _cloudFaceInv: mat4 = mat4.create();

    /** `_captureProj` before its WebGPU Y flip: what a cloud-sky face's rays are rebuilt through. */
    private static readonly _CLOUD_FACE_PROJ: mat4 = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 10);

    /** How far (degrees) the sun may move in play before `autoRebake` starts a new bake. */
    private static readonly CLOUD_SKY_AUTO_DEGREES = 2;

    public cloudSkyFrontCube(): Texture | null {
        return this._cloudSkyFront >= 0 ? this._cloudSkyCubes[this._cloudSkyFront] : null;
    }

    /** True while the scene's sky — and so its clouds — is drawn from the cloud-sky bake. */
    public cloudSkyActive(scene: Scene): boolean {
        const node = scene.volumetricClouds;
        if (!node || !node.enabled || !node.bakeIntoSky || !scene.skyAtmosphere?.cubemap) return false;
        if (this._cloudSkyFront < 0) return false;
        // `authoring` is off in play, in Simulate and in a published player.
        return !authoring.enabled || node.previewBake;
    }

    /** The atmosphere cube to draw, fog with and project: the clouded one while the bake is active. */
    private _atmosphereSkyCube(scene: Scene): Texture | null {
        return this.cloudSkyActive(scene) ? this.cloudSkyFrontCube() : (scene.skyAtmosphere?.cubemap ?? null);
    }

    private _releaseCloudSky(): void {
        for (const cube of this._cloudSkyCubes) cube?.delete();
        this._cloudSkyCubes = [null, null];
        this._cloudSkyRes = [0, 0];
        this._cloudSkyFront = -1;
        this._cloudSkyBake = null;
    }

    /** Start, continue or finish the cloud-sky bake. Runs after the atmosphere bake, before the sky light. */
    public updateCloudSky(scene: Scene): void {
        if (this._view.capturing || this._host.thumbnailMode) return;
        const node = scene.volumetricClouds;
        const atmo = scene.skyAtmosphere;
        if (!node || !atmo || !atmo.cubemap || !node.bakeIntoSky) {
            if (this._cloudSkyCubes[0] || this._cloudSkyCubes[1]) this._releaseCloudSky();
            return;
        }
        if (!node.enabled) { this._cloudSkyBake = null; return; }
        const sun = atmo.lastSunDir;

        if (!this._cloudSkyBake) {
            const fresh = this._cloudSkyFront < 0;
            const play = !authoring.enabled;
            const requested = node.bakeRequested;
            let start = requested || (fresh && (play || node.previewBake));
            const baked = node.bakedSunDir;
            if (!start && play && node.autoRebake && baked) {
                const dot = sun[0] * baked[0] + sun[1] * baked[1] + sun[2] * baked[2];
                start = dot < Math.cos(SkyPasses.CLOUD_SKY_AUTO_DEGREES * Math.PI / 180);
            }
            if (!start) return;
            // The clouds are lit by the CLEAR sky's coefficients, which arrive by async readback. Give
            // the first projection a few frames to land rather than baking flat-lit clouds.
            if (scene.skyLight && node.useSkyAmbient && !this.clearSkySHValid && this._cloudSkyWait++ < 30) return;
            this._cloudSkyWait = 0;
            node.takeBakeRequest();

            const cube = this._cloudSkyFront === 0 ? 1 : 0;
            const res = node.bakeResolution;
            if (!this._cloudSkyCubes[cube] || this._cloudSkyRes[cube] !== res) {
                this._cloudSkyCubes[cube]?.delete();
                const made = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
                made.createCubemapTarget(res, Math.floor(Math.log2(res)) + 1);
                this._cloudSkyCubes[cube] = made;
                this._cloudSkyRes[cube] = res;
            }
            const e = this._view.camera.position;
            this._cloudSkyBake = {
                cube, face: 0,
                // All six at once when there is nothing to show yet or someone pressed Regenerate (the
                // loading overlay or the click covers the hitch); a moving sun gets a face a frame.
                perFrame: fresh || requested ? 6 : 1,
                sun: [sun[0], sun[1], sun[2]], time: performance.now() * 0.001,
                eye: [e[0], e[1], e[2]], signature: node.bakeSignature(),
            };
        }

        const bake = this._cloudSkyBake;
        const faces: number[] = [];
        while (faces.length < bake.perFrame && bake.face < 6) faces.push(bake.face++);
        this._bakeCloudSkyFaces(scene, node, atmo, faces);
        if (bake.face < 6) return;

        this._passes.generateMipsAfterRender(this._cloudSkyCubes[bake.cube]!);
        this._cloudSkyFront = bake.cube;
        node.markBaked(bake.sun, bake.time, bake.signature);
        this._cloudSkyBake = null;
        this._skyLightReprojectPending = true;
    }

    /**
     * Paint `faces` of the bake's cube: the atmosphere first, then the cloud raymarch over it, seen
     * from the bake's eye through each face. No depth bound (nothing occludes a sky face), no temporal
     * reconstruction and no dither (either would freeze into the texture as grain and face seams), and
     * a step floor above the live pass, since this is paid once.
     */
    private _bakeCloudSkyFaces(scene: Scene, node: VolumetricCloudsNode, atmo: SkyAtmosphereNode,
                               faces: readonly number[]): void {
        const bake = this._cloudSkyBake!;
        const cube = this._cloudSkyCubes[bake.cube]!;
        const res = this._cloudSkyRes[bake.cube];
        this._renderAtmosphereFaces(atmo, bake.sun, cube, res, faces);

        this._clouds.bakeCloudNoise();
        if (!this._clouds.cloudBaseNoise || !this._clouds.cloudDetailNoise || node.opacity <= 0) return;

        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(true);
        if (gl) GLState.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this._shaderManager.bind('volumetricClouds');
        const pipeline = this._pipelines.fullscreen('volumetricClouds', VolumetricCloudsProgram,
                                                  VolumetricCloudPasses.CLOUD_BLEND, undefined,
                                                  this.cubeFBO.targetFor(cube, faces[0] ?? 0, 0, false));
        // The depth texture is bound only because the layout has a slot for it; `u_ignoreDepth` skips it.
        const group = this._bindGroups.textureGroup(pipeline, 0, [this._targets.gBuffer.depth, this._clouds.cloudBaseNoise,
                                                           this._clouds.cloudDetailNoise]);
        this._clouds.setCloudUniforms(scene, node, this._cloudFaceInv, bake.eye, bake.time);
        this._shaderManager.setUniform('u_ignoreDepth', true);
        this._shaderManager.setUniform('u_temporal', false);
        this._shaderManager.setUniform('u_jitter', false);
        this._shaderManager.setUniform('u_jitterSlot', 0);
        this._shaderManager.setUniform('u_steps', Math.min(192, Math.max(node.steps, 96)));
        this._shaderManager.setUniform('u_lightSteps', Math.min(12, Math.max(node.lightSteps, 8)));

        this._passes.setViewport(res, res);
        const eye = bake.eye;
        for (const face of faces) {
            // The face's view from the bake's eye, through the UNFLIPPED 90-degree projection on both
            // backends. The ray is rebuilt from the screen quad's uv, and the quad already carries the
            // backend difference (its V is inverted on WebGPU, see `_screenQuad`), which lands every uv
            // row on the texel row the atmosphere's rasterized face put that direction in. Using
            // `_captureProj`, whose Y is flipped on WebGPU for RASTERIZING into a cube, applied the
            // flip twice: every side face traced the mirror image of its sky, so its clouds went below
            // the horizon and only the zenith and nadir looked right.
            mat4.translate(this._cloudFaceView, this._iblFaceViews[face], [-eye[0], -eye[1], -eye[2]]);
            mat4.multiply(this._cloudFaceInv, SkyPasses._CLOUD_FACE_PROJ, this._cloudFaceView);
            mat4.invert(this._cloudFaceInv, this._cloudFaceInv);
            this._shaderManager.setUniform('u_invViewProj', this._cloudFaceInv);
            const pass = this._passes.beginFullscreenPass(this.cubeFBO.targetFor(cube, face, 0, false),
                                                   'cloudSkyBake', false, undefined, false);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            this._passes.drawFullscreenAndEnd(pass);
        }
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        GLState.blend(false);
        this._passes.restoreDefaultBlend();
        GLState.depthMask(true);
        GLState.depthTest(true);
    }
}
