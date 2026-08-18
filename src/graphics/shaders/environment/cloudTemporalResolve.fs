#version 300 es

precision highp float;

// Temporal resolve for the volumetric clouds (Guerrilla/Horizon-style Bayer-subset reprojection).
//
// The trace pass only raymarched 1/16 of this buffer's pixels this frame — the subset selected by
// u_bayerIndex. This pass reconstructs the full image:
//
//   * a pixel IN this frame's subset takes its freshly traced sample directly;
//   * every other pixel reprojects last frame's result through the previous view-projection and
//     takes that instead, clamped to the range of the new samples around it.
//
// The clamp is what makes the whole scheme viable. Reprojection only accounts for CAMERA motion, but
// clouds also drift under wind and evolve over time, so history is always somewhat stale. Bounding
// it to the local min/max of freshly traced neighbours turns unbounded smearing into a bounded,
// slightly soft edge. Without it, a moving camera over animated clouds ghosts badly.

uniform sampler2D u_trace;      // this frame's new samples, 1/4 resolution per axis
uniform sampler2D u_history;    // last frame's resolved result, full cloud resolution
uniform sampler2D u_gDepth;     // scene depth, to reject reprojection onto moved geometry

uniform mat4  u_invViewProj;    // this frame's clip -> world
uniform mat4  u_prevViewProj;   // last frame's world -> clip
uniform vec3  u_viewPos;

uniform vec2  u_resolution;      // cloud-resolution target size, in pixels
// Actual size of the trace buffer. Passed rather than derived as u_resolution*0.25: the renderer
// sizes it with ceil(w/4), so for any width that is not a multiple of 4 the derived value is wrong
// and every sample lands fractionally off its block.
uniform vec2  u_traceResolution;
uniform int   u_bayerIndex;     // which of the 16 sub-positions was traced this frame
uniform bool  u_historyValid;   // false on the first frame / after a cut: ignore history entirely
uniform float u_slabMid;        // world-space altitude of the cloud slab's midpoint

in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;

// The 4x4 Bayer ordering, as (x, y) offsets. Sequential frames land far apart in the block, so the
// reconstructed image converges evenly instead of sweeping a visible band across each block.
const int BAYER_16[16] = int[16](
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5
);

ivec2 bayerOffset(int frame) {
    // Find the cell whose Bayer rank equals this frame's cursor.
    for (int i = 0; i < 16; i++) {
        if (BAYER_16[i] == frame) return ivec2(i % 4, i / 4);
    }
    return ivec2(0, 0);
}

void main() {
    ivec2 pixel = ivec2(fragTexCoord * u_resolution);
    ivec2 block = pixel / 4;          // which 4x4 block this pixel belongs to
    ivec2 sub   = pixel - block * 4;  // its position inside that block

    ivec2 traceSub = bayerOffset(u_bayerIndex);

    // The trace buffer holds exactly one sample per block, at the sub-position traced this frame.
    vec2 traceUV = (vec2(block) + 0.5) / u_traceResolution;
    vec4 traced = texture(u_trace, traceUV);

    // This pixel was traced this frame: nothing to reconstruct.
    if (sub == traceSub) { fragColor = traced; return; }

    // Fallback for every path below that cannot use history (first frame, camera cut, disocclusion,
    // off-screen reprojection). Sampling the trace buffer at this pixel's OWN position rather than at
    // its block centre lets the LINEAR filter interpolate between neighbouring blocks — the same
    // information, but a smooth 4x upscale instead of hard 4x4 blocks. It is geometrically a little
    // off (traced samples sit at varying sub-positions), which is irrelevant for something that
    // survives a frame or two before history takes over, and very visible if you skip it.
    vec4 fallback = texture(u_trace, (fragTexCoord * u_resolution * 0.25) / u_traceResolution);

    // Neighbourhood bounds from the traced samples around this block. One sample per block means the
    // 3x3 block neighbourhood is the tightest honest bound available at this resolution.
    vec4 lo = vec4( 1e6);
    vec4 hi = vec4(-1e6);
    vec2 traceTexel = 1.0 / u_traceResolution;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec4 s = texture(u_trace, traceUV + vec2(float(x), float(y)) * traceTexel);
            lo = min(lo, s);
            hi = max(hi, s);
        }
    }

    if (!u_historyValid) { fragColor = clamp(fallback, lo, hi); return; }

    // Reproject. Clouds have no single depth, so anchor the ray at the slab midpoint: the layer is
    // thin relative to its distance, so one plane intersection is an adequate stand-in for the
    // volume, and it costs no extra buffer. Rays that never reach the slab (looking down, or with
    // geometry in front) fall back to the traced sample.
    vec2 ndc = fragTexCoord * 2.0 - 1.0;
    vec4 nW = u_invViewProj * vec4(ndc, -1.0, 1.0);
    vec4 fW = u_invViewProj * vec4(ndc,  1.0, 1.0);
    vec3 ro = nW.xyz / nW.w;
    vec3 rd = normalize(fW.xyz / fW.w - ro);

    if (abs(rd.y) < 1e-4) { fragColor = clamp(fallback, lo, hi); return; }
    float t = (u_slabMid - u_viewPos.y) / rd.y;
    if (t <= 0.0) { fragColor = clamp(fallback, lo, hi); return; }

    vec3 anchor = u_viewPos + rd * t;
    vec4 prevClip = u_prevViewProj * vec4(anchor, 1.0);
    if (prevClip.w <= 0.0) { fragColor = clamp(fallback, lo, hi); return; }
    vec2 prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Off-screen last frame: there is no history for this pixel, only the new sample.
    if (any(lessThan(prevUV, vec2(0.0))) || any(greaterThan(prevUV, vec2(1.0)))) {
        fragColor = clamp(fallback, lo, hi);
        return;
    }

    vec4 history = texture(u_history, prevUV);

    // Clamp history into the freshly observed range. Premultiplied colour and coverage are clamped
    // together so the two stay consistent — clamping them independently can produce a colour that
    // its own alpha cannot represent, which shows up as bright fringing on cloud edges.
    fragColor = clamp(history, lo, hi);
}
