#version 300 es

precision highp float;

// Temporal resolve for the volumetric clouds (Guerrilla/Horizon-style Bayer-subset reprojection).
//
// The trace pass only raymarched 1/16 of this buffer's pixels this frame — the subset selected by
// u_bayerIndex. This pass reconstructs the full image:
//
//   * a pixel IN this frame's subset blends its freshly traced sample over the reprojected history;
//   * every other pixel takes last frame's result, reprojected through the previous view-projection
//     and clamped to the range of the new samples around it.
//
// Two things make the scheme viable, and both are depth-aware:
//
//   * The CLAMP. Reprojection only accounts for CAMERA motion, but clouds also drift under wind and
//     evolve over time, so history is always somewhat stale. Bounding it to the local min/max of
//     freshly traced neighbours turns unbounded smearing into a bounded, slightly soft edge. But at
//     1/16 density the 3x3 block neighbourhood spans ~24x24 screen pixels, so on a mesh silhouette
//     it would happily include full cloud coverage from nearby sky blocks and bound stale cloud to
//     itself. Neighbours are therefore only admitted when their ray reached the cloud slab if and
//     only if this pixel's did — see the gather loop.
//
//   * The OCCLUSION REJECT. A pixel with geometry nearer than the cloud slab had its ray bounded by
//     that geometry, so a history value captured when the pixel saw sky is not a valid predecessor
//     for it. Without this test cloud radiance drifts onto meshes and sits there for up to 16 frames.
//
// And the resolve BLENDS rather than replaces, so the raymarch's per-pixel ray-start dither actually
// averages out across the Bayer cycle instead of being frozen into the image as grain.

uniform sampler2D u_trace;      // this frame's new samples, 1/4 resolution per axis
uniform sampler2D u_history;    // last frame's resolved result, full cloud resolution
uniform sampler2D u_gDepth;     // scene depth, to reject reprojection onto occluded geometry

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

/**
 * How much of a freshly traced pixel's own sample it keeps, the rest coming from clamped history.
 * Below 1.0 this is what turns the scheme from pure reconstruction into accumulation: the march
 * dither converges away over the Bayer cycle instead of popping against 15 stale neighbours. Kept
 * high so a genuinely new observation still dominates within a frame or two.
 */
const float TRACE_BLEND = 0.85;

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

vec3 reconstructWorldPos(float depth, vec2 uv) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

/**
 * Clamp bounds over the traced neighbourhood, kept in UNPREMULTIPLIED form.
 *
 * They have to be. Premultiplied colour and coverage are not independent — `rgb = colour * a` — and
 * GLSL's clamp on a vec4 is per-component, so clamping a premultiplied sample against premultiplied
 * bounds can raise rgb toward hi while dropping a toward lo, leaving `rgb > a`. That is a colour its
 * own alpha cannot represent, and it composites as a bright fringe along every cloud edge: exactly
 * the artefact the clamp is there to prevent.
 */
vec3  g_colorLo, g_colorHi;
float g_alphaLo, g_alphaHi;

/** Colour of a premultiplied sample. A sample with no coverage carries no colour, only black. */
vec3 unpremultiply(vec4 s) {
    return s.a > 1e-4 ? s.rgb / s.a : vec3(0.0);
}

/** Bring a sample inside the neighbourhood bounds, re-premultiplying so the invariant survives. */
vec4 clampSample(vec4 s) {
    float a = clamp(s.a, g_alphaLo, g_alphaHi);
    vec3  c = clamp(unpremultiply(s), g_colorLo, g_colorHi);
    return vec4(c * a, a);
}

/** Distance from the camera to solid geometry at `uv`, or "infinite" where the background shows. */
float geometryDistance(float depth, vec2 uv) {
    if (depth >= 1.0) return 1e30;
    return length(reconstructWorldPos(depth, uv) - u_viewPos);
}

/**
 * The screen UV a given block's ray was actually traced at this frame.
 *
 * Must mirror volumetricClouds.fs traceUV() exactly, INCLUDING the u_traceResolution * 4.0
 * denominator. u_resolution is not u_traceResolution * 4.0 — the renderer sizes the trace buffer with
 * ceil(w/4) — so dividing by u_resolution here would fetch depth a fraction of a block away from the
 * sample it is supposed to describe, and the depth test would reject valid neighbours near edges.
 */
vec2 traceSampleUV(ivec2 blk, ivec2 subPos) {
    return (vec2(blk) * 4.0 + vec2(subPos) + 0.5) / (u_traceResolution * 4.0);
}

void main() {
    ivec2 pixel = ivec2(fragTexCoord * u_resolution);
    ivec2 block = pixel / 4;          // which 4x4 block this pixel belongs to
    ivec2 sub   = pixel - block * 4;  // its position inside that block

    ivec2 traceSub = bayerOffset(u_bayerIndex);
    bool  isTraced = (sub == traceSub);

    // The trace buffer holds exactly one sample per block, at the sub-position traced this frame.
    vec2 traceUV = (vec2(block) + 0.5) / u_traceResolution;
    vec4 traced = texture(u_trace, traceUV);

    // View ray, from the same reconstruction the raymarch uses.
    vec2 ndc = fragTexCoord * 2.0 - 1.0;
    vec4 nW = u_invViewProj * vec4(ndc, -1.0, 1.0);
    vec4 fW = u_invViewProj * vec4(ndc,  1.0, 1.0);
    vec3 ro = nW.xyz / nW.w;
    vec3 rd = normalize(fW.xyz / fW.w - ro);

    // Clouds have no single depth, so anchor the ray at the slab midpoint: the layer is thin relative
    // to its distance, so one plane intersection is an adequate stand-in for the volume, and it costs
    // no extra buffer. A ray that never reaches the slab (parallel to it, or pointing away) is treated
    // as infinitely far from it.
    float slabT = 1e30;
    if (abs(rd.y) >= 1e-4) {
        float tPlane = (u_slabMid - u_viewPos.y) / rd.y;
        if (tPlane > 0.0) slabT = tPlane;
    }

    // How far this pixel's ray got before solid geometry stopped it, read from the same depth buffer
    // the raymarch bounded its rays against.
    float sceneDist = geometryDistance(texture(u_gDepth, fragTexCoord).r, fragTexCoord);
    bool  reachesSlab = slabT < sceneDist;

    // Fallback for every path that cannot use history (first frame, camera cut, occlusion,
    // off-screen reprojection). Sampling the trace buffer at this pixel's OWN position rather than at
    // its block centre lets the LINEAR filter interpolate between neighbouring blocks — the same
    // information, but a smooth 4x upscale instead of hard 4x4 blocks. It is geometrically a little
    // off (traced samples sit at varying sub-positions), which is irrelevant for something that
    // survives a frame or two before history takes over, and very visible if you skip it.
    vec4 fallback = texture(u_trace, (fragTexCoord * u_resolution * 0.25) / u_traceResolution);

    // Neighbourhood bounds from the traced samples around this block. One sample per block means the
    // 3x3 block neighbourhood is the tightest honest bound available at this resolution — but only
    // over samples that saw the same thing, or the bound is useless exactly on the silhouettes where
    // it matters.
    //
    // "The same thing" is deliberately a REACHABILITY test rather than a depth-difference epsilon
    // like the AO upsample's. Device depth is so compressed toward 1.0 that a mesh 20m away and the
    // open sky behind it differ by a few thousandths; any epsilon loose enough to keep genuine
    // same-surface neighbours also admits the sky, which is precisely the sample that lets stale
    // cloud clamp to itself on a silhouette. Whether the ray got to the cloud layer at all is the
    // property the clamp actually cares about, and it separates the two cases exactly.
    //
    // The centre block always counts, so the bounds can never invert.
    //
    // Coverage and colour are bounded separately (see g_colorLo above), and only samples that carry
    // some coverage contribute a colour bound — a transparent neighbour would otherwise drag the
    // colour floor to black and let the clamp darken genuine cloud.
    g_alphaLo = traced.a;
    g_alphaHi = traced.a;
    bool anyColor = traced.a > 1e-4;
    g_colorLo = anyColor ? traced.rgb / traced.a : vec3(0.0);
    g_colorHi = g_colorLo;

    vec2 traceTexel = 1.0 / u_traceResolution;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            vec2 nbUV = traceSampleUV(block + ivec2(x, y), traceSub);
            // Reuse this pixel's slabT: over one block the anchor distance barely moves, and the test
            // is a threshold rather than a measurement.
            bool nbReaches = slabT < geometryDistance(texture(u_gDepth, nbUV).r, nbUV);
            if (nbReaches != reachesSlab) continue; // saw something else entirely: not a valid bound
            vec4 sN = texture(u_trace, traceUV + vec2(float(x), float(y)) * traceTexel);
            g_alphaLo = min(g_alphaLo, sN.a);
            g_alphaHi = max(g_alphaHi, sN.a);
            if (sN.a <= 1e-4) continue;
            vec3 c = sN.rgb / sN.a;
            g_colorLo = anyColor ? min(g_colorLo, c) : c;
            g_colorHi = anyColor ? max(g_colorHi, c) : c;
            anyColor = true;
        }
    }

    // The traced pixel still has its own fresh sample when history is unusable; everything else has
    // to make do with the bilinear upscale.
    vec4 noHistory = clampSample(isTraced ? traced : fallback);

    if (!u_historyValid) { fragColor = noHistory; return; }

    // Geometry is nearer than the cloud slab, or the slab is not in front of us at all: this frame's
    // ray never sampled cloud here, so last frame's value — captured when the pixel may well have
    // been looking at open sky — is not a valid predecessor. This is the test that keeps cloud from
    // staining meshes; with the bounds above, the fallback resolves against equally-occluded
    // neighbours and so collapses toward zero coverage instead of holding cloud.
    if (!reachesSlab) { fragColor = noHistory; return; }

    vec3 anchor = u_viewPos + rd * slabT;
    vec4 prevClip = u_prevViewProj * vec4(anchor, 1.0);
    if (prevClip.w <= 0.0) { fragColor = noHistory; return; }
    vec2 prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Off-screen last frame: there is no history for this pixel, only the new sample.
    if (any(lessThan(prevUV, vec2(0.0))) || any(greaterThan(prevUV, vec2(1.0)))) {
        fragColor = noHistory;
        return;
    }

    // Clamp history into the freshly observed range, in unpremultiplied space so colour and coverage
    // come back out consistent with each other (see clampSample).
    vec4 history = clampSample(texture(u_history, prevUV));

    // A pixel traced this frame accumulates its new sample over the history rather than replacing it,
    // so the march dither averages across the 16-frame cycle. Every other pixel is history alone.
    //
    // NOTE the residual this cannot cover: a pixel that was BEHIND geometry last frame and is sky now
    // has stale history and no way to know it, since testing that needs a previous-frame depth buffer
    // this pass does not keep. The clamp bounds the error; a 1-channel depth history alongside the
    // colour ping-pong is the fix if it ever becomes visible.
    fragColor = isTraced ? mix(history, traced, TRACE_BLEND) : history;
}
