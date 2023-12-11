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
} u_material;

// Lighting
uniform vec3 u_viewPos;

// Directional
uniform struct DirectionalLight {
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
} u_dirLight;

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

out vec4 outColor;

void main() {
    vec3 normal = normalize(fragNormal);
    vec3 viewDir = normalize(u_viewPos - fragPos);

    vec3 result = vec3(0.0);

    result += computeDirectionalLight(normal, viewDir, u_dirLight);

    outColor = vec4(result, 1.0f);
}