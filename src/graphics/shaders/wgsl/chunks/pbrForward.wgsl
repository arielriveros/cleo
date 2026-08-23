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

struct PBRMaterial {
    baseColor: vec3<f32>,       // fallback if no baseColorTexture
    emissiveFactor: vec3<f32>,
    metallic: f32,              // fallback if the ORM texture has no metallic channel
    roughness: f32,
    opacity: f32,
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
};
@group(2) @binding(0) var<uniform> u_material: PBRMaterial;

struct ForwardLighting {
    u_view: mat4x4<f32>,        // only to get the view-space depth that selects a cascade
    u_dirLight: DirectionalLight,
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,
    u_viewPos: vec3<f32>,
    u_numPointLights: i32,
    u_numSpotlights: i32,
    u_useEnvMap: i32,
    u_envMapLinear: i32,        // env cube is linear HDR (a light probe) -> skip the sRGB decode
    u_isTransparent: i32,       // set by the renderer from material.config.transparent
};
@group(5) @binding(0) var<uniform> u_lighting: ForwardLighting;

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
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;

    let fragPos = in.fragPos;

    // Base colour / albedo.
    var albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture != 0) {
        let tex = toLinear(textureSample(u_material_baseColorTexture_texture,
                                         u_material_baseColorTexture_sampler, in.uv).rgb);
        albedo *= tex;
    }

    // One fetch for all three surface scalars. This used to be two — a metallic/roughness sample and an
    // occlusion sample further down — on textures that are now the same texture.
    var metallic = u_material.metallic;
    var roughness = u_material.roughness;
    var ao = 1.0;
    if (u_material.hasMetallicMap != 0 || u_material.hasRoughnessMap != 0 || u_material.hasOcclusionMap != 0) {
        let orm = textureSample(u_material_ormTexture_texture, u_material_ormTexture_sampler, in.uv).rgb;
        if (u_material.hasOcclusionMap != 0) { ao = orm.r; }
        if (u_material.hasRoughnessMap != 0) { roughness = orm.g; }
        if (u_material.hasMetallicMap != 0) { metallic = orm.b; }
    }

    let N = getNormal(in);
    let V = normalize(u_lighting.u_viewPos - fragPos);

    // Ambient (IBL approximation).
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    let kS = F;

    // Simple ambient fill floor (zeroed when there is no directional light).
    var ambient = u_lighting.u_dirLight.ambient * albedo;
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
        Lo += accumulateLight(N, V, albedo, metallic, roughness, Ld,
                              u_lighting.u_dirLight.diffuse * (1.0 - shadow));
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
        color += toLinear(textureSample(u_material_emissiveMap_texture, u_material_emissiveMap_sampler,
                                        in.uv).rgb) * u_material.emissiveFactor;
    } else {
        color += u_material.emissiveFactor;
    }

    var alpha = 1.0;
    if (u_lighting.u_isTransparent != 0) { alpha = u_material.opacity; }
    return vec4<f32>(color, alpha);
}
