import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { boxBlendFractions, boxInverseMatrix, boxWeight, boxWorldBounds } from "./boxVolume";
import { applyPreset, type Preset } from "../../presets";
import { AUTO_EXPOSURE_PRESETS, type AutoExposurePresetOptions } from "../../../graphics/renderPresets";
import type { ExposureCurveKey } from "../../../graphics/lighting";

/**
 * The exposure fields a volume can override: the scene's own auto-exposure settings, by the same names
 * (RenderSettings, AUTO_EXPOSURE_PRESETS). A field left out inherits the scene's value.
 */
export type ExposureOverrides = AutoExposurePresetOptions;

/** Every overridable field, in the order a preset assigns them (a limit before what it clamps). */
export const EXPOSURE_OVERRIDE_KEYS: readonly (keyof ExposureOverrides)[] = [
    'autoExposureEnabled', 'ev100', 'exposureCompensation', 'exposureCompensationCurve',
    'exposureMinEV', 'exposureMaxEV', 'exposureSpeedUp', 'exposureSpeedDown',
];

/** No side goes below this, so the box never inverts. */
export const MIN_EXPOSURE_VOLUME_SIZE = 0.01;

/**
 * A region of the scene with its own exposure: while the camera is inside the box, the volume's overrides
 * replace the scene's exposure settings, eased in over `blendDistance` at the faces. Unreal's post-process
 * volume, for exposure only.
 *
 * The scene's settings stay the scene's: the renderer blends an effective copy per frame from the camera
 * position (Renderer._resolveExposure) and never writes a volume's values back, so nothing a volume does
 * reaches a saved scene. Where volumes overlap they apply in `priority` order, lowest first, each blended
 * over the result so far by its weight — the highest priority wins at its full weight.
 *
 * The box is `size` (full extents, local units) centred on the node, under its full transform.
 */
export class ExposureVolumeNode extends Node {
    private _size: [number, number, number];
    private _blendDistance: number;
    /** Order among overlapping volumes: a higher one applies later and wins. */
    public priority: number;
    /** Off leaves it in the scene without it changing anything. */
    public enabled: boolean;
    private _overrides: ExposureOverrides;
    private _invScratch: mat4 = mat4.create();

    constructor(
        name: string,
        options: { size?: [number, number, number], blendDistance?: number, priority?: number, enabled?: boolean, overrides?: ExposureOverrides } = {},
        id: string = uuidv4(),
    ) {
        super(name, 'exposureVolume', id);
        this._size = [10, 10, 10];
        if (options.size) this.size = options.size;
        this._blendDistance = Math.max(0, options.blendDistance ?? 1);
        this.priority = Number.isFinite(options.priority) ? options.priority! : 0;
        this.enabled = options.enabled ?? true;
        this._overrides = {};
        this.overrides = options.overrides ?? {};
    }

    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        const s = (x: number) => Math.max(MIN_EXPOSURE_VOLUME_SIZE, Number.isFinite(+x) ? +x : 0);
        this._size = [s(v[0]), s(v[1]), s(v[2])];
    }
    /** Feather width in world units: the override fades to nothing over this distance inside the faces. */
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, +v || 0); }

    /** The fields this volume overrides. A copy: write through `overrides =` or `setOverride`. */
    public get overrides(): ExposureOverrides { return cloneOverrides(this._overrides); }
    public set overrides(v: ExposureOverrides) {
        const next: ExposureOverrides = {};
        for (const k of EXPOSURE_OVERRIDE_KEYS) {
            const value = (v as any)?.[k];
            if (value !== undefined) (next as any)[k] = sanitize(k, value);
        }
        this._overrides = next;
    }
    /** Override one field, or (undefined) let the scene's value through again. */
    public setOverride<K extends keyof ExposureOverrides>(key: K, value: ExposureOverrides[K] | undefined): void {
        const next = { ...this._overrides };
        if (value === undefined) delete next[key]; else (next as any)[key] = sanitize(key, value);
        this._overrides = next;
    }
    public hasOverride(key: keyof ExposureOverrides): boolean { return this._overrides[key] !== undefined; }
    /** The live overrides, read-only, for the renderer's per-frame blend (no copy). */
    public get overridesView(): Readonly<ExposureOverrides> { return this._overrides; }

    /**
     * Applies an exposure preset (AUTO_EXPOSURE_PRESETS id or object) as this volume's overrides: every
     * field the preset sets becomes overridden. Returns false for an unknown id.
     */
    public applyPreset(idOrPreset: string | Preset<AutoExposurePresetOptions>): boolean {
        const target: ExposureOverrides = {};
        if (!applyPreset(target, AUTO_EXPOSURE_PRESETS, idOrPreset)) return false;
        this.overrides = target;
        return true;
    }

    /** world -> volume unit cube (containment = |xyz| <= 0.5). */
    public get invVolumeMatrix(): mat4 { return boxInverseMatrix(this._invScratch, this.worldTransform, this._size); }

    /** How much of the override applies at a world point: 1 inside, easing to 0 at the faces, 0 outside or disabled. */
    public weightAt(p: vec3): number {
        if (!this.enabled) return 0;
        return boxWeight(p, this.invVolumeMatrix, boxBlendFractions(this._size, this.worldScale, this._blendDistance));
    }

    /** World volume of the box, for ordering equal priorities (the smaller, more specific box wins). */
    public get worldVolume(): number {
        const ws = this.worldScale;
        return Math.abs(this._size[0] * ws[0] * this._size[1] * ws[1] * this._size[2] * ws[2]);
    }

    public getBoundingBox(): { min: vec3, max: vec3 } { return boxWorldBounds(this.worldTransform, this._size); }

    protected _serializePayload(): any {
        return {
            exposureVolume: {
                size: [...this._size], blendDistance: this._blendDistance, priority: this.priority,
                enabled: this.enabled, overrides: cloneOverrides(this._overrides),
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new ExposureVolumeNode(json.name, json.exposureVolume ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}

function cloneOverrides(o: ExposureOverrides): ExposureOverrides {
    const out: ExposureOverrides = { ...o };
    if (o.exposureCompensationCurve) out.exposureCompensationCurve = o.exposureCompensationCurve.map(k => [k[0], k[1]] as ExposureCurveKey);
    return out;
}

function sanitize(key: keyof ExposureOverrides, value: unknown): any {
    if (key === 'autoExposureEnabled') return !!value;
    if (key === 'exposureCompensationCurve') {
        return Array.isArray(value)
            ? value.filter(k => Array.isArray(k) && Number.isFinite(+k[0]) && Number.isFinite(+k[1])).map(k => [+k[0], +k[1]] as ExposureCurveKey)
            : [];
    }
    const n = +(value as number);
    if (!Number.isFinite(n)) return 0;
    return key === 'exposureSpeedUp' || key === 'exposureSpeedDown' ? Math.max(0, n) : n;
}
