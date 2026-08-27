// Forward PBR (metallic-roughness) shading, shared by the plain and skinned programs.
//
// Computes the same Cook-Torrance result as deferredLighting.wgsl from the same light structures — the
// difference is only where the surface comes from: interpolated varyings here, a G-buffer fetch there.
// Both pull the BRDF and the light types from chunks/pbrLighting.wgsl so the two paths cannot drift
// into subtly different specular.
//
// Uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl: whichever vertex chunk the
// program included already brought them in, and a second definition is a compile error.

const MAX_POINT_LIGHTS: i32 = 16;
const MAX_SPOTLIGHTS: i32 = 8;

// Samplers are separate globals named `u_material_<field>`, not members of the material struct: WGSL
// has no opaque types in a struct, and no legal identifier generates a dotted GLSL name.
@group(0) @binding(0) var u_material_baseColorTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseColorTexture_sampler: sampler;
@group(0) @binding(2) var u_material_ormTexture_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_ormTexture_sampler: sampler;
@group(0) @binding(4) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_normalMap_sampler: sampler;
@group(0) @binding(6) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(8) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(9) var u_envMap_sampler: sampler;
@group(0) @binding(10) var u_material_displacementMap_texture: texture_2d<f32>;
@group(0) @binding(11) var u_material_displacementMap_sampler: sampler;
@group(0) @binding(12) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(13) var u_material_maskMap_sampler: sampler;

struct PBRMaterial {
    baseColor: vec3<f32>,       // fallback if no baseColorTexture
    emissiveFactor: vec3<f32>,
    metallic: f32,              // fallback if the ORM texture has no metallic channel
    roughness: f32,
    opacity: f32,
    /**
     * glTF alphaMode MASK. Below this base-colour alpha the fragment is discarded; 0 disables it.
     *
     * Placed after `opacity` rather than appended: the block's offsets are derived at runtime by both
     * back ends (WebGPU reflects it, WebGL2 asks the driver), so where it sits is free — but it has to
     * exist in BOTH this chunk and its forward/deferred twin, or the two paths shade differently and
     * nothing says so.
     */
    alphaCutoff: f32,
    // Every flag is an i32: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
    hasBaseColorTexture: i32,
    // Occlusion, roughness and metallic are authored as separate maps and combined into ONE texture by
    // systems/texturePacker.ts before they get here (glTF layout: r=AO, g=roughness, b=metallic). Each
    // flag says whether its channel was actually authored; the others fall back to the scalars above.
    hasMetallicMap: i32,
    hasRoughnessMap: i32,
    hasOcclusionMap: i32,
    hasNormalMap: i32,
    hasEmissiveMap: i32,
    /**
     * A dedicated cutout mask, tested against `alphaCutoff` above.
     *
     * Takes PRECEDENCE over the base-colour alpha when present. That ordering is what keeps every
     * existing glTF import rendering identically: `alphaMode: MASK` sets `alphaCutoff` and no mask
     * texture, so it still falls through to the base-colour alpha exactly as before. A mask is what
     * an FBX/OBJ opacity map (aiTextureType_OPACITY) and a hand-authored cutout supply, neither of
     * which has anywhere to live in a base colour's alpha.
     *
     * RED channel, not alpha — see the note on the same member in chunks/basicGBuffer.wgsl.
     */
    hasMaskMap: i32,
    /**
     * Parallax occlusion mapping. `dispScale` is the depth of the height field in UV units; the flag
     * says whether a displacement map was authored.
     *
     * The height field gets its OWN sampler rather than riding in the normal map's alpha the way
     * terrain's does. Terrain packs because it had to - four layers put it at 13 bound units, and
     * folding height into an unused alpha bought it back down to 9. A standard material has units to
     * spare (5 was freed when metallic/roughness/occlusion were packed into one ORM map), and the
     * packed alternative would mean renaming the normal sampler in all four material chunks, routing
     * blinn-phong through the packer as well, and teaching TexturePacker to hold more than one pack
     * per material. A texture unit is the cheaper thing to spend.
     *
     * These two must exist in BOTH this chunk and its forward/deferred twin, or the two paths shade
     * differently and nothing says so. (The camera/sun members below are deferred-only, because the
     * forward twin already has both in its lighting block — those are plumbing, not authored state.)
     */
    dispScale: f32,
    hasDisplacementMap: i32,
};
@group(1) @binding(1) var<uniform> u_material: PBRMaterial;

struct ForwardLighting {
    u_view: mat4x4<f32>,        // only to get the view-space depth that selects a cascade
    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,
    u_viewPos: vec3<f32>,
    u_numPointLights: i32,
    u_numSpotlights: i32,
    u_useEnvMap: i32,
    u_envMapLinear: i32,        // env cube is linear HDR (a light probe) -> skip the sRGB decode
    u_isTransparent: i32,       // set by the renderer from material.config.transparent
};
@group(1) @binding(3) var<uniform> u_lighting: ForwardLighting;

/** The shading normal, flipped for a BACK face — see chunks/pbrGBuffer.wgsl. */
fn getNormal(in: VertexOutput, front: bool, uv: vec2<f32>, ddx: vec2<f32>, ddy: vec2<f32>) -> vec3<f32> {
    // The ORIGINAL tbn, not the parallax frame - this is a normal-map decode, and its bitangent sign
    // is the engine-wide green-channel convention. See chunks/parallax.wgsl.
    let tbn = tbnOf(in);
    var N = tbn[2];
    if (u_material.hasNormalMap != 0) {
        // Explicit gradients from the UN-offset uv; see the twin in chunks/pbrGBuffer.wgsl.
        var n = textureSampleGrad(u_material_normalMap_texture, u_material_normalMap_sampler,
                                  uv, ddx, ddy).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(tbn * n);
    }
    if (!front) { N = -N; }
    return N;
}

@fragment
// See chunks/pbrGBuffer.wgsl for why this is a separate parameter and not a VertexOutput member.
fn fs_main(in: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;

    let fragPos = in.fragPos;

    // Gradients and the parallax frame, in UNIFORM control flow - above the discard and every
    // per-fragment branch below. See the twin in chunks/pbrGBuffer.wgsl for why that matters.
    let ddx = dpdx(in.uv);
    let ddy = dpdy(in.uv);
    let nRaw = normalize(tbnOf(in)[2]);
    let toEye = normalize(u_lighting.u_viewPos - fragPos);
    let frame = parallaxFrame(fragPos, ddx, ddy, nRaw, toEye);

    var uv = in.uv;
    var selfShadow = 1.0;
    if (u_material.hasDisplacementMap != 0) {
        let dims = vec2<f32>(textureDimensions(u_material_displacementMap_texture, 0));
        let fade = parallaxFade(ddx, ddy, dims);
        let vTan = parallaxToTangent(frame, toEye);
        let hit = parallaxOcclusion(u_material_displacementMap_texture,
                                    u_material_displacementMap_sampler,
                                    in.uv, ddx, ddy, vTan, u_material.dispScale, fade);
        uv = hit.xy;
        // The sun comes from the light list this pass already shades with, not from u_transform, so
        // the two can never disagree about where it is.
        let sunDir = u_lighting.u_dirLight.direction;
        if (dot(sunDir, sunDir) > 1e-6) {
            let lTan = parallaxToTangent(frame, normalize(-sunDir));
            selfShadow = parallaxShadow(u_material_displacementMap_texture,
                                        u_material_displacementMap_sampler,
                                        uv, ddx, ddy, lTan, hit.z, u_material.dispScale, fade);
        }
    }

    // Base colour / albedo. Every fetch from here down reads the parallax-offset uv - all of them, or
    // the maps come apart.
    // The mask cutout, before the base-colour fetch: a discarded fragment writes no G-buffer at all.
    // Explicit gradients from the UN-offset uv, like every other fetch below.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = textureSampleGrad(u_material_maskMap_texture, u_material_maskMap_sampler,
                                     uv, ddx, ddy).r;
        if (mask < u_material.alphaCutoff) { discard; }
    }

    var albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture != 0) {
        let texel = textureSampleGrad(u_material_baseColorTexture_texture,
                                      u_material_baseColorTexture_sampler, uv, ddx, ddy);
        // See chunks/pbrGBuffer.wgsl — the same cutout, applied before the lighting work below.
        // Only when there is no mask texture — that one has already been tested above.
        if (u_material.hasMaskMap == 0 && u_material.alphaCutoff > 0.0
            && texel.a < u_material.alphaCutoff) { discard; }
        albedo *= toLinear(texel.rgb);
    }

    // One fetch for all three surface scalars. This used to be two — a metallic/roughness sample and an
    // occlusion sample further down — on textures that are now the same texture.
    var metallic = u_material.metallic;
    var roughness = u_material.roughness;
    var ao = 1.0;
    if (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0) {
        let orm = textureSampleGrad(u_material_ormTexture_texture, u_material_ormTexture_sampler,
                                    uv, ddx, ddy).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    let N = getNormal(in, front, uv, ddx, ddy);
    let V = normalize(u_lighting.u_viewPos - fragPos);

    // Ambient (IBL approximation).
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    let kS = F;

    // Simple ambient fill floor (zeroed when there is no directional light).
    var ambient = (u_lighting.u_dirLight.ambient
                   + skyIrradiance(u_lighting.u_skyLight, N)) * albedo;
    if (u_lighting.u_useEnvMap != 0) {
        let R = reflect(normalize(fragPos - u_lighting.u_viewPos), N);
        let envC = textureSample(u_envMap_texture, u_envMap_sampler, R).rgb;
        var env = toLinear(envC);
        if (u_lighting.u_envMapLinear != 0) { env = envC; }
        // Strong roughness falloff so only smooth surfaces reflect the env map; kS keeps it
        // metallic-aware. Matches deferredLighting for forward/deferred parity.
        let specAtten = pow(1.0 - roughness, 4.0);
        ambient += env * kS * specAtten;
    }

    var Lo = vec3<f32>(0.0);

    // Directional light (guard against an unset/zero direction -> normalize(0) = NaN).
    let dirD = u_lighting.u_dirLight.direction;
    if (dot(dirD, dirD) > 1e-6) {
        let viewDepth = -(u_lighting.u_view * vec4<f32>(fragPos, 1.0)).z;
        let shadow = directionalShadow(fragPos, N, viewDepth);
        let Ld = normalize(-dirD);
        // Two shadow terms, and they are different things: `shadow` is the cascade map, which is what
        // the rest of the scene casts onto this fragment; `selfShadow` is the height field occluding
        // itself, which the cascade map is far too coarse to resolve. Both attenuate the SUN's
        // radiance, which is where a self-shadow belongs. The deferred twin cannot do this - it has no
        // light list - and folds selfShadow into albedo instead; see chunks/pbrGBuffer.wgsl.
        Lo += accumulateLight(N, V, albedo, metallic, roughness, Ld,
                              u_lighting.u_dirLight.diffuse * (1.0 - shadow) * selfShadow);
    }

    for (var i = 0; i < u_lighting.u_numPointLights; i++) {
        let p = u_lighting.u_pointLights[i];
        let L = normalize(p.position - fragPos);
        let dist = length(p.position - fragPos);
        let att = 1.0 / (p.constant + p.linear * dist + p.quadratic * dist * dist);
        Lo += accumulateLight(N, V, albedo, metallic, roughness, L, p.diffuse * att);
    }

    for (var i = 0; i < u_lighting.u_numSpotlights; i++) {
        let sl = u_lighting.u_spotlights[i];
        let L = normalize(sl.position - fragPos);
        let dist = length(sl.position - fragPos);
        let att = 1.0 / (sl.constant + sl.linear * dist + sl.quadratic * dist * dist);
        let theta = dot(L, normalize(-sl.direction));
        // cutOff/outerCutOff are COSINES of the half-angles (see Renderer's spot upload), so the inner
        // one is the LARGER value and the falloff denominator is inner - outer.
        let epsilon = sl.cutOff - sl.outerCutOff;
        let intensity = clamp((theta - sl.outerCutOff) / epsilon, 0.0, 1.0);
        let spotSh = spotShadowFor(i, fragPos, N, sl.position);
        Lo += accumulateLight(N, V, albedo, metallic, roughness, L,
                              sl.diffuse * att * intensity * (1.0 - spotSh));
    }

    // Occlusion came out of the ORM fetch above.
    var color = ambient * ao + Lo;

    // Emission (sRGB-decoded map). Output stays LINEAR HDR — tonemap and gamma happen at the present.
    if (u_material.hasEmissiveMap != 0) {
        color += toLinear(textureSampleGrad(u_material_emissiveMap_texture,
                                            u_material_emissiveMap_sampler,
                                            uv, ddx, ddy).rgb) * u_material.emissiveFactor;
    } else {
        color += u_material.emissiveFactor;
    }

    var alpha = 1.0;
    if (u_lighting.u_isTransparent != 0) { alpha = u_material.opacity; }
    return vec4<f32>(color, alpha);
}
