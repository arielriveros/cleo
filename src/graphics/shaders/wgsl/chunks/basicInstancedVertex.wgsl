// Unlit INSTANCED vertex stage. The GLSL twin is materials/basicInstanced.vs.
//
// Used by the editor's skeleton overlay to draw many joint spheres and bone connectors in one call. The
// per-instance model matrix arrives at locations 5-8, replacing u_model. The base geometry is
// POSITION-ONLY — its VAO is initialised with the single-attribute shadowMap shader — so the uv is a
// constant, present only so this links against a fragment stage that samples when hasTexture is set.

#include "./basicVarying.wgsl"

struct BasicInstancedTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: BasicInstancedTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(5) instanceModel0: vec4<f32>,
    @location(6) instanceModel1: vec4<f32>,
    @location(7) instanceModel2: vec4<f32>,
    @location(8) instanceModel3: vec4<f32>,
) -> VertexOutput {
    let model = mat4x4<f32>(instanceModel0, instanceModel1, instanceModel2, instanceModel3);
    var out: VertexOutput;
    out.uv = vec2<f32>(0.0);
    out.position = u_transform.u_projection * u_transform.u_view * model * vec4<f32>(position, 1.0);
    return out;
}
