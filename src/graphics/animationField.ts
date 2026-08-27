// ---------------------------------------------------------------------------
// Animation Fields (blend spaces). A field places clips at coordinates in a 1D or 2D parameter space;
// sampling at a probe point yields per-clip weights that the Animator blends into one pose.
// Pure data and math — no GL, no scene, no engine imports — so the editor and runtime share it.
// ---------------------------------------------------------------------------

import { wrapSpan } from '../core/math';

export type AnimationFieldMode = '1d' | '2d';

/**
 * One input axis. `min`/`max` are the authored range and the normalization basis for the 2D metric, not
 * UI hints. The stability knobs below are read by the Animator, not by this module.
 */
export interface AnimationFieldAxis {
    name: string;
    min: number;
    max: number;
    /**
     * Seconds for the probe to catch up to this axis's parameter, as a time constant. `0` is rigid.
     * Absent means {@link DEFAULT_AXIS_SMOOTHING}, not zero.
     */
    smoothing?: number;
    /** Ignore probe movement smaller than this, in axis units. Applied before `smoothing`. Default 0. */
    deadzone?: number;
    /**
     * Treat `min`..`max` as a circle: `max` is adjacent to `min`. Required for any heading axis, and
     * opt-in because it cannot be inferred — a -180..180 axis might be a clamped lean angle.
     */
    wrap?: boolean;
}

export interface AnimationFieldSample {
    /** Name of the clip on the model this sample plays. */
    clipName: string;
    x: number;
    /** 2D fields only; ignored in 1D. */
    y?: number;
    /** Per-sample playback rate multiplier inside the blend, so a clip contributes its real gait length. Default 1. */
    rateScale?: number;
    /**
     * Where this clip sits in its own cycle relative to the field's shared phase, 0..1, wrapping. Use it
     * to line up clips whose gaits start on opposite feet. Default 0.
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
     * Seconds for a clip's WEIGHT to catch up; `0` is rigid, absent means {@link DEFAULT_WEIGHT_SMOOTHING}.
     * Only this makes a departing clip fade out rather than leave the set abruptly.
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

/** The circumference of a wrapping axis, or 0 when it does not wrap. */
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

// Map a value onto 0..1 across an axis's authored range. A degenerate range collapses to 0 rather than
// dividing by zero, which the weighting below handles as an even mix.
function normalizeAxis(value: number, axis: AnimationFieldAxis | undefined): number {
    if (!axis) return 0;
    const span = axis.max - axis.min;
    if (span === 0) return 0;
    return (value - axis.min) / span;
}

// Re-express `value` in the half-open window of width `span` centred on `probe` — the whole of the wrap
// implementation, safe because both weighting algorithms only ever use differences. `span <= 0` is a no-op.
function alignToProbe(value: number, probe: number, span: number): number {
    if (!(span > 0)) return value;
    return probe + wrapSpan(value - probe, span);
}

// Squared distance in normalized axis units below which two samples count as the same point. Not exact
// equality: a wrapping axis folds +180 and -180 together through different arithmetic.
const COINCIDENT_EPSILON_SQ = 1e-12;

// For each point, how many points share its coordinate, itself included. O(n²) on purpose: hashing
// quantized coordinates would reintroduce a boundary at the bucket edges.
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

/** A sample's phase offset, normalized into [0, 1). Absent, negative and out-of-range values all fold in. */
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

// 1D: sort by x, then cross-fade between the two samples bracketing the probe — at most two active
// clips, unlike the 2D gradient band. Outside the authored span, pins to an end sample at full weight.
function weights1D(samples: AnimationFieldSample[], field: AnimationField, x: number): FieldWeight[] {
    const wrap = axisWrapSpan(field.xAxis);

    // On a wrapping axis, "sorted by x" means "round the circle, starting opposite the probe".
    const sorted = samples
        .map(s => ({ sample: s, x: alignToProbe(s.x, x, wrap) }))
        .sort((a, b) => a.x - b.x);

    if (wrap > 0) {
        // Close the circle with two virtual entries so the probe is always bracketed, and the seam needs
        // no special case of its own.
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
        // A virtual entry can name the same sample as its real counterpart; it must not appear twice.
        if (a.sample === b.sample) return [{ sample: a.sample, weight: 1 }];
        return [{ sample: a.sample, weight: 1 - t }, { sample: b.sample, weight: t }];
    }

    // Unreachable given the clamps above, but a field is user data — fall back to the nearest sample.
    return [{ sample: sorted[0].sample, weight: 1 }];
}

// 2D: gradient band interpolation. Sample i's weight is the minimum over every other sample j of
// `1 - dot(p - p_i, p_j - p_i) / |p_j - p_i|²` — 1 at i, 0 at j. Needs no triangulation, and degrades
// gracefully on single, collinear, duplicated and outside-the-hull inputs.
function weights2D(samples: AnimationFieldSample[], field: AnimationField, x: number, y: number): FieldWeight[] {
    const px = normalizeAxis(x, field.xAxis);
    const py = normalizeAxis(y, field.yAxis);

    // A wrapping axis normalizes to a circle of circumference 1, so samples fold into the unit window.
    const wrapX = axisWrapSpan(field.xAxis) > 0 ? 1 : 0;
    const wrapY = axisWrapSpan(field.yAxis) > 0 ? 1 : 0;

    const pts = samples.map(s => ({
        sample: s,
        x: alignToProbe(normalizeAxis(s.x, field.xAxis), px, wrapX),
        y: alignToProbe(normalizeAxis(s.y ?? 0, field.yAxis), py, wrapY),
    }));

    // Coincidence is not exotic: a wrapping axis makes +180 and -180 the same point.
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
            // No i->j direction to project onto; coincident samples are handled as a group below.
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
        // The GROUP's weight, not the split share: a duplicated coordinate must not divide below the threshold.
        if (raw[i] <= WEIGHT_EPSILON) continue;
        // Coincident samples SPLIT one sample's worth of weight; a full share each would count twice.
        const share = raw[i] / groupSize[i];
        out.push({ sample: pts[i].sample, weight: share });
        total += share;
    }

    // Every sample was shut off. Fall back to the nearest one so the pose is always defined.
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
 * Groups of sample indices sharing a coordinate, for authoring warnings. Only groups of two or more; an
 * empty result means every sample sits somewhere of its own.
 */
export function coincidentSamples(field: AnimationField): number[][] {
    const samples = (field.samples ?? []).filter(s => !!s.clipName);
    if (samples.length < 2) return [];

    const wrapX = axisWrapSpan(field.xAxis) > 0 ? 1 : 0;
    const wrapY = axisWrapSpan(field.yAxis) > 0 ? 1 : 0;
    const is2D = field.mode === '2d';

    // The first member is the alignment probe, so a wrapping axis folds as the weighting does.
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
 * The clips contributing at a probe point and how much each contributes. Weights sum to 1 and near-zero
 * ones are dropped. Samples with no clip bound are ignored; [] only when the field has no samples.
 */
export function fieldWeights(field: AnimationField, x: number, y?: number): FieldWeight[] {
    const samples = (field.samples ?? []).filter(s => !!s.clipName);
    if (samples.length === 0) return [];
    if (samples.length === 1) return [{ sample: samples[0], weight: 1 }];

    if (field.mode === '2d') return weights2D(samples, field, x, y ?? 0);
    return weights1D(samples, field, x);
}
