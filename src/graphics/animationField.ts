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

import { wrapSpan } from '../core/math';

export type AnimationFieldMode = '1d' | '2d';

/**
 * One input axis. `min`/`max` are the authored range a parameter is expected to move through; they are also
 * the NORMALIZATION basis for the 2D metric (see fieldWeights), not merely UI hints.
 *
 * `smoothing` / `deadzone` / `wrap` are the temporal-stability knobs. They do not affect this module — which
 * stays a pure function of the probe — but they are authored per axis, so they live on the axis and the
 * Animator reads them from here each frame.
 */
export interface AnimationFieldAxis {
    name: string;
    min: number;
    max: number;
    /**
     * Seconds for the probe to catch up to the parameter driving this axis, as a time constant (~63% of the
     * gap closed per `smoothing`). `0` is rigid — the probe tracks the parameter exactly, which is what the
     * field editor's preview wants and what makes a jittery input a jittery pose.
     *
     * Absent means {@link DEFAULT_AXIS_SMOOTHING}, NOT zero: a measured input (a body's speed, a heading off
     * a physics solver) always carries frame-to-frame noise, and a blend driven straight off it vibrates.
     */
    smoothing?: number;
    /**
     * Ignore probe movement smaller than this, in axis units. A deadband, applied before `smoothing`: it
     * kills the sub-threshold buzz that damping only slows down, at the cost of quantizing tiny moves.
     * Default 0 (off).
     */
    deadzone?: number;
    /**
     * Treat `min`..`max` as a CIRCLE rather than a line: `max` is adjacent to `min`.
     *
     * Required for any heading axis. `Node.planarAngle` is wrapped to (-180, 180], so on a -180..180 axis a
     * character turning through the seam moves the probe across the whole span in one frame (+179 to -179)
     * and the entire weight set flips. With `wrap`, that same turn is a two-degree step.
     *
     * Opt-in, because it cannot be inferred: a -180..180 axis could legitimately be a clamped lean angle
     * where +180 and -180 really are opposites.
     */
    wrap?: boolean;
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
    /**
     * Where in its own cycle this clip sits relative to the field's shared phase, as a fraction 0..1.
     * Default 0. Wraps, so 1.25 and 0.25 mean the same thing.
     *
     * Every clip in a field is posed at ONE shared normalized phase — that is what stops the feet sliding
     * when the blend shifts. But it also assumes every clip starts at the same point in its gait, and clips
     * imported from different sources routinely do not: a forward walk starting on the left foot blended
     * against a strafe starting on the right puts the legs in opposition, worst at an even mix, which reads
     * as the legs fighting rather than as one motion. `0.5` shifts a clip by half a cycle and lines it up.
     */
    phaseOffset?: number;
}

export interface AnimationField {
    mode: AnimationFieldMode;
    xAxis: AnimationFieldAxis;
    /** Present (and used) only when mode === '2d'. */
    yAxis?: AnimationFieldAxis;
    samples: AnimationFieldSample[];
    /**
     * Seconds for a clip's WEIGHT to catch up to the value this module computes for it, as a time constant.
     * `0` is rigid.
     *
     * Distinct from per-axis `smoothing`, and not redundant with it. Smoothing the probe cannot stop a clip
     * from entering or leaving the contributing set between two frames, and that membership change is itself
     * discontinuous (see the note on _mixTransforms in the Animator). Damping the weights makes a departing
     * clip FADE to zero and drop out once it is negligible, so the set only ever changes where it does not
     * matter.
     *
     * Absent means {@link DEFAULT_WEIGHT_SMOOTHING}, not zero.
     */
    weightSmoothing?: number;
}

/** Probe smoothing used when an axis does not author its own. See {@link AnimationFieldAxis.smoothing}. */
export const DEFAULT_AXIS_SMOOTHING = 0.08;

/** Weight smoothing used when a field does not author its own. See {@link AnimationField.weightSmoothing}. */
export const DEFAULT_WEIGHT_SMOOTHING = 0.06;

/** An axis's probe smoothing time in seconds, with the default applied. Negative/NaN read as rigid. */
export function axisSmoothing(axis: AnimationFieldAxis | undefined): number {
    const s = axis?.smoothing;
    if (s === undefined || s === null || !isFinite(s)) return DEFAULT_AXIS_SMOOTHING;
    return s > 0 ? s : 0;
}

/** An axis's deadband in axis units, with the default (0) applied. */
export function axisDeadzone(axis: AnimationFieldAxis | undefined): number {
    const d = axis?.deadzone;
    return typeof d === 'number' && isFinite(d) && d > 0 ? d : 0;
}

/** A field's weight smoothing time in seconds, with the default applied. Negative/NaN read as rigid. */
export function weightSmoothing(field: AnimationField | null | undefined): number {
    const s = field?.weightSmoothing;
    if (s === undefined || s === null || !isFinite(s)) return DEFAULT_WEIGHT_SMOOTHING;
    return s > 0 ? s : 0;
}

/**
 * The circumference of a wrapping axis, or 0 when it does not wrap.
 *
 * The Animator needs this to damp the probe along the shortest arc, which is the other half of the ±180 fix:
 * wrap-aware weighting stops the WEIGHTS lurching, wrap-aware damping stops the PROBE taking the long way
 * round to catch up.
 */
export function axisWrapSpan(axis: AnimationFieldAxis | undefined): number {
    if (!axis?.wrap) return 0;
    const span = axis.max - axis.min;
    return span > 0 ? span : 0;
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

/**
 * Re-express `value` in the half-open window of width `span` centred on `probe`.
 *
 * This is the whole of the wrap implementation. Both weighting algorithms only ever look at DIFFERENCES
 * between coordinates, so shifting every sample by whole spans until it lands nearest the probe leaves the
 * maths untouched while making the seam invisible: a sample at -170 seen from a probe at +175 reads as +190,
 * fifteen units away instead of three hundred and forty-five.
 *
 * `span <= 0` (a non-wrapping axis) passes the value straight through.
 */
function alignToProbe(value: number, probe: number, span: number): number {
    if (!(span > 0)) return value;
    return probe + wrapSpan(value - probe, span);
}

/**
 * Squared distance in NORMALIZED axis units below which two samples count as the same point.
 *
 * Not exact equality. Two samples that a wrapping axis folds together (+180 and -180) arrive through
 * different arithmetic and can differ in the last bit, and two samples a millionth of an axis apart are not
 * meaningfully distinguishable by anything downstream anyway.
 */
const COINCIDENT_EPSILON_SQ = 1e-12;

/**
 * For each point, how many points share its coordinate (itself included, so the answer is always >= 1).
 *
 * O(n^2), which is right here: a field has a handful of samples, and the alternative — hashing quantized
 * coordinates — would reintroduce a boundary, this time at the bucket edges.
 */
function coincidentGroupSizes(pts: { x: number; y: number }[]): number[] {
    const sizes = new Array<number>(pts.length).fill(1);
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[j].x - pts[i].x;
            const dy = pts[j].y - pts[i].y;
            if (dx * dx + dy * dy <= COINCIDENT_EPSILON_SQ) { sizes[i]++; sizes[j]++; }
        }
    }
    return sizes;
}

/**
 * A sample's phase offset, normalized into [0, 1). Absent, negative and out-of-range values all fold in —
 * the quantity is cyclic, so there is no invalid input to reject, only one to wrap.
 */
export function phaseOffsetOf(sample: AnimationFieldSample): number {
    const p = sample.phaseOffset;
    if (typeof p !== 'number' || !isFinite(p)) return 0;
    const w = p % 1;
    return w < 0 ? w + 1 : w;
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
function weights1D(samples: AnimationFieldSample[], field: AnimationField, x: number): FieldWeight[] {
    const wrap = axisWrapSpan(field.xAxis);

    // On a wrapping axis every sample is first pulled into the window around the probe, so "sorted by x"
    // means "in order going round the circle starting opposite the probe".
    const sorted = samples
        .map(s => ({ sample: s, x: alignToProbe(s.x, x, wrap) }))
        .sort((a, b) => a.x - b.x);

    if (wrap > 0) {
        // Close the circle with two virtual entries, so the probe is always bracketed: without them a probe
        // sitting past the last sample has no "next" neighbour, when in fact the next one is the first sample
        // one lap ahead. Standard bracketing then handles the seam with no special case of its own.
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        sorted.unshift({ sample: last.sample, x: last.x - wrap });
        sorted.push({ sample: first.sample, x: first.x + wrap });
    } else {
        // A probe outside the authored span pins to the end sample at full weight (clamping, not extrapolation).
        if (x <= sorted[0].x) return [{ sample: sorted[0].sample, weight: 1 }];
        const last = sorted[sorted.length - 1];
        if (x >= last.x) return [{ sample: last.sample, weight: 1 }];
    }

    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (x < a.x || x > b.x) continue;
        const span = b.x - a.x;
        // Two samples authored at the same x: neither is "next", so hold the first rather than dividing by 0.
        if (span === 0) return [{ sample: a.sample, weight: 1 }];
        const t = (x - a.x) / span;
        if (t <= WEIGHT_EPSILON) return [{ sample: a.sample, weight: 1 }];
        if (t >= 1 - WEIGHT_EPSILON) return [{ sample: b.sample, weight: 1 }];
        // The two virtual entries can name the SAME sample as their real counterpart (two samples on a
        // wrapping axis bracket the probe from both sides), and a duplicated sample must not appear twice.
        if (a.sample === b.sample) return [{ sample: a.sample, weight: 1 }];
        return [{ sample: a.sample, weight: 1 - t }, { sample: b.sample, weight: t }];
    }

    // Unreachable given the clamps above, but a field is user data — fall back to the nearest sample.
    return [{ sample: sorted[0].sample, weight: 1 }];
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

    // A wrapping axis is normalized to a circle of circumference 1, so each sample is pulled into the unit
    // window around the probe. Only differences are ever used below, which is what makes the shift safe.
    const wrapX = axisWrapSpan(field.xAxis) > 0 ? 1 : 0;
    const wrapY = axisWrapSpan(field.yAxis) > 0 ? 1 : 0;

    const pts = samples.map(s => ({
        sample: s,
        x: alignToProbe(normalizeAxis(s.x, field.xAxis), px, wrapX),
        y: alignToProbe(normalizeAxis(s.y ?? 0, field.yAxis), py, wrapY),
    }));

    // How many samples share each sample's coordinate, itself included. Coincidence is not exotic: a wrapping
    // axis makes the two ends the SAME point, so the once-recommended "put the backward clip at both +180 and
    // -180" now lands two samples on top of each other.
    const groupSize = coincidentGroupSizes(pts);

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
            // Coincident samples: there is no i->j direction to project onto, so neither can shut the other
            // off. They are handled as a group below instead.
            if (lenSq <= COINCIDENT_EPSILON_SQ) continue;
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
        // Tested against the GROUP's weight, not the split share, so a heavily-duplicated coordinate is not
        // quietly deleted by being divided below the threshold.
        if (raw[i] <= WEIGHT_EPSILON) continue;
        // Coincident samples SPLIT one sample's worth of weight rather than each claiming a full share.
        // Claiming a full share each is what made a duplicated coordinate count twice, pulling the blend
        // towards that clip and moving the true midpoint between it and its neighbours off where it was drawn.
        const share = raw[i] / groupSize[i];
        out.push({ sample: pts[i].sample, weight: share });
        total += share;
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
 * Groups of sample INDICES that occupy the same coordinate, for authoring warnings. Only groups of two or
 * more are returned; an empty result means every sample sits somewhere of its own.
 *
 * Worth surfacing because a coincidence can be invisible in the editor's plot: on a wrapping axis the two
 * ends are the same point but are drawn at opposite edges, so +180 and -180 look as far apart as it is
 * possible to be while in fact being identical.
 */
export function coincidentSamples(field: AnimationField): number[][] {
    const samples = (field.samples ?? []).filter(s => !!s.clipName);
    if (samples.length < 2) return [];

    const wrapX = axisWrapSpan(field.xAxis) > 0 ? 1 : 0;
    const wrapY = axisWrapSpan(field.yAxis) > 0 ? 1 : 0;
    const is2D = field.mode === '2d';

    // Grouped against the FIRST member as the alignment probe, so a wrapping axis folds its ends together
    // exactly as the weighting does.
    const pts = field.samples.map(s => ({
        x: normalizeAxis(s.x, field.xAxis),
        y: is2D ? normalizeAxis(s.y ?? 0, field.yAxis) : 0,
    }));

    const seen = new Array<boolean>(pts.length).fill(false);
    const groups: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
        if (seen[i] || !field.samples[i].clipName) continue;
        const group = [i];
        for (let j = i + 1; j < pts.length; j++) {
            if (seen[j] || !field.samples[j].clipName) continue;
            const dx = alignToProbe(pts[j].x, pts[i].x, wrapX) - pts[i].x;
            const dy = is2D ? alignToProbe(pts[j].y, pts[i].y, wrapY) - pts[i].y : 0;
            if (dx * dx + dy * dy <= COINCIDENT_EPSILON_SQ) { group.push(j); seen[j] = true; }
        }
        if (group.length > 1) groups.push(group);
    }
    return groups;
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
    return weights1D(samples, field, x);
}
