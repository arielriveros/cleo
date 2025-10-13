#version 300 es

in vec3 a_position;
in vec2 a_texCoord;

out vec2 fragTexCoord;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;

// UV transform for sprite sheets
uniform vec2 u_uvOffset; // default (0,0)
uniform vec2 u_uvScale;  // default (1,1)

void main() {
    // Apply UV transform: scale then offset
    fragTexCoord = a_texCoord * u_uvScale + u_uvOffset;

    gl_Position = u_projection * u_view * u_model * vec4(a_position, 1.0);
}