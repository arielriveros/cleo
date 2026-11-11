// Authored curves and gradients for the particle system, and their bake into the per-emitter LUT.
//
// The GPU never evaluates a curve. Every curve and gradient an emitter uses is sampled here into one row
// of a small float texture, and the shaders read that row with two `textureLoad`s and a lerp — the same
// trade every modern GPU particle system makes (VFX Graph bakes to textures, Niagara to LUTs): a fixed
// cost per lookup whatever the key count, and no key arrays in a uniform block.

// The curve and gradient types and their evaluation are general math and live in core/math.ts; they are
// re-exported here because this is where the particle system, the cleo barrel (`export *`) and the apps'
// deep imports (`cleo/particles/curves`) have always found them.
import { evaluateCurve, evaluateGradient, type Curve, type Gradient } from '../core/math';
export {
    constantCurve, linearCurve, whiteGradient, fadeGradient, parseCurve, parseGradient, evaluateCurve, evaluateGradient,
    type CurveKey, type Curve, type ColorKey, type AlphaKey, type Gradient,
} from '../core/math';

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
