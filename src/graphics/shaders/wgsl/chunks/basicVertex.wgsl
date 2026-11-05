// Unlit vertex stage with a per-object model matrix. The GLSL twin is materials/basic.vs.
//
// The world matrix, the despawn dissolve and the UV transform come from the per-object table
// (chunks/objectData.wgsl) through `instance_index`: (1, 1, 0, 0) for a model, a sprite-sheet tile for a
// sprite. The block keeps only what is the same for every draw of a pass.

#include "./basicVarying.wgsl"
#include "./objectData.wgsl"

struct BasicTransform {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    // The despawn dither phase (per frame); how far gone is per object, objectParams().x. See Node.remove.
    u_ditherPhase: f32,
};
@group(1) @binding(0) var<uniform> u_transform: BasicTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @builtin(instance_index) objectIndex: u32,
) -> VertexOutput {
    let model = objectModel(objectIndex);
    let uvt = objectUvTransform(objectIndex);
    var out: VertexOutput;
    out.uv = texCoord * uvt.xy + uvt.zw;
    out.dissolve = vec2<f32>(objectParams(objectIndex).x, u_transform.u_ditherPhase);
    out.position = u_transform.u_projection * u_transform.u_view * model
                 * vec4<f32>(position, 1.0);
    return out;
}
