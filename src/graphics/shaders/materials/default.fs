#version 300 es

#include "../constants.glsl";
precision mediump float;
#include "../screen/tonemap.glsl";

in vec3 fragPos;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace;
in mat3 TBN;

// Material
uniform struct Material {
    vec3 diffuse;
    bool hasBaseTexture;
    sampler2D baseTexture;

    vec3 ambient;
    vec3 specular;
    // Specular colour (rgb) and reflectivity (a) are authored as two maps and combined into ONE texture
    // by systems/texturePacker.ts before they get here. Each flag says whether its part was authored;
    // the others fall back to the scalars.
    bool hasSpecularMap;
    bool hasReflectivityMap;
    sampler2D specularReflectivityMap;
    float shininess;
    
    vec3 emissive;
    bool hasEmissiveMap;
    sampler2D emissiveMap;

    bool hasNormalMap;
    sampler2D normalMap;

    bool hasMaskMap;
    sampler2D maskMap;

    float opacity;

    float reflectivity;
} u_material;

// Lighting
uniform vec3 u_viewPos;

uniform int u_numPointLights;
uniform int u_numSpotlights;
uniform sampler2D u_shadowMap;

// Directional
uniform struct DirectionalLight {
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
} u_dirLight;

// Point
struct PointLight {
    vec3 position;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
};

// Spot
struct SpotLight {
    vec3 position;
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
    float cutOff;
    float outerCutOff;
};

// Environment
uniform bool u_useEnvMap;
uniform samplerCube u_envMap;
uniform bool u_envMapLinear; // env cube is linear HDR (a light probe) -> skip the sRGB decode

uniform PointLight u_pointLights[MAX_POINT_LIGHTS];
uniform SpotLight u_spotlights[MAX_SPOTLIGHTS];

float shadowCalculation(vec4 fragPosLS) {
    vec3 projCoords = fragPosLS.xyz / fragPosLS.w;
    projCoords = projCoords * 0.5 + 0.5;
    if (projCoords.x > 1.0 || projCoords.y > 1.0 || projCoords.x < 0.0 || projCoords.y < 0.0 || projCoords.z > 1.0)
        return 0.0;

    float closestDepth = texture(u_shadowMap, projCoords.xy).r; 
    float currentDepth = projCoords.z;
    float bias = 0.001;
    float shadow = 0.0;

    // pcf
    float offset = (1.0 / float(textureSize(u_shadowMap, 0).x)) / 2.0;
    for(int x = -1; x <= 1; ++x) {
        for(int y = -1; y <= 1; ++y) {
            float pcfDepth = texture(u_shadowMap, projCoords.xy + vec2(x, y) * offset).r; 
            shadow += currentDepth - bias > pcfDepth ? 1.0 : 0.0;        
        }    
    }
    shadow /= 9.0;

    return shadow;
}

// Per-light functions return direct diffuse + specular only. Ambient is applied once in main()
// (a single term), not accumulated per light — otherwise ambient scales with the light count.
vec3 computeDirectionalLight(vec3 normal, vec3 viewDir, DirectionalLight light, vec3 materialDiffuse, vec3 materialSpecular) {
    // diffuse
    float diff = max(dot(normal, -light.direction), 0.0f);
    vec3 diffuse = light.diffuse * diff * materialDiffuse;

    // specular blinn phong
    vec3 halfwayDir = normalize(-light.direction + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * spec * materialSpecular;

    // calculate shadow
    float shadow = shadowCalculation(fragPosLightSpace);

    return (1.0 - shadow) * (diffuse + specular);
}

vec3 computePointLight(vec3 normal, vec3 viewDir, PointLight light, vec3 materialDiffuse, vec3 materialSpecular) {
    // diffuse
    vec3 lightDir = normalize(light.position - fragPos);
    float diff = max(dot(normal, lightDir), 0.0f);
    vec3 diffuse = light.diffuse * diff * materialDiffuse;

    // specular blinn phong
    vec3 halfwayDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * spec * materialSpecular;

    // attenuation
    float distance = length(light.position - fragPos);
    float attenuation = 1.0f / (light.constant + light.linear * distance + light.quadratic * (distance * distance));

    return (diffuse + specular) * attenuation;
}

vec3 computeSpotlight(vec3 normal, vec3 viewDir, SpotLight light, vec3 materialDiffuse, vec3 materialSpecular) {
    // diffuse
    vec3 lightDir = normalize(light.position - fragPos);
    float diff = max(dot(normal, lightDir), 0.0f);
    vec3 diffuse = light.diffuse * diff * materialDiffuse;

    // specular blinn phong
    vec3 halfwayDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * spec * materialSpecular;

    // attenuation
    float distance = length(light.position - fragPos);
    float attenuation = 1.0f / (light.constant + light.linear * distance + light.quadratic * (distance * distance));

    // spotlight
    float theta = dot(lightDir, normalize(-light.direction));
    float epsilon = light.outerCutOff - light.cutOff;
    float intensity = clamp((theta - light.outerCutOff) / epsilon, 0.0, 1.0);

    return (diffuse + specular) * attenuation * intensity;
}

layout(location = 0) out vec4 fragColor;

void main() {
    if (u_material.hasMaskMap) {
        float mask = texture(u_material.maskMap, fragTexCoord).r;
        if (mask < 0.5) discard;
    }

    vec3 normal = TBN[2];
    vec3 viewDir = normalize(u_viewPos - fragPos);

    if (u_material.hasNormalMap) {
        normal = texture(u_material.normalMap, fragTexCoord).rgb;
        normal = normalize(normal * 2.0 - 1.0);  
        normal = normalize(TBN * normal);
    }
    // Decode the sRGB base colour once to linear; reuse it for both diffuse and ambient tints.
    vec3 baseTex = vec3(1.0);
    if (u_material.hasBaseTexture)
        baseTex = toLinear(texture(u_material.baseTexture, fragTexCoord).rgb);

    vec3 matAmbient  = u_material.ambient * baseTex;
    vec3 matDiffuse  = u_material.diffuse * baseTex;

    // One fetch for both: specular tint in rgb (still sRGB — the pack is a raw byte copy), reflectivity
    // in alpha. Hoisted out of the env-map branch below so the two maps that are now one texture are
    // also one sample.
    vec3 matSpecular = u_material.specular;
    float reflectivity = u_material.reflectivity;
    if (u_material.hasSpecularMap || u_material.hasReflectivityMap) {
        vec4 specRefl = texture(u_material.specularReflectivityMap, fragTexCoord);
        if (u_material.hasSpecularMap) matSpecular *= toLinear(specRefl.rgb);
        if (u_material.hasReflectivityMap) reflectivity = specRefl.a;
    }

    // Single ambient term (from the directional light's ambient); zeroed when there is no dir light.
    vec3 result = u_dirLight.ambient * matAmbient;

    result += computeDirectionalLight(normal, viewDir, u_dirLight, matDiffuse, matSpecular);

    for (int i = 0; i < u_numPointLights; i++) {
        result += computePointLight(normal, viewDir, u_pointLights[i], matDiffuse, matSpecular);
    }

    for (int i = 0; i < u_numSpotlights; i++) {
        result += computeSpotlight(normal, viewDir, u_spotlights[i], matDiffuse, matSpecular);
    }

    if (u_useEnvMap) {
        vec3 I = normalize(fragPos - u_viewPos);
        vec3 R = reflect(I, normal);
        vec3 envC = vec3(texture(u_envMap, R));
        vec3 reflection = (u_envMapLinear ? envC : toLinear(envC)) * matSpecular;
        result = mix(result, reflection, reflectivity / 2.0);
    }

    // Emissive (sRGB-decoded map). Output stays LINEAR HDR — tonemap/gamma happen at the final present.
    if (u_material.hasEmissiveMap)
        result += toLinear(texture(u_material.emissiveMap, fragTexCoord).rgb) * u_material.emissive * 1.25;
    else
        result += u_material.emissive * 1.25;

    float alpha = u_material.opacity;
    fragColor = vec4(result, alpha);
}