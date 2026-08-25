// Composite pass for the reduced-resolution volumetric clouds.
//
// The problem this solves: at resolutionScale 0.5 one cloud texel covers a 2x2 block of screen pixels
// (4x4 at the low tiers), and that whole block's occlusion was decided by ONE depth sample at the
// texel's centre. Upsampling the resulting alpha with any filter therefore smears cloud several screen
// pixels onto the meshes in front of it — a halo — and quantises every silhouette to the cloud grid,
// which reads as a noisy, crawling edge.
//
// So this pass does not try to repair the low-res alpha. It decides occlusion PER FULL-RESOLUTION
// PIXEL and uses the low-res buffer only for colour:
//
//   * Gate — intersect this pixel's own view ray with the cloud slab and compare the entry distance
//     against the distance to solid geometry. Geometry in front of the layer means no cloud here, full
//     stop, at exactly the geometry's own edge.
//   * Gather — for pixels that do see the slab, take the four surrounding cloud texels with
//     `textureLoad` (integer coords: the buffer is LINEAR-filtered, so a UV fetch would already have
//     blended neighbouring texels together before any weighting could reject them), and drop any texel
//     whose OWN centre fails the same slab test. Renormalising over the survivors is what stops a dark
//     notch of missing cloud from hugging every silhouette.
//
// A previous version weighted the taps by relative device depth, mirroring the SSAO upsample. That
// cannot work here: device depth is compressed so hard toward 1.0 that separating a mesh from open sky
// behind it needs a tolerance no wider than a few thousandths, and the taps were being compared against
// the current full-res depth rather than the depth the low-res texel was actually traced at. The same
// argument appears in cloudTemporalResolve.
//
// The cloud buffer holds PREMULTIPLIED colour and coverage and this pass keeps it that way: the caller
// composites with blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA), and a convex
// combination of premultiplied samples is still a valid premultiplied sample.

#include "./chunks/fullscreen.wgsl"

// Binding 1 is deliberately EMPTY. The cloud buffer is only ever read with `textureLoad`, which takes
// no sampler, so a `sampler` declared beside it is never referenced — and an unreferenced binding is
// dropped from the pipeline's auto-generated layout. The engine synthesises its sampler entries from
// what the source DECLARES, so declaring one here made it hand WebGPU a fourth entry for a layout with
// three, which invalidates the bind group and with it the whole command buffer: the pass then does not
// even run its clear and the target reads back as zeros.
@group(0) @binding(0) var u_clouds_texture: texture_2d<f32>;   // the reduced-resolution cloud image
@group(0) @binding(2) var u_gDepth_texture: texture_depth_2d;   // the depth the raymarch bounded against
@group(0) @binding(3) var u_gDepth_sampler: sampler;

struct CloudUpsampleUniforms {
    u_invViewProj: mat4x4<f32>,
    u_viewPos: vec3<f32>,
    // Size of the cloud buffer in texels. Passed rather than derived from a texel size: 1/(1/960) does
    // not round-trip exactly in f32, and truncating that to an integer drops the last row and column.
    u_cloudResolution: vec2<f32>,
    u_slabBottom: f32,     // cloud layer's lower altitude, world space
    u_slabTop: f32,        // cloud layer's upper altitude
};
@group(1) @binding(0) var<uniform> u_up: CloudUpsampleUniforms;

/** Distance from the camera to solid geometry at `uv`, or "infinite" where the background shows. */
fn geometryDistance(uv: vec2<f32>) -> f32 {
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    if (depth >= 1.0) { return 1e30; }
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_up.u_invViewProj * clip;
    return length(world.xyz / world.w - u_up.u_viewPos);
}

/**
 * Does the ray through `uv` reach any part of the cloud slab before geometry stops it?
 *
 * Mirrors the slab intersection in volumetricClouds so this pass agrees with what the raymarch
 * actually did. The comparison is against the slab's ENTRY distance, not its midpoint: geometry
 * sitting INSIDE the layer still has cloud in front of it and must not be erased.
 */
fn reachesSlab(uv: vec2<f32>) -> bool {
    let ndc = uv * 2.0 - 1.0;
    let nW = u_up.u_invViewProj * vec4<f32>(ndc, -1.0, 1.0);
    let fW = u_up.u_invViewProj * vec4<f32>(ndc, 1.0, 1.0);
    let ro = nW.xyz / nW.w;
    let rd = normalize(fW.xyz / fW.w - ro);

    var tEnter: f32;
    var tExit: f32;
    if (abs(rd.y) < 1e-5) {
        // Ray parallel to the slab: only inside it if the camera is.
        if (u_up.u_viewPos.y < u_up.u_slabBottom || u_up.u_viewPos.y > u_up.u_slabTop) { return false; }
        tEnter = 0.0;
        tExit = 1e30;
    } else {
        let t0 = (u_up.u_slabBottom - u_up.u_viewPos.y) / rd.y;
        let t1 = (u_up.u_slabTop - u_up.u_viewPos.y) / rd.y;
        tEnter = max(min(t0, t1), 0.0);
        tExit = max(t0, t1);
    }
    if (tEnter >= tExit) { return false; }
    return tEnter < geometryDistance(uv);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Gate: solid geometry in front of the whole cloud layer means no cloud on this pixel. Decided at
    // full resolution, so the cloud stops exactly on the mesh's silhouette rather than on the cloud
    // buffer's grid.
    if (!reachesSlab(in.uv)) { return vec4<f32>(0.0); }

    // Bilinear footprint over the cloud buffer, resolved by hand so each texel stays separable.
    let texelSize = 1.0 / u_up.u_cloudResolution;
    let p = in.uv * u_up.u_cloudResolution - 0.5;
    let base = vec2<i32>(floor(p));
    let f = fract(p);
    let maxTexel = vec2<i32>(u_up.u_cloudResolution) - 1;

    var sum = vec4<f32>(0.0);
    var weightSum = 0.0;

    for (var i = 0; i < 4; i++) {
        let offset = vec2<i32>(i & 1, i >> 1);
        var wx = f.x;
        if (offset.x == 0) { wx = 1.0 - f.x; }
        var wy = f.y;
        if (offset.y == 0) { wy = 1.0 - f.y; }
        let w = wx * wy;
        if (w <= 0.0) { continue; }

        let texel = clamp(base + offset, vec2<i32>(0), maxTexel);
        // Test the texel at its OWN centre — the position the raymarch sampled depth at for it. A
        // texel straddling a silhouette holds whatever its centre saw, so only its centre can say
        // whether its colour belongs on a sky pixel.
        if (!reachesSlab((vec2<f32>(texel) + 0.5) * texelSize)) { continue; }

        sum += textureLoad(u_clouds_texture, texel, 0) * w;
        weightSum += w;
    }

    // Every contributing texel was occluded even though this pixel is not: nothing honest to show.
    if (weightSum <= 0.0) { return vec4<f32>(0.0); }
    return sum / weightSum;
}
