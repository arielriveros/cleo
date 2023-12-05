#version 300 es

precision mediump float;

uniform struct Material {
    float time;
} u_material;

out vec4 outColor;

void main() {
    float red = sin(u_material.time * 2.) / 2. + 0.5;
    float green = cos(u_material.time * 3.) / 2. + 0.5;
    float blue = cos(u_material.time*5.) / 2. + sin(u_material.time*7.) / 2. + 0.5;
    outColor = vec4(red, green, blue, 1.0);
}