#version 300 es

precision highp float;

// One level of the bloom downsample pyramid — the 13-tap "dual filter" from Jorge Jimenez's
// SIGGRAPH 2014 Call of Duty presentation.
//
// WHY 13 TAPS AND NOT A BOX: halving resolution with a plain bilinear box aliases badly on
// high-contrast HDR highlights, and the aliasing then *pulses* as the camera moves because a
// sub-pixel highlight jumps between source texels frame to frame. The overlapping 4-square pattern
// below is a wide, well-behaved kernel that kills that flicker for the cost of a few more fetches at
// a quarter of the pixels.
//
// The Karis average (weighting each 2x2 group by 1/(1+luma) before summing) is applied on the FIRST
// level only: it is what stops a single very bright pixel from dominating the whole mip chain, but it
// is non-energy-conserving, so applying it at every level would visibly dim the bloom.

uniform sampler2D u_srcTexture;
uniform vec2 u_srcTexelSize;   // 1 / source resolution
uniform bool u_karisAverage;   // true only for the first downsample (see above)
uniform vec2 u_dstResolution;  // size of this target, in texels

in vec2 fragTexCoord;
out vec4 outColor;

/**
 * UV of the exact centre of the 2x2 source block this destination texel stands for.
 *
 * Sampling at `fragTexCoord` instead looks right but is only correct when the source is EXACTLY twice
 * the destination. Viewport sizes are arbitrary, and the pyramid halves with floor(), so any odd
 * dimension gives src = 2*dst + 1: the naive mapping then drifts by (j + 0.5) / dst source texels,
 * reaching a full texel by the far edge. That drift beats against the source grid — sample points
 * land alternately on texel centres (bilinear returns one texel, aliased) and on texel boundaries
 * (bilinear averages two) — which reads as vertical/horizontal banding that worsens toward the right
 * and bottom of the frame, with dark lines wherever a bright column is skipped entirely.
 *
 * Snapping to (2j + 1) source texels removes the drift completely and makes the bilinear fetch an
 * exact 2x2 box, at any parity. The last source column/row of an odd dimension is dropped rather than
 * smeared across the whole image, which is the right trade.
 */
vec2 sourceBlockUV(vec2 uv, vec2 dstResolution, vec2 srcTexelSize) {
    return (floor(uv * dstResolution) * 2.0 + 1.0) * srcTexelSize;
}

float karisWeight(vec3 c) {
    // Weight by inverse luma so bright outliers cannot dominate the average.
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return 1.0 / (1.0 + luma);
}

void main() {
    float x = u_srcTexelSize.x;
    float y = u_srcTexelSize.y;
    // Centre the kernel on the 2x2 source block this texel stands for, not on the raw UV — see
    // sourceBlockUV. The 13 taps below are placed in SOURCE texels around that centre, which is only
    // meaningful if the centre itself is on the source grid.
    vec2 uv = sourceBlockUV(fragTexCoord, u_dstResolution, u_srcTexelSize);

    // Outer ring (corners), at +/- 2 texels.
    vec3 a = texture(u_srcTexture, vec2(uv.x - 2.0 * x, uv.y + 2.0 * y)).rgb;
    vec3 b = texture(u_srcTexture, vec2(uv.x,           uv.y + 2.0 * y)).rgb;
    vec3 c = texture(u_srcTexture, vec2(uv.x + 2.0 * x, uv.y + 2.0 * y)).rgb;

    vec3 d = texture(u_srcTexture, vec2(uv.x - 2.0 * x, uv.y)).rgb;
    vec3 e = texture(u_srcTexture, vec2(uv.x,           uv.y)).rgb;
    vec3 f = texture(u_srcTexture, vec2(uv.x + 2.0 * x, uv.y)).rgb;

    vec3 g = texture(u_srcTexture, vec2(uv.x - 2.0 * x, uv.y - 2.0 * y)).rgb;
    vec3 h = texture(u_srcTexture, vec2(uv.x,           uv.y - 2.0 * y)).rgb;
    vec3 i = texture(u_srcTexture, vec2(uv.x + 2.0 * x, uv.y - 2.0 * y)).rgb;

    // Inner 2x2 square, at +/- 1 texel.
    vec3 j = texture(u_srcTexture, vec2(uv.x - x, uv.y + y)).rgb;
    vec3 k = texture(u_srcTexture, vec2(uv.x + x, uv.y + y)).rgb;
    vec3 l = texture(u_srcTexture, vec2(uv.x - x, uv.y - y)).rgb;
    vec3 m = texture(u_srcTexture, vec2(uv.x + x, uv.y - y)).rgb;

    vec3 result;
    if (u_karisAverage) {
        // Five overlapping 2x2 groups, each averaged with its own inverse-luma weight.
        vec3 g0 = (a + b + d + e) * 0.25;
        vec3 g1 = (b + c + e + f) * 0.25;
        vec3 g2 = (d + e + g + h) * 0.25;
        vec3 g3 = (e + f + h + i) * 0.25;
        vec3 g4 = (j + k + l + m) * 0.25;
        float w0 = karisWeight(g0), w1 = karisWeight(g1), w2 = karisWeight(g2);
        float w3 = karisWeight(g3), w4 = karisWeight(g4);
        // The centre group carries half the weight, matching the unweighted kernel below.
        float wSum = w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5;
        result = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125
                + g3 * w3 * 0.125 + g4 * w4 * 0.5) / max(wSum, 1e-5);
    } else {
        result  = e * 0.125;
        result += (a + c + g + i) * 0.03125;
        result += (b + d + f + h) * 0.0625;
        result += (j + k + l + m) * 0.125;
    }

    outColor = vec4(max(result, 0.0), 1.0);
}
