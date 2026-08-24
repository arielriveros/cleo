// One z-slice of a TILEABLE 3D noise volume, baked once at startup and thereafter sampled by
// volumetricClouds instead of being recomputed per raymarch step.
//
// WHY BAKE: the cloud raymarch evaluated a 4-octave FBM (32 hash+lerp taps) for every primary sample
// and a 3-octave FBM again for detail erosion, plus the same 4-octave field for every secondary
// sun-march sample. At 40 primary x 5 light steps that is thousands of hash evaluations per pixel to
// reproduce a field that never changes. Two trilinear texture fetches give the same answer.
//
// WHY TILEABLE, and what it costs: a texture can only stand in for an infinite procedural field if the
// field repeats at the texture's period. So the value noise in the chunk hashes lattice cells modulo a
// per-octave period rather than hashing raw coordinates. The visible consequence is that the cloud
// field now repeats — see BASE_PERIOD in the renderer for the world distance that works out to.
//
// The renderer draws this once per slice; `u_slice` is the slice's centre in [0,1] along z. On WebGL2
// that is `framebufferTextureLayer` per slice. On WebGPU a render pass cannot target a 3D texture
// slice at all, so this module is unreachable there and `cloudNoiseBakeCompute.wgsl` — same field,
// same chunk, one dispatch — takes its place.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/cloudNoiseField.wgsl"

struct CloudNoiseUniforms {
    u_slice: f32,      // z coordinate of this layer, at texel centre
    u_period: f32,     // lattice cells across the volume at octave 0 (the tiling period)
    u_octaves: i32,    // octaves in the R channel FBM
    u_detail: i32,     // non-zero when baking the small high-frequency detail volume
};
@group(1) @binding(0) var<uniform> u_noise: CloudNoiseUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Position in lattice space: [0,1] across the volume, scaled to `u_period` cells. `in.uv` at a
    // fragment centre is exactly (x + 0.5) / size, and the renderer supplies (z + 0.5) / size as
    // `u_slice` — so this is the texel centre on all three axes, which is what the compute path has
    // to reproduce from its workgroup id.
    let p = vec3<f32>(in.uv, u_noise.u_slice) * u_noise.u_period;
    return cloudNoiseTexel(p, u_noise.u_period, u_noise.u_octaves, u_noise.u_detail);
}
