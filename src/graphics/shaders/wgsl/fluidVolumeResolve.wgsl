// Smoke-and-fire volumes: the TEMPORAL RESOLVE (renderer `_renderFluidVolumes`, temporal mode).
//
// Each frame the trace casts one jittered ray per trace pixel with a long, dithered step -- cheap and
// noisy. This pass reprojects last frame's resolved image through the volume's coverage-weighted depth
// (where the smoke actually is, not the box face), clamps it to the new samples' 3x3 neighbourhood so
// animating gas cannot ghost (the TAA trick), and blends. Converged, the result has many rays' worth
// of samples per pixel for the price of one.
//
// Colours are premultiplied, so blending and clamping happen in the space the composite uses.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_traceColor_texture: texture_2d<f32>;
@group(0) @binding(1) var u_traceColor_sampler: sampler;
@group(0) @binding(2) var u_traceDepth_texture: texture_2d<f32>;
@group(0) @binding(3) var u_traceDepth_sampler: sampler;
@group(0) @binding(4) var u_history_texture: texture_2d<f32>;
@group(0) @binding(5) var u_history_sampler: sampler;

struct FluidResolveUniforms {
    u_invViewProj: mat4x4<f32>,    // this frame's clip -> world (uv-consuming form)
    u_prevViewProj: mat4x4<f32>,   // last frame's world -> clip (uv-producing form)
    u_feedback: f32,               // history weight, 0..1
    u_historyValid: i32,
};
@group(1) @binding(0) var<uniform> u_resolve: FluidResolveUniforms;

fn unproject(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let w = u_resolve.u_invViewProj * vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return w.xyz / w.w;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(u_traceColor_texture, 0));
    let pix = clamp(vec2<i32>(in.uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1));
    let current = textureLoad(u_traceColor_texture, pix, 0);

    // The new samples' neighbourhood: what the history may be clamped to.
    var lo = current;
    var hi = current;
    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            let q = clamp(pix + vec2<i32>(dx, dy), vec2<i32>(0), size - vec2<i32>(1));
            let c = textureLoad(u_traceColor_texture, q, 0);
            lo = min(lo, c);
            hi = max(hi, c);
        }
    }
    if (u_resolve.u_historyValid == 0) { return current; }

    // Reproject through where the gas is: the coverage-weighted distance along the ray. A pixel with no
    // coverage this frame reprojects through the far plane, which for a static camera is itself.
    let d = textureLoad(u_traceDepth_texture, pix, 0);
    let o = unproject(in.uv, 0.0);
    let ray = unproject(in.uv, 1.0) - o;
    var world = o + ray;
    if (d.a > 1e-3) { world = o + normalize(ray) * (d.r / d.a); }
    let prevClip = u_resolve.u_prevViewProj * vec4<f32>(world, 1.0);
    if (prevClip.w <= 0.0) { return current; }
    let prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
    if (any(prevUv < vec2<f32>(0.0)) || any(prevUv > vec2<f32>(1.0))) { return current; }

    let history = clamp(textureSampleLevel(u_history_texture, u_history_sampler, prevUv, 0.0), lo, hi);
    return mix(current, history, u_resolve.u_feedback);
}
