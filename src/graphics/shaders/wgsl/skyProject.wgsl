// Equirectangular unwrap of the sky cubemap, RGBM-encoded, for CPU-side spherical-harmonic projection.
//
// A sibling of probePreview.wgsl and deliberately so: it uses the IDENTICAL uv -> direction mapping, so
// the CPU can reconstruct each texel's direction from its row and column without knowing anything about
// the backend. That property is the one probePreview documents — the screen quad hands row 0 the same
// `uv.y` on both backends, so row 0 is the south pole either way — and it is what keeps this readback
// from needing a per-backend flip.
//
// It is NOT probePreview with a flag, for one reason: that pass tonemaps, and tonemapping is exactly
// what must not happen to a signal about to be integrated into irradiance.
//
// RGBM RATHER THAN A FLOAT TARGET, because WebGL2's readback refuses anything but an 8-bit, 4-byte
// colour format outright ("readPixels needs an 8-bit colour target on WebGL2"). The sky is linear HDR —
// `sunIntensity` alone defaults to 22 — so it has to be encoded to survive the trip. RGBM's ~8 bits of
// relative precision is far more than an irradiance integral needs; a raw rgba8 would clip the sky to 1.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/tonemap.wgsl"

const PI: f32 = 3.14159265359;
/** Shared with the decoder in renderer.ts. Comfortably above the sky's peak, including the sun disk. */
const RGBM_RANGE: f32 = 64.0;

@group(0) @binding(0) var u_cube_texture: texture_cube<f32>;
@group(0) @binding(1) var u_cube_sampler: sampler;

struct SkyProjectUniforms {
    /** 1 = the cube is already linear HDR (a baked atmosphere); 0 = sRGB-authored (a user skybox). */
    u_linearInput: f32,
};
@group(1) @binding(0) var<uniform> u_project: SkyProjectUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // u -> longitude [-PI, PI], v -> latitude [-PI/2, PI/2] (v=0 bottom, v=1 top).
    let lon = (in.uv.x - 0.5) * 2.0 * PI;
    let lat = (in.uv.y - 0.5) * PI;
    let cosLat = cos(lat);
    let dir = normalize(vec3<f32>(cosLat * sin(lon), sin(lat), -cosLat * cos(lon)));

    // Level 0 explicitly. This is a small target sampling a large cube, so the implicit derivative would
    // pick a high mip and hand back a pre-blurred sky — harmless for a preview, wrong for an integral
    // that is about to do its own averaging with proper solid-angle weights.
    var radiance = textureSampleLevel(u_cube_texture, u_cube_sampler, dir, 0.0).rgb;
    if (u_project.u_linearInput < 0.5) { radiance = toLinear(radiance); }

    let peak = max(max(radiance.r, radiance.g), radiance.b);
    // `ceil` to 1/255 rather than round: the multiplier must never quantize BELOW the value it is
    // scaling, or the division below pushes a channel past 1.0 and the target clamps it away.
    let m = max(ceil(clamp(peak / RGBM_RANGE, 0.0, 1.0) * 255.0) / 255.0, 1.0 / 255.0);
    return vec4<f32>(radiance / (RGBM_RANGE * m), m);
}
