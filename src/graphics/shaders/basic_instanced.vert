#version 300 es

in vec3 a_position;
in vec2 a_texCoord;
in mat4 a_model_array;

out vec2 fragTexCoord;

uniform mat4 u_view;
uniform mat4 u_projection;

const int MAX_INSTANCES = 1000;

struct InstanceData {
    mat4 model;
};

uniform InstanceData u_instances[MAX_INSTANCES];


void main() {
    fragTexCoord = a_texCoord;

    mat4 model = u_instances[gl_InstanceID].model;

    gl_Position = u_projection * u_view * model * vec4(a_position, 1.0);
}