// Screen-space lens flare: the ghosts and halo a bright source throws when it reflects between the
// elements of a real lens.
//
// Generated from the IMAGE rather than anchored to the sun, and that is the important decision here.
// Anchoring to `_sunScreenInfo` would be cheaper, but its `visible` term is only an edge fade — it is
// not an occlusion test — so a sun-anchored flare keeps firing at full strength through a wall. Working
// from thresholded image brightness is occluded for free: if the sun is behind geometry it is not in
// the buffer, so it throws no ghosts. It also flares every other bright thing (a window, a headlight),
// which is what a lens actually does.
//
// Runs at half resolution and is composited back additively by lensFlareComposite.wgsl.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct LensFlareUniforms {
    /** Linear-HDR radiance a pixel must exceed before it throws a flare at all. */
    u_flareThreshold: f32,
    /** How many ghosts to trace back along the centre line. Clamped to GHOST_LIMIT below. */
    u_flareGhosts: f32,
    /** Spacing of the ghosts along that line, as a fraction of the distance to the centre. */
    u_flareDispersal: f32,
    /** Radius of the halo ring, in uv. 0 disables it. */
    u_flareHaloWidth: f32,
    /**
     * How far apart the three channels are sampled, in uv. A lens disperses the ghosts it throws, and
     * a flare with none reads as a grey smudge rather than as glass.
     */
    u_flareChromatic: f32,
};
@group(1) @binding(0) var<uniform> u_flare: LensFlareUniforms;

/**
 * Ghosts the loop below will ever trace. A compile-time bound with a dynamic `break`, rather than a
 * uniform loop bound: both backends accept a dynamic bound, but a fixed one lets the compiler unroll,
 * and this shader samples the source three times per ghost.
 */
const GHOST_LIMIT: i32 = 8;

/** Everything above the threshold, and nothing below it. The flare's only source of light. */
fn bright(uv: vec2<f32>) -> vec3<f32> {
    // Outside the frame there is no image — not black, but nothing. Sampling a clamped texture there
    // would smear the edge pixels outward into a bar along whichever side the ghost ran off.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return vec3<f32>(0.0); }
    let c = textureSample(u_screenTexture_texture, u_screenTexture_sampler, uv).rgb;
    return max(c - vec3<f32>(u_flare.u_flareThreshold), vec3<f32>(0.0));
}

/** The three channels sampled slightly apart along `dir`, which is what disperses a ghost. */
fn brightDispersed(uv: vec2<f32>, dir: vec2<f32>) -> vec3<f32> {
    let d = dir * u_flare.u_flareChromatic;
    return vec3<f32>(bright(uv + d).r, bright(uv).g, bright(uv - d).b);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Ghosts fall on the line through the frame's centre, on the OPPOSITE side from their source —
    // which is why the image is read mirrored. That is not a stylisation: an internal reflection
    // inverts through the optical axis.
    let uv = vec2<f32>(1.0) - in.uv;
    let toCentre = vec2<f32>(0.5) - uv;
    let step = toCentre * u_flare.u_flareDispersal;
    let dir = normalize(toCentre + vec2<f32>(1e-6));

    var result = vec3<f32>(0.0);

    for (var i: i32 = 0; i < GHOST_LIMIT; i = i + 1) {
        if (f32(i) >= u_flare.u_flareGhosts) { break; }
        let offset = uv + step * f32(i);
        // Ghosts fade toward the edge of the frame. Without this the furthest one lands hard against
        // the border and reads as a rectangle rather than as a reflection.
        let weight = pow(max(0.0, 1.0 - length(vec2<f32>(0.5) - offset) / 0.707), 6.0);
        result = result + brightDispersed(offset, dir) * weight;
    }

    // The halo: a ring at a fixed radius, sampled by pulling each pixel toward the centre by that
    // much. Its own weight curve, because it is a ring rather than a point and has to stay thin.
    if (u_flare.u_flareHaloWidth > 0.0) {
        let haloUv = uv + dir * u_flare.u_flareHaloWidth;
        let ring = length(vec2<f32>(0.5) - haloUv) / 0.707;
        let weight = pow(max(0.0, 1.0 - ring), 6.0);
        result = result + brightDispersed(haloUv, dir) * weight;
    }

    return vec4<f32>(result, 1.0);
}
