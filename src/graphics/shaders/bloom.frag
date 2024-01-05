#version 300 es

precision mediump float;

in vec2 fragTexCoord;

uniform sampler2D u_sceneTexture;
uniform sampler2D u_blurTexture;

out vec4 outColor;

void main()
{
    const float gamma = 2.2;
    vec3 color = texture(u_sceneTexture, fragTexCoord).rgb;      
    vec3 bloomColor = texture(u_blurTexture, fragTexCoord).rgb;
    color += bloomColor; // additive blending
    outColor = vec4(color, 1.0);
}