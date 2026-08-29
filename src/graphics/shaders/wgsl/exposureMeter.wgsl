// Auto-exposure metering: reduce the lit scene to ONE number, the average log-luminance.
//
// A single fullscreen draw into a 1x1 target, taking a fixed 16x16 grid of taps. No mip pyramid and no
// reduction chain: the destination is one fragment, so 256 taps is 256 fetches for the whole frame,
// which is cheaper than the four extra passes a halving chain would cost to reach the same number.
//
// LOG-luminance, not linear. Averaging luminance directly lets one small blown highlight drag the whole
// frame's exposure — a lamp in shot would darken the room around it. Averaging in log space is the
// geometric mean, which is what a light meter measures and what every auto-exposure implementation
// since Reinhard has used.
//
// THE OUTPUT IS 8-BIT ON PURPOSE. `WebGL2Device.readPixelsSync` refuses anything that is not an 8-bit
// colour target ("readPixels needs an 8-bit colour target on WebGL2"), and this number has to come back
// to the CPU because `Renderer._exposure` is a plain number that eight call sites already read —
// including bloom's bright pass, which is what keeps bloom's display-referred threshold meaningful as
// the exposure moves. So the log-luminance is remapped from a fixed window into 0..1.
//
// Across TWO channels rather than one. A single byte over a 20-stop window is 0.078 stops per step,
// which is finer than the adaptation smoothing that consumes it — but it is not finer than the
// difference between two backends. WebGL2 and WebGPU metering the same frame land on adjacent bytes
// often enough that the whole image shifts a step between them, and a global exposure shift moves
// EVERY cell of a signature at once: measured at 108 of 128 cells before this was widened. Sixteen bits
// puts the step at 0.0003 stops, far below anything either backend disagrees about.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

/** The encode window, in log2 of internal radiance. Must match `Renderer.LOG_LUMINANCE_WINDOW`. */
const LOG_LUM_MIN: f32 = -12.0;
const LOG_LUM_MAX: f32 = 8.0;
/** Taps per axis. 256 total, which is plenty for a number that is then smoothed over ~a second. */
const GRID: i32 = 16;
/** Histogram resolution. 64 bins over a 20-stop window is 0.31 stops per bin. */
const BINS: i32 = 64;
/**
 * Fraction of the frame discarded from each end before averaging — Unreal's `AutoExposureLowPercent`
 * and `HighPercent`, whose defaults are the same 10 and 90.
 *
 * This is the difference between exposure that settles and exposure that hunts. A flat average over the
 * whole frame lets the extremes drag it: a patch of bright sky pulls the exposure down and darkens
 * everything under it, a dark doorway pulls it up and blows out the rest, and the adaptation then
 * chases whichever the camera happens to be pointing at. Throwing away the darkest and brightest tenth
 * leaves the exposure keyed on the part of the frame a viewer is actually looking at.
 */
const LOW_PERCENT: f32 = 0.10;
const HIGH_PERCENT: f32 = 0.90;

/** Luminance at one tap of the fixed grid, floored so a black pixel cannot produce -inf. */
fn tapLogLuminance(index: i32) -> f32 {
    // Stratified centres rather than in.uv: this stage has ONE fragment, so the interpolated uv says
    // nothing about the frame and the taps have to be placed explicitly.
    let uv = (vec2<f32>(f32(index % GRID), f32(index / GRID)) + 0.5) / f32(GRID);
    let c = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0).rgb;
    let lum = max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-6);
    return clamp(log2(lum), LOG_LUM_MIN, LOG_LUM_MAX);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let total = GRID * GRID;
    let span = LOG_LUM_MAX - LOG_LUM_MIN;

    // Pass one: a histogram, which is how the percentile cuts are found without sorting 256 values in
    // a fragment. 64 bins is 256 bytes of local storage, unlike the 1 KB an array of the samples
    // themselves would need.
    var histogram: array<f32, 64>;
    for (var b = 0; b < BINS; b = b + 1) { histogram[b] = 0.0; }
    for (var i = 0; i < total; i = i + 1) {
        let t = (tapLogLuminance(i) - LOG_LUM_MIN) / span;
        let bin = clamp(i32(t * f32(BINS)), 0, BINS - 1);
        histogram[bin] = histogram[bin] + 1.0;
    }

    // Walk the bins to the two cuts. Bin EDGES, so the retained band is a range of luminance values
    // rather than a count — the second pass then averages the real sample values inside it, which is
    // what keeps the result off the 0.31-stop bin grid.
    let lowTarget = f32(total) * LOW_PERCENT;
    let highTarget = f32(total) * HIGH_PERCENT;
    var running = 0.0;
    var lowCut = LOG_LUM_MIN;
    var highCut = LOG_LUM_MAX;
    var seenLow = false;
    var seenHigh = false;
    for (var b = 0; b < BINS; b = b + 1) {
        running = running + histogram[b];
        let edge = LOG_LUM_MIN + span * f32(b + 1) / f32(BINS);
        if (!seenLow && running >= lowTarget) { lowCut = LOG_LUM_MIN + span * f32(b) / f32(BINS); seenLow = true; }
        if (!seenHigh && running >= highTarget) { highCut = edge; seenHigh = true; }
    }

    // Pass two: the mean of the samples that survived. Re-tapped rather than stored, because 256 fetches
    // into a single fragment cost less than 1 KB of local array does.
    var sumLog = 0.0;
    var kept = 0.0;
    for (var i = 0; i < total; i = i + 1) {
        let v = tapLogLuminance(i);
        if (v >= lowCut && v <= highCut) { sumLog = sumLog + v; kept = kept + 1.0; }
    }
    // A frame flat enough that every sample lands in one bin can cut everything away; fall back to the
    // whole set rather than dividing by zero and blacking out the exposure.
    if (kept < 1.0) {
        for (var i = 0; i < total; i = i + 1) { sumLog = sumLog + tapLogLuminance(i); }
        kept = f32(total);
    }

    let avgLog = sumLog / kept;
    let encoded = saturate((avgLog - LOG_LUM_MIN) / (LOG_LUM_MAX - LOG_LUM_MIN));

    // Fixed-point across r and g. `hi` is already a multiple of 1/255 so the 8-bit target stores it
    // exactly, and `lo` carries the remainder at the same step — 16 bits in total.
    let scaled = encoded * 255.0;
    let hi = floor(scaled);
    return vec4<f32>(hi / 255.0, scaled - hi, 0.0, 1.0);
}
