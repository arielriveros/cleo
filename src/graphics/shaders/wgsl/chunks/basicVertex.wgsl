// Unlit vertex stage with a per-object model matrix. The GLSL twin is materials/basic.vs.

#include "./basicVarying.wgsl"

struct BasicTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // UV transform for sprite sheets: scale then offset.
    u_uvOffset: vec2<f32>,
    u_uvScale: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: BasicTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    out.uv = texCoord * u_transform.u_uvScale + u_transform.u_uvOffset;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 1.0);
    return out;
}
