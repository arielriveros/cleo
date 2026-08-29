// Deferred geometry pass for unlit ("basic") materials.
//
// The colour goes into the EMISSIVE channel with zero albedo, so the deferred lighting pass passes it
// through unlit — no diffuse or specular contribution. Zero albedo is also what the bloom mask keys on,
// so unlit pixels never bloom.
//
// Uses VertexOutput from whichever basic vertex chunk the program included.

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;
@group(0) @binding(2) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_maskMap_sampler: sampler;

struct BasicGeometryMaterial {
    color: vec3<f32>,
    opacity: f32,
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass a boolean.
    hasTexture: i32,
    /**
     * Alpha cutout. Below this the fragment is DISCARDED; 0 disables it (that is the "off" encoding,
     * so 0 is not a valid threshold).
     *
     * The value tested is the mask texture's RED channel. Red rather than alpha, despite the name:
     * it is the engine's convention for a standalone single-channel map (see the reflectivity note in
     * systems/texturePacker.ts), it is what Blinn-Phong's mask has always read, and it is what the
     * assimp opacity-map import (aiTextureType_OPACITY) feeds into this slot. A grayscale mask has
     * r == g == b, so red is the only channel that works for the maps this slot actually receives.
     *
     * Discard, not a blend: this material also renders through the deferred G-buffer, which has no
     * alpha channel to carry coverage, so a cutout is the only mechanism that behaves the same in
     * both pipelines.
     */
    alphaCutoff: f32,
    hasMaskMap: i32,
};
@group(1) @binding(1) var<uniform> u_material: BasicGeometryMaterial;

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,    // rgb = albedo (0 => unlit), a = metallic
    @location(1) gNormalRoughness: vec4<f32>,   // rg = oct normal, b = reflectance, a = roughness (normal unused: unlit)
    @location(2) gEmissiveAO: vec4<f32>,        // rgb = emissive (the colour), a = ambient occlusion
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    // The cutout first, before any other work — a discarded fragment costs nothing downstream.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r;
        if (mask < u_material.alphaCutoff) { discard; }
    }

    var color = toLinear(u_material.color);
    if (u_material.hasTexture != 0) {
        // sRGB -> linear
        color *= toLinear(textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv).rgb);
    }

    var out: GBuffer;
    out.gAlbedoMetallic = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    // (0, 0) IS the octahedral encoding of +Z, so this writes the same normal it always did without
    // needing the encoder. Unlit anyway — deferredLighting takes the emissive branch for this material.
    out.gNormalRoughness = vec4<f32>(0.0, 0.0, 0.5, 1.0);
    out.gEmissiveAO = vec4<f32>(color, 1.0);
    return out;
}
