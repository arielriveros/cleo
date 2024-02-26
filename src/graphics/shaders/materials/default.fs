#version 300 es

#include "../constants.glsl";
precision mediump float;

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
    bool hasSpecularMap;
    sampler2D specularMap;
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
    bool hasReflectivityMap;
    sampler2D reflectivityMap;
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

vec3 computeDirectionalLight(vec3 normal, vec3 viewDir, DirectionalLight light, vec3 materialAmbient, vec3 materialDiffuse, vec3 materialSpecular) {

    //ambient
    vec3 ambient = light.ambient * materialAmbient;

    // diffuse
    float diff = max(dot(normal, -light.direction), 0.0f);
    vec3 diffuse = light.diffuse * diff * materialDiffuse;

    // specular blinn phong
    vec3 halfwayDir = normalize(-light.direction + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * spec * materialSpecular;

    // calculate shadow
    float shadow = shadowCalculation(fragPosLightSpace);

    return (ambient + (1.0 - shadow) * (diffuse + specular));
}

vec3 computePointLight(vec3 normal, vec3 viewDir, PointLight light, vec3 materialAmbient, vec3 materialDiffuse, vec3 materialSpecular) {
    // ambient
    vec3 ambient = light.ambient * materialAmbient;

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

    ambient *= attenuation;
    diffuse *= attenuation;
    specular *= attenuation;

    return (ambient + diffuse + specular);
}

vec3 computeSpotlight(vec3 normal, vec3 viewDir, SpotLight light, vec3 materialAmbient, vec3 materialDiffuse, vec3 materialSpecular) {
    // ambient
    vec3 ambient = light.ambient * materialAmbient;

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

    ambient *= attenuation;
    diffuse *= attenuation;
    specular *= attenuation;

    // spotlight
    float theta = dot(lightDir, normalize(-light.direction));
    float epsilon = light.outerCutOff - light.cutOff;
    float intensity = clamp((theta - light.outerCutOff) / epsilon, 0.0, 1.0);
    diffuse *= intensity;
    specular *= intensity;

    return (ambient + diffuse + specular);
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
    vec3 result = vec3(0.0);

    vec3 ambient = u_material.ambient;
    if (u_material.hasBaseTexture)
        ambient *= vec3(texture(u_material.baseTexture, fragTexCoord));

    vec3 diffuse = u_material.diffuse;
    if (u_material.hasBaseTexture)
        diffuse *= vec3(texture(u_material.baseTexture, fragTexCoord));

    vec3 specular = u_material.specular;
    if (u_material.hasSpecularMap)
        specular *=  vec3(texture(u_material.specularMap, fragTexCoord));


    result += computeDirectionalLight(normal, viewDir, u_dirLight, ambient, diffuse, specular);

    for (int i = 0; i < u_numPointLights; i++) {
        result += computePointLight(normal, viewDir, u_pointLights[i], ambient, diffuse, specular);
    }

    for (int i = 0; i < u_numSpotlights; i++) {
        result += computeSpotlight(normal, viewDir, u_spotlights[i], ambient, diffuse, specular);
    }

    if (u_useEnvMap) {
        vec3 I = normalize(fragPos - u_viewPos);
        vec3 R = reflect(I, normal);
        vec3 reflection = vec3(texture(u_envMap, R)) * specular;
        float reflectivity = u_material.reflectivity;
        if (u_material.hasReflectivityMap)
            reflectivity = texture(u_material.reflectivityMap, fragTexCoord).b; // b channel if using roughmetal workflow

        result = mix(result, reflection, reflectivity / 2.0);
    }

    if (u_material.hasEmissiveMap)
        result += vec3(texture(u_material.emissiveMap, fragTexCoord)) * u_material.emissive * 1.25;

    else
        result += u_material.emissive * 1.25;

    float alpha = u_material.opacity;
    fragColor = vec4(result, alpha);
}