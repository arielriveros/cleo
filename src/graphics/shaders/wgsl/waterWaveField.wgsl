// LIVE WAVES, step 0 (render/waterWaves.ts; the model is water/waveSim.ts): what the simulated window knows
// of the water under it. One pass per Water node in reach, each writing its own water and leaving the rest
// as it is: the current that carries the waves (the flow bake's, or the drawn river's), how deep the water
// is, and how much foam the bake left there (where the water loses its energy, which is where it boils).
// Dry texels stay zero: the waves end there.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_info0_texture: texture_3d<f32>;   // surface (coarse), flow x, flow z, shore distance
@group(0) @binding(1) var u_info0_sampler: sampler;
@group(0) @binding(2) var u_info1_texture: texture_3d<f32>;   // surface (fine), foam, bed, wet
@group(0) @binding(3) var u_info1_sampler: sampler;

struct FieldUniforms {
    u_window: vec4<f32>,       // origin x, origin z (m), side (m), texels a side of THIS target
    u_infoOrigin: vec4<f32>,   // the node's grid: origin x, origin z, cell (m), -
    u_infoSize: vec4<f32>,     // cells x, cells z, -, -
};
@group(1) @binding(0) var<uniform> u_wf: FieldUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.position.xy / u_wf.u_window.w;
    let xz = u_wf.u_window.xy + uv * u_wf.u_window.z;
    let c = (xz - u_wf.u_infoOrigin.xy) / u_wf.u_infoOrigin.z + vec2<f32>(0.5);
    let uvw = vec3<f32>(c.x / u_wf.u_infoSize.x, c.y / u_wf.u_infoSize.y, 0.5);
    if (any(uvw.xy < vec2<f32>(0.0)) || any(uvw.xy > vec2<f32>(1.0))) { discard; }
    let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, uvw, 0.0);
    let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, uvw, 0.0);
    // This node's own water only: where two meet, each writes its side.
    if (i1.w < 0.5) { discard; }
    let depth = max(i0.x + i1.x - i1.z, 0.0);
    return vec4<f32>(i0.y, i0.z, depth, clamp(i1.y, 0.0, 1.0));
}
