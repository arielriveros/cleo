#version 300 es

precision mediump float;

in vec3 fragTexCoord;

uniform samplerCube u_skybox;

layout(location = 0) out vec4 fragColor;

void main()
{    
    fragColor = texture(u_skybox, fragTexCoord);
}