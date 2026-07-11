#version 300 es

// Skinned depth-only shader for the shadow pass. Mirrors shadowMap.vs but applies linear-blend
// skinning so a skinned mesh casts its ANIMATED-pose shadow instead of its static bind pose.
// Uses the same explicit attribute locations as default_skinned.vs so it can draw the mesh's
// existing animated VAO with no re-initialization.

layout (location = 0) in vec3 a_position;
layout (location = 5) in ivec4 a_boneIds;   // Joint indices (up to 4 bones per vertex)
layout (location = 6) in vec4 a_weights;    // Joint weights (up to 4 weights per vertex)

uniform mat4 u_model;
uniform mat4 u_lightSpace;

const int MAX_BONES = 100;
const int MAX_BONE_INFLUENCE = 4;
uniform mat4 u_boneMatrices[MAX_BONES];

void main() {
    vec4 totalPosition = vec4(0.0);

    for (int i = 0; i < MAX_BONE_INFLUENCE; i++) {
        if (a_boneIds[i] == -1)
            continue;
        if (a_boneIds[i] >= MAX_BONES)
            continue;

        vec4 localPosition = u_boneMatrices[a_boneIds[i]] * vec4(a_position, 1.0);
        totalPosition += localPosition * a_weights[i];
    }

    // If no bone influences were applied, fall back to the raw bind-pose position.
    if (totalPosition == vec4(0.0)) {
        totalPosition = vec4(a_position, 1.0);
    }

    gl_Position = u_lightSpace * u_model * totalPosition;
}
