import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { WEATHER_PRESETS, type WeatherPreset } from "./weatherPresets";
import { applyPreset } from "../../presets";
import { boxBlendFractions, boxColumnWeight, boxInverseMatrix, boxWeight, boxWorldBounds } from "./boxVolume";
import { Material } from "../../../graphics/material";

/**
 * Weather inside a box: how wet the ground and the plants are, how much snow lies on them, and whether
 * what stands under a roof stays dry.
 *
 * A BOX VOLUME like VolumetricFogNode: `size` along the node's own axes, carried by its transform, fading
 * in over `blendDistance` at the faces. Several may overlap: they composite in priority order, so a dry
 * box nested in a snowy one carves out a dry pocket. A size of [0, 0, 0] is UNBOUNDED, the whole scene:
 * what a scene saved before weather had a box reads as, so it looks exactly as it did.
 *
 * What answers it:
 * - the LANDSCAPE (chunks/terrainWeather.wgsl): rain darkens and glosses the ground and stands in puddles
 *   in its low, flat spots; snow settles on what is flat enough (`snowSlope`), low ground first, broken up
 *   by `snowBreakup`, drawn with `snowMaterial`'s maps (flat white without one);
 * - FOLIAGE materials (chunks/foliageSurface.wgsl): leaves and blades darken and gloss by their
 *   `wetResponse`, snow settles on what faces up by their `snowCover`, and both bow the plant by its
 *   `weightDroop`, per plant.
 * With `shelter` on, what stands under something solid (a roof, an overhang, a cart; anything that casts
 * a shadow from straight above) stays dry and free of snow.
 *
 * PRECIPITATION. `precipitation` makes rain or snow FALL inside the box, drawn by the particle system: one
 * camera-following system per kind for the whole scene (`scene.precipitation`, PrecipitationRig), so
 * overlapping volumes never double it and a nested dry box carves it out. It falls only where the
 * volumes ask for it (thinned to their `precipitationRate`, feathered at their side faces; the TOP of a
 * box is open, so what falls from the sky above it reaches it), and never under shelter. Rain also stirs
 * the landscape's wet ground: rings ripple in its puddles and drops hit the ground round them, by the
 * rate times the wetness, so it goes still once the rain stops.
 */
export interface WeatherOptions {
    /** How wet: 0 dry, 1 soaked. */
    wetness?: number;
    /** How much snow lies on things: 0 none, 1 thick. */
    snow?: number;
    /** How much of the wet ground's low, flat spots holds standing water: 0 none, 1 every hollow. */
    puddles?: number;
    /** Full extents of the box, before the node transform. [0, 0, 0]: unbounded, the whole scene. */
    size?: [number, number, number];
    /** Metres over which the weather fades in at the faces. */
    blendDistance?: number;
    /** Composite order where volumes overlap (higher over lower), and which survive the per-frame cap. */
    priority?: number;
    enabled?: boolean;
    /** The snow's surface: a PBR (or Blinn-Phong, basic) material whose maps the landscape draws snow with. */
    snowMaterial?: any;
    /** Editor-side link to the Material library asset the snow was taken from. Never `materialId`. */
    snowMaterialId?: string | null;
    /** Metres per repeat of the snow material's maps on the landscape. */
    snowTiling?: number;
    /** Degrees: ground steeper than this sheds its snow. */
    snowSlope?: number;
    /** 0..1: how much a noise breaks the snow's edge into patches. */
    snowBreakup?: number;
    /** Keep what stands under something solid dry and free of snow (and, falling, out of the rain). */
    shelter?: boolean;
    /** What falls from the sky inside the box: nothing, rain or snow (see {@link WeatherNode}). */
    precipitation?: PrecipitationKind;
    /** How hard it falls: 0 nothing, 1 a downpour (or a blizzard). */
    precipitationRate?: number;
    /** Size of the drops or flakes, times the realistic default: 0.25..3. */
    precipitationSize?: number;
    /** How fast they fall, times the realistic default (8.5 m/s rain, 1 m/s snow): 0.25..3. */
    precipitationSpeed?: number;
    /** 0..1: how much the scene's wind (its WindNode) slants the rain and drifts the snow. */
    precipitationWind?: number;
    /**
     * Rain only: the length of each drop's trail (its streak) as a multiple of the realistic default, one
     * random draw per drop between `precipitationTrailMin` and `precipitationTrailMax` (0.1..4). Equal
     * values give every streak the same length; 1 is the default streak.
     */
    precipitationTrailMin?: number;
    precipitationTrailMax?: number;
    /**
     * The drops' or flakes' look: a sprite sheet (a tileset's atlas, or any texture cut into a grid), each
     * particle taking a random cell, or playing them at `fps`. Null: the engine's own realistic sprites.
     */
    precipitationSprite?: PrecipitationSprite | null;
}

/** What a weather volume makes fall. */
export type PrecipitationKind = 'none' | 'rain' | 'snow';
export const PRECIPITATION_KINDS: readonly PrecipitationKind[] = ['none', 'rain', 'snow'];

/**
 * A sprite sheet for falling rain or snow: `columns` x `rows` cells over the WHOLE texture (no margin or
 * spacing), `frames` of them used counted from the top-left. With `fps` 0 each particle shows one random
 * cell; above 0 they play in order from a random one. A rain cell's TOP is its leading end: the drop
 * falls toward it.
 */
export interface PrecipitationSprite {
    /** TextureManager id of the sheet. */
    textureId: string;
    /** Editor-side link to the tileset the sheet was taken from (its texture and grid are copied in). */
    tilesetId?: string | null;
    columns: number;
    rows: number;
    frames: number;
    fps: number;
}

/** A sprite sheet with every field in range (a fresh copy), or null for none. */
export function parsePrecipitationSprite(v: unknown): PrecipitationSprite | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (typeof o.textureId !== 'string' || !o.textureId) return null;
    const int = (x: unknown, lo: number, hi: number, fallback: number) =>
        Math.min(hi, Math.max(lo, Math.round(typeof x === 'number' && Number.isFinite(x) ? x : fallback)));
    const columns = int(o.columns, 1, 64, 1);
    const rows = int(o.rows, 1, 64, 1);
    const out: PrecipitationSprite = {
        textureId: o.textureId, columns, rows, frames: int(o.frames, 1, columns * rows, columns * rows),
        fps: Math.min(120, Math.max(0, typeof o.fps === 'number' && Number.isFinite(o.fps) ? o.fps : 0)),
    };
    if (typeof o.tilesetId === 'string' && o.tilesetId) out.tilesetId = o.tilesetId;
    return out;
}

export const WEATHER_DEFAULTS = {
    wetness: 0, snow: 0, puddles: 0.5, blendDistance: 4, snowTiling: 4, snowSlope: 45, snowBreakup: 0.4,
    precipitationRate: 0.6, precipitationSize: 1, precipitationSpeed: 1, precipitationWind: 0.5,
    precipitationTrailMin: 0.7, precipitationTrailMax: 1.3,
} as const;

/** No side of a bounded weather box goes below this, so it never inverts. */
export const MIN_WEATHER_VOLUME_SIZE = 0.01;

const unit = (v: unknown, fallback: number) =>
    Math.min(1, Math.max(0, typeof v === 'number' && Number.isFinite(v) ? v : fallback));
const finite = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const trail = (v: unknown, fallback: number) => Math.min(4, Math.max(0.1, finite(v, fallback)));
const multiplier = (v: unknown, fallback: number) => Math.min(3, Math.max(0.25, finite(v, fallback)));
const kindOf = (v: unknown, fallback: PrecipitationKind): PrecipitationKind =>
    (PRECIPITATION_KINDS.includes(v as PrecipitationKind) ? v as PrecipitationKind : fallback);

export class WeatherNode extends Node {
    private _wetness: number;
    private _snow: number;
    private _puddles: number;
    private _size: [number, number, number] = [0, 0, 0];
    private _blendDistance: number;
    public priority: number;
    public enabled: boolean;
    /** See {@link WeatherOptions.snowMaterial}. Null: flat snow. */
    public snowMaterial: Material | null;
    /** See {@link WeatherOptions.snowMaterialId}. */
    public snowMaterialId: string | null;
    private _snowTiling: number;
    private _snowSlope: number;
    private _snowBreakup: number;
    /** See {@link WeatherOptions.shelter}. */
    public shelter: boolean;
    private _precipitation: PrecipitationKind;
    private _precipitationRate: number;
    private _precipitationSize: number;
    private _precipitationSpeed: number;
    private _precipitationWind: number;
    private _precipitationTrailMin: number;
    private _precipitationTrailMax: number;
    private _precipitationSprite: PrecipitationSprite | null;
    private _invScratch: mat4 = mat4.create();

    constructor(name: string, options: WeatherOptions = {}, id: string = uuidv4()) {
        super(name, 'weather', id);
        this._wetness = unit(options.wetness, WEATHER_DEFAULTS.wetness);
        this._snow = unit(options.snow, WEATHER_DEFAULTS.snow);
        this._puddles = unit(options.puddles, WEATHER_DEFAULTS.puddles);
        if (options.size) this.size = options.size;
        this._blendDistance = Math.max(0, finite(options.blendDistance, WEATHER_DEFAULTS.blendDistance));
        this.priority = finite(options.priority, 0);
        this.enabled = options.enabled ?? true;
        this.snowMaterial = options.snowMaterial ? WeatherNode._parseMaterial(options.snowMaterial) : null;
        this.snowMaterialId = typeof options.snowMaterialId === 'string' && options.snowMaterialId ? options.snowMaterialId : null;
        this._snowTiling = Math.max(0.05, finite(options.snowTiling, WEATHER_DEFAULTS.snowTiling));
        this._snowSlope = Math.min(90, Math.max(0, finite(options.snowSlope, WEATHER_DEFAULTS.snowSlope)));
        this._snowBreakup = unit(options.snowBreakup, WEATHER_DEFAULTS.snowBreakup);
        this.shelter = options.shelter ?? true;
        this._precipitation = kindOf(options.precipitation, 'none');
        this._precipitationRate = unit(options.precipitationRate, WEATHER_DEFAULTS.precipitationRate);
        this._precipitationSize = multiplier(options.precipitationSize, WEATHER_DEFAULTS.precipitationSize);
        this._precipitationSpeed = multiplier(options.precipitationSpeed, WEATHER_DEFAULTS.precipitationSpeed);
        this._precipitationWind = unit(options.precipitationWind, WEATHER_DEFAULTS.precipitationWind);
        this._precipitationTrailMin = trail(options.precipitationTrailMin, WEATHER_DEFAULTS.precipitationTrailMin);
        this._precipitationTrailMax = Math.max(this._precipitationTrailMin, trail(options.precipitationTrailMax, WEATHER_DEFAULTS.precipitationTrailMax));
        this._precipitationSprite = parsePrecipitationSprite(options.precipitationSprite);
    }

    private static _parseMaterial(json: any): Material | null {
        if (json instanceof Material) return json;
        try { return Material.parse(json); } catch { return null; }
    }

    public get wetness(): number { return this._wetness; }
    public set wetness(v: number) { this._wetness = unit(v, this._wetness); }
    public get snow(): number { return this._snow; }
    public set snow(v: number) { this._snow = unit(v, this._snow); }
    public get puddles(): number { return this._puddles; }
    public set puddles(v: number) { this._puddles = unit(v, this._puddles); }
    public get snowTiling(): number { return this._snowTiling; }
    public set snowTiling(v: number) { this._snowTiling = Math.max(0.05, finite(+v, this._snowTiling)); }
    public get snowSlope(): number { return this._snowSlope; }
    public set snowSlope(v: number) { this._snowSlope = Math.min(90, Math.max(0, finite(+v, this._snowSlope))); }
    public get snowBreakup(): number { return this._snowBreakup; }
    public set snowBreakup(v: number) { this._snowBreakup = unit(v, this._snowBreakup); }

    /** See {@link WeatherOptions.precipitation}. */
    public get precipitation(): PrecipitationKind { return this._precipitation; }
    public set precipitation(v: PrecipitationKind) { this._precipitation = kindOf(v, this._precipitation); }
    /** See {@link WeatherOptions.precipitationRate}. */
    public get precipitationRate(): number { return this._precipitationRate; }
    public set precipitationRate(v: number) { this._precipitationRate = unit(v, this._precipitationRate); }
    /** See {@link WeatherOptions.precipitationSize}. */
    public get precipitationSize(): number { return this._precipitationSize; }
    public set precipitationSize(v: number) { this._precipitationSize = multiplier(+v, this._precipitationSize); }
    /** See {@link WeatherOptions.precipitationSpeed}. */
    public get precipitationSpeed(): number { return this._precipitationSpeed; }
    public set precipitationSpeed(v: number) { this._precipitationSpeed = multiplier(+v, this._precipitationSpeed); }
    /** See {@link WeatherOptions.precipitationWind}. */
    public get precipitationWind(): number { return this._precipitationWind; }
    public set precipitationWind(v: number) { this._precipitationWind = unit(v, this._precipitationWind); }
    /** See {@link WeatherOptions.precipitationTrailMin}. Raising it past the max raises the max with it. */
    public get precipitationTrailMin(): number { return this._precipitationTrailMin; }
    public set precipitationTrailMin(v: number) {
        this._precipitationTrailMin = trail(+v, this._precipitationTrailMin);
        if (this._precipitationTrailMax < this._precipitationTrailMin) this._precipitationTrailMax = this._precipitationTrailMin;
    }
    /** See {@link WeatherOptions.precipitationTrailMax}. Lowering it past the min lowers the min with it. */
    public get precipitationTrailMax(): number { return this._precipitationTrailMax; }
    public set precipitationTrailMax(v: number) {
        this._precipitationTrailMax = trail(+v, this._precipitationTrailMax);
        if (this._precipitationTrailMin > this._precipitationTrailMax) this._precipitationTrailMin = this._precipitationTrailMax;
    }
    /** See {@link WeatherOptions.precipitationSprite}. Assigning copies (and clamps) the sheet; null: the built-in sprites. */
    public get precipitationSprite(): PrecipitationSprite | null { return this._precipitationSprite; }
    public set precipitationSprite(v: PrecipitationSprite | null) { this._precipitationSprite = parsePrecipitationSprite(v); }

    /** The rain falling here: the rate when it rains, else 0. What the shaders and the rain particles composite. */
    public get rainRate(): number { return this._precipitation === 'rain' ? this._precipitationRate : 0; }
    /** The snow falling here: the rate when it snows, else 0. */
    public get snowfallRate(): number { return this._precipitation === 'snow' ? this._precipitationRate : 0; }
    /** Whether anything falls: a kind, at a rate above 0. */
    public get precipitating(): boolean { return this._precipitation !== 'none' && this._precipitationRate > 0; }

    /** The box. [0, 0, 0]: unbounded. Any other size is clamped to MIN_WEATHER_VOLUME_SIZE a side. */
    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        const n = (x: number) => (Number.isFinite(+x) ? Math.max(0, +x) : 0);
        const raw: [number, number, number] = [n(v[0]), n(v[1]), n(v[2])];
        if (raw[0] === 0 && raw[1] === 0 && raw[2] === 0) { this._size = raw; return; }
        this._size = [Math.max(MIN_WEATHER_VOLUME_SIZE, raw[0]), Math.max(MIN_WEATHER_VOLUME_SIZE, raw[1]), Math.max(MIN_WEATHER_VOLUME_SIZE, raw[2])];
    }
    /** False for the whole-scene weather a size of [0, 0, 0] gives (and every scene saved before boxes). */
    public get bounded(): boolean { return this._size[0] > 0 || this._size[1] > 0 || this._size[2] > 0; }
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, +v || 0); }

    /** Whether it does anything at all: enabled, and wet, snowy or precipitating. */
    public get active(): boolean {
        return this.enabled && this.visible && (this._wetness > 0 || this._snow > 0 || this.precipitating);
    }

    /** world -> volume unit cube (containment = |xyz| <= 0.5). Identity-scaled garbage when unbounded: check `bounded`. */
    public get invVolumeMatrix(): mat4 { return boxInverseMatrix(this._invScratch, this.worldTransform, this._size); }
    /** Per-axis feather as a fraction of the unit cube. */
    public get blendFractions(): [number, number, number] { return boxBlendFractions(this._size, this.worldScale, this._blendDistance); }

    /** How much of this weather is present at a world point: 1 inside (everywhere, unbounded), easing to 0 at the faces. */
    public weightAt(p: vec3): number {
        if (!this.enabled) return 0;
        if (!this.bounded) return 1;
        return boxWeight(p, this.invVolumeMatrix, this.blendFractions);
    }

    /** {@link weightAt} for what FALLS: the box's top is open, so the sky above it counts as inside. */
    public columnWeightAt(p: vec3): number {
        if (!this.enabled) return 0;
        if (!this.bounded) return 1;
        return boxColumnWeight(p, this.invVolumeMatrix, this.blendFractions);
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (this.bounded) return boxWorldBounds(this.worldTransform, this._size);
        // Unbounded: the box only gives the editor something to frame.
        const p = this.worldPosition;
        return { min: vec3.fromValues(p[0] - 1, p[1] - 1, p[2] - 1), max: vec3.fromValues(p[0] + 1, p[1] + 1, p[2] + 1) };
    }

    /** What a viewport click selects the volume by: a small box at its centre, never the whole box. */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const r = 0.4;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }

    /** Applies a preset by id (see WEATHER_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | WeatherPreset): boolean {
        return applyPreset(this, WEATHER_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
            weather: {
                wetness: this._wetness, snow: this._snow, puddles: this._puddles,
                size: [...this._size], blendDistance: this._blendDistance, priority: this.priority, enabled: this.enabled,
                snowTiling: this._snowTiling, snowSlope: this._snowSlope, snowBreakup: this._snowBreakup, shelter: this.shelter,
                precipitation: this._precipitation, precipitationRate: this._precipitationRate,
                precipitationSize: this._precipitationSize, precipitationSpeed: this._precipitationSpeed,
                precipitationWind: this._precipitationWind,
                precipitationTrailMin: this._precipitationTrailMin, precipitationTrailMax: this._precipitationTrailMax,
                ...(this._precipitationSprite ? { precipitationSprite: { ...this._precipitationSprite } } : {}),
                ...(this.snowMaterial ? { snowMaterial: this.snowMaterial.serialize() } : {}),
                ...(this.snowMaterialId ? { snowMaterialId: this.snowMaterialId } : {}),
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new WeatherNode(json.name, json.weather ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}
