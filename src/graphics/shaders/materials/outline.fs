#version 300 es
precision highp float;

in vec3 v_normal;
in vec2 v_texCoord;

uniform vec3 u_outlineColor;

out vec4 fragColor;

void main() {
    // Selection-mask shader: fill the selected silhouette with a flat color (white when building
    // the outline mask). The screen-space outline pass turns this silhouette into a border.
    fragColor = vec4(u_outlineColor, 1.0);
}
