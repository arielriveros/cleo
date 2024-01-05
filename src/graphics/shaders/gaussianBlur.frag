#version 300 es

precision mediump float;

in vec2 fragTexCoord;

uniform sampler2D u_screenTexture;
  
uniform bool u_horizontal;

float WEIGHTS[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);

out vec4 outColor;

void main()
{             
    float tex_offset_x = 1.0 / float(textureSize(u_screenTexture, 0).x);
    float tex_offset_y = 1.0 / float(textureSize(u_screenTexture, 0).y);

    vec3 result = texture(u_screenTexture, fragTexCoord).rgb * WEIGHTS[0]; // current fragment's contribution
    if(u_horizontal)
    {
        for(int i = 1; i < 5; ++i)
        {
            result += texture(u_screenTexture, fragTexCoord + vec2(tex_offset_x * float(i), 0.0)).rgb * WEIGHTS[i];
            result += texture(u_screenTexture, fragTexCoord - vec2(tex_offset_x * float(i), 0.0)).rgb * WEIGHTS[i];
        }
    }
    else
    {
        for(int i = 1; i < 5; ++i)
        {
            result += texture(u_screenTexture, fragTexCoord + vec2(0.0, tex_offset_y * float(i))).rgb * WEIGHTS[i];
            result += texture(u_screenTexture, fragTexCoord - vec2(0.0, tex_offset_y * float(i))).rgb * WEIGHTS[i];
        }
    }
    outColor = vec4(result, 1.0);
}