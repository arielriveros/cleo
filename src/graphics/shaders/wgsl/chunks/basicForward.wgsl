// Unlit forward shading. The GLSL twin is materials/basic.fs.
//
// Uses VertexOutput from whichever basic vertex chunk the program included.

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;
@group(0) @binding(2) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_maskMap_sampler: sampler;

struct BasicMaterial {
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
@group(1) @binding(1) var<uniform> u_material: BasicMaterial;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The cutout first, before any other work — a discarded fragment costs nothing downstream.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r;
        if (mask < u_material.alphaCutoff) { discard; }
    }

    // Decode the sRGB-authored colour/texture to linear; this shader writes into the linear-HDR scene
    // buffer and is tonemapped once at the final present like every other surface.
    var color = toLinear(u_material.color);
    var alpha = u_material.opacity;

    if (u_material.hasTexture != 0) {
        let texColor = textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv);
        color *= toLinear(texColor.rgb);
        alpha *= texColor.a;
    }

    return vec4<f32>(color, alpha);
}
