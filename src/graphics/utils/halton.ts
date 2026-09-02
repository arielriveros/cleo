/**
 * The low-discrepancy sequence TAA jitters the projection along.
 *
 * Pure arithmetic with no engine dependencies, deliberately: it is the one part of the jitter that can
 * be checked without a GPU, and `tests/halton.test.ts` is where the properties below are pinned.
 */

/**
 * The radical inverse of `index` in `base` — Halton's term, in [0, 1).
 *
 * `index` starts at 1, never 0: `halton(0, b)` is 0 for every base, which as a sub-pixel offset is the
 * corner of the pixel rather than a sample within it, and it would repeat every cycle.
 */
export function halton(index: number, base: number): number {
    let fraction = 1;
    let result = 0;
    let i = index;
    while (i > 0) {
        fraction /= base;
        result += fraction * (i % base);
        i = Math.floor(i / base);
    }
    return result;
}

/**
 * `count` sub-pixel offsets from Halton(2, 3), recentred so the set averages to exactly zero.
 *
 * Returned interleaved (x, y, x, y, ...), each component in [-0.5, 0.5] — a displacement in PIXELS
 * from the pixel centre.
 *
 * The recentring is not cosmetic. Over the first 8 indices base 3 happens to average exactly 0.5, but
 * base 2 averages 0.4453125 — so subtracting a flat 0.5 would leave a permanent −0.0547 px horizontal
 * bias baked into every converged frame. Nothing about that is visible in a screenshot; it shows up as
 * a whole image that has quietly shifted a twentieth of a pixel left. Subtracting the set's own mean
 * removes it by construction, at any count, for any pair of bases.
 */
export function haltonSequence(count: number, baseX: number = 2, baseY: number = 3): Float32Array {
    const out = new Float32Array(count * 2);
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < count; i++) {
        const x = halton(i + 1, baseX);
        const y = halton(i + 1, baseY);
        out[i * 2] = x;
        out[i * 2 + 1] = y;
        sumX += x;
        sumY += y;
    }

    const meanX = sumX / count;
    const meanY = sumY / count;
    for (let i = 0; i < count; i++) {
        out[i * 2] -= meanX;
        out[i * 2 + 1] -= meanY;
    }
    return out;
}
