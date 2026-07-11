#version 300 es

// Forward, unlit, INSTANCED vertex shader — pairs with materials/basic.fs. Used by the editor's
// skeleton overlay to draw many joint spheres / bone connectors in one instanced draw call. The
// per-instance model matrix comes from an instanced attribute at locations 5-8 (replacing u_model).
// Position-only base geometry (loc 0); its VAO is initialized with the single-attribute shadowMap
// shader. fragTexCoord is a constant so it links with basic.fs (which only samples when hasTexture).

layout (location = 0) in vec3 a_position;
layout (location = 5) in mat4 a_instanceModel; // occupies locations 5,6,7,8

out vec2 fragTexCoord;

uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    fragTexCoord = vec2(0.0);
    gl_Position = u_projection * u_view * a_instanceModel * vec4(a_position, 1.0);
}
