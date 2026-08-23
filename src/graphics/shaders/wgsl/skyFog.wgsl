// Atmospheric distance fog for the SkyAtmosphere node (aerial perspective).
//
// A single fullscreen pass: for each opaque pixel we reconstruct world position from depth, derive a fog
// factor from distance (plus optional height falloff), and take the fog COLOUR by sampling the
// already-baked atmosphere cubemap in that pixel's view direction — so geometry fades into exactly the
// sky colour behind it. Output is straight-alpha (blended with SRC_ALPHA, ONE_MINUS_SRC_ALPHA) so it
// only tints the scene toward the fog colour; the sky (depth == 1.0) is skipped since it already IS
// that colour.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_gDepth_texture: texture_2d<f32>;        // scene depth (opaque), background 1.0
@group(0) @binding(1) var u_gDepth_sampler: sampler;
// baked sky cubemap (display-referred), sampled for the fog colour
@group(0) @binding(2) var u_atmosphere_texture: texture_cube<f32>;
@group(0) @binding(3) var u_atmosphere_sampler: sampler;

struct SkyFogUniforms {
    u_invViewProj: mat4x4<f32>,
    u_viewPos: vec3<f32>,
    u_fogColor: vec3<f32>,
    u_fogDensity: f32,
    u_fogStart: f32,
    u_fogHeight: f32,
    u_fogHeightFalloff: f32,
    u_fogMaxOpacity: f32,
    u_fogColorBlend: f32,   // 0 = pure atmosphere colour, 1 = pure custom colour
    // Mip to sample the atmosphere at: blurs out the sharp sun disk so fog reads as colour haze rather
    // than a crisp window to the sky.
    u_fogSkyLod: f32,
};
@group(1) @binding(0) var<uniform> u_fog: SkyFogUniforms;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_fog.u_invViewProj * clip;
    return world.xyz / world.w;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depth = textureSample(u_gDepth_texture, u_gDepth_sampler, in.uv).r;
    // Sky: already the atmosphere colour, so do not fog it. The margin below 1.0 guards against anything
    // that rasterizes at forced far depth (NDC z = w) leaving pixels a float-epsilon short of the clear
    // value — fogging those produces a z-fighting-like shimmer. Real geometry that close to the far
    // plane is fog-saturated to the sky colour anyway, so skipping it is invisible.
    if (depth >= 0.999999) { discard; }

    let worldPos = reconstructWorldPos(in.uv, depth);
    let toPixel = worldPos - u_fog.u_viewPos;
    let dist = length(toPixel);
    let viewDir = toPixel / max(dist, 1e-5);

    // Fog colour = atmosphere in this view direction (from a blurred mip so the sharp sun disk does not
    // show "through" objects), optionally tinted toward a custom colour.
    let atmoColor = textureSampleLevel(u_atmosphere_texture, u_atmosphere_sampler, viewDir,
                                       u_fog.u_fogSkyLod).rgb;
    let fogColor = mix(atmoColor, u_fog.u_fogColor, u_fog.u_fogColorBlend);

    // Exponential distance fog beyond the start distance.
    let d = max(0.0, dist - u_fog.u_fogStart);
    let distFog = 1.0 - exp(-d * u_fog.u_fogDensity);

    // Optional height falloff: thinner with altitude above u_fogHeight (0 falloff = uniform fog).
    var heightFactor = 1.0;
    if (u_fog.u_fogHeightFalloff > 0.0) {
        heightFactor = clamp(exp(-max(0.0, worldPos.y - u_fog.u_fogHeight) * u_fog.u_fogHeightFalloff),
                             0.0, 1.0);
    }

    let f = clamp(distFog * heightFactor, 0.0, u_fog.u_fogMaxOpacity);
    if (f <= 0.0) { discard; }

    return vec4<f32>(fogColor, f);
}
