#version 300 es

// Depth-only pass for one cascade. `u_lightSpace` is that cascade's fitted ortho matrix.
//
// The explicit location matters: _ensureOverlayMeshes builds position-only VAOs from THIS shader's
// reflected attributes and then draws them with basicInstanced, which hardcodes location 0. Without
// the qualifier that only worked because every driver so far happened to assign 0 here.
layout (location = 0) in vec3 a_position;

uniform mat4 u_model;
uniform mat4 u_lightSpace;

void main() {
    gl_Position = u_lightSpace * u_model * vec4(a_position, 1.0);
}
