#version 300 es

// Tilemap chunk geometry. The attribute locations are explicit because a chunk's VAO is set up by
// TileMesh directly rather than through Mesh's canonical-attribute reflection, so these numbers are the
// contract between the two — see LOC_POSITION/LOC_UV/LOC_COLOR in src/graphics/tilemap/tileMesh.ts.
layout (location = 0) in vec2 a_position;
layout (location = 1) in vec2 a_texCoord;
layout (location = 2) in vec4 a_color;

out vec2 fragTexCoord;
out vec4 fragTint;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    fragTexCoord = a_texCoord;
    fragTint = a_color;
    // Tiles are flat on the XY plane; the layer's z offset and parallax shift both ride in u_model.
    gl_Position = u_projection * u_view * u_model * vec4(a_position, 0.0, 1.0);
}
