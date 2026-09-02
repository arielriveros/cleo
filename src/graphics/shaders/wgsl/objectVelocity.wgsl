// Per-object velocity for a rigid mesh: where this fragment's surface point sat on screen last frame,
// given where its MODEL was last frame rather than the camera-reprojection pass's assumption that the
// world point never moved.
//
// Declares position alone, as shadowMap.wgsl does. The mesh's vertex buffer was packed for whatever
// material the node wears — 20 bytes for an unlit one, 56 for a lit one — so the pipeline is told the
// real stride through `builtFor`, and nothing here re-strides the VAO.

#include "./chunks/objectVelocity.wgsl"

struct ObjectVelocityUniforms {
    u_model: mat4x4<f32>,
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,      // via _clipProjection: rasterization only, so depth matches the G-buffer
    u_uvViewProj: mat4x4<f32>,      // via _uvProducing(viewProj)
    u_uvPrevViewProj: mat4x4<f32>,  // via _uvProducing(prevViewProj) — or of viewProj, for 'objectOnly'
    u_prevModel: mat4x4<f32>,
    u_screenSize: vec2<f32>,
    u_intensity: f32,
    u_maxVelocityPx: f32,
    u_noBlur: f32,
};
@group(1) @binding(0) var<uniform> u_ov: ObjectVelocityUniforms;

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    let local = vec4<f32>(position, 1.0);
    let world = u_ov.u_model * local;
    let prevWorld = u_ov.u_prevModel * local;

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
