#version 300 es

precision mediump float;

in vec2 fragTexCoord;

uniform sampler2D u_buffer1;      // scene (linear HDR)
uniform sampler2D u_buffer2;      // blurred bloom (linear HDR)
uniform float u_bloomIntensity;   // how strongly bloom is added back

out vec4 outColor;

void main()
{
    vec3 scene = texture(u_buffer1, fragTexCoord).rgb;
    vec3 bloom = texture(u_buffer2, fragTexCoord).rgb;
    outColor = vec4(scene + bloom * u_bloomIntensity, 1.0);
}