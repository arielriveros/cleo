#version 300 es

precision mediump float;

in vec3 fragPos;
in vec3 fragNormal;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace;

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

    float opacity;
} u_material;

// Lighting
uniform vec3 u_viewPos;
const int MAX_POINT_LIGHTS = 32;
uniform int u_numPointLights;
uniform sampler2D u_shadowMap;

// Directional
uniform struct DirectionalLight {
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
} u_dirLight;

struct PointLight {
    vec3 position;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
};

uniform PointLight u_pointLights[MAX_POINT_LIGHTS];

float shadowCalculation(vec4 fragPosLS) {
    vec3 projCoords = fragPosLS.xyz / fragPosLS.w;
    projCoords = projCoords * 0.5 + 0.5;
    if (projCoords.x > 1.0 || projCoords.y > 1.0 || projCoords.x < 0.0 || projCoords.y < 0.0 || projCoords.z > 1.0)
        return 0.0;

    float closestDepth = texture(u_shadowMap, projCoords.xy).r; 
    float currentDepth = projCoords.z;
    //float bias = max(0.05 * (1.0 - dot(fragNormal, -u_dirLight.direction)), 0.005);
    float bias = 0.0025;
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

vec3 computeDirectionalLight(vec3 normal, vec3 viewDir, DirectionalLight light) {
    //ambient
    vec3 ambient = light.ambient * u_material.ambient;
    if (u_material.hasBaseTexture)
        ambient *= vec3(texture(u_material.baseTexture, fragTexCoord));

    // diffuse
    float diff = max(dot(normal, -light.direction), 0.0f);
    vec3 diffuse = light.diffuse * diff * u_material.diffuse;
    if (u_material.hasBaseTexture)
        diffuse *= vec3(texture(u_material.baseTexture, fragTexCoord));

    // specular blinn phong
    vec3 halfwayDir = normalize(-light.direction + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * spec * u_material.specular;

    if (u_material.hasSpecularMap)
        specular *=  vec3(texture(u_material.specularMap, fragTexCoord));

    // calculate shadow
    float shadow = shadowCalculation(fragPosLightSpace);       

    return (ambient + (1.0 - shadow) * (diffuse + specular));
}

vec3 computePointLight(vec3 normal, vec3 viewDir, PointLight light) {
    // ambient
    vec3 ambient = light.ambient * u_material.ambient;
    if (u_material.hasBaseTexture)
        ambient *= vec3(texture(u_material.baseTexture, fragTexCoord));

    // diffuse
    vec3 lightDir = normalize(light.position - fragPos);
    float diff = max(dot(normal, lightDir), 0.0f);
    vec3 diffuse = light.diffuse * diff * u_material.diffuse;
    if (u_material.hasBaseTexture)
        diffuse *= vec3(texture(u_material.baseTexture, fragTexCoord));

    // specular blinn phong
    vec3 halfwayDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * spec * u_material.specular;

    if (u_material.hasSpecularMap)
        specular *=  vec3(texture(u_material.specularMap, fragTexCoord));

    // attenuation
    float distance = length(light.position - fragPos);
    float attenuation = 1.0f / (light.constant + light.linear * distance + light.quadratic * (distance * distance));

    ambient *= attenuation;
    diffuse *= attenuation;
    specular *= attenuation;

    return (ambient + diffuse + specular);
}

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 brightColor;

void main() {
    vec3 normal = normalize(fragNormal);
    vec3 viewDir = normalize(u_viewPos - fragPos);

    vec3 result = vec3(0.0);

    result += computeDirectionalLight(normal, viewDir, u_dirLight);

    for (int i = 0; i < u_numPointLights; i++) {
        result += computePointLight(normal, viewDir, u_pointLights[i]);
    }

    if (u_material.hasEmissiveMap)
        result += vec3(texture(u_material.emissiveMap, fragTexCoord)) * u_material.emissive;

    else
        result += u_material.emissive;

    float alpha = u_material.opacity;

    float brightness = dot(result.rgb, vec3(0.2126, 0.7152, 0.0722));
    fragColor = vec4(result, alpha);
    
    if (brightness > 1.2) {
        brightColor = vec4(result, 1.0);
    } else {
        brightColor = vec4(0.0, 0.0, 0.0, 1.0);
    }
}