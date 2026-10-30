// Robust contrast-adaptive sharpening (AMD FidelityFX RCAS), run on the TAA resolve's output.
//
// TAA trades aliasing for softness: every frame blends jittered samples whose footprints overlap, and
// even a Catmull-Rom history fetch filters a little. This puts back the high frequencies without
// putting back the aliasing, and does it on the copy that goes on to the screen, NOT on the history —
// sharpening a feedback loop compounds frame over frame into ringing.
//
// "Robust" because the lobe is limited per pixel to what the 4-neighbourhood can absorb without the
// result leaving its own [min, max] range, so it cannot ring or create halos on a hard edge, and it
// does nearly nothing in flat regions where sharpening would only lift noise.
//
// In a range-compressed space for the same reason the resolve blends in one: on raw HDR a single
// bright texel dominates the min/max and the limiter would switch sharpening off around every
// highlight. `c / (1 + max(c))` maps to [0, 1) per pixel without shifting hue and inverts exactly.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct SharpenUniforms {
    u_texelSize: vec2<f32>,
    /** 0 = off, 1 = the strongest RCAS allows. */
    u_sharpness: f32,
    /** The scene's exposure, so the compression above happens at display brightness. */
    u_exposure: f32,
};
@group(1) @binding(0) var<uniform> u_sharpen: SharpenUniforms;

// 0.25 - 1/16, AMD's limit: the most negative lobe that cannot invert a pixel's contrast.
const RCAS_LIMIT: f32 = 0.1875;

fn compress(c: vec3<f32>) -> vec3<f32> {
    return c / (1.0 + max(c.r, max(c.g, c.b)));
}

fn expand(c: vec3<f32>) -> vec3<f32> {
    return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4);
}

fn tap(uv: vec2<f32>, exposure: f32) -> vec3<f32> {
    return compress(max(textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0).rgb,
                        vec3<f32>(0.0)) * exposure);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let ts = u_sharpen.u_texelSize;
    let exposure = max(u_sharpen.u_exposure, 1e-4);
    let centre = textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0);

    let e = compress(max(centre.rgb, vec3<f32>(0.0)) * exposure);
    let b = tap(uv + vec2<f32>(0.0, -ts.y), exposure);
    let d = tap(uv + vec2<f32>(-ts.x, 0.0), exposure);
    let f = tap(uv + vec2<f32>(ts.x, 0.0), exposure);
    let h = tap(uv + vec2<f32>(0.0, ts.y), exposure);

    let mn = min(min(b, d), min(f, h));
    let mx = max(max(b, d), max(f, h));
    // How negative the lobe may go before the result undershoots the neighbourhood's min, and before
    // it overshoots its max; the tighter of the two wins.
    let hitMin = mn / max(4.0 * mx, vec3<f32>(1e-4));
    let hitMax = (vec3<f32>(1.0) - mx) / min(4.0 * mn - 4.0, vec3<f32>(-1e-4));
    let lobeRgb = max(-hitMin, hitMax);
    let lobe = max(-RCAS_LIMIT, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0))
               * clamp(u_sharpen.u_sharpness, 0.0, 1.0);

    let sharpened = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
    let rgb = expand(clamp(sharpened, vec3<f32>(0.0), vec3<f32>(0.9999))) / exposure;

    // Alpha is the bloom mask and passes through.
    return vec4<f32>(rgb, centre.a);
}
