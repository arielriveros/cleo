// Local exposure, stage 1: how well each of three synthetic exposures would show this patch of the frame.
//
// Exposure fusion (Mertens, Kautz & Van Reeth 2007), the way Wronski runs it for real-time local
// tonemapping ("Exposure Fusion: local tonemapping for real-time rendering", 2022): the image is looked at
// through three exposures — the frame's own, one `u_shadowStops` brighter, one `u_highlightStops` darker —
// and each pixel is scored for how well-exposed it is in each (how near mid-display it lands). The scores
// are averaged down a pyramid (localExposureDown.wgsl) until they describe REGIONS, not pixels, and the
// present (chunks/localExposure.wgsl) turns them into a smooth per-region exposure shift: the moonlit field
// beside a torch pool is lifted, the pool itself is held back, and the detail inside each is untouched
// because the shift is a smooth multiply rather than a new tone curve.
//
// Quarter resolution: this target is a quarter of the frame on each axis, so each texel averages a 4x4
// block of the source in four bilinear taps.
//
// Output: rgb = the three weights (brighter, as is, darker), a = the block's mean log2 exposed luminance —
// the guide the present upsamples against, so the shift stops at the edge of the region it belongs to.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct LocalExposureLumUniforms {
    u_srcTexelSize: vec2<f32>,      // 1 / source resolution
    u_dstResolution: vec2<f32>,     // this target's size, in texels
    u_exposure: f32,                // the display exposure (exposure / pre-exposure)
    u_shadowStops: f32,             // how much brighter the shadow exposure is
    u_highlightStops: f32,          // how much darker the highlight exposure is
};
@group(1) @binding(0) var<uniform> u_le: LocalExposureLumUniforms;

/** A display-like curve for scoring: what a tone mapper does to luminance, roughly, then the sRGB encode. */
fn displayed(x: f32) -> f32 {
    return pow(x / (1.0 + x), 1.0 / 2.2);
}

/** Mertens' well-exposedness: a Gaussian round mid-display. */
fn wellExposed(x: f32) -> f32 {
    let t = displayed(max(x, 0.0)) - 0.5;
    return exp(-t * t / (2.0 * 0.2 * 0.2)) + 1e-4;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The 4x4 source block this texel stands for, as four bilinear 2x2 taps at its quarter points.
    let block = floor(in.uv * u_le.u_dstResolution) * 4.0;
    let lift = exp2(u_le.u_shadowStops);
    let hold = exp2(-u_le.u_highlightStops);
    var weights = vec3<f32>(0.0);
    var logSum = 0.0;
    for (var j = 0; j < 2; j++) {
        for (var i = 0; i < 2; i++) {
            let uv = (block + vec2<f32>(f32(i) * 2.0 + 1.0, f32(j) * 2.0 + 1.0)) * u_le.u_srcTexelSize;
            let c = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0).rgb;
            let lum = max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.0) * u_le.u_exposure;
            weights += vec3<f32>(wellExposed(lum * lift), wellExposed(lum), wellExposed(lum * hold));
            logSum += log2(max(lum, 1e-6));
        }
    }
    return vec4<f32>(weights * 0.25, logSum * 0.25);
}
