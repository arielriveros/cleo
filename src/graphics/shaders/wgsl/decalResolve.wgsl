// Surface decals — the resolve: fold the DBuffer into the G-buffer.
//
// Fullscreen, drawn INTO the G-buffer (all three targets, no blending) while reading a copy of it taken
// just before, since a pass cannot sample what it is writing. The DBuffer holds, per attribute group,
// the premultiplied decal value in rgb and the surviving fraction of the surface in alpha — see
// decalSurface.wgsl — so every attribute resolves as
//
//     result = surface * dbuffer.a + dbuffer.rgb
//
// The normal is resolved in the DBuffer's blendable encoding (n * 0.5 + 0.5) and re-packed
// octahedrally. Reflectance and emissive pass through: a decal writes neither.
//
// The G-buffer DEPTH is attached to this pass and is therefore never sampled here. Untouched pixels are
// told apart by the DBuffer's alphas instead, and discarded so they cost no G-buffer write at all.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"

@group(0) @binding(0) var u_gAlbedoMetallic_texture: texture_2d<f32>;    // copy: rgb = albedo, a = metallic
@group(0) @binding(1) var u_gAlbedoMetallic_sampler: sampler;
@group(0) @binding(2) var u_gNormalRoughness_texture: texture_2d<f32>;   // copy: rg = oct normal, b = reflectance, a = roughness
@group(0) @binding(3) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(4) var u_gEmissiveAO_texture: texture_2d<f32>;        // copy: rgb = emissive, a = ao
@group(0) @binding(5) var u_gEmissiveAO_sampler: sampler;
@group(0) @binding(6) var u_dbufferAlbedo_texture: texture_2d<f32>;
@group(0) @binding(7) var u_dbufferAlbedo_sampler: sampler;
@group(0) @binding(8) var u_dbufferNormal_texture: texture_2d<f32>;
@group(0) @binding(9) var u_dbufferNormal_sampler: sampler;
@group(0) @binding(10) var u_dbufferSurface_texture: texture_2d<f32>;
@group(0) @binding(11) var u_dbufferSurface_sampler: sampler;

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,
    @location(1) gNormalRoughness: vec4<f32>,
    @location(2) gEmissiveAO: vec4<f32>,
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let g0 = textureSampleLevel(u_gAlbedoMetallic_texture, u_gAlbedoMetallic_sampler, in.uv, 0.0);
    let g1 = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, in.uv, 0.0);
    let g2 = textureSampleLevel(u_gEmissiveAO_texture, u_gEmissiveAO_sampler, in.uv, 0.0);
    let dA = textureSampleLevel(u_dbufferAlbedo_texture, u_dbufferAlbedo_sampler, in.uv, 0.0);
    let dB = textureSampleLevel(u_dbufferNormal_texture, u_dbufferNormal_sampler, in.uv, 0.0);
    let dC = textureSampleLevel(u_dbufferSurface_texture, u_dbufferSurface_sampler, in.uv, 0.0);

    // No decal touched this pixel: the DBuffer still holds its clear alpha of exactly 1 everywhere (a
    // zero-coverage write multiplies it by exactly 1, so the test needs no tolerance).
    // Zero albedo is the engine's UNLIT marker — an unlit Basic surface stores its colour as emissive
    // and deferredLighting.wgsl skips lighting it. Giving it albedo would make it lit, and bloom-eligible,
    // under the decal. Neither kind is written; both keep their G-buffer texels untouched.
    let untouched = dA.a >= 1.0 && dB.a >= 1.0 && dC.a >= 1.0;
    let unlit = dot(g0.rgb, g0.rgb) <= 0.0;
    if (untouched || unlit) { discard; }

    let albedo = g0.rgb * dA.a + dA.rgb;
    let metallic = g0.a * dC.a + dC.g;
    let roughness = g1.a * dC.a + dC.r;
    let ao = g2.a * dC.a + dC.b;
    let encoded = (octDecode(g1.rg) * 0.5 + 0.5) * dB.a + dB.rgb;
    let n = encoded * 2.0 - 1.0;
    // A decal normal exactly opposite the surface's could cancel it; keep the surface's then.
    let normal = select(normalize(n), octDecode(g1.rg), dot(n, n) < 1e-8);
    let oct = octEncode(normal);

    var out: GBuffer;
    out.gAlbedoMetallic = vec4<f32>(clamp(albedo, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(metallic, 0.0, 1.0));
    out.gNormalRoughness = vec4<f32>(oct.x, oct.y, g1.b, clamp(roughness, 0.0, 1.0));
    out.gEmissiveAO = vec4<f32>(g2.rgb, clamp(ao, 0.0, 1.0));
    return out;
}
