// The standard model vertex stage, for a mesh drawn with a per-object model matrix.
//
// In the GLSL tree this is materials/pbr.vs, paired by the linker with several different fragment
// shaders. WGSL cannot work that way — naga generates varying names from a module's location numbers,
// so both stages must live in one module — which is why the sharing moves from "one file linked many
// times" to "one chunk included many times". See tools/shaderIncludes.mjs.
//
// Vertex inputs are declared WITHOUT the engine's `a_` prefix; the loader adds it. See
// tools/wgslTranslate.mjs for why that separation is load-bearing rather than stylistic.
//
// While the GLSL twin still exists it must stay in step: it feeds the same varyings to fragment
// shaders that have not been converted yet.

#include "./modelVarying.wgsl"

struct ModelTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: ModelTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    fillVarying(&out, u_transform.u_model, position, texCoord, normal, tangent, bitangent);
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 1.0);
    return out;
}
