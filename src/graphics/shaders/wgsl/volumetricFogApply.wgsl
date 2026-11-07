// Volumetric fog, pass 3: put the fog over the opaque scene. The integrated froxel at each pixel's depth —
// the light scattered toward the camera in front of the surface, and how much of the surface still shows
// through — composited as `colour * T + S` (blend: one, src-alpha). The alpha the shader writes is the
// transmittance, which the blend's colour half consumes; the alpha half keeps the scene's bloom mask. See
// chunks/volumetricFogCommon.wgsl.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/volumetricFogCommon.wgsl"

@group(0) @binding(0) var u_integrated_texture: texture_2d<f32>;
@group(0) @binding(1) var u_integrated_sampler: sampler;
@group(0) @binding(2) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_sceneDepth_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depth = textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, in.uv, 0);
    // The sky (and anything past the fog's reach) takes the whole column.
    var viewDepth = u_fogv.u_far;
    if (depth < 0.999999) {
        let p = fogWorldAt(in.uv, depth);
        viewDepth = min(dot(p - u_fogv.u_camPos, u_fogv.u_camForward), u_fogv.u_far);
    }
    if (viewDepth <= u_fogv.u_near) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    // The integrated texel s holds the column up to the FAR edge of slice s, so the depth maps to the
    // texel whose far edge it is: slice coordinate minus one half-step back from the texel centre.
    let z = fogDepthSlice(viewDepth) - 0.5;
    let fog = fogSampleAtlas(u_integrated_texture, u_integrated_sampler, in.uv, z);
    return vec4<f32>(fog.rgb, clamp(fog.a, 0.0, 1.0));
}
