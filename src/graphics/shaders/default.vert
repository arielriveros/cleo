#version 300 es

in vec3 a_position;
in vec3 a_normal;
in vec2 a_texCoord;

out vec3 fragPos;
out vec3 fragNormal;
out vec2 fragTexCoord;
out vec4 fragPosLightSpace;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat4 u_lightSpace;

void main() {
    fragPos = vec3(u_model * vec4(a_position, 1.0f));
    fragNormal = mat3(transpose(inverse(u_model))) * a_normal;
    fragTexCoord = a_texCoord;
    fragPosLightSpace = u_lightSpace * vec4(fragPos, 1.0f);
    
    gl_Position = u_projection * u_view * u_model * vec4(a_position, 1.0f);
}