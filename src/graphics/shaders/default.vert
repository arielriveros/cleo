#version 300 es

in vec2 a_position;

uniform mat4 u_model;

void main() {
    gl_Position = u_model * vec4(a_position, 0, 1);
}