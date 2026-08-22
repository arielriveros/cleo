// One level of the bloom downsample pyramid — the 13-tap "dual filter" from Jorge Jimenez's
// SIGGRAPH 2014 Call of Duty presentation.
//
// WHY 13 TAPS AND NOT A BOX: halving resolution with a plain bilinear box aliases badly on
// high-contrast HDR highlights, and the aliasing then *pulses* as the camera moves because a
// sub-pixel highlight jumps between source texels frame to frame. The overlapping 4-square pattern
// below is a wide, well-behaved kernel that kills that flicker for the cost of a few more fetches at
// a quarter of the pixels.
//
// The Karis average (weighting each 2x2 group by 1/(1+luma) before summing) is applied on the FIRST
// level only: it is what stops a single very bright pixel from dominating the whole mip chain, but it
// is non-energy-conserving, so applying it at every level would visibly dim the bloom.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_srcTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_srcTexture_sampler: sampler;

struct BloomDownsampleUniforms {
    u_srcTexelSize: vec2<f32>,    // 1 / source resolution
    u_dstResolution: vec2<f32>,   // size of this target, in texels
    // `u_karisAverage` is an i32, not a bool: WGSL forbids bool in a uniform buffer (it is not
    // host-shareable). Call sites still pass a JavaScript boolean — the std140 writer converts it,
    // because the reflected member type is integer.
    u_karisAverage: i32,
};
@group(1) @binding(0) var<uniform> u_bloom: BloomDownsampleUniforms;

/**
 * UV of the exact centre of the 2x2 source block this destination texel stands for.
 *
 * Sampling at the raw UV instead looks right but is only correct when the source is EXACTLY twice the
 * destination. Viewport sizes are arbitrary, and the pyramid halves with floor(), so any odd dimension
 * gives src = 2*dst + 1: the naive mapping then drifts by (j + 0.5) / dst source texels, reaching a
 * full texel by the far edge. That drift beats against the source grid — sample points land alternately
 * on texel centres (bilinear returns one texel, aliased) and on texel boundaries (bilinear averages
 * two) — which reads as vertical/horizontal banding that worsens toward the right and bottom of the
 * frame, with dark lines wherever a bright column is skipped entirely.
 *
 * Snapping to (2j + 1) source texels removes the drift completely and makes the bilinear fetch an exact
 * 2x2 box, at any parity. The last source column/row of an odd dimension is dropped rather than smeared
 * across the whole image, which is the right trade.
 */
fn sourceBlockUV(uv: vec2<f32>, dstResolution: vec2<f32>, srcTexelSize: vec2<f32>) -> vec2<f32> {
    return (floor(uv * dstResolution) * 2.0 + 1.0) * srcTexelSize;
}

fn karisWeight(c: vec3<f32>) -> f32 {
    // Weight by inverse luma so bright outliers cannot dominate the average.
    let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    return 1.0 / (1.0 + luma);
}

fn tap(uv: vec2<f32>) -> vec3<f32> {
    return textureSample(u_srcTexture_texture, u_srcTexture_sampler, uv).rgb;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let x = u_bloom.u_srcTexelSize.x;
    let y = u_bloom.u_srcTexelSize.y;
    // Centre the kernel on the 2x2 source block this texel stands for, not on the raw UV — see
    // sourceBlockUV. The 13 taps below are placed in SOURCE texels around that centre, which is only
    // meaningful if the centre itself is on the source grid.
    let uv = sourceBlockUV(in.uv, u_bloom.u_dstResolution, u_bloom.u_srcTexelSize);

    // Outer ring (corners), at +/- 2 texels.
    let a = tap(vec2<f32>(uv.x - 2.0 * x, uv.y + 2.0 * y));
    let b = tap(vec2<f32>(uv.x,           uv.y + 2.0 * y));
    let c = tap(vec2<f32>(uv.x + 2.0 * x, uv.y + 2.0 * y));

    let d = tap(vec2<f32>(uv.x - 2.0 * x, uv.y));
    let e = tap(vec2<f32>(uv.x,           uv.y));
    let f = tap(vec2<f32>(uv.x + 2.0 * x, uv.y));

    let g = tap(vec2<f32>(uv.x - 2.0 * x, uv.y - 2.0 * y));
    let h = tap(vec2<f32>(uv.x,           uv.y - 2.0 * y));
    let i = tap(vec2<f32>(uv.x + 2.0 * x, uv.y - 2.0 * y));

    // Inner 2x2 square, at +/- 1 texel.
    let j = tap(vec2<f32>(uv.x - x, uv.y + y));
    let k = tap(vec2<f32>(uv.x + x, uv.y + y));
    let l = tap(vec2<f32>(uv.x - x, uv.y - y));
    let m = tap(vec2<f32>(uv.x + x, uv.y - y));

    var result: vec3<f32>;
    if (u_bloom.u_karisAverage != 0) {
        // Five overlapping 2x2 groups, each averaged with its own inverse-luma weight.
        let g0 = (a + b + d + e) * 0.25;
        let g1 = (b + c + e + f) * 0.25;
        let g2 = (d + e + g + h) * 0.25;
        let g3 = (e + f + h + i) * 0.25;
        let g4 = (j + k + l + m) * 0.25;
        let w0 = karisWeight(g0);
        let w1 = karisWeight(g1);
        let w2 = karisWeight(g2);
        let w3 = karisWeight(g3);
        let w4 = karisWeight(g4);
        // The centre group carries half the weight, matching the unweighted kernel below.
        let wSum = w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5;
        result = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125
                + g3 * w3 * 0.125 + g4 * w4 * 0.5) / max(wSum, 1e-5);
    } else {
        result = e * 0.125;
        result += (a + c + g + i) * 0.03125;
        result += (b + d + f + h) * 0.0625;
        result += (j + k + l + m) * 0.125;
    }

    return vec4<f32>(max(result, vec3<f32>(0.0)), 1.0);
}
