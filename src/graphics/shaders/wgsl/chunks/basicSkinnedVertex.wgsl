// Unlit skinned vertex stage. The GLSL twin is materials/basic_skinned.vs.
//
// Bone indices and weights sit at locations 2 and 3 here, NOT 5 and 6 as in the lit skinned shader —
// this family has no normal/tangent/bitangent to occupy 1-4.

#include "./basicVarying.wgsl"

const MAX_BONES: i32 = 100;
const MAX_BONE_INFLUENCE: i32 = 4;

struct BasicSkinnedTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_boneMatrices: array<mat4x4<f32>, 100>,
};
@group(1) @binding(0) var<uniform> u_transform: BasicSkinnedTransform;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @location(2) boneIds: vec4<i32>,    // Joint indices (up to 4 bones per vertex)
    @location(3) weights: vec4<f32>,    // Joint weights (up to 4 weights per vertex)
) -> VertexOutput {
    var totalPosition = vec4<f32>(0.0);

    for (var i = 0; i < MAX_BONE_INFLUENCE; i++) {
        let id = boneIds[i];
        if (id == -1) { continue; }
        if (id >= MAX_BONES) { continue; }
        totalPosition += (u_transform.u_boneMatrices[id] * vec4<f32>(position, 1.0)) * weights[i];
    }

    // If no bone influences were applied, use the original position.
    if (all(totalPosition == vec4<f32>(0.0))) {
        totalPosition = vec4<f32>(position, 1.0);
    }

    var out: VertexOutput;
    out.uv = texCoord;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model * totalPosition;
    return out;
}
