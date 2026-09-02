// The shutter transform that the velocity buffer used to bake in at write time.
//
// `_velocityFBO` now stores RAW screen-space motion in UV units — unscaled and unclamped — because
// two passes read it and they want different things from it. TAA reprojects through `.xy` and needs
// the true per-pixel delta; motion blur wants that delta scaled by a shutter length and capped at one
// tile. One buffer, two readings: the raw form is what is stored, and each consumer applies what it
// needs at the point of use.
//
// Included by motionBlurTileMax.wgsl and motionBlur.wgsl. (`#include` has no include-once guard:
// include it exactly once per module.)

/**
 * Scale a raw motion vector by the shutter length and clamp its screen-space length.
 *
 * The clamp is not cosmetic: a streak longer than one tile is one the NeighborMax dilation cannot
 * have accounted for, so the gather would read a dominant velocity that never reaches the pixels it
 * claims to cover. Applying it here rather than at write time keeps the two consumers in agreement —
 * both call this, with the same uniforms, so the shutter length is still single-valued across the
 * image.
 */
fn applyShutter(v: vec2<f32>, screenSize: vec2<f32>, intensity: f32, maxVelocityPx: f32) -> vec2<f32> {
    var velocity = v * intensity;
    let lenPx = length(velocity * screenSize);
    if (lenPx > maxVelocityPx) {
        velocity *= maxVelocityPx / max(lenPx, 1e-5);
    }
    return velocity;
}
