#version 300 es

// Instanced geometry-pass vertex shader for pbr/default materials (14-float vertex layout).
// The per-instance model matrix comes from an instanced vertex attribute at locations 5-8,
// replacing the u_model uniform. Outputs match materials/pbr.vs so the geometry fragment
// shaders (geometryPBR.fs / geometryDefault.fs) can be reused unchanged.

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_normal;
layout (location = 2) in vec2 a_texCoord;
layout (location = 3) in vec3 a_tangent;
layout (location = 4) in vec3 a_bitangent;
layout (location = 5) in mat4 a_instanceModel; // occupies locations 5,6,7,8

out vec3 fragPos;
out vec2 fragTexCoord;
// The TBN basis travels as three vectors rather than as `out mat3 TBN`. A matrix is not a valid
// shader interface type outside GLSL ES — WGSL rejects one as NotIOShareableType — so this is the
// form both backends can carry. The fragment stage reassembles it into the same `TBN` it always had.
out vec3 fragTangent;
out vec3 fragBitangent;
out vec3 fragNormal;

uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    mat4 model = a_instanceModel;
    fragPos = vec3(model * vec4(a_position, 1.0));
    fragTexCoord = a_texCoord;

    vec3 T = normalize(vec3(model * vec4(a_tangent,   0.0)));
    vec3 N = normalize(vec3(model * vec4(a_normal,    0.0)));
    vec3 B = normalize(vec3(model * vec4(-a_bitangent, 0.0)));
    fragTangent = T;
    fragBitangent = B;
    fragNormal = N;

    gl_Position = u_projection * u_view * model * vec4(a_position, 1.0);
}
