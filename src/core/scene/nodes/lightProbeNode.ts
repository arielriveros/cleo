import { Texture } from "../../../graphics/texture";
import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { boxBlendFractions, boxInverseMatrix, boxWeight, boxWorldBounds } from "./boxVolume";
import type { LightBakeSnapshot } from "./lightNode";

/**
 * Baked irradiance probe with a bounded influence volume.
 */

export class LightProbeNode extends Node {
    private _resolution: number;
    private _mode: 'baked' | 'realtime';
    private _updateFrequency: number; // seconds (realtime mode)
    private _intensity: number;
    // Influence volume: an oriented box, full extents in world units at scale 1.
    // [0,0,0] means unbounded — the probe affects the whole scene.
    private _size: [number, number, number];
    // Feather width in world units: IBL fades to zero over this distance inside the volume boundary.
    private _blendDistance: number;
    // What the probe contributes inside its volume: the diffuse light it bounces onto surfaces, the
    // reflections, or both. Off for one, whatever is behind the probe — another probe, the sky light,
    // the scene ambient — supplies it there instead.
    private _affectsLighting: boolean;
    private _affectsReflections: boolean;
    // Parallax-correct the reflections against the box (bounded probes only).
    private _boxProjection: boolean;
    // Degrees the sun may move before the probe relights itself (0 = only when asked).
    private _relightDegrees: number;
    private _needsBake: boolean = true;
    private _needsRelight: boolean = false;
    private _lastBakeTime: number = 0;
    private _sourceCube: Texture | null = null;
    private _bakeVersion = 0;
    private _invVolScratch: mat4 = mat4.create();

    constructor(
        name: string,
        options: { resolution?: number, mode?: 'baked' | 'realtime', updateFrequency?: number, intensity?: number, size?: [number, number, number], blendDistance?: number,
                   affectsLighting?: boolean, affectsReflections?: boolean, boxProjection?: boolean, relightDegrees?: number } = {},
        id: string = uuidv4()
    ) {
        super(name, 'lightProbe', id);
        this._resolution = options.resolution ?? 256;
        this._mode = options.mode ?? 'baked';
        this._updateFrequency = options.updateFrequency ?? 1;
        this._intensity = options.intensity ?? 1;
        this._size = options.size ? [options.size[0], options.size[1], options.size[2]] : [0, 0, 0];
        this._blendDistance = options.blendDistance ?? 1;
        this._affectsLighting = options.affectsLighting ?? true;
        this._affectsReflections = options.affectsReflections ?? true;
        this._boxProjection = options.boxProjection ?? false;
        this._relightDegrees = Math.max(0, options.relightDegrees ?? 0);
    }

    // --- Editor-facing properties (setting the ones that affect the capture flags a re-bake) ---
    public get resolution(): number { return this._resolution; }
    public set resolution(v: number) { const n = Math.max(16, Math.floor(v)); if (n !== this._resolution) { this._resolution = n; this._needsBake = true; } }
    public get mode(): 'baked' | 'realtime' { return this._mode; }
    public set mode(v: 'baked' | 'realtime') { this._mode = v; if (v === 'realtime') this._needsBake = true; }
    public get updateFrequency(): number { return this._updateFrequency; }
    public set updateFrequency(v: number) { this._updateFrequency = Math.max(0, v); }
    /**
     * Follow the sun: once the scene's sun has turned this many degrees since the probe was last lit, it
     * relights itself (its captured scene lit again, a few frames' work; never a re-capture). 0 = only when
     * something asks (`relight()`). A day that moves the sun — a sequence keying it, a script — keeps the
     * probe's reflections and fill in step without any code.
     */
    public get relightDegrees(): number { return this._relightDegrees; }
    public set relightDegrees(v: number) { this._relightDegrees = Math.max(0, +v || 0); }
    public get intensity(): number { return this._intensity; }
    public set intensity(v: number) { this._intensity = Math.max(0, v); }
    // Volume setters do NOT flag a re-bake: the volume only governs where the probe applies, not what it captured.
    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) { this._size = [Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])]; }
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, v); }
    /**
     * Whether the probe lights surfaces inside its volume (diffuse irradiance). Off, it only gives them
     * reflections, and their lighting comes from whatever covers them otherwise. No re-bake: the capture
     * is the same, only how it is applied changes.
     */
    public get affectsLighting(): boolean { return this._affectsLighting; }
    public set affectsLighting(v: boolean) { this._affectsLighting = !!v; }
    /** Whether the probe gives surfaces inside its volume their reflections (specular). */
    public get affectsReflections(): boolean { return this._affectsReflections; }
    public set affectsReflections(v: boolean) { this._affectsReflections = !!v; }
    /**
     * Box projection (parallax correction): a surface inside the box reflects what the probe saw where its
     * reflected ray leaves the box, instead of what lies along that direction infinitely far away. Right
     * for a room (its walls land where they are on a polished floor); wrong for an open landscape, whose
     * horizon IS far away. Bounded probes only. No re-bake.
     */
    public get boxProjection(): boolean { return this._boxProjection; }
    public set boxProjection(v: boolean) { this._boxProjection = !!v; }

    // --- Influence volume ---
    /** True when the probe has a finite influence box; false = unbounded (affects the whole scene). */
    public get bounded(): boolean { return this._size[0] > 0 && this._size[1] > 0 && this._size[2] > 0; }

    /** world -> probe-volume unit cube (containment = |xyz| <= 0.5). Only meaningful when bounded. */
    public get invVolumeMatrix(): mat4 {
        return boxInverseMatrix(this._invVolScratch, this.worldTransform, this._size);
    }

    /** Per-axis feather as a fraction of the unit cube (blendDistance / world size, capped at 0.5).
     *  Uploaded alongside invVolumeMatrix so the shader can smoothstep the boundary. */
    public get volumeBlend(): [number, number, number] {
        return boxBlendFractions(this._size, this.worldScale, this._blendDistance);
    }

    /**
     * Feathered containment weight of a world-space point: 1 well inside the volume, easing to 0 at
     * the boundary (over blendDistance), 0 outside. Unbounded probes weigh 1 everywhere.
     */
    public probeWeight(p: vec3): number {
        if (!this.bounded) return 1;
        return boxWeight(p, this.invVolumeMatrix, this.volumeBlend);
    }

    /**
     * World distance from `p` to the influence volume: 0 inside it (or anywhere, unbounded). Past the
     * per-frame cap, the probes nearest the camera by it are the ones applied (render/probeLighting.ts).
     */
    public distanceToVolume(p: vec3): number {
        if (!this.bounded) return 0;
        const inv = this.invVolumeMatrix;
        const q = vec3.transformMat4(this._distScratch, p, inv);
        const cx = Math.min(0.5, Math.max(-0.5, q[0])), cy = Math.min(0.5, Math.max(-0.5, q[1])), cz = Math.min(0.5, Math.max(-0.5, q[2]));
        if (cx === q[0] && cy === q[1] && cz === q[2]) return 0;
        const box = mat4.invert(this._boxScratch, inv);
        if (!box) return vec3.distance(p, this.worldPosition);
        const nearest = vec3.transformMat4(this._distScratch, vec3.set(this._distScratch, cx, cy, cz), box);
        return vec3.distance(p, nearest);
    }

    /** The influence volume in cubic metres (Infinity unbounded): a smaller volume is the more specific probe. */
    public get volumeSize(): number {
        if (!this.bounded) return Infinity;
        const s = this.worldScale;
        return Math.abs(this._size[0] * s[0] * this._size[1] * s[1] * this._size[2] * s[2]);
    }

    private readonly _distScratch: vec3 = vec3.create();
    private readonly _boxScratch: mat4 = mat4.create();

    // --- Renderer-facing baking state ---
    /** A full capture is asked for: the probe's scene (its G-buffer) is captured again, then lit. */
    public get needsBake(): boolean { return this._needsBake; }
    /** A RELIGHT is asked for: the captured scene lit again (the sun moved, a light changed), no geometry. */
    public get needsRelight(): boolean { return this._needsRelight; }
    public get lastBakeTime(): number { return this._lastBakeTime; }
    public get hasBakedMaps(): boolean { return this._sourceCube !== null; }
    /** Bumped by every installed bake: an asynchronous result taken from an older one is dropped. */
    public get bakeVersion(): number { return this._bakeVersion; }
    /** The sharp, full-resolution scene capture (linear HDR) — best for clear/mirror-like reflections. */
    public get envMap(): Texture | null { return this._sourceCube; }
    /**
     * The layer of the reflection atlas (render/reflectionAtlas.ts) holding this probe's GGX-prefiltered
     * environment, or -1 while it has none. Renderer-owned.
     */
    public reflectionLayer = -1;
    /**
     * What the lights the last bake saw were then, by light id: what the editor compares the lights
     * against to say the probe is out of date (probeBakeState.ts). Null before any bake.
     */
    public bakedLights: Map<string, LightBakeSnapshot> | null = null;
    /** Request a full (re)capture — the editor "Bake" button, a probe that moved. */
    public bake(): void { this._needsBake = true; }
    /**
     * Request a relight: the captured scene lit again by the lights and sky as they are now. Far cheaper
     * than a bake (no geometry but the sun's shadow), which is what a time of day asks for as the sun
     * moves. A probe never captured is baked instead.
     */
    public relight(): void { this._needsRelight = true; }
    /** Renderer-facing: a bake or relight has started; requests made from here on queue another. */
    public takeBakeRequests(): void { this._needsBake = false; this._needsRelight = false; }
    public markBaked(time: number): void { this._needsBake = false; this._lastBakeTime = time; }
    /**
     * Install a capture. The source cube may be the one already installed (a relight writes into it in
     * place); it is deleted only when replaced. Its lighting (`irradianceSH`) is projected from it next.
     */
    public setBakedMaps(source: Texture): void {
        if (this._sourceCube && this._sourceCube !== source) this._sourceCube.delete();
        this._sourceCube = source;
        this._bakeVersion++;
        // The coefficients are re-projected from the new irradiance cube a frame or two later
        // (SkyPasses.updateProbeLighting). The old ones keep lighting meanwhile: a re-bake as the sun
        // moves must not flash the volume to the sky's fill while the readback is in flight.
        this._shStale = true;
    }

    // --- Lighting: the irradiance as spherical harmonics ---
    private _irradianceSH: Float32Array | null = null;
    private _shStale = true;
    /**
     * The diffuse light this probe gives the surfaces in its volume: its irradiance cube projected onto
     * nine L2 spherical harmonics (rgb, 4 floats apart), in the radiance form the sky light's are in
     * (shProject.ts). Null until the first projection lands. What lets the lighting loop over every probe
     * per pixel (render/probeLighting.ts) where the two cubemap slots are handed out by the camera.
     * Derived at runtime, never saved: a probe re-bakes on load.
     */
    public get irradianceSH(): Float32Array | null { return this._irradianceSH; }
    /** True while the coefficients are missing or older than the irradiance cube. */
    public get shStale(): boolean { return this._shStale; }
    public setIrradianceSH(sh: Float32Array): void {
        this._irradianceSH = sh;
        this._shStale = false;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        // World AABB of the oriented influence box, so the editor's selection box shows the volume.
        if (this.bounded) return boxWorldBounds(this.worldTransform, this._size);
        const position = this.worldPosition;
        const scale = this.worldScale;
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.5;
        const min = vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius);
        const max = vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius);
        return { min, max };
    }

    protected _serializePayload(): any {
        return {
                    resolution: this._resolution,
                    mode: this._mode,
                    updateFrequency: this._updateFrequency,
                    intensity: this._intensity,
                    size: [this._size[0], this._size[1], this._size[2]],
                    blendDistance: this._blendDistance,
                    affectsLighting: this._affectsLighting,
                    affectsReflections: this._affectsReflections,
                    boxProjection: this._boxProjection,
                    ...(this._relightDegrees > 0 ? { relightDegrees: this._relightDegrees } : {}),
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new LightProbeNode(json.name, {
            resolution: json.resolution,
            mode: json.mode,
            updateFrequency: json.updateFrequency,
            intensity: json.intensity,
            size: json.size,           // absent in pre-volume scenes -> [0,0,0] = unbounded (legacy)
            blendDistance: json.blendDistance,
            affectsLighting: json.affectsLighting,         // absent in older scenes -> true
            affectsReflections: json.affectsReflections,
            boxProjection: json.boxProjection,             // absent in older scenes -> off
            relightDegrees: typeof json.relightDegrees === 'number' ? json.relightDegrees : 0,
        }, json.id);
        Node.finishParse(node, parent, json);
    }
}
