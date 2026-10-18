// Instanced vertex stage: the per-instance world matrix arrives as a vertex attribute at locations
// 5-8 (divisor 1), replacing u_model entirely — the matrices Foliage bakes are already in world space.
// The GLSL twin is deferred/geometry_instanced.vs.
//
// A mat4 vertex attribute is four vec4 locations; WGSL has to spell that out, where GLSL let one
// `in mat4` cover it. The engine binds them by LOCATION (see rhi/vertexLayouts.ts instanceMatrixLayout),
// not by name, so the parameter names here are free.

#include "./modelVarying.wgsl"
#include "./foliageWind.wgsl"

struct InstancedTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // Foliage wind (chunks/foliageWind.wgsl). Declared in EVERY variant so the block's layout never
    // depends on the variant; only `CLEO_WIND` builds read them.
    u_windGlobal: vec4<f32>,
    u_windTime: vec4<f32>,
    u_windResponse: vec4<f32>,
    u_windShape: vec4<f32>,
    u_windCamera: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: InstancedTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) instanceModel0: vec4<f32>,
    @location(6) instanceModel1: vec4<f32>,
    @location(7) instanceModel2: vec4<f32>,
    @location(8) instanceModel3: vec4<f32>,
) -> VertexOutput {
    let model = mat4x4<f32>(instanceModel0, instanceModel1, instanceModel2, instanceModel3);

    var out: VertexOutput;
    fillVarying(&out, model, position, texCoord, normal, tangent, bitangent);
#if CLEO_WIND
    let wind = WindParams(u_transform.u_windGlobal, u_transform.u_windTime, u_transform.u_windResponse,
                          u_transform.u_windShape, u_transform.u_windCamera);
    out.fragPos = windDisplace(out.fragPos, position.y, model, u_transform.u_windTime.x, wind);
#endif
    // From fragPos, which IS model * position unless the wind moved it.
    out.position = u_transform.u_projection * u_transform.u_view * vec4<f32>(out.fragPos, 1.0);
    return out;
}
