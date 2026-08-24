// The PBR G-buffer fragment stage, shared by the plain, skinned and instanced geometry programs.
//
// It uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl itself: whichever
// vertex chunk the program included already brought them in, and including it here as well would
// define the struct twice. The include resolver has no include-once guard.

// Samplers are separate globals named `u_material_<field>`, not members of the material struct: WGSL
// has no opaque types in a struct, and no legal identifier generates a dotted GLSL name. The GLSL twin
// hoists them the same way, so the renderer names them identically for both.
@group(0) @binding(0) var u_material_baseColorTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseColorTexture_sampler: sampler;
@group(0) @binding(2) var u_material_ormTexture_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_ormTexture_sampler: sampler;
@group(0) @binding(4) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_normalMap_sampler: sampler;
@group(0) @binding(6) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_emissiveMap_sampler: sampler;

struct PBRMaterial {
    baseColor: vec3<f32>,
    emissiveFactor: vec3<f32>,
    metallic: f32,
    roughness: f32,
    opacity: f32,
    // Every flag is an i32, not a bool: WGSL forbids bool in a uniform buffer (not host-shareable).
    // Call sites still pass JavaScript booleans — the std140 writer converts them, because the
    // reflected member type is integer.
    hasBaseColorTexture: i32,
    // Occlusion, roughness and metallic are authored as separate maps and combined into ONE texture by
    // systems/texturePacker.ts before they get here (glTF layout: r=AO, g=roughness, b=metallic). Each
    // flag says whether its channel was actually authored; the others fall back to the scalars above.
    hasMetallicMap: i32,
    hasRoughnessMap: i32,
    hasOcclusionMap: i32,
    hasNormalMap: i32,
    hasEmissiveMap: i32,
};
@group(1) @binding(1) var<uniform> u_material: PBRMaterial;

struct GBuffer {
    @location(0) gAlbedoMetallic: vec4<f32>,    // rgb = albedo, a = metallic
    @location(1) gNormalRoughness: vec4<f32>,   // rgb = world normal, a = roughness
    @location(2) gEmissiveAO: vec4<f32>,        // rgb = emissive, a = ambient occlusion
};

fn getNormal(in: VertexOutput) -> vec3<f32> {
    let tbn = tbnOf(in);
    var N = tbn[2];
    if (u_material.hasNormalMap != 0) {
        var n = textureSample(u_material_normalMap_texture, u_material_normalMap_sampler, in.uv).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(tbn * n);
    }
    return N;
}

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    var albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture != 0) {
        // sRGB -> linear
        let t = textureSample(u_material_baseColorTexture_texture, u_material_baseColorTexture_sampler, in.uv).rgb;
        albedo *= pow(t, vec3<f32>(2.2));
    }

    var metallic = u_material.metallic;
    var roughness = u_material.roughness;
    var ao = 1.0;
    if (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0) {
        let orm = textureSample(u_material_ormTexture_texture, u_material_ormTexture_sampler, in.uv).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    var emissive = u_material.emissiveFactor;
    if (u_material.hasEmissiveMap != 0) {
        // sRGB -> linear
        let t = textureSample(u_material_emissiveMap_texture, u_material_emissiveMap_sampler, in.uv).rgb;
        emissive = pow(t, vec3<f32>(2.2)) * u_material.emissiveFactor;
    }

    let N = normalize(getNormal(in));

    var out: GBuffer;
    out.gAlbedoMetallic = vec4<f32>(albedo, metallic);
    out.gNormalRoughness = vec4<f32>(N, roughness);
    out.gEmissiveAO = vec4<f32>(emissive, ao);
    return out;
}
