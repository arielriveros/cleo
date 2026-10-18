// The varying contract between a model vertex stage and a material fragment stage.
//
// Included by each vertex chunk (modelVertex / skinnedVertex / instancedVertex) and NOT by the
// fragment chunks, which simply use what the one included vertex chunk brought in. A program includes
// exactly one vertex chunk, so this lands exactly once — the include resolver has no include-once
// guard, and a second definition of a struct is a compile error.
//
// chunks/parallax.wgsl rides in here for that same "exactly once" property. Its consumers are
// FRAGMENT chunks (pbrGBuffer, pbrForward), and a program can include more than one
// of those, so including it from each would define its functions twice. Here it cannot.

#include "./parallax.wgsl"

#include "./octNormal.wgsl"

#include "./uvProjection.wgsl"

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragPos: vec3<f32>,        // world-space position
    @location(1) uv: vec2<f32>,
    // The TBN basis travels as three vectors, never as a mat3: a matrix is not a valid shader
    // interface type in WGSL (NotIOShareableType). Fragment stages rebuild it with tbnOf().
    @location(2) tangent: vec3<f32>,
    @location(3) bitangent: vec3<f32>,
    @location(4) normal: vec3<f32>,
    // Object space, for a material's box/triplanar projection in Object space (chunks/uvProjection.wgsl):
    // the position in METRES along the object's own axes (scaled by the node, so a stretched cube is
    // measured as stretched) and the normal in those axes.
    @location(5) objPos: vec3<f32>,
    @location(6) objNormal: vec3<f32>,
    // Foliage LOD crossfade (chunks/instancedVertex.wgsl): x = fade-in, y = fade-out, z = this frame's
    // dither phase. 1, 1 for everything else, which `lodFadeKeeps` always keeps.
    @location(7) lodFade: vec3<f32>,
};

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
 * Whether a fragment survives the foliage LOD crossfade: a screen-door dissolve. While a level fades IN
 * it keeps the pixels whose threshold is above 1 - fade; while it fades OUT, those below fade. The two
 * sides of one band edge therefore claim complementary pixels — never a hole, never both — and the
 * per-frame phase lets TAA resolve the pattern into a smooth blend.
 */
fn lodFadeKeeps(fade: vec3<f32>, fragCoord: vec2<f32>) -> bool {
    if (fade.x >= 1.0 && fade.y >= 1.0) { return true; }
    let t = lodDitherThreshold(fragCoord, fade.z);
    return (1.0 - t) < fade.x && t < fade.y;
}

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
 * `v` normalised, or `fallback` when `v` has no length. `normalize(0)` is NaN on most drivers, and a
 * mesh imported without tangents — leaf and grass cards very often are — has exactly that. The NaN rode
 * the TBN into a normal-mapped G-buffer normal, lit as black, and TAA then kept the black.
 * `select`, so the NaN of the unused branch is never the result.
 */
fn safeNormalize(v: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
    let d = dot(v, v);
    return select(fallback, v * inverseSqrt(max(d, 1e-30)), d > 1e-20);
}

/** Any unit vector perpendicular to the unit `n` — a stand-in tangent for a mesh that has none. */
fn anyTangent(n: vec3<f32>) -> vec3<f32> {
    let a = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.x) > 0.9);
    return normalize(cross(a, n));
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
    let n = safeNormalize((model * vec4<f32>(normal, 0.0)).xyz, vec3<f32>(0.0, 1.0, 0.0));
    (*out).normal = n;
    // A missing tangent frame falls back to an arbitrary orthonormal one: the normal map then decodes
    // in a rotated frame, which is wrong but finite, instead of NaN, which is black forever under TAA.
    let t = safeNormalize((model * vec4<f32>(tangent, 0.0)).xyz, anyTangent(n));
    (*out).tangent = t;
    // Negated to match the handedness the importers produce; see materials/pbr.vs.
    (*out).bitangent = safeNormalize((model * vec4<f32>(-bitangent, 0.0)).xyz, cross(n, t));
    let scale = vec3<f32>(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz));
    (*out).objPos = position * scale;
    // Inverse-scaled, the way a normal transforms under a non-uniform scale.
    (*out).objNormal = normalize(normal / max(scale, vec3<f32>(1e-6)));
    (*out).lodFade = vec3<f32>(1.0, 1.0, 0.0);
}

/** The material's projection, resolved for this fragment. See chunks/uvProjection.wgsl. */
fn surfaceUvOf(in: VertexOutput, params: UvParams) -> SurfaceUv {
    return surfaceUv(params, in.uv, in.objPos, in.objNormal, in.fragPos, in.normal);
}
