// Atmospheric fog for the SkyAtmosphere node: exponential height fog, integrated along each view ray.
//
// A single fullscreen pass. For each pixel we reconstruct the view ray from depth and integrate the fog
// along it — uniform density up to `u_fogHeight`, thinning exponentially above it — so a valley floor
// seen from a hill, a mountain rising out of the mist, and the mist itself between them all get the
// fog that actually lies along the line of sight, not the fog at the far end of it.
//
// The fog COLOUR is the atmosphere's HORIZON colour in the pixel's compass direction, from the clean
// (cloud-free) atmosphere cubemap at a heavily blurred mip, optionally tinted toward a custom colour. Not
// the sky directly behind the pixel: sampling that turned a fogged mountain into a picture of the sky (and
// of any clouds) behind it, so solid geometry looked see-through, and below the horizon it sampled the
// ground tint, which drew a horizon line across everything the fog touched.
//
// The SKY is fogged too, by the fog along its own ray, so fogged terrain meets a sky fogged the same way
// instead of a hard seam where the fog stopped at the geometry's silhouette. Height fog gives a sky ray a
// finite amount of fog by itself. Uniform fog (no falloff) would fill every sky ray completely, so for the
// sky it is taken as a layer `UNIFORM_SKY_DEPTH` deep around the viewer: a dense fog whites the sky out, a
// light distance haze only veils the horizon and leaves the zenith clear.
//
// Output is straight-alpha (blended with SRC_ALPHA, ONE_MINUS_SRC_ALPHA) toward the fog colour.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_gDepth_texture: texture_depth_2d;        // scene depth (opaque), background 1.0
@group(0) @binding(1) var u_gDepth_sampler: sampler;
// The clean atmosphere cubemap (linear HDR, no clouds baked in), sampled for the fog colour.
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
    // Mip to sample the atmosphere at: a few texels per face, so the fog is a smooth colour haze.
    u_fogSkyLod: f32,
};
@group(1) @binding(0) var<uniform> u_fog: SkyFogUniforms;

/** How far a sky pixel's ray runs through the fog, in metres. Far enough to saturate any fog worth having. */
const SKY_RAY: f32 = 20000.0;
/** Depth, in metres, of the layer uniform fog is taken to fill above the viewer when fogging the sky. */
const UNIFORM_SKY_DEPTH: f32 = 200.0;
/** How far above the horizon the fog colour is read: just clear of the ground tint below it. */
const HORIZON_LIFT: f32 = 0.06;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_fog.u_invViewProj * clip;
    return world.xyz / world.w;
}

/**
 * Fog optical depth along `y(t) = y0 + vy * t` for t in [ta, tb]: density `u_fogDensity` at and below
 * `u_fogHeight`, times exp(-falloff * (y - fogHeight)) above it. Split where the ray crosses the fog
 * height, with the part above integrated in closed form (written as a difference of two exponentials that
 * are each at most 1, so a long ray far above the fog cannot overflow).
 */
fn opticalDepth(y0: f32, vy: f32, ta: f32, tb: f32) -> f32 {
    if (tb <= ta) { return 0.0; }
    let density = u_fog.u_fogDensity;
    let k = u_fog.u_fogHeightFalloff;
    let h = u_fog.u_fogHeight;
    if (k <= 0.0) { return density * (tb - ta); }

    let ya = y0 + vy * ta;
    let yb = y0 + vy * tb;
    if (ya <= h && yb <= h) { return density * (tb - ta); }

    var a = ta;
    var b = tb;
    var below = 0.0;
    if (abs(vy) > 1e-6) {
        let th = (h - y0) / vy;
        if (ya < h) { below = th - ta; a = th; }        // rises out of the fog layer at th
        else if (yb < h) { below = tb - th; b = th; }   // sinks into it at th
    }

    let ea = k * (y0 + vy * a - h);   // >= 0: [a, b] lies at or above the fog height
    let eb = k * (y0 + vy * b - h);
    var above: f32;
    if (abs(eb - ea) < 1e-4) { above = exp(-ea) * (b - a); }
    else { above = (exp(-ea) - exp(-eb)) / (k * vy); }
    return density * (max(below, 0.0) + max(above, 0.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, in.uv, 0);
    // The margin below 1.0 catches anything rasterized at forced far depth (NDC z = w) a float-epsilon
    // short of the clear value: that is sky, and fogging it as geometry would shimmer.
    let isSky = depth >= 0.999999;

    let worldPos = reconstructWorldPos(in.uv, select(depth, 1.0, isSky));
    let toPixel = worldPos - u_fog.u_viewPos;
    let viewDir = toPixel / max(length(toPixel), 1e-5);
    let dist = select(length(toPixel), SKY_RAY, isSky);

    let start = max(u_fog.u_fogStart, 0.0);
    var tau: f32;
    if (isSky && u_fog.u_fogHeightFalloff <= 0.0) {
        let len = select(SKY_RAY, min(SKY_RAY, UNIFORM_SKY_DEPTH / max(viewDir.y, 1e-3)), viewDir.y > 1e-3);
        tau = u_fog.u_fogDensity * max(0.0, len - start);
    } else {
        tau = opticalDepth(u_fog.u_viewPos.y, viewDir.y, min(start, dist), dist);
    }
    let f = clamp(1.0 - exp(-tau), 0.0, u_fog.u_fogMaxOpacity);
    if (f <= 0.0) { discard; }

    // The horizon in this compass direction (straight up or down has none; any heading will do there).
    let level = vec2<f32>(viewDir.x, viewDir.z);
    let levelLen = length(level);
    let heading = select(vec2<f32>(1.0, 0.0), level / levelLen, levelLen > 1e-4);
    let horizonDir = normalize(vec3<f32>(heading.x, HORIZON_LIFT, heading.y));
    let atmoColor = textureSampleLevel(u_atmosphere_texture, u_atmosphere_sampler, horizonDir,
                                       u_fog.u_fogSkyLod).rgb;
    let fogColor = mix(atmoColor, u_fog.u_fogColor, u_fog.u_fogColorBlend);

    return vec4<f32>(fogColor, f);
}
