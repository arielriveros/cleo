#version 300 es

precision highp float;

// Editor-only: blit ONE layer of the cascade depth array to the screen.
//
// It cannot go through debugView.fs like every other channel: that shader takes a single sampler2D
// and the cascades live in a TEXTURE_2D_ARRAY. Its depth mode is also wrong for them — `pow(r, 40)`
// is tuned for a perspective depth buffer, and a cascade's orthographic depth is linear in view
// space, so the same curve renders it almost entirely black.
//
// A plain (non-comparison) sampler: this reads the stored depth, it does not test against it.

in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;

uniform highp sampler2DArray u_shadowCascades;
uniform int u_layer;

void main() {
    float d = texture(u_shadowCascades, vec3(fragTexCoord, float(u_layer))).r;
    // Stretch the contrast around the occupied range. An empty (cleared) cascade reads 1.0 -> white,
    // which is a useful signal in itself: it means nothing rasterized into that layer.
    fragColor = vec4(vec3(pow(d, 4.0)), 1.0);
}
