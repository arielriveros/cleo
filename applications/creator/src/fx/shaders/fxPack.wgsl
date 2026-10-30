// The live preview's hand-off to the engine: the solver's current scalars and the half-resolution
// light grid, packed into the FluidVolumeNode's 3D texture (R density, G temperature, B light
// transmittance, A fire glow) without leaving the GPU. One thread per voxel.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> light: array<f32>;
@group(0) @binding(3) var<storage, read> glow: array<f32>;
@group(0) @binding(4) var volume: texture_storage_3d<rgba16float, write>;

fn light_cell(x: i32, y: i32, z: i32, ld: vec3<i32>) -> f32 {
    return light[u32(x + ld.x * (y + ld.y * z))];
}

fn glow_cell(x: i32, y: i32, z: i32, ld: vec3<i32>) -> f32 {
    return glow[u32(x + ld.x * (y + ld.y * z))];
}

fn glow_at(p: vec3<f32>) -> f32 {
    let ld = vec3<i32>(u.light_dims.xyz);
    let q = clamp(p * 0.5, vec3<f32>(0.0), vec3<f32>(ld) - vec3<f32>(1.0));
    let b = clamp(vec3<i32>(floor(q)), vec3<i32>(0), max(ld - vec3<i32>(2), vec3<i32>(0)));
    let f = q - vec3<f32>(b);
    let b1 = min(b + vec3<i32>(1), ld - vec3<i32>(1));
    let c00 = mix(glow_cell(b.x, b.y, b.z, ld), glow_cell(b1.x, b.y, b.z, ld), f.x);
    let c10 = mix(glow_cell(b.x, b1.y, b.z, ld), glow_cell(b1.x, b1.y, b.z, ld), f.x);
    let c01 = mix(glow_cell(b.x, b.y, b1.z, ld), glow_cell(b1.x, b.y, b1.z, ld), f.x);
    let c11 = mix(glow_cell(b.x, b1.y, b1.z, ld), glow_cell(b1.x, b1.y, b1.z, ld), f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

/** The light grid sampled trilinearly at a full-resolution voxel -- fxRender.wgsl's `light_at`. */
fn light_at(p: vec3<f32>) -> f32 {
    let ld = vec3<i32>(u.light_dims.xyz);
    let q = clamp(p * 0.5, vec3<f32>(0.0), vec3<f32>(ld) - vec3<f32>(1.0));
    let b = clamp(vec3<i32>(floor(q)), vec3<i32>(0), max(ld - vec3<i32>(2), vec3<i32>(0)));
    let f = q - vec3<f32>(b);
    let b1 = min(b + vec3<i32>(1), ld - vec3<i32>(1));
    let c00 = mix(light_cell(b.x, b.y, b.z, ld), light_cell(b1.x, b.y, b.z, ld), f.x);
    let c10 = mix(light_cell(b.x, b1.y, b.z, ld), light_cell(b1.x, b1.y, b.z, ld), f.x);
    let c01 = mix(light_cell(b.x, b.y, b1.z, ld), light_cell(b1.x, b.y, b1.z, ld), f.x);
    let c11 = mix(light_cell(b.x, b1.y, b1.z, ld), light_cell(b1.x, b1.y, b1.z, ld), f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

@compute @workgroup_size(4, 4, 4)
fn cs_pack(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let s = sca[idx(g.x, g.y, g.z)];
    let l = light_at(vec3<f32>(g));
    var gl = 0.0;
    if (u.look2.z > 0.0) { gl = glow_at(vec3<f32>(g)); }
    textureStore(volume, vec3<i32>(g), vec4<f32>(s.x, emission_temperature(s.y, s.w), l, gl));
}
