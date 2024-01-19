#version 300 es

in vec3 a_position;

out vec2 fragTexCoord;

uniform mat4 u_model;
uniform mat4 u_lightSpace;
uniform bool u_isInstanced;

struct InstanceData {
    mat4 model;
};

void main() {
    gl_Position = u_lightSpace * u_model * vec4(a_position, 1.0);
}