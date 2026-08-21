#version 300 es

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_normal;
layout (location = 2) in vec2 a_texCoord;
layout (location = 3) in vec3 a_tangent;
layout (location = 4) in vec3 a_bitangent;
layout (location = 5) in ivec4 a_boneIds;    // Joint indices (up to 4 bones per vertex)
layout (location = 6) in vec4 a_weights;     // Joint weights (up to 4 weights per vertex)

out vec3 fragPos;
out vec2 fragTexCoord;
out mat3 TBN;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

const int MAX_BONES = 100;
const int MAX_BONE_INFLUENCE = 4;
uniform mat4 u_boneMatrices[MAX_BONES];

void main() {
    // Calculate skinned position
    vec4 totalPosition = vec4(0.0);
    vec3 totalNormal = vec3(0.0);
    vec3 totalTangent = vec3(0.0);
    vec3 totalBitangent = vec3(0.0);
    
    for(int i = 0; i < MAX_BONE_INFLUENCE; i++) {
        if(a_boneIds[i] == -1) 
            continue;
        if(a_boneIds[i] >= MAX_BONES) 
            continue;
        
        vec4 localPosition = u_boneMatrices[a_boneIds[i]] * vec4(a_position, 1.0);
        totalPosition += localPosition * a_weights[i];
        
        vec3 localNormal = mat3(u_boneMatrices[a_boneIds[i]]) * a_normal;
        totalNormal += localNormal * a_weights[i];
        
        vec3 localTangent = mat3(u_boneMatrices[a_boneIds[i]]) * a_tangent;
        totalTangent += localTangent * a_weights[i];
        
        vec3 localBitangent = mat3(u_boneMatrices[a_boneIds[i]]) * a_bitangent;
        totalBitangent += localBitangent * a_weights[i];
    }
    
    // If no bone influences were applied, use original attributes
    if(totalPosition == vec4(0.0)) {
        totalPosition = vec4(a_position, 1.0);
        totalNormal = a_normal;
        totalTangent = a_tangent;
        totalBitangent = a_bitangent;
    }
    
    fragPos = vec3(u_model * totalPosition);
    fragTexCoord = a_texCoord;

    vec3 T = normalize(vec3(u_model * vec4(totalTangent, 0.0)));
    vec3 N = normalize(vec3(u_model * vec4(totalNormal, 0.0)));
    vec3 B = normalize(vec3(u_model * vec4(-totalBitangent, 0.0)));
    TBN = mat3(T, B, N);
    
    gl_Position = u_projection * u_view * u_model * totalPosition;
}
