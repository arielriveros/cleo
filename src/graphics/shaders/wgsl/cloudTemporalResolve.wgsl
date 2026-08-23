// Temporal resolve for the volumetric clouds (Guerrilla/Horizon-style Bayer-subset reprojection).
//
// The trace pass only raymarched 1/16 of this buffer's pixels this frame — the subset selected by
// `u_bayerIndex`. This pass reconstructs the full image:
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
//     1/16 density the 3x3 block neighbourhood spans ~24x24 screen pixels, so on a mesh silhouette it
//     would happily include full cloud coverage from nearby sky blocks and bound stale cloud to
//     itself. Neighbours are therefore only admitted when their ray reached the cloud slab if and only
//     if this pixel's did — see the gather loop.
//
//   * The OCCLUSION REJECT. A pixel with geometry nearer than the cloud slab had its ray bounded by
//     that geometry, so a history value captured when the pixel saw sky is not a valid predecessor for
//     it. Without this test cloud radiance drifts onto meshes and sits there for up to 16 frames.
//
// And the resolve BLENDS rather than replaces, so the raymarch's per-pixel ray-start dither actually
// averages out across the Bayer cycle instead of being frozen into the image as grain.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_trace_texture: texture_2d<f32>;     // this frame's new samples, 1/4 per axis
@group(0) @binding(1) var u_trace_sampler: sampler;
@group(0) @binding(2) var u_history_texture: texture_2d<f32>;   // last frame's resolved result
@group(0) @binding(3) var u_history_sampler: sampler;
@group(0) @binding(4) var u_gDepth_texture: texture_2d<f32>;    // scene depth, to reject occluded reprojection
@group(0) @binding(5) var u_gDepth_sampler: sampler;

struct CloudResolveUniforms {
    u_invViewProj: mat4x4<f32>,    // this frame's clip -> world
    u_prevViewProj: mat4x4<f32>,   // last frame's world -> clip
    u_viewPos: vec3<f32>,
    u_resolution: vec2<f32>,       // cloud-resolution target size, in pixels
    // Actual size of the trace buffer. Passed rather than derived as u_resolution*0.25: the renderer
    // sizes it with ceil(w/4), so for any width not a multiple of 4 the derived value is wrong and
    // every sample lands fractionally off its block.
    u_traceResolution: vec2<f32>,
    u_slabMid: f32,                // world-space altitude of the cloud slab's midpoint
    u_bayerIndex: i32,             // which of the 16 sub-positions was traced this frame
    u_historyValid: i32,           // 0 on the first frame / after a cut: ignore history entirely
};
@group(1) @binding(0) var<uniform> u_resolve: CloudResolveUniforms;

/**
 * How much of a freshly traced pixel's own sample it keeps, the rest coming from clamped history.
 *
 * Below 1.0 this is what turns the scheme from pure reconstruction into accumulation: the march dither
 * converges away over the Bayer cycle instead of popping against 15 stale neighbours. Kept high so a
 * genuinely new observation still dominates within a frame or two.
 */
const TRACE_BLEND: f32 = 0.85;

// The 4x4 Bayer ordering. Sequential frames land far apart in the block, so the reconstructed image
// converges evenly instead of sweeping a visible band across each block.
const BAYER_16 = array<i32, 16>(
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5,
);

/**
 * Clamp bounds over the traced neighbourhood, kept in UNPREMULTIPLIED form.
 *
 * They have to be. Premultiplied colour and coverage are not independent — `rgb = colour * a` — and a
 * clamp on a vec4 is per-component, so clamping a premultiplied sample against premultiplied bounds
 * can raise rgb toward hi while dropping a toward lo, leaving `rgb > a`. That is a colour its own alpha
 * cannot represent, and it composites as a bright fringe along every cloud edge: exactly the artefact
 * the clamp exists to prevent.
 */
struct ClampBounds {
    colorLo: vec3<f32>,
    colorHi: vec3<f32>,
    alphaLo: f32,
    alphaHi: f32,
};

fn bayerOffset(frame: i32) -> vec2<i32> {
    // Find the cell whose Bayer rank equals this frame's cursor.
    for (var i = 0; i < 16; i++) {
        if (BAYER_16[i] == frame) { return vec2<i32>(i % 4, i / 4); }
    }
    return vec2<i32>(0, 0);
}

fn reconstructWorldPos(depth: f32, uv: vec2<f32>) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_resolve.u_invViewProj * clip;
    return world.xyz / world.w;
}

/** Colour of a premultiplied sample. A sample with no coverage carries no colour, only black. */
fn unpremultiply(s: vec4<f32>) -> vec3<f32> {
    if (s.a > 1e-4) { return s.rgb / s.a; }
    return vec3<f32>(0.0);
}

/** Bring a sample inside the neighbourhood bounds, re-premultiplying so the invariant survives. */
fn clampSample(s: vec4<f32>, b: ClampBounds) -> vec4<f32> {
    let a = clamp(s.a, b.alphaLo, b.alphaHi);
    let c = clamp(unpremultiply(s), b.colorLo, b.colorHi);
    return vec4<f32>(c * a, a);
}

/** Distance from the camera to solid geometry at `uv`, or "infinite" where the background shows. */
fn geometryDistance(depth: f32, uv: vec2<f32>) -> f32 {
    if (depth >= 1.0) { return 1e30; }
    return length(reconstructWorldPos(depth, uv) - u_resolve.u_viewPos);
}

/**
 * The screen UV a given block's ray was actually traced at this frame.
 *
 * Must mirror volumetricClouds' traceUV() exactly, INCLUDING the `u_traceResolution * 4.0`
 * denominator. `u_resolution` is not `u_traceResolution * 4.0` — the renderer sizes the trace buffer
 * with ceil(w/4) — so dividing by u_resolution here would fetch depth a fraction of a block away from
 * the sample it is supposed to describe, and the depth test would reject valid neighbours near edges.
 */
fn traceSampleUV(blk: vec2<i32>, subPos: vec2<i32>) -> vec2<f32> {
    return (vec2<f32>(blk) * 4.0 + vec2<f32>(subPos) + 0.5) / (u_resolve.u_traceResolution * 4.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let pixel = vec2<i32>(in.uv * u_resolve.u_resolution);
    let block = pixel / 4;              // which 4x4 block this pixel belongs to
    let sub = pixel - block * 4;        // its position inside that block

    let traceSub = bayerOffset(u_resolve.u_bayerIndex);
    let isTraced = all(sub == traceSub);

    // The trace buffer holds exactly one sample per block, at the sub-position traced this frame.
    let traceUV = (vec2<f32>(block) + 0.5) / u_resolve.u_traceResolution;
    let traced = textureSample(u_trace_texture, u_trace_sampler, traceUV);

    // View ray, from the same reconstruction the raymarch uses.
    let ndc = in.uv * 2.0 - 1.0;
    let nW = u_resolve.u_invViewProj * vec4<f32>(ndc, -1.0, 1.0);
    let fW = u_resolve.u_invViewProj * vec4<f32>(ndc, 1.0, 1.0);
    let ro = nW.xyz / nW.w;
    let rd = normalize(fW.xyz / fW.w - ro);

    // Clouds have no single depth, so anchor the ray at the slab midpoint: the layer is thin relative
    // to its distance, so one plane intersection is an adequate stand-in for the volume, and it costs
    // no extra buffer. A ray that never reaches the slab is treated as infinitely far from it.
    var slabT = 1e30;
    if (abs(rd.y) >= 1e-4) {
        let tPlane = (u_resolve.u_slabMid - u_resolve.u_viewPos.y) / rd.y;
        if (tPlane > 0.0) { slabT = tPlane; }
    }

    // How far this pixel's ray got before solid geometry stopped it, read from the same depth buffer
    // the raymarch bounded its rays against.
    let sceneDist = geometryDistance(
        textureSample(u_gDepth_texture, u_gDepth_sampler, in.uv).r, in.uv);
    let reachesSlab = slabT < sceneDist;

    // Fallback for every path that cannot use history (first frame, camera cut, occlusion, off-screen
    // reprojection). Sampling the trace buffer at this pixel's OWN position rather than at its block
    // centre lets the LINEAR filter interpolate between neighbouring blocks — the same information,
    // but a smooth 4x upscale instead of hard 4x4 blocks. It is geometrically a little off (traced
    // samples sit at varying sub-positions), which is irrelevant for something that survives a frame
    // or two before history takes over, and very visible if you skip it.
    let fallback = textureSample(u_trace_texture, u_trace_sampler,
        (in.uv * u_resolve.u_resolution * 0.25) / u_resolve.u_traceResolution);

    // Neighbourhood bounds from the traced samples around this block. One sample per block means the
    // 3x3 block neighbourhood is the tightest honest bound available at this resolution — but only
    // over samples that saw the same thing, or the bound is useless exactly on the silhouettes where
    // it matters.
    //
    // "The same thing" is deliberately a REACHABILITY test rather than a depth-difference epsilon like
    // the AO upsample's. Device depth is so compressed toward 1.0 that a mesh 20m away and the open
    // sky behind it differ by a few thousandths; any epsilon loose enough to keep genuine same-surface
    // neighbours also admits the sky, which is precisely the sample that lets stale cloud clamp to
    // itself on a silhouette. Whether the ray got to the cloud layer at all is the property the clamp
    // actually cares about, and it separates the two cases exactly.
    //
    // The centre block always counts, so the bounds can never invert. Coverage and colour are bounded
    // separately, and only samples carrying some coverage contribute a colour bound — a transparent
    // neighbour would otherwise drag the colour floor to black and let the clamp darken genuine cloud.
    var bounds: ClampBounds;
    bounds.alphaLo = traced.a;
    bounds.alphaHi = traced.a;
    var anyColor = traced.a > 1e-4;
    bounds.colorLo = unpremultiply(traced);
    bounds.colorHi = bounds.colorLo;

    let traceTexel = 1.0 / u_resolve.u_traceResolution;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let nbUV = traceSampleUV(block + vec2<i32>(x, y), traceSub);
            // Reuse this pixel's slabT: over one block the anchor distance barely moves, and the test
            // is a threshold rather than a measurement.
            let nbReaches = slabT < geometryDistance(
                textureSample(u_gDepth_texture, u_gDepth_sampler, nbUV).r, nbUV);
            if (nbReaches != reachesSlab) { continue; }   // saw something else: not a valid bound
            let sN = textureSample(u_trace_texture, u_trace_sampler,
                                   traceUV + vec2<f32>(f32(x), f32(y)) * traceTexel);
            bounds.alphaLo = min(bounds.alphaLo, sN.a);
            bounds.alphaHi = max(bounds.alphaHi, sN.a);
            if (sN.a <= 1e-4) { continue; }
            let c = sN.rgb / sN.a;
            if (anyColor) {
                bounds.colorLo = min(bounds.colorLo, c);
                bounds.colorHi = max(bounds.colorHi, c);
            } else {
                bounds.colorLo = c;
                bounds.colorHi = c;
            }
            anyColor = true;
        }
    }

    // The traced pixel still has its own fresh sample when history is unusable; everything else has to
    // make do with the bilinear upscale.
    var source = fallback;
    if (isTraced) { source = traced; }
    let noHistory = clampSample(source, bounds);

    if (u_resolve.u_historyValid == 0) { return noHistory; }

    // Geometry is nearer than the cloud slab, or the slab is not in front of us at all: this frame's
    // ray never sampled cloud here, so last frame's value — captured when the pixel may well have been
    // looking at open sky — is not a valid predecessor. This is the test that keeps cloud from staining
    // meshes; with the bounds above, the fallback resolves against equally-occluded neighbours and so
    // collapses toward zero coverage instead of holding cloud.
    if (!reachesSlab) { return noHistory; }

    let anchor = u_resolve.u_viewPos + rd * slabT;
    let prevClip = u_resolve.u_prevViewProj * vec4<f32>(anchor, 1.0);
    if (prevClip.w <= 0.0) { return noHistory; }
    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Off-screen last frame: there is no history for this pixel, only the new sample.
    if (any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0))) { return noHistory; }

    // Clamp history into the freshly observed range, in unpremultiplied space so colour and coverage
    // come back out consistent with each other (see clampSample).
    let history = clampSample(textureSample(u_history_texture, u_history_sampler, prevUV), bounds);

    // A pixel traced this frame accumulates its new sample over the history rather than replacing it,
    // so the march dither averages across the 16-frame cycle. Every other pixel is history alone.
    //
    // NOTE the residual this cannot cover: a pixel that was BEHIND geometry last frame and is sky now
    // has stale history and no way to know it, since testing that needs a previous-frame depth buffer
    // this pass does not keep. The clamp bounds the error; a 1-channel depth history alongside the
    // colour ping-pong is the fix if it ever becomes visible.
    if (isTraced) { return mix(history, traced, TRACE_BLEND); }
    return history;
}
