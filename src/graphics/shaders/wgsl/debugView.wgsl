// Fullscreen debug visualiser: displays one renderer buffer (G-buffer channel, SSAO, depth, bloom, lit
// scene …) chosen by u_mode. Editor-only; published builds always use the plain 'screen' shader.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/tonemap.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct DebugViewUniforms {
    u_exposure: f32,    // for the tonemapped (linear-HDR) channels
    u_mode: i32,
};
@group(1) @binding(0) var<uniform> u_debug: DebugViewUniforms;

/**
 * Overdraw heat map, black -> blue -> green -> yellow -> red.
 *
 * That ramp is the convention every GPU profiler uses, so the reading transfers. This is the view that
 * makes a fill-rate problem legible: draw-call and triangle counts say nothing about how many times each
 * pixel was shaded, and on a deferred renderer with a lot of alpha-blended overlays that number is
 * exactly what costs the frame.
 */
fn heatMap(value: f32) -> vec3<f32> {
    let n = clamp(value, 0.0, 1.0);
    if (n < 0.25) { return mix(vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(0.0, 0.2, 1.0), n / 0.25); }
    if (n < 0.5)  { return mix(vec3<f32>(0.0, 0.2, 1.0), vec3<f32>(0.0, 1.0, 0.3), (n - 0.25) / 0.25); }
    if (n < 0.75) { return mix(vec3<f32>(0.0, 1.0, 0.3), vec3<f32>(1.0, 1.0, 0.0), (n - 0.5) / 0.25); }
    return mix(vec3<f32>(1.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), (n - 0.75) / 0.25);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let t = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);
    let mode = u_debug.u_mode;

    // World-space normals stored in [-1,1] -> remap to viewable [0,1] colour.
    if (mode == 1) { return vec4<f32>(t.rgb * 0.5 + 0.5, 1.0); }
    // Scalar packed in the alpha channel (metallic / roughness / ambient occlusion).
    if (mode == 2) { return vec4<f32>(vec3<f32>(t.a), 1.0); }
    // Non-linear depth in .r; a contrast curve spreads the far-weighted range so structure shows.
    if (mode == 3) { return vec4<f32>(vec3<f32>(pow(t.r, 40.0)), 1.0); }
    // Single-channel value in .r (SSAO occlusion factor).
    if (mode == 4) { return vec4<f32>(vec3<f32>(t.r), 1.0); }
    // Motion-blur velocity (screen-space, small UV units in .rg). Amplify + bias so it is visible.
    if (mode == 5) { return vec4<f32>(t.rg * 15.0 + 0.5, 0.5, 1.0); }
    // Linear-HDR channels (lit scene, bloom): resolve to display so the preview matches the image.
    if (mode == 6) { return vec4<f32>(tonemap(t.rgb, u_debug.u_exposure), 1.0); }
    if (mode == 7) { return vec4<f32>(heatMap(t.r), 1.0); }
    // Passthrough RGB (albedo, emissive, …).
    return vec4<f32>(t.rgb, 1.0);
}
