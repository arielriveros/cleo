#version 300 es

precision mediump float;
#include "../screen/tonemap.glsl";

uniform sampler2D u_tileset;

in vec2 fragTexCoord;
in vec4 fragTint;

layout(location = 0) out vec4 fragColor;

void main() {
    vec4 texel = texture(u_tileset, fragTexCoord);
    // Tile art is overwhelmingly cut-out rather than blended, and the tilemap pass draws with depth
    // writes off; discarding fully transparent texels keeps a transparent tile from tinting whatever
    // was already in the buffer with its (usually black) unused pixels.
    if (texel.a < 0.004) discard;

    // Both the texture and the authored tint are sRGB; this shader writes into the linear-HDR scene
    // buffer and is tonemapped once at the final present, like every other surface.
    fragColor = vec4(toLinear(texel.rgb) * toLinear(fragTint.rgb), texel.a * fragTint.a);
}
