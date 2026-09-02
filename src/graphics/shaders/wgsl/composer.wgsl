// Composite: scene plus bloom, both in linear HDR, before the single exposure/ACES resolve in present.
//
// This is also where the LENS DIRT overlay is applied, and it belongs here rather than in a pass of its
// own: dirt on the front element is only visible because it catches glare. A dirt texture composited
// over the image on its own would just be a semi-transparent photograph of a dirty lens; what makes it
// read is that it MODULATES a glow that is already there. Unreal and Unity HDRP both apply it in
// exactly this spot, for the same reason.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_buffer1_texture: texture_2d<f32>;   // scene (linear HDR)
@group(0) @binding(1) var u_buffer1_sampler: sampler;
@group(0) @binding(2) var u_buffer2_texture: texture_2d<f32>;   // blurred bloom (linear HDR)
@group(0) @binding(3) var u_buffer2_sampler: sampler;
@group(0) @binding(4) var u_lensDirt_texture: texture_2d<f32>;  // smudges/streaks, stretched to the frame
@group(0) @binding(5) var u_lensDirt_sampler: sampler;

struct ComposerUniforms {
    u_bloomIntensity: f32,   // how strongly bloom is added back
    /**
     * How much the dirt overlay boosts the bloom it catches. 0 leaves the composite exactly as it was
     * before dirt existed — which is also what is uploaded while the texture is still decoding, so a
     * frame never composites against an undecoded (white) fallback.
     */
    u_dirtIntensity: f32,
};
@group(1) @binding(0) var<uniform> u_composer: ComposerUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let scene = textureSample(u_buffer1_texture, u_buffer1_sampler, in.uv).rgb;
    let bloom = textureSample(u_buffer2_texture, u_buffer2_sampler, in.uv).rgb;
    let dirt = textureSample(u_lensDirt_texture, u_lensDirt_sampler, in.uv).rgb;

    // `1 + dirt * k`, not `dirt * k`: dirt may only ever ADD glare where the lens is smeared, never
    // subtract it where the lens is clean. Multiplying outright would make a black patch of the mask
    // erase bloom that the scene genuinely produced.
    let gain = vec3<f32>(1.0) + dirt * u_composer.u_dirtIntensity;
    return vec4<f32>(scene + bloom * u_composer.u_bloomIntensity * gain, 1.0);
}
