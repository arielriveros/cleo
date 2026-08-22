// HDR bright-pass. A soft knee ramps pixels in around the threshold instead of a hard per-channel
// clip, which avoids flickering/popping on small highlights.
//
// The threshold is tested against EXPOSED luminance — see u_exposure below. This pass runs on
// scene-linear radiance before the tonemapper, and that radiance is much darker than it looks: the
// engine's physically-correct Lambertian (albedo/PI) diffuse puts a white surface under a white light
// at only ~0.3, which is exactly why the default camera exposure is ~2 (see renderer.ts). Comparing a
// threshold of 1.0 against 0.3 meant `contribution` was identically zero for essentially every pixel
// in an ordinary scene, so the bright pass emitted black no matter what threshold, knee, intensity or
// exposure were set to. Exposing first makes the threshold mean what the UI implies — "bloom what
// would clip on screen" — and makes bloom respond to the exposure control.

#include "./chunks/fullscreen.wgsl"

// post-processed scene colour (may be motion-blurred)
@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
// raw scene buffer; its alpha flags bloom-eligible lit surfaces
@group(0) @binding(2) var u_bloomMask_texture: texture_2d<f32>;
@group(0) @binding(3) var u_bloomMask_sampler: sampler;

struct BloomUniforms {
    u_srcTexelSize: vec2<f32>,      // 1 / scene resolution
    u_dstResolution: vec2<f32>,     // size of this (half-resolution) target, in texels
    u_bloomThreshold: f32,          // luminance where bloom starts, in EXPOSED (display-referred) terms
    u_bloomKnee: f32,               // soft-knee width around the threshold (0 = hard cutoff)
    u_exposure: f32,                // the same exposure the final present applies
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass a boolean.
    u_bloomMaskEnabled: i32,        // restrict bloom to surfaces that set the mask
};
@group(1) @binding(0) var<uniform> u_bloom: BloomUniforms;

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
 * 2x2 box, at any parity.
 */
fn sourceBlockUV(uv: vec2<f32>, dstResolution: vec2<f32>, srcTexelSize: vec2<f32>) -> vec2<f32> {
    return (floor(uv * dstResolution) * 2.0 + 1.0) * srcTexelSize;
}

// Single output: the extracted bright part, which seeds the bloom mip pyramid. This used to also emit a
// scene passthrough on location 1 so the composite step had something to read; the composite now reads
// the compose buffer directly, so carrying a second full-size attachment through every pyramid level
// would be pure bandwidth for a copy of an image we already have.
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // This pass also halves the resolution, so it must FILTER, not point-sample: a single fetch at the
    // raw UV throws away half the source and aliases hard on exactly the high-contrast HDR highlights
    // bloom exists to find. The snapped fetch below is an exact 2x2 box.
    let uv = sourceBlockUV(in.uv, u_bloom.u_dstResolution, u_bloom.u_srcTexelSize);

    let color = textureSample(u_screenTexture_texture, u_screenTexture_sampler, uv).rgb;

    // Optional eligibility mask, carried in the scene buffer's alpha. It is 1 on lit PBR /
    // Blinn-Phong surfaces (deferredLighting.fs) and on a baked atmosphere sky (skybox.fs), and cloud
    // coverage is composited into it. It stays 0 on a user cubemap sky, on unlit "basic" pixels, and
    // everywhere the frame's alpha-0 clear was never overwritten — sprites, tilemaps, transparents and
    // gizmos all draw under a mask-preserving blend and *cannot* set it, so with the mask on they can
    // never bloom. That makes it an artistic filter rather than a sensible default, hence the toggle:
    // off, bloom applies to the whole image the way it does in other engines.
    var mask = 1.0;
    if (u_bloom.u_bloomMaskEnabled != 0) {
        mask = step(0.5, textureSample(u_bloomMask_texture, u_bloomMask_sampler, uv).a);
    }

    // Perceptual luminance, measured after exposure so the threshold is display-referred.
    let luma = dot(color * u_bloom.u_exposure, vec3<f32>(0.2126, 0.7152, 0.0722));

    // Soft-knee curve (Unreal/Unity style): 0 below (threshold - knee), smooth ramp across the knee,
    // then linear (luma - threshold) above. Scaling the colour by contribution/luma keeps its hue.
    let knee = max(u_bloom.u_bloomKnee, 1e-4);
    var soft = clamp(luma - (u_bloom.u_bloomThreshold - knee), 0.0, 2.0 * knee);
    soft = (soft * soft) / (4.0 * knee + 1e-5);
    let contribution = max(soft, luma - u_bloom.u_bloomThreshold) / max(luma, 1e-5);

    // Scale the UN-exposed colour: bloom stays in pre-exposure linear, so composer.fs (scene + bloom)
    // and the single exposure/ACES resolve in present.fs both stay consistent. Only the *decision* of
    // how much to extract was made in exposed terms.
    return vec4<f32>(color * contribution * mask, 1.0);
}
