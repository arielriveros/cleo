// Film grain: the sensor's or the emulsion's own noise, added last so nothing in the lens follows it.
//
// Two things make grain read as film rather than as video noise. It is SCALED BY LUMINANCE with a
// curve that peaks in the midtones — real grain is silver halide, and a fully exposed or fully black
// patch has none — and it is ANIMATED, because a static pattern reads as dirt on the screen instead.
//
// Applied in linear HDR, before the tone curve, which is where Unreal applies it. Grain will therefore
// be more visible in midtones than in highlights, since the curve compresses what is above them. That
// is the film-like behaviour and it is intended; Unity's post-tonemap grain has uniform visibility.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct FilmGrainUniforms {
    /** 0 = off. Around 0.05 is a subtle 35mm stock; past ~0.3 it reads as sensor noise. */
    u_grainIntensity: f32,
    /** Grain cell size in pixels. 1 is per-pixel and will alias under TAA; ~1.5-3 is filmic. */
    u_grainSize: f32,
    /** Non-zero tints each channel independently, as colour film does; zero is monochrome grain. */
    u_grainColored: f32,
    /** Seconds. Animates the pattern — a fixed one looks like a dirty screen, not like film. */
    u_time: f32,
    u_resolution: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_grain: FilmGrainUniforms;

/**
 * A cheap hash with no visible axis-aligned structure.
 *
 * The classic `fract(sin(dot(p, k)) * n)` is deliberately avoided: `sin` at large arguments is
 * precision-dependent, and the two backends do not agree on it — the same frame would grain
 * differently on WebGL2 and WebGPU. This is integer-free but uses only multiply and fract, which both
 * evaluate identically.
 */
fn hash21(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2<f32>(0.1031, 0.1030));
    q = q + vec2<f32>(dot(q, q.yx + 33.33));
    return fract((q.x + q.y) * q.x);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);

    // Quantise to grain cells in PIXELS, not in uv, so the grain does not change size with the window.
    let cell = max(1e-3, u_grain.u_grainSize);
    let p = floor(in.uv * u_grain.u_resolution / cell);

    // A whole number of seconds apart would repeat the pattern exactly; the offsets are irrational
    // enough that it does not, and are per-channel so colour grain decorrelates.
    let t = u_grain.u_time;
    let mono = hash21(p + vec2<f32>(t * 71.13, t * 47.71)) - 0.5;
    let noise = mix(
        vec3<f32>(mono),
        vec3<f32>(mono,
                  hash21(p + vec2<f32>(t * 39.31 + 17.0, t * 61.17 + 5.0)) - 0.5,
                  hash21(p + vec2<f32>(t * 53.77 + 91.0, t * 29.13 + 43.0)) - 0.5),
        u_grain.u_grainColored);

    // Response peaks in the midtones and vanishes at both ends. `sqrt(l)*(1-l)` normalised to ~1 at its
    // peak: black stays black (no grain floating over a letterbox) and a blown highlight stays clean.
    let luma = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let l = clamp(luma, 0.0, 1.0);
    let response = sqrt(l) * (1.0 - l) * 2.6;

    // ADDITIVE, scaled by the response rather than by the colour: multiplying would leave the shadows
    // untouched, which is the opposite of how film behaves.
    let grain = noise * u_grain.u_grainIntensity * response;
    return vec4<f32>(max(color.rgb + grain, vec3<f32>(0.0)), color.a);
}
