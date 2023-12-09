#version 300 es

precision mediump float;

// Material
uniform struct Material {
    vec3 diffuse;
    bool hasTexture;
    sampler2D texture;

    vec3 ambient;
    vec3 specular;
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

    // diffuse
    float diff = max(dot(normal, -light.direction), 0.0f);
    vec3 diffuse = light.diffuse * (diff * u_material.diffuse);

    // specular blinn phong
    vec3 halfwayDir = normalize(-light.direction + viewDir);
    float spec = pow(max(dot(normal, halfwayDir), 0.0f), u_material.shininess);
    vec3 specular = light.specular * (spec * u_material.specular);

    return (ambient + diffuse + specular);
}

in vec3 fragPos;
in vec3 fragNormal;
in vec2 fragTexCoord;

out vec4 outColor;

void main() {
    vec3 normal = normalize(fragNormal);
    vec3 viewDir = normalize(u_viewPos - fragPos);

    vec3 result = vec3(0.0);

    vec3 texel;

    if (u_material.hasTexture) {
        texel = texture(u_material.texture, fragTexCoord).rgb;
    } else {
        texel = vec3(1.0);
    }
    result += computeDirectionalLight(normal, viewDir, u_dirLight) * texel;

    outColor = vec4(result, 1.0f);
}