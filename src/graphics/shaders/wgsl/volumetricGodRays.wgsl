// Volumetric god rays: raymarch from the camera along each pixel's view ray (bounded by the opaque
// scene depth and u_maxDistance), testing the sun's shadow map at every step — samples the sun can see
// in-scatter light toward the camera (Henyey-Greenstein phase, Beer-Lambert transmittance).
//
// Rendered at half resolution into a scratch buffer and additively upsampled into the pre-bloom scene
// buffer, so the shafts bloom and tonemap like any other light.

#include "./chunks/fullscreen.wgsl"
// Shadow source: the shared cascade sampler. With u_shadowsEnabled false (no caster, or shadows
// switched off) every lookup returns "lit" and the shafts degrade to uniform haze.
#include "./chunks/shadows.wgsl"

const MAX_STEPS: i32 = 128;
const PI: f32 = 3.14159265359;

@group(0) @binding(0) var u_depth_texture: texture_2d<f32>;   // opaque scene depth; 1.0 = sky
@group(0) @binding(1) var u_depth_sampler: sampler;

struct GodRayUniforms {
    u_invViewProj: mat4x4<f32>,   // clip -> world
    u_view: mat4x4<f32>,          // cascade slice pick uses view-space depth
    u_viewPos: vec3<f32>,
    u_sunDir: vec3<f32>,          // world dir TOWARD the sun (normalised)
    u_lightColor: vec3<f32>,      // sun light colour (linear)
    u_tint: vec3<f32>,
    u_intensity: f32,             // overall shaft intensity (godRayExposure)
    u_density: f32,               // 0..1 scattering density (scaled to per-metre below)
    u_anisotropy: f32,            // Henyey-Greenstein g (0..0.95)
    u_maxDistance: f32,           // march cap in world units
    u_steps: i32,                 // march steps (<= MAX_STEPS)
};
@group(1) @binding(0) var<uniform> u_ray: GodRayUniforms;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_ray.u_invViewProj * clip;
    return world.xyz / world.w;
}

/**
 * 1 = the sun reaches p, 0 = occluded.
 *
 * A single unfiltered tap — see shadowVisibility's note on why PCF here would be wasted work.
 */
fn sunVisibility(p: vec3<f32>) -> f32 {
    return shadowVisibility(p, -(u_ray.u_view * vec4<f32>(p, 1.0)).z);
}

/** Henyey-Greenstein phase: how much light scatters from the sun direction toward the camera. */
fn hgPhase(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

/** Interleaved gradient noise — per-pixel ray start offset that hides step banding without a texture. */
fn ign(px: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global.
    cleoFragCoord = in.position.xy;

    let depth = textureSample(u_depth_texture, u_depth_sampler, in.uv).r;

    // View ray: through this pixel, capped by opaque geometry (or u_maxDistance against the sky).
    var sampleDepth = 0.9999;
    if (depth < 1.0) { sampleDepth = depth; }
    let farPoint = reconstructWorldPos(in.uv, sampleDepth);
    let toFar = farPoint - u_ray.u_viewPos;
    let sceneDist = length(toFar);
    let rd = toFar / max(sceneDist, 1e-5);

    var reach = u_ray.u_maxDistance;
    if (depth < 1.0) { reach = sceneDist; }
    let marchDist = min(reach, u_ray.u_maxDistance);

    let steps = min(u_ray.u_steps, MAX_STEPS);
    let stepLen = marchDist / f32(steps);
    // Jitter the SAMPLE POINT within each fixed segment (not the whole comb): a fully-lit ray then
    // integrates to exactly 1 - e^(-sigma*D) with zero per-pixel variance — no dither noise on the open
    // sky — while shadow boundaries still get dithered, which is what the jitter is for.
    let jitter = ign(in.position.xy);

    let phase = hgPhase(dot(rd, u_ray.u_sunDir), u_ray.u_anisotropy);
    let sigma = u_ray.u_density * 0.05;              // density slider (0..1) -> extinction per metre
    let segScatter = 1.0 - exp(-sigma * stepLen);    // energy scattered within one segment
    let segTrans = exp(-sigma * stepLen);            // transmittance across one segment

    var transmittance = 1.0;
    var scatter = 0.0;
    var visSum = 0.0;

    for (var i = 0; i < MAX_STEPS; i++) {
        if (i >= steps) { break; }
        let p = u_ray.u_viewPos + rd * ((f32(i) + jitter) * stepLen);
        let vis = sunVisibility(p);   // u_shadowsEnabled false -> always 1.0 -> uniform haze
        scatter += vis * transmittance * segScatter;
        visSum += vis;
        transmittance *= segTrans;
    }

    // Contrast boost (deliberately non-physical): scale by the SQUARE of the ray's average sun
    // visibility, so occluded rays darken hard (a half-shadowed ray keeps only ~1/8 of its haze). The
    // purely physical model only removes the occluded segments' share, which leaves shadowed shafts
    // looking washed out.
    let visAvg = visSum / f32(steps);
    scatter *= visAvg * visAvg;

    // Alpha 0: composited ADDITIVELY (blendFunc ONE, ONE) so the bloom mask in the scene alpha survives.
    return vec4<f32>(u_ray.u_lightColor * u_ray.u_tint * (scatter * phase * u_ray.u_intensity), 0.0);
}
