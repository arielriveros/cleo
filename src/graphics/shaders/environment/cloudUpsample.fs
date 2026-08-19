#version 300 es

precision highp float;

// Composite pass for the reduced-resolution volumetric clouds.
//
// The problem this solves: at resolutionScale 0.5 one cloud texel covers a 2x2 block of screen pixels
// (4x4 at the low tiers), and that whole block's occlusion was decided by ONE depth sample at the
// texel's centre. Upsampling the resulting alpha with any filter therefore smears cloud several
// screen pixels onto the meshes in front of it — a halo — and quantises every silhouette to the cloud
// grid, which reads as a noisy, crawling edge.
//
// So this pass does not try to repair the low-res alpha. It decides occlusion PER FULL-RESOLUTION
// PIXEL and uses the low-res buffer only for colour:
//
//   * Gate — intersect this pixel's own view ray with the cloud slab and compare the entry distance
//     against the distance to solid geometry. Geometry in front of the layer means no cloud here, full
//     stop, at exactly the geometry's own edge.
//   * Gather — for the pixels that do see the slab, take the four surrounding cloud texels with
//     texelFetch (integer coords: the buffer is LINEAR-filtered, so a UV fetch would already have
//     blended neighbouring texels together before any weighting could reject them), and drop any texel
//     whose OWN centre fails the same slab test. Renormalising over the survivors is what stops a dark
//     notch of missing cloud from hugging every silhouette.
//
// A previous version weighted the taps by relative device depth, mirroring the SSAO upsample. That
// cannot work here: device depth is compressed so hard toward 1.0 that separating a mesh from the open
// sky behind it needs a tolerance no wider than a few thousandths, and the taps were being compared
// against the current full-res depth rather than the depth the low-res texel was actually traced at.
// See the same argument in cloudTemporalResolve.fs.
//
// The cloud buffer holds PREMULTIPLIED colour and coverage and this pass keeps it that way: the caller
// composites with blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA), and a convex
// combination of premultiplied samples is still a valid premultiplied sample.

uniform sampler2D u_clouds;      // the reduced-resolution cloud image
uniform sampler2D u_gDepth;      // the SAME depth the raymarch bounded its rays against
// Size of the cloud buffer in texels. Passed rather than derived from a texel size: 1/(1/960) does
// not round-trip exactly in float32, and truncating that to an int drops the last row and column.
uniform vec2      u_cloudResolution;

uniform mat4  u_invViewProj;
uniform vec3  u_viewPos;
uniform float u_slabBottom;      // cloud layer's lower altitude, world space
uniform float u_slabTop;         // cloud layer's upper altitude

in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;

/** Distance from the camera to solid geometry at `uv`, or "infinite" where the background shows. */
float geometryDistance(vec2 uv) {
    float depth = texture(u_gDepth, uv).r;
    if (depth >= 1.0) return 1e30;
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return length(world.xyz / world.w - u_viewPos);
}

/**
 * Does the ray through `uv` reach any part of the cloud slab before geometry stops it?
 *
 * Mirrors the slab intersection in volumetricClouds.fs so this pass agrees with what the raymarch
 * actually did. The comparison is against the slab's ENTRY distance, not its midpoint: geometry that
 * sits inside the layer still has cloud in front of it and must not be erased.
 */
bool reachesSlab(vec2 uv) {
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 nW = u_invViewProj * vec4(ndc, -1.0, 1.0);
    vec4 fW = u_invViewProj * vec4(ndc,  1.0, 1.0);
    vec3 ro = nW.xyz / nW.w;
    vec3 rd = normalize(fW.xyz / fW.w - ro);

    float tEnter, tExit;
    if (abs(rd.y) < 1e-5) {
        // Ray parallel to the slab: only inside it if the camera is.
        if (u_viewPos.y < u_slabBottom || u_viewPos.y > u_slabTop) return false;
        tEnter = 0.0;
        tExit = 1e30;
    } else {
        float t0 = (u_slabBottom - u_viewPos.y) / rd.y;
        float t1 = (u_slabTop - u_viewPos.y) / rd.y;
        tEnter = max(min(t0, t1), 0.0);
        tExit = max(t0, t1);
    }
    if (tEnter >= tExit) return false;
    return tEnter < geometryDistance(uv);
}

void main() {
    // Gate: solid geometry in front of the whole cloud layer means no cloud on this pixel. Decided at
    // full resolution, so the cloud stops exactly on the mesh's silhouette instead of on the cloud
    // buffer's grid.
    if (!reachesSlab(fragTexCoord)) { fragColor = vec4(0.0); return; }

    // Bilinear footprint over the cloud buffer, resolved by hand so each texel stays separable.
    vec2  texelSize = 1.0 / u_cloudResolution;
    vec2  p = fragTexCoord * u_cloudResolution - 0.5;
    ivec2 base = ivec2(floor(p));
    vec2  f = fract(p);
    ivec2 maxTexel = ivec2(u_cloudResolution) - 1;

    vec4  sum = vec4(0.0);
    float weightSum = 0.0;

    for (int i = 0; i < 4; i++) {
        ivec2 offset = ivec2(i & 1, i >> 1);
        float w = (offset.x == 0 ? 1.0 - f.x : f.x) * (offset.y == 0 ? 1.0 - f.y : f.y);
        if (w <= 0.0) continue;

        ivec2 texel = clamp(base + offset, ivec2(0), maxTexel);
        // Test the texel at its own centre — the position the raymarch sampled depth at for it. A
        // texel straddling a silhouette holds whatever its centre saw, so only its centre can say
        // whether its colour belongs on a sky pixel.
        if (!reachesSlab((vec2(texel) + 0.5) * texelSize)) continue;

        sum += texelFetch(u_clouds, texel, 0) * w;
        weightSum += w;
    }

    // Every contributing texel was occluded even though this pixel is not: nothing honest to show.
    if (weightSum <= 0.0) { fragColor = vec4(0.0); return; }
    fragColor = sum / weightSum;
}
