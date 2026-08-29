// The varying contract between a model vertex stage and a material fragment stage.
//
// Included by each vertex chunk (modelVertex / skinnedVertex / instancedVertex) and NOT by the
// fragment chunks, which simply use what the one included vertex chunk brought in. A program includes
// exactly one vertex chunk, so this lands exactly once — the include resolver has no include-once
// guard, and a second definition of a struct is a compile error.
//
// chunks/parallax.wgsl rides in here for that same "exactly once" property. Its consumers are
// FRAGMENT chunks (terrainLayers, pbrGBuffer, pbrForward), and a program can include more than one
// of those, so including it from each would define its functions twice. Here it cannot.

#include "./parallax.wgsl"

#include "./octNormal.wgsl"

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragPos: vec3<f32>,        // world-space position
    @location(1) uv: vec2<f32>,
    // The TBN basis travels as three vectors, never as a mat3: a matrix is not a valid shader
    // interface type in WGSL (NotIOShareableType). Fragment stages rebuild it with tbnOf().
    @location(2) tangent: vec3<f32>,
    @location(3) bitangent: vec3<f32>,
    @location(4) normal: vec3<f32>,
};

/**
 * Geometric specular antialiasing: widen roughness by the SUB-PIXEL VARIANCE of the normal.
 *
 * A curved or normal-mapped surface packs many normal directions into one pixel. The specular lobe is
 * evaluated once, at the averaged normal, so the highlight that should have been a smooth wide band
 * across those directions comes out as a point sample of a very narrow one — and it flickers as the
 * geometry moves, because which direction wins changes from frame to frame. That is highlight crawl,
 * and no amount of MSAA fixes it: the aliasing is in the SHADING, not the coverage.
 *
 * Kaplanyan/Tokuyoshi's answer, in Filament's formulation: treat the normal spread inside the pixel as
 * a distribution, and fold its variance into the NDF's own width. A rough surface already has a wide
 * lobe and barely changes; a mirror over a sharp crease can be widened a long way, which is exactly
 * where the crawl is. `d(N)/d(screen)` is the variance estimate, and it costs two derivative pairs.
 *
 * The arithmetic runs in ALPHA, not in this codebase's perceptual roughness. Filament's
 * `perceptualRoughnessToRoughness` is `pr * pr`, so `alpha * alpha` is `pr^4`, and the fourth root at
 * the end takes the sum straight back to perceptual — which is why the two square roots are not a
 * mistake. Adding the kernel to a perceptual roughness instead would widen matte surfaces far too much
 * and mirrors nowhere near enough.
 *
 * The two constants are Filament's defaults. The threshold matters: without it a silhouette edge, where
 * the normal turns through most of a hemisphere inside one pixel, drives roughness to 1 and paints a
 * bright rim on every object.
 *
 * CALL IT IN UNIFORM CONTROL FLOW. It takes derivatives, so it carries the same rule `textureSample`
 * does. `enabled` is read from a uniform buffer, so the branch on it is uniform, but the derivatives
 * are taken unconditionally anyway rather than relying on that.
 */
const SPECULAR_AA_VARIANCE: f32 = 0.15;
const SPECULAR_AA_THRESHOLD: f32 = 0.25;

fn filterSpecularRoughness(perceptualRoughness: f32, N: vec3<f32>, enabled: i32) -> f32 {
    let du = dpdx(N);
    let dv = dpdy(N);
    let variance = SPECULAR_AA_VARIANCE * (dot(du, du) + dot(dv, dv));
    let kernel = min(2.0 * variance, SPECULAR_AA_THRESHOLD);
    let alpha = perceptualRoughness * perceptualRoughness;
    let filtered = sqrt(sqrt(clamp(alpha * alpha + kernel, 0.0, 1.0)));
    return select(perceptualRoughness, filtered, enabled != 0);
}
/** Rebuild the TBN basis from the three varyings. Columns are tangent, bitangent, normal. */
fn tbnOf(in: VertexOutput) -> mat3x3<f32> {
    return mat3x3<f32>(in.tangent, in.bitangent, in.normal);
}

/**
 * Fill the varyings from an object-space vertex and its world matrix.
 *
 * Shared by all three vertex chunks so the basis is built one way only — the GLSL originals had this
 * arithmetic copied into pbr.vs, pbr_skinned.vs and geometry_instanced.vs, with the bitangent negation
 * that has to match the importers' handedness repeated in each.
 */
fn fillVarying(out: ptr<function, VertexOutput>, model: mat4x4<f32>,
               position: vec3<f32>, texCoord: vec2<f32>,
               normal: vec3<f32>, tangent: vec3<f32>, bitangent: vec3<f32>) {
    (*out).fragPos = (model * vec4<f32>(position, 1.0)).xyz;
    (*out).uv = texCoord;
    (*out).tangent = normalize((model * vec4<f32>(tangent, 0.0)).xyz);
    (*out).normal = normalize((model * vec4<f32>(normal, 0.0)).xyz);
    // Negated to match the handedness the importers produce; see materials/pbr.vs.
    (*out).bitangent = normalize((model * vec4<f32>(-bitangent, 0.0)).xyz);
}
