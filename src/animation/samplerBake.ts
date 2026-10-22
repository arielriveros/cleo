import type { Animation, AnimationSampler } from './animatedModel';

/**
 * CUBICSPLINE samplers store three values per key — in-tangent, value, out-tangent — so their `output`
 * is three times as long as a LINEAR sampler's. Everything downstream of loading (playback, retargeting,
 * clip edits) reads one value per key, so CUBICSPLINE is resolved once, here, into a LINEAR sampler that
 * evaluates the glTF Hermite curve at each key and at `subdivisions` points inside every segment.
 *
 * STEP samplers keep their layout (one value per key) and are honoured where they are sampled.
 */

const SUBDIVISIONS = 4;

/** The LINEAR equivalent of a CUBICSPLINE sampler, or `sampler` itself for any other interpolation. */
export function bakeCubicSpline(sampler: AnimationSampler, subdivisions = SUBDIVISIONS): AnimationSampler {
    if (sampler.interpolation !== 'CUBICSPLINE') return sampler;
    const keys = sampler.input.length;
    if (!keys) return { input: [], output: [], interpolation: 'LINEAR' };
    const stride = Math.round(sampler.output.length / (keys * 3));
    if (!(stride > 0) || stride * keys * 3 !== sampler.output.length) {
        // Not a well-formed cubic layout: keep the middle (value) third if it divides, else pass through.
        return { input: sampler.input.slice(), output: sampler.output.slice(), interpolation: 'LINEAR' };
    }
    const o = sampler.output;
    const value = (k: number, c: number) => o[(k * 3 + 1) * stride + c];
    const inTan = (k: number, c: number) => o[(k * 3) * stride + c];
    const outTan = (k: number, c: number) => o[(k * 3 + 2) * stride + c];

    const input: number[] = [];
    const output: number[] = [];
    const steps = Math.max(1, subdivisions + 1);
    for (let k = 0; k < keys; k++) {
        input.push(sampler.input[k]);
        for (let c = 0; c < stride; c++) output.push(value(k, c));
        if (k === keys - 1) break;
        const t0 = sampler.input[k], td = sampler.input[k + 1] - t0;
        if (!(td > 0)) continue;
        for (let s = 1; s < steps; s++) {
            const u = s / steps, u2 = u * u, u3 = u2 * u;
            const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
            input.push(t0 + u * td);
            for (let c = 0; c < stride; c++) {
                output.push(h00 * value(k, c) + td * h10 * outTan(k, c) + h01 * value(k + 1, c) + td * h11 * inTan(k + 1, c));
            }
        }
    }
    // Quaternion outputs are renormalized where they are consumed (Bone builds its channel normalized).
    return { input, output, interpolation: 'LINEAR' };
}

/** `clip` with every CUBICSPLINE sampler baked to LINEAR. The same object when there is none. */
export function bakeClipCubicSplines(clip: Animation): Animation {
    if (!clip.samplers.some(s => s.interpolation === 'CUBICSPLINE')) return clip;
    return { ...clip, samplers: clip.samplers.map(s => bakeCubicSpline(s)) };
}
