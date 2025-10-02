#version 300 es
precision highp float;

in vec3 v_normal;
in vec2 v_texCoord;

uniform vec3 u_outlineColor;
uniform float u_outlineWidth;

out vec4 fragColor;

void main() {
    // Simple outline shader - just output the outline color
    fragColor = vec4(u_outlineColor, 1.0);
}
