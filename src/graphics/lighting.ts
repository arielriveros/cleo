import { vec3 } from "gl-matrix";

// -----------------------------------------------------------------------------------------------
// Lights carry PHOTOMETRIC intensity: lux for a directional light, lumens for a point or spot. What
// they replaced was the Phong-era triple of `diffuse` / `specular` / `ambient` colours plus a
// `constant / linear / quadratic` attenuation denominator, which had three problems that no amount of
// tuning fixes:
//
//   1. Brightness had no home. A light was made brighter by pushing its COLOUR above 1 or by editing
//      three coefficients whose product is not a physical quantity, so no two lights in a scene were
//      comparable and none of them was comparable to the sun.
//   2. `1 / (c + l*d + q*d^2)` is not inverse-square and never reaches zero, so a light has no radius,
//      cannot be culled, and its falloff shape is authored rather than derived.
//   3. `specular` was uploaded and IGNORED by every PBR path, and `ambient` was added as a flat,
//      non-directional fill on every pixel the light could not possibly reach. Between them they made
//      energy conservation unauthorable.
//
// See DIRECT_LIGHTING_ROADMAP.md. The migration below is what keeps existing scenes looking the same.
// -----------------------------------------------------------------------------------------------

/**
 * Marker stamped on a light payload whose numbers are photometric. Mirrors `FOLIAGE_DENSITY_UNIT`:
 * a unit marker rather than a version integer, so the conversion is idempotent by construction and a
 * serialize/parse round trip cannot apply it twice.
 */
export const LIGHT_UNIT = 'photometric';

/**
 * The illuminance a legacy `diffuse = 1.0` stood for, and the anchor that keeps this whole change from
 * moving every exposure in every project.
 *
 * Photometric values are divided by this on the way to the shader, so the INTERNAL radiance scale is
 * exactly what it was before. `Renderer._exposure = 2.0` still means what it meant; every stored
 * `config.render.exposure` is still valid; and a scene lit only by a white directional light is
 * pixel-identical across the change, because its shader input is `78643.2 / 78643.2 = 1`.
 *
 * The number is not arbitrary: `2.0 * 1.2 * 2^15` is the illuminance the default exposure meters at
 * EV100 15, the sunny-16 exposure. So `exposure = REFERENCE_ILLUMINANCE / (1.2 * 2^EV100)` makes
 * EV100 15 and exposure 2.0 the same setting, and the EV control is a pure re-parameterisation.
 */
export const REFERENCE_ILLUMINANCE = 78643.2;

/** Clear midday sun. Bright, but a bit under the ~120,000 lx peak — that is a summer noon, not a default. */
export const DEFAULT_DIRECTIONAL_LUX = 100000;
/** The sun's apparent radius: half of 0.53 degrees, in radians. Drives the sun's specular disc. */
export const DEFAULT_ANGULAR_RADIUS = 0.00465;
/** A bright household bulb — the 100 W-equivalent everyone pictures when they add a point light. */
export const DEFAULT_LUMENS = 1500;
/** Metres. Where the windowed falloff reaches exactly zero, which is also the light's culling radius. */
export const DEFAULT_RANGE = 10;
/** Metres. A 5 cm bulb: small enough to read as a point, big enough to soften a highlight. */
export const DEFAULT_SOURCE_RADIUS = 0.05;

/** The neutral fill a scene starts with, in lux. Matches the legacy `ambient` default of 0.1. */
export const DEFAULT_SCENE_AMBIENT_LUX = 0.1 * REFERENCE_ILLUMINANCE;

/**
 * The shader-side light array sizes. Hand-matched to `array<PointLight, N>` in the four lighting
 * blocks, and gated by `npm run harness:uniforms`, which compares every computed offset against a real
 * driver — a mismatch here moves every member after the array and the whole block reads garbage.
 *
 * They live here rather than in the renderer because the SCENE has to know them too: it stops
 * numbering lights at the cap, and a light past it gets index -1 instead of an out-of-range slot.
 * `systems/customShaders.ts` does not use these — it derives the same numbers from the reflected
 * layout of `pbr.wgsl`, which is a stronger check and available to it because it already imports the
 * program.
 */
export const MAX_POINT_LIGHTS = 16;
export const MAX_SPOTLIGHTS = 8;

/** Fraction of peak brightness at which a legacy falloff curve is treated as having ended. */
const LEGACY_RANGE_CUTOFF = 1 / 256;

interface LightProperties {
    /**
     * Radiance colour, nominally in [0,1]. Magnitude belongs to `intensity` — a colour above 1 still
     * works, it is just no longer how brightness is expressed.
     */
    color?: vec3;
    /** `LIGHT_UNIT` on a photometric payload; absent or anything else means "legacy, migrate me". */
    unit?: string;

    /** @deprecated Pre-photometric radiance. Converted by the constructor; see {@link LIGHT_UNIT}. */
    diffuse?: vec3;
    /** @deprecated Never read by any PBR path. Dropped on migration. */
    specular?: vec3;
    /** @deprecated Flat indirect fill. Becomes the SCENE's ambient; see `legacyAmbientFromSceneJson`. */
    ambient?: vec3;
}

/** The magnitude a legacy colour carried, and the unit colour left behind once it is taken out.
 *
 * `max`, deliberately, not luminance: dividing `[1, 0.55, 0.2]` by its luminance gives components
 * above 1, which the editor's hex colour input can neither show nor round-trip. `max` always leaves a
 * colour inside the cube, with the brightest channel pinned at 1.
 */
function splitMagnitude(colour: vec3 | undefined): { color: vec3; magnitude: number } {
    const c = colour ?? [1, 1, 1];
    const magnitude = Math.max(c[0], c[1], c[2]);
    if (!(magnitude > 0)) return { color: vec3.fromValues(1, 1, 1), magnitude: 0 };
    return { color: vec3.fromValues(c[0] / magnitude, c[1] / magnitude, c[2] / magnitude), magnitude };
}

/**
 * Distance at which the legacy attenuation `1 / (c + l*d + q*d^2)` has fallen to `ratio` of its peak.
 *
 * The 1/256 case is a light's effective RANGE, and it is the same solve `spotShadowFar` used to do for
 * its shadow far plane — which is why that function now takes a range instead of computing one. Two
 * copies of this arithmetic would let a migrated spot light's shadow frustum end somewhere other than
 * its light, and the symptom (shadows clipped partway down the cone) does not look like a unit bug.
 */
export function legacyFalloffDistance(constant: number, linear: number, quadratic: number,
                                      ratio: number, fallback: number): number {
    const target = 1 / Math.max(1e-6, ratio);   // c + l*d + q*d^2 == target
    const b = target - constant;
    let d: number;
    if (quadratic > 1e-9) {
        const disc = linear * linear + 4 * quadratic * b;
        d = disc > 0 ? (-linear + Math.sqrt(disc)) / (2 * quadratic) : 0;
    } else if (linear > 1e-9) {
        d = b / linear;
    } else {
        // No falloff at all. Nothing in the curve bounds it, so the caller's fallback does.
        d = fallback;
    }
    if (!(d > 0) || !isFinite(d)) d = fallback;
    return d;
}

/** A legacy light's effective range: where its attenuation reaches 1/256 of peak. */
export function legacyRange(constant: number, linear: number, quadratic: number): number {
    return Math.max(0.01, legacyFalloffDistance(constant, linear, quadratic, LEGACY_RANGE_CUTOFF, 100));
}

/**
 * The windowed inverse-square falloff, in JS. The twin of `distanceAttenuation` in
 * chunks/pbrLighting.wgsl — this exists so the migration can FIT against the curve the shader will
 * actually evaluate rather than against an idealised `1/d^2`.
 */
export function distanceAttenuation(distance: number, range: number): number {
    const d2 = distance * distance;
    const f = d2 / Math.max(1e-6, range * range);
    const w = Math.max(0, 1 - f * f);
    return (w * w) / Math.max(d2, 1e-4);
}

/**
 * Luminous intensity, in the engine's internal radiance units, that reproduces a legacy point or spot
 * light as closely as one curve can reproduce another.
 *
 * The two curves cannot be made equal — `1 / (c + l*d + q*d^2)` is finite at d = 0 and `I / d^2` is
 * not — so this matches them at the HALF-BRIGHTNESS distance. That is the distance at which the light
 * visibly reads, so the error lands where nobody is looking: matching at 1 m instead blows out
 * everything near the source, and matching near the range makes the light disappear.
 *
 * BE WARNED WHAT COMES OUT. The default legacy point light (c=1, l=0.09, q=0.032) is half-bright at
 * 4.36 m and migrates to roughly 9.4 MILLION lumens. That is not the fit failing. Legacy content
 * genuinely asserts that a lamp is as bright at 1 m as the sun is, because the sun was `diffuse = 1`
 * and so was the lamp. The contract here is "the same picture", not "sane numbers", and the two cannot
 * both hold — which is why a migrated light is flagged `legacyFalloff` and says so in the inspector.
 */
function fitLegacyIntensity(magnitude: number, constant: number, linear: number, quadratic: number,
                            range: number): number {
    const half = legacyFalloffDistance(constant, linear, quadratic, 0.5, range * 0.5);
    const dHalf = Math.min(Math.max(half, 0.01), range * 0.99);
    const attenuation = distanceAttenuation(dHalf, range);
    if (!(attenuation > 0)) return DEFAULT_LUMENS;
    // 0.5 is what the old curve returns at dHalf, by construction.
    const internal = (0.5 * magnitude) / attenuation;
    return internal * REFERENCE_ILLUMINANCE * 4 * Math.PI;
}

/**
 * The scene-wide fill recovered from a pre-photometric save, in lux.
 *
 * `light.ambient` was per-light but behaved as though it were not: every path added the DIRECTIONAL
 * light's copy, unconditionally, to every pixel. So the value belongs to the scene, and this walks a
 * raw scene JSON for the first un-migrated directional light to find it. Raw JSON rather than parsed
 * nodes on purpose — it runs before the tree exists, and it is testable without one.
 *
 * Returns `null` when the save has no legacy directional light to take a fill from, which is the
 * signal to use `DEFAULT_SCENE_AMBIENT_LUX` instead of black.
 */
export function legacyAmbientFromSceneJson(json: any): vec3 | null {
    let found: vec3 | null = null;

    const walk = (node: any) => {
        if (!node || typeof node !== 'object' || found) return;
        if (node.lightType === 'directional' && node.light && node.light.unit !== LIGHT_UNIT
            && Array.isArray(node.light.ambient)) {
            const a = node.light.ambient;
            found = vec3.fromValues(a[0] * REFERENCE_ILLUMINANCE, a[1] * REFERENCE_ILLUMINANCE,
                                    a[2] * REFERENCE_ILLUMINANCE);
            return;
        }
        for (const child of node.children ?? []) walk(child);
    };

    walk(json?.scene ?? json);
    return found;
}

export class Light {
    private _color: vec3;
    /**
     * Set when this light's numbers came out of the legacy migration rather than being authored. The
     * editor uses it to explain an absurd-looking intensity and to offer a reset; nothing in the
     * renderer reads it.
     */
    public legacyFalloff: boolean = false;

    constructor(properties: LightProperties) {
        if (properties.unit === LIGHT_UNIT || properties.color !== undefined) {
            this._color = vec3.clone((properties.color ?? [1, 1, 1]) as vec3);
        } else {
            // The magnitude is not lost: each subclass takes it as its intensity.
            this._color = splitMagnitude(properties.diffuse).color;
        }
    }

    public get color(): vec3 { return this._color; }
    public set color(value: vec3) { this._color = value; }

    /**
     * @deprecated Pre-photometric alias for {@link color}. Kept because editor code, preview scenes
     * and the harness pages all name it; it is the COLOUR only, never the brightness.
     */
    public get diffuse(): vec3 { return this._color; }
    public set diffuse(value: vec3) { this._color = value; }
}

export interface DirectionalLightProperties extends LightProperties {
    /** Illuminance on a surface facing the light, in LUX. */
    intensity?: number;
    /** Apparent radius of the source, in radians. The sun is 0.00465. */
    angularRadius?: number;
}

export class DirectionalLight extends Light {
    private _intensity: number;
    private _angularRadius: number;

    constructor(properties: DirectionalLightProperties) {
        super(properties);
        // `??`, not `||`: a light switched off is `intensity: 0`, and `||` would silently restore the
        // default. Under the old colour-as-brightness model a zero could not be expressed at all, so
        // this only became a real bug the moment intensity became a number.
        if (properties.unit === LIGHT_UNIT || properties.intensity !== undefined) {
            this._intensity = properties.intensity ?? DEFAULT_DIRECTIONAL_LUX;
        } else {
            // Exact, not a fit: illuminance is the magnitude the colour used to carry.
            const legacy = splitMagnitude(properties.diffuse);
            this._intensity = legacy.magnitude * REFERENCE_ILLUMINANCE;
        }
        this._angularRadius = properties.angularRadius ?? DEFAULT_ANGULAR_RADIUS;
    }

    /** Illuminance perpendicular to the light, in lux. */
    public get intensity(): number { return this._intensity; }
    public set intensity(value: number) { this._intensity = value; }
    public get angularRadius(): number { return this._angularRadius; }
    public set angularRadius(value: number) { this._angularRadius = value; }

    /** What the shader receives: lux on the engine's internal radiance scale. */
    public get internalIntensity(): number { return this._intensity / REFERENCE_ILLUMINANCE; }
}

export interface PointLightProperties extends LightProperties {
    /** Luminous power, in LUMENS. */
    intensity?: number;
    /** Metres at which the windowed falloff reaches zero. Also the light's culling radius. */
    range?: number;
    /** Radius of the emitting sphere, in metres. Widens the specular highlight and softens shadows. */
    sourceRadius?: number;

    /** @deprecated Pre-photometric attenuation denominator. */
    constant?: number;
    /** @deprecated */
    linear?: number;
    /** @deprecated */
    quadratic?: number;
}

/**
 * Shared by point and spot, which differ only by the cone. Both carry luminous POWER; the conversion
 * to intensity is `lm / 4pi` for either, so narrowing a spot's cone does not brighten it. That is
 * Unreal's candela convention rather than its lumen one, and it is the behaviour an artist expects
 * when dragging a cone-angle slider.
 */
abstract class PunctualLight extends Light {
    private _intensity: number;
    private _range: number;
    private _sourceRadius: number;

    constructor(properties: PointLightProperties) {
        super(properties);
        this._sourceRadius = properties.sourceRadius ?? DEFAULT_SOURCE_RADIUS;

        if (properties.unit === LIGHT_UNIT || properties.intensity !== undefined) {
            this._intensity = properties.intensity ?? DEFAULT_LUMENS;
            this._range = properties.range ?? DEFAULT_RANGE;
            return;
        }

        const constant = properties.constant ?? 1.0;
        const linear = properties.linear ?? 0.09;
        const quadratic = properties.quadratic ?? 0.032;
        this._range = properties.range ?? legacyRange(constant, linear, quadratic);
        this._intensity = fitLegacyIntensity(splitMagnitude(properties.diffuse).magnitude,
                                             constant, linear, quadratic, this._range);
        this.legacyFalloff = true;
    }

    /** Luminous power, in lumens. */
    public get intensity(): number { return this._intensity; }
    public set intensity(value: number) { this._intensity = value; }
    public get range(): number { return this._range; }
    public set range(value: number) { this._range = Math.max(0.01, value); }
    public get sourceRadius(): number { return this._sourceRadius; }
    public set sourceRadius(value: number) { this._sourceRadius = Math.max(0, value); }

    /** What the shader receives: candela on the engine's internal radiance scale. */
    public get internalIntensity(): number {
        return this._intensity / (4 * Math.PI) / REFERENCE_ILLUMINANCE;
    }

    /** `1 / range^2`, which is the form the falloff wants — computed here so the shader does not divide. */
    public get invRangeSquared(): number { return 1 / (this._range * this._range); }

    /** Reset to the defaults a freshly added light would have. What the editor's reset button calls. */
    public resetToPhysicalDefaults(): void {
        this._intensity = DEFAULT_LUMENS;
        this._range = DEFAULT_RANGE;
        this._sourceRadius = DEFAULT_SOURCE_RADIUS;
        this.legacyFalloff = false;
    }
}

export class PointLight extends PunctualLight {}

export interface SpotlightProperties extends PointLightProperties {
    /** Inner half-angle, in DEGREES. Full brightness inside this cone. */
    cutOff?: number;
    /** Outer half-angle, in DEGREES. Zero outside it; must be larger than `cutOff`. */
    outerCutOff?: number;
}

export class Spotlight extends PunctualLight {
    private _cutOff: number;
    private _outerCutOff: number;

    constructor(properties: SpotlightProperties) {
        super(properties);
        this._cutOff = properties.cutOff ?? 30.5;
        this._outerCutOff = properties.outerCutOff ?? 35.5;
    }

    public get cutOff(): number { return this._cutOff; }
    public set cutOff(value: number) { this._cutOff = value; }
    public get outerCutOff(): number { return this._outerCutOff; }
    public set outerCutOff(value: number) { this._outerCutOff = value; }

    /**
     * The cone falloff, pre-solved into the `saturate(cosAngle * scale + offset)` the shader wants.
     *
     * Derived here rather than in the shader for the same reason the cutoffs were already uploaded as
     * cosines: it is per-light, not per-pixel, and the `1 / (cosInner - cosOuter)` divide was
     * unguarded in four separate shader copies — inner == outer divided by zero in all of them.
     */
    public get coneScaleOffset(): [number, number] {
        const cosOuter = Math.cos(this._outerCutOff * Math.PI / 180);
        const cosInner = Math.cos(this._cutOff * Math.PI / 180);
        const scale = 1 / Math.max(cosInner - cosOuter, 1e-4);
        return [scale, -cosOuter * scale];
    }
}
