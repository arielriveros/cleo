// Authored curves and gradients for the particle system, and their bake into the per-emitter LUT.
//
// The GPU never evaluates a curve. Every curve and gradient an emitter uses is sampled here into one row
// of a small float texture, and the shaders read that row with two `textureLoad`s and a lerp — the same
// trade every modern GPU particle system makes (VFX Graph bakes to textures, Niagara to LUTs): a fixed
// cost per lookup whatever the key count, and no key arrays in a uniform block.

/** One key of a {@link Curve}. Tangents are slopes (dv/dt); absent means "auto" (Catmull-Rom). */
export interface CurveKey {
    t: number;
    v: number;
    inTangent?: number;
    outTangent?: number;
}

/** A scalar function of normalized time, cubic Hermite between keys and flat beyond the ends. */
export interface Curve {
    keys: CurveKey[];
}

export interface ColorKey { t: number; c: [number, number, number]; }
export interface AlphaKey { t: number; a: number; }

/** Colour and alpha keyed separately, as every DCC and engine gradient editor does. Linear between keys. */
export interface Gradient {
    color: ColorKey[];
    alpha: AlphaKey[];
}

export function constantCurve(v: number): Curve {
    return { keys: [{ t: 0, v }, { t: 1, v }] };
}

export function linearCurve(from: number, to: number): Curve {
    return { keys: [{ t: 0, v: from }, { t: 1, v: to }] };
}

export function whiteGradient(): Gradient {
    return { color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }] };
}

/** White, fading in quickly and out slowly — the default "colour over life" every engine ships. */
export function fadeGradient(): Gradient {
    return {
        color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }],
        alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 0.7, a: 1 }, { t: 1, a: 0 }],
    };
}

const finite = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Tolerant parse: drops malformed keys, sorts, and never returns an empty curve. */
export function parseCurve(json: any, fallback: Curve = constantCurve(1)): Curve {
    const raw = Array.isArray(json?.keys) ? json.keys : null;
    if (!raw) return { keys: fallback.keys.map(k => ({ ...k })) };
    const keys: CurveKey[] = [];
    for (const k of raw) {
        if (!k || typeof k !== 'object') continue;
        const key: CurveKey = { t: clamp01(finite(k.t, 0)), v: finite(k.v, 0) };
        if (typeof k.inTangent === 'number' && Number.isFinite(k.inTangent)) key.inTangent = k.inTangent;
        if (typeof k.outTangent === 'number' && Number.isFinite(k.outTangent)) key.outTangent = k.outTangent;
        keys.push(key);
    }
    if (keys.length === 0) return { keys: fallback.keys.map(k => ({ ...k })) };
    keys.sort((a, b) => a.t - b.t);
    return { keys };
}

export function parseGradient(json: any, fallback: Gradient = whiteGradient()): Gradient {
    const color: ColorKey[] = [];
    const alpha: AlphaKey[] = [];
    if (Array.isArray(json?.color))
        for (const k of json.color) {
            if (!k || !Array.isArray(k.c)) continue;
            color.push({ t: clamp01(finite(k.t, 0)),
                         c: [finite(k.c[0], 1), finite(k.c[1], 1), finite(k.c[2], 1)] });
        }
    if (Array.isArray(json?.alpha))
        for (const k of json.alpha) {
            if (!k) continue;
            alpha.push({ t: clamp01(finite(k.t, 0)), a: clamp01(finite(k.a, 1)) });
        }
    color.sort((a, b) => a.t - b.t);
    alpha.sort((a, b) => a.t - b.t);
    return {
        color: color.length ? color : fallback.color.map(k => ({ t: k.t, c: [...k.c] as [number, number, number] })),
        alpha: alpha.length ? alpha : fallback.alpha.map(k => ({ ...k })),
    };
}

/** The slope a key leaves with when it carries none: Catmull-Rom from its neighbours, flat at the ends. */
function autoTangent(keys: readonly CurveKey[], i: number): number {
    if (keys.length < 2) return 0;
    const prev = keys[Math.max(0, i - 1)];
    const next = keys[Math.min(keys.length - 1, i + 1)];
    const dt = next.t - prev.t;
    return dt > 1e-6 ? (next.v - prev.v) / dt : 0;
}

/** Evaluate `curve` at `t`, clamped to the first and last key's value outside their range. */
export function evaluateCurve(curve: Curve, t: number): number {
    const keys = curve.keys;
    if (keys.length === 0) return 0;
    if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;

    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.t - a.t;
    if (span <= 1e-6) return b.v;
    const s = (t - a.t) / span;
    // Tangents are dv/dt; Hermite wants them scaled to the segment's parameter span.
    const m0 = (a.outTangent ?? autoTangent(keys, i)) * span;
    const m1 = (b.inTangent ?? autoTangent(keys, i + 1)) * span;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * m0
         + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * m1;
}

function lerpKeys<K extends { t: number }>(keys: readonly K[], t: number, read: (k: K) => number[]): number[] {
    if (keys.length === 0) return [];
    if (t <= keys[0].t) return read(keys[0]);
    const last = keys[keys.length - 1];
    if (t >= last.t) return read(last);
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.t - a.t;
    const s = span > 1e-6 ? (t - a.t) / span : 1;
    const va = read(a), vb = read(b);
    return va.map((x, c) => x + (vb[c] - x) * s);
}

/** Evaluate `gradient` at `t` as linear RGBA. */
export function evaluateGradient(gradient: Gradient, t: number): [number, number, number, number] {
    const rgb = lerpKeys(gradient.color, t, k => k.c);
    const a = lerpKeys(gradient.alpha, t, k => [k.a]);
    return [rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, a[0] ?? 1];
}

/** Texels per LUT row. Matches `PARTICLE_LUT_WIDTH` in `chunks/particleCommon.wgsl`. */
export const LUT_WIDTH = 256;

/**
 * The emitter LUT's rows. Each row is RGBA; scalar curves share a row by channel. The numbers are part of
 * the shader contract — `chunks/particleCommon.wgsl` names the same rows.
 */
export const LUT_ROW = {
    /** rgb = colour over life, a = alpha over life. */
    COLOR_OVER_LIFE: 0,
    /** x = size over life, y = size by speed, z = angular velocity over life, w = speed over life. */
    SCALARS: 1,
    /** rgba = colour by speed. */
    COLOR_BY_SPEED: 2,
    /** rgba = the initial-colour gradient, sampled at a random t per particle. */
    INIT_COLOR: 3,
} as const;
export const LUT_ROWS = 4;

/** A zeroed-to-identity LUT: white colours, unit scalars. What an emitter with no over-life modules reads. */
export function identityLut(): Float32Array {
    const data = new Float32Array(LUT_WIDTH * LUT_ROWS * 4);
    data.fill(1);
    return data;
}

/** Write `gradient` into `row`, every texel at its own centre-free t = i / (W - 1) so both ends are exact. */
export function bakeGradientRow(data: Float32Array, row: number, gradient: Gradient): void {
    for (let i = 0; i < LUT_WIDTH; i++) {
        const c = evaluateGradient(gradient, i / (LUT_WIDTH - 1));
        data.set(c, (row * LUT_WIDTH + i) * 4);
    }
}

/** Write `curve` into one CHANNEL of `row`, leaving the other three alone. */
export function bakeCurveChannel(data: Float32Array, row: number, channel: number, curve: Curve): void {
    for (let i = 0; i < LUT_WIDTH; i++)
        data[(row * LUT_WIDTH + i) * 4 + channel] = evaluateCurve(curve, i / (LUT_WIDTH - 1));
}

/** Sample a baked row on the CPU exactly as the shader does: two texels and a lerp. For tests. */
export function sampleLut(data: Float32Array, row: number, t: number): [number, number, number, number] {
    const x = Math.min(1, Math.max(0, t)) * (LUT_WIDTH - 1);
    const i0 = Math.floor(x), i1 = Math.min(i0 + 1, LUT_WIDTH - 1), f = x - i0;
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const a = data[(row * LUT_WIDTH + i0) * 4 + c], b = data[(row * LUT_WIDTH + i1) * 4 + c];
        out[c] = a + (b - a) * f;
    }
    return out;
}
