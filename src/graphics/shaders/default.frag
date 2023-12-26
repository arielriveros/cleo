#version 300 es

precision mediump float;

in vec3 fragPos;
in vec3 fragNormal;
in vec2 fragTexCoord;

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
} u_material;

// Lighting
uniform vec3 u_viewPos;
const int MAX_POINT_LIGHTS = 4;
uniform int u_numPointLights;

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

    return (ambient + diffuse + specular);
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

out vec4 outColor;

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

    outColor = vec4(result, 1.0f);
}