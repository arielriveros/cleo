// The cloud-noise volume bake, as a COMPUTE dispatch. The WebGPU half of `cloudNoiseBake.wgsl`.
//
// WHY A SECOND MODULE AT ALL. A WebGPU render attachment must be a 2D or 2D-array view, and a 3D
// texture's z-slice can never be one — so the raster bake's "one fullscreen draw per slice, with
// `framebufferTextureLayer` re-pointing the attachment" has no WebGPU spelling. Writing a
// `texture_storage_3d` from a compute shader does, and it fills the whole volume in one dispatch
// instead of 128 (and then 32) draws.
//
// The FIELD is not duplicated: `chunks/cloudNoiseField.wgsl` holds it, and both modules include it.
// That is the whole reason the chunk exists — the WebGL2 volume is pinned by a recorded pixel
// signature, so a second copy of the noise would be a second thing to keep bit-identical by hand.
//
// NO `fullscreen.wgsl` INCLUDE. It declares an `@vertex` entry point, and a module carrying one would
// be a render module with a compute function bolted on: the translator would send that vertex stage
// through naga's GLSL ES 300 backend at build time and the pipeline here would want a vertex layout
// that does not exist. A compute module declares exactly one stage.
//
// This module has no GLSL half by construction — see tools/wgslTranslate.mjs, which sends only the
// raster stages through naga because ES 300 has no compute stage to translate to.

#include "./chunks/cloudNoiseField.wgsl"

struct CloudNoiseComputeUniforms {
    u_size: f32,       // texels across the volume, the same on all three axes
    u_period: f32,     // lattice cells across the volume at octave 0 (the tiling period)
    u_octaves: i32,    // octaves in the R channel FBM
    u_detail: i32,     // non-zero when baking the small high-frequency detail volume
};
@group(0) @binding(0) var<uniform> u_noise: CloudNoiseComputeUniforms;

// Reflected as `kind: 'texture'` by findResources, which matches on the `texture_` prefix and does not
// look at the storage part. Harmless: WebGPU binds by group and binding and never consults the kind,
// and the only consumer that does — the WebGL2 bind group — refuses a storage entry outright.
@group(0) @binding(1) var u_volume: texture_storage_3d<rgba8unorm, write>;

// 64 invocations per workgroup, cubic so the three axes are addressed symmetrically. Both volume
// sizes the renderer bakes (128 and 32) are multiples of 4, so the grid divides exactly.
@compute @workgroup_size(4, 4, 4)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = u32(u_noise.u_size);
    // Cheap insurance rather than dead code: the dispatch rounds its workgroup count up, so a volume
    // size that is not a multiple of 4 would otherwise write outside the texture.
    if (gid.x >= size || gid.y >= size || gid.z >= size) { return; }

    // TEXEL CENTRES, on all three axes — the entire correctness question in this file.
    //
    // The raster path gets them for free twice over: `in.uv` interpolated at a fragment centre is
    // exactly (x + 0.5) / size, and the renderer hands it (z + 0.5) / size as `u_slice`. A compute
    // invocation is handed the integer index instead, so the +0.5 has to be written down. Dropping it
    // shifts the whole field by half a texel on every axis, which still looks like plausible cloud
    // noise and would never be caught by eye.
    let p = (vec3<f32>(gid) + 0.5) / u_noise.u_size * u_noise.u_period;

    textureStore(u_volume, vec3<i32>(gid),
                 cloudNoiseTexel(p, u_noise.u_period, u_noise.u_octaves, u_noise.u_detail));
}
