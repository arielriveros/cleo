#version 300 es

precision mediump float;
#include "../screen/tonemap.glsl";

in vec3 fragTexCoord;

uniform samplerCube u_skybox;
// The scene buffer is linear HDR. A user-supplied cubemap is sRGB-authored and must be decoded to
// linear; the baked SkyAtmosphere cubemap is already linear HDR and must pass through untouched.
uniform bool u_linearInput;

layout(location = 0) out vec4 fragColor;

void main()
{
    vec3 c = texture(u_skybox, fragTexCoord).rgb;
    if (!u_linearInput) c = toLinear(c); // sRGB user cubemap -> linear
    // Bloom mask (alpha): the baked SkyAtmosphere (u_linearInput) feeds bloom so its sun/sky glow blooms;
    // a plain user cubemap is treated as flat background and stays out of the bloom pass.
    fragColor = vec4(c, u_linearInput ? 1.0 : 0.0);
}