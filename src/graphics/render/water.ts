import { mat4, vec3 } from 'gl-matrix';
import type { WaterVolumeNode } from '../../core/scene/nodes/waterVolumeNode';
import type { Scene } from '../../core/scene/scene';
import { floatsToHalves } from '../../core/math';
import { Texture } from '../texture';
import { Mesh } from '../mesh';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import { DirectionalLight } from '../lighting';
import { skyAmbient } from '../particles/particleLighting';
import { ShaderManager } from '../systems/shaderManager';
import { WaterProgram, WaterUnderwaterProgram } from './programs';
import type { FullscreenPasses } from './fullscreenPasses';
import { sizedTarget } from './featureSubsystems';
import { ViewProjection } from './viewProjection';
import { buildWaterInfo, type WaterInfo } from '../../water/waterInfo';
import { WATER_DETAIL_SIZE, waterDetailPixels } from '../../water/waterTextures';
import { selectOceanTiles, type OceanTile } from '../../water/oceanLod';
import { sceneGround } from '../../water/ground';
import { decodeWaterBake } from '../../water/bake/waterBakeFormat';
import { GiBakeRegistry } from './gi/giBakeRegistry';
import { DEFAULT_WATER_LOOK, type WaterLook } from '../../water/waterLook';
import { GERSTNER_MAX_WAVES, type GerstnerWave } from '../../physics/water/gerstner';
import { waterTime } from '../../physics/water/waterClock';
import { surfOf } from '../../physics/water/surf';
import { createWindSample, sampleWindField } from '../../core/wind/windField';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { RenderSubsystems } from './subsystems';

/** What WaterPasses reads from the renderer that owns it. */
export interface WaterPassesHost {
    readonly renderWidth: number;
    readonly renderHeight: number;
    /** What a forward reflection marches with: [steps, thickness, max distance, on]. */
    ssrForward(): readonly number[];
}

/** Quads across a tile at each level of detail. */
const TILE_LODS = [64, 32, 16, 8];
/** Metres the skirt under each tile's edge hangs, covering cracks between tiles of different density. */
const SKIRT = 0.3;
/** Ripple trains at most (the shader's MAX_RIPPLES), each this much shorter than the last, down to the shortest. */
const RIPPLE_TRAINS = 16;
const RIPPLE_RATIO = 0.72;
const RIPPLE_SHORTEST = 0.05;
/** Seconds between rebuilds of a node's water info while it is being edited (a gizmo drag). */
const REBUILD_INTERVAL = 0.2;

/** One node's GPU side: its water info as two RGBA16F textures, and what they were built from. */
interface NodeWater {
    key: string;
    info: WaterInfo | null;
    tex0: Texture | null;
    tex1: Texture | null;
    builtAt: number;
}

/** One draw: where, with which mesh (`lod` into TILE_LODS), and, for an ocean tile, its morph. */
interface Tile { x0: number; z0: number; size: number; lod: number; ocean: OceanTile | null; }

/**
 * The surface of every Water node (core/scene/nodes/waterVolumeNode.ts): its water info, its tiles, and
 * one forward draw per visible tile with `water.wgsl`, into the scene before the fog and the temporal resolve (glass, particles
 * and sprites still draw over water, and the water writes depth they test against).
 *
 * LOD: a node's grid of tiles (water/waterInfo.ts) draws each tile with the grid density its distance
 * from the camera calls for, from 64 quads across up close to 8 far away, and skirts hide the cracks
 * between neighbours of different density; each wave moves only meshes dense enough to draw it, and the
 * shader fades the rest into roughness. An endless ocean is a CDLOD quadtree round the camera
 * (water/oceanLod.ts), morphing between levels, to the horizon. Tiles outside the view frustum, or past
 * the node's draw distance, are not drawn.
 */
export class WaterPasses {
    private readonly _shaderManager = ShaderManager.Instance;
    private readonly _nodes = new Map<WaterVolumeNode, NodeWater>();
    private _meshes: Mesh[] | null = null;
    private readonly _uvProj = mat4.create();
    private readonly _min = vec3.create();
    private readonly _max = vec3.create();
    private readonly _wind = createWindSample();
    /** Tiles drawn last frame, for stats and tests. */
    public tilesDrawn = 0;

    constructor(private readonly _host: WaterPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    /** Draw every enabled, visible Water node's surface into the scene buffer. */
    public renderWater(scene: Scene): void {
        const nodes: WaterVolumeNode[] = [];
        for (const node of scene.waterVolumes as Set<WaterVolumeNode>)
            // A legacy volume drawing its water with a Surface model (surfaceNodeId) keeps that look: drawing
            // a surface of its own too would put two waters on top of each other.
            if (node.enabled && node.visible && node.resolved() && !node.surfaceNodeId) nodes.push(node);
        this._forget(scene);
        this.tilesDrawn = 0;
        if (!nodes.length) return;
        const meshes = this._ensureMeshes();
        const ground = sceneGround(scene);

        // The opaque scene's colour, for refraction: the transparents' copy, taken earlier here.
        const w = this._host.renderWidth, h = this._host.renderHeight;
        const fbo = this._targets.refraction = sizedTarget(this._targets.refraction, () => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }), w, h);
        this._passes.copyColors([this._targets.scene.colors[0]], [fbo.colors[0]], w, h);

        const sm = this._shaderManager;
        const cam = this._view.camera;
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'water', false, undefined, false);
        const depthFormat = this._targets.scene.renderTarget.depthView?.texture.format;
        const pipeline = this._pipelines.get('water', WaterProgram, {
            cullMode: 'none', vertex: 'model', builtFor: 'water',
            depthStencil: depthFormat ? { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' } : undefined,
        });
        pass.setPipeline(pipeline);
        sm.bind('water');
        const { sunColor, ambient, sunDir } = this._light(scene);
        const env = this._envOf(scene);
        if (device.capabilities.conventions.originTopLeft) mat4.multiply(this._uvProj, ViewProjection.FLIP_SCREEN_Y, cam.projectionMatrix);
        else mat4.copy(this._uvProj, cam.projectionMatrix);
        // The key light's cascades and the cloud shadow: the glint, the caustics and the glow through the
        // waves all go dark in the shadow of a mountain or a cloud.
        if (this._bindGroups.declaresShadowGroup(pipeline)) {
            this._sys.shadows.uploadShadowUniforms('water');
            pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline, false));
        }

        // Per frame.
        sm.setUniform('u_view', cam.viewMatrix);
        sm.setUniform('u_projection', this._projection.rasterProjection(cam.projectionMatrix));
        sm.setUniform('u_fView', cam.viewMatrix);
        sm.setUniform('u_ssrProjection', this._uvProj);
        sm.setUniform('u_ssrParams', this._host.ssrForward());
        sm.setUniform('u_sunDir', [sunDir[0], sunDir[1], sunDir[2], 0]);
        sm.setUniform('u_sunColor', [sunColor[0], sunColor[1], sunColor[2], 0]);
        sm.setUniform('u_ambient', [ambient[0], ambient[1], ambient[2], 0]);
        sm.setUniform('u_vCamera', [cam.position[0], cam.position[1], cam.position[2], 0]);
        sm.setUniform('u_depthParams', [cam.near, cam.far, cam.type === 'orthographic' ? 1 : 0, 0]);
        sm.setUniform('u_resolution', [w, h, 1 / Math.max(1, w), 1 / Math.max(1, h)]);
        sm.setUniform('u_envScale', env.scale);

        let under: { node: WaterVolumeNode; level: number; look: WaterLook } | null = null;
        for (const node of nodes) {
            const body = node.resolved();
            const water = this._waterOf(node, ground);
            const info = water.info;
            const look = WaterPasses._lookOf(node);
            const waves = node.waves();
            const oceanLevel = body && body.type === 'ocean' && body.endless ? body.level : null;
            if (!info && oceanLevel === null) continue;
            // The waves' reach: how far they lift the surface (the culling box's height), and sideways.
            const heightScale = node.waveWindScale();
            let up = node.waveAmplitude, side = 0;
            for (const w of waves) { up += w.amplitude * heightScale; side += w.steepness * w.wavelength / (2 * Math.PI * waves.length); }
            // An ocean's surf stands taller than its waves over the beach.
            if (oceanLevel !== null && info) up += 1.5 * surfOf(waves, heightScale, this._surf).amplitude;
            const tiles = this._tilesOf(node, info, oceanLevel, up, side);
            if (!tiles.length) continue;
            // The waves' clock: the physics' drawn time while the game runs (so floaters ride what is drawn),
            // else the frame's; the node's wave speed applied, as physics applies it.
            const clock = waterTime(this._view.windTime);
            const t = clock * node.waveSpeed;
            this._nodeUniforms(node, info, oceanLevel, look, waves, t, scene);
            if (!under) {
                const c = cam.position, col = node.columnAt(c[0], c[2], clock);
                if (col && c[1] < col.surface && c[1] > col.floor - 1) under = { node, level: col.surface, look };
            }
            pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                this._targets.sceneDepth.depth, fbo.colors[0], env.cube ?? this._bindGroups.fallbackCube,
                water.tex0 ?? this._fallbackInfo(), water.tex1 ?? this._fallbackInfo(), this._detail(),
            ]));
            for (const tile of tiles) {
                const quads = TILE_LODS[tile.lod];
                sm.setUniform('u_tile', [tile.x0, tile.z0, tile.size, tile.ocean ? 0 : SKIRT]);
                sm.setUniform('u_tileLod', tile.ocean
                    ? [quads, tile.ocean.morphStart, tile.ocean.morphEnd, 1]
                    : [quads, 0, 0, 0]);
                this._passes.recordDraw(pass, meshes[tile.lod], 0, 0);
                this.tilesDrawn++;
            }
        }
        this._passes.endFullscreenPass(pass);
        if (under) this._underwater(under.level, under.look, scene);
    }

    /**
     * The camera is in the water: fog, tint and caustics over everything drawn so far, the surface seen
     * from below included (so its depth is copied in first).
     */
    private _underwater(level: number, look: WaterLook, scene: Scene): void {
        const w = this._host.renderWidth, h = this._host.renderHeight;
        this._passes.copyDepth(this._targets.scene.depth, this._targets.sceneDepth.depth, w, h);
        const fbo = this._targets.refraction!;
        this._passes.copyColors([this._targets.scene.colors[0]], [fbo.colors[0]], w, h);
        const { sunColor, ambient, sunDir } = this._light(scene);
        const k = this._view.preExposure;
        const sunUp = Math.max(0, sunDir[1]);
        const light = [0, 1, 2].map(i => (ambient[i] + sunColor[i] * sunUp * 0.5) * k);
        const sm = this._shaderManager;
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'water.underwater', false, undefined, false);
        this._fullscreen.bind(pass, 'waterUnderwater', WaterUnderwaterProgram, [fbo.colors[0], this._targets.sceneDepth.depth]);
        sm.bind('waterUnderwater');
        const cam = this._view.camera.position;
        sm.setUniform('u_invViewProj', this._projection.uvConsuming(this._invScratch, this._view.invViewProjStable));
        sm.setUniform('u_camera', [cam[0], cam[1], cam[2], level]);
        sm.setUniform('u_fog', [look.underwaterColor[0] * light[0], look.underwaterColor[1] * light[1], look.underwaterColor[2] * light[2], look.underwaterFog]);
        sm.setUniform('u_absorb', [look.absorption[0] * 0.5, look.absorption[1] * 0.5, look.absorption[2] * 0.5, this._view.windTime]);
        sm.setUniform('u_sun', [sunDir[0], sunDir[1], sunDir[2], look.caustics]);
        sm.setUniform('u_causticScale', [look.causticsScale, Math.min(this._view.camera.far, 500), 0, 0]);
        this._passes.drawFullscreenAndEnd(pass);
    }

    private readonly _invScratch = mat4.create();

    // ---- per node ---------------------------------------------------------------------------------

    private _nodeUniforms(node: WaterVolumeNode, info: WaterInfo | null, oceanLevel: number | null, look: WaterLook,
                          waves: GerstnerWave[], t: number, scene: Scene): void {
        const sm = this._shaderManager;
        const origin = info ? [info.originX, info.originZ, info.cell, 1] : [0, 0, 1, 0];
        const size = info ? [info.nx, info.nz, info.minY, 0] : [1, 1, 0, 0];
        sm.setUniform('u_vInfoOrigin', origin);
        sm.setUniform('u_vInfoSize', size);
        sm.setUniform('u_fInfoOrigin', origin);
        sm.setUniform('u_fInfoSize', size);
        const ocean = [oceanLevel ?? 0, oceanLevel !== null ? 1 : 0, 0, 0];
        sm.setUniform('u_vOcean', ocean);
        sm.setUniform('u_fOcean', ocean);
        const dir = this._waveDir, phase = this._wavePhase;
        dir.fill(0); phase.fill(0);
        const n = Math.min(GERSTNER_MAX_WAVES, waves.length);
        let amplitude = 0;
        for (let i = 0; i < n; i++) {
            const w = waves[i];
            dir.set([w.dirX, w.dirZ, w.amplitude, w.wavelength], i * 4);
            phase.set([w.steepness, w.phase, 0, 0], i * 4);
            amplitude += w.amplitude;
        }
        const heightScale = node.waveWindScale();
        sm.setUniform('u_waveDir', dir);
        sm.setUniform('u_wavePhase', phase);
        sm.setUniform('u_waveParams', [n, t, heightScale, node.shoreFade]);
        sm.setUniform('u_fWaveDir', dir);
        sm.setUniform('u_fWavePhase', phase);
        sm.setUniform('u_fWaveParams', [n, t, heightScale, node.shoreFade]);
        sm.setUniform('u_swell', [node.waveAmplitude, node.waveFrequency, amplitude * heightScale, 0]);
        // The surf over the beach (physics/water/surf.ts): an ocean with a shore grid has it, from its waves.
        const surf = surfOf(waves, heightScale, this._surf);
        const surfOn = oceanLevel !== null && !!info ? 1 : 0;
        sm.setUniform('u_vSurf', [surf.omega, surf.amplitude, surfOn, 0]);
        sm.setUniform('u_fSurf', [surf.omega, surf.amplitude, surfOn, 0]);
        const cam = this._view.camera.position;
        sm.setUniform('u_viewPos', [cam[0], cam[1], cam[2], t]);

        // The look.
        sm.setUniform('u_shallowColor', [...look.shallowColor, look.turbidity]);
        sm.setUniform('u_deepColor', [...look.deepColor, look.clarity]);
        sm.setUniform('u_absorption', [...look.absorption, look.roughness]);
        sm.setUniform('u_foamColor', [...look.foamColor, look.shoreFoam]);
        sm.setUniform('u_foamParams', [look.crestFoam, look.flowFoam, look.caustics, look.causticsScale]);
        sm.setUniform('u_surfaceParams', [look.reflectivity, look.screenReflections, look.refraction, look.detailStrength]);
        sm.setUniform('u_detailParams', [look.detailScale, look.flowStrength, look.rainRipples, look.snowCover]);
        sm.setUniform('u_underwater', [...look.underwaterColor, look.underwaterFog]);
        sm.setUniform('u_sssColor', [...look.scatterColor, look.subsurface]);
        sm.setUniform('u_sssParams', [look.subsurfaceSharpness, look.subsurfaceDistortion, 0, 0]);

        // The wind over the water, from the frame's wind field.
        const field = this._sys.wind.windField;
        const p = node.worldPosition;
        let wx = 0, wz = 0, speed = 0;
        if (field.active) {
            sampleWindField(field.params, field.sources, field.count, p[0], p[1], p[2], this._wind);
            wx = this._wind.velocity[0]; wz = this._wind.velocity[2];
            speed = Math.hypot(wx, wz);
        }
        sm.setUniform('u_windParams', [wx, wz, speed, look.windResponse]);
        const under = this._cameraUnder(node);
        sm.setUniform('u_misc', [this._view.preExposure, 0, under ? 1 : 0, 0]);

        // The ripples: the spectrum carried on below the shortest Gerstner wave down to a few centimetres,
        // their slope variance what Cox and Munk measured on a sea under this wind, less what the waves
        // already have. The wind is the scene's where it blows here, else the wind the waves were shaped for.
        const wind = field.active && speed > 0.5 ? speed * look.windResponse : node.windSpeed;
        const longest = n ? Math.min(...waves.slice(0, n).map(w => w.wavelength)) * 0.75 : 2;
        const count = Math.max(1, Math.min(RIPPLE_TRAINS, Math.floor(Math.log(RIPPLE_SHORTEST / Math.max(longest, RIPPLE_SHORTEST * 1.01)) / Math.log(RIPPLE_RATIO)) + 1));
        let wavesVariance = 0;
        for (let i = 0; i < n; i++) {
            const k = 2 * Math.PI / Math.max(0.01, waves[i].wavelength);
            wavesVariance += 0.5 * Math.pow(k * waves[i].amplitude * heightScale, 2);
        }
        const coxMunk = 0.003 + 0.00512 * Math.max(0, wind);
        const rippleVariance = Math.max(coxMunk - wavesVariance, 0.002);
        sm.setUniform('u_ripple', [Math.max(longest, RIPPLE_SHORTEST), Math.sqrt(2 * rippleVariance / count), RIPPLE_RATIO, count]);
        const heading = speed > 0.5 && field.active ? [wx / speed, wz / speed] : WaterPasses._heading(node.waveDirection);
        sm.setUniform('u_rippleDir', [heading[0], heading[1], 0, 0]);
        void scene;
    }

    private readonly _surf = { omega: 0, amplitude: 0 };
    private readonly _waveDir = new Float32Array(GERSTNER_MAX_WAVES * 4);
    private readonly _wavePhase = new Float32Array(GERSTNER_MAX_WAVES * 4);

    /** Unit x, z of a heading in degrees (0 = +Z, 90 = +X), as the waves' direction is given. */
    private static _heading(degrees: number): [number, number] {
        const a = degrees * Math.PI / 180;
        return [Math.sin(a), Math.cos(a)];
    }

    /** Whether the camera is below this node's surface (and so sees it from underneath). */
    private _cameraUnder(node: WaterVolumeNode): boolean {
        const c = this._view.camera.position;
        const col = node.columnAt(c[0], c[2], waterTime(this._view.windTime));
        return !!col && c[1] < col.surface && c[1] > col.floor - 1;
    }

    /** The node's water info and textures, rebuilt when its shapes, placement or the ground under it change. */
    private _waterOf(node: WaterVolumeNode, ground: ReturnType<typeof sceneGround>): NodeWater {
        let water = this._nodes.get(node);
        const key = `${node.resolveKey()}|${ground.key}`;
        const now = performance.now() / 1000; // wall-clock: throttles CPU rebuilds of the grid, not a look
        // A current bake replaces the analytic grid; a stale one (the shapes changed since) is ignored.
        const bake = node.bakeId ? this._bakeOf(node.bakeId) : null;
        const baked = bake && bake.signature === node.bakeSignature() ? bake : null;
        const fullKey = baked ? `bake:${node.bakeId}|${GiBakeRegistry.generation}` : key;
        if (water && water.key === fullKey) return water;
        if (!baked && water && water.info && water.info.source === 'analytic' && now - water.builtAt < REBUILD_INTERVAL) return water;
        const body = node.resolved();
        const info = baked ? baked.info
            : body && body.type === 'ocean' && body.endless ? node.oceanShoreInfo()
            : buildWaterInfo(node.resolvedShapes(), ground.sample, { handOver: node.handOver() });
        const keyNow = fullKey;
        if (!water) { water = { key, info: null, tex0: null, tex1: null, builtAt: now }; this._nodes.set(node, water); }
        water.key = keyNow;
        water.builtAt = now;
        water.info = info;
        if (info) {
            const fit = (tex: Texture | null) => tex && tex.width === info.nx && tex.height === info.nz;
            if (!fit(water.tex0)) { water.tex0?.delete(); water.tex0 = WaterPasses._infoTexture(info.nx, info.nz); }
            if (!fit(water.tex1)) { water.tex1?.delete(); water.tex1 = WaterPasses._infoTexture(info.nx, info.nz); }
            // Heights above the grid's lowest surface: half floats keep centimetres there, not at 100 m up.
            const rel0 = info.info0.slice(), rel1 = info.info1.slice();
            for (let i = 0; i < rel0.length; i += 4) { rel0[i] -= info.minY; rel1[i + 2] -= info.minY; }
            WaterPasses._upload(water.tex0!, rel0, info.nx, info.nz);
            WaterPasses._upload(water.tex1!, rel1, info.nx, info.nz);
        }
        return water;
    }

    private readonly _bakes = new Map<string, { generation: number; decoded: ReturnType<typeof decodeWaterBake> }>();
    /** A bake's grid by id, decoded once per registry change. */
    private _bakeOf(id: string): ReturnType<typeof decodeWaterBake> {
        const cached = this._bakes.get(id);
        if (cached && cached.generation === GiBakeRegistry.generation) return cached.decoded;
        const bytes = GiBakeRegistry.get(id);
        const decoded = bytes ? decodeWaterBake(bytes, id) : null;
        this._bakes.set(id, { generation: GiBakeRegistry.generation, decoded });
        return decoded;
    }

    /** Drop the GPU side of nodes no longer in the scene. */
    private _forget(scene: Scene): void {
        for (const [node, water] of this._nodes) {
            if (scene.waterVolumes.has(node)) continue;
            water.tex0?.delete(); water.tex1?.delete();
            this._nodes.delete(node);
        }
    }

    /** RGBA16F, one slice deep: the format and path FluidVolumeNode's volumes take, filterable everywhere. */
    private static _infoTexture(nx: number, nz: number): Texture {
        const tex = new Texture({
            target: 'texture3D', mipMap: false, wrapping: 'clamp', format: 'rgba16float', loadOnly: true,
            size: { width: nx, height: nz, depth: 1 },
        } as any);
        tex.createVolume(nx, nz, 1, 'clamp');
        return tex;
    }

    private static _upload(tex: Texture, data: Float32Array, nx: number, nz: number): void {
        const half = !device.capabilities.conventions.writeTextureConvertsFloatToHalf;
        if (half) {
            const halves = new Uint16Array(data.length);
            floatsToHalves(data, halves);
            device.writeTexture(tex.rhiTexture, halves, nx, nz, 0, 0);
        } else {
            device.writeTexture(tex.rhiTexture, data, nx, nz, 0, 0);
        }
    }

    private _detailTexture: Texture | null = null;
    /**
     * The foam texture (water/waterTextures.ts), made on first use, tiled, and MIPMAPPED: the shader picks a
     * level by distance, and an unfilled level is black (a raw-bytes upload fills level 0 only), so it goes
     * up the way an image does, which builds the chain on both backends.
     */
    private _detail(): Texture {
        if (!this._detailTexture) {
            const tex = new Texture({ mipMap: true, wrapping: 'repeat' });
            tex.createFromPixels(new Uint8ClampedArray(waterDetailPixels().buffer), WATER_DETAIL_SIZE, WATER_DETAIL_SIZE);
            this._detailTexture = tex;
        }
        return this._detailTexture;
    }

    private _fallback: Texture | null = null;
    /** A 1x1 dry info texture, for a node with no grid (an endless ocean alone). */
    private _fallbackInfo(): Texture {
        if (!this._fallback) {
            this._fallback = WaterPasses._infoTexture(1, 1);
            WaterPasses._upload(this._fallback, new Float32Array(4), 1, 1);
        }
        return this._fallback;
    }

    // ---- tiles ------------------------------------------------------------------------------------

    private readonly _oceanTiles: OceanTile[] = [];

    /**
     * Every tile of `node` to draw this frame, culled and with its level of detail. `up` and `side` are how
     * far the waves move the surface vertically and sideways: the culling boxes grow by them.
     */
    private _tilesOf(node: WaterVolumeNode, info: WaterInfo | null, oceanLevel: number | null, up: number, side: number): Tile[] {
        const out: Tile[] = [];
        const cam = this._view.camera.position;
        const vis = this._sys.visibility;
        const drawDistance = node.drawDistance > 0 ? node.drawDistance : Infinity;
        const cull = (x0: number, z0: number, size: number, y0: number, y1: number): boolean => {
            this._min[0] = x0 - side; this._min[1] = y0 - up - SKIRT; this._min[2] = z0 - side;
            this._max[0] = x0 + size + side; this._max[1] = y1 + up; this._max[2] = z0 + size + side;
            return vis.frustumCulling && !vis.frustum.intersectsAABB(this._min, this._max);
        };
        const distanceTo = (x0: number, z0: number, size: number, y: number) => {
            const dx = Math.max(x0 - cam[0], 0, cam[0] - (x0 + size));
            const dz = Math.max(z0 - cam[2], 0, cam[2] - (z0 + size));
            return Math.hypot(dx, dz, cam[1] - y);
        };
        const lodFor = (d: number, size: number) => {
            const r = d / Math.max(size, 1);
            return r < 1.5 ? 0 : r < 4 ? 1 : r < 10 ? 2 : 3;
        };
        if (info && info.tilesX > 0) {
            const span = info.tileCells * info.cell;
            for (let tz = 0; tz < info.tilesZ; tz++) for (let tx = 0; tx < info.tilesX; tx++) {
                const k = tz * info.tilesX + tx;
                if (!info.tileWet[k]) continue;
                const x0 = info.originX + tx * span, z0 = info.originZ + tz * span;
                const y0 = info.tileMinY[k], y1 = info.tileMaxY[k];
                if (cull(x0, z0, span, y0, y1)) continue;
                const d = distanceTo(x0, z0, span, (y0 + y1) / 2);
                if (d > drawDistance) continue;
                out.push({ x0, z0, size: span, lod: lodFor(d, span), ocean: null });
            }
        }
        if (oceanLevel !== null) {
            // An endless ocean: the CDLOD quadtree round the camera, culled by the frustum's sides only (its
            // far plane would stop the sea short of the horizon; the shader pins it inside).
            const planes = vis.frustum.planes;
            const culling = vis.frustumCulling;
            const visible = (min: number[], max: number[]) => {
                if (!culling) return true;
                for (let i = 0; i < 4; i++) {
                    const o = i * 4, a = planes[o], b = planes[o + 1], c = planes[o + 2];
                    const px = a >= 0 ? max[0] + side : min[0] - side, py = b >= 0 ? max[1] : min[1], pz = c >= 0 ? max[2] + side : min[2] - side;
                    if (a * px + b * py + c * pz + planes[o + 3] < 0) return false;
                }
                return true;
            };
            for (const tile of selectOceanTiles(cam, oceanLevel, up + SKIRT, visible, this._oceanTiles)) {
                if (distanceTo(tile.x0, tile.z0, tile.size, oceanLevel) > drawDistance) continue;
                out.push({ x0: tile.x0, z0: tile.z0, size: tile.size, lod: TILE_LODS.indexOf(tile.quads), ocean: tile });
            }
        }
        return out;
    }

    /** The grid meshes, one per level of detail: (n+1)² vertices over 0..1, and a skirt ring at y = -1. */
    private _ensureMeshes(): Mesh[] {
        if (this._meshes) return this._meshes;
        this._meshes = TILE_LODS.map(n => {
            const v: number[] = [];
            const idx: number[] = [];
            for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) v.push(x / n, 0, z / n);
            const at = (x: number, z: number) => z * (n + 1) + x;
            for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
                const a = at(x, z), b = at(x + 1, z), c = at(x, z + 1), d = at(x + 1, z + 1);
                idx.push(a, c, b, b, c, d);
            }
            // The skirt: each edge vertex again at y = -1, stitched to its edge.
            const edge: number[] = [];
            for (let x = 0; x <= n; x++) edge.push(at(x, 0));
            for (let z = 1; z <= n; z++) edge.push(at(n, z));
            for (let x = n - 1; x >= 0; x--) edge.push(at(x, n));
            for (let z = n - 1; z >= 1; z--) edge.push(at(0, z));
            const base = v.length / 3;
            for (const e of edge) v.push(v[e * 3], -1, v[e * 3 + 2]);
            for (let i = 0; i < edge.length; i++) {
                const j = (i + 1) % edge.length;
                const a = edge[i], b = edge[j], c = base + i, d = base + j;
                idx.push(a, b, c, b, d, c);
            }
            const mesh = new Mesh();
            mesh.create(new Float32Array(v), v.length / 3, idx);
            return mesh;
        });
        return this._meshes;
    }

    // ---- light, environment, ground, look ------------------------------------------------------------

    /** The key light and ambient, as the fluid volumes and lit particles gather them. */
    private _light(scene: Scene): { sunColor: number[]; ambient: number[]; sunDir: number[] } {
        const sunColor = [0, 0, 0];
        const sunDir = [0, 1, 0];
        // The sun as the deferred lighting has it: dimmed and whitened by the cloud cover (lighting.ts
        // `_uploadDirectional`), so the glint fades under an overcast exactly as the land's light does.
        const grade = this._sys.lighting.cloudGrade(scene);
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            const light = node.light as DirectionalLight;
            const key = node === this._sys.lighting.keyLightNode ? this._sys.lighting.keyLight : null;
            const k = (key ? key.intensity : light.internalIntensity) * grade.sun;
            const c = key ? key.color : light.color;
            const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            for (let i = 0; i < 3; i++) sunColor[i] = (c[i] + (lum - c[i]) * grade.white) * k;
            const f = this._sys.lighting.dirOf(node);
            sunDir[0] = -f[0]; sunDir[1] = -f[1]; sunDir[2] = -f[2];
            break;
        }
        const ambient = this._sys.lighting.internalAmbient(scene);
        const skyNode = scene.skyLight;
        if (skyNode && this._sys.sky.skySHValid) {
            const sky = skyAmbient(this._sys.sky.skySH, skyNode.intensity * grade.sky);
            ambient[0] += sky[0]; ambient[1] += sky[1]; ambient[2] += sky[2];
        }
        return { sunColor, ambient, sunDir };
    }

    /** The cube the water reflects, and how to scale it: the scene's environment map or the sky's. */
    private _envOf(scene: Scene): { cube: Texture | null; scale: number[] } {
        const k = this._view.preExposure;
        if (scene.environmentMap) return { cube: scene.environmentMap, scale: [k, k, k, 1] };
        const sky = this._sys.sky.skyReflectionCube;
        const light = scene.skyLight;
        if (sky && light) {
            const s = light.intensity * k, tint = light.tint;
            return { cube: sky, scale: [s * tint[0], s * tint[1], s * tint[2], 2] };
        }
        return { cube: null, scale: [0, 0, 0, 0] };
    }

    /** The node's Water material look, or the default. */
    private static _lookOf(node: WaterVolumeNode): WaterLook {
        return node.waterMaterial?.look ?? DEFAULT_WATER_LOOK;
    }
}
