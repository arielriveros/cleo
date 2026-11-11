// GI relight, step one: the light leaving every ray's hit, from the CAPTURED hit and today's light
// (render/gi/giRelight.ts). Drawn over a volume's radiance scratch (its hit cache's layout); probes
// outside [first, first + count) are discarded.
//
// A hit's radiance is Lambertian — what a probe gathers is diffuse irradiance, and the specular lobe of
// what it sees averages out of it:
//
//     L = emissive + albedo x (E_sun x shadow + sum of E_light x visibility + E_bounce) / pi
//
// E_bounce is the volumes' own irradiance at the hit, from their previous result: each sweep adds one
// more bounce. A ray that hit nothing sees the sky light's radiance in its direction; one that hit a back
// face carries nothing. Everything is on the STORE scale k: the uploads arrive pre-exposed by k (the relight
// runs with the frame's pre-exposure set to it), the absolute emissive is multiplied by it here.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/areaLights.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"
#include "./chunks/giSample.wgsl"

@group(0) @binding(0) var u_hitA_texture: texture_2d<f32>;
@group(0) @binding(1) var u_hitA_sampler: sampler;
@group(0) @binding(2) var u_hitB_texture: texture_2d<f32>;
@group(0) @binding(3) var u_hitB_sampler: sampler;
@group(0) @binding(4) var u_hitC_texture: texture_2d<f32>;
@group(0) @binding(5) var u_hitC_sampler: sampler;

/** Baked lights a volume takes: indices into the bake light grid, four to a vec4. */
const GI_MAX_LIGHTS: i32 = 32;

struct GiRadianceUniforms {
    /** The volume's grid -> world (probe (i, j, k) at integer (i, j, k)). */
    u_gridToWorld: mat4x4<f32>,
    u_lightIndex: array<vec4<i32>, 8>,
    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    /** The frame's flat fill (pre-exposed); unused by the rays, kept for the upload's sake. */
    u_sceneAmbient: vec3<f32>,
    /** The store scale k: what the absolute emissive is multiplied by. */
    u_preExposure: f32,
    /** xyz probe counts, w the volume's first global probe index. */
    u_counts: vec4<i32>,
    u_first: i32,
    u_count: i32,
    u_raySide: i32,
    u_lightCount: i32,
    u_maxRayDistance: f32,
    /** 1: the bounces after the first (the volumes' previous irradiance at each hit). */
    u_bounce: i32,
    /** This volume's index in the GiVolumeBlock list: the bounce a hit outside every box takes. */
    u_ownVolume: i32,
    _pad1: i32,
};
@group(1) @binding(0) var<uniform> u_gi: GiRadianceUniforms;

/** A light's Lambertian irradiance (E, on the light's own scale) at `p` facing `n`, its shadow included. */
fn giPunctualIrradiance(index: i32, p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    let cl = cleoLight(index);
    let light = cl.light;
    if (!cleoLightReaches(light, p)) { return vec3<f32>(0.0); }
    let ext = cleoAreaIndex(cl);
    if (ext >= 0) {
        // An area light's exact form factor: smooth over the hit, no hotspot for a ray to alias.
        let area = cleoAreaLight(cl, ext);
        return areaLightIrradiance(area, p, n) * cleoAreaVisibility(cl, area, p, n);
    }
    let toLight = light.position - p;
    let d2 = max(dot(toLight, toLight), light.sourceRadius * light.sourceRadius);
    let l = toLight * inverseSqrt(max(dot(toLight, toLight), 1e-12));
    let ndl = max(dot(n, l), 0.0);
    if (ndl <= 0.0) { return vec3<f32>(0.0); }
    var atten = distanceAttenuation(d2, light.invRangeSquared);
    if (light.coneScale != 0.0) {
        atten *= spotAttenuation(dot(-l, normalize(light.direction)), light.coneScale, light.coneOffset);
    }
    let vis = cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot, p, n, light.position);
    return light.color * (light.intensity * atten * ndl * vis);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    cleoFragCoord = in.position.xy;
    let side = u_gi.u_raySide;
    let texel = vec2<i32>(floor(in.position.xy));
    let p = (texel.y / side) * 64 + texel.x / side;
    if (p < u_gi.u_first || p >= u_gi.u_first + u_gi.u_count) { discard; }

    let g = u_gi.u_counts.w + p;
    let data = giProbeData(g);
    if (abs(data.w - 1.0) > 0.25) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }   // not an active probe

    let hitA = textureLoad(u_hitA_texture, texel, 0);
    let kind = giHitKind(hitA.a);
    let d = giRayDirection(vec2<f32>(f32(texel.x % side), f32(texel.y % side)), f32(side));
    if (kind == 0) {
        // Sky radiance, as the sky light holds it (radiance-form SH x its intensity, pre-exposed), plus
        // whatever glows in the rest of the ray's cell (giReduce.wgsl averages it over the cell).
        let cellGlow = giDecodeRGBE(textureLoad(u_hitC_texture, texel, 0)) * u_gi.u_preExposure;
        if (u_gi.u_skyLight.enabled == 0) { return vec4<f32>(cellGlow, 1.0); }
        return vec4<f32>(giShRadiance(u_gi.u_skyLight.sh, d) * u_gi.u_skyLight.intensity + cellGlow, 1.0);
    }
    if (kind == 1) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

    // The hit: where, facing what, of what colour.
    let counts = u_gi.u_counts;
    let local = vec3<f32>(f32(p % counts.x), f32((p / counts.x) % counts.y), f32(p / (counts.x * counts.y)));
    let origin = (u_gi.u_gridToWorld * vec4<f32>(local, 1.0)).xyz + data.xyz;
    let hitB = textureLoad(u_hitB_texture, texel, 0);
    let distance = giDecode16(hitB.ba) * u_gi.u_maxRayDistance;
    let P = origin + d * distance;
    let N = octDecode(hitB.rg * 2.0 - 1.0);
    let albedo = hitA.rgb * hitA.rgb;
    let emissive = giDecodeRGBE(textureLoad(u_hitC_texture, texel, 0)) * u_gi.u_preExposure;

    // The sun, with its shadow from the volume's own map (read in the cascades' place). The "view depth"
    // only selects a cascade, and the volume map is the one layer.
    var E = vec3<f32>(0.0);
    let sun = u_gi.u_dirLight;
    if (dot(sun.direction, sun.direction) > 1e-6) {
        let L = normalize(-sun.direction);
        let ndl = max(dot(N, L), 0.0);
        if (ndl > 0.0) {
            let shadow = directionalShadow(P, N, 1.0);
            E += sun.color * (sun.intensity * ndl * (1.0 - shadow));
        }
    }
    // The baked lights this volume takes (the bake grid, steady, no flicker).
    for (var i = 0; i < min(u_gi.u_lightCount, GI_MAX_LIGHTS); i++) {
        E += giPunctualIrradiance(u_gi.u_lightIndex[i / 4][i % 4], P, N);
    }
    var bounce = vec3<f32>(0.0);
    if (u_gi.u_bounce != 0) {
        // The view vector the lookup is biased along: back toward the probe that saw the hit.
        let claimed = giIrradianceAt(P, N, -d);
        bounce = claimed.rgb;
        // A hit outside every box — a room's walls, just past its volume — takes what is left from its own
        // volume, the lookup clamped to the grid's edge: the probes nearest it saw it.
        if (claimed.a < 0.999 && u_gi.u_ownVolume >= 0) {
            let own = giSampleVolume(u_gi.u_ownVolume, P, N, -d);
            bounce += own.rgb * (saturate(own.a / GI_FULL_COVERAGE) * (1.0 - claimed.a) * u_giVolumes.u_giBlend[u_gi.u_ownVolume].w);
        }
    }
    // E is irradiance; Lambertian radiance is albedo x E / pi. `bounce` is already E/pi.
    return vec4<f32>(emissive + albedo * (E / GI_PI + bounce), 1.0);
}
