import { quat, vec3 } from 'gl-matrix';
import type { AnimationSampler } from './animatedModel';

// Sampling one keyframed value at an arbitrary time, the way playback does (`Bone` in animator.ts): one
// value per key, LINEAR lerps/slerps, STEP holds a key until the next. CUBICSPLINE is baked to LINEAR at
// load (samplerBake.ts), so it never reaches here. Shared by the clip edit stack and the retarget, which
// both resample curves and must agree with what the engine plays.

const EPS = 1e-6;

/** Index of the key at or before `t`, clamped so `i` and `i+1` are both in range. */
export function keyIndexAt(input: ArrayLike<number>, t: number): number {
    if (input.length < 2) return 0;
    for (let i = 0; i < input.length - 1; i++) if (t < input[i + 1]) return i;
    return input.length - 2;
}

/** Blend factor between key `i` and `i+1`, clamped to [0,1] so sampling past the end holds, never extrapolates. */
export function keyFactor(input: ArrayLike<number>, i: number, t: number, step = false): number {
    if (input.length < 2) return 0;
    if (step) return t >= input[i + 1] ? 1 : 0;
    const span = input[i + 1] - input[i];
    if (span <= EPS) return 0;
    return Math.min(1, Math.max(0, (t - input[i]) / span));
}

export function sampleVec3(s: AnimationSampler, t: number, out = vec3.create()): vec3 {
    if (!s.input.length) return vec3.set(out, 0, 0, 0);
    if (s.input.length < 2) return vec3.set(out, s.output[0] ?? 0, s.output[1] ?? 0, s.output[2] ?? 0);
    const i = keyIndexAt(s.input, t);
    const a = vec3.fromValues(s.output[i * 3], s.output[i * 3 + 1], s.output[i * 3 + 2]);
    const b = vec3.fromValues(s.output[(i + 1) * 3], s.output[(i + 1) * 3 + 1], s.output[(i + 1) * 3 + 2]);
    return vec3.lerp(out, a, b, keyFactor(s.input, i, t, s.interpolation === 'STEP'));
}

export function sampleQuat(s: AnimationSampler, t: number, out = quat.create()): quat {
    if (!s.input.length) return quat.identity(out);
    const i = keyIndexAt(s.input, t);
    const a = quat.fromValues(s.output[i * 4], s.output[i * 4 + 1], s.output[i * 4 + 2], s.output[i * 4 + 3]);
    quat.normalize(a, a);
    if (s.input.length < 2) return quat.copy(out, a);
    const b = quat.fromValues(
        s.output[(i + 1) * 4], s.output[(i + 1) * 4 + 1], s.output[(i + 1) * 4 + 2], s.output[(i + 1) * 4 + 3]);
    quat.normalize(b, b);
    return quat.normalize(out, quat.slerp(out, a, b, keyFactor(s.input, i, t, s.interpolation === 'STEP')));
}

/** The sorted, de-duplicated union of several samplers' key times. */
export function unionKeyTimes(samplers: AnimationSampler[]): number[] {
    const all: number[] = [];
    for (const s of samplers) for (let i = 0; i < s.input.length; i++) all.push(s.input[i]);
    all.sort((a, b) => a - b);
    const out: number[] = [];
    for (const t of all) if (!out.length || t - out[out.length - 1] > EPS) out.push(t);
    return out;
}
