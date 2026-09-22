import { v4 as uuidv4 } from 'uuid';
import { mat4, vec3 } from "gl-matrix";
import { Logger } from "../../logger";
import { Node } from "./node";
import { Material } from "../../../graphics/material";

/** The one shading model a decal can project, as a literal: the material type enum is not exported. */
const PBR_TYPE = 'pbr';

/** RGBA, 0..1 per channel. The rgb is sRGB-authored, like every other picker colour. */
export type DecalColor = [number, number, number, number];

/** Which surfaces a decal may land on. See {@link DecalNode.receivers}. */
export type DecalReceivers = 'all' | 'terrain';

/** Where a decal's colour and coverage come from. See {@link DecalNode.pattern}. */
export type DecalPattern = 'material' | 'radial';

/**
 * How the radial pattern's weight falls from the centre to the rim.
 *
 * `power` is `pow(1 - t, exponent)` — the terrain brush's classic `soft` curve when `exponent` is
 * `brushFalloffExponent(falloff)`. The other four are the band curves of `curveWeight` in
 * terrain/sculpt.ts (the Unreal/Unity convention): full weight over the inner `1 - falloff` of the
 * radius, then `smooth` (smoothstep), `linear`, `sphere` (a quarter circle) or `tip` (its inverse)
 * down to 0 at the rim.
 */
export type DecalRadialCurve = 'power' | 'smooth' | 'linear' | 'sphere' | 'tip';

/** The distance a radial pattern measures: to the box's vertical axis, or Chebyshev (a square). */
export type DecalRadialShape = 'circle' | 'square';

/** The shader's index for each curve; see `radialWeight` in shaders/wgsl/chunks/decal.wgsl. */
export const DECAL_RADIAL_CURVES: readonly DecalRadialCurve[] = ['power', 'smooth', 'linear', 'sphere', 'tip'];

/**
 * The surface attributes a decal writes. Grouped the way the renderer's decal buffer is: `surface` is
 * roughness, metallic and ambient occlusion together, which share ONE coverage channel exactly as
 * Unreal's DBufferC does.
 */
export interface DecalAffects {
    albedo: boolean;
    normal: boolean;
    surface: boolean;
    emissive: boolean;
}

/**
 * A procedural radial gradient, for ground indicators and the editor's terrain brush.
 *
 * `t` is the distance from the box's vertical axis as a fraction of its half-width (an ellipse when the
 * box is not square), or the Chebyshev distance for `shape: 'square'`. The fill is
 * `mix(outerColor, innerColor, w)` with `w = radialDecalWeight(t, exponent, curve, falloff)` — the same
 * curves the terrain brush sculpts with, which is the point. Nothing lands outside `t = 1`; the ring
 * sits on it.
 */
export interface DecalRadialPattern {
    /** Colour and coverage at the centre (w = 1). */
    innerColor: DecalColor;
    /** Colour and coverage at the rim (w = 0). */
    outerColor: DecalColor;
    /** The weight curve. See {@link DecalRadialCurve}. */
    curve: DecalRadialCurve;
    /** The `power` curve's exponent; 0 is a flat, uniform disc. */
    exponent: number;
    /** The band curves' falloff: the fraction of the radius the weight falls over; 0 is a hard edge. */
    falloff: number;
    /** Circle, or a square (rotate the node to turn it). */
    shape: DecalRadialShape;
    /** The outline at t = 1; alpha 0 disables it. */
    ringColor: DecalColor;
    /** Ring width in screen PIXELS, so it stays crisp at any distance. */
    ringWidthPx: number;
    /** Emissive multiplier on the pattern colour; 0 = not emissive. */
    emissive: number;
}

export interface DecalOptions {
    size?: [number, number, number];
    material?: Material | null;
    opacity?: number;
    sortOrder?: number;
    angleFade?: number;
    depthFade?: number;
    affects?: Partial<DecalAffects>;
    receivers?: DecalReceivers;
    pattern?: DecalPattern;
    radial?: Partial<DecalRadialPattern>;
}

const DEFAULT_AFFECTS: DecalAffects = { albedo: true, normal: true, surface: true, emissive: true };
const DEFAULT_RADIAL: DecalRadialPattern = {
    innerColor: [1, 1, 1, 1],
    outerColor: [1, 1, 1, 0],
    curve: 'power',
    exponent: 1,
    falloff: 0.5,
    shape: 'circle',
    ringColor: [1, 1, 1, 0],
    ringWidthPx: 1.5,
    emissive: 0,
};
/** A zero extent would make the volume matrix singular; nothing real is thinner than this. */
const MIN_EXTENT = 1e-3;

/**
 * Decal-box local position to decal uv. The image lies in the box's local XZ plane and the decal
 * projects along local −Y, so seen from above (looking down the projection) +X runs right and −Z runs
 * up the image — `v` is flipped for the same reason a texture is not mirrored on a floor.
 *
 * The WGSL twin is `decalUv` in shaders/wgsl/chunks/decal.wgsl.
 */
export function decalLocalToUV(local: ArrayLike<number>): [number, number] {
    return [0.5 + local[0], 0.5 - local[2]];
}

/**
 * The radial pattern's gradient weight at `t` (fraction of the half-width). 0 outside the rim.
 * The WGSL twin is `radialWeight` in shaders/wgsl/chunks/decal.wgsl; the terrain twin, which the
 * editor's brush cursor must agree with to the digit, is `curveWeight` in terrain/sculpt.ts.
 */
export function radialDecalWeight(t: number, exponent: number, curve: DecalRadialCurve = 'power',
                                  falloff: number = 0): number {
    // The rim itself belongs to the pattern only for a hard edge, exactly as in `curveWeight`: a band curve
    // at t = 1 would otherwise come out a rounding error above zero.
    const hard = curve === 'power' ? exponent <= 0 : falloff <= 0;
    if (t >= 1) return t === 1 && hard ? 1 : 0;
    if (curve === 'power') return exponent <= 0 ? 1 : Math.pow(Math.max(0, 1 - t), exponent);
    const f = Math.min(1, Math.max(0, falloff));
    if (f <= 0) return 1;
    const inner = 1 - f;
    if (t <= inner) return 1;
    const u = (t - inner) / f;
    switch (curve) {
        case 'smooth': return 1 - u * u * (3 - 2 * u);
        case 'linear': return 1 - u;
        case 'sphere': return Math.sqrt(Math.max(0, 1 - u * u));
        case 'tip': { const v = 1 - u; return 1 - Math.sqrt(Math.max(0, 1 - v * v)); }
    }
    return 0;
}

/** The radial distance `t` of a unit-box position for `shape`. The WGSL twin is `radialT`. */
export function radialDecalT(local: ArrayLike<number>, shape: DecalRadialShape = 'circle'): number {
    return shape === 'square'
        ? Math.max(Math.abs(local[0]), Math.abs(local[2])) * 2
        : Math.hypot(local[0], local[2]) * 2;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const color = (v: unknown, fallback: DecalColor): DecalColor =>
    Array.isArray(v) && v.length >= 3
        ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, v.length > 3 ? (Number(v[3]) || 0) : 1]
        : [fallback[0], fallback[1], fallback[2], fallback[3]];

/**
 * A decal volume: an oriented box that projects a material onto every surface inside it, the way
 * Unreal's DecalActor and HDRP's DecalProjector do.
 *
 * ## The box
 *
 * `size` is the full extent at scale 1, so the volume is `worldTransform x scale(size)` over the unit
 * cube `|xyz| <= 0.5` — the same convention as `LightProbeNode`'s influence box. The decal projects
 * along local **−Y**: a freshly added decal with no rotation lands on the ground beneath it. Surfaces
 * are only touched where they lie inside the box AND face the projector (see {@link angleFade}).
 *
 * ## How it renders (renderer.ts, `_surfaceDecalPass` and friends)
 *
 * - **Surface** attributes — albedo, normal, roughness/metallic/AO — go through a DBuffer before
 *   lighting and are resolved into the G-buffer, so they are LIT like the surface underneath. Deferred
 *   receivers only: the Default (Blinn-Phong) and Cel materials are shaded forward, after lighting.
 * - **Emissive** is added to the lit image afterwards, on every opaque surface.
 * - An **editor-only** decal (`markEditorOnly`) skips both and is drawn as unlit chrome in the overlay
 *   layer. That is what the landscape brush is.
 */
export class DecalNode extends Node {
    private _size: [number, number, number];
    private _material: Material | null = null;
    private _opacity: number;
    private _sortOrder: number;
    private _angleFade: number;
    private _depthFade: number;
    private _affects: DecalAffects;
    private _receivers: DecalReceivers;
    private _pattern: DecalPattern;
    private _radial: DecalRadialPattern;

    private readonly _volScratch: mat4 = mat4.create();
    private readonly _invVolScratch: mat4 = mat4.create();
    private static readonly _corner: vec3 = vec3.create();

    constructor(name: string, options: DecalOptions = {}, id: string = uuidv4()) {
        super(name, 'decal', id);
        this._size = [1, 1, 1];
        if (options.size) this.size = options.size;
        this.material = options.material ?? null;
        this._opacity = clamp01(options.opacity ?? 1);
        this._sortOrder = Math.round(options.sortOrder ?? 0);
        this._angleFade = clamp01(options.angleFade ?? 0.3);
        this._depthFade = clamp01(options.depthFade ?? 0.2);
        this._affects = { ...DEFAULT_AFFECTS, ...(options.affects ?? {}) };
        this._receivers = options.receivers === 'terrain' ? 'terrain' : 'all';
        this._pattern = options.pattern === 'radial' ? 'radial' : 'material';
        this._radial = DecalNode._radialFrom(options.radial);
    }

    // --- Authored state ---------------------------------------------------------------------------

    /** Full extents at scale 1. Changing it moves the bounds without moving the node. */
    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        this._size = [Math.max(MIN_EXTENT, Math.abs(v[0])), Math.max(MIN_EXTENT, Math.abs(v[1])),
                      Math.max(MIN_EXTENT, Math.abs(v[2]))];
        this.invalidateWorldBounds();
    }

    /**
     * The projected material, PBR only: its base colour (alpha = coverage), normal, ORM, emissive and
     * mask maps and their scalars. `null` projects plain white (or the radial pattern).
     */
    public get material(): Material | null { return this._material; }
    public set material(m: Material | null) {
        if (m && (m.type as string) !== PBR_TYPE) {
            Logger.warn(`Decal '${this._name}': only PBR materials can be projected (got '${m.type}').`, 'Scene');
            this._material = null;
            return;
        }
        this._material = m;
    }

    /** Overall coverage multiplier, 0..1. */
    public get opacity(): number { return this._opacity; }
    public set opacity(v: number) { this._opacity = clamp01(v); }

    /** Draw order among overlapping decals: higher lands on top. Ties break by id, never by distance. */
    public get sortOrder(): number { return this._sortOrder; }
    public set sortOrder(v: number) { this._sortOrder = Math.round(v); }

    /**
     * How the decal fades on surfaces turned away from the projector, 0..1: the weight is
     * `smoothstep(0, angleFade, dot(surfaceNormal, decalUp))`. 0 disables the test entirely — the
     * decal then also lands on walls and back faces inside the box, as Unreal's does by default.
     */
    public get angleFade(): number { return this._angleFade; }
    public set angleFade(v: number) { this._angleFade = clamp01(v); }

    /** Feather toward the box's top and bottom faces, as a fraction of its half-height. 0 = hard cut. */
    public get depthFade(): number { return this._depthFade; }
    public set depthFade(v: number) { this._depthFade = clamp01(v); }

    /** Which surface attributes this decal writes. The returned object is live; mutate it freely. */
    public get affects(): DecalAffects { return this._affects; }
    public set affects(v: DecalAffects) { this._affects = { ...DEFAULT_AFFECTS, ...v }; }

    /**
     * `'terrain'` restricts the decal to landscape surfaces: a rock or a grass blade standing inside
     * the box stays clean. Costs one depth-only pass over the terrain chunks in any frame such a decal
     * is visible. There is no stencil in this engine, so this is the only receiver filter.
     */
    public get receivers(): DecalReceivers { return this._receivers; }
    public set receivers(v: DecalReceivers) { this._receivers = v === 'terrain' ? 'terrain' : 'all'; }

    /** `'material'` projects {@link material}; `'radial'` draws the procedural {@link radial} gradient. */
    public get pattern(): DecalPattern { return this._pattern; }
    public set pattern(v: DecalPattern) { this._pattern = v === 'radial' ? 'radial' : 'material'; }

    /** The radial gradient's parameters. The returned object is live; mutate it freely. */
    public get radial(): DecalRadialPattern { return this._radial; }
    public set radial(v: Partial<DecalRadialPattern>) { this._radial = DecalNode._radialFrom(v); }

    // --- Renderer-facing --------------------------------------------------------------------------

    /** unit cube -> world. Live scratch: copy it to keep it. */
    public get volumeMatrix(): mat4 {
        return mat4.scale(this._volScratch, this.worldTransform, this._size);
    }

    /** world -> unit cube, containment = |xyz| <= 0.5. Live scratch: copy it to keep it. */
    public get invVolumeMatrix(): mat4 {
        return mat4.invert(this._invVolScratch, this.volumeMatrix) ?? mat4.identity(this._invVolScratch);
    }

    /**
     * Whether the world transform mirrors the box. A negative determinant reverses triangle winding, so
     * the renderer has to cull the OTHER face set to keep drawing the box's back faces.
     */
    public get mirrored(): boolean { return mat4.determinant(this.worldTransform) < 0; }

    /** Whether this decal writes anything into the G-buffer (albedo, a normal, roughness/metal/AO). */
    public get writesSurface(): boolean {
        const a = this._affects;
        if (a.albedo || a.surface) return true;
        return a.normal && this._pattern === 'material' && !!this._material?.properties.get('hasNormalMap');
    }

    /** Whether this decal adds light to the image. */
    public get emits(): boolean {
        if (!this._affects.emissive) return false;
        if (this._pattern === 'radial') return this._radial.emissive > 0;
        const m = this._material;
        if (!m) return false;
        const intensity = Number(m.properties.get('emissiveIntensity') ?? 1);
        const factor = (m.properties.get('emissiveFactor') ?? [0, 0, 0]) as number[];
        return intensity > 0 && (factor[0] > 0 || factor[1] > 0 || factor[2] > 0);
    }

    /** World AABB of the oriented box, over its 8 corners. Live cached reference. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (!this._worldBoxDirty) return this._worldBox;
        const world = this.volumeMatrix;
        const { min, max } = this._worldBox;
        vec3.set(min, Infinity, Infinity, Infinity);
        vec3.set(max, -Infinity, -Infinity, -Infinity);
        const corner = DecalNode._corner;
        for (let i = 0; i < 8; i++) {
            vec3.set(corner, (i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5);
            vec3.transformMat4(corner, corner, world);
            vec3.min(min, min, corner);
            vec3.max(max, max, corner);
        }
        this._worldBoxDirty = false;
        return this._worldBox;
    }

    /**
     * What an editor click picks this decal by: a compact box at the centre of the volume's TOP face,
     * where the editor draws the decal's icon — never the volume itself.
     *
     * A decal is a projection, not a solid. Its box routinely encloses the ground and the meshes it lands
     * on, so ray-picking the volume (as `Raycaster` does every other node's bounds) would swallow every
     * click and every drop aimed at them. `Raycaster` asks for this hook by name; nothing else does.
     */
    public pickBox(): { min: vec3, max: vec3 } {
        const top = vec3.transformMat4(DecalNode._corner, [0, 0.5, 0], this.volumeMatrix);
        const h = DecalNode.PICK_HALF_EXTENT;
        return {
            min: vec3.fromValues(top[0] - h, top[1] - h, top[2] - h),
            max: vec3.fromValues(top[0] + h, top[1] + h, top[2] + h),
        };
    }
    /** Half the pick box's edge, in world units: about the size of the editor icon. */
    public static readonly PICK_HALF_EXTENT = 0.4;

    /** Sphere through the box's farthest corner, for frustum culling. Live cached reference. */
    public getBoundingSphere(): { center: vec3; radius: number } {
        if (!this._worldSphereDirty) return this._worldSphere;
        const world = this.volumeMatrix;
        const center = this._worldSphere.center;
        vec3.set(center, world[12], world[13], world[14]);
        let radius = 0;
        const corner = DecalNode._corner;
        for (let i = 0; i < 8; i++) {
            vec3.set(corner, (i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5);
            vec3.transformMat4(corner, corner, world);
            radius = Math.max(radius, vec3.distance(corner, center));
        }
        this._worldSphere.radius = radius;
        this._worldSphereDirty = false;
        return this._worldSphere;
    }

    // --- Serialization ----------------------------------------------------------------------------

    protected _serializePayload(): any {
        const r = this._radial;
        return {
            // One nested key, so nothing here can collide with a base Node field — and deliberately no
            // key called `materialId`: the editor's asset graph reads that name as a TERRAIN material.
            // The library link rides in the `__materialId` node variable, as it does on a ModelNode.
            decal: {
                size: [this._size[0], this._size[1], this._size[2]],
                opacity: this._opacity,
                sortOrder: this._sortOrder,
                angleFade: this._angleFade,
                depthFade: this._depthFade,
                affects: { ...this._affects },
                receivers: this._receivers,
                pattern: this._pattern,
                radial: {
                    innerColor: [...r.innerColor], outerColor: [...r.outerColor],
                    curve: r.curve, exponent: r.exponent, falloff: r.falloff, shape: r.shape,
                    ringColor: [...r.ringColor], ringWidthPx: r.ringWidthPx, emissive: r.emissive,
                },
                material: this._material ? this._material.serialize() : null,
            },
        };
    }

    /** Tolerant reader: anything missing or malformed falls back to the constructor default. */
    public static optionsFromJson(d: any): DecalOptions {
        if (!d || typeof d !== 'object') return {};
        const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
        let material: Material | null = null;
        if (d.material && typeof d.material === 'object') {
            try {
                const parsed = Material.parse(d.material);
                material = (parsed.type as string) === PBR_TYPE ? parsed : null;
            } catch (e) {
                Logger.warn(`Decal material could not be parsed: ${(e as Error).message}`, 'Scene');
            }
        }
        return {
            // All three components or none. A single non-number used to reach the setter as NaN, which
            // poisons the volume matrix, the bounds and the frustum test at once — and re-saves as `null`.
            size: Array.isArray(d.size) && d.size.length === 3 && d.size.every((v: unknown) => num(v) !== undefined)
                ? [d.size[0], d.size[1], d.size[2]] : undefined,
            material,
            opacity: num(d.opacity),
            sortOrder: num(d.sortOrder),
            angleFade: num(d.angleFade),
            depthFade: num(d.depthFade),
            affects: d.affects && typeof d.affects === 'object' ? {
                ...(typeof d.affects.albedo === 'boolean' ? { albedo: d.affects.albedo } : {}),
                ...(typeof d.affects.normal === 'boolean' ? { normal: d.affects.normal } : {}),
                ...(typeof d.affects.surface === 'boolean' ? { surface: d.affects.surface } : {}),
                ...(typeof d.affects.emissive === 'boolean' ? { emissive: d.affects.emissive } : {}),
            } : undefined,
            receivers: d.receivers,
            pattern: d.pattern,
            radial: d.radial && typeof d.radial === 'object' ? d.radial : undefined,
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new DecalNode(json.name, DecalNode.optionsFromJson(json.decal), json.id);
        Node.finishParse(node, parent, json);
    }

    private static _radialFrom(v: Partial<DecalRadialPattern> | undefined): DecalRadialPattern {
        const d = DEFAULT_RADIAL;
        const num = (x: unknown, fallback: number) => (typeof x === 'number' && isFinite(x) ? x : fallback);
        return {
            innerColor: color(v?.innerColor, d.innerColor),
            outerColor: color(v?.outerColor, d.outerColor),
            curve: DECAL_RADIAL_CURVES.includes(v?.curve as DecalRadialCurve) ? v!.curve! : d.curve,
            exponent: Math.max(0, num(v?.exponent, d.exponent)),
            falloff: Math.min(1, Math.max(0, num(v?.falloff, d.falloff))),
            shape: v?.shape === 'square' ? 'square' : 'circle',
            ringColor: color(v?.ringColor, d.ringColor),
            ringWidthPx: Math.max(0, num(v?.ringWidthPx, d.ringWidthPx)),
            emissive: Math.max(0, num(v?.emissive, d.emissive)),
        };
    }
}
