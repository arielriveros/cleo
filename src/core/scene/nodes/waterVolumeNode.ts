import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { finiteOr } from "../../math";
import { Logger } from "../../logger";
import { waveReach, wavesForCurrent, wavesForWind, type WaterWave } from "../../../physics/water/waves";
import { windFieldClock, WIND_REFERENCE_SPEED } from "../../wind/windField";
import { waterTime } from "../../../physics/water/waterClock";
import { ALL_LAYERS, LAYER, isAllLayers, storedMask } from "../../../physics/collisionLayers";
import type { PhysicsBody } from "../../../physics/physicsBody";
/** What the water reads back from a body it buoyed: where it is and how it moves, and its collision layer. */
type FloatingBody = { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; collisionFilterGroup?: number };
import { Node } from "./node";
import { authoring } from "../../eventBus";
import { WaterMaterial } from "../../../graphics/material";
import { WATER_VOLUME_PRESETS, type WaterVolumePreset } from "./waterVolumePresets";
import { applyPreset } from "../../presets";
import type { BuoyancyVolume } from "../../../physics/buoyancy";
import { buoyancyVolumeFromSpec, waterSpecColumn, type WaterFlowGrid, type WaterShoreGrid, type WaterSpec } from "../../../physics/waterSurface";
import { buildOceanShoreInfo, buildWaterInfo, type WaterInfo } from "../../../water/waterInfo";
import {
    clipMargin, clipWaterToShape, refineWaterEdges, waterJoinField, EDGE_APRON_CELLS, EDGE_BAND_CELLS,
    type JoinSample, type WaterEdges, type WaterJoinField,
} from "../../../water/waterEdges";
import { obstacleSpan, sceneObstacles, type WaterObstacle } from "../../../water/bake/obstacles";
import { shapesSignedEdge, YIELD_BELOW } from "../../../physics/water/waterColumn";
import { JOIN_CHANNELS, JOIN_FAR, joinLength, sampleChannel, type JoinGrid, type ScalarField, type WaterJoinSpec, type WaterUnderRiver } from "../../../physics/water/joins";
import { surfTravelTime } from "../../../physics/water/surf";
import { sceneGround } from "../../../water/ground";
import { waterGroupSignature } from "../../../water/bake/bakeNode";
import { GiBakeRegistry } from "../../../graphics/render/gi/giBakeRegistry";
import { decodeWaterBake } from "../../../water/bake/waterBakeFormat";
import { DEFAULT_WATER_LOOK } from "../../../water/waterLook";
import {
    legacyWaterShapes, normaliseWaterBody, normaliseWaterPoint, resolveWaterBody, retypeWaterBody, waterColumnAt,
    waterShapeFetch, type ResolvedWaterShape, type WaterBody, type WaterBodyType, type WaterCarve, type WaterColumn,
    type WaterPoint,
} from "../../../water/waterShapes";

export interface WaterVolumeOptions {
    /** Which body of water the node is (water/waterShapes.ts). Missing: a pool of `size` (the original volume). */
    waterType?: WaterBodyType;
    /** River: the centre line, upstream to downstream. Lake: the outline. Node-local. */
    points?: Partial<WaterPoint>[];
    /** Pool: full extents [x, depth, z] in metres, centred on the node; the top face is the surface. */
    size?: [number, number, number];
    /** Lake, ocean: metres, surface to floor. */
    depth?: number;
    /** Ocean: metres it reaches each way (0 = endless). */
    extent?: number;
    /** River, lake: how its bed is dug into the landscape. */
    carve?: Partial<WaterCarve>;
    /** River: the Water nodes (ids) it flows from and into. */
    connect?: { start?: string | null; end?: string | null };
    /** kg/m³. Fresh water 1000. */
    density?: number;
    /** Per second, at full submersion. */
    linearDrag?: number;
    angularDrag?: number;
    /** Metres: how far the surface rises and falls, so floating bodies bob. 0 = a flat surface. */
    waveAmplitude?: number;
    /** Hz of that bob. */
    waveFrequency?: number;
    /**
     * Wind (m/s) the waves are shaped for: their length, height and roughness grow with it and with how
     * much open water the body gives it. 0 = no waves, only the swell.
     */
    windSpeed?: number;
    /**
     * Metres of open water the wind has blown across (its fetch): the shorter, the shorter, steeper and
     * choppier the young sea it raises. 0 = what the body gives it (an endless ocean: the open sea, fully
     * developed).
     */
    fetch?: number;
    /** Degrees the waves travel toward (0 = +Z, 90 = +X). */
    waveDirection?: number;
    /** Multiplies wave height. */
    waveScale?: number;
    /** 0..1: how hard the long waves crowd the short ones onto their crests (0 none: an even, glassy chop). */
    choppiness?: number;
    /**
     * 0..2: how fast the waves and ripples run against their natural (deep-water) pace. 1 is real; below it
     * a calmer, slower sea. Physics follows it, so floating bodies ride the waves as drawn.
     */
    waveSpeed?: number;
    /** Metres from a shore over which waves die down (shoaling). */
    shoreFade?: number;
    /** Whether flowing water (rivers) carries floating bodies along. */
    currents?: boolean;
    /**
     * Whether the scene's Wind node raises and calms the waves: their height follows the wind's speed
     * against {@link windSpeed} (squared, as a sea's does), 0..2x. Their length and direction stay.
     */
    followWind?: boolean;
    /** The Water material the surface is drawn with (an embedded copy); null = the engine default look. */
    waterMaterial?: any;
    /** Editor-side link to the Material library asset that copy was taken from. */
    waterMaterialId?: string | null;
    /** The baked shallow-water flow (water/bake/), by id in the bake registry; null = analytic flow. */
    bakeId?: string | null;
    /**
     * Manning's roughness of the bed the bake runs the water over (0.01 smooth concrete, 0.03 a natural
     * channel, 0.1 a weedy, bouldery one): the rougher, the slower and deeper the water runs.
     */
    bedRoughness?: number;
    /** Whether character bodies are buoyed too. Off: a character capsule is mostly air and would launch. */
    affectCharacters?: boolean;
    /**
     * The collision layers the water reacts to (a mask; -1, the default, is every layer): bodies on them ripple
     * its surface and splash it, static colliders on them shape its flow (the live waves and the flow bake).
     * Buoyancy does not ask: whatever floats, floats.
     */
    reactsTo?: number;
    /**
     * How much spray the flowing water throws (0..2, default 1): droplets, mist and foam where it runs fast and
     * loses its energy (rapids), off the foot of a fall, up the face of what stands in a fast current, and off
     * bodies its current hits (water/spray/). 0 throws none.
     */
    spray?: number;
    /**
     * The model node showing the water. If its CustomMaterial declares vec4 uniforms `ripple0`..`ripple11`
     * (`[x, z, startTime, strength]`, startTime on the u_time clock), they are filled with ripples from
     * whatever moves through the water. A material without them is left alone.
     */
    surfaceNodeId?: string | null;
    /** Template instantiated at the surface for splashes ('' = none). */
    splashTemplate?: string;
    /**
     * Template for the splashes of something WADING, the footsteps of a character walking through
     * ('' = the entry {@link splashTemplate} for those too).
     */
    wadeSplashTemplate?: string;
    enabled?: boolean;
}

/** Ripple slots a surface material can declare (`ripple0`..`ripple11`). */
export const WATER_RIPPLE_SLOTS = 12;

/** Seconds between wake rings, and between footstep splashes, for something moving through the water. */
const WAKE_INTERVAL = 0.35;
const SPLASH_INTERVAL = 0.45;
/** Below this planar speed (m/s) a wading character leaves no wake. */
const WAKE_MIN_SPEED = 0.4;
/** A body or character entering faster than this (m/s, vertical) throws an entry splash. */
const ENTRY_SPLASH_SPEED = 1.2;
/** Global cap on splashes per second, so a pile of debris landing at once cannot flood the scene. */
const MAX_SPLASHES_PER_SECOND = 8;
/** Metres a body's waterline radius is taken as, at least and at most. */
const DISTURBANCE_MIN_RADIUS = 0.12;
const DISTURBANCE_MAX_RADIUS = 4;
/** Metres above the surface a body's bottom may be and still touch it (a hull's skin, a foot's sole). */
const DISTURBANCE_CLEARANCE = 0.05;
/** m/s past which a static body's move between two updates is a jump (a pooled collider placed anew), not a motion. */
const DISTURBANCE_TELEPORT_SPEED = 40;
/** Milliseconds a node keeps gathering what crosses its surface after its list was last read (by a renderer). */
const DISTURBANCE_WANTED_MS = 1000;

/**
 * Something crossing the water's surface this frame (WaterVolumeNode.disturbances): what the live waves round
 * the camera are raised by (render/waterWaves.ts, water/waveSim.ts bodyWavePush).
 */
export interface WaterDisturbance {
    /** World x and z of its centre (m). */
    x: number; z: number;
    /** Its waterline's radius (m): the disc of its footprint's area. */
    radius: number;
    /** 0..1: how much of it the surface cuts (1 while it spans the surface, less as it sinks under or lifts clear). */
    share: number;
    /** Its velocity against the water's own there (m/s): what it pushes the water with. */
    vx: number; vy: number; vz: number;
}

interface SourceState { inWater: boolean; nextWake: number; nextSplash: number; lastVy: number; }

/** A Water node's bake as drawn: its grid clipped to the water's shape, and the clip line per cell. */
interface ClippedBake {
    key: string;
    info: WaterInfo;
    clip: Float32Array;
    signature: string;
    /** What the clip was made against: the water's body and the water beside it. */
    shapes: string;
}

/** Metres the sea under a joined river is drawn down past the river's waves: the local flow's draw-down, and a hand's breadth. */
const JOIN_UNDER_LIFT = 0.8 + YIELD_BELOW;

/** A river's mouths (WaterVolumeNode.waterJoin): its join field and, per slot, the water joined and the band's length. */
export interface DrawnJoin {
    key: string;
    field: WaterJoinField;
    targets: { node: WaterVolumeNode; length: number }[];
}

/** Whether a water's drawn grid `info` has its own water at world (x, z) (its nearest cell is wet). */
function drawsAt(info: WaterInfo, x: number, z: number): boolean {
    const ix = Math.round((x - info.originX) / info.cell), iz = Math.round((z - info.originZ) / info.cell);
    if (ix < 0 || iz < 0 || ix >= info.nx || iz >= info.nz) return false;
    return info.info1[(iz * info.nx + ix) * 4 + 3] > 0.5;
}

/**
 * The water `node` draws at world (x, z), from what it is drawn with (`drawn`), as its surface reads it there
 * (water.wgsl): its resting surface, its shore distance, an endless sea's depth over its beach and its surf's
 * travel-time gradient, any other water's current.
 */
function targetAt(node: WaterVolumeNode, drawn: DrawnWater | null, x: number, z: number, out: JoinSample): void {
    const r = node.resolved()!;
    out.ux = 0; out.uz = 0; out.edge = JOIN_FAR; out.depth = JOIN_FAR; out.rest = r.level;
    if (!drawn) return;
    const g = drawn.info;
    const ch = (data: ArrayLike<number>, stride: number, c: number, px: number, pz: number) =>
        sampleChannel(data, stride, c, g.originX, g.originZ, g.cell, g.nx, g.nz, px, pz);
    if (r.type === 'ocean' && r.endless) {
        // Its shore grid where it covers the point (water.wgsl: past it the open sea), its gradient clamped.
        const fx = (x - g.originX) / g.cell + 0.5, fz = (z - g.originZ) / g.cell + 0.5;
        if (fx >= 0 && fz >= 0 && fx <= g.nx && fz <= g.nz) {
            out.edge = ch(g.info0, 4, 3, x, z);
            out.depth = Math.max(0, r.level - ch(g.info1, 4, 2, x, z));
        }
        const travel = (px: number, pz: number) => surfTravelTime(ch(g.info0, 4, 3, px, pz), r.level - ch(g.info1, 4, 2, px, pz));
        const d = g.cell;
        out.ux = (travel(x + d, z) - travel(x - d, z)) / (2 * d);
        out.uz = (travel(x, z + d) - travel(x, z - d)) / (2 * d);
        return;
    }
    const e = drawn.edges;
    out.rest = e ? ch(e.surface, 1, 0, x, z) : ch(g.info0, 4, 0, x, z);
    out.edge = e ? ch(e.shore, 1, 0, x, z) : ch(g.info0, 4, 3, x, z);
    out.ux = ch(g.info0, 4, 1, x, z); out.uz = ch(g.info0, 4, 2, x, z);
}

/** A join field cropped to its bands, three cells round them (past them nothing is joined: the border holds that). */
function cropJoin(field: WaterJoinField): JoinGrid | null {
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const b of field.bounds) if (b) { bx0 = Math.min(bx0, b[0]); bz0 = Math.min(bz0, b[1]); bx1 = Math.max(bx1, b[2]); bz1 = Math.max(bz1, b[3]); }
    if (!Number.isFinite(bx0)) return null;
    const c = field.cell, pad = 3;
    const x0 = Math.max(0, Math.round((bx0 - field.originX) / c) - pad), x1 = Math.min(field.nx - 1, Math.round((bx1 - field.originX) / c) + pad);
    const z0 = Math.max(0, Math.round((bz0 - field.originZ) / c) - pad), z1 = Math.min(field.nz - 1, Math.round((bz1 - field.originZ) / c) + pad);
    const nx = x1 - x0 + 1, nz = z1 - z0 + 1;
    if (nx < 2 || nz < 2) return null;
    const C = JOIN_CHANNELS;
    const data = new Float32Array(nx * nz * C);
    for (let z = 0; z < nz; z++) data.set(field.data.subarray(((z + z0) * field.nx + x0) * C, ((z + z0) * field.nx + x1 + 1) * C), z * nx * C);
    return { originX: field.originX + x0 * c, originZ: field.originZ + z0 * c, cell: c, nx, nz, data };
}

/** Milliseconds an unbaked grid stands while its water is being edited before it is built again. */
const DRAWN_REBUILD_MS = 200;

/**
 * What a Water node is drawn from (WaterVolumeNode.drawnWater): its grid, where on it the water ends (none for
 * an endless ocean's shore grid, whose waterline is the landscape's), and whether it is a bake's.
 */
export interface DrawnWater {
    key: string;
    info: WaterInfo;
    edges: WaterEdges | null;
    baked: boolean;
}

/** Water nodes being resolved or keyed right now: a cycle of rivers stops at the node it started from. */
const RESOLVING = new Set<WaterVolumeNode>();
const KEYING = new Set<WaterVolumeNode>();

/**
 * One body of water: a river, a lake, an ocean or a pool (water/waterShapes.ts). Everything dynamic inside it
 * is buoyed by the water it displaces and dragged by the water's motion (see physics/buoyancy.ts), and
 * whatever moves through it disturbs the surface — ripples on the water's material and splashes from a
 * template. A river joins other Water nodes by naming them: it flows from one and into another, meeting
 * their surface.
 *
 * The node's position is the body's origin (a pool's centre, a lake's or ocean's level); its scale
 * multiplies the body; its rotation is ignored: water stays level.
 */
export class WaterVolumeNode extends Node {
    private _water: WaterBody;
    private _density: number;
    private _linearDrag: number;
    private _angularDrag: number;
    private _waveAmplitude: number;
    private _waveFrequency: number;
    private _windSpeed: number;
    private _fetch: number;
    private _waveDirection: number;
    private _waveScale: number;
    private _choppiness: number;
    private _waveSpeed: number;
    private _shoreFade: number;
    private _currents: boolean;
    private _followWind: boolean;
    private _waterMaterial: WaterMaterial | null;
    private _waterMaterialId: string | null;
    private _bakeId: string | null;
    private _bedRoughness: number;
    private _affectCharacters: boolean;
    private _reactsTo: number;
    private _spray: number;
    private _surfaceNodeId: string | null;
    private _splashTemplate: string;
    private _wadeSplashTemplate: string;
    private _enabled: boolean;

    // ---- derived (cached) ----
    /** Bumped on every body or wave edit: what renderers and the bake compare against. */
    private _version = 0;
    private _resolved: ResolvedWaterShape | null = null;
    private _resolvedKey: string | null = null;
    private _waves: WaterWave[] | null = null;

    // ---- runtime ----
    /** The submerged fraction of every body the physics buoyed since the last update (max over substeps). */
    private _submerged = new Map<FloatingBody, number>();
    private _sources = new Map<object, SourceState>();
    private _ripples: number[][] = Array.from({ length: WATER_RIPPLE_SLOTS }, () => [0, 0, -1000, 0]);
    private _nextSlot = 0;
    private _splashBudget = MAX_SPLASHES_PER_SECOND;
    /** Templates that failed to instantiate (logged once by instantiate): not asked for again. */
    private _splashFailed = new Set<string>();
    /** What crossed the surface at the last update (see {@link disturbances}). */
    private _disturbances: WaterDisturbance[] = [];
    /** Kinematic bodies' positions at the last update: their velocity is how far they moved since. */
    private _lastPositions = new Map<object, [number, number, number]>();

    constructor(name: string, options: WaterVolumeOptions = {}, id: string = uuidv4()) {
        super(name, 'waterVolume', id);
        // No type is the original water volume: a pool (a box), centred on the node, its top the surface.
        this._water = normaliseWaterBody({ ...options, type: options.waterType ?? 'pool' });
        this._density = Math.max(1, finiteOr(options.density, 1000));
        this._linearDrag = Math.max(0, finiteOr(options.linearDrag, 2.5));
        this._angularDrag = Math.max(0, finiteOr(options.angularDrag, 0.5));
        this._waveAmplitude = Math.max(0, finiteOr(options.waveAmplitude, 0.03));
        this._waveFrequency = Math.max(0, finiteOr(options.waveFrequency, 0.6));
        this._windSpeed = Math.max(0, finiteOr(options.windSpeed, 0));
        this._fetch = Math.max(0, finiteOr(options.fetch, 0));
        this._waveDirection = finiteOr(options.waveDirection, 0);
        this._waveScale = Math.max(0, finiteOr(options.waveScale, 1));
        this._choppiness = Math.min(1, Math.max(0, finiteOr(options.choppiness, 0.5)));
        this._waveSpeed = Math.min(2, Math.max(0, finiteOr(options.waveSpeed, 1)));
        this._shoreFade = Math.max(0, finiteOr(options.shoreFade, 6));
        this._currents = options.currents !== false;
        this._followWind = !!options.followWind;
        this._waterMaterial = WaterVolumeNode._parseMaterial(options.waterMaterial);
        this._waterMaterialId = typeof options.waterMaterialId === 'string' && options.waterMaterialId ? options.waterMaterialId : null;
        this._bakeId = typeof options.bakeId === 'string' && options.bakeId ? options.bakeId : null;
        this._bedRoughness = Math.min(0.15, Math.max(0.005, finiteOr(options.bedRoughness, 0.03)));
        this._affectCharacters = !!options.affectCharacters;
        this._reactsTo = storedMask(Math.trunc(finiteOr(options.reactsTo, ALL_LAYERS)));
        this._spray = Math.min(2, Math.max(0, finiteOr(options.spray, 1)));
        this._surfaceNodeId = typeof options.surfaceNodeId === 'string' && options.surfaceNodeId ? options.surfaceNodeId : null;
        this._splashTemplate = typeof options.splashTemplate === 'string' ? options.splashTemplate : '';
        this._wadeSplashTemplate = typeof options.wadeSplashTemplate === 'string' ? options.wadeSplashTemplate : '';
        this._enabled = options.enabled !== false;
    }

    // ---- properties ----
    /** The body as plain data (water/waterShapes.ts). Replace it whole to edit it; it is normalised. */
    public get waterBody(): Readonly<WaterBody> { return this._water; }
    public set waterBody(v: Readonly<Partial<WaterBody>>) {
        this._water = normaliseWaterBody({ ...this._water, ...v });
        this._bodyChanged('waterBody');
    }

    /**
     * Which body of water this is. Changing it keeps what the two types share and starts the new type's own
     * fields (a river's centre line, a lake's outline) from their defaults.
     */
    public get waterType(): WaterBodyType { return this._water.type; }
    public set waterType(v: WaterBodyType) {
        const next = retypeWaterBody(this._water, v);
        if (next === this._water) return;
        this._water = next;
        this._bodyChanged('waterType');
    }

    /** River: the centre line, upstream to downstream. Lake: the outline. Node-local; empty for the other types. */
    public get points(): readonly WaterPoint[] { return this._water.points; }
    public set points(v: readonly Partial<WaterPoint>[]) {
        this._water = normaliseWaterBody({ ...this._water, points: (Array.isArray(v) ? v : []).map(p => normaliseWaterPoint(p)) });
        this._bodyChanged('points');
    }

    /** Pool: full extents [x, depth, z] in metres before the node scale. */
    public get size(): [number, number, number] { return [...this._water.size] as [number, number, number]; }
    public set size(v: [number, number, number]) {
        this._water = normaliseWaterBody({ ...this._water, size: [Math.abs(finiteOr(v?.[0], 10)), Math.abs(finiteOr(v?.[1], 2)), Math.abs(finiteOr(v?.[2], 10))] });
        this._bodyChanged('size');
    }

    /** Lake, ocean: metres, surface to floor (where the landscape is higher, it is the floor). */
    public get depth(): number { return this._water.depth; }
    public set depth(v: number) { this._water = normaliseWaterBody({ ...this._water, depth: v }); this._bodyChanged('depth'); }

    /** Ocean: metres it reaches each way from the node; 0 = endless, to the horizon. */
    public get extent(): number { return this._water.extent; }
    public set extent(v: number) { this._water = normaliseWaterBody({ ...this._water, extent: v }); this._bodyChanged('extent'); }

    /** River, lake: how the bed is dug into the landscape when Carve is run. */
    public get carve(): Readonly<WaterCarve> { return this._water.carve; }
    public set carve(v: Readonly<Partial<WaterCarve>>) {
        this._water = normaliseWaterBody({ ...this._water, carve: { ...this._water.carve, ...v } });
        this._bodyChanged('carve');
    }

    /** River: the Water node it starts in (a lake it drains, a river it branches from), by id; null = a spring. */
    public get flowsFrom(): string | null { return this._water.connect.start; }
    public set flowsFrom(v: string | null) {
        this._water = normaliseWaterBody({ ...this._water, connect: { ...this._water.connect, start: v || null } });
        this._bodyChanged('flowsFrom');
    }
    /** River: the Water node it ends in (a lake, the ocean, another river), by id; null = nowhere. */
    public get flowsInto(): string | null { return this._water.connect.end; }
    public set flowsInto(v: string | null) {
        this._water = normaliseWaterBody({ ...this._water, connect: { ...this._water.connect, end: v || null } });
        this._bodyChanged('flowsInto');
    }

    /**
     * Changes with every edit to the body or waves: compare it to know when to rebuild what they feed. A
     * river also depends on the water it joins: see {@link resolveKey}.
     */
    public get version(): number { return this._version; }

    private _bodyChanged(key: string): void {
        this._version++;
        this._resolvedKey = null;
        this._waves = null;
        this._notifyChange('component', key);
    }
    public get density(): number { return this._density; }
    public set density(v: number) { this._density = Math.max(1, finiteOr(v, this._density)); this._notifyChange('component', 'density'); }
    public get linearDrag(): number { return this._linearDrag; }
    public set linearDrag(v: number) { this._linearDrag = Math.max(0, finiteOr(v, this._linearDrag)); this._notifyChange('component', 'linearDrag'); }
    public get angularDrag(): number { return this._angularDrag; }
    public set angularDrag(v: number) { this._angularDrag = Math.max(0, finiteOr(v, this._angularDrag)); this._notifyChange('component', 'angularDrag'); }
    public get waveAmplitude(): number { return this._waveAmplitude; }
    public set waveAmplitude(v: number) { this._waveAmplitude = Math.max(0, finiteOr(v, this._waveAmplitude)); this._notifyChange('component', 'waveAmplitude'); }
    public get waveFrequency(): number { return this._waveFrequency; }
    public set waveFrequency(v: number) { this._waveFrequency = Math.max(0, finiteOr(v, this._waveFrequency)); this._notifyChange('component', 'waveFrequency'); }
    public get windSpeed(): number { return this._windSpeed; }
    public set windSpeed(v: number) { this._windSpeed = Math.max(0, finiteOr(v, this._windSpeed)); this._bodyChanged('windSpeed'); }
    public get fetch(): number { return this._fetch; }
    public set fetch(v: number) { this._fetch = Math.max(0, finiteOr(v, this._fetch)); this._bodyChanged('fetch'); }
    public get waveDirection(): number { return this._waveDirection; }
    public set waveDirection(v: number) { this._waveDirection = finiteOr(v, this._waveDirection); this._bodyChanged('waveDirection'); }
    public get waveScale(): number { return this._waveScale; }
    public set waveScale(v: number) { this._waveScale = Math.max(0, finiteOr(v, this._waveScale)); this._bodyChanged('waveScale'); }
    public get choppiness(): number { return this._choppiness; }
    public set choppiness(v: number) { this._choppiness = Math.min(1, Math.max(0, finiteOr(v, this._choppiness))); this._bodyChanged('choppiness'); }
    public get waveSpeed(): number { return this._waveSpeed; }
    public set waveSpeed(v: number) { this._waveSpeed = Math.min(2, Math.max(0, finiteOr(v, this._waveSpeed))); this._notifyChange('component', 'waveSpeed'); }
    public get shoreFade(): number { return this._shoreFade; }
    public set shoreFade(v: number) { this._shoreFade = Math.max(0, finiteOr(v, this._shoreFade)); this._bodyChanged('shoreFade'); }
    public get followWind(): boolean { return this._followWind; }
    public set followWind(v: boolean) { this._followWind = !!v; this._notifyChange('component', 'followWind'); }

    /**
     * What the waves' height is multiplied by right now: 1, or with {@link followWind} the scene wind's
     * speed against the wind the waves were shaped for, squared, 0..2. The renderer and the physics both
     * read it, so a calm that flattens the drawn sea flattens the one bodies ride too. A river's waves are
     * its current's, whatever the wind: always 1.
     */
    public waveWindScale(): number {
        if (this._water.type === 'river' || !this._followWind || !(this._windSpeed > 0)) return 1;
        const wind = (this._scene as any)?.wind;
        if (!wind || wind.enabled === false) return 0;
        const speed = Math.max(0, Number(wind.strength) || 0) * WIND_REFERENCE_SPEED;
        const r = speed / this._windSpeed;
        return Math.min(2, r * r);
    }

    public get currents(): boolean { return this._currents; }
    public set currents(v: boolean) { this._currents = !!v; this._notifyChange('component', 'currents'); }
    /** The Water material drawing the surface, or null for the default look. */
    public get waterMaterial(): WaterMaterial | null { return this._waterMaterial; }
    public set waterMaterial(v: WaterMaterial | null) { this._waterMaterial = v instanceof WaterMaterial ? v : null; this._notifyChange('component', 'waterMaterial'); }
    public get waterMaterialId(): string | null { return this._waterMaterialId; }
    public set waterMaterialId(v: string | null) { this._waterMaterialId = v || null; this._notifyChange('component', 'waterMaterialId'); }

    /** The bake drawing the surface's flow, or null for the analytic flow. */
    public get bakeId(): string | null { return this._bakeId; }
    public set bakeId(v: string | null) { this._bakeId = v || null; this._notifyChange('component', 'bakeId'); }
    public get bedRoughness(): number { return this._bedRoughness; }
    public set bedRoughness(v: number) {
        this._bedRoughness = Math.min(0.15, Math.max(0.005, finiteOr(v, this._bedRoughness)));
        this._signature = null;
        this._notifyChange('component', 'bedRoughness');
    }

    /**
     * What a bake of this water depends on: every water of the system it is baked with (everything joined to
     * it through a river), their bodies and placements, the water the system runs into, the ground under it
     * and the static obstacles in it (water/bake/bakeNode.ts waterGroupSignature). A bake whose signature no
     * longer matches is STALE, and the surface falls back to the unbaked water until it is baked again.
     */
    public bakeSignature(groundKey?: string): string {
        // The system and the scene round it are walked at most twice a second; this water's own body is
        // checked every time. A tool with no landscape node gives the ground's key itself (water/ground.ts
        // heightsRegionKey).
        const key = this.resolveKey();
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (groundKey === undefined && this._signature && this._signature.key === key && now - this._signature.at < 500) return this._signature.value;
        const value = waterGroupSignature(this, groundKey);
        if (groundKey === undefined) this._signature = { key, at: now, value };
        return value;
    }
    private _signature: { key: string; at: number; value: string } | null = null;

    private static _parseMaterial(json: any): WaterMaterial | null {
        if (!json) return null;
        if (json instanceof WaterMaterial) return json;
        try { return WaterMaterial.parse(json); } catch { return null; }
    }
    public get affectCharacters(): boolean { return this._affectCharacters; }
    public set affectCharacters(v: boolean) { this._affectCharacters = !!v; this._notifyChange('component', 'affectCharacters'); }
    /**
     * The collision layers the water reacts to, as a mask (-1: every layer): bodies on them ripple and splash
     * it, static colliders on them shape its flow. A bake's signature follows the colliders it keeps, so
     * unticking a layer a collider in the water is on makes the bake stale; ticking every layer changes nothing.
     */
    public get reactsTo(): number { return this._reactsTo; }
    public set reactsTo(v: number) {
        const next = storedMask(Math.trunc(finiteOr(v, ALL_LAYERS)));
        if (next === this._reactsTo) return;
        this._reactsTo = next;
        this._signature = null;
        this._notifyChange('component', 'reactsTo');
    }
    /** How much spray the flowing water throws (0..2, 1 the default; see {@link WaterVolumeOptions.spray}). */
    public get spray(): number { return this._spray; }
    public set spray(v: number) {
        const next = Math.min(2, Math.max(0, finiteOr(v, this._spray)));
        if (next === this._spray) return;
        this._spray = next;
        this._notifyChange('component', 'spray');
    }
    /** Whether a body or collider on `layer` (bits) is one the water reacts to. */
    public reactsToLayer(layer: number): boolean {
        return isAllLayers(this._reactsTo) || (layer & this._reactsTo) !== 0;
    }
    public get surfaceNodeId(): string | null { return this._surfaceNodeId; }
    public set surfaceNodeId(v: string | null) { this._surfaceNodeId = v || null; this._notifyChange('component', 'surfaceNodeId'); }
    public get splashTemplate(): string { return this._splashTemplate; }
    public set splashTemplate(v: string) { this._splashTemplate = v ?? ''; this._splashFailed.clear(); this._notifyChange('component', 'splashTemplate'); }
    public get wadeSplashTemplate(): string { return this._wadeSplashTemplate; }
    public set wadeSplashTemplate(v: string) { this._wadeSplashTemplate = v ?? ''; this._splashFailed.clear(); this._notifyChange('component', 'wadeSplashTemplate'); }
    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) { if (!!v === this._enabled) return; this._enabled = !!v; this._notifyChange('component', 'enabled'); }

    // ---- geometry ----

    /** The Water node one of a river's ends names, if it is in the scene (and is not this node). */
    private _target(which: 'start' | 'end'): WaterVolumeNode | null {
        if (this._water.type !== 'river') return null;
        const id = which === 'start' ? this._water.connect.start : this._water.connect.end;
        if (!id || id === this.id) return null;
        const n = (this._scene as any)?.getNodeById?.(id);
        return n instanceof WaterVolumeNode && n !== this ? n : null;
    }

    /** The Water nodes this river joins: what it flows from, then what it flows into (either may be missing). */
    public joinedNodes(): WaterVolumeNode[] {
        const out: WaterVolumeNode[] = [];
        for (const w of ['start', 'end'] as const) {
            const t = this._target(w);
            if (t && !out.includes(t)) out.push(t);
        }
        return out;
    }

    /** The rivers that run into this water or out of it: those whose Flows into or Flows from names it. */
    public joinedRivers(): WaterVolumeNode[] {
        const out: WaterVolumeNode[] = [];
        for (const n of ((this._scene as any)?.waterVolumes ?? []) as Iterable<WaterVolumeNode>) {
            if (n !== this && n.waterType === 'river' && (n.flowsInto === this.id || n.flowsFrom === this.id)) out.push(n);
        }
        return out;
    }

    /**
     * The water that carries on from this water's edge: the rivers running into it or out of it, resolved.
     * Where they stand, this water's edge is no shore (water/waterInfo.ts buildWaterInfo `beside`).
     */
    public beside(): ResolvedWaterShape[] {
        if (this._water.type === 'river') return [];
        const out: ResolvedWaterShape[] = [];
        for (const n of this.joinedRivers()) {
            const r = RESOLVING.has(n) ? null : n.resolved();
            if (r) out.push(r);
        }
        return out;
    }

    /** What {@link beside} depends on: the joined rivers' own keys. */
    public besideKey(): string {
        if (this._water.type === 'river') return '';
        return this.joinedRivers().map(n => n.resolveKey()).join(';');
    }

    /**
     * Everything the resolved body depends on: the body, the node's placement and, for a river, the same of
     * the water it joins (a lake that moves moves the river's mouth). Compare it to know when to rebuild.
     */
    public resolveKey(): string {
        if (KEYING.has(this)) return 'cycle';
        KEYING.add(this);
        try {
            const m = this.worldTransform;
            let key = `${this.id}:${this._version}|${m[12]},${m[13]},${m[14]}|${Math.hypot(m[0], m[1], m[2])},${Math.hypot(m[4], m[5], m[6])},${Math.hypot(m[8], m[9], m[10])}`;
            if (this._water.type === 'river') {
                const s = this._target('start'), e = this._target('end');
                key += `|from(${s ? s.resolveKey() : ''})into(${e ? e.resolveKey() : ''})`;
            }
            return key;
        } finally {
            KEYING.delete(this);
        }
    }

    /**
     * The body in world space, connections applied (water/waterShapes.ts); null when it has nothing to
     * resolve. Cached until the body, the node's placement or the water it joins change.
     */
    public resolved(): ResolvedWaterShape | null {
        const key = this.resolveKey();
        if (key === this._resolvedKey) return this._resolved;
        // A cycle of rivers: the one that started it keeps what it had.
        if (RESOLVING.has(this)) return this._resolved;
        RESOLVING.add(this);
        try {
            const m = this.worldTransform;
            const frame = { position: [m[12], m[13], m[14]], scale: [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])] };
            const targets = { start: this._target('start')?.resolved() ?? null, end: this._target('end')?.resolved() ?? null };
            this._resolved = resolveWaterBody(this._water, frame, this.id, targets);
            this._resolvedKey = key;
            this._waves = null;
        } finally {
            RESOLVING.delete(this);
        }
        return this._resolved;
    }

    /** The resolved body as a list (empty or one): what the shape-list helpers take. */
    public resolvedShapes(): ResolvedWaterShape[] {
        const r = this.resolved();
        return r ? [r] : [];
    }

    /**
     * The water this river HANDS OVER to where they overlap: the bodies it flows from and into. There, the
     * other node's water is the water (it draws it, it buoys what is in it), and the river's edge is no shore.
     */
    public handOver(): ResolvedWaterShape[] {
        const out: ResolvedWaterShape[] = [];
        for (const n of this.joinedNodes()) {
            const r = RESOLVING.has(n) ? null : n.resolved();
            if (r) out.push(r);
        }
        return out;
    }

    /**
     * The waves the surface is drawn with and bodies ride (physics/water/waves.ts). A river's are raised by
     * its own current (wavesForCurrent, for the speed {@link flowReference} gives), whatever the wind; any
     * other water's by the wind: {@link windSpeed} over {@link fetch} metres of open water, or what the body
     * gives, and none when the wind is 0.
     */
    public waves(): WaterWave[] {
        const r = this.resolved();
        const reference = this.flowReference();
        if (!this._waves || this._wavesFor !== reference) {
            this._wavesFor = reference;
            if (r && r.type === 'river') {
                this._waves = this._waveScale > 0 ? wavesForCurrent(reference, { scale: this._waveScale, choppiness: this._choppiness, seed: 0 }) : [];
            } else {
                const fetch = this._fetch > 0 ? this._fetch : r ? waterShapeFetch(r) : 0;
                this._waves = this._windSpeed > 0 && this._waveScale > 0
                    ? wavesForWind(this._windSpeed, this._waveDirection, fetch || 10,
                        { scale: this._waveScale, choppiness: this._choppiness, seed: 0 })
                    : [];
            }
        }
        return this._waves;
    }
    private _wavesFor = 0;

    /**
     * The speed a river's waves are built for (m/s): its baked current's typical speed, else the fastest it
     * was drawn to flow. Where its water runs faster or slower the waves are scaled (waves.ts flowWaveScale).
     * 0 for any other water, whose waves the wind raises.
     */
    public flowReference(): number {
        const r = this.resolved();
        if (!r || r.type !== 'river') return 0;
        this.bakedFlowGrid();
        if (this._flowGrid && this._flowGrid.grid && this._flowGrid.speed > 0) return this._flowGrid.speed;
        let fastest = 0;
        for (const q of r.samples) fastest = Math.max(fastest, q.speed);
        return fastest;
    }

    /** Metres from a shore over which this water's waves die down: a river's banks calm its chop within a stride. */
    public get waveShoreFade(): number {
        return this._water.type === 'river' ? Math.min(this._shoreFade, 1.5) : this._shoreFade;
    }

    /**
     * World-space box around the water, `max[1]` being the highest resting surface. Rotation is ignored.
     * An endless ocean makes it very large.
     */
    public worldBox(): { min: [number, number, number]; max: [number, number, number] } {
        const b = this.resolved();
        if (b) return { min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number] };
        const p = this.worldPosition;
        return { min: [p[0], p[1], p[2]], max: [p[0], p[1], p[2]] };
    }

    /**
     * The water over a world x/z: resting surface (no waves unless `time` is given), bed and flow. Null
     * where there is none.
     */
    public columnAt(x: number, z: number, time?: number, out?: WaterColumn): WaterColumn | null {
        if (time === undefined) return waterColumnAt(this.resolvedShapes(), x, z, out);
        return waterSpecColumn(this.buoyancySpec(), x, z, time, out, this._lookup);
    }

    /**
     * The water surface height at a world x/z at `time` seconds: the resting level plus the swell and
     * waves. Outside every shape, the highest resting level (plus the swell): where the water would be.
     */
    public surfaceHeightAt(x: number, z: number, time: number): number {
        const col = this.columnAt(x, z, time);
        if (col) return col.surface;
        const spec = this.buoyancySpec();
        const level = spec.max[1];
        if (!(spec.waveAmplitude > 0)) return level;
        return level + spec.waveAmplitude * Math.sin(time * spec.waveFrequency * Math.PI * 2 + x * 0.37 + z * 0.29);
    }

    /** Whether a world point is in the water (below the resting surface, above the bed). */
    public contains(p: ArrayLike<number>): boolean {
        const col = this.columnAt(p[0], p[2]);
        return !!col && p[1] >= col.floor && p[1] <= col.surface;
    }

    /** Depth of a world point below the resting surface (negative above it); -Infinity where there is no water. */
    public depthAt(p: ArrayLike<number>): number {
        const col = this.columnAt(p[0], p[2]);
        return col ? col.surface - p[1] : -Infinity;
    }

    /** What the physics step buoys with, at physics time `time`. */
    public buoyancyVolume(time: number): BuoyancyVolume {
        return buoyancyVolumeFromSpec(this.buoyancySpec(), time, this._lookup);
    }

    private _spec: { key: string; spec: WaterSpec } | null = null;

    /**
     * The water as plain data (see physics/waterSurface.ts): what the physics, on either thread, buoys with.
     * The same object while nothing it is built from changes (its `key` says what), so the physics worker is
     * sent it once; only the waves' height factor (the wind's) is refreshed on every call.
     */
    public buoyancySpec(): WaterSpec {
        const shore = this.oceanShoreInfo();
        const bake = this._bakeId ? `${this._bakeId}@${GiBakeRegistry.generation}` : '';
        // Where it meets the water it joins (a river's mouths), and where rivers run into it.
        const join = this.waterJoin();
        const here = this._joinsHere();
        const key = [this.resolveKey(), this._density, this._linearDrag, this._angularDrag, this._affectCharacters,
            this._waveAmplitude, this._waveFrequency, this._waveSpeed, this._shoreFade, this._currents, bake,
            shore ? this._shore!.key : '', this.flowReference(), this._flowAdvect(),
            join ? join.key : '', here.map(h => `${h.river.id}:${h.join.key}:${h.river.joinDrop()}`).join(';')].join('|');
        const waveScale = this.waveWindScale();
        if (this._spec && this._spec.key === key) { this._spec.spec.waveScale = waveScale; return this._spec.spec; }
        const box = this.worldBox();
        const shapes = this.resolvedShapes();
        const waves = this.waves();
        // A pool with nothing but the swell is the original water volume: buoyed by its box alone, the
        // cheapest path (and the one every existing scene was tuned on).
        const plainBox = shapes.length === 1 && shapes[0].type === 'pool' && !waves.length;
        const joined = this.joinedNodes().map(n => n.id);
        const spec: WaterSpec = {
            id: this.id, key, yieldsTo: joined.length ? joined : undefined,
            min: box.min, max: box.max, density: this._density,
            linearDrag: this._linearDrag, angularDrag: this._angularDrag, affectCharacters: this._affectCharacters,
            waveAmplitude: this._waveAmplitude, waveFrequency: this._waveFrequency,
            shapes: plainBox ? undefined : shapes,
            waves, waveScale, waveSpeed: this._waveSpeed, shoreFade: this.waveShoreFade, currents: this._currents,
            flowWaves: this.flowReference(), flowAdvect: this._flowAdvect(),
            flowGrid: plainBox ? undefined : this.bakedFlowGrid() ?? undefined,
            shoreGrid: shore ? WaterVolumeNode._shoreGrid(shore) : undefined,
            joins: join ? this._joinSpec(join) ?? undefined : undefined,
        };
        // The sea under the rivers joined to it is drawn down (water.wgsl): physics takes it down the same.
        const endless = shapes.length === 1 && shapes[0].type === 'ocean' && shapes[0].endless;
        if (endless && here.length) {
            const under: WaterUnderRiver[] = [];
            for (const h of here) {
                const grid = h.river._joinSpec(h.join);
                const slot = h.join.targets.findIndex(t => t.node === this);
                if (grid && slot >= 0) under.push({ field: grid.field, slot, length: h.join.targets[slot].length, drop: h.river.joinDrop() });
            }
            if (under.length) spec.underRivers = under;
        } else if (!plainBox) {
            spec.shoreFields = this._shoreFields(here);
        }
        this._spec = { key, spec };
        return spec;
    }

    /** How far the surface's waves ride the current: its Water material's Flow (the default look's when it has none). */
    private _flowAdvect(): number {
        return this._waterMaterial ? this._waterMaterial.look.flowStrength : DEFAULT_WATER_LOOK.flowStrength;
    }

    private _shore: { key: string; info: WaterInfo | null } | null = null;

    /**
     * An endless ocean's shore grid over the scene's landscapes (water/waterInfo.ts buildOceanShoreInfo): where
     * the beach is and how deep the sea is. The surface is drawn with it and physics reads it, so the waves
     * die down on the beach for both. Null for any other water, or with no landscape.
     */
    public oceanShoreInfo(): WaterInfo | null {
        const r = this.resolved();
        if (!r || r.type !== 'ocean' || !r.endless || !this._scene) return null;
        const ground = sceneGround(this._scene);
        const key = `${ground.key}|${r.level}`;
        if (this._shore && this._shore.key === key) return this._shore.info;
        const info = buildOceanShoreInfo(r.level, ground.sample, ground.bounds);
        this._shore = { key, info };
        return info;
    }

    /**
     * What this water is drawn from, and what physics reads where the two must agree (a river's mouth): its
     * grid (water/waterInfo.ts) and, for a lake, pool or river, where on it the water really ends
     * (water/waterEdges.ts). A current bake's grid when it has one, an endless ocean's shore grid, else the grid
     * built from its body over the ground, which the water it gives way to (`handOver`) and the rivers beside
     * it shape. Rebuilt when any of that changes, an unbaked grid at most five times a second while it is
     * being edited (a gizmo drag). `key` says which build it is: equal keys, the same data. Null with nothing
     * to draw.
     */
    public drawnWater(): DrawnWater | null {
        const body = this.resolved();
        if (!body) { this._drawn = null; return null; }
        const ground = this._scene ? sceneGround(this._scene) : { sample: null, key: '', bounds: null };
        const baked = this._bakeId ? this._clippedBake() : null;
        const endless = body.type === 'ocean' && body.endless;
        const key = baked ? `bake:${baked.key}`
            : endless ? `shore:${ground.key}|${body.level}`
            : `${this.resolveKey()}|${ground.key}|${this.besideKey()}`;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const last = this._drawn;
        if (last && last.key === key) return last.drawn;
        // Being edited: the last unbaked grid stands a little longer, rather than rebuilding on every move.
        if (!baked && !endless && last && last.drawn && !last.drawn.baked && last.drawn.info.source === 'analytic'
            && now - last.at < DRAWN_REBUILD_MS) return last.drawn;
        const info = baked ? baked.info
            : endless ? this.oceanShoreInfo()
            : buildWaterInfo(this.resolvedShapes(), ground.sample, { handOver: this.handOver(), beside: this.beside() });
        if (!info) { this._drawn = { key, at: now, drawn: null }; return null; }
        // A bake's edges are kept by what it is: any GI bake anywhere moves the registry on, and a grid a million
        // cells big is not refined again for that.
        const bakeKey = baked ? `${this._bakeId}|${baked.signature}|${baked.shapes}|${info.nx}x${info.nz}` : null;
        const edges = info.source === 'shore' ? null
            : bakeKey && this._bakedEdges && this._bakedEdges.key === bakeKey ? this._bakedEdges.edges
            : this._edgesOf(info, !!baked, ground.sample, baked ? baked.clip : null);
        if (bakeKey && edges) this._bakedEdges = { key: bakeKey, edges };
        const drawn: DrawnWater = { key, info, edges, baked: !!baked };
        this._drawn = { key, at: now, drawn };
        return drawn;
    }
    private _drawn: { key: string; at: number; drawn: DrawnWater | null } | null = null;
    private _bakedEdges: { key: string; edges: WaterEdges } | null = null;

    /** This node's bake decoded, once per registry change (null when it has none, or it is not in the registry). */
    private _decodedBake(): ReturnType<typeof decodeWaterBake> {
        const id = this._bakeId;
        if (!id) return null;
        const cached = this._decoded;
        if (cached && cached.id === id && cached.generation === GiBakeRegistry.generation) return cached.decoded;
        const bytes = GiBakeRegistry.get(id);
        const decoded = bytes ? decodeWaterBake(bytes, id) : null;
        this._decoded = { id, generation: GiBakeRegistry.generation, decoded };
        return decoded;
    }
    private _decoded: { id: string; generation: number; decoded: ReturnType<typeof decodeWaterBake> } | null = null;

    /**
     * This node's current bake as it is drawn and floated on: decoded, and on a copy clipped to the water's drawn
     * shape and a margin (water/waterEdges.ts clipWaterToShape): the simulation ran over a corridor round a river
     * and a basin round a lake, and what it left out there is not this water. The water this one joins counts as
     * its shape too (a mouth is kept on both sides); the endless sea's held water is never cut. Once per bake and
     * shape. Null without a current bake.
     */
    private _clippedBake(): ClippedBake | null {
        const decoded = this._decodedBake();
        if (!decoded || decoded.signature !== this.bakeSignature()) return null;
        const shapes = `${this.resolveKey()}|${this.besideKey()}`;
        const key = `${this._bakeId}|${GiBakeRegistry.generation}|${decoded.signature}|${shapes}`;
        if (this._clipped && this._clipped.key === key) return this._clipped;
        const src = decoded.info;
        const info: WaterInfo = { ...src, info0: src.info0.slice(), info1: src.info1.slice() };
        const own = this.resolvedShapes();
        const joined = [...this.handOver(), ...this.beside()];
        const sea = joined.some(r => r.type === 'ocean' && r.endless);
        const bounded = joined.filter(r => !(r.type === 'ocean' && r.endless));
        const margin = clipMargin(info.cell);
        const reach = margin + (EDGE_APRON_CELLS + EDGE_BAND_CELLS + 2) * info.cell;
        const keep = (x: number, z: number) => Math.max(own.length ? shapesSignedEdge(own, x, z, reach) : Infinity,
            bounded.length ? shapesSignedEdge(bounded, x, z, reach) : -reach);
        const clip = clipWaterToShape(info, keep, margin, !sea);
        this._clipped = { key, info, clip, signature: decoded.signature, shapes };
        return this._clipped;
    }
    private _clipped: ClippedBake | null = null;

    /**
     * Whether a static collider (on the layers this water reacts to) stands at world (x, z) as high as `level`:
     * a dry pocket in the water there is the cell round a post, drawn over. Gathered once per edge refinement.
     */
    private _wallsOver(info: WaterInfo): (x: number, z: number, level: number) => boolean {
        let list: WaterObstacle[] | null = null;
        return (x, z, level) => {
            if (!list) {
                const h = info.cell / 2;
                list = this._scene ? sceneObstacles((this._scene as any).nodes ?? [], [info.originX - h, info.originZ - h,
                    info.originX + (info.nx - 0.5) * info.cell, info.originZ + (info.nz - 0.5) * info.cell], this._reactsTo) : [];
            }
            for (const o of list) {
                const span = obstacleSpan(o, x, z);
                if (span && span[0] <= level) return true;
            }
            return false;
        };
    }

    /**
     * Where the water ends on its grid `info` (water/waterEdges.ts): with the ground under it, the edge of its
     * own body, and the edge of the water it gives way to or runs on into. A bake's members are cut from one
     * field, so they meet between the same cells without being told where the other one is.
     */
    private _edgesOf(info: WaterInfo, baked: boolean, ground: ((x: number, z: number) => number | null) | null,
                     clip: Float32Array | null = null): WaterEdges {
        const reach = (EDGE_APRON_CELLS + EDGE_BAND_CELLS + 2) * info.cell;
        const own = this.resolvedShapes();
        const others = [...this.handOver(), ...this.beside()];
        return refineWaterEdges(info, {
            baked,
            ground: ground ?? (() => null),
            shapeEdge: own.length ? (x, z) => shapesSignedEdge(own, x, z, reach) : null,
            otherEdge: !baked && others.length ? (x, z) => shapesSignedEdge(others, x, z, reach) : null,
            clipEdge: clip,
            walls: baked ? this._wallsOver(info) : null,
        });
    }

    /**
     * Where this river runs into the water it joins and that water takes over (physics/water/joins.ts): its
     * join field over its drawn grid (water/waterEdges.ts waterJoinField) and, per slot, the water joined and
     * the band's length. The surface draws the blend from it and physics floats on the same. Rebuilt when
     * what this river or the water it joins is drawn from changes. Null for any other water, or where no
     * mouth is found (a river falling into the sea off a cliff).
     */
    public waterJoin(): DrawnJoin | null {
        if (this._water.type !== 'river') return null;
        const drawn = this.drawnWater();
        const r = this.resolved();
        const targets = this.joinedNodes().filter(n => !RESOLVING.has(n) && n.resolved());
        if (!drawn || !drawn.edges || !r || r.samples.length < 2 || !targets.length) { this._join = null; return null; }
        const tDrawn = targets.map(t => t.drawnWater());
        const key = `${drawn.key}#${targets.map((t, k) => `${t.id}:${tDrawn[k]?.key ?? ''}:${t.enabled ? 1 : 0}`).join(',')}`;
        if (this._join && this._join.key === key) return this._join.join;
        const info = drawn.info, edges = drawn.edges;
        const n = info.nx * info.nz;
        // Which joined water each cell this river hands over is: as it was handed over (an unbaked grid); a
        // bake's, the joined water drawing it, else the sea it runs into (held at its level there).
        let owner: Int8Array;
        if (!drawn.baked && info.handedBy && info.handedBy.length === n) owner = info.handedBy;
        else {
            owner = new Int8Array(n).fill(-1);
            const sea = targets.findIndex(t => { const b = t.resolved(); return !!b && b.type === 'ocean' && b.endless; });
            for (let i = 0; i < n; i++) {
                if (info.info1[i * 4 + 3] > 0.5 || !(info.info0[i * 4 + 3] > 0)) continue;
                const x = i % info.nx, z = (i - x) / info.nx;
                const wx = info.originX + x * info.cell, wz = info.originZ + z * info.cell;
                let k = tDrawn.findIndex((d, j) => j !== sea && !!d && drawsAt(d.info, wx, wz));
                if (k < 0) k = sea;
                owner[i] = k;
            }
        }
        const first = r.samples[0], last = r.samples[r.samples.length - 1];
        const lengths = targets.map(t => {
            const atStart = this._target('start') === t, atEnd = this._target('end') === t;
            const width = Math.max(atStart ? first.width : 0, atEnd ? last.width : 0);
            return joinLength(width, last.dist);
        });
        const at = (k: number, x: number, z: number, out: JoinSample) => targetAt(targets[k], tDrawn[k], x, z, out);
        const reach = (EDGE_APRON_CELLS + EDGE_BAND_CELLS + 2) * info.cell;
        const own = this.resolvedShapes(), others = this.handOver();
        const field = waterJoinField(info, edges, {
            owner, lengths, at,
            shapeEdge: own.length ? (x, z) => shapesSignedEdge(own, x, z, reach) : null,
            otherEdge: !drawn.baked && others.length ? (x, z) => shapesSignedEdge(others, x, z, reach) : null,
        });
        const join: DrawnJoin | null = field ? { key, field, targets: targets.map((node, k) => ({ node, length: lengths[k] })) } : null;
        this._join = { key, join };
        return join;
    }
    private _join: { key: string; join: DrawnJoin | null } | null = null;

    /**
     * Metres the sea is drawn down under a river joined to it, upstream of its mouth (water.wgsl, the sea under a
     * river): past the river's waves and the local flow's draw-down, so it never pokes up through the river.
     */
    public joinDrop(): number {
        return this._waveAmplitude + waveReach(this.waves(), this.waveWindScale()) + JOIN_UNDER_LIFT;
    }

    /** This river's join field as physics reads it: cropped to its bands. */
    private _joinSpec(join: DrawnJoin): WaterJoinSpec | null {
        const grid = cropJoin(join.field);
        if (!grid) return null;
        return { field: grid, rise: join.field.rise, targets: join.targets.map(t => ({ id: t.node.id, length: t.length })) };
    }

    /**
     * Where rivers run into this water: its refined shore distance round each mouth (what the surface fades its
     * waves by, which counts the river's water as water), so a body there rides the waves drawn.
     */
    private _shoreFields(joins: readonly { river: WaterVolumeNode; join: DrawnJoin }[]): ScalarField[] | undefined {
        const drawn = this.drawnWater();
        if (!drawn || !drawn.edges || !joins.length) return undefined;
        const { info, edges } = drawn;
        const out: ScalarField[] = [];
        for (const { join } of joins) join.targets.forEach((t, k) => {
            const b = join.field.bounds[k];
            if (t.node !== this || !b) return;
            const pad = 3 * info.cell + join.field.cell;
            const x0 = Math.max(0, Math.floor((b[0] - pad - info.originX) / info.cell)), x1 = Math.min(info.nx - 1, Math.ceil((b[2] + pad - info.originX) / info.cell));
            const z0 = Math.max(0, Math.floor((b[1] - pad - info.originZ) / info.cell)), z1 = Math.min(info.nz - 1, Math.ceil((b[3] + pad - info.originZ) / info.cell));
            if (x1 - x0 < 1 || z1 - z0 < 1) return;
            const nx = x1 - x0 + 1, nz = z1 - z0 + 1;
            const data = new Float32Array(nx * nz);
            for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) data[z * nx + x] = edges.shore[(z + z0) * info.nx + x + x0];
            out.push({ originX: info.originX + x0 * info.cell, originZ: info.originZ + z0 * info.cell, cell: info.cell, nx, nz, data });
        });
        return out.length ? out : undefined;
    }

    /** The rivers joined to this water whose mouths are found, with their join fields (the renderer's sea draws under them). */
    public joinedMouths(): { river: WaterVolumeNode; join: DrawnJoin }[] { return this._joinsHere(); }

    /** The rivers joined to this water whose mouths are found, with their join fields. */
    private _joinsHere(): { river: WaterVolumeNode; join: DrawnJoin }[] {
        const out: { river: WaterVolumeNode; join: DrawnJoin }[] = [];
        for (const river of this.joinedRivers()) {
            if (!river.enabled || RESOLVING.has(river)) continue;
            const join = river.waterJoin();
            if (join && join.targets.some(t => t.node === this)) out.push({ river, join });
        }
        return out;
    }

    /** The water nodes' specs by id, as the step has them: a river's mouth reads the water it joins. */
    private readonly _lookup = (id: string): WaterSpec | undefined => {
        const n = (this._scene as any)?.getNodeById?.(id);
        return n instanceof WaterVolumeNode && n.enabled && n !== this ? n.buoyancySpec() : undefined;
    };

    /** The shore grid as physics reads it: metres to the shore and the bed, per cell. */
    private static _shoreGrid(info: WaterInfo): WaterShoreGrid {
        const n = info.nx * info.nz;
        const data = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { data[i * 2] = info.info0[i * 4 + 3]; data[i * 2 + 1] = info.info1[i * 4 + 2]; }
        return { originX: info.originX, originZ: info.originZ, cell: info.cell, nx: info.nx, nz: info.nz, data };
    }

    private _flowGrid: { key: string; grid: WaterFlowGrid | null; speed: number; stale: boolean } | null = null;
    private _staleSince = 0;
    private _staleTold: string | null = null;

    /**
     * A bake that no longer matches what it was baked from is dropped for the water as drawn, which is easy
     * to miss: the Console says so, once per bake, when it has stayed stale a few seconds (a scene still
     * loading its landscape and colliders is not stale yet).
     */
    private _noteStale(stale: boolean): void {
        if (!stale) { this._staleSince = 0; return; }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!this._staleSince) { this._staleSince = now; return; }
        if (now - this._staleSince < 3000 || this._staleTold === this._bakeId) return;
        this._staleTold = this._bakeId;
        Logger.warn(`Water "${this.name}": its flow bake no longer matches the water, the ground or the colliders it was baked over, so the water is drawn unbaked. Bake flow again.`, 'Water');
    }

    /**
     * The current bake (if any, and not stale) as physics reads it, cell for cell: what floats follows the
     * baked currents, right to the banks. Cached per bake and registry change.
     *
     * Its water is this node's own cells and, two cells on, the water of whatever it meets (the lake at a
     * river's mouth, the river at a lake's outlet: the same simulated field, cut in two for drawing). Both
     * grids then cover the seam, with the same surface and current, so a floating body is never between two
     * waters with neither under it; which of the two it is in there is the physics' usual choice.
     */
    public bakedFlowGrid(): WaterFlowGrid | null {
        if (!this._bakeId || !GiBakeRegistry.has(this._bakeId)) return null;
        const key = `${this._bakeId}|${GiBakeRegistry.generation}|${this.bakeSignature()}|${this.resolveKey()}|${this.besideKey()}`;
        if (this._flowGrid && this._flowGrid.key === key) { this._noteStale(this._flowGrid.stale); return this._flowGrid.grid; }
        // The bake as it is drawn: clipped to the water's shape, so nothing floats on water that is not there.
        const decoded = this._decodedBake();
        const clipped = this._clippedBake();
        let grid: WaterFlowGrid | null = null;
        let speed = 0;
        if (clipped) {
            const info = clipped.info;
            const nx = info.nx, nz = info.nz;
            const data = new Float32Array(nx * nz * 3);
            let squares = 0, cells = 0;
            const own = (x: number, z: number) => x >= 0 && z >= 0 && x < nx && z < nz && info.info1[(z * nx + x) * 4 + 3] > 0.5;
            for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
                const i = z * nx + x, o = i * 3;
                let wet = info.info1[i * 4 + 3] > 0.5;
                if (wet) { const u = info.info0[i * 4 + 1], v = info.info0[i * 4 + 2]; squares += u * u + v * v; cells++; }
                else if (info.info0[i * 4 + 3] > 0) {
                    // Water of the system that another node draws: this node's too within two cells of its own.
                    for (let dz = -2; dz <= 2 && !wet; dz++) for (let dx = -2; dx <= 2 && !wet; dx++) wet = own(x + dx, z + dz);
                }
                data[o] = wet ? info.info0[i * 4] : NaN;
                data[o + 1] = wet ? info.info0[i * 4 + 1] : 0;
                data[o + 2] = wet ? info.info0[i * 4 + 2] : 0;
            }
            grid = { originX: info.originX, originZ: info.originZ, cell: info.cell, nx, nz, data };
            // The current's typical speed (root mean square over its water), to a tenth: what its waves are built for.
            speed = cells ? Math.round(Math.sqrt(squares / cells) * 10) / 10 : 0;
        }
        const stale = !!decoded && !grid;
        this._flowGrid = { key, grid, speed, stale };
        this._noteStale(stale);
        return grid;
    }

    /** Called by the physics step for every body it buoyed. */
    public recordSubmerged(body: FloatingBody, fraction: number): void {
        this._submerged.set(body, Math.max(this._submerged.get(body) ?? 0, fraction));
    }

    /** The ripple slots as last written (`[x, z, startTime, strength]` each). For tests and tools. */
    public get ripples(): readonly (readonly number[])[] { return this._ripples; }

    // ---- surface activity (runs only while the scene updates, i.e. in play) ----

    public update(delta: number, time: number): void {
        super.update(delta, time);
        if (!this._enabled) { this._submerged.clear(); this._clearDisturbances(); return; }
        try {
            this._surfaceActivity(delta);
        } finally {
            this._submerged.clear();
        }
    }

    /**
     * What crossed the surface at the last update, on the layers the water {@link reactsTo}: each body's
     * waterline and its motion against the water's own. Only while the game runs (Play, Simulate): in Edit the
     * list is empty. The renderer's live waves are raised by it (render/waterWaves.ts).
     *
     * Reading it asks for it: the node gathers the list only while something reads it (within a second), so a
     * game with nothing drawing its water (a headless host) pays nothing for it.
     */
    public get disturbances(): readonly WaterDisturbance[] {
        this._disturbancesRead = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return this._disturbances;
    }
    /** When {@link disturbances} was last gathered (performance.now() ms): a paused game's list goes stale. */
    public get disturbancesAt(): number { return this._disturbancesAt; }
    private _disturbancesAt = -Infinity;
    private _disturbancesRead = -Infinity;

    private _clearDisturbances(): void {
        this._disturbances.length = 0;
        this._lastPositions.clear();
    }

    private readonly _aabb = new Float64Array(6);

    /**
     * Gather {@link disturbances}: every physics body on a layer the water reacts to whose bounds cross the
     * surface, dynamic or moved by its node (a static body that moved since the last update). Triggers and
     * bodies that take no part in the solver are left out, and so is a sleeping body (it does not move).
     */
    private _gatherDisturbances(delta: number): void {
        const out = this._disturbances;
        out.length = 0;
        const wallNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._disturbancesAt = wallNow;
        const scene = this._scene as any;
        const bodies = scene?.physics?.bodies as readonly PhysicsBody[] | undefined;
        if (authoring.enabled || !this._reactsTo || !bodies || !bodies.length || wallNow - this._disturbancesRead > DISTURBANCE_WANTED_MS) {
            this._lastPositions.clear();
            return;
        }
        const box = this.worldBox();
        const margin = DISTURBANCE_MAX_RADIUS;
        const time = waterTime(WaterVolumeNode._now());
        const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
        // How far the surface can stand off its resting height (the waves and the swell, and a metre for a bake's
        // water against the drawn shape's): what is clear of that band is not asked about the waves.
        const band = this._waveAmplitude + waveReach(this.waves(), this.waveWindScale()) + 1;
        const seen = new Set<object>();
        const a = this._aabb;
        for (const body of bodies) {
            if (body.isTrigger || !body.collisionResponse) continue;
            const p = body.position;
            if (p.x < box.min[0] - margin || p.x > box.max[0] + margin || p.z < box.min[2] - margin || p.z > box.max[2] + margin
                || p.y < box.min[1] - margin || p.y > box.max[1] + margin) continue;
            if (!this.reactsToLayer(body.collisionFilterGroup)) continue;
            let vx: number, vy: number, vz: number;
            if (body.isDynamic) {
                if (body.isSleeping) continue;
                vx = body.velocity.x; vy = body.velocity.y; vz = body.velocity.z;
            } else {
                // A static body moved by its node (a platform, a boat on rails, a swung prop): its velocity is
                // how far it went since the last update. One that has not moved is the bank, not a disturbance.
                const last = this._lastPositions.get(body);
                seen.add(body);
                if (!last) { this._lastPositions.set(body, [p.x, p.y, p.z]); continue; }
                const dt = Math.max(delta, 1e-4);
                vx = (p.x - last[0]) / dt; vy = (p.y - last[1]) / dt; vz = (p.z - last[2]) / dt;
                last[0] = p.x; last[1] = p.y; last[2] = p.z;
                if (vx === 0 && vy === 0 && vz === 0) continue;
                // A jump, not a motion: a pooled collider (the foliage's) set somewhere new, a respawn.
                if (vx * vx + vy * vy + vz * vz > DISTURBANCE_TELEPORT_SPEED * DISTURBANCE_TELEPORT_SPEED) continue;
            }
            body.getAabb(a);
            const cx = (a[0] + a[3]) / 2, cz = (a[2] + a[5]) / 2;
            const rest = this.columnAt(cx, cz, undefined, col);
            if (!rest || a[1] > rest.surface + band || a[4] < rest.surface - band - DISTURBANCE_MAX_RADIUS) continue;
            const here = this.columnAt(cx, cz, time, col);
            if (!here) continue;
            const surface = here.surface;
            const hx = (a[3] - a[0]) / 2, hz = (a[5] - a[2]) / 2;
            const radius = Math.min(DISTURBANCE_MAX_RADIUS, Math.max(DISTURBANCE_MIN_RADIUS, Math.sqrt(Math.max(hx, 0) * Math.max(hz, 0))));
            // All of it while it spans the surface; less as its bottom lifts clear or its top sinks a radius under.
            const lifted = Math.max(0, a[1] - surface) / DISTURBANCE_CLEARANCE;
            const sunk = Math.max(0, surface - a[4]) / radius;
            const share = Math.max(0, 1 - lifted) * Math.max(0, 1 - sunk);
            if (share <= 0) continue;
            // Against the water's own motion: its current and the orbits of the waves it rides. A log carried
            // down a river, or a buoy riding the swell, moves with the water and raises nothing.
            vx -= here.flowX + (here.waveVX ?? 0);
            vz -= here.flowZ + (here.waveVZ ?? 0);
            vy -= here.waveVY ?? 0;
            out.push({ x: cx, z: cz, radius, share, vx, vy, vz });
        }
        for (const key of this._lastPositions.keys()) if (!seen.has(key)) this._lastPositions.delete(key);
    }

    /** The clock the ripples are stamped on: the renderer's `u_time`, its render clock (`windFieldClock`). */
    private static _now(): number { return windFieldClock.time; }

    private _surfaceActivity(delta: number): void {
        const scene = this._scene;
        if (!scene) return;
        const now = WaterVolumeNode._now();
        this._splashBudget = Math.min(MAX_SPLASHES_PER_SECOND, this._splashBudget + delta * MAX_SPLASHES_PER_SECOND);
        const seen = new Set<object>();
        const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
        this._gatherDisturbances(delta);

        // Characters wading: feet below the surface, inside the box.
        for (const c of scene.characters) {
            if (!this.reactsToLayer(c.body?.collisionFilterGroup ?? LAYER.DEFAULT)) continue;
            const p = c.worldPosition;
            const here = this.columnAt(p[0], p[2], undefined, col);
            const depth = here ? here.surface - p[1] : -Infinity;
            const level = here ? here.surface : 0;
            // Feet below the surface and not below the floor (a character under the volume is not in it).
            const wading = !!here && depth > 0.02 && p[1] >= here.floor - 0.5;
            const state = this._state(c);
            seen.add(c);
            const v = c.currentVelocity;
            const planar = Math.hypot(v[0], v[2]);
            if (wading && !state.inWater) {
                this._ripple(p[0], p[2], now, Math.min(1, 0.5 + Math.abs(v[1]) * 0.2 + planar * 0.1));
                if (Math.abs(v[1]) > ENTRY_SPLASH_SPEED || planar > 2) this._splash(p[0], level, p[2], this._splashTemplate);
                state.nextWake = now + WAKE_INTERVAL;
                state.nextSplash = now + SPLASH_INTERVAL;
            } else if (wading && planar > WAKE_MIN_SPEED) {
                if (now >= state.nextWake) {
                    this._ripple(p[0], p[2], now, Math.min(1, 0.25 + planar * 0.12));
                    state.nextWake = now + WAKE_INTERVAL;
                }
                if (now >= state.nextSplash) {
                    this._splash(p[0], level, p[2], this._wadeSplashTemplate || this._splashTemplate);
                    state.nextSplash = now + SPLASH_INTERVAL;
                }
            }
            state.inWater = wading;
        }

        // Floating (or sinking) bodies: a ring when one enters, and as it bobs.
        for (const [body, fraction] of this._submerged) {
            if (!this.reactsToLayer(body.collisionFilterGroup ?? LAYER.DEFAULT)) continue;
            seen.add(body);
            const state = this._state(body);
            const vy = body.velocity.y;
            const x = body.position.x, z = body.position.z;
            const level = this.columnAt(x, z, undefined, col)?.surface ?? body.position.y;
            if (!state.inWater) {
                this._ripple(x, z, now, Math.min(1, 0.4 + Math.abs(vy) * 0.15));
                if (Math.abs(vy) > ENTRY_SPLASH_SPEED) this._splash(x, level, z, this._splashTemplate);
                state.nextWake = now + WAKE_INTERVAL;
            } else if (fraction < 0.98 && now >= state.nextWake) {
                // At the surface rather than sunk: rings as it bobs (a turn of vertical direction) or drifts.
                const planar = Math.hypot(body.velocity.x, body.velocity.z);
                const turned = (vy > 0) !== (state.lastVy > 0) && Math.abs(vy - state.lastVy) > 0.02;
                if (turned || planar > 0.3) {
                    this._ripple(x, z, now, Math.min(0.8, 0.15 + Math.abs(vy) * 0.6 + planar * 0.2));
                    state.nextWake = now + WAKE_INTERVAL * 2;
                }
            }
            state.inWater = true;
            state.lastVy = vy;
        }

        // Forget whatever left.
        for (const [key, state] of this._sources) if (!seen.has(key)) { state.inWater = false; this._sources.delete(key); }
        this._writeRipples();
    }

    private _state(key: object): SourceState {
        let s = this._sources.get(key);
        if (!s) { s = { inWater: false, nextWake: 0, nextSplash: 0, lastVy: 0 }; this._sources.set(key, s); }
        return s;
    }

    private _ripple(x: number, z: number, now: number, strength: number): void {
        this._ripples[this._nextSlot] = [x, z, now, strength];
        this._nextSlot = (this._nextSlot + 1) % WATER_RIPPLE_SLOTS;
    }

    private _splash(x: number, y: number, z: number, template: string): void {
        if (!template || this._splashFailed.has(template) || this._splashBudget < 1 || !this._scene) return;
        this._splashBudget -= 1;
        const made = this._scene.instantiate(template, { position: [x, y + 0.02, z] });
        if (!made) this._splashFailed.add(template);   // logged once by instantiate; stop asking
    }

    /** Hand the ripple slots to the surface material, if it declares them. */
    private _writeRipples(): void {
        if (!this._surfaceNodeId || !this._scene) return;
        const surface = this._scene.getNodeById(this._surfaceNodeId) as any;
        const materials: any[] = surface?.model?.materials ?? (surface?.model?.material ? [surface.model.material] : []);
        for (const m of materials) {
            if (!Array.isArray(m?.uniforms) || !m.uniforms.some((u: any) => u.name === 'ripple0')) continue;
            for (let i = 0; i < WATER_RIPPLE_SLOTS; i++) m.properties.set(`ripple${i}`, this._ripples[i]);
        }
    }

    // ---- serialization ----

    /** Applies a preset by id (see WATER_VOLUME_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | WaterVolumePreset): boolean {
        return applyPreset(this, WATER_VOLUME_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
            waterVolume: {
                ...WaterVolumeNode._bodyPayload(this._water), density: this._density,
                linearDrag: this._linearDrag, angularDrag: this._angularDrag,
                waveAmplitude: this._waveAmplitude, waveFrequency: this._waveFrequency,
                windSpeed: this._windSpeed, ...(this._fetch > 0 ? { fetch: this._fetch } : {}),
                waveDirection: this._waveDirection, waveScale: this._waveScale,
                choppiness: this._choppiness, waveSpeed: this._waveSpeed, shoreFade: this._shoreFade, currents: this._currents,
                ...(this._followWind ? { followWind: true } : {}),
                ...(this._waterMaterial ? { waterMaterial: this._waterMaterial.serialize() } : {}),
                ...(this._waterMaterialId ? { waterMaterialId: this._waterMaterialId } : {}),
                ...(this._bakeId ? { bakeId: this._bakeId } : {}),
                ...(this._bedRoughness !== 0.03 ? { bedRoughness: this._bedRoughness } : {}),
                affectCharacters: this._affectCharacters,
                ...(isAllLayers(this._reactsTo) ? {} : { reactsTo: this._reactsTo }),
                ...(this._spray !== 1 ? { spray: this._spray } : {}),
                surfaceNodeId: this._surfaceNodeId,
                splashTemplate: this._splashTemplate, wadeSplashTemplate: this._wadeSplashTemplate, enabled: this._enabled,
            },
        };
    }

    /** The body's fields for a save: only what its type reads. */
    private static _bodyPayload(b: WaterBody): any {
        const out: any = { waterType: b.type };
        if (b.type === 'river' || b.type === 'lake') {
            out.points = JSON.parse(JSON.stringify(b.points));
            out.carve = { ...b.carve };
        }
        if (b.type === 'pool') out.size = [...b.size];
        if (b.type === 'lake' || b.type === 'ocean') out.depth = b.depth;
        if (b.type === 'ocean') out.extent = b.extent;
        if (b.type === 'river' && (b.connect.start || b.connect.end)) out.connect = { ...b.connect };
        return out;
    }

    public static parse(parent: Node, json: any) {
        const wv = json.waterVolume ?? {};
        if (Array.isArray(wv.shapes) && wv.shapes.length && !wv.waterType) { WaterVolumeNode._parseLegacyShapes(parent, json); return; }
        const node = new WaterVolumeNode(json.name, wv, json.id);
        Node.finishParse(node, parent, json);
    }

    /**
     * An older save: one node holding a list of shapes. Each shape becomes a Water node of its own, siblings
     * with the same settings and material, placed where the shape was (its offset folded into the node's
     * position) and named after it; the first keeps the node's id and children. Connections that named a
     * shape name the node it became. The old bake covered all the shapes at once: dropped, to be baked again.
     */
    private static _parseLegacyShapes(parent: Node, json: any): void {
        const wv = json.waterVolume;
        const shapes = legacyWaterShapes(wv.shapes);
        const ids = new Map<string, string>();
        shapes.forEach((s, i) => ids.set(s.id, i === 0 && json.id ? json.id : uuidv4()));
        const pos: number[] = Array.isArray(json.position) ? json.position : [0, 0, 0];
        const scale: number[] = Array.isArray(json.scale) ? json.scale : [1, 1, 1];
        const { shapes: _shapes, bakeId: _bake, ...settings } = wv;
        void _shapes; void _bake;
        shapes.forEach((s, i) => {
            const connect = s.body.type === 'river'
                ? { start: s.body.connect.start ? ids.get(s.body.connect.start) ?? null : null, end: s.body.connect.end ? ids.get(s.body.connect.end) ?? null : null }
                : undefined;
            const options: WaterVolumeOptions = { ...settings, waterType: s.body.type, points: s.body.points, size: s.body.size,
                depth: s.body.depth, extent: s.body.extent, carve: s.body.carve, connect };
            const name = shapes.length === 1 ? json.name : (s.name || `${json.name} ${s.body.type}`);
            const id = ids.get(s.id)!;
            const position = [pos[0] + s.offset[0] * (scale[0] ?? 1), pos[1] + s.offset[1] * (scale[1] ?? 1), pos[2] + s.offset[2] * (scale[2] ?? 1)];
            const node = new WaterVolumeNode(name, options, id);
            const nodeJson = i === 0 ? { ...json, name, position } : {
                id, name, position, rotation: json.rotation, scale: json.scale, visible: json.visible, drawDistance: json.drawDistance, children: [],
            };
            Node.finishParse(node, parent, nodeJson);
        });
    }

    /** A small box at the origin: the volume itself would swallow clicks aimed at what is in the water. */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const r = 0.3;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        // An endless ocean is bounded for framing and culling by a kilometre around the node.
        const p = this.worldPosition;
        const wb = this.worldBox();
        const b = { min: wb.min.map((v, i) => Math.max(v, p[i] - 1000)), max: wb.max.map((v, i) => Math.min(v, p[i] + 1000)) };
        return { min: vec3.fromValues(b.min[0], b.min[1], b.min[2]), max: vec3.fromValues(b.max[0], b.max[1], b.max[2]) };
    }
}
