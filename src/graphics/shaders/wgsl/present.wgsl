// Final present / resolve pass.
//
// The scene has been rendered and post-processed in LINEAR HDR; this is the single place exposure,
// tonemapping and sRGB encoding are applied before hitting the display.
//
// The first program with scalar uniforms, which is the point of it: naga puts those in a std140 block,
// and the engine has never bound one. Struct fields carry the engine's uniform names so the existing
// setUniform('u_exposure', ...) call sites keep working unchanged.

#include "./chunks/fullscreen.wgsl"
// grade.wgsl includes tonemap.wgsl itself. Including both here would declare toLinear() twice, and
// there are no include guards. colorLut.wgsl brings bindings 4/5 with it.
#include "./chunks/grade.wgsl"
#include "./chunks/colorLut.wgsl"
// Bindings 6/7: the local exposure regions (chunks/localExposure.wgsl).
#include "./chunks/localExposure.wgsl"

struct PresentUniforms {
    u_exposure: f32,
    /**
     * 1 = untouched. Below 1 drains colour toward luma.
     *
     * The artist trim, multiplied by the sky light's cloud response — an overcast sky really does
     * desaturate a scene, and most of that comes from the lighting itself (a white key and a flat fill),
     * but not all of it. This covers the rest without turning the whole feature into a filter.
     */
    u_saturation: f32,
    /** Which display transform to apply. The TONE_* constants in chunks/grade.wgsl. */
    u_toneMapper: i32,
    /** How far toward the colour LUT the display colour is pulled. 0 leaves the frame ungraded. */
    u_lutIntensity: f32,
    /** Edge length of the bound LUT volume; 2 when it is the identity placeholder. */
    u_lutSize: f32,
    // Offscreen thumbnail capture: make the background transparent so asset previews composite over
    // the editor's UI. Coverage comes from the scene DEPTH (1.0 == nothing was drawn) rather than the
    // scene colour's alpha, which carries the bloom mask and would erase dark, non-blooming assets.
    // 0 = opaque background (on-screen), 1 = transparent (thumbnail).
    u_alphaFromDepth: f32,
    /** Night vision (chunks/grade.wgsl purkinjeShift): 0 off .. 1 full. RenderSettings.purkinjeStrength. */
    u_purkinjeStrength: f32,
    /** cd/m2 per stored unit: REFERENCE_ILLUMINANCE over the frame's pre-exposure. */
    u_nitsPerUnit: f32,
    /** Local exposure (chunks/localExposure.wgsl): strength, shadow stops, highlight stops, guide sharpness. */
    u_localExposure: vec4<f32>,
};

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(0) @binding(2) var u_coverageDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_coverageDepth_sampler: sampler;
// Bindings 4/5 are the colour LUT, declared by chunks/grade.wgsl.
@group(1) @binding(0) var<uniform> u_present: PresentUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let hdr = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv).rgb;

    var alpha = 1.0;
    if (u_present.u_alphaFromDepth > 0.5) {
        let coverage = textureSampleLevel(u_coverageDepth_texture, u_coverageDepth_sampler, in.uv, 0);
        alpha = select(0.0, 1.0, coverage < 1.0);
    }

    var seen = purkinjeShift(hdr, u_present.u_nitsPerUnit, u_present.u_purkinjeStrength);
    // Local exposure: a smooth per-region shift, in stops, on top of the camera's (see the chunk).
    let exposedLum = dot(seen, vec3<f32>(0.2126, 0.7152, 0.0722)) * u_present.u_exposure;
    seen *= exp2(localExposureStops(in.uv, exposedLum, u_present.u_localExposure));
    let display = gradeToDisplay(seen, u_present.u_exposure, u_present.u_saturation,
                                 u_present.u_toneMapper);
    let graded = applyColorLut(display, u_present.u_lutSize, u_present.u_lutIntensity);
    return vec4<f32>(max(graded + displayDither(in.position.xy), vec3<f32>(0.0)), alpha);
}
