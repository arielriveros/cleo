#version 300 es

precision mediump float;

uniform vec3 u_diffuse;
uniform vec3 u_ambient;
uniform vec3 u_specular;
uniform float u_shininess;

out vec4 outColor;

void main() {
    outColor = vec4(1.-u_diffuse + u_ambient + u_specular, u_shininess);
}