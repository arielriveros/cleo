// The terrain layer stack: four tiled PBR layers blended by an RGBA splat map.
//
// Shared by the deferred pass (geometryTerrain) and the forward one (terrainForward). Those two carried
// verbatim copies of all of this — nine sampler declarations, ~50 uniforms, `band`, `addLayer` and the
// whole blend — differing only in what they did with the result. That is exactly the duplication this
// migration exists to remove: one of the two was always going to get a fix the other did not.
//
// A consumer includes this, calls `resolveTerrainSurface()`, and shades however it likes.
//
// `u_normalN` is a PACKED texture built by systems/texturePacker.ts: rgb = tangent-space normal,
// a = displacement height in 0..1. A layer with a height map but no normal map still binds one here,
// with a flat normal in rgb. Folding height into the normal's unused alpha is what took terrain from
// 13 bound texture units down to 9.

@group(0) @binding(0)  var u_splat_texture: texture_2d<f32>;
@group(0) @binding(1)  var u_splat_sampler: sampler;
@group(0) @binding(2)  var u_albedo0_texture: texture_2d<f32>;
@group(0) @binding(3)  var u_albedo0_sampler: sampler;
@group(0) @binding(4)  var u_albedo1_texture: texture_2d<f32>;
@group(0) @binding(5)  var u_albedo1_sampler: sampler;
@group(0) @binding(6)  var u_albedo2_texture: texture_2d<f32>;
@group(0) @binding(7)  var u_albedo2_sampler: sampler;
@group(0) @binding(8)  var u_albedo3_texture: texture_2d<f32>;
@group(0) @binding(9)  var u_albedo3_sampler: sampler;
@group(0) @binding(10) var u_normal0_texture: texture_2d<f32>;
@group(0) @binding(11) var u_normal0_sampler: sampler;
@group(0) @binding(12) var u_normal1_texture: texture_2d<f32>;
@group(0) @binding(13) var u_normal1_sampler: sampler;
@group(0) @binding(14) var u_normal2_texture: texture_2d<f32>;
@group(0) @binding(15) var u_normal2_sampler: sampler;
@group(0) @binding(16) var u_normal3_texture: texture_2d<f32>;
@group(0) @binding(17) var u_normal3_sampler: sampler;

// Every scalar name here ends in a layer index, which is exactly the shape naga escapes: it emits
// `u_tiling0` as `u_tiling0_`. `UniformBlockSet` un-mangles the trailing underscore, and it has to —
// without that, all forty of these resolve to nothing and terrain renders with a zeroed layout.
struct TerrainUniforms {
    u_baseColor: vec3<f32>,
    u_viewPos: vec3<f32>,          // camera world position: parallax view vector, and specular V
    u_color0: vec3<f32>,
    u_color1: vec3<f32>,
    u_color2: vec3<f32>,
    u_color3: vec3<f32>,
    // A world-Y band per layer, for the automatic height mask.
    u_hRange0: vec2<f32>,
    u_hRange1: vec2<f32>,
    u_hRange2: vec2<f32>,
    u_hRange3: vec2<f32>,
    // A slope band per layer, where slope = 1 - N.y (0 flat .. 1 vertical).
    u_sRange0: vec2<f32>,
    u_sRange1: vec2<f32>,
    u_sRange2: vec2<f32>,
    u_sRange3: vec2<f32>,
    u_metallic0: f32,
    u_metallic1: f32,
    u_metallic2: f32,
    u_metallic3: f32,
    u_roughness0: f32,
    u_roughness1: f32,
    u_roughness2: f32,
    u_roughness3: f32,
    u_tiling0: f32,
    u_tiling1: f32,
    u_tiling2: f32,
    u_tiling3: f32,
    u_dispScale0: f32,
    u_dispScale1: f32,
    u_dispScale2: f32,
    u_dispScale3: f32,
    u_heightBlend0: f32,
    u_heightBlend1: f32,
    u_heightBlend2: f32,
    u_heightBlend3: f32,
    // Every flag is an i32: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
    u_layerCount: i32,
    u_useAuto: i32,
    u_hasAlbedo0: i32,
    u_hasAlbedo1: i32,
    u_hasAlbedo2: i32,
    u_hasAlbedo3: i32,
    u_hasNormal0: i32,
    u_hasNormal1: i32,
    u_hasNormal2: i32,
    u_hasNormal3: i32,
    u_hasDisp0: i32,
    u_hasDisp1: i32,
    u_hasDisp2: i32,
    u_hasDisp3: i32,
    u_auto0: i32,
    u_auto1: i32,
    u_auto2: i32,
    u_auto3: i32,
};
@group(1) @binding(1) var<uniform> u_terrain: TerrainUniforms;

/** One layer's weighted contribution, before the divide by the total weight. */
struct LayerAccum {
    albedo: vec3<f32>,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
};

/** What the layer stack resolves to at one fragment, before any lighting. */
struct TerrainSurface {
    albedo: vec3<f32>,
    metallic: f32,
    roughness: f32,
    normal: vec3<f32>,
};

fn band(range: vec2<f32>, v: f32, edge: f32) -> f32 {
    let lo = smoothstep(range.x - edge, range.x + edge, v);
    let hi = 1.0 - smoothstep(range.y - edge, range.y + edge, v);
    return clamp(lo * hi, 0.0, 1.0);
}

/**
 * One layer's weighted PBR contribution at the (already parallax-offset) tiled uv.
 *
 * Returned rather than accumulated through `inout`, which WGSL does not have. Texture sampling is
 * guarded by the uniform `hasXxx` flags only, never by the per-fragment weight — a per-fragment branch
 * around a sample leaves the mip derivatives undefined.
 */
fn addLayer(w: f32, uv: vec2<f32>,
            albedoTex: texture_2d<f32>, albedoSmp: sampler, hasAlbedo: i32, color: vec3<f32>,
            normalTex: texture_2d<f32>, normalSmp: sampler, hasNormal: i32,
            metallic: f32, roughness: f32, tbn: mat3x3<f32>) -> LayerAccum {
    var alb = toLinear(color);   // sRGB layer tint -> linear
    if (hasAlbedo == 1) { alb *= toLinear(textureSample(albedoTex, albedoSmp, uv).rgb); }

    var nrm = tbn[2];
    if (hasNormal == 1) {
        let tn = textureSample(normalTex, normalSmp, uv).rgb * 2.0 - 1.0;
        nrm = normalize(tbn * tn);
    }

    var out: LayerAccum;
    out.albedo = w * alb;
    out.metallic = w * metallic;
    out.roughness = w * roughness;
    out.normal = w * nrm;
    return out;
}

/**
 * Blend the four layers at this fragment: splat weights, optional height/slope auto-masking, optional
 * height-aware bias, per-layer parallax, then a weighted average.
 *
 * Falls back to the flat base colour when every weight is ~0 — an unpainted terrain. Without that the
 * normalise below would divide by zero and the whole surface would come out NaN.
 */
fn resolveTerrainSurface(fragPos: vec3<f32>, baseUv: vec2<f32>, tbn: mat3x3<f32>) -> TerrainSurface {
    let nGeom = normalize(tbn[2]);
    let height = fragPos.y;
    let slope = clamp(1.0 - nGeom.y, 0.0, 1.0);

    // Tangent-space view direction for parallax; TBN is orthonormal world<-tangent, so its transpose
    // is world->tangent. Offset-LIMITED parallax: Vt.xy is used directly with no 1/Vt.z, so the offset
    // stays bounded and does not swim at grazing angles.
    let vWorld = normalize(u_terrain.u_viewPos - fragPos);
    let vTangent = vec3<f32>(dot(vWorld, tbn[0]), dot(vWorld, tbn[1]), dot(vWorld, tbn[2]));
    let pdir = vTangent.xy;

    var uv0 = baseUv * u_terrain.u_tiling0;
    var uv1 = baseUv * u_terrain.u_tiling1;
    var uv2 = baseUv * u_terrain.u_tiling2;
    var uv3 = baseUv * u_terrain.u_tiling3;

    // Height comes out of the normal map's alpha, read at the UN-offset uv — it is what produces the
    // offset in the first place.
    var h0 = 0.0;
    var h1 = 0.0;
    var h2 = 0.0;
    var h3 = 0.0;
    if (u_terrain.u_hasDisp0 == 1) { h0 = textureSample(u_normal0_texture, u_normal0_sampler, uv0).a; }
    if (u_terrain.u_hasDisp1 == 1) { h1 = textureSample(u_normal1_texture, u_normal1_sampler, uv1).a; }
    if (u_terrain.u_hasDisp2 == 1) { h2 = textureSample(u_normal2_texture, u_normal2_sampler, uv2).a; }
    if (u_terrain.u_hasDisp3 == 1) { h3 = textureSample(u_normal3_texture, u_normal3_sampler, uv3).a; }
    if (u_terrain.u_hasDisp0 == 1) { uv0 -= pdir * (h0 * u_terrain.u_dispScale0); }
    if (u_terrain.u_hasDisp1 == 1) { uv1 -= pdir * (h1 * u_terrain.u_dispScale1); }
    if (u_terrain.u_hasDisp2 == 1) { uv2 -= pdir * (h2 * u_terrain.u_dispScale2); }
    if (u_terrain.u_hasDisp3 == 1) { uv3 -= pdir * (h3 * u_terrain.u_dispScale3); }

    let splat = textureSample(u_splat_texture, u_splat_sampler, baseUv);
    var w0 = splat.r;
    var w1 = splat.g;
    var w2 = splat.b;
    var w3 = splat.a;

    if (u_terrain.u_layerCount < 1) { w0 = 0.0; }
    if (u_terrain.u_layerCount < 2) { w1 = 0.0; }
    if (u_terrain.u_layerCount < 3) { w2 = 0.0; }
    if (u_terrain.u_layerCount < 4) { w3 = 0.0; }

    if (u_terrain.u_useAuto == 1) {
        if (u_terrain.u_auto0 == 1) { w0 *= band(u_terrain.u_hRange0, height, 2.0) * band(u_terrain.u_sRange0, slope, 0.08); }
        if (u_terrain.u_auto1 == 1) { w1 *= band(u_terrain.u_hRange1, height, 2.0) * band(u_terrain.u_sRange1, slope, 0.08); }
        if (u_terrain.u_auto2 == 1) { w2 *= band(u_terrain.u_hRange2, height, 2.0) * band(u_terrain.u_sRange2, slope, 0.08); }
        if (u_terrain.u_auto3 == 1) { w3 *= band(u_terrain.u_hRange3, height, 2.0) * band(u_terrain.u_sRange3, slope, 0.08); }
    }

    // Height-aware blend: bias each weight by its height. With no displacement map h is 0 and the
    // factor is 1, i.e. the original linear blend. Higher u_heightBlend sharpens transitions so high
    // spots poke through.
    w0 *= exp(u_terrain.u_heightBlend0 * h0);
    w1 *= exp(u_terrain.u_heightBlend1 * h1);
    w2 *= exp(u_terrain.u_heightBlend2 * h2);
    w3 *= exp(u_terrain.u_heightBlend3 * h3);

    let sum = w0 + w1 + w2 + w3;

    var out: TerrainSurface;
    if (sum < 1e-4) {
        out.albedo = toLinear(u_terrain.u_baseColor);
        out.metallic = 0.0;
        out.roughness = 0.9;
        out.normal = nGeom;
        return out;
    }

    let l0 = addLayer(w0, uv0, u_albedo0_texture, u_albedo0_sampler, u_terrain.u_hasAlbedo0,
                      u_terrain.u_color0, u_normal0_texture, u_normal0_sampler,
                      u_terrain.u_hasNormal0, u_terrain.u_metallic0, u_terrain.u_roughness0, tbn);
    let l1 = addLayer(w1, uv1, u_albedo1_texture, u_albedo1_sampler, u_terrain.u_hasAlbedo1,
                      u_terrain.u_color1, u_normal1_texture, u_normal1_sampler,
                      u_terrain.u_hasNormal1, u_terrain.u_metallic1, u_terrain.u_roughness1, tbn);
    let l2 = addLayer(w2, uv2, u_albedo2_texture, u_albedo2_sampler, u_terrain.u_hasAlbedo2,
                      u_terrain.u_color2, u_normal2_texture, u_normal2_sampler,
                      u_terrain.u_hasNormal2, u_terrain.u_metallic2, u_terrain.u_roughness2, tbn);
    let l3 = addLayer(w3, uv3, u_albedo3_texture, u_albedo3_sampler, u_terrain.u_hasAlbedo3,
                      u_terrain.u_color3, u_normal3_texture, u_normal3_sampler,
                      u_terrain.u_hasNormal3, u_terrain.u_metallic3, u_terrain.u_roughness3, tbn);

    out.albedo = (l0.albedo + l1.albedo + l2.albedo + l3.albedo) / sum;
    out.metallic = (l0.metallic + l1.metallic + l2.metallic + l3.metallic) / sum;
    out.roughness = (l0.roughness + l1.roughness + l2.roughness + l3.roughness) / sum;
    out.normal = normalize(l0.normal + l1.normal + l2.normal + l3.normal);
    return out;
}
