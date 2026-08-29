// Forward Blinn-Phong shading, shared by the plain and skinned programs.
//
// Uses the light STRUCTS from chunks/pbrLighting.wgsl (the same lights feed both material models) but
// none of its BRDF — this is the classic diffuse + Blinn-Phong specular model, not Cook-Torrance.
//
// Uses VertexOutput and tbnOf() without including chunks/modelVarying.wgsl: whichever vertex chunk the
// program included already brought them in, and a second definition is a compile error.
//
// A note the GLSL twin carries and this does not need: that file is `precision mediump float` and had
// to mark fragPos, u_view and the whole shadow library `highp` by hand, because a mediump world
// position a few hundred units out is only good to about half a unit — many shadow texels. WGSL has no
// precision qualifiers at all and naga emits `precision highp float` for the whole module, so the
// hazard cannot arise here.

const MAX_POINT_LIGHTS: i32 = 16;
const MAX_SPOTLIGHTS: i32 = 8;

@group(0) @binding(0) var u_material_baseTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_material_baseTexture_sampler: sampler;
@group(0) @binding(2) var u_material_specularReflectivityMap_texture: texture_2d<f32>;
@group(0) @binding(3) var u_material_specularReflectivityMap_sampler: sampler;
@group(0) @binding(4) var u_material_emissiveMap_texture: texture_2d<f32>;
@group(0) @binding(5) var u_material_emissiveMap_sampler: sampler;
@group(0) @binding(6) var u_material_normalMap_texture: texture_2d<f32>;
@group(0) @binding(7) var u_material_normalMap_sampler: sampler;
@group(0) @binding(8) var u_material_maskMap_texture: texture_2d<f32>;
@group(0) @binding(9) var u_material_maskMap_sampler: sampler;
@group(0) @binding(10) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(11) var u_envMap_sampler: sampler;

struct BlinnPhongMaterial {
    diffuse: vec3<f32>,
    ambient: vec3<f32>,
    specular: vec3<f32>,
    emissive: vec3<f32>,
    /** HDR headroom for the emissive colour, default 1. See chunks/pbrGBuffer.wgsl for why. */
    emissiveIntensity: f32,
    shininess: f32,
    opacity: f32,
    reflectivity: f32,
    // Every flag is an i32: WGSL forbids bool in a uniform buffer. Call sites still pass booleans.
    hasBaseTexture: i32,
    // Specular colour (rgb) and reflectivity (a) are authored as two maps and combined into ONE texture
    // by systems/texturePacker.ts before they get here. Each flag says whether its part was authored;
    // the others fall back to the scalars.
    hasSpecularMap: i32,
    hasReflectivityMap: i32,
    hasEmissiveMap: i32,
    hasNormalMap: i32,
    hasMaskMap: i32,
    /** Cutout threshold for the mask above; 0 disables it. See chunks/basicGBuffer.wgsl. */
    alphaCutoff: f32,
};
@group(1) @binding(1) var<uniform> u_material: BlinnPhongMaterial;

struct BlinnPhongLighting {
    u_view: mat4x4<f32>,        // only to get the view-space depth that selects a cascade
    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,
    u_viewPos: vec3<f32>,
    /** Scene-wide indirect fill, in internal radiance units. Replaces the per-light ambient. */
    u_sceneAmbient: vec3<f32>,
    u_numPointLights: i32,
    u_numSpotlights: i32,
    u_useEnvMap: i32,
    u_envMapLinear: i32,        // env cube is linear HDR (a light probe) -> skip the sRGB decode
};
@group(1) @binding(3) var<uniform> u_lighting: BlinnPhongLighting;

// Per-light functions return direct diffuse + specular only. Ambient is applied once in the entry point
// (a single term), not accumulated per light — otherwise ambient scales with the light count.
//
// Blinn-Phong is not energy-conserving and never was, but it takes the same PHOTOMETRIC inputs as the
// PBR path: one radiance (`color * intensity`) instead of separate `diffuse` and `specular` colours,
// and the shared windowed-inverse-square falloff instead of `1 / (c + l*d + q*d^2)`. Keeping the two
// models on one set of light parameters is the point — a light should not read as a different
// brightness because the object in front of it uses a different shading model.

fn computeDirectionalLight(fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>,
                           light: DirectionalLight,
                           materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    if (dot(light.direction, light.direction) <= 1e-6) { return vec3<f32>(0.0); }
    let radiance = light.color * light.intensity;

    let diff = max(dot(normal, -light.direction), 0.0);
    let halfwayDir = normalize(-light.direction + viewDir);
    let spec = pow(max(dot(normal, halfwayDir), 0.0), u_material.shininess);

    let viewDepth = -(u_lighting.u_view * vec4<f32>(fragPos, 1.0)).z;
    let shadow = directionalShadow(fragPos, normal, viewDepth);

    return (1.0 - shadow) * radiance * (diff * materialDiffuse + spec * materialSpecular);
}

fn computePointLight(fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>, light: PointLight,
                     materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    let toLight = light.position - fragPos;
    let d2 = dot(toLight, toLight);
    let attenuation = distanceAttenuation(d2, light.invRangeSquared);
    if (attenuation <= 0.0) { return vec3<f32>(0.0); }

    let lightDir = normalize(toLight);
    let diff = max(dot(normal, lightDir), 0.0);
    let halfwayDir = normalize(lightDir + viewDir);
    let spec = pow(max(dot(normal, halfwayDir), 0.0), u_material.shininess);

    let radiance = light.color * (light.intensity * attenuation);
    return radiance * (diff * materialDiffuse + spec * materialSpecular);
}

fn computeSpotlight(index: i32, fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>,
                    light: SpotLight,
                    materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    let toLight = light.position - fragPos;
    let d2 = dot(toLight, toLight);
    let attenuation = distanceAttenuation(d2, light.invRangeSquared);
    if (attenuation <= 0.0) { return vec3<f32>(0.0); }

    let lightDir = normalize(toLight);
    let cone = spotAttenuation(dot(lightDir, normalize(-light.direction)), light.coneScale, light.coneOffset);
    let shadow = spotShadowFor(index, fragPos, normal, light.position);

    let diff = max(dot(normal, lightDir), 0.0);
    let halfwayDir = normalize(lightDir + viewDir);
    let spec = pow(max(dot(normal, halfwayDir), 0.0), u_material.shininess);

    let radiance = light.color * (light.intensity * attenuation * cone * (1.0 - shadow));
    return radiance * (diff * materialDiffuse + spec * materialSpecular);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;

    let fragPos = in.fragPos;
    let tbn = tbnOf(in);

    // `alphaCutoff`, not the literal 0.5 this used to hardcode. The threshold is now a per-material
    // property shared with Basic and PBR. Existing content is unaffected: Material.Default defaults it
    // to 0.5 whenever a mask is present, and `parse` applies the same default to anything saved before
    // the property existed — so a project authored against the old constant reloads unchanged.
    if (u_material.hasMaskMap != 0 && u_material.alphaCutoff > 0.0) {
        let mask = textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r;
        if (mask < u_material.alphaCutoff) { discard; }
    }

    var normal = tbn[2];
    let viewDir = normalize(u_lighting.u_viewPos - fragPos);

    if (u_material.hasNormalMap != 0) {
        var n = textureSample(u_material_normalMap_texture, u_material_normalMap_sampler, in.uv).rgb;
        n = normalize(n * 2.0 - 1.0);
        normal = normalize(tbn * n);
    }

    // Decode the sRGB base colour once to linear; reuse it for both diffuse and ambient tints.
    var baseTex = vec3<f32>(1.0);
    if (u_material.hasBaseTexture != 0) {
        baseTex = toLinear(textureSample(u_material_baseTexture_texture,
                                         u_material_baseTexture_sampler, in.uv).rgb);
    }

    let matAmbient = u_material.ambient * baseTex;
    let matDiffuse = u_material.diffuse * baseTex;

    // One fetch for both: specular tint in rgb (still sRGB — the pack is a raw byte copy), reflectivity
    // in alpha. Hoisted out of the env-map branch below so the two maps that are now one texture are
    // also one sample.
    var matSpecular = u_material.specular;
    var reflectivity = u_material.reflectivity;
    if (u_material.hasSpecularMap != 0 || u_material.hasReflectivityMap != 0) {
        let specRefl = textureSample(u_material_specularReflectivityMap_texture,
                                     u_material_specularReflectivityMap_sampler, in.uv);
        if (u_material.hasSpecularMap != 0) { matSpecular *= toLinear(specRefl.rgb); }
        if (u_material.hasReflectivityMap != 0) { reflectivity = specRefl.a; }
    }

    // Single ambient term: the SCENE ambient plus its sky light, against the material's own ambient
    // tint. Zeroed when the scene sets neither.
    var result = (u_lighting.u_sceneAmbient
                  + skyIrradiance(u_lighting.u_skyLight, normal)) * matAmbient;

    result += computeDirectionalLight(fragPos, normal, viewDir, u_lighting.u_dirLight,
                                      matDiffuse, matSpecular);

    for (var i = 0; i < u_lighting.u_numPointLights; i++) {
        result += computePointLight(fragPos, normal, viewDir, u_lighting.u_pointLights[i],
                                    matDiffuse, matSpecular);
    }

    for (var i = 0; i < u_lighting.u_numSpotlights; i++) {
        result += computeSpotlight(i, fragPos, normal, viewDir, u_lighting.u_spotlights[i],
                                   matDiffuse, matSpecular);
    }

    if (u_lighting.u_useEnvMap != 0) {
        let I = normalize(fragPos - u_lighting.u_viewPos);
        let R = reflect(I, normal);
        let envC = textureSample(u_envMap_texture, u_envMap_sampler, R).rgb;
        var env = toLinear(envC);
        if (u_lighting.u_envMapLinear != 0) { env = envC; }
        let reflection = env * matSpecular;
        result = mix(result, reflection, reflectivity / 2.0);
    }

    // Emissive (sRGB-decoded map). Output stays LINEAR HDR — tonemap and gamma happen at the present.
    if (u_material.hasEmissiveMap != 0) {
        result += toLinear(textureSample(u_material_emissiveMap_texture, u_material_emissiveMap_sampler,
                                         in.uv).rgb)
                  * u_material.emissive * 1.25 * u_material.emissiveIntensity;
    } else {
        result += u_material.emissive * 1.25 * u_material.emissiveIntensity;
    }

    return vec4<f32>(result, u_material.opacity);
}
