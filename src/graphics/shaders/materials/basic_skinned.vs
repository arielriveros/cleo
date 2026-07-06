#version 300 es

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec2 a_texCoord;
layout (location = 2) in ivec4 a_boneIds;    // Joint indices (up to 4 bones per vertex)
layout (location = 3) in vec4 a_weights;     // Joint weights (up to 4 weights per vertex)

out vec2 fragTexCoord;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

const int MAX_BONES = 100;
const int MAX_BONE_INFLUENCE = 4;
uniform mat4 u_boneMatrices[MAX_BONES];

void main() {
    // Calculate skinned position
    vec4 totalPosition = vec4(0.0);
    
    for(int i = 0; i < MAX_BONE_INFLUENCE; i++) {
        if(a_boneIds[i] == -1) 
            continue;
        if(a_boneIds[i] >= MAX_BONES) 
            continue;
        
        vec4 localPosition = u_boneMatrices[a_boneIds[i]] * vec4(a_position, 1.0);
        totalPosition += localPosition * a_weights[i];
    }
    
    // If no bone influences were applied, use original position
    if(totalPosition == vec4(0.0)) {
        totalPosition = vec4(a_position, 1.0);
    }
    
    fragTexCoord = a_texCoord;
    gl_Position = u_projection * u_view * u_model * totalPosition;
}
