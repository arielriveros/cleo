#version 300 es

precision mediump float;

uniform struct {
    vec3 color;
} u_material;

out vec4 outColor;

void main() {
    outColor = vec4(u_material.color, 1.0);
}