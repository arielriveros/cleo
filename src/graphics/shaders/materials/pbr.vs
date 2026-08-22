#version 300 es

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_normal;
layout (location = 2) in vec2 a_texCoord;
layout (location = 3) in vec3 a_tangent;
layout (location = 4) in vec3 a_bitangent; 

out vec3 fragPos;
out vec2 fragTexCoord;
// The TBN basis travels as three vectors rather than as `out mat3 TBN`. A matrix is not a valid
// shader interface type outside GLSL ES — WGSL rejects one as NotIOShareableType — so this is the
// form both backends can carry. The fragment stage reassembles it into the same `TBN` it always had.
out vec3 fragTangent;
out vec3 fragBitangent;
out vec3 fragNormal;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    fragPos = vec3(u_model * vec4(a_position, 1.0));
    fragTexCoord = a_texCoord;

    vec3 T = normalize(vec3(u_model * vec4(a_tangent,   0.0)));
    vec3 N = normalize(vec3(u_model * vec4(a_normal,    0.0)));
    vec3 B = normalize(vec3(u_model * vec4(-a_bitangent, 0.0)));
    fragTangent = T;
    fragBitangent = B;
    fragNormal = N;
    
    gl_Position = u_projection * u_view * u_model * vec4(a_position, 1.0);
}
