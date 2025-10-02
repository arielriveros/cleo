#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_normal;
in vec2 a_texCoord;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

out vec3 v_normal;
out vec2 v_texCoord;

void main() {
    gl_Position = u_projection * u_view * u_model * vec4(a_position, 1.0);
    v_normal = mat3(u_model) * a_normal;
    v_texCoord = a_texCoord;
}
