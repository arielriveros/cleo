// GI apply: the volumes' irradiance at every visible surface (render/gi/giResolve.ts). One full-screen pass
// over the G-buffer, at full or half resolution; the deferred lighting pass takes its result as the most
// specific indirect diffuse, ahead of the light probes and the sky (deferredLighting.wgsl `sampleGI`).
//
// .rgb = sum of claim x E/pi on the FRAME's scale (intensity x pre-exposure / store scale, in each volume's
// blend w), .a = the share the volumes claimed. A background pixel writes nothing claimed.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"
#include "./chunks/giSample.wgsl"

@group(0) @binding(0) var u_gNormalRoughness_texture: texture_2d<f32>;
@group(0) @binding(1) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(2) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_gDepth_sampler: sampler;

struct GiResolveUniforms {
    /** clip -> world, uv-consuming (the deferred pass's reconstruction). */
    u_invViewProj: mat4x4<f32>,
    u_viewPos: vec3<f32>,
    _pad0: f32,
};
@group(1) @binding(0) var<uniform> u_resolve: GiResolveUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    if (depth >= 1.0) { return vec4<f32>(0.0); }
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_resolve.u_invViewProj * clip;
    let P = world.xyz / world.w;
    let N = octDecode(textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, uv, 0.0).rg);
    let V = normalize(u_resolve.u_viewPos - P);
    return giIrradianceAt(P, N, V);
}
