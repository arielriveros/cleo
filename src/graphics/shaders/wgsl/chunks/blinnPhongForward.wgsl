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
};
@group(1) @binding(1) var<uniform> u_material: BlinnPhongMaterial;

struct BlinnPhongLighting {
    u_view: mat4x4<f32>,        // only to get the view-space depth that selects a cascade
    u_dirLight: DirectionalLight,
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,
    u_viewPos: vec3<f32>,
    u_numPointLights: i32,
    u_numSpotlights: i32,
    u_useEnvMap: i32,
    u_envMapLinear: i32,        // env cube is linear HDR (a light probe) -> skip the sRGB decode
};
@group(1) @binding(3) var<uniform> u_lighting: BlinnPhongLighting;

// Per-light functions return direct diffuse + specular only. Ambient is applied once in the entry point
// (a single term), not accumulated per light — otherwise ambient scales with the light count.

fn computeDirectionalLight(fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>,
                           light: DirectionalLight,
                           materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    let diff = max(dot(normal, -light.direction), 0.0);
    let diffuse = light.diffuse * diff * materialDiffuse;

    let halfwayDir = normalize(-light.direction + viewDir);
    let spec = pow(max(dot(normal, halfwayDir), 0.0), u_material.shininess);
    let specular = light.specular * spec * materialSpecular;

    let viewDepth = -(u_lighting.u_view * vec4<f32>(fragPos, 1.0)).z;
    let shadow = directionalShadow(fragPos, normal, viewDepth);

    return (1.0 - shadow) * (diffuse + specular);
}

fn computePointLight(fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>, light: PointLight,
                     materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    let lightDir = normalize(light.position - fragPos);
    let diff = max(dot(normal, lightDir), 0.0);
    let diffuse = light.diffuse * diff * materialDiffuse;

    let halfwayDir = normalize(lightDir + viewDir);
    let spec = pow(max(dot(normal, halfwayDir), 0.0), u_material.shininess);
    let specular = light.specular * spec * materialSpecular;

    let dist = length(light.position - fragPos);
    let attenuation = 1.0 / (light.constant + light.linear * dist + light.quadratic * (dist * dist));

    return (diffuse + specular) * attenuation;
}

fn computeSpotlight(index: i32, fragPos: vec3<f32>, normal: vec3<f32>, viewDir: vec3<f32>,
                    light: SpotLight,
                    materialDiffuse: vec3<f32>, materialSpecular: vec3<f32>) -> vec3<f32> {
    let lightDir = normalize(light.position - fragPos);
    let diff = max(dot(normal, lightDir), 0.0);
    let diffuse = light.diffuse * diff * materialDiffuse;

    let halfwayDir = normalize(lightDir + viewDir);
    let spec = pow(max(dot(normal, halfwayDir), 0.0), u_material.shininess);
    let specular = light.specular * spec * materialSpecular;

    let dist = length(light.position - fragPos);
    let attenuation = 1.0 / (light.constant + light.linear * dist + light.quadratic * (dist * dist));

    let theta = dot(lightDir, normalize(-light.direction));
    // cutOff/outerCutOff are COSINES of the half-angles (see Renderer's spot upload), so the inner one
    // is the LARGER value and the falloff denominator is inner - outer.
    let epsilon = light.cutOff - light.outerCutOff;
    let intensity = clamp((theta - light.outerCutOff) / epsilon, 0.0, 1.0);

    let shadow = spotShadowFor(index, fragPos, normal, light.position);
    return (diffuse + specular) * attenuation * intensity * (1.0 - shadow);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;

    let fragPos = in.fragPos;
    let tbn = tbnOf(in);

    if (u_material.hasMaskMap != 0) {
        let mask = textureSample(u_material_maskMap_texture, u_material_maskMap_sampler, in.uv).r;
        if (mask < 0.5) { discard; }
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

    // Single ambient term (from the directional light's ambient); zeroed when there is no dir light.
    var result = u_lighting.u_dirLight.ambient * matAmbient;

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
                                         in.uv).rgb) * u_material.emissive * 1.25;
    } else {
        result += u_material.emissive * 1.25;
    }

    return vec4<f32>(result, u_material.opacity);
}
