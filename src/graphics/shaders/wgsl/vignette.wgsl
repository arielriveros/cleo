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
     * 0 is a circle on screen, whatever the aspect; 1 stretches it to the frame's shape (an ellipse
     * reaching into the corners of a wide frame). The default 0 is the round one.
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
    // At roundness 0 the x offset is scaled by the aspect, so distance is measured in frame HEIGHTS and
    // the shade is a circle on screen; at 1 it is measured in frame-relative units, so it follows the
    // viewport's shape.
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
