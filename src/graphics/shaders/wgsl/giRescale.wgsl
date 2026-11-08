// GI store scale, changed in place (render/gi/giSystem.ts `_rescale`): every texel of the irradiance atlas
// multiplied by u_scale through a MULTIPLY blend (destination x source). The volumes' light is stored x the
// frame's pre-exposure as it was when they were last reset (fp16 keeps a moonlit night out of its
// subnormals); when the exposure drifts far from it, the stored light follows instead of being thrown away
// and relit from nothing. The pre-exposure is a power of two, so the multiply is exact.
//
// The alpha written is 1, which the blend's alpha half leaves alone.

#include "./chunks/fullscreen.wgsl"

// Any texture: read for nothing, so the program's group 0 is not empty (a pipeline layout with no group 0
// would refuse the bind group every fullscreen pass sets there).
@group(0) @binding(0) var u_anchor_texture: texture_2d<f32>;
@group(0) @binding(1) var u_anchor_sampler: sampler;

struct GiRescaleUniforms {
    u_scale: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
@group(1) @binding(0) var<uniform> u_rescale: GiRescaleUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let anchor = textureSampleLevel(u_anchor_texture, u_anchor_sampler, in.uv, 0.0).a * 0.0;
    return vec4<f32>(vec3<f32>(u_rescale.u_scale + anchor), 1.0);
}
