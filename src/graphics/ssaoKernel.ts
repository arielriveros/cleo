// SSAO hemisphere kernel generation. No GL dependency.

/**
 * Radius multiplier for sample `i` of `count`, in 0.1..1.0.
 *
 * Invariant: `ssaoKernelScale(count - 1, count)` must equal 1 for every count.
 */
export function ssaoKernelScale(i: number, count: number): number {
    const t = count > 1 ? i / (count - 1) : 1;
    return 0.1 + 0.9 * t * t;
}

/**
 * Fill `out` (at least `count * 3` floats) with a hemisphere kernel oriented around +Z; entries past
 * `count` are zeroed. `random` is injectable so tests can make the distribution deterministic.
 */
export function buildSSAOKernel(out: Float32Array, count: number, random: () => number = Math.random): void {
    const n = Math.max(1, Math.min(Math.floor(out.length / 3), count));
    for (let i = 0; i < n; i++) {
        let x = random() * 2 - 1;
        let y = random() * 2 - 1;
        let z = random(); // hemisphere: z >= 0
        const len = Math.hypot(x, y, z) || 1;
        x /= len; y /= len; z /= len;
        const r = random();
        const scale = ssaoKernelScale(i, n) * r;
        out[i * 3 + 0] = x * scale;
        out[i * 3 + 1] = y * scale;
        out[i * 3 + 2] = z * scale;
    }
    out.fill(0, n * 3);
}
