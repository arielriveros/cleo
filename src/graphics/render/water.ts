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
import { WaterProgram } from './programs';
import { sizedTarget } from './featureSubsystems';
import { ViewProjection } from './viewProjection';
import { buildWaterInfo, type GroundSampler, type WaterInfo } from '../../water/waterInfo';
import { sceneGround } from '../../water/ground';
import { decodeWaterBake } from '../../water/bake/waterBakeFormat';
import { GiBakeRegistry } from './gi/giBakeRegistry';
import { DEFAULT_WATER_LOOK, type WaterLook } from '../../water/waterLook';
import { GERSTNER_MAX_WAVES } from '../../physics/water/gerstner';
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
/** An endless ocean's tiles: the innermost size (m) and how many doublings reach the horizon. */
const OCEAN_TILE = 16;
const OCEAN_LEVELS = 9;
/** Metres the skirt under each tile's edge hangs, covering cracks between tiles of different density. */
const SKIRT = 0.3;
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

interface Tile { x0: number; z0: number; size: number; lod: number; ocean: boolean; }

/**
 * The surface of every Water node (core/scene/nodes/waterVolumeNode.ts): its water info, its tiles, and
 * one forward draw per visible tile with `water.wgsl`, right before the transparents (so glass, particles
 * and sprites still draw over water, and the water writes depth they test against).
 *
 * LOD: a node's grid of tiles (water/waterInfo.ts) draws each tile with the grid density its distance
 * from the camera calls for, from 64 quads across up close to 8 far away, and skirts hide the cracks
 * between neighbours of different density; the waves fade out with distance, and so do the detail, the
 * screen-space reflection and the caustics in the shader's own terms. An endless ocean adds concentric
 * rings of tiles around the camera, each ring's tiles twice the last's, to the horizon. Tiles outside
 * the view frustum, or past the node's draw distance, are not drawn.
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
                private readonly _sys: RenderSubsystems) {}

    /** Draw every enabled, visible Water node's surface into the scene buffer. */
    public renderWater(scene: Scene): void {
        const nodes: WaterVolumeNode[] = [];
        for (const node of scene.waterVolumes as Set<WaterVolumeNode>)
            if (node.enabled && node.visible && node.shapes.length) nodes.push(node);
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
        const viewProj = mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix);
        if (device.capabilities.conventions.originTopLeft) mat4.multiply(this._uvProj, ViewProjection.FLIP_SCREEN_Y, cam.projectionMatrix);
        else mat4.copy(this._uvProj, cam.projectionMatrix);
        const t = this._view.windTime;

        // Per frame.
        sm.setUniform('u_view', cam.viewMatrix);
        sm.setUniform('u_projection', this._projection.rasterProjection(cam.projectionMatrix));
        sm.setUniform('u_fView', cam.viewMatrix);
        sm.setUniform('u_ssrProjection', this._uvProj);
        sm.setUniform('u_ssrParams', this._host.ssrForward());
        sm.setUniform('u_sunDir', [sunDir[0], sunDir[1], sunDir[2], 0]);
        sm.setUniform('u_sunColor', [sunColor[0], sunColor[1], sunColor[2], 0]);
        sm.setUniform('u_ambient', [ambient[0], ambient[1], ambient[2], 0]);
        sm.setUniform('u_viewPos', [cam.position[0], cam.position[1], cam.position[2], t]);
        sm.setUniform('u_depthParams', [cam.near, cam.far, cam.type === 'orthographic' ? 1 : 0, 0]);
        sm.setUniform('u_resolution', [w, h, 1 / Math.max(1, w), 1 / Math.max(1, h)]);
        sm.setUniform('u_envScale', env.scale);
        void viewProj;

        for (const node of nodes) {
            const water = this._waterOf(node, ground);
            const info = water.info;
            const look = WaterPasses._lookOf(node);
            const waves = node.waves();
            const oceanLevel = info ? info.oceanLevel : node.resolvedShapes().find(s => s.type === 'ocean' && s.endless)?.level ?? null;
            if (!info && oceanLevel === null) continue;
            const tiles = this._tilesOf(node, info, oceanLevel, waves.reduce((s, w) => s + w.amplitude, 0) + node.waveAmplitude);
            if (!tiles.length) continue;
            this._nodeUniforms(node, info, oceanLevel, look, waves, t, scene);
            pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                this._targets.sceneDepth.depth, fbo.colors[0], env.cube ?? this._bindGroups.fallbackCube,
                water.tex0 ?? this._fallbackInfo(), water.tex1 ?? this._fallbackInfo(),
            ]));
            for (const tile of tiles) {
                sm.setUniform('u_tile', [tile.x0, tile.z0, tile.size, SKIRT]);
                sm.setUniform('u_fOcean', [oceanLevel ?? 0, oceanLevel !== null ? 1 : 0, tile.ocean ? 1 : 0, 0]);
                this._passes.recordDraw(pass, meshes[tile.lod], 0, 0);
                this.tilesDrawn++;
            }
        }
        this._passes.endFullscreenPass(pass);
    }

    // ---- per node ---------------------------------------------------------------------------------

    private _nodeUniforms(node: WaterVolumeNode, info: WaterInfo | null, oceanLevel: number | null, look: WaterLook,
                          waves: ReturnType<WaterVolumeNode['waves']>, t: number, scene: Scene): void {
        const sm = this._shaderManager;
        const origin = info ? [info.originX, info.originZ, info.cell, 1] : [0, 0, 1, 0];
        const size = info ? [info.nx, info.nz, info.minY, 0] : [1, 1, 0, 0];
        sm.setUniform('u_vInfoOrigin', origin);
        sm.setUniform('u_vInfoSize', size);
        sm.setUniform('u_fInfoOrigin', origin);
        sm.setUniform('u_fInfoSize', size);
        sm.setUniform('u_vOcean', [oceanLevel ?? 0, oceanLevel !== null ? 1 : 0, 0, 0]);
        const dir = new Float32Array(GERSTNER_MAX_WAVES * 4), phase = new Float32Array(GERSTNER_MAX_WAVES * 4);
        const n = Math.min(GERSTNER_MAX_WAVES, waves.length);
        for (let i = 0; i < n; i++) {
            const w = waves[i];
            dir.set([w.dirX, w.dirZ, w.amplitude, w.wavelength], i * 4);
            phase.set([w.steepness, w.phase, 0, 0], i * 4);
        }
        sm.setUniform('u_waveDir', dir);
        sm.setUniform('u_wavePhase', phase);
        sm.setUniform('u_waveParams', [n, t, 1, node.shoreFade]);
        sm.setUniform('u_swell', [node.waveAmplitude, node.waveFrequency, 0, 0]);
        const cam = this._view.camera.position;
        sm.setUniform('u_vCamera', [cam[0], cam[1], cam[2], 1500]);

        // The look.
        sm.setUniform('u_shallowColor', [...look.shallowColor, look.turbidity]);
        sm.setUniform('u_deepColor', [...look.deepColor, look.clarity]);
        sm.setUniform('u_absorption', [...look.absorption, look.roughness]);
        sm.setUniform('u_foamColor', [...look.foamColor, look.shoreFoam]);
        sm.setUniform('u_foamParams', [look.crestFoam, look.flowFoam, look.caustics, look.causticsScale]);
        sm.setUniform('u_surfaceParams', [look.reflectivity, look.screenReflections, look.refraction, look.detailStrength]);
        sm.setUniform('u_detailParams', [look.detailScale, look.flowStrength, look.rainRipples, look.snowCover]);
        sm.setUniform('u_underwater', [...look.underwaterColor, look.underwaterFog]);

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
        void scene;
    }

    /** Whether the camera is below this node's surface (and so sees it from underneath). */
    private _cameraUnder(node: WaterVolumeNode): boolean {
        const c = this._view.camera.position;
        const col = node.columnAt(c[0], c[2], this._view.windTime);
        return !!col && c[1] < col.surface && c[1] > col.floor - 1;
    }

    /** The node's water info and textures, rebuilt when its shapes, placement or the ground under it change. */
    private _waterOf(node: WaterVolumeNode, ground: { sample: GroundSampler | null; key: string }): NodeWater {
        let water = this._nodes.get(node);
        const m = node.worldTransform;
        const key = `${node.version}|${m[12]},${m[13]},${m[14]},${m[0]},${m[5]},${m[10]}|${ground.key}`;
        const now = performance.now() / 1000;
        // A current bake replaces the analytic grid; a stale one (the shapes changed since) is ignored.
        const bake = node.bakeId ? this._bakeOf(node.bakeId) : null;
        const baked = bake && bake.signature === node.bakeSignature() ? bake : null;
        const fullKey = baked ? `bake:${node.bakeId}|${GiBakeRegistry.generation}` : key;
        if (water && water.key === fullKey) return water;
        if (!baked && water && water.info && water.info.source === 'analytic' && now - water.builtAt < REBUILD_INTERVAL) return water;
        const info = baked ? baked.info : buildWaterInfo(node.resolvedShapes(), ground.sample);
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

    /** Every tile of `node` to draw this frame, culled and with its level of detail. */
    private _tilesOf(node: WaterVolumeNode, info: WaterInfo | null, oceanLevel: number | null, reach: number): Tile[] {
        const out: Tile[] = [];
        const cam = this._view.camera.position;
        const vis = this._sys.visibility;
        const drawDistance = node.drawDistance > 0 ? node.drawDistance : Infinity;
        const cull = (x0: number, z0: number, size: number, y0: number, y1: number): boolean => {
            this._min[0] = x0; this._min[1] = y0 - reach - SKIRT; this._min[2] = z0;
            this._max[0] = x0 + size; this._max[1] = y1 + reach; this._max[2] = z0 + size;
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
        if (info) {
            const span = info.tileCells * info.cell;
            for (let tz = 0; tz < info.tilesZ; tz++) for (let tx = 0; tx < info.tilesX; tx++) {
                const k = tz * info.tilesX + tx;
                if (!info.tileWet[k]) continue;
                const x0 = info.originX + tx * span, z0 = info.originZ + tz * span;
                const y0 = info.tileMinY[k], y1 = info.tileMaxY[k];
                if (cull(x0, z0, span, y0, y1)) continue;
                const d = distanceTo(x0, z0, span, (y0 + y1) / 2);
                if (d > drawDistance) continue;
                out.push({ x0, z0, size: span, lod: lodFor(d, span), ocean: false });
            }
        }
        if (oceanLevel !== null) {
            // Rings of tiles round the camera, each level's tiles twice the size of the last, snapped to
            // their own size so they do not swim as the camera moves. Level 0 is a 4x4 block; each further
            // level is the 4x4 block of its size around the camera minus the 2x2 the level inside it covers.
            for (let level = 0; level < OCEAN_LEVELS; level++) {
                const s = OCEAN_TILE * Math.pow(2, level);
                const cx = Math.floor(cam[0] / (2 * s)) * 2 * s, cz = Math.floor(cam[2] / (2 * s)) * 2 * s;
                const inner = level === 0 ? null : OCEAN_TILE * Math.pow(2, level - 1);
                const icx = inner ? Math.floor(cam[0] / (2 * inner)) * 2 * inner : 0, icz = inner ? Math.floor(cam[2] / (2 * inner)) * 2 * inner : 0;
                for (let j = -2; j < 2; j++) for (let i = -2; i < 2; i++) {
                    const x0 = cx + i * s, z0 = cz + j * s;
                    if (inner) {
                        // Inside the previous level's block (its 4x4 of half-size tiles): already drawn.
                        const bx0 = icx - 2 * inner, bz0 = icz - 2 * inner, bx1 = icx + 2 * inner, bz1 = icz + 2 * inner;
                        if (x0 >= bx0 && x0 + s <= bx1 && z0 >= bz0 && z0 + s <= bz1) continue;
                    }
                    if (cull(x0, z0, s, oceanLevel, oceanLevel)) continue;
                    const d = distanceTo(x0, z0, s, oceanLevel);
                    if (d > drawDistance) continue;
                    out.push({ x0, z0, size: s, lod: level === 0 ? 0 : 1, ocean: true });
                }
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
