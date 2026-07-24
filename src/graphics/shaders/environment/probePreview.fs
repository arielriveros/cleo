#version 300 es

precision highp float;
#include "../screen/tonemap.glsl";

// Equirectangular (lat/long) unwrap of a probe's captured cubemap for the editor preview thumbnail.
// The screen quad supplies fragTexCoord in [0,1]; we map it to a spherical direction, sample the cube,
// then tonemap the linear HDR capture down to a displayable sRGB image.

in vec2 fragTexCoord;

uniform samplerCube u_cube;
uniform float u_exposure;

layout(location = 0) out vec4 fragColor;

const float PI = 3.14159265359;

void main()
{
    // u -> longitude [-PI, PI], v -> latitude [-PI/2, PI/2] (v=0 bottom, v=1 top).
    float lon = (fragTexCoord.x - 0.5) * 2.0 * PI;
    float lat = (fragTexCoord.y - 0.5) * PI;
    float cosLat = cos(lat);
    vec3 dir = vec3(cosLat * sin(lon), sin(lat), -cosLat * cos(lon));

    vec3 hdr = texture(u_cube, normalize(dir)).rgb;
    fragColor = vec4(tonemap(hdr, u_exposure), 1.0);
}
