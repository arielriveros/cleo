#version 300 es

precision mediump float;

in vec2 fragTexCoord;

uniform sampler2D u_buffer1;
uniform sampler2D u_buffer2;

out vec4 outColor;

void main()
{
    vec3 color1 = texture(u_buffer1, fragTexCoord).rgb;      
    vec3 color2 = texture(u_buffer2, fragTexCoord).rgb;
    outColor = vec4(color1 + color2, 1.0);
}