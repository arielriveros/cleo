// Per-object velocity for a SKINNED mesh: the vertex is skinned twice, once by this frame's bone
// palette and once by last frame's, so a running character's limbs streak while its torso does not.
// Rigid velocity alone cannot express that — the node transform is the same for every vertex.
//
// Declares the FULL lit skinned attribute set (0-6), not the narrow position+bones set shadowMapSkinned
// uses, and that is deliberate: `AnimatedModel.initializeVAO` is keyed by layout and rebuilds whenever
// the key changes, so matching the colour program's layout exactly means the geometry pass leaves the
// VAO in the shape this pass wants and neither of them re-strides it. normal/tangent/bitangent are
// declared and unused for that reason alone.
//
// The unlit Basic family packs bone data at locations 2/3 instead — see objectVelocityBasicSkinned.wgsl.

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
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) boneIds: vec4<i32>,
    @location(6) weights: vec4<f32>,
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

    // No influences: the bind pose, for both frames. Same fallback as shadowMapSkinned.wgsl.
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
