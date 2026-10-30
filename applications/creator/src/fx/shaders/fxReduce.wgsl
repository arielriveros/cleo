// The fire light: the per-brick emission sums of fxOccupancy.wgsl reduced to one emission-weighted
// centroid (normalised to the grid) and a strength (the share of voxels burning, 1% = full), written
// to a 1x1 RGBA8 texture the app reads back a frame or more later. One thread: a few hundred bricks.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> bricksum: array<vec4<f32>>;
@group(0) @binding(2) var result: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(1, 1, 1)
fn cs_reduce(@builtin(global_invocation_id) g: vec3<u32>) {
    let bricks = (u.dims.xyz + vec3<u32>(7u)) / 8u;
    let n = bricks.x * bricks.y * bricks.z;
    var sum = vec4<f32>(0.0);
    for (var i = 0u; i < n; i = i + 1u) { sum = sum + bricksum[i]; }
    let dims = vec3<f32>(u.dims.xyz);
    var centre = vec3<f32>(0.5);
    if (sum.w > 1e-4) { centre = clamp(sum.xyz / sum.w / max(dims - vec3<f32>(1.0), vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0)); }
    let strength = clamp(sum.w / (dims.x * dims.y * dims.z * 0.01), 0.0, 1.0);
    textureStore(result, vec2<i32>(0, 0), vec4<f32>(centre, strength));
}
