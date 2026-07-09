#version 300 es

// Renders a unit cube from its center for the IBL convolution passes. The interpolated local
// position is used by the fragment shaders as the per-fragment sample direction.
in vec3 a_position;

out vec3 localPos;

uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    localPos = a_position;
    gl_Position = u_projection * u_view * vec4(a_position, 1.0);
}
