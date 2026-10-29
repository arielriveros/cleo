/** Constrain `v` to [lo, hi]. `lo` wins when the bounds are inverted. */
export function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}
