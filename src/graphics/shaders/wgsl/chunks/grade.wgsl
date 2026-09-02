// The tone-mapping operators and the artist grade: everything between "linear HDR composite" and a
// display-space colour, for the three programs that resolve a linear-HDR buffer to the screen
// (present, outlinePost, debugView).
//
// Include THIS and NOT ./chunks/tonemap.wgsl — this includes that, there are no include guards, and
// a second copy of toLinear() is a compile error. chunks/tonemap.wgsl stays the lightweight thing
// the other seventeen shaders take for toLinear alone.
//
// It declares no bindings on purpose. The colour LUT needs a texture and is therefore its own chunk
// (chunks/colorLut.wgsl), so that a program which only wants the curve — debugView — does not
// inherit a binding it would then have to satisfy every frame.

#include "./tonemap.wgsl"

// Operator ids. These MUST match the ToneMapper mapping in graphics/renderer.ts (_toneMapperId).
const TONE_AGX: i32 = 0;
const TONE_ACES: i32 = 1;
const TONE_NEUTRAL: i32 = 2;
const TONE_NONE: i32 = 3;

// ---------------------------------------------------------------------------------------------
// AgX — Troy Sobotka's curve, Filament's polynomial fit; the same operator Godot 4.6 and three.js
// ship. Its point over the ACES fit is what it does to a bright saturated colour: the inset matrix
// pulls the primaries in before a per-channel sigmoid, so an over-range blue desaturates toward
// WHITE as it clips instead of skewing toward purple.
//
// The matrices are COLUMN-major, exactly as the `mat3(vec3, vec3, vec3)` they were transcribed
// from: each vec3 below is a column. A transposed inset still renders a picture — with wrong hues,
// and nothing here or in the tests would say so.
// ---------------------------------------------------------------------------------------------
const AGX_SRGB_TO_REC2020 = mat3x3<f32>(
    vec3<f32>(0.6274, 0.0691, 0.0164),
    vec3<f32>(0.3293, 0.9195, 0.0880),
    vec3<f32>(0.0433, 0.0113, 0.8956));
const AGX_REC2020_TO_SRGB = mat3x3<f32>(
    vec3<f32>( 1.6605, -0.1246, -0.0182),
    vec3<f32>(-0.5876,  1.1329, -0.1006),
    vec3<f32>(-0.0728, -0.0083,  1.1187));
const AGX_INSET = mat3x3<f32>(
    vec3<f32>(0.856627153315983,   0.137318972929847,   0.11189821299995),
    vec3<f32>(0.0951212405381588,  0.761241990602591,   0.0767994186031903),
    vec3<f32>(0.0482516061458583,  0.101439036467562,   0.811302368396859));
const AGX_OUTSET = mat3x3<f32>(
    vec3<f32>( 1.1271005818144368,  -0.1413297634984383,  -0.14132976349843826),
    vec3<f32>(-0.11060664309660323,  1.157823702216272,   -0.11060664309660294),
    vec3<f32>(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

// The log2 window mapped onto 0..1 before the sigmoid: about 16.5 stops.
const AGX_MIN_EV: f32 = -12.47393;
const AGX_MAX_EV: f32 = 4.026069;

/**
 * Sixth-order fit of AgX's sigmoid. Not an approximation of convenience — the reference curve is a
 * spline nobody evaluates per fragment, and this fit IS the operator as shipped everywhere else.
 */
fn agxDefaultContrastApprox(x: vec3<f32>) -> vec3<f32> {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2
         - 40.14 * x4 * x
         + 31.96 * x4
         - 6.868 * x2 * x
         + 0.4298 * x2
         + 0.1191 * x
         - 0.00232;
}

/**
 * Linear HDR in, LINEAR sRGB [0,1] out.
 *
 * The trailing pow(2.2) undoes the display encode baked into the sigmoid's output, so the caller's
 * toSrgb() is the single encode rather than a second one — this composition is correct, not a
 * double gamma.
 */
fn agx(hdr: vec3<f32>) -> vec3<f32> {
    var c = AGX_SRGB_TO_REC2020 * hdr;
    c = AGX_INSET * c;
    // log2(0) is -inf. 1e-10 sits far below AGX_MIN_EV, so it clamps to black either way.
    c = max(vec3<f32>(1e-10), c);
    c = (log2(c) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    c = agxDefaultContrastApprox(c);
    c = AGX_OUTSET * c;
    c = pow(max(vec3<f32>(0.0), c), vec3<f32>(2.2));
    return clamp(AGX_REC2020_TO_SRGB * c, vec3<f32>(0.0), vec3<f32>(1.0));
}

/**
 * Khronos PBR Neutral (KhronosGroup/ToneMapping). Linear Rec.709 in, linear Rec.709 [0,1] out.
 *
 * Its promise is that an in-gamut albedo survives to screen unchanged — no hue shift and no
 * artistic contrast — which is what an asset or product viewer wants, and what neither AgX nor the
 * ACES fit offers.
 *
 * Written BRANCHLESS. The reference returns early for the uncompressed case, and a helper that may
 * return non-uniformly is the exact shape that once invalidated this engine's selection outline
 * (see outlinePost.wgsl). `safePeak` also keeps the discarded branch's divisor away from zero, so
 * no NaN is produced only to be thrown away.
 */
fn pbrNeutral(color_in: vec3<f32>) -> vec3<f32> {
    let startCompression = 0.8 - 0.04;
    let desaturation = 0.15;

    let x = min(color_in.r, min(color_in.g, color_in.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    let color = color_in - offset;

    let peak = max(color.r, max(color.g, color.b));
    let safePeak = max(peak, startCompression);
    let d = 1.0 - startCompression;
    let newPeak = 1.0 - d * d / (safePeak + d - startCompression);
    let compressed = color * (newPeak / safePeak);
    let g = 1.0 - 1.0 / (desaturation * (safePeak - newPeak) + 1.0);
    // select(false, true, cond): below the knee the colour passes through uncompressed.
    return select(mix(compressed, vec3<f32>(newPeak), g), color, peak < startCompression);
}

/**
 * The operator dispatch. Exposed linear HDR in, LINEAR [0,1] out — the sRGB encode is the caller's,
 * and every branch here returns linear so that one encode stays the only one.
 */
fn toneCurve(hdr: vec3<f32>, mapper: i32) -> vec3<f32> {
    // Negatives reach here from a filtered HDR buffer (bloom's downsample chain, chromatic
    // aberration). AgX's log2 and Neutral's min-channel both misbehave on them.
    let x = max(vec3<f32>(0.0), hdr);
    if (mapper == TONE_ACES) { return acesFilm(x); }
    if (mapper == TONE_NEUTRAL) { return pbrNeutral(x); }
    if (mapper == TONE_NONE) { return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0)); }
    return agx(x);   // the default, and where an out-of-range id lands
}

/**
 * Saturation trim, exposure, tone curve, sRGB encode: linear HDR in, DISPLAY colour out.
 *
 * The saturation lerp is in LINEAR and BEFORE the curve, and that ordering is the whole reason this
 * is one function rather than a lerp at the end: desaturating after the curve pulls an already
 * rolled-off highlight toward an already rolled-off grey, which flattens the filmic shoulder into
 * mush. Doing it in linear lets the tonemapper roll off the corrected colour, so a de-saturated
 * overcast frame keeps its highlight response.
 *
 * The weights are Rec.709 luma, which is the right basis for a linear signal.
 */
fn gradeToDisplay(hdr: vec3<f32>, exposure: f32, saturation: f32, mapper: i32) -> vec3<f32> {
    let lum = dot(hdr, vec3<f32>(0.2126, 0.7152, 0.0722));
    let trimmed = mix(vec3<f32>(lum), hdr, saturation);
    return toSrgb(toneCurve(trimmed * exposure, mapper));
}

