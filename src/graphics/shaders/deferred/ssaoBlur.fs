#version 300 es
precision highp float;

// 4x4 box blur of the raw SSAO buffer, to remove the tiled pattern the 4x4 rotation noise leaves
// behind. The kernel size is not arbitrary: it must match the noise tile, or the pattern survives.
//
// Implemented as FOUR bilinear taps rather than sixteen point taps. A tap placed exactly halfway
// between two texel centres returns their average for free in the texture unit, so one tap at the
// centre of a 2x2 block returns that block's mean, and four of them cover the 4x4 footprint. The
// result is arithmetically identical to the sixteen-tap loop this replaces — same texels, same
// weights — for a quarter of the fetches.
//
// The footprint spans texels -2..+1 around the centre, so it sits half a texel up-left. That is
// inherent to an even-sized kernel (there is no symmetric 4-wide integer window) and is preserved
// here deliberately: it matches what the sixteen-tap version did, so this change alters cost without
// altering the image.

in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;

uniform sampler2D u_ssao;

void main() {
    vec2 texelSize = 1.0 / vec2(textureSize(u_ssao, 0));

    // Block centres: the pair {-2,-1} has its midpoint at -1.5, the pair {0,+1} at +0.5.
    vec2 lo = fragTexCoord + vec2(-1.5, -1.5) * texelSize;
    vec2 hi = fragTexCoord + vec2( 0.5,  0.5) * texelSize;

    float result = texture(u_ssao, vec2(lo.x, lo.y)).r
                 + texture(u_ssao, vec2(hi.x, lo.y)).r
                 + texture(u_ssao, vec2(lo.x, hi.y)).r
                 + texture(u_ssao, vec2(hi.x, hi.y)).r;

    fragColor = vec4(result * 0.25);
}
