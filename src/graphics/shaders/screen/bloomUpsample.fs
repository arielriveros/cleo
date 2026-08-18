#version 300 es

precision highp float;

// One level of the bloom upsample pyramid: a 3x3 tent filter, additively blended onto the next
// larger mip (the renderer enables GL_ONE/GL_ONE around this pass rather than reading the
// destination, so no extra sampler or ping-pong buffer is needed).
//
// The filter radius is in *destination* texels, not a fixed UV offset, so the bloom's apparent
// spread stays constant across resolutions instead of shrinking as the window grows.

uniform sampler2D u_srcTexture;
uniform float u_filterRadius;

in vec2 fragTexCoord;
out vec4 outColor;

void main() {
    float x = u_filterRadius;
    float y = u_filterRadius;
    vec2 uv = fragTexCoord;

    vec3 a = texture(u_srcTexture, vec2(uv.x - x, uv.y + y)).rgb;
    vec3 b = texture(u_srcTexture, vec2(uv.x,     uv.y + y)).rgb;
    vec3 c = texture(u_srcTexture, vec2(uv.x + x, uv.y + y)).rgb;

    vec3 d = texture(u_srcTexture, vec2(uv.x - x, uv.y)).rgb;
    vec3 e = texture(u_srcTexture, vec2(uv.x,     uv.y)).rgb;
    vec3 f = texture(u_srcTexture, vec2(uv.x + x, uv.y)).rgb;

    vec3 g = texture(u_srcTexture, vec2(uv.x - x, uv.y - y)).rgb;
    vec3 h = texture(u_srcTexture, vec2(uv.x,     uv.y - y)).rgb;
    vec3 i = texture(u_srcTexture, vec2(uv.x + x, uv.y - y)).rgb;

    // 3x3 tent: 1 2 1 / 2 4 2 / 1 2 1, normalised by 16.
    vec3 result  = e * 4.0;
    result += (b + d + f + h) * 2.0;
    result += (a + c + g + i);
    result *= 1.0 / 16.0;

    outColor = vec4(result, 1.0);
}
