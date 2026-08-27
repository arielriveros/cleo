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
