// SSAO hemisphere kernel generation. Split out of renderer.ts and kept free of any GL dependency so
// the distribution — the part with a real invariant to get wrong — is unit-testable.

/**
 * Radius multiplier for sample `i` of `count`, in 0.1..1.0.
 *
 * Samples are pushed toward the origin by a quadratic ramp so that most of them land close to the
 * shaded point, where occlusion detail matters, while the last one reaches the full `ssaoRadius`.
 *
 * THE INVARIANT: the ramp must span the samples ACTUALLY USED, so `scale(count - 1, count) === 1`
 * for every count. It previously divided by the kernel array's fixed capacity (64) while the shader
 * read only the first `count` entries, so at 24 samples the largest sample sat at 0.23 — dropping the
 * quality tier quietly shrank the AO radius by ~4.4x instead of merely making it noisier. Anything
 * that changes this function should keep `ssaoKernelScale(count - 1, count)` equal to 1.
 */
export function ssaoKernelScale(i: number, count: number): number {
    const t = count > 1 ? i / (count - 1) : 1;
    return 0.1 + 0.9 * t * t;
}

/**
 * Fill `out` (a Float32Array of at least `count * 3`) with a hemisphere kernel of `count` samples,
 * oriented around +Z. Entries past `count` are zeroed so a stale tail from a larger previous count
 * cannot leak in.
 *
 * `random` is injectable purely so tests can make the distribution deterministic.
 */
export function buildSSAOKernel(out: Float32Array, count: number, random: () => number = Math.random): void {
    const n = Math.max(1, Math.min(Math.floor(out.length / 3), count));
    for (let i = 0; i < n; i++) {
        let x = random() * 2 - 1;
        let y = random() * 2 - 1;
        let z = random(); // hemisphere: z >= 0
        const len = Math.hypot(x, y, z) || 1;
        x /= len; y /= len; z /= len;
        // Random depth within the hemisphere, then the ramp above.
        const r = random();
        const scale = ssaoKernelScale(i, n) * r;
        out[i * 3 + 0] = x * scale;
        out[i * 3 + 1] = y * scale;
        out[i * 3 + 2] = z * scale;
    }
    out.fill(0, n * 3);
}
