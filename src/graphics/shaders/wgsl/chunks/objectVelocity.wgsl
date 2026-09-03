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
// and, on a cube-face capture, a Y flip, neither of which belongs in a screen-space delta. It is also
// what makes this pass correct under TAA jitter for free — the jitter lives only in the rasterization
// matrix, so it never reaches the delta.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) curClip: vec4<f32>,
    @location(1) prevClip: vec4<f32>,
    /**
     * `(u_noBlur, u_trueMotion)`, carried down from the vertex stage rather than read from the uniform
     * block a second time — and that detour is a HARD REQUIREMENT, not a preference.
     *
     * A uniform block read from BOTH stages is emitted by naga as two stage-suffixed blocks with no
     * instance name, and GLSL ES 300 scopes an instance-less block's members globally: two of them
     * declaring `u_ov` is a LINK error ("Ambiguous field 'u_ov' in blocks ... which don't have
     * instance names"). Every other group-1 block in the engine is single-stage for exactly this
     * reason — see PBRMaterial in chunks/pbrGBuffer.wgsl and TerrainUniforms in chunks/terrainLayers
     * .wgsl, both of which carry per-frame values purely to stay out of the vertex block.
     *
     * These three programs did not, so all three failed to link, and `_createPrograms` builds every
     * program at boot: the renderer came up on NO backend at all. Passing the two flags as a flat
     * varying keeps the block vertex-only and costs one interpolant, with no second binding for the
     * bind-group layouts to grow by.
     */
    @location(2) @interpolate(flat) flags: vec2<f32>,
};

/**
 * Screen-space motion vector in UV units, in the exact encoding the camera-reprojection pass uses:
 * `.xy` is the RAW delta and `.z` is the "leave this pixel alone" flag the reconstruction filter
 * reads.
 *
 * RAW — neither scaled by the shutter nor clamped to a tile — because TAA reprojects through this
 * same buffer and needs the true delta, while motion blur wants the scaled and capped form.
 * `chunks/motionBlurShutter.wgsl` applies the second at the point of use, so one stored value serves
 * both. Storing the blurred form was correct while motion blur was the only reader; it is not any
 * more.
 *
 * `.z` is a MOTION-BLUR opt-out and nothing else. It used to arrive with a zeroed `.xy`, which kept a
 * flagged object out of TileMax for free; TileMax now skips flagged texels explicitly, and the true
 * velocity survives so TAA can reproject the object rather than ghost it. Those are different
 * questions and they now have different answers.
 *
 * `.w` answers a third: is `.xy` the REAL screen-space motion of this surface? The 'objectOnly' blur
 * mode deliberately says it is not — it is handed this frame's view-projection as its previous one, so
 * the camera term divides out and what is left is the node's own world motion. That is a good blur and
 * a wrong reprojection, so it is marked here and the TAA resolve declines to use it. Those objects
 * come out aliased rather than ghosted, which is the right way round.
 */
fn encodeVelocity(curClip: vec4<f32>, prevClip: vec4<f32>, noBlur: f32, trueMotion: f32) -> vec4<f32> {
    // Guard the divides: a vertex on or behind the eye plane has w <= 0, and the interpolated w of a
    // triangle straddling it passes through zero somewhere on screen.
    let curW = max(abs(curClip.w), 1e-6) * select(-1.0, 1.0, curClip.w >= 0.0);
    let prevW = max(abs(prevClip.w), 1e-6) * select(-1.0, 1.0, prevClip.w >= 0.0);

    let curUV = (curClip.xy / curW) * 0.5 + 0.5;
    let prevUV = (prevClip.xy / prevW) * 0.5 + 0.5;

    return vec4<f32>(curUV - prevUV, select(0.0, 1.0, noBlur > 0.5), trueMotion);
}
