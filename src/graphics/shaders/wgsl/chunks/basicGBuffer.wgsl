// Deferred geometry pass for unlit ("basic") materials.
//
// The colour goes into the EMISSIVE channel with zero albedo, so the deferred lighting pass passes it
// through unlit — no diffuse or specular contribution. Zero albedo is also what the bloom mask keys on,
// so unlit pixels never bloom.
//
// Uses VertexOutput from whichever basic vertex chunk the program included.

@group(0) @binding(0) var u_material_texture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_texture_sampler: sampler;

struct BasicGeometryMaterial {
    color: vec3<f32>,
    opacity: f32,
    hasTexture: i32,
};
@group(2) @binding(0) var<uniform> u_material: BasicGeometryMaterial;

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,    // rgb = albedo (0 => unlit), a = metallic
    @location(1) gNormalRoughness: vec4<f32>,   // rgb = world normal (unused for unlit), a = roughness
    @location(2) gEmissiveAO: vec4<f32>,        // rgb = emissive (the colour), a = ambient occlusion
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    var color = toLinear(u_material.color);
    if (u_material.hasTexture != 0) {
        // sRGB -> linear
        color *= toLinear(textureSample(u_material_texture_texture, u_material_texture_sampler, in.uv).rgb);
    }

    var out: GBuffer;
    out.gAlbedoMetallic = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.gNormalRoughness = vec4<f32>(0.0, 0.0, 1.0, 1.0);
    out.gEmissiveAO = vec4<f32>(color, 1.0);
    return out;
}
