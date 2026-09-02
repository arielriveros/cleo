// Shared tail of the per-object velocity programs: the varying contract and the encoder that turns a
// pair of clip positions into the same screen-space motion vector `motionBlurVelocity.wgsl` writes.
//
// The uniform block itself is NOT here. Each variant appends its own bone palettes to it, and WGSL has
// no way to extend a struct — so the block is declared per program and only the parts that are
// genuinely identical live in this chunk. (`#include` has no include-once guard: include it once.)
//
// Both clip positions arrive built with `_uvProducing`-flipped view-projections, never with the
// `_clipProjection` one used to rasterize. That is the whole reason they travel as varyings instead of
// being derived from `@builtin(position)`: the rasterization matrix carries the backend's Z convention
// and, on a cube-face capture, a Y flip, neither of which belongs in a screen-space delta.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) curClip: vec4<f32>,
    @location(1) prevClip: vec4<f32>,
};

/**
 * Screen-space motion vector in UV units, in the exact encoding the camera-reprojection pass uses:
 * `.xy` is the (intensity-scaled, length-clamped) delta and `.z` is the "leave this pixel alone" flag
 * the reconstruction filter reads.
 *
 * `intensity` is baked in here rather than applied at gather time because the base pass bakes it in
 * too — two velocity sources that disagreed about the shutter length would blur by different amounts
 * within one image.
 */
fn encodeVelocity(curClip: vec4<f32>, prevClip: vec4<f32>, screenSize: vec2<f32>,
                  intensity: f32, maxVelocityPx: f32, noBlur: f32) -> vec4<f32> {
    // Flagged pixels carry no velocity at all, so they also contribute nothing to TileMax and cannot
    // pull a blur onto their own neighbours.
    if (noBlur > 0.5) { return vec4<f32>(0.0, 0.0, 1.0, 1.0); }

    // Guard the divides: a vertex on or behind the eye plane has w <= 0, and the interpolated w of a
    // triangle straddling it passes through zero somewhere on screen.
    let curW = max(abs(curClip.w), 1e-6) * select(-1.0, 1.0, curClip.w >= 0.0);
    let prevW = max(abs(prevClip.w), 1e-6) * select(-1.0, 1.0, prevClip.w >= 0.0);

    let curUV = (curClip.xy / curW) * 0.5 + 0.5;
    let prevUV = (prevClip.xy / prevW) * 0.5 + 0.5;

    var velocity = (curUV - prevUV) * intensity;

    // Same clamp as the base pass, and for the same reason: a streak longer than one tile is one the
    // NeighborMax dilation cannot have accounted for.
    let velPx = velocity * screenSize;
    let lenPx = length(velPx);
    if (lenPx > maxVelocityPx) {
        velocity *= maxVelocityPx / max(lenPx, 1e-5);
    }

    return vec4<f32>(velocity, 0.0, 1.0);
}
