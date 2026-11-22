import { mat4, vec3 } from 'gl-matrix';
import type { DrawnJoin, WaterVolumeNode } from '../../core/scene/nodes/waterVolumeNode';
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
import { heightQuantum, splitHeight, type WaterInfo } from '../../water/waterInfo';
import { WATER_DETAIL_SIZE, WATER_FOAM_SIZE, waterDetailPixels, waterFoamPixels } from '../../water/waterTextures';
import { WAVE_SIM_CELL, WAVE_SIM_SIZE } from '../../water/waveSim';
import { WaterWaveSim, WAVE_SIM_SIDE, type WaveSimWater } from './waterWaves';
import { selectOceanTiles, type OceanTile } from '../../water/oceanLod';
import { obstacleFootprint, sceneObstacles, type WaterObstacle, type WaterObstacleFootprint } from '../../water/bake/obstacles';
import { ALL_LAYERS, isAllLayers } from '../../physics/collisionLayers';
import type { WaveSimBody } from '../../water/waveSim';
import { DEFAULT_WATER_LOOK, type WaterLook } from '../../water/waterLook';
import { WAVE_MAX, WAVE_SLOPE_VARIANCE, rippleShare, waveCrest, waveOmega, waveReach, waveSigma, type WaterWave } from '../../physics/water/waves';
import { waterTime } from '../../physics/water/waterClock';
import { surfOf } from '../../physics/water/surf';
import { JOIN_CHANNELS, JOIN_FAR } from '../../physics/water/joins';
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

/** Quads across a tile at each level of detail. The first is for the tiles under the camera: fine enough to lift by the live waves. */
const TILE_LODS = [128, 64, 32, 16, 8];
/** The coarsest level of detail a steep tile (a cascade, water/waterEdges.ts tileSteep) is drawn at: a vertex a cell. */
const STEEP_TILE_LOD = 2;
/** Metres between vertices the mesh is made fine to under the camera where the local flow is drawn: its cells are 0.3 m. */
const FINE_SPACING = 0.15;
/** Metres the local flow lifts or lowers the surface at most, for the culling boxes. */
const LOCAL_FLOW_REACH = 0.8;
/** Metres the skirt under each tile's edge hangs, covering cracks between tiles of different density. */
const SKIRT = 0.3;
/** Seconds the live waves run on after the last body crossed the surface in their window: its rings die down. */
const RIPPLE_LINGER = 10;
/** Seconds over which they fade out at the end of that. */
const RIPPLE_FADE = 2;
/** Metres the live waves lift or lower the surface at most, for the culling boxes. */
const LIVE_REACH = 0.3;
/** Milliseconds a node's list of what crosses its surface stays news (a paused game's goes stale). */
const DISTURBANCE_FRESH_MS = 250;

/**
 * One node's GPU side: its water info as two RGBA16F textures, and what they were built from. `tileDrawn`: the
 * surface tiles any of whose cells are drawn (its own water and the apron under its banks, water/waterEdges.ts).
 */
interface NodeWater {
    key: string;
    info: WaterInfo | null;
    tex0: Texture | null;
    tex1: Texture | null;
    builtAt: number;
    tileDrawn: Uint8Array | null;
    /** The surface tiles whose drawn surface is steep (a cascade): drawn no coarser than STEEP_TILE_LOD. */
    tileSteep: Uint8Array | null;
    /** A river's mouths (WaterVolumeNode.waterJoin): its join field as two RGBA16F textures on its grid. */
    joinKey: string;
    join: DrawnJoin | null;
    joinA: Texture | null;
    joinB: Texture | null;
}

/** A river joined to an endless sea, as the sea's tiles near it draw under it (water.wgsl, the sea under a river). */
interface SeaMouth { water: NodeWater; info: WaterInfo; slot: number; length: number; drop: number; box: [number, number, number, number]; }

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
    /** The live waves on flowing water round the camera (render/waterWaves.ts). */
    private _liveSim: WaterWaveSim | null = null;

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
        // Textures replaced or dropped last time are freed now: the passes that read them have been submitted.
        this._flushRetired();
        this._frameWater.clear();
        const nodes: WaterVolumeNode[] = [];
        for (const node of scene.waterVolumes as Set<WaterVolumeNode>)
            // A legacy volume drawing its water with a Surface model (surfaceNodeId) keeps that look: drawing
            // a surface of its own too would put two waters on top of each other.
            if (node.enabled && node.visible && node.resolved() && !node.surfaceNodeId) nodes.push(node);
        this._forget(scene);
        this.tilesDrawn = 0;
        if (!nodes.length) return;
        const meshes = this._ensureMeshes();
        // The live waves, before the surface's own pass opens: they record passes of their own. Only where a
        // river runs: still water raises none.
        this._liveWaves(scene, nodes);

        // The surface's pipeline first, for the target it will draw into: the first one is built off the main
        // thread on WebGPU (PipelineCache.getOrDefer: the water program compiled for 9 s there), and until it
        // is ready there is no water to draw.
        const sceneTarget = this._targets.scene.renderTarget;
        const depthFormat = sceneTarget.depthView?.texture.format;
        const pipeline = this._pipelines.getOrDefer('water', WaterProgram, {
            cullMode: 'none', vertex: 'model', builtFor: 'water', target: sceneTarget,
            depthStencil: depthFormat ? { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' } : undefined,
        });
        if (!pipeline) return;

        // The opaque scene's colour, for refraction: the transparents' copy, taken earlier here.
        const w = this._host.renderWidth, h = this._host.renderHeight;
        const fbo = this._targets.refraction = sizedTarget(this._targets.refraction, () => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }), w, h);
        this._passes.copyColors([this._targets.scene.colors[0]], [fbo.colors[0]], w, h);

        const sm = this._shaderManager;
        const cam = this._view.camera;
        const pass = this._passes.beginFullscreenPass(sceneTarget, 'water', false, undefined, false);
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
            const water = this._waterOf(node);
            const info = water.info;
            const look = WaterPasses._lookOf(node);
            const waves = node.waves();
            const oceanLevel = body && body.type === 'ocean' && body.endless ? body.level : null;
            if (!info && oceanLevel === null) continue;
            // The waves' reach: how far they can lift the surface (the culling box's height). They move it
            // up and down only, so nothing sideways.
            const heightScale = node.waveWindScale();
            // The local flow round the camera lifts it too: a cushion, a pillow, at most the head of fast water.
            const flowUp = oceanLevel === null && this._liveSim?.flowSurface ? LOCAL_FLOW_REACH : 0;
            // The live waves round the camera, on any water: a river's own, and the rings of what moves through.
            const live = this._liveSim && this._liveSim.live ? this._liveAmount(look) : 0;
            const liveUp = live > 0 ? LIVE_REACH * live : 0;
            // A river's mouths: the water it joins stands over it there with its own waves.
            const join = body && body.type === 'river' ? this._joinOf(node, water) : null;
            const joinUp = join ? this._joinReach(join) : 0;
            const up = Math.max(node.waveAmplitude + waveReach(waves, heightScale), joinUp) + Math.max(flowUp, liveUp), side = 0;
            // An ocean's surf stands taller than its waves over the beach.
            const surfUp = oceanLevel !== null && info ? 1.5 * surfOf(waves, heightScale, this._surf).amplitude : 0;
            // Round the camera, where the local flow or the live waves are drawn, the mesh is made fine enough to
            // show their lift.
            const fine = (flowUp > 0 || liveUp > 0) && this._liveSim ? [this._liveSim.origin[0], this._liveSim.origin[1], WAVE_SIM_SIDE] : null;
            const tiles = this._tilesOf(node, info, oceanLevel, up + surfUp, side, fine, water.tileDrawn, water.tileSteep);
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
            // The live waves' window, for the water that carries them.
            const window = this._liveSim && live > 0 ? [this._liveSim.origin[0], this._liveSim.origin[1], 1 / WAVE_SIM_SIDE, live] : [0, 0, 1, 0];
            sm.setUniform('u_vLive', window);
            sm.setUniform('u_fLive', window);
            const flowSurface = live > 0 && oceanLevel === null ? this._liveSim!.flowSurface : null;
            sm.setUniform('u_vLocal', [flowSurface ? 1 : 0, 0, 0, 0]);
            sm.setUniform('u_fLiveGrid', [1 / WAVE_SIM_SIZE, WAVE_SIM_CELL, body && body.type === 'river' ? 1 : 0, flowSurface ? 1 : 0]);
            const base = [
                this._targets.sceneDepth.depth, fbo.colors[0], env.cube ?? this._bindGroups.fallbackCube,
                water.tex0 ?? this._fallbackInfo(), water.tex1 ?? this._fallbackInfo(), this._detail(),
                this._liveSim && live > 0 ? this._liveSim.texture : this._detail(), this._foam(),
                flowSurface ?? this._detail(),
            ];
            const drawTiles = (list: readonly Tile[]) => {
                for (const tile of list) {
                    const quads = TILE_LODS[tile.lod];
                    sm.setUniform('u_tile', [tile.x0, tile.z0, tile.size, tile.ocean ? 0 : SKIRT]);
                    sm.setUniform('u_tileLod', tile.ocean
                        ? [quads, tile.ocean.morphStart, tile.ocean.morphEnd, 1]
                        : [quads, 0, 0, 0]);
                    this._passes.recordDraw(pass, meshes[tile.lod], 0, 0);
                    this.tilesDrawn++;
                }
            };
            this._joinUniforms(node, join, clock);
            const mouths = oceanLevel !== null ? this._seaMouths(node) : [];
            if (!mouths.length) {
                pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                    ...base, join && water.joinA ? water.joinA : this._fallbackJoin(0), join && water.joinB ? water.joinB : this._fallbackJoin(1),
                ]));
                drawTiles(tiles);
            } else {
                // The sea's tiles over a joined river's grid read that river's mouths; the rest none.
                const groups = new Map<SeaMouth | null, Tile[]>();
                for (const tile of tiles) {
                    const m = mouths.find(m => tile.x0 < m.box[2] && tile.x0 + tile.size > m.box[0] && tile.z0 < m.box[3] && tile.z0 + tile.size > m.box[1]) ?? null;
                    const list = groups.get(m);
                    if (list) list.push(tile); else groups.set(m, [tile]);
                }
                for (const [m, list] of groups) {
                    this._underUniforms(m);
                    pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                        ...base, m ? m.water.joinA! : this._fallbackJoin(0), m ? m.water.joinB! : this._fallbackJoin(1),
                    ]));
                    drawTiles(list);
                }
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

    /**
     * Step the live waves for this frame (render/waterWaves.ts), round the camera on the water's own clock: over
     * every water with a grid (and an endless sea's shore grid, and the open sea), when a river asks for its
     * waves or something crosses the surface in their window (the rings it throws run on for a while after).
     */
    private _liveWaves(scene: Scene, nodes: readonly WaterVolumeNode[]): void {
        const waters: WaveSimWater[] = [];
        const bodies: WaveSimBody[] = [];
        let river = false, sea = false, seaLevel: number | null = null, mask = 0;
        const now = performance.now(); // wall-clock: whether a node's list of bodies is this frame's
        for (const node of nodes) {
            const body = node.resolved();
            if (!body) continue;
            const water = this._waterOf(node);
            const endless = body.type === 'ocean' && body.endless;
            if (endless) { sea = true; seaLevel = body.level; }
            mask |= node.reactsTo;
            // Read every frame (reading is what keeps the node gathering it); taken while it is this frame's.
            const crossing = node.disturbances;
            if (now - node.disturbancesAt < DISTURBANCE_FRESH_MS) for (const d of crossing) bodies.push(d);
            if (!water.info || !water.tex0 || !water.tex1) continue;
            waters.push({ info: water.info, tex0: water.tex0, tex1: water.tex1, manning: node.bedRoughness, shore: endless });
            // A river with its Live waves at nought asks for none of its own.
            if (!endless) river = river || (node.flowReference() > 0 && WaterPasses._lookOf(node).liveWaves > 0);
        }
        const cam = this._view.camera;
        const clock = waterTime(this._view.windTime);
        // Something crossing the surface where the window will be (it is set ahead of the camera, within its side).
        const reach = WAVE_SIM_SIDE;
        const inWindow = bodies.some(b => Math.abs(b.x - cam.position[0]) < reach && Math.abs(b.z - cam.position[2]) < reach);
        if (inWindow) this._rippledAt = clock;
        const rippling = clock - this._rippledAt < RIPPLE_LINGER && clock >= this._rippledAt;
        this._river = river;
        this._rippleFade = river ? 1 : Math.min(1, Math.max(0, (RIPPLE_LINGER - (clock - this._rippledAt)) / RIPPLE_FADE));
        if ((!river && !rippling) || (!waters.length && !sea) || !WaterWaveSim.supported) {
            if (this._liveSim) this._liveSim.update(NaN, 0, 0, 0, 0, []);
            return;
        }
        if (!this._liveSim) this._liveSim = new WaterWaveSim(this._passes, this._fullscreen);
        // The camera looks down its view matrix's third row, negated.
        const v = cam.viewMatrix;
        const obstacles = this._obstaclesNear(scene, waters, cam.position[0], cam.position[2], isAllLayers(mask) ? ALL_LAYERS : mask, seaLevel);
        this._liveSim.update(clock, cam.position[0], cam.position[2], -v[2], -v[10], waters, this._detail(), obstacles,
            { bodies, sea, river });
    }

    /** When something last crossed the surface in the live waves' window (the water's clock). */
    private _rippledAt = -Infinity;
    /** Whether a river asks for its own live waves this frame, and how far the rings have faded out (0..1). */
    private _river = false;
    private _rippleFade = 1;

    /**
     * How tall the live waves are drawn on water with `look`: the material's Live waves while a river raises
     * its own, else the rings of what moves through it at their own height, fading out as they die down.
     */
    private _liveAmount(look: WaterLook): number {
        return this._river ? look.liveWaves : this._rippleFade;
    }

    /** What stands in the water round the camera, for the live waves: read from the scene at most four times a second. */
    private _footprints: { scene: Scene | null; at: number; mask: number; list: WaterObstacleFootprint[] } = { scene: null, at: -Infinity, mask: ALL_LAYERS, list: [] };

    /**
     * The static colliders on the layers in `mask` (the waters' Reacts to, together) standing in the water
     * round (`cx`, `cz`), as footprints at its surface; over the open sea (`seaLevel`), at its level.
     */
    private _obstaclesNear(scene: Scene, waters: readonly WaveSimWater[], cx: number, cz: number, mask: number,
                           seaLevel: number | null): WaterObstacleFootprint[] {
        const cached = this._footprints;
        const now = performance.now(); // wall-clock: how often the scene is walked, not a time-based effect
        if (cached.scene === scene && cached.mask === mask && now - cached.at < 250) return cached.list;
        const reach = WAVE_SIM_SIDE;
        const list: WaterObstacleFootprint[] = [];
        if (mask) for (const o of sceneObstacles(scene.nodes, [cx - reach, cz - reach, cx + reach, cz + reach], mask)) {
            const surface = surfaceRound(waters, o) ?? seaLevel;
            const footprint = surface === null ? null : obstacleFootprint(o, surface);
            if (footprint) list.push(footprint);
        }
        this._footprints = { scene, at: now, mask, list };
        return list;
    }

    // ---- per node ---------------------------------------------------------------------------------

    private _nodeUniforms(node: WaterVolumeNode, info: WaterInfo | null, oceanLevel: number | null, look: WaterLook,
                          waves: WaterWave[], t: number, scene: Scene): void {
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
        // The waves (physics/water/waves.ts), longest first, with what every pixel would otherwise work out
        // for each of them: heading, amplitude (the look's ripple strength folded in), drag; wavenumber,
        // length, frequency, and the slope variance of it and every shorter wave (what a pixel too coarse to
        // draw the rest adds to its roughness, all at once). Their phases follow from their index, on both sides.
        const packed = this._waves, packedK = this._waveK;
        packed.fill(0); packedK.fill(0);
        const n = WaterPasses._packWaves(waves, look, packed, packedK, 0);
        const heightScale = node.waveWindScale();
        sm.setUniform('u_waves', packed);
        sm.setUniform('u_waveK', packedK);
        sm.setUniform('u_waveParams', [n, t, heightScale, node.waveShoreFade]);
        // How far what rides the water is carried by its current, and the speed a river's waves are built for.
        sm.setUniform('u_vFlow', [look.flowStrength, node.flowReference(), 0, 0]);
        sm.setUniform('u_fWaves', packed);
        sm.setUniform('u_fWaveK', packedK);
        sm.setUniform('u_fWaveParams', [n, t, heightScale, waveSigma(waves)]);
        // The swell, the crest the shallows cap the waves against, and the body's share of its waves.
        sm.setUniform('u_swell', [node.waveAmplitude, node.waveFrequency, waveCrest(waves, heightScale), node.resolved()?.waveFactor ?? 1]);
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
        sm.setUniform('u_misc', [this._view.preExposure, look.flowScatter, under ? 1 : 0, 0]);

        void scene;
    }

    private readonly _surf = { omega: 0, amplitude: 0 };
    private readonly _waves = new Float32Array(WAVE_MAX * 4);
    private readonly _waveK = new Float32Array(WAVE_MAX * 4);

    /**
     * Waves (physics/water/waves.ts), longest first, into `packed` / `packedK` from vec4 `at`, as the shader reads
     * them: heading, amplitude (the look's ripple strength folded in), drag; wavenumber, length, frequency, and
     * the slope variance of it and every shorter wave. Returns how many.
     */
    private static _packWaves(waves: readonly WaterWave[], look: WaterLook, packed: Float32Array, packedK: Float32Array, at: number): number {
        const n = Math.min(WAVE_MAX, waves.length);
        for (let i = 0; i < n; i++) {
            const w = waves[i];
            const k = 2 * Math.PI / Math.max(0.01, w.wavelength);
            const a = w.amplitude * rippleShare(w.wavelength, look.detailStrength);
            packed.set([w.dirX, w.dirZ, a, w.drag], (at + i) * 4);
            packedK.set([k, w.wavelength, waveOmega(k), (k * a) ** 2 * WAVE_SLOPE_VARIANCE], (at + i) * 4);
        }
        for (let i = n - 2; i >= 0; i--) packedK[(at + i) * 4 + 3] += packedK[(at + i + 1) * 4 + 3];
        return n;
    }

    // ---- mouths (physics/water/joins.ts) ------------------------------------------------------------

    private readonly _jWaves = new Float32Array(2 * WAVE_MAX * 4);
    private readonly _jWaveK = new Float32Array(2 * WAVE_MAX * 4);
    private readonly _jVec = { params: new Float32Array(8), swell: new Float32Array(8), flow: new Float32Array(8), surf: new Float32Array(8),
        fParams: new Float32Array(8), fSwell: new Float32Array(8), fFlow: new Float32Array(8) };

    /**
     * A river's join textures, rebuilt when its mouths change (WaterVolumeNode.waterJoin): the field's eight
     * channels as two RGBA16F textures on the river's grid. Null when it has none.
     */
    private _joinOf(node: WaterVolumeNode, water: NodeWater): DrawnJoin | null {
        const join = water.info ? node.waterJoin() : null;
        const key = join ? join.key : '';
        if (water.joinKey === key && (!join || (water.joinA && water.joinB))) return water.join;
        water.joinKey = key;
        water.join = join;
        if (!join) return null;
        const f = join.field;
        const fit = (tex: Texture | null) => tex && tex.width === f.nx && tex.height === f.nz;
        if (!fit(water.joinA)) { this._retire(water.joinA); water.joinA = WaterPasses._infoTexture(f.nx, f.nz); }
        if (!fit(water.joinB)) { this._retire(water.joinB); water.joinB = WaterPasses._infoTexture(f.nx, f.nz); }
        const n = f.nx * f.nz, C = JOIN_CHANNELS;
        const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) { a[i * 4 + c] = f.data[i * C + c]; b[i * 4 + c] = f.data[i * C + 4 + c]; }
        WaterPasses._upload(water.joinA!, a, f.nx, f.nz);
        WaterPasses._upload(water.joinB!, b, f.nx, f.nz);
        return join;
    }

    /** How far the water a river joins can stand over the river's own resting surface at its mouths. */
    private _joinReach(join: DrawnJoin): number {
        let up = 0;
        for (const t of join.targets) {
            const scale = t.node.waveWindScale();
            const sea = t.node.resolved();
            const surf = sea && sea.type === 'ocean' && sea.endless ? 1.5 * surfOf(t.node.waves(), scale, this._surf).amplitude : 0;
            up = Math.max(up, Math.max(0, join.field.rise) + t.node.waveAmplitude + waveReach(t.node.waves(), scale) + surf);
        }
        return up;
    }

    /**
     * The join slots' uniforms (water.wgsl u_wvj, u_wfj): for a river with mouths, each joined water's waves,
     * swell, surf and clock, as that water's own draw packs them. `clock` is the waves' clock before any water's
     * wave speed.
     */
    private _joinUniforms(node: WaterVolumeNode, join: DrawnJoin | null, clock: number): void {
        const sm = this._shaderManager;
        const on = [join ? 1 : 0, 0, 0, 0];
        sm.setUniform('u_vjOn', on);
        sm.setUniform('u_fjOn', on);
        if (!join) return;
        const v = this._jVec;
        const packed = this._jWaves, packedK = this._jWaveK;
        packed.fill(0); packedK.fill(0);
        for (const a of Object.values(v)) a.fill(0);
        const band = [0, 0, 0, 0];
        join.targets.slice(0, 2).forEach((t, k) => {
            const target = t.node, body = target.resolved();
            if (!body || !target.enabled) return;
            band[k] = t.length;
            const look = WaterPasses._lookOf(target);
            const waves = target.waves();
            const n = WaterPasses._packWaves(waves, look, packed, packedK, k * WAVE_MAX);
            const scale = target.waveWindScale(), share = body.waveFactor ?? 1;
            const time = clock * target.waveSpeed;
            const sea = body.type === 'ocean' && body.endless;
            const crest = waveCrest(waves, scale);
            const surf = surfOf(waves, scale, this._surf);
            const surfOn = sea && !!target.drawnWater() ? 1 : 0;
            v.params.set([n, time, scale * share, target.waveShoreFade], k * 4);
            v.swell.set([target.waveAmplitude, target.waveFrequency, crest, sea ? 1 : 0], k * 4);
            v.flow.set([look.flowStrength, target.flowReference(), 0, 0], k * 4);
            v.surf.set([surf.omega, surf.amplitude, surfOn, 0], k * 4);
            v.fParams.set([n, time, scale * share, waveSigma(waves)], k * 4);
            v.fSwell.set([0, 0, crest, sea ? 1 : 0], k * 4);
            v.fFlow.set([look.flowStrength, target.flowReference(), target.waveShoreFade, 0], k * 4);
        });
        void node;
        sm.setUniform('u_vjBand', band);
        sm.setUniform('u_fjBand', band);
        sm.setUniform('u_vjParams', v.params);
        sm.setUniform('u_vjSwell', v.swell);
        sm.setUniform('u_vjFlow', v.flow);
        sm.setUniform('u_vjSurf', v.surf);
        sm.setUniform('u_vjWaves', packed);
        sm.setUniform('u_vjWaveK', packedK);
        sm.setUniform('u_fjParams', v.fParams);
        sm.setUniform('u_fjSwell', v.fSwell);
        sm.setUniform('u_fjFlow', v.fFlow);
        sm.setUniform('u_fjSurf', v.surf);
        sm.setUniform('u_fjWaves', packed);
        sm.setUniform('u_fjWaveK', packedK);
    }

    /** The rivers joined to an endless sea `node`, with their grids and join textures, for its tiles over them. */
    private _seaMouths(node: WaterVolumeNode): SeaMouth[] {
        const out: SeaMouth[] = [];
        for (const { river, join } of node.joinedMouths()) {
            const water = this._waterOf(river);
            const info = water.info;
            if (!info || this._joinOf(river, water) !== join || !water.joinA || !water.joinB) continue;
            const slot = join.targets.findIndex(t => t.node === node);
            if (slot < 0) continue;
            const h = info.cell / 2;
            out.push({ water, info, slot, length: join.targets[slot].length, drop: river.joinDrop(),
                box: [info.originX - h, info.originZ - h, info.originX + (info.nx - 0.5) * info.cell, info.originZ + (info.nz - 0.5) * info.cell] });
        }
        return out;
    }

    /** The sea-under-a-river uniforms for the sea's tiles over river mouth `m` (none: null). */
    private _underUniforms(m: SeaMouth | null): void {
        const sm = this._shaderManager;
        const on = [0, m ? 1 : 0, 0, 0];
        sm.setUniform('u_vjOn', on);
        sm.setUniform('u_fjOn', on);
        if (!m) return;
        const origin = [m.info.originX, m.info.originZ, m.info.cell, 0], size = [m.info.nx, m.info.nz, 0, 0];
        const under = [m.length, m.slot, m.drop, 0];
        sm.setUniform('u_vjGridOrigin', origin);
        sm.setUniform('u_vjGridSize', size);
        sm.setUniform('u_vjUnder', under);
        sm.setUniform('u_fjGridOrigin', origin);
        sm.setUniform('u_fjGridSize', size);
        sm.setUniform('u_fjUnder', under);
    }

    private readonly _joinFallback: (Texture | null)[] = [null, null];
    /** 1x1 join textures for water with no mouths: no seam near, nothing of a river drawn. */
    private _fallbackJoin(which: 0 | 1): Texture {
        let tex = this._joinFallback[which];
        if (!tex) {
            tex = WaterPasses._infoTexture(1, 1);
            WaterPasses._upload(tex, Float32Array.from(which === 0 ? [JOIN_FAR, 0, JOIN_FAR, JOIN_FAR] : [0, 0, -JOIN_FAR, 0]), 1, 1);
            this._joinFallback[which] = tex;
        }
        return tex;
    }

    /** Whether the camera is below this node's surface (and so sees it from underneath). */
    private _cameraUnder(node: WaterVolumeNode): boolean {
        const c = this._view.camera.position;
        const col = node.columnAt(c[0], c[2], waterTime(this._view.windTime));
        return !!col && c[1] < col.surface && c[1] > col.floor - 1;
    }

    /** Each node's water as this call of renderWater resolved it: once a call, so passes recorded on its textures keep them. */
    private readonly _frameWater = new Map<WaterVolumeNode, NodeWater>();

    /**
     * The node's water info and textures, rebuilt when its shapes, placement or the ground under it change.
     * Resolved once a renderWater call: the live waves record passes on its textures before the surface does,
     * and a rebuild in between would free textures those passes still use.
     */
    private _waterOf(node: WaterVolumeNode): NodeWater {
        const memo = this._frameWater.get(node);
        if (memo) return memo;
        const water = this._resolveWater(node);
        this._frameWater.set(node, water);
        return water;
    }

    private _resolveWater(node: WaterVolumeNode): NodeWater {
        let water = this._nodes.get(node);
        // What the node is drawn from (WaterVolumeNode.drawnWater: its grid and where on it the water ends),
        // shared with the physics, which must agree with it where two waters meet.
        const drawn = node.drawnWater();
        const key = drawn ? drawn.key : '';
        if (water && water.key === key) return water;
        const now = performance.now() / 1000; // wall-clock: when the GPU copy was last made
        const info = drawn ? drawn.info : null;
        if (!water) {
            water = { key, info: null, tex0: null, tex1: null, builtAt: now, tileDrawn: null, tileSteep: null, joinKey: '', join: null, joinA: null, joinB: null };
            this._nodes.set(node, water);
        }
        water.key = key;
        water.builtAt = now;
        water.info = info;
        water.tileDrawn = null;
        water.tileSteep = null;
        if (info) {
            const fit = (tex: Texture | null) => tex && tex.width === info.nx && tex.height === info.nz;
            if (!fit(water.tex0)) { this._retire(water.tex0); water.tex0 = WaterPasses._infoTexture(info.nx, info.nz); }
            if (!fit(water.tex1)) { this._retire(water.tex1); water.tex1 = WaterPasses._infoTexture(info.nx, info.nz); }
            const rel0 = info.info0.slice(), rel1 = info.info1.slice();
            // Where the water ends, finer than its cells (water/waterEdges.ts): its surface carried on level into
            // the dry cells, the shore distance, and how far inside what it draws each cell is (in the wet
            // flag's place: the shader draws where it is above nought). The sea's shore grid stays as physics
            // has it: its surf is timed by that distance, and its waterline is the landscape's already.
            const edges = drawn!.edges;
            if (edges) {
                for (let i = 0, n = info.nx * info.nz; i < n; i++) {
                    rel0[i * 4] = edges.surface[i];
                    rel0[i * 4 + 3] = edges.shore[i];
                    rel1[i * 4 + 3] = edges.draw[i];
                }
                water.tileDrawn = edges.tileDrawn;
                water.tileSteep = edges.tileSteep;
            }
            // Heights above the grid's lowest surface, the surface in two parts that add up (waterInfo.ts
            // heightQuantum): a coarse one half floats hold exactly and the remainder, in the channel the
            // wave share had (one number per node, now a uniform). A river's fall then reaches the GPU to a
            // fraction of a millimetre instead of in 3 cm terraces. The step is set by every height sent, the
            // dry cells' and another water's too.
            let reach = info.maxY - info.minY;
            for (let i = 0; i < rel0.length; i += 4) reach = Math.max(reach, Math.abs(rel0[i] - info.minY));
            const quantum = heightQuantum(reach), parts = [0, 0];
            for (let i = 0; i < rel0.length; i += 4) {
                splitHeight(rel0[i] - info.minY, quantum, parts);
                rel0[i] = parts[0]; rel1[i] = parts[1];
                rel1[i + 2] -= info.minY;
            }
            WaterPasses._upload(water.tex0!, rel0, info.nx, info.nz);
            WaterPasses._upload(water.tex1!, rel1, info.nx, info.nz);
        }
        return water;
    }

    /** Textures to free once the passes recorded this call have been submitted (the next call). */
    private readonly _retired: Texture[] = [];
    private _retire(tex: Texture | null): void { if (tex) this._retired.push(tex); }
    private _flushRetired(): void {
        for (const tex of this._retired) tex.delete();
        this._retired.length = 0;
    }

    /**
     * Drop the GPU side of nodes no longer in any scene: those out of the scene drawn now that are not in a
     * scene of their own either (another scene drawn in the same frame, a preview's, keeps its water). Freed
     * at the next call, once what this one records with them has been submitted.
     */
    private _forget(scene: Scene): void {
        for (const [node, water] of this._nodes) {
            if (scene.waterVolumes.has(node)) continue;
            const own = node.scene;
            if (own && own !== scene && own.waterVolumes.has(node)) continue;
            this._retire(water.tex0); this._retire(water.tex1); this._retire(water.joinA); this._retire(water.joinB);
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
     * The detail texture (water/waterTextures.ts: the ripples' slopes, and the noise the live waves'
     * turbulence is renewed with), made on first use, tiled, and MIPMAPPED: the shader picks a level by
     * distance, and an unfilled level is black (a raw-bytes upload fills level 0 only), so it goes up the
     * way an image does, which builds the chain on both backends.
     */
    private _detail(): Texture {
        if (!this._detailTexture) {
            const tex = new Texture({ mipMap: true, wrapping: 'repeat' });
            tex.createFromPixels(new Uint8ClampedArray(waterDetailPixels().buffer), WATER_DETAIL_SIZE, WATER_DETAIL_SIZE);
            this._detailTexture = tex;
        }
        return this._detailTexture;
    }

    private _foamTexture: Texture | null = null;
    /** The foam texture (water/waterTextures.ts): what an amount of foam is drawn with. Made and uploaded as the detail texture is. */
    private _foam(): Texture {
        if (!this._foamTexture) {
            const tex = new Texture({ mipMap: true, wrapping: 'repeat' });
            tex.createFromPixels(new Uint8ClampedArray(waterFoamPixels().buffer), WATER_FOAM_SIZE, WATER_FOAM_SIZE);
            this._foamTexture = tex;
        }
        return this._foamTexture;
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
    private _tilesOf(node: WaterVolumeNode, info: WaterInfo | null, oceanLevel: number | null, up: number, side: number,
                     fine: readonly number[] | null = null, drawn: Uint8Array | null = null, steep: Uint8Array | null = null): Tile[] {
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
            return r < 0.75 ? 0 : r < 1.5 ? 1 : r < 4 ? 2 : r < 10 ? 3 : 4;
        };
        if (info && info.tilesX > 0) {
            const span = info.tileCells * info.cell;
            // The tiles with any of it drawn: its water, and the apron under its banks (water/waterEdges.ts).
            const wet = drawn && drawn.length === info.tileWet.length ? drawn : info.tileWet;
            for (let tz = 0; tz < info.tilesZ; tz++) for (let tx = 0; tx < info.tilesX; tx++) {
                const k = tz * info.tilesX + tx;
                if (!wet[k]) continue;
                const x0 = info.originX + tx * span, z0 = info.originZ + tz * span;
                const y0 = info.tileMinY[k], y1 = info.tileMaxY[k];
                if (cull(x0, z0, span, y0, y1)) continue;
                const d = distanceTo(x0, z0, span, (y0 + y1) / 2);
                if (d > drawDistance) continue;
                // A steep tile (a cascade) keeps a vertex on every cell: coarser, its chords would cut across the drop.
                const lod = steep && steep[k] ? Math.min(STEEP_TILE_LOD, lodFor(d, span)) : lodFor(d, span);
                // Under the camera, in the local flow's window, a tile too coarse at its finest to show the
                // flow's lift (a pile a foot across) is drawn as smaller tiles, each with its own level of detail.
                if (fine && lod === 0 && span / TILE_LODS[0] > FINE_SPACING
                    && x0 < fine[0] + fine[2] && x0 + span > fine[0] && z0 < fine[1] + fine[2] && z0 + span > fine[1]) {
                    const k = Math.min(8, 2 ** Math.ceil(Math.log2(span / TILE_LODS[0] / FINE_SPACING)));
                    const sub = span / k;
                    for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) {
                        const sx = x0 + a * sub, sz = z0 + b * sub;
                        if (cull(sx, sz, sub, y0, y1)) continue;
                        const sd = distanceTo(sx, sz, sub, (y0 + y1) / 2);
                        if (sd > drawDistance) continue;
                        out.push({ x0: sx, z0: sz, size: sub, lod: lodFor(sd, sub), ocean: null });
                    }
                    continue;
                }
                out.push({ x0, z0, size: span, lod, ocean: null });
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

/** The mean surface of the water round an obstacle (its bounds and a couple of cells about them); null for none. */
function surfaceRound(waters: readonly WaveSimWater[], o: WaterObstacle): number | null {
    let sum = 0, count = 0;
    for (const { info } of waters) {
        const c = info.cell;
        const x0 = Math.max(0, Math.floor((o.min[0] - info.originX) / c) - 2), x1 = Math.min(info.nx - 1, Math.ceil((o.max[0] - info.originX) / c) + 2);
        const z0 = Math.max(0, Math.floor((o.min[2] - info.originZ) / c) - 2), z1 = Math.min(info.nz - 1, Math.ceil((o.max[2] - info.originZ) / c) + 2);
        if (x0 > x1 || z0 > z1) continue;
        const stride = Math.max(1, Math.ceil(Math.max(x1 - x0, z1 - z0) / 32));
        for (let z = z0; z <= z1; z += stride) for (let x = x0; x <= x1; x += stride) {
            const i = z * info.nx + x;
            if (info.info1[i * 4 + 3] < 0.5) continue;
            sum += info.info0[i * 4]; count++;
        }
    }
    return count ? sum / count : null;
}
