// Keyframe lookup for clip sampling: the segment a time falls in, found from where the last lookup
// left off.
//
// Sampling is the animation hot path — every channel of every bone of every clip a character blends,
// every frame — and the lookup used to be a linear scan from key 0, so its cost grew with how far into a
// clip the playhead was. Playback almost always moves forward by less than one segment per frame, so the
// previous index (or the one after it) is nearly always the answer; a jump (a seek, a loop wrap, a clip
// sampled at a second time for root motion) falls back to a binary search.

/**
 * The index `i` of the segment [times[i], times[i+1]) that `t` falls in — EXACTLY what the old linear
 * scan returned: the first `i` with `t < times[i + 1]`, or `length - 2` when there is none (at or past
 * the last key, which the caller then clamps). `times` must be non-decreasing and hold at least 2 keys.
 * `hint` is the index the previous lookup returned.
 */
export function findKey(times: ArrayLike<number>, t: number, hint: number): number {
    const last = times.length - 2;
    if (!(t < times[last + 1])) return last;          // at/past the end (and NaN, as before)
    // The hint, then the next segment: one or two comparisons for ordinary forward playback.
    if (hint >= 0 && hint <= last && t < times[hint + 1] && (hint === 0 || !(t < times[hint]))) return hint;
    const next = hint + 1;
    if (next >= 0 && next <= last && t < times[next + 1] && (next === 0 || !(t < times[next]))) return next;
    // First i in [0, last] with t < times[i + 1]: an upper bound over times[1..last+1].
    let lo = 0, hi = last;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t < times[mid + 1]) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/** Whether `times` is non-decreasing, which {@link findKey} relies on. */
export function isSorted(times: ArrayLike<number>): boolean {
    for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) return false;
    return true;
}

/** The old linear scan, for a channel whose times are out of order (and for tests to compare against). */
export function findKeyLinear(times: ArrayLike<number>, t: number): number {
    for (let i = 0; i < times.length - 1; i++) if (t < times[i + 1]) return i;
    return times.length - 2;
}
