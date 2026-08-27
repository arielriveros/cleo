import { Texture } from "../../../graphics/texture";
import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

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
    private _needsBake: boolean = true;
    private _lastBakeTime: number = 0;
    private _sourceCube: Texture | null = null;
    private _irradiance: Texture | null = null;
    private _prefiltered: Texture | null = null;
    private _volScratch: mat4 = mat4.create();
    private _invVolScratch: mat4 = mat4.create();
    private static _pointScratch: vec3 = vec3.create();

    constructor(
        name: string,
        options: { resolution?: number, mode?: 'baked' | 'realtime', updateFrequency?: number, intensity?: number, size?: [number, number, number], blendDistance?: number } = {},
        id: string = uuidv4()
    ) {
        super(name, 'lightProbe', id);
        this._resolution = options.resolution ?? 256;
        this._mode = options.mode ?? 'baked';
        this._updateFrequency = options.updateFrequency ?? 1;
        this._intensity = options.intensity ?? 1;
        this._size = options.size ? [options.size[0], options.size[1], options.size[2]] : [0, 0, 0];
        this._blendDistance = options.blendDistance ?? 1;
    }

    // --- Editor-facing properties (setting the ones that affect the capture flags a re-bake) ---
    public get resolution(): number { return this._resolution; }
    public set resolution(v: number) { const n = Math.max(16, Math.floor(v)); if (n !== this._resolution) { this._resolution = n; this._needsBake = true; } }
    public get mode(): 'baked' | 'realtime' { return this._mode; }
    public set mode(v: 'baked' | 'realtime') { this._mode = v; if (v === 'realtime') this._needsBake = true; }
    public get updateFrequency(): number { return this._updateFrequency; }
    public set updateFrequency(v: number) { this._updateFrequency = Math.max(0, v); }
    public get intensity(): number { return this._intensity; }
    public set intensity(v: number) { this._intensity = Math.max(0, v); }
    // Volume setters do NOT flag a re-bake: the volume only governs where the probe applies, not what it captured.
    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) { this._size = [Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])]; }
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, v); }

    // --- Influence volume ---
    /** True when the probe has a finite influence box; false = unbounded (affects the whole scene). */
    public get bounded(): boolean { return this._size[0] > 0 && this._size[1] > 0 && this._size[2] > 0; }

    /** world -> probe-volume unit cube (containment = |xyz| <= 0.5). Only meaningful when bounded. */
    public get invVolumeMatrix(): mat4 {
        mat4.scale(this._volScratch, this.worldTransform, [this._size[0], this._size[1], this._size[2]]);
        mat4.invert(this._invVolScratch, this._volScratch);
        return this._invVolScratch;
    }

    /** Per-axis feather as a fraction of the unit cube (blendDistance / world size, capped at 0.5).
     *  Uploaded alongside invVolumeMatrix so the shader can smoothstep the boundary. */
    public get volumeBlend(): [number, number, number] {
        const ws = this.worldScale;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const worldSize = Math.abs(this._size[i] * ws[i]);
            out[i] = worldSize > 0 ? Math.min(0.5, this._blendDistance / worldSize) : 0;
        }
        return out;
    }

    /**
     * Feathered containment weight of a world-space point: 1 well inside the volume, easing to 0 at
     * the boundary (over blendDistance), 0 outside. Unbounded probes weigh 1 everywhere.
     */
    public probeWeight(p: vec3): number {
        if (!this.bounded) return 1;
        const local = vec3.transformMat4(LightProbeNode._pointScratch, p, this.invVolumeMatrix);
        const blend = this.volumeBlend;
        let w = 1;
        for (let i = 0; i < 3; i++) {
            const edge = 0.5 - Math.abs(local[i]); // distance to the boundary in unit-cube space
            if (edge <= 0) return 0;
            if (blend[i] > 0) {
                const t = Math.min(1, edge / blend[i]);
                w = Math.min(w, t * t * (3 - 2 * t)); // smoothstep
            }
        }
        return w;
    }

    // --- Renderer-facing baking state ---
    public get needsBake(): boolean { return this._needsBake; }
    public get lastBakeTime(): number { return this._lastBakeTime; }
    public get hasBakedMaps(): boolean { return this._irradiance !== null && this._prefiltered !== null; }
    public get irradiance(): Texture | null { return this._irradiance; }
    public get prefiltered(): Texture | null { return this._prefiltered; }
    /** The sharp, full-resolution scene capture (linear HDR) — best for clear/mirror-like reflections. */
    public get envMap(): Texture | null { return this._sourceCube; }
    /** Request a (re)capture on the next frame — used by the editor "Bake" button. */
    public bake(): void { this._needsBake = true; }
    public markBaked(time: number): void { this._needsBake = false; this._lastBakeTime = time; }
    public setBakedMaps(source: Texture, irradiance: Texture, prefiltered: Texture): void {
        this._sourceCube?.delete();
        this._irradiance?.delete();
        this._prefiltered?.delete();
        this._sourceCube = source;
        this._irradiance = irradiance;
        this._prefiltered = prefiltered;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (this.bounded) {
            // World AABB of the oriented influence box, so the editor's selection box shows the volume.
            const world = mat4.scale(this._volScratch, this.worldTransform, [this._size[0], this._size[1], this._size[2]]);
            const min = vec3.fromValues(Infinity, Infinity, Infinity);
            const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
            const corner = LightProbeNode._pointScratch;
            for (let i = 0; i < 8; i++) {
                vec3.set(corner, (i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5);
                vec3.transformMat4(corner, corner, world);
                vec3.min(min, min, corner);
                vec3.max(max, max, corner);
            }
            return { min, max };
        }
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
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new LightProbeNode(json.name, {
            resolution: json.resolution,
            mode: json.mode,
            updateFrequency: json.updateFrequency,
            intensity: json.intensity,
            size: json.size,           // absent in pre-volume scenes -> [0,0,0] = unbounded (legacy)
            blendDistance: json.blendDistance
        }, json.id);
        Node.finishParse(node, parent, json);
    }
}
