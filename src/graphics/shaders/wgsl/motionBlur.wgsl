// McGuire 2012 "A Reconstruction Filter for Plausible Motion Blur" (the basis of UE's filter).

#include "./chunks/fullscreen.wgsl"

// Upper bound for the dynamic sample loop (actual count comes from u_samples). WGSL has no
// preprocessor, so this is a module-scope const rather than a #define — same role, and it is still a
// compile-time constant, which is what lets the loop bound be static.
const MAX_SAMPLES: i32 = 32;

// Soft depth-comparison extent, in linear (view-space) units.
const SOFT_Z_EXTENT: f32 = 1.0;

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;   // lit scene color
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(0) @binding(2) var u_velocity_texture: texture_2d<f32>;        // full-res per-pixel velocity (UV)
@group(0) @binding(3) var u_velocity_sampler: sampler;
@group(0) @binding(4) var u_neighborMax_texture: texture_2d<f32>;     // tile-res dilated velocity (UV)
@group(0) @binding(5) var u_neighborMax_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_depth_2d;          // device depth
@group(0) @binding(7) var u_gDepth_sampler: sampler;

struct MotionBlurUniforms {
    u_texelSize: vec2<f32>,    // 1 / full-res dimensions
    u_screenSize: vec2<f32>,   // full-res dimensions (px)
    u_near: f32,
    u_far: f32,
    u_samples: i32,            // taps per pixel
};
@group(1) @binding(0) var<uniform> u_mb: MotionBlurUniforms;

fn linearizeDepth(d: f32) -> f32 {
    let z = d * 2.0 - 1.0;
    return (2.0 * u_mb.u_near * u_mb.u_far)
         / (u_mb.u_far + u_mb.u_near - z * (u_mb.u_far - u_mb.u_near));
}

// Cheap per-pixel dither to break up banding between the discrete taps.
fn interleavedGradientNoise(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// 1 when za is in front of zb (within the soft extent), 0 when clearly behind.
fn softDepthCompare(za: f32, zb: f32) -> f32 {
    return clamp(1.0 - (za - zb) / SOFT_Z_EXTENT, 0.0, 1.0);
}

// Falls off linearly as the tap distance approaches the velocity length.
fn cone(dist: f32, velLen: f32) -> f32 {
    return clamp(1.0 - dist / velLen, 0.0, 1.0);
}

// Near-flat contribution for taps well within a blurred sample's own trail.
fn cylinder(dist: f32, velLen: f32) -> f32 {
    return 1.0 - smoothstep(0.95 * velLen, 1.05 * velLen, dist);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let centerColor = textureSample(u_screenTexture_texture, u_screenTexture_sampler, uv).rgb;

    // Dominant velocity for this tile (pixels). If nothing is moving, pass the pixel through.
    let vN = textureSample(u_neighborMax_texture, u_neighborMax_sampler, uv).xy;
    let vNlen = length(vN * u_mb.u_screenSize);
    if (vNlen < 0.5) {
        return vec4<f32>(centerColor, 1.0);
    }

    // `textureSampleLevel(..., 0.0)`, not `textureSample`, from here down.
    //
    // Everything below the early return above is in NON-UNIFORM control flow — whether a fragment gets
    // here depends on its own tile velocity — and WGSL forbids an implicit-LOD sample there, because
    // the derivative it would need is only defined across a quad that took the same branch. Dawn
    // refuses the whole module ("'textureSample' must only be called from uniform control flow"), and
    // an invalid module means an invalid pipeline, which means every draw recorded against it silently
    // does nothing. WebGL2 has no such rule, which is why it never complained.
    //
    // The explicit level is not a behaviour change: these are screen-sized post targets with no mip
    // chain, so level 0 is what the implicit form already resolved to. Same fix, same reason, as the
    // one `ssao` and `deferredLighting` already carry.
    let vCenter = textureSampleLevel(u_velocity_texture, u_velocity_sampler, uv, 0.0);

    // .z is the velocity buffer's "leave this pixel alone" flag, written by objects whose motionBlur
    // mode is 'none'. Zero velocity alone would not be enough: this filter deliberately lets a blurred
    // FOREGROUND sample cover a sharp centre (the `fg * cone` term), so a hero standing still in front
    // of a whipping background would still be smeared by it. The flag is the only way to say "never".
    if (vCenter.z > 0.5) {
        return vec4<f32>(centerColor, 1.0);
    }

    let vC = vCenter.xy;
    let vClen = max(length(vC * u_mb.u_screenSize), 0.5);
    let centerDepth = linearizeDepth(textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0));

    // `in.position` is the fragment coordinate — WGSL's gl_FragCoord.
    let jitter = interleavedGradientNoise(in.position.xy) - 0.5;
    let samples = u_mb.u_samples;

    // Weighted accumulation, seeded with the center tap.
    var weight = 1.0 / vClen;
    var result = centerColor * weight;

    for (var i = 0; i < MAX_SAMPLES; i++) {
        if (i >= samples) { break; }

        // Symmetric, jittered position along the dominant velocity, skipping the exact center.
        let t = mix(-1.0, 1.0, (f32(i) + jitter + 1.0) / (f32(samples) + 1.0));
        let sampleUV = uv + vN * t;

        let vS = textureSampleLevel(u_velocity_texture, u_velocity_sampler, sampleUV, 0.0).xy;
        let vSlen = max(length(vS * u_mb.u_screenSize), 0.5);
        let sampleDepth = linearizeDepth(textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, sampleUV, 0));

        let dist = abs(t) * vNlen;

        // linearizeDepth is positive-forward (larger = farther).
        let bg = softDepthCompare(centerDepth, sampleDepth); // 1 when center is closer -> sample is background
        let fg = softDepthCompare(sampleDepth, centerDepth); // 1 when sample is closer -> sample is foreground

        let alpha = fg * cone(dist, vSlen) +                 // blurry foreground sample covers center
                    bg * cone(dist, vClen) +                 // center's own blur reveals background sample
                    cylinder(dist, vSlen) * cylinder(dist, vClen) * 2.0; // both blurry, similar depth

        weight += alpha;
        result += textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, sampleUV, 0.0).rgb * alpha;
    }

    return vec4<f32>(result / weight, 1.0);
}
