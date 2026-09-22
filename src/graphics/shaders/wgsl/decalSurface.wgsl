// Surface decals — the DBuffer write, Unreal's DBuffer decal pass.
//
// Runs after the geometry pass and before SSAO and lighting, drawing each decal box's back faces into
// three RGBA8 targets cleared to (0, 0, 0, 1). Every output is PREMULTIPLIED — (value * a, a) — and the
// renderer blends all three with colour `one, one-minus-src-alpha` and alpha `zero,
// one-minus-src-alpha`. After N overlapping decals each target therefore holds the composited decal
// value in rgb and the product of (1 - a) in alpha: how much of the SURFACE survives. decalResolve.wgsl
// folds that into the G-buffer as `surface * alpha + rgb`.
//
// Why not blend straight into the G-buffer, as a forward engine would: the normal is octahedral-packed
// (a lerp of two encodings is not the encoding of the lerp) and metallic, roughness and AO live in alpha
// channels, so there is no alpha left to blend BY. The DBuffer keeps every attribute in rgb with its
// own coverage, in a blendable encoding — the normal as n * 0.5 + 0.5, exactly Unreal's DBufferB.
//
// Targets: 0 = albedo (A), 1 = normal (B), 2 = roughness, metallic, AO (C) — one coverage for the
// three, as DBufferC has.

#include "./chunks/octNormal.wgsl"
#include "./chunks/decal.wgsl"

// The projected material's maps, named `u_material_<field>` so the renderer's material bind group can
// resolve each from `material.textures` by name, exactly as the PBR geometry pass does.
@group(0) @binding(0) var u_material_baseColorTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseColorTexture_sampler: sampler;
@group(0) @binding(2) var u_material_ormTexture_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_ormTexture_sampler: sampler;
@group(0) @binding(4) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_normalMap_sampler: sampler;
@group(0) @binding(6) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_maskMap_sampler: sampler;

// The G-buffer's normal target — NOT attached in this pass, so reading it is legal. The surface normal
// drives both the angle fade and the frame the decal's own normal map is decoded in.
@group(2) @binding(4) var u_gNormalRoughness_texture: texture_2d<f32>;
@group(2) @binding(5) var u_gNormalRoughness_sampler: sampler;

struct DBuffer {
    @location(0) albedo: vec4<f32>,     // albedo * a, a
    @location(1) normal: vec4<f32>,     // (n * 0.5 + 0.5) * a, a
    @location(2) surface: vec4<f32>,    // (roughness, metallic, ao) * a, a
};

/**
 * Half a texel inside [0, 1]: decal textures carry their own wrap mode, and a repeat-wrapped one would
 * otherwise bilinear-bleed its opposite edge in along the box's border.
 */
fn insetUv(uv: vec2<f32>, dims: vec2<u32>) -> vec2<f32> {
    let border = 0.5 / max(vec2<f32>(dims), vec2<f32>(1.0));
    return clamp(uv, border, vec2<f32>(1.0) - border);
}

@fragment
fn fs_main(in: VertexOutput) -> DBuffer {
    let s = decalSample(in.position.xy);
    let surfaceN = octDecode(textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler,
                                                s.screenUv, 0.0).rg);
    let coverage = s.weight * decalAngleWeight(surfaceN) * u_decal.u_decalOpacity;

    // Colour and coverage: the material's base colour and alpha, or the radial gradient.
    var albedo = u_material.baseColor;
    var alpha = u_material.opacity;
    if (u_decal.u_pattern == 0) {
        if (u_material.hasBaseColorTexture != 0) {
            let texel = textureSampleGrad(u_material_baseColorTexture_texture,
                                          u_material_baseColorTexture_sampler,
                                          insetUv(s.uv, textureDimensions(u_material_baseColorTexture_texture, 0)),
                                          s.ddx, s.ddy);
            albedo *= pow(texel.rgb, vec3<f32>(2.2));   // sRGB -> linear, as pbrGBuffer.wgsl
            alpha *= texel.a;
        }
        if (u_material.hasMaskMap != 0) {
            alpha *= textureSampleGrad(u_material_maskMap_texture, u_material_maskMap_sampler,
                                       insetUv(s.uv, textureDimensions(u_material_maskMap_texture, 0)),
                                       s.ddx, s.ddy).r;
        }
    } else {
        let p = radialPattern(s.t, s.tPerPixel);
        albedo = p.rgb;
        alpha = p.a;
    }
    let a = clamp(alpha * coverage, 0.0, 1.0);

    // Roughness / metallic / AO, from the packed ORM map where authored (glTF layout: r = AO,
    // g = roughness, b = metallic), else the scalars.
    var roughness = u_material.roughness;
    var metallic = u_material.metallic;
    var ao = 1.0;
    if (u_decal.u_pattern == 0
        && (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0)) {
        let orm = textureSampleGrad(u_material_ormTexture_texture, u_material_ormTexture_sampler,
                                    insetUv(s.uv, textureDimensions(u_material_ormTexture_texture, 0)),
                                    s.ddx, s.ddy).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    // The decal's normal map, decoded in a frame laid on the RECEIVING surface: tangent = the decal's
    // +X projected into the surface plane, bitangent = cross(T, N). That bitangent is the engine's
    // green-down convention for this chart (v runs toward -Z, so cross(X, Y) = +Z = -dP/dv), the same
    // one chunks/modelVarying.wgsl produces by negating the imported bitangent.
    var normalA = 0.0;
    var n = surfaceN;
    if (u_decal.u_affectNormal != 0 && u_decal.u_pattern == 0 && u_material.hasNormalMap != 0) {
        let tn = normalize(textureSampleGrad(u_material_normalMap_texture, u_material_normalMap_sampler,
                                             insetUv(s.uv, textureDimensions(u_material_normalMap_texture, 0)),
                                             s.ddx, s.ddy).rgb * 2.0 - 1.0);
        let projected = u_decal.u_decalAxisX - surfaceN * dot(u_decal.u_decalAxisX, surfaceN);
        // A surface whose normal IS the decal's X (a wall the decal meets edge-on) has no projection;
        // fall back to the in-plane direction the other decal axis gives.
        let fallback = cross(surfaceN, u_decal.u_decalAxisY);
        let T = normalize(select(projected, fallback, dot(projected, projected) < 1e-8));
        let B = cross(T, surfaceN);
        n = normalize(T * tn.x + B * tn.y + surfaceN * tn.z);
        normalA = a;
    }

    var out: DBuffer;
    out.albedo = select(vec4<f32>(0.0), vec4<f32>(albedo * a, a), u_decal.u_affectAlbedo != 0);
    out.normal = vec4<f32>((n * 0.5 + 0.5) * normalA, normalA);
    out.surface = select(vec4<f32>(0.0), vec4<f32>(vec3<f32>(roughness, metallic, ao) * a, a),
                         u_decal.u_affectSurface != 0);
    return out;
}
