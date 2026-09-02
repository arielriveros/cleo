// Composite the half-res lens flare back over the image, modulated by the lens-dirt overlay.
//
// Drawn with ADDITIVE_BLEND, so this returns the CONTRIBUTION rather than the finished pixel and never
// reads the destination. That is what lets it run in place on a chain stage — see the `readWrites`
// declaration on the `lensFlare` node in `Renderer._buildPostGraph`.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_flare_texture: texture_2d<f32>;     // half-res ghosts + halo
@group(0) @binding(1) var u_flare_sampler: sampler;
@group(0) @binding(2) var u_lensDirt_texture: texture_2d<f32>;  // smudges, stretched to the frame
@group(0) @binding(3) var u_lensDirt_sampler: sampler;

struct LensFlareCompositeUniforms {
    u_flareIntensity: f32,
    /**
     * How much the dirt overlay boosts the flare it catches. 0 while the mask is still decoding, so a
     * frame never composites against the white fallback and flashes to double brightness.
     */
    u_dirtIntensity: f32,
};
@group(1) @binding(0) var<uniform> u_flareComposite: LensFlareCompositeUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Bilinear off the half-res buffer is the upsample: the flare is smooth by construction, so a tent
    // filter here would cost four taps to soften something that has no detail to preserve.
    let flare = textureSample(u_flare_texture, u_flare_sampler, in.uv).rgb;
    let dirt = textureSample(u_lensDirt_texture, u_lensDirt_sampler, in.uv).rgb;

    // `1 + dirt * k` for the same reason the bloom composite uses it: dirt may only add glare where the
    // lens is smeared, never subtract it where the lens is clean.
    let gain = vec3<f32>(1.0) + dirt * u_flareComposite.u_dirtIntensity;

    // Alpha 0, not 1. ADDITIVE_BLEND spells out its alpha half as `one, one`, so a 1 here would add
    // into the destination's alpha — which carries the bloom mask, not coverage.
    return vec4<f32>(flare * u_flareComposite.u_flareIntensity * gain, 0.0);
}
