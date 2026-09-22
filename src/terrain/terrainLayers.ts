// The landscape layer stack as DATA: blend rules, the over-compositing that turns per-surface coverage into
// final weights, the flattening of a landscape's base + paint layers into the GPU's surface list, and the
// migration from the old 4-channel normalized splat.
//
// No GL, no scene graph, no Terrain: everything here is a pure function of its arguments so that the one
// CPU copy of the compositing rule — which foliage scatter and coverage queries consult — can be tested
// against the shader's arithmetic without a device. `chunks/terrainLayers.wgsl` is the other copy; the
// functions below say which WGSL function they mirror, and the constants they share are exported.
//
// THE MODEL. A landscape has one BASE layer (a landscape material covering 100% of the ground, no paint
// needed) and an ordered stack of PAINT layers above it, each a landscape material plus a painted 0..1
// mask. A landscape material is an ordered list of SLOTS: slot 0 is the material's own surface, and every
// further slot carries its own blend rule (elevation / slope / noise / height blend / opacity). A slot's
// coverage is its layer's mask times its rule, and every surface is composited over the ones below it —
// so erasing a painted road reveals whatever is underneath, rules included, instead of the old splat's
// renormalization, where painting one layer took weight away from all the others.

/** Surfaces the shader can composite in one pass: base slots + every paint layer's slots, flattened. */
export const MAX_TERRAIN_SURFACES = 16;

/** Paint-layer masks packed per RGBA mask-array slice. */
export const MASK_CHANNELS_PER_SLICE = 4;

/** Paint layers a landscape can hold. Every one needs at least one surface, and the base takes one. */
export const MAX_PAINT_LAYERS = MAX_TERRAIN_SURFACES - 1;

/** Below this, a surface's coverage is treated as absent (mirrors `SURFACE_EPSILON` in the WGSL). */
export const SURFACE_EPSILON = 1e-3;

/**
 * Smallest noise scale in metres. A zero scale would divide the world position by zero; mirrors
 * `NOISE_SCALE_MIN` in the WGSL.
 */
export const NOISE_SCALE_MIN = 0.01;

/**
 * The narrowest fade a range test uses. A falloff of 0 means a hard edge, but `smoothstep` with equal
 * edges divides by zero — undefined in WGSL — so both copies widen it to this instead, in the range's own
 * unit (a tenth of a millimetre, or of a thousandth of a degree). Mirrors `RANGE_FALLOFF_MIN` in the WGSL.
 */
export const RANGE_FALLOFF_MIN = 1e-4;

/** One banded test of a blend rule. `min..max` is fully covered; coverage fades to 0 over `falloff` outside. */
export interface TerrainRuleRange {
    enabled: boolean;
    min: number;
    max: number;
    /** Width of the fade outside `min..max`, in the range's own unit. 0 = a hard edge. */
    falloff: number;
}

/** Spatial noise that breaks a rule's transition zone up into an irregular edge. */
export interface TerrainNoiseRule {
    /** 0 = none, 1 = the transition zone is fully re-drawn by the noise. Acts only where coverage is between 0 and 1. */
    amount: number;
    /** Feature size in METRES. */
    scale: number;
    /** Decorrelates two slots that use the same scale. */
    seed: number;
}

/**
 * Where a landscape-material slot appears. Every test multiplies; a disabled test passes everywhere.
 *
 * UNITS are authored the way an artist thinks about ground, not the way the shader does:
 *   - elevation in METRES ABOVE THE LANDSCAPE'S ORIGIN, so moving the landscape does not move its snow line;
 *   - slope in DEGREES, 0 = flat, 90 = vertical.
 * The shader converts once (see `u_elevRemap` and `slopeDegreesFromNormalY`).
 */
export interface TerrainBlendRule {
    elevation: TerrainRuleRange;
    slope: TerrainRuleRange;
    noise: TerrainNoiseRule;
    /** 0..1. How much the slot's height map sharpens its transition (high spots poke through first). */
    heightBlend: number;
    /** 0..1. Multiplies the final coverage. */
    opacity: number;
}

/** A rule that covers everywhere: both tests off, no noise, full opacity. */
export function defaultBlendRule(): TerrainBlendRule {
    return {
        elevation: { enabled: false, min: 0, max: 100, falloff: 5 },
        slope: { enabled: false, min: 30, max: 90, falloff: 5 },
        noise: { amount: 0, scale: 8, seed: 0 },
        heightBlend: 0,
        opacity: 1,
    };
}

const num = (v: any, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function parseRange(j: any, d: TerrainRuleRange): TerrainRuleRange {
    if (!j || typeof j !== 'object') return { ...d };
    return {
        enabled: !!j.enabled,
        min: num(j.min, d.min),
        max: num(j.max, d.max),
        falloff: Math.max(0, num(j.falloff, d.falloff)),
    };
}

/** Read a rule from JSON, filling anything missing or malformed with the defaults. Never throws. */
export function parseBlendRule(json: any): TerrainBlendRule {
    const d = defaultBlendRule();
    if (!json || typeof json !== 'object') return d;
    return {
        elevation: parseRange(json.elevation, d.elevation),
        slope: parseRange(json.slope, d.slope),
        noise: {
            amount: clamp01(num(json.noise?.amount, d.noise.amount)),
            scale: Math.max(NOISE_SCALE_MIN, num(json.noise?.scale, d.noise.scale)),
            seed: num(json.noise?.seed, d.noise.seed),
        },
        heightBlend: clamp01(num(json.heightBlend, d.heightBlend)),
        opacity: clamp01(num(json.opacity, d.opacity)),
    };
}

/** A deep, JSON-safe copy of a rule. */
export function cloneBlendRule(r: TerrainBlendRule): TerrainBlendRule {
    return {
        elevation: { ...r.elevation },
        slope: { ...r.slope },
        noise: { ...r.noise },
        heightBlend: r.heightBlend,
        opacity: r.opacity,
    };
}

/** Whether a rule can ever take coverage away (a rule that cannot is skipped cheaply on the CPU). */
export function ruleRestricts(r: TerrainBlendRule): boolean {
    return r.elevation.enabled || r.slope.enabled || r.opacity < 1;
}

// --- evaluation -----------------------------------------------------------------------------------

const f32 = Math.fround;

/** `smoothstep` with WGSL's semantics, including the degenerate edge0 == edge1 case the WGSL avoids. */
export function smoothstep(e0: number, e1: number, x: number): number {
    if (e1 === e0) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
}

/**
 * Coverage of one range test at `v`: 1 inside `min..max`, a smoothstep fade to 0 across `falloff` outside
 * each end, and a (near) hard step when the falloff is 0 — see RANGE_FALLOFF_MIN. Mirrors
 * `rangeCoverage` in the WGSL.
 */
export function rangeCoverage(r: TerrainRuleRange, v: number): number {
    if (!r.enabled) return 1;
    const f = Math.max(r.falloff, RANGE_FALLOFF_MIN);
    const lo = smoothstep(r.min - f, r.min, v);
    const hi = 1 - smoothstep(r.max, r.max + f, v);
    return lo * hi;
}

/**
 * Slope in degrees from the Y of a unit normal: 0 facing straight up, 90 vertical. Undersides (a preview
 * sphere's lower half) clamp to 90 rather than reading as a slope beyond vertical, which no authored range
 * would expect. Mirrors `slopeDegrees` in the WGSL.
 */
export function slopeDegreesFromNormalY(ny: number): number {
    return Math.acos(clamp01(ny)) * (180 / Math.PI);
}

/**
 * Move coverage `a` by `t` (-1..1) scaled by `strength` (0..1), but ONLY inside a transition: the shift is
 * weighted by `4a(1-a)`, so a fully covered (1) or fully absent (0) fragment is never touched. This is what
 * makes noise and height blending act on a rule's EDGE rather than punching holes in its interior, and it
 * is the identity at strength 0. Mirrors `transitionShift` in the WGSL.
 */
export function transitionShift(a: number, t: number, strength: number): number {
    return clamp01(a + 4 * a * (1 - a) * t * strength);
}

/** Hoskins' "hash without sine", evaluated in f32 like the GPU does. 0..1. Mirrors `hash12` in the WGSL. */
export function hash12(x: number, y: number): number {
    let px = f32(x * 0.1031), py = f32(y * 0.1031), pz = f32(x * 0.1031);
    px = f32(px - Math.floor(px)); py = f32(py - Math.floor(py)); pz = f32(pz - Math.floor(pz));
    // p3 += dot(p3, p3.yzx + 33.33)
    const d = f32(f32(px * f32(py + 33.33)) + f32(py * f32(pz + 33.33)) + f32(pz * f32(px + 33.33)));
    px = f32(px + d); py = f32(py + d); pz = f32(pz + d);
    const v = f32(f32(px + py) * pz);
    return v - Math.floor(v);
}

/** Smooth value noise on the integer lattice, 0..1. Mirrors `valueNoise` in the WGSL. */
export function valueNoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash12(ix, iy), b = hash12(ix + 1, iy);
    const c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
    const top = a + (b - a) * ux, bot = c + (d - c) * ux;
    return top + (bot - top) * uy;
}

/**
 * The noise a rule's transition is broken up by, at a WORLD x/z, 0..1. Two octaves: one reads as blotches,
 * the second keeps the edge from looking like a blurred circle. Mirrors `ruleNoise` in the WGSL.
 */
export function ruleNoise(n: TerrainNoiseRule, worldX: number, worldZ: number): number {
    const s = 1 / Math.max(n.scale, NOISE_SCALE_MIN);
    const px = worldX * s + n.seed * 19.19, pz = worldZ * s + n.seed * 7.73;
    return 0.62 * valueNoise(px, pz) + 0.38 * valueNoise(px * 2.13 + 5.2, pz * 2.13 + 1.7);
}

/**
 * One surface's alpha — how much of it is laid OVER everything below — before compositing.
 *
 * @param mask    The surface's paint mask, 0..1 (1 for the base layer, which covers everywhere).
 * @param elevation Metres above the landscape origin.
 * @param slopeDeg  Degrees, see {@link slopeDegreesFromNormalY}.
 * @param noise01   {@link ruleNoise} at the fragment. Ignored when the rule has no noise.
 * @param height01  The surface's own height-map texel, 0..1. The CPU has no texture to read and passes 0.5,
 *                  which makes the height term the identity.
 *
 * Mirrors `surfaceAlpha` in the WGSL. The order matters and is shared: mask x range tests, then the noise
 * shift, then the height shift, then opacity.
 */
export function surfaceAlpha(rule: TerrainBlendRule, mask: number, elevation: number, slopeDeg: number,
                             noise01: number, height01 = 0.5): number {
    let a = clamp01(mask) * rangeCoverage(rule.elevation, elevation) * rangeCoverage(rule.slope, slopeDeg);
    if (rule.noise.amount > 0) a = transitionShift(a, noise01 * 2 - 1, rule.noise.amount);
    if (rule.heightBlend > 0) a = transitionShift(a, height01 * 2 - 1, rule.heightBlend);
    return a * clamp01(rule.opacity);
}

/**
 * Over-composite per-surface alphas (ordered BOTTOM to TOP) into final weights, written into `out`.
 * Returns the uncovered remainder — what the landscape's base colour shows through. The base slot's alpha
 * is 1, so for a landscape with a base material the remainder is 0.
 *
 * Mirrors the front-to-back loop in `resolveTerrainSurface`: iterating top-down, each surface takes its
 * alpha of whatever is still uncovered.
 */
export function compositeWeights(alphas: ArrayLike<number>, out: { [i: number]: number; length: number }): number {
    let remaining = 1;
    for (let i = alphas.length - 1; i >= 0; i--) {
        const a = clamp01(alphas[i]);
        out[i] = a * remaining;
        remaining *= 1 - a;
    }
    return remaining;
}

// --- surfaces -----------------------------------------------------------------------------------

/** A material surface resolved to what the shader samples. Independent of where it sits in the stack. */
export interface TerrainSurfaceData {
    albedoId: string | null;
    aoId: string | null;
    normalId: string | null;
    heightId: string | null;
    invertHeight: boolean;
    color: number[];
    metallic: number;
    roughness: number;
    /** UV repeats across the whole landscape. */
    tiling: number;
}

/** The structural slice of a `Material` a surface is derived from. */
export interface SurfaceMaterialLike {
    type: unknown;
    properties: Map<string, any>;
    textures: Map<string, string>;
}

/**
 * Read a surface out of a material of any base shading model. The height map is `displacementMap` and AO
 * `occlusionMap` for every base type — the keys the material editor's slots already write.
 */
export function deriveSurface(m: SurfaceMaterialLike, tiling: number, invertHeight = false): TerrainSurfaceData {
    const p = m.properties, t = m.textures, bt = m.type as string;
    const heightId = t.get('displacementMap') ?? null;
    const aoId = t.get('occlusionMap') ?? null;
    if (bt === 'basic') {
        return {
            albedoId: t.get('texture') ?? null, aoId, normalId: null, heightId, invertHeight,
            color: p.get('color') ?? [1, 1, 1], metallic: 0, roughness: 1, tiling,
        };
    }
    if (bt === 'pbr') {
        return {
            albedoId: t.get('baseColorTexture') ?? null, aoId, normalId: t.get('normalMap') ?? null,
            heightId, invertHeight, color: p.get('baseColor') ?? [1, 1, 1],
            metallic: p.get('metallic') ?? 0, roughness: p.get('roughness') ?? 1, tiling,
        };
    }
    // blinn_phong, and anything unrecognised — the same fallthrough Material.serialize takes.
    return {
        albedoId: t.get('baseTexture') ?? null, aoId, normalId: t.get('normalMap') ?? null,
        heightId, invertHeight, color: p.get('diffuse') ?? [1, 1, 1], metallic: 0, roughness: 0.7, tiling,
    };
}

/** One slot of a landscape material as the stack sees it. */
export interface TerrainSlotSource {
    surface: TerrainSurfaceData;
    rule: TerrainBlendRule;
    allowFoliage: boolean;
}

/** One layer of the stack: the base (`mask` -1) or a paint layer (`mask` = its channel). */
export interface TerrainLayerSource {
    slots: TerrainSlotSource[];
    /** Mask channel, or -1 for the base, which covers everywhere. */
    mask: number;
    visible: boolean;
    /** Multiplies every slot's opacity. */
    opacity: number;
}

/** A surface in the GPU's flat list, bottom to top. */
export interface TerrainFlatSurface extends TerrainSlotSource {
    /** Index into the layer list it came from (0 = base). */
    layer: number;
    /** Slot index within that layer's material. */
    slot: number;
    /** Mask channel, -1 = no mask (covers). */
    mask: number;
    /** The base layer's first slot: coverage is forced to 1, whatever its rule says. */
    fill: boolean;
}

/**
 * Flatten a layer stack (base first) into the ordered surface list the shader composites, capped at
 * {@link MAX_TERRAIN_SURFACES}. Hidden layers are skipped; the cap keeps the BOTTOM of the stack, because
 * losing the base would leave bare base colour under everything.
 *
 * A layer's opacity multiplies into each slot's rule, so the shader has one opacity per surface.
 */
export function flattenSurfaces(layers: TerrainLayerSource[]): { surfaces: TerrainFlatSurface[]; truncated: boolean } {
    const surfaces: TerrainFlatSurface[] = [];
    let truncated = false;
    for (let li = 0; li < layers.length; li++) {
        const L = layers[li];
        if (!L.visible) continue;
        for (let si = 0; si < L.slots.length; si++) {
            if (surfaces.length >= MAX_TERRAIN_SURFACES) { truncated = true; break; }
            const s = L.slots[si];
            const rule = cloneBlendRule(s.rule);
            rule.opacity = clamp01(rule.opacity * clamp01(L.opacity));
            surfaces.push({
                surface: s.surface, rule, allowFoliage: s.allowFoliage,
                layer: li, slot: si, mask: L.mask, fill: L.mask < 0 && si === 0,
            });
        }
    }
    return { surfaces, truncated };
}

/**
 * Final per-surface weights at one point, bottom to top, into `out` (resized to fit). The CPU twin of the
 * shader's compositing, minus the height term (no height maps on the CPU).
 *
 * @param maskAt Paint mask of channel `c` at this point, 0..1.
 */
export function surfaceWeightsAt(surfaces: readonly TerrainFlatSurface[], maskAt: (channel: number) => number,
                                 elevation: number, slopeDeg: number, worldX: number, worldZ: number,
                                 out: number[]): number {
    const alphas = new Array<number>(surfaces.length);
    for (let i = 0; i < surfaces.length; i++) {
        const s = surfaces[i];
        if (s.fill) { alphas[i] = 1; continue; }
        const mask = s.mask < 0 ? 1 : maskAt(s.mask);
        const noise = s.rule.noise.amount > 0 ? ruleNoise(s.rule.noise, worldX, worldZ) : 0.5;
        alphas[i] = surfaceAlpha(s.rule, mask, elevation, slopeDeg, noise);
    }
    out.length = surfaces.length;
    return compositeWeights(alphas, out);
}

// --- legacy migration ---------------------------------------------------------------------------

/**
 * The legacy per-layer "auto" mask as a blend rule.
 *
 * The old shader multiplied a layer's splat weight by `band(hRange, worldY, 2) * band(sRange, 1 - N.y, 0.08)`
 * where `band` smoothsteps across `[lo - e, lo + e]` and `[hi - e, hi + e]`. With this module's ranges
 * (covered inside `min..max`, fading over `falloff` outside) that is EXACTLY `min = lo + e`, `max = hi - e`,
 * `falloff = 2e` for elevation. Slope was in `1 - cos` units and is now degrees, so its edges are converted
 * point by point and the fade is their average width — close, not exact, and only for `auto` layers.
 *
 * `originY` converts the old WORLD-Y band into metres above the landscape's origin.
 */
export function legacyAutoRule(auto: boolean, hRange: readonly number[] | undefined,
                               sRange: readonly number[] | undefined, originY = 0): TerrainBlendRule {
    const rule = defaultBlendRule();
    if (!auto) return rule;
    const hLo = num(hRange?.[0], 0), hHi = num(hRange?.[1], 100);
    const he = 2;
    let eMin = hLo + he - originY, eMax = hHi - he - originY;
    if (eMax < eMin) eMin = eMax = (eMin + eMax) / 2;
    rule.elevation = { enabled: true, min: eMin, max: eMax, falloff: 2 * he };

    const deg = (s: number) => Math.acos(1 - clamp01(s)) * (180 / Math.PI);
    const sLo = clamp01(num(sRange?.[0], 0)), sHi = clamp01(num(sRange?.[1], 1));
    const se = 0.08;
    let sMin = deg(sLo + se), sMax = deg(sHi - se);
    if (sMax < sMin) sMin = sMax = (sMin + sMax) / 2;
    const fade = ((deg(sLo + se) - deg(sLo - se)) + (deg(sHi + se) - deg(sHi - se))) / 2;
    rule.slope = { enabled: true, min: sMin, max: sMax, falloff: Math.max(0, fade) };
    // An edge at the very end of the old range meant "no limit that side"; keep it open.
    if (sLo <= 0) rule.slope.min = -1e-3;
    if (sHi >= 1) rule.slope.max = 90 + 1e-3;
    if (hLo <= -1e5) rule.elevation.min = -1e9;
    return rule;
}

/**
 * Convert one legacy splat texel (four NORMALIZED weights, layer 0 at the bottom) into the over-alphas of
 * layers 1..3 that composite to exactly the same weights over a base of layer 0.
 *
 * Over-compositing gives layer k the weight `a_k * prod_{j>k}(1 - a_j)`. Peeling from the top:
 * `a3 = w3`, `a2 = w2 / (1 - w3)`, `a1 = w1 / (1 - w3 - w2)`, and layer 0 takes what is left, which is
 * `w0`. A denominator at zero means nothing below is visible, so its alpha is irrelevant; 0 is written.
 *
 * `out` receives [a1, a2, a3]. Weights need not be normalized; they are divided by their sum first, which
 * is what the old shader did.
 */
export function legacySplatAlphas(w0: number, w1: number, w2: number, w3: number, out: number[]): void {
    const sum = w0 + w1 + w2 + w3;
    if (sum <= 0) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
    const n1 = w1 / sum, n2 = w2 / sum, n3 = w3 / sum;
    const EPS = 1e-6;
    out[2] = clamp01(n3);
    let rem = 1 - n3;
    out[1] = rem > EPS ? clamp01(n2 / rem) : 0;
    rem -= n2;
    out[0] = rem > EPS ? clamp01(n1 / rem) : 0;
}

/**
 * A legacy RGBA splat (4 normalized channels per texel) as paint-mask bytes for legacy layers 1..3,
 * written into channels 0..2 of an RGBA mask slice of the same texel count. Channel 3 is left at 0.
 */
export function legacySplatToMasks(splat: Uint8Array, texels: number): Uint8Array {
    const out = new Uint8Array(texels * 4);
    const a = [0, 0, 0];
    for (let i = 0; i < texels; i++) {
        const b = i * 4;
        legacySplatAlphas(splat[b], splat[b + 1], splat[b + 2], splat[b + 3], a);
        out[b] = Math.round(a[0] * 255);
        out[b + 1] = Math.round(a[1] * 255);
        out[b + 2] = Math.round(a[2] * 255);
    }
    return out;
}
