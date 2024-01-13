#version 300 es

precision mediump float;

in vec2 fragTexCoord;

uniform sampler2D u_screenTexture;

uniform float u_strength;

out vec4 outColor;

void main()
{
    float direction = fragTexCoord.x - 0.5;
    float delta = 0.25;
    float redOffset   = u_strength * (1.0 - delta);
    float greenOffset = u_strength * (1.0 - 2.0 * delta);
    float blueOffset  = u_strength * (1.0 - 3.0 * delta);

    vec3 chromColor = vec3(0.0);
    chromColor.r = texture(u_screenTexture, fragTexCoord - vec2(redOffset * direction, 0.0)).r;
    chromColor.g = texture(u_screenTexture, fragTexCoord - vec2(greenOffset * direction, 0.0)).g;
    chromColor.b = texture(u_screenTexture, fragTexCoord - vec2(blueOffset * direction, 0.0)).b;
    
    outColor = vec4(chromColor, 1.0);
}