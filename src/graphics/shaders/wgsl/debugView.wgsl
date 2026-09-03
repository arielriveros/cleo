// Fullscreen debug visualiser: displays one renderer buffer (G-buffer channel, SSAO, depth, bloom, lit
// scene …) chosen by u_mode. Editor-only; published builds always use the plain 'screen' shader.

#include "./chunks/fullscreen.wgsl"
// grade.wgsl rather than tonemap.wgsl: the linear-HDR channels below resolve with the SCENE's tone
// curve, so "Lit Scene" cannot disagree with "Final" about what the frame looks like. Deliberately
// NOT colorLut.wgsl — a preview of an internal buffer is a picture of the BUFFER, and a grade on
// top would misreport it. That is also why this pass carries no LUT binding to satisfy.
#include "./chunks/grade.wgsl"
#include "./chunks/octNormal.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
// The depth channel needs its OWN binding, and it is bound on every frame rather than only for mode 3.
//
// A depth-format texture cannot satisfy a `texture_2d<f32>` declaration - WebGPU refuses the bind group
// ("None of the supported sample types (UnfilterableFloat|Depth) ... match the expected sample types
// (Float)"), which invalidates the command buffer and blanks the channel. WebGL2 accepted the same
// texture through the colour sampler, which is why one binding served every mode for as long as it did.
// Always bound because WebGPU requires every declared binding to be present; the other modes ignore it.
@group(0) @binding(2) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(3) var u_gDepth_sampler: sampler;

struct DebugViewUniforms {
    u_exposure: f32,    // for the tonemapped (linear-HDR) channels
    u_mode: i32,
    u_toneMapper: i32,  // TONE_* in chunks/grade.wgsl
    u_validity: i32,    // != 0: paint invalid texels instead of rendering the channel
};
@group(1) @binding(0) var<uniform> u_debug: DebugViewUniforms;

/**
 * A magnitude no finite render value ever reaches, used to test for one. See `the validity overlay`.
 *
 * DELIBERATELY NOT the exact f32 maximum (3.40282347e38). A literal is converted against the
 * type's limit BEFORE it is rounded, so a decimal spelling of the maximum reads as larger than the
 * maximum and is a shader-creation error on Tint -- while naga rounds it to the maximum and accepts
 * it, so the WebGL2 build stays green and only the WebGPU one dies, with `[Invalid RenderPipeline]`
 * and no clue which line. Any large finite threshold answers the question being asked here.
 */
const F32_MAX: f32 = 3.0e38;

/**
 * Overdraw heat map, black -> blue -> green -> yellow -> red.
 *
 * That ramp is the convention every GPU profiler uses, so the reading transfers. This is the view that
 * makes a fill-rate problem legible: draw-call and triangle counts say nothing about how many times each
 * pixel was shaded, and on a deferred renderer with a lot of alpha-blended overlays that number is
 * exactly what costs the frame.
 */
fn heatMap(value: f32) -> vec3<f32> {
    let n = clamp(value, 0.0, 1.0);
    if (n < 0.25) { return mix(vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(0.0, 0.2, 1.0), n / 0.25); }
    if (n < 0.5)  { return mix(vec3<f32>(0.0, 0.2, 1.0), vec3<f32>(0.0, 1.0, 0.3), (n - 0.25) / 0.25); }
    if (n < 0.75) { return mix(vec3<f32>(0.0, 1.0, 0.3), vec3<f32>(1.0, 1.0, 0.0), (n - 0.5) / 0.25); }
    return mix(vec3<f32>(1.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), (n - 0.75) / 0.25);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let t = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);
    let mode = u_debug.u_mode;

    // VALUE-VALIDITY OVERLAY. Paints a flat classification colour for any texel this buffer should
    // never be able to hold. It composes with every channel below rather than being a channel of its
    // own, so one toggle audits the G-buffer, the lit scene, SSAO, velocity and the TAA history in
    // turn — which is what a hunt for the pass that emits a bad value actually needs.
    //
    // WGSL has no `isnan`/`isinf`, and it does not need one: EVERY comparison against NaN is false,
    // which is exactly the property being tested. `finite` therefore fails for NaN and for the
    // infinities alike, while `inf` is true only for the infinities, so the difference isolates NaN
    // without naming it. This form also survives translation to GLSL ES 300 unchanged, where a
    // literal `isnan()` is permitted but is free to be optimised away under a no-NaN assumption.
    //
    // Inf deserves its own colour rather than being folded in with NaN: every one of these targets is
    // rgba16float, so an Inf here most likely means a value that EXCEEDED 65504 on store rather than
    // a division by zero, and the two have different repairs.
    if (u_debug.u_validity != 0) {
        let inf = any(abs(t) > vec4<f32>(F32_MAX));
        let finite = all(t >= vec4<f32>(-F32_MAX)) && all(t <= vec4<f32>(F32_MAX));
        if (!finite && !inf) { return vec4<f32>(1.0, 0.0, 1.0, 1.0); }   // NaN            -> magenta
        if (inf) { return vec4<f32>(1.0, 0.55, 0.0, 1.0); }              // +-Inf/overflow -> orange
        // A NEGATIVE is a defect only where the channel's own encoding forbids one. Radiance, albedo,
        // emissive and the packed scalars cannot go below zero; an octahedral normal (mode 1, and the
        // rg of the metallic/roughness channels) and a motion vector (mode 5) are signed by
        // construction. Testing all four components everywhere would paint those solid cyan and the
        // overlay would report nothing at all.
        var neg = false;
        if (mode == 0 || mode == 6) { neg = any(t.rgb < vec3<f32>(0.0)); }
        if (mode == 2) { neg = t.a < 0.0; }
        if (mode == 4 || mode == 7) { neg = t.r < 0.0; }
        if (neg) { return vec4<f32>(0.0, 0.9, 1.0, 1.0); }               // negative       -> cyan
    }

    // World-space normals, DECODED from the octahedral pair first — displaying the raw rg would show
    // the encoding rather than the normal, which looks plausible enough to be believed.
    if (mode == 1) { return vec4<f32>(octDecode(vec2<f32>(t.r, t.g)) * 0.5 + 0.5, 1.0); }
    // Scalar packed in the alpha channel (metallic / roughness / ambient occlusion).
    if (mode == 2) { return vec4<f32>(vec3<f32>(t.a), 1.0); }
    // Non-linear depth; a contrast curve spreads the far-weighted range so structure shows. Read from
    // the dedicated depth binding, and with an explicit INTEGER level, which is what WGSL requires of a
    // depth texture.
    if (mode == 3) {
        let d = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, in.uv, 0);
        return vec4<f32>(vec3<f32>(pow(d, 40.0)), 1.0);
    }
    // Single-channel value in .r (SSAO occlusion factor).
    if (mode == 4) { return vec4<f32>(vec3<f32>(t.r), 1.0); }
    // Screen-space velocity (RAW motion in UV units in .rg). Amplify + bias so it is visible.
    // The gain is calibrated so full scale is 1/15 uv of motion per frame — about 128 px at 1080p.
    // It used to see the shutter-scaled, tile-clamped form, which could never exceed 20 px however
    // fast a thing moved; the buffer is raw now, so the channel shows true motion and saturates.
    // Velocity: .rg is the motion vector, amplified and biased to mid-grey. .b is the no-blur flag —
    // flat red, so a model excluded from motion blur is identifiable at a glance rather than being
    // indistinguishable from one that simply is not moving.
    if (mode == 5) {
        if (t.b > 0.5) { return vec4<f32>(0.9, 0.15, 0.15, 1.0); }
        return vec4<f32>(t.rg * 15.0 + 0.5, 0.5, 1.0);
    }
    // Linear-HDR channels (lit scene, bloom): resolve to display so the preview matches the image.
    if (mode == 6) {
        return vec4<f32>(toSrgb(toneCurve(t.rgb * u_debug.u_exposure, u_debug.u_toneMapper)), 1.0);
    }
    if (mode == 7) { return vec4<f32>(heatMap(t.r), 1.0); }
    // Passthrough RGB (albedo, emissive, …).
    return vec4<f32>(t.rgb, 1.0);
}
