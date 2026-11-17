import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { finiteOr } from "../../math";
import { wavesForWind, type WaterWave } from "../../../physics/water/waves";
import { windFieldClock, WIND_REFERENCE_SPEED } from "../../wind/windField";
/** What the water reads back from a body it buoyed: where it is and how it moves. */
type FloatingBody = { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } };
import { Node } from "./node";
import { WaterMaterial } from "../../../graphics/material";
import { WATER_VOLUME_PRESETS, type WaterVolumePreset } from "./waterVolumePresets";
import { applyPreset } from "../../presets";
import type { BuoyancyVolume } from "../../../physics/buoyancy";
import { buoyancyVolumeFromSpec, waterSpecColumn, type WaterFlowGrid, type WaterShoreGrid, type WaterSpec } from "../../../physics/waterSurface";
import { buildOceanShoreInfo, type WaterInfo } from "../../../water/waterInfo";
import { sceneGround } from "../../../water/ground";
import { waterBakeContext } from "../../../water/bake/bakeNode";
import { GiBakeRegistry } from "../../../graphics/render/gi/giBakeRegistry";
import { decodeWaterBake } from "../../../water/bake/waterBakeFormat";
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

interface SourceState { inWater: boolean; nextWake: number; nextSplash: number; lastVy: number; }

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
     * read it, so a calm that flattens the drawn sea flattens the one bodies ride too.
     */
    public waveWindScale(): number {
        if (!this._followWind || !(this._windSpeed > 0)) return 1;
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
     * What a bake of this water depends on: the body, where the node puts it, the water it joins, the ground
     * under it, the static obstacles in it and the rivers running into it (water/bake/bakeNode.ts). A bake
     * whose signature no longer matches is STALE, and the surface falls back to the analytic flow until it is
     * baked again.
     */
    public bakeSignature(groundKey?: string): string {
        // The scene around it (ground, obstacles, the rivers feeding it) is walked at most twice a second;
        // its own body and what it joins are checked every time. A tool with no landscape node gives the
        // ground's key itself (water/ground.ts heightsRegionKey).
        const key = this.resolveKey();
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (groundKey === undefined && this._signature && this._signature.key === key && now - this._signature.at < 500) return this._signature.value;
        const m = this.worldTransform;
        const r = (v: number) => Math.round(v * 1000) / 1000;
        const joined = this.handOver().map(t => [t.id, t.type, r(t.level), t.min.map(r), t.max.map(r)]);
        const value = JSON.stringify([this._water, [m[12], m[13], m[14], Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])].map(r), joined, this._bedRoughness, waterBakeContext(this, groundKey)]);
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
     * The waves the surface is drawn with and bodies ride (physics/water/waves.ts): shaped by
     * {@link windSpeed} over {@link fetch} metres of open water, or what this body gives. Empty when the wind is 0.
     */
    public waves(): WaterWave[] {
        const r = this.resolved();
        if (!this._waves) {
            const fetch = this._fetch > 0 ? this._fetch : r ? waterShapeFetch(r) : 0;
            this._waves = this._windSpeed > 0 && this._waveScale > 0
                ? wavesForWind(this._windSpeed, this._waveDirection, fetch || 10,
                    { scale: this._waveScale, choppiness: this._choppiness, seed: 0 })
                : [];
        }
        return this._waves;
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
        return waterSpecColumn(this.buoyancySpec(), x, z, time, out);
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
        return buoyancyVolumeFromSpec(this.buoyancySpec(), time);
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
        const key = [this.resolveKey(), this._density, this._linearDrag, this._angularDrag, this._affectCharacters,
            this._waveAmplitude, this._waveFrequency, this._waveSpeed, this._shoreFade, this._currents, bake,
            shore ? this._shore!.key : ''].join('|');
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
            waves, waveScale, waveSpeed: this._waveSpeed, shoreFade: this._shoreFade, currents: this._currents,
            flowGrid: plainBox ? undefined : this.bakedFlowGrid() ?? undefined,
            shoreGrid: shore ? WaterVolumeNode._shoreGrid(shore) : undefined,
        };
        this._spec = { key, spec };
        return spec;
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

    /** The shore grid as physics reads it: metres to the shore and the bed, per cell. */
    private static _shoreGrid(info: WaterInfo): WaterShoreGrid {
        const n = info.nx * info.nz;
        const data = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { data[i * 2] = info.info0[i * 4 + 3]; data[i * 2 + 1] = info.info1[i * 4 + 2]; }
        return { originX: info.originX, originZ: info.originZ, cell: info.cell, nx: info.nx, nz: info.nz, data };
    }

    private _flowGrid: { key: string; grid: WaterFlowGrid | null } | null = null;

    /**
     * The current bake (if any, and not stale) as physics reads it, cell for cell: what floats follows the
     * baked currents, right to the banks. Cached per bake and registry change.
     */
    public bakedFlowGrid(): WaterFlowGrid | null {
        if (!this._bakeId || !GiBakeRegistry.has(this._bakeId)) return null;
        const key = `${this._bakeId}|${GiBakeRegistry.generation}|${this.bakeSignature()}`;
        if (this._flowGrid && this._flowGrid.key === key) return this._flowGrid.grid;
        const decoded = decodeWaterBake(GiBakeRegistry.get(this._bakeId)!, this._bakeId);
        let grid: WaterFlowGrid | null = null;
        if (decoded && decoded.signature === this.bakeSignature()) {
            const info = decoded.info;
            const nx = info.nx, nz = info.nz;
            const data = new Float32Array(nx * nz * 3);
            for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
                const i = z * nx + x, o = i * 3;
                const wet = info.info1[i * 4 + 3] > 0.5;
                data[o] = wet ? info.info0[i * 4] : NaN;
                data[o + 1] = wet ? info.info0[i * 4 + 1] : 0;
                data[o + 2] = wet ? info.info0[i * 4 + 2] : 0;
            }
            grid = { originX: info.originX, originZ: info.originZ, cell: info.cell, nx, nz, data };
        }
        this._flowGrid = { key, grid };
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
        if (!this._enabled) { this._submerged.clear(); return; }
        try {
            this._surfaceActivity(delta);
        } finally {
            this._submerged.clear();
        }
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

        // Characters wading: feet below the surface, inside the box.
        for (const c of scene.characters) {
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
                affectCharacters: this._affectCharacters, surfaceNodeId: this._surfaceNodeId,
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
