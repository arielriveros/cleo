#version 300 es

in vec3 a_position;
in vec3 a_normal;
in vec2 a_texCoord;

out vec3 fragPos;
out vec3 fragNormal;
out vec2 fragTexCoord;
out vec4 fragPosLightSpace;

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
    fragNormal = mat3(transpose(inverse(model))) * a_normal;
    fragTexCoord = a_texCoord;
    fragPosLightSpace = u_lightSpace * vec4(fragPos, 1.0f);
    
    gl_Position = u_projection * u_view * model * vec4(a_position, 1.0f);
}