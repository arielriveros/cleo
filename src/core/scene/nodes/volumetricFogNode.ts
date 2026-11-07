import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { boxBlendFractions, boxInverseMatrix, boxWeight, boxWorldBounds } from "./boxVolume";
import { applyPreset, definePresets, type Preset } from "../../presets";

/** Everything a fog volume is authored with. Every field optional: a missing one takes the default. */
export interface VolumetricFogOptions {
    /** Full extents of the box, local units, centred on the node. */
    size?: [number, number, number];
    /** Metres over which the fog fades in at the faces. */
    blendDistance?: number;
    /** Which volumes survive when more are in view than the renderer draws: the higher, first. */
    priority?: number;
    enabled?: boolean;
    /** Extinction, per metre: how quickly the fog hides what is behind it (visibility ~ 3.9 / density m). */
    density?: number;
    /** The share of what the fog takes from a ray that it scatters rather than absorbs, per channel. */
    albedo?: [number, number, number];
    /** Light the fog itself gives off (a glowing haze, a fire's smoke): colour and nits on the internal scale. */
    emissiveColor?: [number, number, number];
    emissiveIntensity?: number;
    /** Henyey-Greenstein g: 0 scatters evenly, toward 1 glows round a light seen through the fog. */
    anisotropy?: number;
    /** 1/m: the fog thins exponentially from the box's bottom face up; 0 is even all the way through. */
    heightFalloff?: number;
    /** 0..1: how much a drifting noise breaks the fog up. */
    noiseStrength?: number;
    /** Metres per noise cell. */
    noiseScale?: number;
    /** World metres per second the noise drifts. */
    windVelocity?: [number, number, number];
    /** Multipliers on what lights the fog: the sun or moon, the point and spot lights, the sky's ambient. */
    sunScattering?: number;
    localLightScattering?: number;
    ambientScattering?: number;
}

const DEFAULTS: Required<Omit<VolumetricFogOptions, 'size' | 'priority' | 'enabled'>> = {
    blendDistance: 2, density: 0.02, albedo: [0.9, 0.9, 0.9], emissiveColor: [1, 1, 1], emissiveIntensity: 0,
    anisotropy: 0.2, heightFalloff: 0, noiseStrength: 0.4, noiseScale: 6, windVelocity: [0.4, 0, 0.15],
    sunScattering: 1, localLightScattering: 1, ambientScattering: 1,
};

/** One-click looks: the medium, never the box or where it is. */
export type VolumetricFogPreset = Preset<VolumetricFogOptions>;
export const VOLUMETRIC_FOG_PRESETS: VolumetricFogPreset[] = definePresets<VolumetricFogOptions>(
    { density: 0.02, albedo: [0.9, 0.9, 0.9], emissiveIntensity: 0, anisotropy: 0.2, heightFalloff: 0, noiseStrength: 0.4, noiseScale: 6 }, [
    ['mist', 'Mist', 'A thin, bright mist: torches glow in it, distant things soften.', {}],
    ['groundFog', 'Ground Fog', 'Thick at the floor of the box and gone a few metres up.',
        { density: 0.06, heightFalloff: 0.6, noiseStrength: 0.5, noiseScale: 8 }],
    ['smokyInterior', 'Smoky Interior', 'A warm, smoky room: shafts through the windows, halos round the lamps.',
        { density: 0.035, albedo: [0.75, 0.7, 0.62], anisotropy: 0.45, noiseStrength: 0.25, noiseScale: 3 }],
    ['dust', 'Dust', 'Fine, dry dust hanging in the light.',
        { density: 0.012, albedo: [0.85, 0.78, 0.65], anisotropy: 0.55, noiseStrength: 0.3, noiseScale: 4 }],
    ['swamp', 'Swamp', 'Heavy, greenish air low over water.',
        { density: 0.05, albedo: [0.7, 0.8, 0.65], heightFalloff: 0.3, noiseStrength: 0.6, noiseScale: 10 }],
    ['fireHaze', 'Fire Haze', 'Smoke and heat over a fire: dense, dark, lit from inside.',
        { density: 0.08, albedo: [0.45, 0.42, 0.4], anisotropy: 0.3, noiseStrength: 0.7, noiseScale: 1.5 }],
]);

/** No side goes below this, so the box never inverts. */
export const MIN_FOG_VOLUME_SIZE = 0.01;

const vec = (v: unknown, fallback: [number, number, number]): [number, number, number] =>
    Array.isArray(v) && v.length >= 3 && v.every(x => Number.isFinite(+x)) ? [+v[0], +v[1], +v[2]] : [...fallback] as [number, number, number];
const finite = (v: unknown, fallback: number): number => (Number.isFinite(+(v as number)) && v !== null && v !== undefined ? +(v as number) : fallback);

/**
 * A box of participating medium: fog, mist, smoke or dust that the sun, the moon, the torches and the
 * sky light scatter into, so a torch glows in the mist round it and shafts cross a smoky hall. Drawn by the
 * renderer's froxel fog (render/volumetricFog.ts): the camera's view is cut into a grid of cells, each lit
 * once per frame, and integrated front to back, so everything behind fog is dimmed by it and lit by it.
 *
 * Adjusted in the scene with a box gizmo, like an exposure volume. Overlapping volumes ADD (their density
 * and glow sum, as two banks of fog would); `priority` only decides which survive when more are in view
 * than the quality tier draws. The scene's own height fog and god rays are separate and unchanged.
 */
export class VolumetricFogNode extends Node {
    private _size: [number, number, number];
    private _blendDistance: number;
    public priority: number;
    public enabled: boolean;
    private _density: number;
    public albedo: [number, number, number];
    public emissiveColor: [number, number, number];
    private _emissiveIntensity: number;
    private _anisotropy: number;
    private _heightFalloff: number;
    private _noiseStrength: number;
    private _noiseScale: number;
    public windVelocity: [number, number, number];
    private _sunScattering: number;
    private _localLightScattering: number;
    private _ambientScattering: number;
    private _invScratch: mat4 = mat4.create();

    constructor(name: string, options: VolumetricFogOptions = {}, id: string = uuidv4()) {
        super(name, 'volumetricFog', id);
        this._size = [20, 6, 20];
        if (options.size) this.size = options.size;
        this._blendDistance = Math.max(0, finite(options.blendDistance, DEFAULTS.blendDistance));
        this.priority = finite(options.priority, 0);
        this.enabled = options.enabled ?? true;
        this._density = Math.max(0, finite(options.density, DEFAULTS.density));
        this.albedo = vec(options.albedo, DEFAULTS.albedo);
        this.emissiveColor = vec(options.emissiveColor, DEFAULTS.emissiveColor);
        this._emissiveIntensity = Math.max(0, finite(options.emissiveIntensity, DEFAULTS.emissiveIntensity));
        this._anisotropy = Math.min(0.9, Math.max(-0.9, finite(options.anisotropy, DEFAULTS.anisotropy)));
        this._heightFalloff = Math.max(0, finite(options.heightFalloff, DEFAULTS.heightFalloff));
        this._noiseStrength = Math.min(1, Math.max(0, finite(options.noiseStrength, DEFAULTS.noiseStrength)));
        this._noiseScale = Math.max(0.05, finite(options.noiseScale, DEFAULTS.noiseScale));
        this.windVelocity = vec(options.windVelocity, DEFAULTS.windVelocity);
        this._sunScattering = Math.max(0, finite(options.sunScattering, 1));
        this._localLightScattering = Math.max(0, finite(options.localLightScattering, 1));
        this._ambientScattering = Math.max(0, finite(options.ambientScattering, 1));
    }

    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        const s = (x: number) => Math.max(MIN_FOG_VOLUME_SIZE, Number.isFinite(+x) ? +x : 0);
        this._size = [s(v[0]), s(v[1]), s(v[2])];
    }
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, +v || 0); }
    public get density(): number { return this._density; }
    public set density(v: number) { this._density = Math.max(0, +v || 0); }
    public get emissiveIntensity(): number { return this._emissiveIntensity; }
    public set emissiveIntensity(v: number) { this._emissiveIntensity = Math.max(0, +v || 0); }
    public get anisotropy(): number { return this._anisotropy; }
    public set anisotropy(v: number) { this._anisotropy = Math.min(0.9, Math.max(-0.9, +v || 0)); }
    public get heightFalloff(): number { return this._heightFalloff; }
    public set heightFalloff(v: number) { this._heightFalloff = Math.max(0, +v || 0); }
    public get noiseStrength(): number { return this._noiseStrength; }
    public set noiseStrength(v: number) { this._noiseStrength = Math.min(1, Math.max(0, +v || 0)); }
    public get noiseScale(): number { return this._noiseScale; }
    public set noiseScale(v: number) { this._noiseScale = Math.max(0.05, +v || 0.05); }
    public get sunScattering(): number { return this._sunScattering; }
    public set sunScattering(v: number) { this._sunScattering = Math.max(0, +v || 0); }
    public get localLightScattering(): number { return this._localLightScattering; }
    public set localLightScattering(v: number) { this._localLightScattering = Math.max(0, +v || 0); }
    public get ambientScattering(): number { return this._ambientScattering; }
    public set ambientScattering(v: number) { this._ambientScattering = Math.max(0, +v || 0); }

    /** Metres at which the fog hides about 98% of what is behind it (`3.9 / density`). */
    public get visibilityDistance(): number { return this._density > 0 ? 3.9 / this._density : Infinity; }

    /** world -> volume unit cube (containment = |xyz| <= 0.5). */
    public get invVolumeMatrix(): mat4 { return boxInverseMatrix(this._invScratch, this.worldTransform, this._size); }
    /** Per-axis feather as a fraction of the unit cube. */
    public get blendFractions(): [number, number, number] { return boxBlendFractions(this._size, this.worldScale, this._blendDistance); }

    /** How much of the fog is present at a world point: 1 inside, easing to 0 at the faces, 0 outside or disabled. */
    public weightAt(p: vec3): number {
        if (!this.enabled) return 0;
        return boxWeight(p, this.invVolumeMatrix, this.blendFractions);
    }

    public getBoundingBox(): { min: vec3, max: vec3 } { return boxWorldBounds(this.worldTransform, this._size); }

    /** What a viewport click selects the volume by: a small box at its centre, as OcclusionVolumeNode's. */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const r = 0.4;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }

    /** Applies a look (VOLUMETRIC_FOG_PRESETS id or object). Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | VolumetricFogPreset): boolean {
        return applyPreset(this, VOLUMETRIC_FOG_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
            volumetricFog: {
                size: [...this._size], blendDistance: this._blendDistance, priority: this.priority, enabled: this.enabled,
                density: this._density, albedo: [...this.albedo], emissiveColor: [...this.emissiveColor],
                emissiveIntensity: this._emissiveIntensity, anisotropy: this._anisotropy, heightFalloff: this._heightFalloff,
                noiseStrength: this._noiseStrength, noiseScale: this._noiseScale, windVelocity: [...this.windVelocity],
                sunScattering: this._sunScattering, localLightScattering: this._localLightScattering,
                ambientScattering: this._ambientScattering,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new VolumetricFogNode(json.name, json.volumetricFog ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}
