// GGX importance sampling, shared by the two split-sum bakes.
//
// `brdf.wgsl` integrates the environment BRDF and `prefilter.wgsl` convolves the environment cube, and
// both need the same low-discrepancy sequence and the same GGX half-vector distribution. In the GLSL
// tree these were two verbatim copies, 30 lines each, in screen/brdf.fs and environment/prefilter.fs —
// the kind of duplication that stays identical right up until someone fixes a bug in one of them.

const PI: f32 = 3.14159265359;

/**
 * Van der Corput radical inverse: the bits of `i`, reversed, as a fraction in [0, 1).
 *
 * The shifts and masks ARE the reversal — pairs, then nibbles, then bytes, then halves. WGSL's `u32`
 * takes the GLSL `uint` code unchanged, which is the one place these two languages agree completely.
 */
fn radicalInverseVdC(index: u32) -> f32 {
    var bits = index;
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return f32(bits) * 2.3283064365386963e-10;
}

/** The i-th of N points on the Hammersley set — a 2D low-discrepancy sequence. */
fn hammersley(i: u32, n: u32) -> vec2<f32> {
    return vec2<f32>(f32(i) / f32(n), radicalInverseVdC(i));
}

/**
 * A half-vector drawn from the GGX distribution around `n`, for the sample point `xi`.
 *
 * The `up` vector switches axis near the pole so the cross product cannot degenerate: with `n` almost
 * parallel to +Z, crossing against +Z gives a zero-length tangent and every sample collapses onto one
 * direction.
 */
fn importanceSampleGGX(xi: vec2<f32>, n: vec3<f32>, roughness: f32) -> vec3<f32> {
    let a = roughness * roughness;
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);

    let h = vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);

    var up = vec3<f32>(1.0, 0.0, 0.0);
    if (abs(n.z) < 0.999) { up = vec3<f32>(0.0, 0.0, 1.0); }
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    return normalize(tangent * h.x + bitangent * h.y + n * h.z);
}
