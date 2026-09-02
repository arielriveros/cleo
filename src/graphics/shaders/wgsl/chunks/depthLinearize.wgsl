// Device depth -> view-space distance, shared by the passes that have to compare two depths rather
// than merely order them.
//
// Parameterized rather than reading a `u_near`/`u_far` from a uniform block, because a chunk cannot
// reference the block of whichever program included it — every consumer names its own. (`#include` has
// no include-once guard: include it exactly once per module.)
//
// `d * 2 - 1` recovers GL-convention NDC z on BOTH backends: WebGL2 rasterizes into [-1, 1] and the
// device maps that to [0, 1], while WebGPU rasterizes into [0, 1] directly via `_CLIP_Z_ZERO_TO_ONE`.
// The two arrive at the same stored value from different directions, which is exactly why this
// conversion needs no backend switch.

fn linearizeDepth(d: f32, near: f32, far: f32) -> f32 {
    let z = d * 2.0 - 1.0;
    return (2.0 * near * far) / (far + near - z * (far - near));
}
