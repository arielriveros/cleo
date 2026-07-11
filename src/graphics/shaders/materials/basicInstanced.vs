#version 300 es

// Forward, unlit, INSTANCED vertex shader — pairs with materials/basic.fs. Used by the editor's
// skeleton overlay to draw many joint spheres / bone connectors in one instanced draw call. The
// per-instance model matrix comes from an instanced attribute at locations 5-8 (replacing u_model).
// Declares the full 5-attribute layout (0-4) so the mesh VAO can be initialized with a standard
// non-instanced geometry shader's attributes (only a_position is actually used here).

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_normal;
layout (location = 2) in vec2 a_texCoord;
layout (location = 3) in vec3 a_tangent;
layout (location = 4) in vec3 a_bitangent;
layout (location = 5) in mat4 a_instanceModel; // occupies locations 5,6,7,8

out vec2 fragTexCoord;

uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    fragTexCoord = a_texCoord;
    gl_Position = u_projection * u_view * a_instanceModel * vec4(a_position, 1.0);
}
