#version 300 es

in vec3 a_position;
in vec2 a_texCoord;

out vec2 fragTexCoord;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    fragTexCoord = a_texCoord;

    gl_Position = u_projection * u_view * u_model * vec4(a_position, 1.0);
}