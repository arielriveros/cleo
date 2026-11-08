// The GI Volumes' irradiance at a surface point: the DDGI lookup over every volume in view, smallest
// first, each claiming its feathered share (render/gi/giLighting.ts is its CPU twin, minus visibility).
// Shared by the apply pass (giResolve.wgsl) and the relight (giRadiance.wgsl, for the bounces).
//
// Include AFTER chunks/octNormal.wgsl and chunks/giCommon.wgsl.
//
// Bindings: the volume descriptors as their own uniform block (group 1, binding 3, beside the program's
// own block at 0 and the shadow / cluster blocks at 2 and 6), the three shared atlases in group 2.

const MAX_GI_VOLUMES: i32 = 16;
const GI_IRR_TILE: f32 = 8.0;
const GI_IRR_INTERIOR: f32 = 6.0;
const GI_VIS_TILE: f32 = 16.0;
const GI_VIS_INTERIOR: f32 = 14.0;
/** The valid trilinear weight at which a cage counts as fully covering a point (giLighting.ts). */
const GI_FULL_COVERAGE: f32 = 0.25;

struct GiVolumeBlock {
    /** World -> fractional grid coordinates (probe (i, j, k) at integer (i, j, k)). */
    u_giWorldToGrid: array<mat4x4<f32>, 16>,
    u_giGridToWorld: array<mat4x4<f32>, 16>,
    /** World -> the volume's unit box (containment |xyz| <= 0.5), for the feather. */
    u_giInvVolume: array<mat4x4<f32>, 16>,
    /** xyz probe counts, w the volume's first global probe index. */
    u_giCounts: array<vec4<i32>, 16>,
    /** xyz feather as a fraction of the unit box, w intensity x (frame pre-exposure / store scale). */
    u_giBlend: array<vec4<f32>, 16>,
    /** x normal bias (m), y view bias (m), z max ray distance (m), w unused. */
    u_giBias: array<vec4<f32>, 16>,
    /** x irradiance tiles a row, y visibility tiles a row, z probe-data texels a row. */
    u_giAtlas: vec4<f32>,
    /** xy irradiance atlas size, zw visibility atlas size (texels). */
    u_giAtlasSize: vec4<f32>,
    u_giVolumeCount: i32,
    _giPad0: i32,
    _giPad1: i32,
    _giPad2: i32,
};
@group(1) @binding(3) var<uniform> u_giVolumes: GiVolumeBlock;

@group(2) @binding(0) var u_giIrradiance_texture: texture_2d<f32>;
@group(2) @binding(1) var u_giIrradiance_sampler: sampler;
@group(2) @binding(2) var u_giVisibility_texture: texture_2d<f32>;
@group(2) @binding(3) var u_giVisibility_sampler: sampler;
@group(2) @binding(4) var u_giProbeData_texture: texture_2d<f32>;
@group(2) @binding(5) var u_giProbeData_sampler: sampler;

/** A probe's data texel: xyz offset from its grid position, w its state (1 active). */
fn giProbeData(g: i32) -> vec4<f32> {
    let perRow = i32(u_giVolumes.u_giAtlas.z);
    return textureLoad(u_giProbeData_texture, vec2<i32>(g % perRow, g / perRow), 0);
}

/** Feathered containment in volume `v`: 1 well inside, smoothstepping to 0 at the faces. */
fn giBoxWeight(v: i32, p: vec3<f32>) -> f32 {
    let local = (u_giVolumes.u_giInvVolume[v] * vec4<f32>(p, 1.0)).xyz;
    let edge = vec3<f32>(0.5) - abs(local);
    if (min(edge.x, min(edge.y, edge.z)) <= 0.0) { return 0.0; }
    let blend = u_giVolumes.u_giBlend[v].xyz;
    var w = 1.0;
    for (var a = 0; a < 3; a++) {
        if (blend[a] > 0.0) {
            let t = min(1.0, edge[a] / blend[a]);
            w = min(w, t * t * (3.0 - 2.0 * t));
        }
    }
    return w;
}

/**
 * Atlas uv of the octahedral position `oct` (`octEncode(d) * 0.5 + 0.5`, 0..1) in probe `g`'s irradiance
 * tile (bilinear-safe: the border is one texel). Split from the direction so a lookup that reads eight
 * probes along one normal encodes it once.
 */
fn giIrradianceTileUV(g: i32, oct: vec2<f32>) -> vec2<f32> {
    let perRow = i32(u_giVolumes.u_giAtlas.x);
    let origin = vec2<f32>(f32(g % perRow), f32(g / perRow)) * GI_IRR_TILE;
    return (origin + oct * GI_IRR_INTERIOR + vec2<f32>(1.0)) / u_giVolumes.u_giAtlasSize.xy;
}

/** Atlas uv of direction `d` in probe `g`'s irradiance tile. */
fn giIrradianceUV(g: i32, d: vec3<f32>) -> vec2<f32> {
    return giIrradianceTileUV(g, octEncode(d) * 0.5 + 0.5);
}

fn giVisibilityUV(g: i32, d: vec3<f32>) -> vec2<f32> {
    let perRow = i32(u_giVolumes.u_giAtlas.y);
    let origin = vec2<f32>(f32(g % perRow), f32(g / perRow)) * GI_VIS_TILE;
    let local = (octEncode(d) * 0.5 + 0.5) * GI_VIS_INTERIOR + vec2<f32>(1.0);
    return (origin + local) / u_giVolumes.u_giAtlasSize.zw;
}

/**
 * Volume `v`'s irradiance (E/pi, on the store scale) at surface point `P` with normal `N`, `V` the unit
 * vector toward the eye. `.a` is the trilinear weight of the cage's ACTIVE probes, 0..1: how much of the
 * cage could answer at all (a cage still being captured answers less, and fades to the fallback).
 *
 * DDGI (Majercik et al. 2019, 2021): the lookup point is pushed off the surface along the normal and
 * toward the eye; each of the eight probes round it is weighted by trilinear position, by a smooth
 * back-face term (a probe behind the surface counts little) and by Chebyshev's bound on its visibility
 * (a probe that sees a wall nearer than the point is behind that wall, and counts almost nothing).
 */
fn giSampleVolume(v: i32, P: vec3<f32>, N: vec3<f32>, V: vec3<f32>) -> vec4<f32> {
    let bias = u_giVolumes.u_giBias[v];
    let biased = P + N * bias.x + V * bias.y;
    let counts = u_giVolumes.u_giCounts[v];
    let n = vec3<f32>(f32(counts.x), f32(counts.y), f32(counts.z));
    let g = clamp((u_giVolumes.u_giWorldToGrid[v] * vec4<f32>(biased, 1.0)).xyz, vec3<f32>(0.0), n - vec3<f32>(1.0));
    let base = min(floor(g), n - vec3<f32>(2.0));
    let frac = g - base;
    let maxDistance = bias.z;
    let moments2 = vec2<f32>(maxDistance, maxDistance * maxDistance);
    // Once for the cage, not once a probe: the normal's place in every irradiance tile, the cage's first
    // probe, and the grid's axes in the world (gridToWorld is affine, so each corner is a step along them).
    let octN = octEncode(N) * 0.5 + 0.5;
    let toWorld = u_giVolumes.u_giGridToWorld[v];
    let corner0 = (toWorld * vec4<f32>(base, 1.0)).xyz;
    let axisX = toWorld[0].xyz;
    let axisY = toWorld[1].xyz;
    let axisZ = toWorld[2].xyz;
    let probe0 = counts.w + i32(base.x) + counts.x * (i32(base.y) + counts.y * i32(base.z));
    let strideZ = counts.x * counts.y;

    var sum = vec3<f32>(0.0);
    var weightSum = 0.0;
    var valid = 0.0;
    for (var s = 0; s < 8; s++) {
        let ox = s & 1;
        let oy = (s >> 1u) & 1;
        let oz = (s >> 2u) & 1;
        let offset = vec3<f32>(f32(ox), f32(oy), f32(oz));
        let probe = probe0 + ox + oy * counts.x + oz * strideZ;
        // The probe's light first: its alpha is the probe's state (giStateStamp.wgsl, 1 = active), and
        // only ACTIVE probes answer. No probe-data fetch: v1 keeps every probe on its grid point.
        let irradiance = textureSampleLevel(u_giIrradiance_texture, u_giIrradiance_sampler, giIrradianceTileUV(probe, octN), 0.0);
        if (irradiance.a < 0.5) { continue; }

        let tri = mix(vec3<f32>(1.0) - frac, frac, offset);
        let trilinear = max(tri.x * tri.y * tri.z, 1e-6);
        valid += tri.x * tri.y * tri.z;

        let probePos = corner0 + axisX * offset.x + axisY * offset.y + axisZ * offset.z;
        // Smooth back-face weight: a probe behind the surface still contributes a little.
        let toProbe = normalize(probePos - P);
        let facing = (dot(toProbe, N) + 1.0) * 0.5;
        var w = facing * facing + 0.2;

        // Chebyshev visibility from the probe's distance moments, along the probe -> point direction.
        let fromProbe = biased - probePos;
        let r = length(fromProbe);
        if (r > 1e-4) {
            let moments = textureSampleLevel(u_giVisibility_texture, u_giVisibility_sampler,
                                             giVisibilityUV(probe, fromProbe / r), 0.0).rg * moments2;
            if (r > moments.x) {
                let variance = abs(moments.y - moments.x * moments.x);
                let d = r - moments.x;
                let cheb = variance / max(variance + d * d, 1e-8);
                w *= max(cheb * cheb * cheb, 0.0);
            }
        }
        // Crush tiny weights (DDGI): stops a nearly-occluded probe from leaking a faint wash.
        w = max(w, 1e-6);
        if (w < 0.2) { w *= w * w * (1.0 / (0.2 * 0.2)); }
        w *= trilinear;

        sum += irradiance.rgb * w;
        weightSum += w;
    }
    if (weightSum <= 0.0) { return vec4<f32>(0.0); }
    return vec4<f32>(sum / weightSum, valid);
}

/**
 * Every volume's light at `P`, smallest first, each claiming its feathered weight times its coverage of
 * what the ones before it left. `.rgb` = sum of claim x E/pi x the volume's blend w (intensity and scale),
 * `.a` = the share claimed.
 */
fn giIrradianceAt(P: vec3<f32>, N: vec3<f32>, V: vec3<f32>) -> vec4<f32> {
    var remaining = 1.0;
    var light = vec3<f32>(0.0);
    for (var v = 0; v < min(u_giVolumes.u_giVolumeCount, MAX_GI_VOLUMES); v++) {
        let w = giBoxWeight(v, P);
        if (w <= 0.0) { continue; }
        let s = giSampleVolume(v, P, N, V);
        let claim = w * saturate(s.a / GI_FULL_COVERAGE) * remaining;
        if (claim <= 0.0) { continue; }
        light += s.rgb * (claim * u_giVolumes.u_giBlend[v].w);
        remaining -= claim;
        if (remaining <= 1e-3) { break; }
    }
    return vec4<f32>(light, 1.0 - remaining);
}
