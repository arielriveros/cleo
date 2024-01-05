#version 300 es

in vec3 a_position;
in vec2 a_texCoord;

out vec2 fragTexCoord;

void main() {
    fragTexCoord = a_texCoord;
    gl_Position = vec4(a_position, 1.0);
}