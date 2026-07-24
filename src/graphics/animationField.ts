// ---------------------------------------------------------------------------
// Animation Fields (blend spaces)
//
// A field places animation clips at coordinates in a 1D or 2D parameter space. Sampling it at a probe
// point yields per-clip WEIGHTS; the Animator turns those into one blended pose. This is the continuous
// counterpart to the state machine's discrete states: instead of snapping idle -> walk -> run across
// thresholds, a Speed axis mixes them.
//
// Pure data + math on purpose — no GL, no scene, no engine imports. That keeps it unit-testable and lets
// the editor import the same weighting the runtime uses, so the authoring preview cannot drift from the game.
// ---------------------------------------------------------------------------

export type AnimationFieldMode = '1d' | '2d';

/**
 * One input axis. `min`/`max` are the authored range a parameter is expected to move through; they are also
 * the NORMALIZATION basis for the 2D metric (see fieldWeights), not merely UI hints.
 */
export interface AnimationFieldAxis {
    name: string;
    min: number;
    max: number;
}

export interface AnimationFieldSample {
    /** Name of the clip on the model this sample plays. */
    clipName: string;
    x: number;
    /** 2D fields only; ignored in 1D. */
    y?: number;
    /**
     * Per-sample playback rate multiplier inside the blend (UE5's "rate scale"). A clip authored at half
     * speed can be marked 0.5 so it contributes its real gait length to the synchronized phase. Default 1.
     */
    rateScale?: number;
}

export interface AnimationField {
    mode: AnimationFieldMode;
    xAxis: AnimationFieldAxis;
    /** Present (and used) only when mode === '2d'. */
    yAxis?: AnimationFieldAxis;
    samples: AnimationFieldSample[];
}

export interface FieldWeight {
    sample: AnimationFieldSample;
    /** 0..1. Across a returned set these always sum to 1. */
    weight: number;
}

/** Weights below this are dropped before normalizing, so a large field still evaluates only a few clips. */
const WEIGHT_EPSILON = 1e-4;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Map a value onto 0..1 across an axis's authored range.
 *
 * A degenerate range (min === max, which the editor allows mid-typing) would divide by zero, so it collapses
 * to 0 — every sample then lands on the same coordinate and the weighting below falls back to an even mix
 * rather than producing NaN weights and a collapsed skeleton.
 */
function normalizeAxis(value: number, axis: AnimationFieldAxis | undefined): number {
    if (!axis) return 0;
    const span = axis.max - axis.min;
    if (span === 0) return 0;
    return (value - axis.min) / span;
}

/** The rate scale of a sample, guarded against 0/negative/absent (which would make durations infinite). */
export function rateScaleOf(sample: AnimationFieldSample): number {
    const r = sample.rateScale;
    return typeof r === 'number' && r > 0 ? r : 1;
}

/**
 * 1D: sort by x, then linearly cross-fade between the two samples bracketing the probe.
 *
 * Deliberately NOT the gradient band used for 2D. On a line the bracketing pair is exactly what the user
 * drew, and it guarantees at most two active clips with a clean 0..1 ramp between neighbours — the gradient
 * band would let a distant third sample leak in.
 *
 * A probe outside the authored span pins to the end sample at full weight (clamping, not extrapolation).
 */
function weights1D(samples: AnimationFieldSample[], x: number): FieldWeight[] {
    const sorted = samples.slice().sort((a, b) => a.x - b.x);

    if (x <= sorted[0].x) return [{ sample: sorted[0], weight: 1 }];
    const last = sorted[sorted.length - 1];
    if (x >= last.x) return [{ sample: last, weight: 1 }];

    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (x < a.x || x > b.x) continue;
        const span = b.x - a.x;
        // Two samples authored at the same x: neither is "next", so hold the first rather than dividing by 0.
        if (span === 0) return [{ sample: a, weight: 1 }];
        const t = (x - a.x) / span;
        if (t <= WEIGHT_EPSILON) return [{ sample: a, weight: 1 }];
        if (t >= 1 - WEIGHT_EPSILON) return [{ sample: b, weight: 1 }];
        return [{ sample: a, weight: 1 - t }, { sample: b, weight: t }];
    }

    // Unreachable given the clamps above, but a field is user data — fall back to the nearest sample.
    return [{ sample: sorted[0], weight: 1 }];
}

/**
 * 2D: gradient band interpolation (the algorithm behind Unity's Freeform Cartesian blend trees).
 *
 * For each sample i, walk every other sample j and ask how far the probe has travelled from i TOWARDS j,
 * measured along the i->j direction: `1 - dot(p - p_i, p_j - p_i) / |p_j - p_i|^2`. That is 1 at i, 0 at j,
 * and negative past j. Sample i's weight is the MINIMUM of those over all j — i.e. the nearest neighbour in
 * any direction is what shuts it off.
 *
 * Chosen over UE5's Delaunay + barycentric because it needs no triangulation and degrades gracefully on
 * exactly the inputs an authoring tool produces: a single sample, collinear samples, duplicated coordinates,
 * and probes outside the convex hull all fall out of the same formula.
 */
function weights2D(samples: AnimationFieldSample[], field: AnimationField, x: number, y: number): FieldWeight[] {
    const px = normalizeAxis(x, field.xAxis);
    const py = normalizeAxis(y, field.yAxis);

    const pts = samples.map(s => ({
        sample: s,
        x: normalizeAxis(s.x, field.xAxis),
        y: normalizeAxis(s.y ?? 0, field.yAxis),
    }));

    const raw: number[] = [];
    for (let i = 0; i < pts.length; i++) {
        const pi = pts[i];
        const vipx = px - pi.x;
        const vipy = py - pi.y;

        let w = 1;
        for (let j = 0; j < pts.length; j++) {
            if (j === i) continue;
            const vijx = pts[j].x - pi.x;
            const vijy = pts[j].y - pi.y;
            const lenSq = vijx * vijx + vijy * vijy;
            // Coincident samples: there is no i->j direction to project onto. Skipping the pair leaves both
            // fully weighted, which normalizes into an even split — the only sane reading of "two clips at
            // the same coordinate".
            if (lenSq === 0) continue;
            const t = 1 - (vipx * vijx + vipy * vijy) / lenSq;
            const c = clamp01(t);
            if (c < w) w = c;
            if (w === 0) break; // cannot go lower; the remaining neighbours cannot change this sample
        }
        raw.push(w);
    }

    const out: FieldWeight[] = [];
    let total = 0;
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] <= WEIGHT_EPSILON) continue;
        out.push({ sample: pts[i].sample, weight: raw[i] });
        total += raw[i];
    }

    // Every sample was shut off — only reachable when the probe sits exactly on a sample that some other
    // sample zeroes out, or with pathological coordinates. Fall back to the nearest sample so the pose is
    // always defined.
    if (out.length === 0 || total <= 0) {
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < pts.length; i++) {
            const dx = px - pts[i].x;
            const dy = py - pts[i].y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = i; }
        }
        return [{ sample: pts[best].sample, weight: 1 }];
    }

    for (const w of out) w.weight /= total;
    return out;
}

/**
 * The clips contributing at a probe point and how much each contributes.
 *
 * Weights are normalized (they sum to 1) and near-zero contributions are dropped, so callers can blend the
 * returned list directly without re-checking. Returns [] only when the field has no samples at all.
 * Samples with no clip bound are ignored — an unfinished row in the editor must not silently steal weight
 * from its neighbours and leave a hole in the blend.
 */
export function fieldWeights(field: AnimationField, x: number, y?: number): FieldWeight[] {
    const samples = (field.samples ?? []).filter(s => !!s.clipName);
    if (samples.length === 0) return [];
    if (samples.length === 1) return [{ sample: samples[0], weight: 1 }];

    if (field.mode === '2d') return weights2D(samples, field, x, y ?? 0);
    return weights1D(samples, x);
}
