#version 300 es

// Depth-only pass for instanced foliage. The per-instance world matrix arrives as a vertex attribute
// at locations 5-8 (divisor 1), replacing u_model entirely — the matrices Foliage bakes are already
// in world space.
//
// All five per-vertex attributes are declared even though only position and uv are read. Mesh's
// initializeVAO packs its interleaved offsets over ONLY the attributes a shader declares and derives
// the stride from that subset, so a depth shader declaring a narrower set would re-stride any mesh it
// was used to initialize and corrupt the colour pass. Matching geometry_instanced.vs exactly keeps
// both passes on one VAO layout.
layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_normal;
layout (location = 2) in vec2 a_texCoord;
layout (location = 3) in vec3 a_tangent;
layout (location = 4) in vec3 a_bitangent;
layout (location = 5) in mat4 a_instanceModel; // occupies locations 5,6,7,8

out vec2 fragTexCoord;

uniform mat4 u_lightSpace;

void main() {
    fragTexCoord = a_texCoord;
    gl_Position = u_lightSpace * a_instanceModel * vec4(a_position, 1.0);
}
