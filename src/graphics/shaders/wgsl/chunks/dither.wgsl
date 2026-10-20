// The 4x4 ordered dither every screen-door dissolve in the engine uses: foliage LOD crossfades
// (chunks/instancedVertex.wgsl) and gradual despawns (Node.remove). Included by each varying chunk;
// a program includes exactly one of those, so this lands once.

/** A 4x4 ordered-dither threshold in (0, 1) for a pixel, shifted per frame by `phase`. */
fn lodDitherThreshold(fragCoord: vec2<f32>, phase: f32) -> f32 {
    let x = i32(floor(fragCoord.x)) & 3;
    let y = i32(floor(fragCoord.y)) & 3;
    // Bayer 4x4 by recursion on the 2x2 pattern [[0, 2], [3, 1]].
    let lo = ((x ^ y) & 1) * 2 + (y & 1);
    let hi = (((x >> 1) ^ (y >> 1)) & 1) * 2 + ((y >> 1) & 1);
    return fract((f32(lo * 4 + hi) + 0.5) / 16.0 + phase);
}

/**
 * Whether a fragment survives a despawn dissolve: `dissolve.x` is how far gone (0 solid, 1 gone) and
 * `dissolve.y` the frame's dither phase. Zero -- an unwritten uniform -- keeps everything.
 */
fn dissolveKeeps(dissolve: vec2<f32>, fragCoord: vec2<f32>) -> bool {
    if (dissolve.x <= 0.0) { return true; }
    return lodDitherThreshold(fragCoord, dissolve.y) < 1.0 - dissolve.x;
}
