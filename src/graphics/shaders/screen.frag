#version 300 es

precision mediump float;

uniform sampler2D u_screenTexture;

in vec2 fragTexCoord;

out vec4 outColor;

void main() {
    outColor = texture(u_screenTexture, fragTexCoord);
}