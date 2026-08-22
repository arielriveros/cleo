// Linear-blend skinning vertex stage. The GLSL twin is materials/pbr_skinned.vs.
//
// The normal, tangent and bitangent are skinned by the bone matrices' ROTATION part alone, which is
// why each uses a mat3 narrowing of the bone matrix rather than the full transform.

#include "./modelVarying.wgsl"

const MAX_BONES: i32 = 100;
const MAX_BONE_INFLUENCE: i32 = 4;

struct SkinnedTransform {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_boneMatrices: array<mat4x4<f32>, 100>,
};
@group(1) @binding(0) var<uniform> u_transform: SkinnedTransform;

/** The rotation/scale part of a bone matrix. WGSL has no mat3(mat4) narrowing constructor. */
fn boneRotation(m: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(m[0].xyz, m[1].xyz, m[2].xyz);
}

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) boneIds: vec4<i32>,    // Joint indices (up to 4 bones per vertex)
    @location(6) weights: vec4<f32>,    // Joint weights (up to 4 weights per vertex)
) -> VertexOutput {
    var totalPosition = vec4<f32>(0.0);
    var totalNormal = vec3<f32>(0.0);
    var totalTangent = vec3<f32>(0.0);
    var totalBitangent = vec3<f32>(0.0);

    for (var i = 0; i < MAX_BONE_INFLUENCE; i++) {
        let id = boneIds[i];
        if (id == -1) { continue; }
        if (id >= MAX_BONES) { continue; }

        let bone = u_transform.u_boneMatrices[id];
        let rot = boneRotation(bone);
        totalPosition += (bone * vec4<f32>(position, 1.0)) * weights[i];
        totalNormal += (rot * normal) * weights[i];
        totalTangent += (rot * tangent) * weights[i];
        totalBitangent += (rot * bitangent) * weights[i];
    }

    // If no bone influences were applied, use the original attributes.
    if (all(totalPosition == vec4<f32>(0.0))) {
        totalPosition = vec4<f32>(position, 1.0);
        totalNormal = normal;
        totalTangent = tangent;
        totalBitangent = bitangent;
    }

    var out: VertexOutput;
    fillVarying(&out, u_transform.u_model, totalPosition.xyz, texCoord,
                totalNormal, totalTangent, totalBitangent);
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model * totalPosition;
    return out;
}
