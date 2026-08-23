// Deferred geometry pass for Blinn-Phong ("default") materials, shared by the plain, skinned and
// instanced programs.
//
// Translates the legacy Blinn-Phong parameters into the metallic-roughness G-buffer the deferred
// lighting pass reads, so a scene can mix both material models and still be lit once.
//
// Uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl: whichever vertex chunk the
// program included already brought them in, and a second definition is a compile error.

// Samplers live outside the material struct, named `u_material_<field>` — WGSL has no opaque types in a
// struct, and no legal identifier generates a dotted GLSL name.
@group(0) @binding(0) var u_material_baseTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseTexture_sampler: sampler;
@group(0) @binding(2) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_normalMap_sampler: sampler;
@group(0) @binding(4) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(6) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_maskMap_sampler: sampler;

struct BlinnPhongGeometryMaterial {
    diffuse: vec3<f32>,
    emissive: vec3<f32>,
    shininess: f32,
    reflectivity: f32,
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
    hasBaseTexture: i32,
    hasNormalMap: i32,
    hasEmissiveMap: i32,
    hasMaskMap: i32,
};
@group(2) @binding(0) var<uniform> u_material: BlinnPhongGeometryMaterial;

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,    // rgb = albedo, a = metallic
    @location(1) gNormalRoughness: vec4<f32>,   // rgb = world normal, a = roughness
    @location(2) gEmissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let tbn = tbnOf(in);

    if (u_material.hasMaskMap != 0) {
        let mask = textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r;
        if (mask < 0.5) { discard; }
    }

    var albedo = u_material.diffuse;
    if (u_material.hasBaseTexture != 0) {
        // sRGB -> linear
        let t = textureSample(u_material_baseTexture_texture, u_material_baseTexture_sampler, in.uv).rgb;
        albedo *= pow(t, vec3<f32>(2.2));
    }

    // Blinn-Phong shininess -> perceptual roughness. Biased rougher (matte) so typical default
    // materials aren't glossy and don't pick up env reflection (shininess 32 -> ~0.49).
    let roughness = clamp(pow(2.0 / (u_material.shininess + 2.0), 0.25), 0.08, 1.0);
    // Legacy materials are dielectric; only "very specular" ones (high reflectivity) reflect the env.
    let metallic = clamp(u_material.reflectivity, 0.0, 1.0);

    var N = tbn[2];
    if (u_material.hasNormalMap != 0) {
        var n = textureSample(u_material_normalMap_texture, u_material_normalMap_sampler, in.uv).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(tbn * n);
    }

    // Match the old forward path's emissive boost of 1.25.
    var emissive = u_material.emissive * 1.25;
    if (u_material.hasEmissiveMap != 0) {
        // sRGB -> linear
        let t = textureSample(u_material_emissiveMap_texture, u_material_emissiveMap_sampler, in.uv).rgb;
        emissive = pow(t, vec3<f32>(2.2)) * u_material.emissive * 1.25;
    }

    var out: GBuffer;
    out.gAlbedoMetallic = vec4<f32>(albedo, metallic);
    out.gNormalRoughness = vec4<f32>(normalize(N), roughness);
    out.gEmissiveAO = vec4<f32>(emissive, 1.0);
    return out;
}
