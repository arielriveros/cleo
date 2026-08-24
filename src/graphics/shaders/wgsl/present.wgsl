// Final present / resolve pass.
//
// The scene has been rendered and post-processed in LINEAR HDR; this is the single place exposure,
// tonemapping and sRGB encoding are applied before hitting the display.
//
// The first program with scalar uniforms, which is the point of it: naga puts those in a std140 block,
// and the engine has never bound one. Struct fields carry the engine's uniform names so the existing
// setUniform('u_exposure', ...) call sites keep working unchanged.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/tonemap.wgsl"

struct PresentUniforms {
    u_exposure: f32,
    // Offscreen thumbnail capture: make the background transparent so asset previews composite over
    // the editor's UI. Coverage comes from the scene DEPTH (1.0 == nothing was drawn) rather than the
    // scene colour's alpha, which carries the bloom mask and would erase dark, non-blooming assets.
    // 0 = opaque background (on-screen), 1 = transparent (thumbnail).
    u_alphaFromDepth: f32,
};

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(0) @binding(2) var u_coverageDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_coverageDepth_sampler: sampler;
@group(1) @binding(0) var<uniform> u_present: PresentUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let hdr = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv).rgb;

    var alpha = 1.0;
    if (u_present.u_alphaFromDepth > 0.5) {
        let coverage = textureSampleLevel(u_coverageDepth_texture, u_coverageDepth_sampler, in.uv, 0);
        alpha = select(0.0, 1.0, coverage < 1.0);
    }

    return vec4<f32>(tonemap(hdr, u_present.u_exposure), alpha);
}
