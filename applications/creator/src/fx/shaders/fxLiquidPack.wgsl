// The live preview's hand-off to the engine: per voxel (density, foam, light, 0) into the FluidVolumeNode's
// texture, which its `liquid` shading draws -- liquidRender.ts `packLiquidVolume` without leaving the GPU.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> dens: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> light: array<f32>;
@group(0) @binding(3) var volume: texture_storage_3d<rgba16float, write>;

fn light_cell(x: i32, y: i32, z: i32) -> f32 {
    let ld = vec3<i32>(u.light_dims.xyz);
    let c = clamp(vec3<i32>(x, y, z), vec3<i32>(0), ld - vec3<i32>(1));
    return light[u32(c.x + ld.x * (c.y + ld.y * c.z))];
}

@compute @workgroup_size(4, 4, 4)
fn cs_liquid_pack(@builtin(global_invocation_id) g: vec3<u32>) {
    if (any(g >= u.grid.xyz)) { return; }
    let d = dens[g.x + u.grid.x * (g.y + u.grid.y * g.z)];
    // The half-resolution light, trilinear at this voxel.
    let q = vec3<f32>(g) * 0.5;
    let b = vec3<i32>(floor(q));
    let f = q - vec3<f32>(b);
    let c00 = mix(light_cell(b.x, b.y, b.z), light_cell(b.x + 1, b.y, b.z), f.x);
    let c10 = mix(light_cell(b.x, b.y + 1, b.z), light_cell(b.x + 1, b.y + 1, b.z), f.x);
    let c01 = mix(light_cell(b.x, b.y, b.z + 1), light_cell(b.x + 1, b.y, b.z + 1), f.x);
    let c11 = mix(light_cell(b.x, b.y + 1, b.z + 1), light_cell(b.x + 1, b.y + 1, b.z + 1), f.x);
    let l = mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
    textureStore(volume, vec3<i32>(g), vec4<f32>(d.x, d.y, l, 0.0));
}
