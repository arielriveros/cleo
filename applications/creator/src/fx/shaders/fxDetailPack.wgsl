// Advected detail, step 2 of 2: the two coordinate sets into the FluidVolumeNode's detail volumes, which
// the engine's volume march samples the detail noise through. One thread per half-resolution cell.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> a: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> b: array<vec4<f32>>;
@group(0) @binding(3) var tex_a: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var tex_b: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn cs_detail_pack(@builtin(global_invocation_id) g: vec3<u32>) {
    let ld = u.light_dims;
    if (g.x >= ld.x || g.y >= ld.y || g.z >= ld.z) { return; }
    let i = g.x + ld.x * (g.y + ld.y * g.z);
    textureStore(tex_a, vec3<i32>(g), a[i]);
    textureStore(tex_b, vec3<i32>(g), b[i]);
}
