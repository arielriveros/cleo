#version 300 es

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_normal;
layout (location = 2) in vec2 a_texCoord;
layout (location = 3) in vec3 a_tangent;
layout (location = 4) in vec3 a_bitangent; 

out vec3 fragPos;
out vec2 fragTexCoord;
out vec4 fragPosLightSpace;
out mat3 TBN;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat4 u_lightSpace;

const int MAX_INSTANCES = 1000;

struct InstanceData {
    mat4 model;
};

uniform InstanceData u_instances[MAX_INSTANCES];

void main() {
    mat4 model = u_instances[gl_InstanceID].model;

    fragPos = vec3(model * vec4(a_position, 1.0f));
    fragTexCoord = a_texCoord;
    fragPosLightSpace = u_lightSpace * vec4(fragPos, 1.0f);

    vec3 T = normalize(vec3(model * vec4(a_tangent,   0.0)));
    vec3 B = normalize(vec3(model * vec4(a_bitangent, 0.0)));
    vec3 N = normalize(vec3(model * vec4(a_normal,    0.0)));
    TBN = mat3(T, B, N);
    
    gl_Position = u_projection * u_view * model * vec4(a_position, 1.0f);
}