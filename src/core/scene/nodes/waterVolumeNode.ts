import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import type { Body as CannonBody } from 'cannon-es';
import { Node } from "./node";
import { WATER_VOLUME_PRESETS, type WaterVolumePreset } from "./waterVolumePresets";
import { applyPreset } from "../../presets";
import type { BuoyancyVolume } from "../../../physics/buoyancy";

export interface WaterVolumeOptions {
    /** Full extents [x, depth, z] in metres, before the node's scale. The TOP face is the water surface. */
    size?: [number, number, number];
    /** kg/m³. Fresh water 1000. */
    density?: number;
    /** Per second, at full submersion. */
    linearDrag?: number;
    angularDrag?: number;
    /** Metres: how far the surface rises and falls, so floating bodies bob. 0 = a flat surface. */
    waveAmplitude?: number;
    /** Hz of that bob. */
    waveFrequency?: number;
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
    enabled?: boolean;
}

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

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

/**
 * A body of water: everything dynamic inside it is buoyed by the water it displaces and slowed by drag
 * (see physics/buoyancy.ts), and whatever moves through it disturbs the surface — ripples on the water's
 * material and splashes from a template.
 *
 * An axis-aligned box: the node's rotation is ignored, its position is the box centre and its scale
 * multiplies `size`. The top face is the water level.
 */
export class WaterVolumeNode extends Node {
    private _size: [number, number, number];
    private _density: number;
    private _linearDrag: number;
    private _angularDrag: number;
    private _waveAmplitude: number;
    private _waveFrequency: number;
    private _affectCharacters: boolean;
    private _surfaceNodeId: string | null;
    private _splashTemplate: string;
    private _enabled: boolean;

    // ---- runtime ----
    /** The submerged fraction of every body the physics buoyed since the last update (max over substeps). */
    private _submerged = new Map<CannonBody, number>();
    private _sources = new Map<object, SourceState>();
    private _ripples: number[][] = Array.from({ length: WATER_RIPPLE_SLOTS }, () => [0, 0, -1000, 0]);
    private _nextSlot = 0;
    private _splashBudget = MAX_SPLASHES_PER_SECOND;
    private _splashFailed = false;

    constructor(name: string, options: WaterVolumeOptions = {}, id: string = uuidv4()) {
        super(name, 'waterVolume', id);
        const s = options.size;
        this._size = Array.isArray(s) ? [Math.abs(num(s[0], 10)), Math.abs(num(s[1], 2)), Math.abs(num(s[2], 10))] : [10, 2, 10];
        this._density = Math.max(1, num(options.density, 1000));
        this._linearDrag = Math.max(0, num(options.linearDrag, 2.5));
        this._angularDrag = Math.max(0, num(options.angularDrag, 1.5));
        this._waveAmplitude = Math.max(0, num(options.waveAmplitude, 0.03));
        this._waveFrequency = Math.max(0, num(options.waveFrequency, 0.6));
        this._affectCharacters = !!options.affectCharacters;
        this._surfaceNodeId = typeof options.surfaceNodeId === 'string' && options.surfaceNodeId ? options.surfaceNodeId : null;
        this._splashTemplate = typeof options.splashTemplate === 'string' ? options.splashTemplate : '';
        this._enabled = options.enabled !== false;
    }

    // ---- properties ----
    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        this._size = [Math.abs(num(v?.[0], 10)), Math.abs(num(v?.[1], 2)), Math.abs(num(v?.[2], 10))];
        this._notifyChange('component', 'size');
    }
    public get density(): number { return this._density; }
    public set density(v: number) { this._density = Math.max(1, num(v, this._density)); this._notifyChange('component', 'density'); }
    public get linearDrag(): number { return this._linearDrag; }
    public set linearDrag(v: number) { this._linearDrag = Math.max(0, num(v, this._linearDrag)); this._notifyChange('component', 'linearDrag'); }
    public get angularDrag(): number { return this._angularDrag; }
    public set angularDrag(v: number) { this._angularDrag = Math.max(0, num(v, this._angularDrag)); this._notifyChange('component', 'angularDrag'); }
    public get waveAmplitude(): number { return this._waveAmplitude; }
    public set waveAmplitude(v: number) { this._waveAmplitude = Math.max(0, num(v, this._waveAmplitude)); this._notifyChange('component', 'waveAmplitude'); }
    public get waveFrequency(): number { return this._waveFrequency; }
    public set waveFrequency(v: number) { this._waveFrequency = Math.max(0, num(v, this._waveFrequency)); this._notifyChange('component', 'waveFrequency'); }
    public get affectCharacters(): boolean { return this._affectCharacters; }
    public set affectCharacters(v: boolean) { this._affectCharacters = !!v; this._notifyChange('component', 'affectCharacters'); }
    public get surfaceNodeId(): string | null { return this._surfaceNodeId; }
    public set surfaceNodeId(v: string | null) { this._surfaceNodeId = v || null; this._notifyChange('component', 'surfaceNodeId'); }
    public get splashTemplate(): string { return this._splashTemplate; }
    public set splashTemplate(v: string) { this._splashTemplate = v ?? ''; this._splashFailed = false; this._notifyChange('component', 'splashTemplate'); }
    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) { if (!!v === this._enabled) return; this._enabled = !!v; this._notifyChange('component', 'enabled'); }

    // ---- geometry ----

    /** World-space box of the water, `max[1]` being the resting surface. Rotation is ignored. */
    public worldBox(): { min: [number, number, number]; max: [number, number, number] } {
        const m = this.worldTransform;
        const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
        const h = [this._size[0] * sx / 2, this._size[1] * sy / 2, this._size[2] * sz / 2];
        return {
            min: [m[12] - h[0], m[13] - h[1], m[14] - h[2]],
            max: [m[12] + h[0], m[13] + h[1], m[14] + h[2]],
        };
    }

    /** The water surface height at a world x/z at `time` seconds: the resting level plus a gentle swell. */
    public surfaceHeightAt(x: number, z: number, time: number): number {
        const level = this.worldBox().max[1];
        if (!(this._waveAmplitude > 0)) return level;
        const phase = time * this._waveFrequency * Math.PI * 2 + x * 0.37 + z * 0.29;
        return level + this._waveAmplitude * Math.sin(phase);
    }

    /** Whether a world point is in the water (below the resting surface, inside the box). */
    public contains(p: ArrayLike<number>): boolean {
        const b = this.worldBox();
        return p[0] >= b.min[0] && p[0] <= b.max[0] && p[2] >= b.min[2] && p[2] <= b.max[2]
            && p[1] >= b.min[1] && p[1] <= b.max[1];
    }

    /** Depth of a world point below the resting surface (negative above it); -Infinity outside the box's xz. */
    public depthAt(p: ArrayLike<number>): number {
        const b = this.worldBox();
        if (p[0] < b.min[0] || p[0] > b.max[0] || p[2] < b.min[2] || p[2] > b.max[2]) return -Infinity;
        return b.max[1] - p[1];
    }

    /** What the physics step buoys with, at physics time `time`. */
    public buoyancyVolume(time: number): BuoyancyVolume {
        const box = this.worldBox();
        return {
            min: box.min, max: box.max, density: this._density,
            linearDrag: this._linearDrag, angularDrag: this._angularDrag,
            affectCharacters: this._affectCharacters,
            surfaceAt: this._waveAmplitude > 0 ? (x, z) => this.surfaceHeightAt(x, z, time) : undefined,
        };
    }

    /** Called by the physics step for every body it buoyed. */
    public recordSubmerged(body: CannonBody, fraction: number): void {
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

    /** The clock the ripples are stamped on: the renderer's `u_time`. */
    private static _now(): number { return performance.now() * 0.001; }

    private _surfaceActivity(delta: number): void {
        const scene = this._scene;
        if (!scene) return;
        const now = WaterVolumeNode._now();
        this._splashBudget = Math.min(MAX_SPLASHES_PER_SECOND, this._splashBudget + delta * MAX_SPLASHES_PER_SECOND);
        const level = this.worldBox().max[1];
        const seen = new Set<object>();

        // Characters wading: feet below the surface, inside the box.
        for (const c of scene.characters) {
            const p = c.worldPosition;
            const box = this.worldBox();
            const depth = this.depthAt(p);
            // Feet below the surface and not below the floor (a character under the volume is not in it).
            const wading = depth > 0.02 && p[1] >= box.min[1] - 0.5;
            const state = this._state(c);
            seen.add(c);
            const v = c.currentVelocity;
            const planar = Math.hypot(v[0], v[2]);
            if (wading && !state.inWater) {
                this._ripple(p[0], p[2], now, Math.min(1, 0.5 + Math.abs(v[1]) * 0.2 + planar * 0.1));
                if (Math.abs(v[1]) > ENTRY_SPLASH_SPEED || planar > 2) this._splash(p[0], level, p[2]);
                state.nextWake = now + WAKE_INTERVAL;
                state.nextSplash = now + SPLASH_INTERVAL;
            } else if (wading && planar > WAKE_MIN_SPEED) {
                if (now >= state.nextWake) {
                    this._ripple(p[0], p[2], now, Math.min(1, 0.25 + planar * 0.12));
                    state.nextWake = now + WAKE_INTERVAL;
                }
                if (now >= state.nextSplash) {
                    this._splash(p[0], level, p[2]);
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
            if (!state.inWater) {
                this._ripple(x, z, now, Math.min(1, 0.4 + Math.abs(vy) * 0.15));
                if (Math.abs(vy) > ENTRY_SPLASH_SPEED) this._splash(x, level, z);
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

    private _splash(x: number, y: number, z: number): void {
        if (!this._splashTemplate || this._splashFailed || this._splashBudget < 1 || !this._scene) return;
        this._splashBudget -= 1;
        const made = this._scene.instantiate(this._splashTemplate, { position: [x, y + 0.02, z] });
        if (!made) this._splashFailed = true;   // logged once by instantiate; stop asking
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
                size: [...this._size], density: this._density,
                linearDrag: this._linearDrag, angularDrag: this._angularDrag,
                waveAmplitude: this._waveAmplitude, waveFrequency: this._waveFrequency,
                affectCharacters: this._affectCharacters, surfaceNodeId: this._surfaceNodeId,
                splashTemplate: this._splashTemplate, enabled: this._enabled,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new WaterVolumeNode(json.name, json.waterVolume ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }

    /** A small box at the origin: the volume itself would swallow clicks aimed at what is in the water. */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const r = 0.3;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const b = this.worldBox();
        return { min: vec3.fromValues(b.min[0], b.min[1], b.min[2]), max: vec3.fromValues(b.max[0], b.max[1], b.max[2]) };
    }
}
