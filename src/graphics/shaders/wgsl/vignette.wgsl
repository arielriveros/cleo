// Vignette: the fall-off in brightness toward the corners that every real lens has, because the rim
// of the barrel occludes part of the aperture for off-axis rays.
//
// MULTIPLICATIVE, on linear radiance, and it runs before the tone curve — which is what it physically
// is, light that never reached the sensor. Darkening after the curve instead would crush the corners
// to a flat black rather than exposing them down, and the difference shows the moment a bright sky
// reaches a corner.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct VignetteUniforms {
    /** 0 = off, 1 = corners fully dark. */
    u_vignetteStrength: f32,
    /**
     * 0 follows the frame's aspect ratio (an ellipse touching the short edges); 1 is a circle. A
     * lens vignette is genuinely elliptical on a non-square sensor, so 0 is the honest default and 1
     * is the stylistic one.
     */
    u_vignetteRoundness: f32,
    /** Width of the falloff. Small values give a hard iris edge, large ones a gentle shade. */
    u_vignetteSmoothness: f32,
    /** width / height, for the roundness blend above. */
    u_aspect: f32,
};
@group(1) @binding(0) var<uniform> u_vignette: VignetteUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);

    var d = in.uv - vec2<f32>(0.5, 0.5);
    // Stretch the x axis back out toward square as roundness goes to 1. At 0 the distance is measured
    // in frame-relative units, so the ellipse follows the viewport.
    d.x = d.x * mix(u_vignette.u_aspect, 1.0, u_vignette.u_vignetteRoundness);

    // 0 at the centre, 1 at the short-edge midpoint. `smoothstep` from just inside that outward, so a
    // strength of 1 leaves the middle of the frame untouched however smooth the falloff is.
    let r = length(d) * 2.0;
    let smoothness = max(1e-3, u_vignette.u_vignetteSmoothness);
    let shade = 1.0 - smoothstep(1.0 - smoothness, 1.0 + smoothness, r) * u_vignette.u_vignetteStrength;

    // Alpha is passed through unchanged rather than forced to 1: it carries the bloom mask through the
    // chain, and there is no reason for a brightness falloff to be the pass that discards it.
    return vec4<f32>(color.rgb * shade, color.a);
}
