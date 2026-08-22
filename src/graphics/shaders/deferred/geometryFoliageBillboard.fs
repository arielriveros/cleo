#version 300 es

precision highp float;
#include "../screen/tonemap.glsl";

// Deferred geometry pass for instanced billboard foliage (grass). Alpha-tests the layer texture and
// writes an up-facing, matte surface into the PBR G-buffer. Paired with deferred/geometry_instanced.vs.

in vec3 fragPos;
in vec2 fragTexCoord;
in vec3 fragTangent;
in vec3 fragBitangent;
in vec3 fragNormal;

// Reassembled from the three varyings at the top of main(), which is where it has to happen: GLSL ES
// 300 forbids initialising a global from a varying, and TBN is read from inside helper functions as
// well as from main, so it cannot just be a local.
mat3 TBN;

layout(location = 0) out vec4 gAlbedoMetallic;
layout(location = 1) out vec4 gNormalRoughness;
layout(location = 2) out vec4 gEmissiveAO;

uniform sampler2D u_texture;

void main() {
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    vec4 c = texture(u_texture, fragTexCoord);
    if (c.a < 0.5) discard; // alpha cutout so blades read as cutouts, not quads
    gAlbedoMetallic  = vec4(toLinear(c.rgb), 0.0); // sRGB -> linear
    gNormalRoughness = vec4(0.0, 1.0, 0.0, 0.9); // up normal keeps grass evenly lit
    gEmissiveAO      = vec4(0.0, 0.0, 0.0, 1.0);
}
