// objectVelocitySkinned.wgsl for the unlit Basic family, which has no normal/tangent/bitangent and so
// packs texCoord at location 1 and bone data at 2/3. A single shared program cannot read both layouts;
// binding the wrong one is what used to raise GL_INVALID_OPERATION in the shadow pass, and the fix
// there — a family-specific program, picked at draw time — is the fix here.

#include "./chunks/objectVelocity.wgsl"

const MAX_BONES: i32 = 100;
const MAX_BONE_INFLUENCE: i32 = 4;

struct ObjectVelocitySkinnedUniforms {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_uvViewProj: mat4x4<f32>,
    u_uvPrevViewProj: mat4x4<f32>,
    u_prevModel: mat4x4<f32>,
    u_screenSize: vec2<f32>,
    u_intensity: f32,
    u_maxVelocityPx: f32,
    u_noBlur: f32,
    u_boneMatrices: array<mat4x4<f32>, 100>,
    u_prevBoneMatrices: array<mat4x4<f32>, 100>,
};
@group(1) @binding(0) var<uniform> u_ov: ObjectVelocitySkinnedUniforms;

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @location(2) boneIds: vec4<i32>,
    @location(3) weights: vec4<f32>,
) -> VertexOutput {
    let local = vec4<f32>(position, 1.0);
    var skinned = vec4<f32>(0.0);
    var prevSkinned = vec4<f32>(0.0);

    for (var i = 0; i < MAX_BONE_INFLUENCE; i++) {
        let id = boneIds[i];
        if (id == -1) { continue; }
        if (id >= MAX_BONES) { continue; }
        skinned += (u_ov.u_boneMatrices[id] * local) * weights[i];
        prevSkinned += (u_ov.u_prevBoneMatrices[id] * local) * weights[i];
    }

    if (all(skinned == vec4<f32>(0.0))) {
        skinned = local;
        prevSkinned = local;
    }

    let world = u_ov.u_model * skinned;
    let prevWorld = u_ov.u_prevModel * prevSkinned;

    var out: VertexOutput;
    out.position = u_ov.u_projection * u_ov.u_view * world;
    out.curClip = u_ov.u_uvViewProj * world;
    out.prevClip = u_ov.u_uvPrevViewProj * prevWorld;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return encodeVelocity(in.curClip, in.prevClip, u_ov.u_screenSize,
                          u_ov.u_intensity, u_ov.u_maxVelocityPx, u_ov.u_noBlur);
}
