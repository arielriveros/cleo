// GI apply: the volumes' irradiance at every visible surface (render/gi/giResolve.ts). One full-screen pass
// over the G-buffer, at full or half resolution; the deferred lighting pass takes its result as the most
// specific indirect diffuse, ahead of the light probes and the sky (deferredLighting.wgsl `sampleGI`).
//
// .rgb = sum of claim x E/pi on the FRAME's scale (intensity x pre-exposure / store scale, in each volume's
// blend w), .a = the share of the fill (light probes, ambient, sky light) the volumes REPLACE: what they
// claimed, less an additive volume's claim, whose light goes on top of the fill. A background pixel writes
// nothing claimed.

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
    /** xy the G-buffer's size, zw this target's (texels): equal at full resolution. */
    u_sizes: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_resolve: GiResolveUniforms;

/**
 * The G-buffer texel a texel of this target is computed at: the first of the block it covers. One exact
 * texel rather than this texel's uv, which at reduced resolution falls between four of them and reads a
 * blend of their normals. deferredLighting.wgsl `giUpsample` reads the same texel back to weigh it.
 */
fn giSourceTexel(here: vec2<f32>) -> vec2<i32> {
    return vec2<i32>(floor(floor(here) * u_resolve.u_sizes.xy / u_resolve.u_sizes.zw));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texel = giSourceTexel(in.position.xy);
    // Depth SAMPLED at the texel's centre: naga's GLSL cannot textureLoad a depth texture.
    let uv = (vec2<f32>(texel) + vec2<f32>(0.5)) / u_resolve.u_sizes.xy;
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    if (depth >= 1.0) {
        // The normal's sampler and the probe data, read for nothing and only by the sky: a pipeline layout
        // drops what the shader never reaches, and the groups bind one for every texture (see
        // giAmbientCube's anchors). The lookup itself reads neither (the states are in the irradiance's
        // alpha, giStateStamp.wgsl).
        return vec4<f32>(textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, uv, 0.0).a
                       + giProbeData(0).w) * 0.0;
    }
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_resolve.u_invViewProj * clip;
    let P = world.xyz / world.w;
    let N = octDecode(textureLoad(u_gNormalRoughness_texture, texel, 0).rg);
    let V = normalize(u_resolve.u_viewPos - P);
    let g = giLightAt(P, N, V);
    return vec4<f32>(g.light, g.replaced);
}
