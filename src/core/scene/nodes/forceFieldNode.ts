import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { FORCE_FIELD_PRESETS, type ForceFieldPreset } from "./forceFieldPresets";
import { applyPreset } from "../../presets";

export type ForceFieldKind = 'directional' | 'radial' | 'vortex' | 'turbulence' | 'drag';
export type ForceFieldShape = 'global' | 'sphere' | 'box';

export interface ForceFieldOptions {
    kind?: ForceFieldKind;
    shape?: ForceFieldShape;
    /** m/s² for radial, vortex and turbulence; target speed (m/s) for directional; 1/s for drag. */
    strength?: number;
    /** Sphere radius, in metres, before the node's scale. */
    radius?: number;
    /** Box half extents, in metres, before the node's scale. */
    extents?: [number, number, number];
    /** 0..1: the fraction of the shape, from its edge inward, over which the force fades in. */
    falloff?: number;
    /** Turbulence noise frequency, per metre. */
    frequency?: number;
    enabled?: boolean;
}

const KINDS: readonly ForceFieldKind[] = ['directional', 'radial', 'vortex', 'turbulence', 'drag'];
const SHAPES: readonly ForceFieldShape[] = ['global', 'sphere', 'box'];
const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/** Fields the GPU sees per frame. Matches MAX_FORCE_FIELDS in chunks/particleSimCore.wgsl. */
export const MAX_FORCE_FIELDS = 16;

/**
 * A volume that pushes particles around: wind, a blast, a whirlwind, a turbulent patch of air.
 *
 * Particles opt in per emitter with the Force Fields module, so one gust can move the smoke without
 * dragging the sparks with it. Direction and vortex axis are the node's local +Y, so a field is aimed
 * by rotating it like anything else in the scene.
 */
export class ForceFieldNode extends Node {
    private _kind: ForceFieldKind;
    private _shape: ForceFieldShape;
    private _strength: number;
    private _radius: number;
    private _extents: [number, number, number];
    private _falloff: number;
    private _frequency: number;
    private _enabled: boolean;

    constructor(name: string, options: ForceFieldOptions = {}, id: string = uuidv4()) {
        super(name, 'forceField', id);
        this._kind = KINDS.includes(options.kind as ForceFieldKind) ? options.kind as ForceFieldKind : 'directional';
        this._shape = SHAPES.includes(options.shape as ForceFieldShape) ? options.shape as ForceFieldShape : 'sphere';
        this._strength = num(options.strength, 5);
        this._radius = Math.max(0.01, num(options.radius, 3));
        const e = options.extents;
        this._extents = Array.isArray(e) ? [Math.abs(num(e[0], 2)), Math.abs(num(e[1], 2)), Math.abs(num(e[2], 2))] : [2, 2, 2];
        this._falloff = Math.min(1, Math.max(0, num(options.falloff, 0.5)));
        this._frequency = Math.max(0.001, num(options.frequency, 0.5));
        this._enabled = options.enabled !== false;
    }

    public get kind(): ForceFieldKind { return this._kind; }
    public set kind(v: ForceFieldKind) {
        if (!KINDS.includes(v) || v === this._kind) return;
        this._kind = v;
        this._notifyChange('component', 'kind');
    }
    public get shape(): ForceFieldShape { return this._shape; }
    public set shape(v: ForceFieldShape) {
        if (!SHAPES.includes(v) || v === this._shape) return;
        this._shape = v;
        this._notifyChange('component', 'shape');
    }
    public get strength(): number { return this._strength; }
    public set strength(v: number) {
        this._strength = num(v, this._strength);
        this._notifyChange('component', 'strength');
    }
    public get radius(): number { return this._radius; }
    public set radius(v: number) {
        this._radius = Math.max(0.01, num(v, this._radius));
        this._notifyChange('component', 'radius');
    }
    public get extents(): [number, number, number] { return this._extents; }
    public set extents(v: [number, number, number]) {
        this._extents = [Math.abs(num(v?.[0], 2)), Math.abs(num(v?.[1], 2)), Math.abs(num(v?.[2], 2))];
        this._notifyChange('component', 'extents');
    }
    public get falloff(): number { return this._falloff; }
    public set falloff(v: number) {
        this._falloff = Math.min(1, Math.max(0, num(v, this._falloff)));
        this._notifyChange('component', 'falloff');
    }
    public get frequency(): number { return this._frequency; }
    public set frequency(v: number) {
        this._frequency = Math.max(0.001, num(v, this._frequency));
        this._notifyChange('component', 'frequency');
    }
    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) {
        if (!!v === this._enabled) return;
        this._enabled = !!v;
        this._notifyChange('component', 'enabled');
    }

    /**
     * Write this field's four texels at `offset` of `out`, in world space: (position, kind)
     * (direction, strength) (shape, radius, falloff, frequency) (box half extents, 0). Scale is folded in.
     */
    public packInto(out: Float32Array, offset: number): void {
        const m = this.worldTransform;
        const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
        // Local +Y, unit length.
        const up = vec3.fromValues(m[4], m[5], m[6]);
        vec3.normalize(up, up);
        out.set([m[12], m[13], m[14], KINDS.indexOf(this._kind)], offset);
        out.set([up[0], up[1], up[2], this._strength], offset + 4);
        out.set([SHAPES.indexOf(this._shape), this._radius * Math.max(sx, sy, sz), this._falloff, this._frequency], offset + 8);
        out.set([this._extents[0] * sx, this._extents[1] * sy, this._extents[2] * sz, 0], offset + 12);
    }

    /** Applies a preset by id (see FORCE_FIELD_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | ForceFieldPreset): boolean {
        return applyPreset(this, FORCE_FIELD_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
            forceField: {
                kind: this._kind, shape: this._shape, strength: this._strength, radius: this._radius,
                extents: [...this._extents], falloff: this._falloff, frequency: this._frequency,
                enabled: this._enabled,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new ForceFieldNode(json.name, json.forceField ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }

    /**
     * What a viewport click selects the force field by: a small box at its origin, where its editor icon
     * sits. Its bounds would enclose the ground and everything else the effect plays over, and swallow
     * every click aimed at them — the reason DecalNode has one too.
     */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const r = 0.3;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const m = this.worldTransform;
        const s = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
        const r = this._shape === 'box' ? Math.max(...this._extents) * s : this._shape === 'sphere' ? this._radius * s : 0.5;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }
}
