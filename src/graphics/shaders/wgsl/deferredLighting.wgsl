// Deferred lighting pass: a single fullscreen quad that reads the G-buffer, reconstructs world
// position from depth, and computes PBR (Cook-Torrance) lighting for every opaque pixel. All lights
// are uploaded once per frame here instead of per-object per-shader.

// Build-time variants (see programVariants.ts): one shadow filter each, and no cascade-debug tint —
// only the editor's debug view needs that, and the editor builds the base program.
// @variant pcf CLEO_SHADOW_FILTER=0 CLEO_NO_CASCADE_DEBUG
// @variant poisson CLEO_SHADOW_FILTER=1 CLEO_NO_CASCADE_DEBUG

#include "./chunks/fullscreen.wgsl"
// Cascaded shadow maps. Every uniform and every sampling function lives in the shared chunk, so this
// pass, the forward materials, custom materials and the god rays cannot drift apart.
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/shIrradiance.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/translucencyTint.wgsl"

const MAX_REFLECTION_LOD: f32 = 4.0;
/** Relative depth difference beyond which an AO/SSIL neighbour is treated as a different surface. */
const AO_DEPTH_TOLERANCE: f32 = 0.02;
/** Rec. 709 luminance, for the GI Volumes' reflection normalization. */
const GI_LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

// --- G-buffer -----------------------------------------------------------------------------------
@group(0) @binding(0) var u_gAlbedoMetallic_texture: texture_2d<f32>;    // rgb = albedo, a = metallic
@group(0) @binding(1) var u_gAlbedoMetallic_sampler: sampler;
@group(0) @binding(2) var u_gNormalRoughness_texture: texture_2d<f32>;   // rg = oct normal, b = reflectance, a = roughness
@group(0) @binding(3) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(4) var u_gEmissiveAO_texture: texture_2d<f32>;        // rgb = emissive, a = ao
@group(0) @binding(5) var u_gEmissiveAO_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_depth_2d;             // non-linear depth
@group(0) @binding(7) var u_gDepth_sampler: sampler;
// SSIL (ssil.wgsl): rgb = one bounce of nearby indirect light as E/pi, a = screen-space visibility.
@group(0) @binding(8) var u_ssao_texture: texture_2d<f32>;
@group(0) @binding(9) var u_ssao_sampler: sampler;
// Screen-space reflections (ssr.ts): rgb = reflected light, normalised as a prefiltered cube is, and
// a = the share of the reflection the screen answered. The pass samples 13 textures, inside the 16 GLSL
// ES 3.00 guarantees (tests/deferredLightingSamplers.test.ts).
@group(0) @binding(10) var u_ssr_texture: texture_2d<f32>;
@group(0) @binding(11) var u_ssr_sampler: sampler;
// GI Volumes (render/gi/giSystem.ts): rgb = the volumes' irradiance (E/pi, pre-exposed, x intensity, summed
// over their claims), a = the share they claimed. The most specific indirect diffuse: it claims first.
@group(0) @binding(12) var u_gi_texture: texture_2d<f32>;
@group(0) @binding(13) var u_gi_sampler: sampler;

// --- IBL ----------------------------------------------------------------------------------------
//
// A light probe's two lobes reach this pass two different ways.
//
// LIGHTING (diffuse): every lighting probe in view, as nine spherical-harmonic coefficients in the uniform
// block (`u_lightProbeSH`), looped over per pixel. A room's probe lights the room whether the camera is in
// it or looking in through the door. See render/probeLighting.ts, whose CPU twin of the loop lights
// forward draws, particles and sprites the same way.
//
// REFLECTIONS (specular): the same way. Every reflecting probe in view, its prefiltered environment one
// layer of the octahedral reflection atlas (render/reflectionAtlas.ts), looped over per pixel in the same
// claim order, so a polished floor reflects its room's probe from the street as from inside. ONE sampler
// with a dynamic layer, which GLSL ES 3.00 allows where it forbids a dynamically indexed sampler array.
@group(2) @binding(0) var u_reflectionAtlas_texture: texture_2d_array<f32>;  // layer = probe, mip = roughness
@group(2) @binding(1) var u_reflectionAtlas_sampler: sampler;
@group(2) @binding(2) var u_brdfLUT_texture: texture_2d<f32>;            // BRDF LUT
@group(2) @binding(3) var u_brdfLUT_sampler: sampler;
// The environment reflection where no probe volume applies: the scene's environment map (8-bit sRGB,
// box-filtered mips) or, without one, the sky light's sky GGX-prefiltered (linear HDR, mip = roughness).
// Which one is `u_envMapMode`.
@group(2) @binding(4) var u_envMap_texture: texture_cube<f32>;
@group(2) @binding(5) var u_envMap_sampler: sampler;

/** Lighting probes per frame. Must match MAX_LIGHTING_PROBES in render/probeLighting.ts. */
const MAX_LIGHT_PROBES: i32 = 16;
/** Reflecting probes per frame. Must match MAX_REFLECTION_PROBES in render/reflectionAtlas.ts. */
const MAX_REFLECTION_PROBES: i32 = 16;
/** The atlas's border, a fraction of each mip's side. Must match REFLECTION_BORDER in reflectionAtlas.ts. */
const REFLECTION_BORDER: f32 = 0.0625;

// --- Lights: structs and the BRDF come from chunks/pbrLighting.wgsl ------------------------------

struct Lighting {
    u_invViewProj: mat4x4<f32>,     // reconstruct world position from depth
    u_view: mat4x4<f32>,
    /** The lighting probes, most specific (smallest volume) first: world -> unit cube, per probe. */
    u_lightProbeInvVolume: array<mat4x4<f32>, 16>,
    /** Their irradiance, 9 radiance-form SH coefficients each (probe i at 9i), x intensity x pre-exposure. */
    u_lightProbeSH: array<vec4<f32>, 144>,
    /** xyz = the feather as a fraction of the unit cube, w = 1 for an unbounded probe. */
    u_lightProbeBlend: array<vec4<f32>, 16>,
    /** The reflecting probes, in the same claim order: world -> unit cube (inside = |xyz| <= 0.5). */
    u_reflProbeInvVolume: array<mat4x4<f32>, 16>,
    /** xyz = the feather, w = 1 unbounded. */
    u_reflProbeBlend: array<vec4<f32>, 16>,
    /** x = atlas layer, y = intensity x pre-exposure, z = 1 box projection, w unused. */
    u_reflProbeParams: array<vec4<f32>, 16>,
    /** xyz = where the probe captured (its world position), for box projection. */
    u_reflProbeCapture: array<vec4<f32>, 16>,
    /**
     * Their irradiance's LUMINANCE, L0 and L1 (x the constant term, yzw the linear one in the normal's x,
     * y, z), E/pi x intensity x pre-exposure: what the GI Volumes' reflection normalization compares the
     * volumes' light with. x = 0 for a probe with none projected yet, which is left as it is.
     */
    u_reflProbeIrradiance: array<vec4<f32>, 16>,

    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,

    u_viewPos: vec3<f32>,
    /** Scene-wide indirect fill, in internal radiance units. Replaces the per-light ambient. */
    u_sceneAmbient: vec3<f32>,
    /** The sky light's intensity x tint, on the sky reflection (`u_envMapMode` 2). */
    u_skyReflectionScale: vec3<f32>,
    /** One AO texel in this pass's UV space; (0,0) means the AO buffer is full resolution. */
    u_ssaoTexelSize: vec2<f32>,
    /** The same for the SSR buffer. */
    u_ssrTexelSize: vec2<f32>,
    /** The same for the GI buffer. */
    u_giTexelSize: vec2<f32>,

    /** Scale on SSIL's bounce (`.rgb`); 0 leaves its visibility as plain ambient occlusion. */
    u_ssilIntensity: f32,
    u_reflProbeCount: i32,          // reflecting probes in u_reflProbe*: 0 = the environment fallback alone
    u_lightProbeCount: i32,         // lighting probes in u_lightProbe*: 0 = the ambient and sky light alone
    // i32 rather than bool: WGSL forbids bool in a uniform buffer.
    /** 0 = no environment reflection, 1 = the scene environment map, 2 = the prefiltered sky. */
    u_envMapMode: i32,
    u_ssaoEnabled: i32,
    /** 0 restores the pre-phase-4 behaviour of occluding both lobes by the same hemisphere term. */
    u_specularOcclusion: i32,
    /** 0 lets a normal-mapped surface keep reflecting the sky along rays that point into itself. */
    u_horizonOcclusion: i32,
    /** Whether the SSR pass produced a result THIS frame (SsrPasses.ssrProducedThisFrame). */
    u_ssrEnabled: i32,
    /** Whether the GI Volumes' apply produced a result THIS frame (GiSystem.producedThisFrame). */
    u_giEnabled: i32,
    /**
     * The frame's pre-exposure (graphics/preExposure.ts). The lights, ambient, sky light, probes and sky
     * reflection arrive multiplied by it; the G-buffer emissive and the scene environment map are
     * absolute, so this pass scales those two itself.
     */
    u_preExposure: f32,
};
@group(1) @binding(0) var<uniform> u_lighting: Lighting;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_lighting.u_invViewProj * clip;
    return world.xyz / world.w;
}

/**
 * The GEOMETRIC normal, rebuilt from the depth buffer, for `horizonOcclusion`.
 *
 * The G-buffer carries the SHADING normal only, and horizon occlusion is precisely a comparison
 * between the two — a term computed against one normal twice is identically 1, because `reflect` can
 * never send a ray below the normal it reflected about. A second normal is not optional here.
 *
 * Storing one would cost a fourth attachment: a direction is two channels even oct-packed, and the one
 * channel this pass freed by oct-packing the shading normal already went to reflectance. Depth is
 * already bound, already reconstructed to world space one line above, and the surface it describes is
 * exactly the geometry — so four extra taps buy what 8 bytes per pixel per frame would have.
 *
 * MIN-ABS NEIGHBOUR SELECTION, which is the whole difficulty. A plain forward difference straddles
 * silhouettes: at the edge of an object one of the two neighbours belongs to whatever is behind it, and
 * the cross product of that pair describes a plane joining two unrelated surfaces — nearly edge-on to
 * the camera, so `dot(R, Ng)` goes hard negative and the term paints a black outline around every
 * object. Picking, per axis, whichever neighbour's depth is CLOSER to the centre keeps both samples on
 * the near surface; the winding is then corrected by the sign the choice implies, or half the
 * the near surface.
 *
 * No derivatives, deliberately: `dpdx` would be shorter and is illegal here, since this pass discards
 * on background before it reaches any of this. Explicit taps carry no uniformity requirement.
 */
fn geometricNormal(uv: vec2<f32>, centerDepth: f32, centerPos: vec3<f32>) -> vec3<f32> {
    let texel = 1.0 / vec2<f32>(textureDimensions(u_gDepth_texture, 0));
    let dx = vec2<f32>(texel.x, 0.0);
    let dy = vec2<f32>(0.0, texel.y);

    let dL = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv - dx, 0);
    let dR = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv + dx, 0);
    let dU = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv - dy, 0);
    let dD = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv + dy, 0);

    let leftCloser = abs(dL - centerDepth) < abs(dR - centerDepth);
    let upCloser = abs(dU - centerDepth) < abs(dD - centerDepth);
    let uvX = select(uv + dx, uv - dx, leftCloser);
    let uvY = select(uv + dy, uv - dy, upCloser);
    let depthX = select(dR, dL, leftCloser);
    let depthY = select(dD, dU, upCloser);

    let alongX = reconstructWorldPos(uvX, depthX) - centerPos;
    let alongY = reconstructWorldPos(uvY, depthY) - centerPos;
    let n = cross(alongX, alongY);
    // A degenerate pair — two coincident reconstructions, which a flat far plane produces — would
    // normalise to NaN and take every lit pixel downstream with it.
    if (dot(n, n) < 1e-20) { return vec3<f32>(0.0, 1.0, 0.0); }

    // ORIENTED TOWARD THE VIEWER rather than by a winding rule, and that is not laziness. The sign of
    // this cross product depends on which way the uv axes run AND on which neighbour the min-abs test
    // picked on each axis — four combinations, two of them inverted, and a backward choice happens
    // exactly at the silhouettes where being wrong is most visible. A visible surface faces the camera
    // by definition, so that fact settles the sign for all four cases at once.
    let toEye = u_lighting.u_viewPos - centerPos;
    return normalize(n) * select(-1.0, 1.0, dot(n, toEye) >= 0.0);
}

// --- Image-based lighting -----------------------------------------------------------------------

/**
 * Feathered containment weight of worldPos in a probe's volume: 1 well inside, easing to 0 at the
 * boundary over the blend feather, 0 outside. Unbounded probes weigh 1 everywhere.
 */
fn probeWeight(worldPos: vec3<f32>, invVolume: mat4x4<f32>, blend: vec3<f32>, unbounded: i32) -> f32 {
    if (unbounded != 0) { return 1.0; }
    let local = (invVolume * vec4<f32>(worldPos, 1.0)).xyz;
    let edge = vec3<f32>(0.5) - abs(local);      // distance to the boundary in unit-cube space
    if (any(edge <= vec3<f32>(0.0))) { return 0.0; }
    let t = clamp(edge / max(blend, vec3<f32>(1e-5)), vec3<f32>(0.0), vec3<f32>(1.0));
    let s = t * t * (3.0 - 2.0 * t);             // smoothstep
    return min(s.x, min(s.y, s.z));
}

/**
 * Indirect light, kept SPLIT rather than summed.
 *
 * The two lobes are occluded differently — a hemisphere-wide AO term is right for diffuse and wrong for
 * specular — so they cannot be added until after occlusion is applied. See `computeSpecularAO`.
 */
struct IndirectLight {
    diffuse: vec3<f32>,
    specular: vec3<f32>,
};

/**
 * The split sum's environment BRDF for reflectance `F0`, from the baked LUT's pair (brdf.wgsl): `F0 * A + B`.
 * The pair already integrates Fresnel over the GGX lobe, so nothing multiplies a Fresnel term onto it.
 */
fn envSplitSum(F0: vec3<f32>, brdf: vec2<f32>) -> vec3<f32> {
    return F0 * brdf.x + vec3<f32>(brdf.y);
}

/** The atlas uv a direction is sampled at: reflectionAtlas.ts `octAtlasUv`. */
fn reflectionAtlasUv(dir: vec3<f32>) -> vec2<f32> {
    let e = octEncode(dir);
    return vec2<f32>(REFLECTION_BORDER) + (e * 0.5 + vec2<f32>(0.5)) * (1.0 - 2.0 * REFLECTION_BORDER);
}

/**
 * Box projection (parallax correction, Lagarde's local cubemap): the reflected ray from `worldPos` meets
 * the probe's box somewhere, and the probe saw that point in the direction from where it captured, not
 * along `R` — which is what puts a room's walls in the right place on its floor. The intersection runs in
 * the box's unit cube, where `t` is the same as in the world (the map is affine). Unbounded or flagged off,
 * `R` unchanged.
 */
fn boxProjected(R: vec3<f32>, worldPos: vec3<f32>, invVolume: mat4x4<f32>, capture: vec3<f32>) -> vec3<f32> {
    let o = (invVolume * vec4<f32>(worldPos, 1.0)).xyz;
    let d = (invVolume * vec4<f32>(R, 0.0)).xyz;
    // The exit distance along d from inside the box: the nearest of the three far planes.
    let safe = select(d, vec3<f32>(1e-6), abs(d) < vec3<f32>(1e-6));
    let tFar = (sign(safe) * 0.5 - o) / safe;
    let t = max(min(tFar.x, min(tFar.y, tFar.z)), 0.0);
    return normalize(worldPos + R * t - capture);
}

/** Split-sum specular IBL from one reflecting probe's atlas layer, along `dir` (R, or box-projected). */
fn probeReflection(layer: i32, dir: vec3<f32>, N: vec3<f32>, V: vec3<f32>, roughness: f32, F0: vec3<f32>) -> vec3<f32> {
    let NoV = max(dot(N, V), 0.0);
    let prefiltered = textureSampleLevel(u_reflectionAtlas_texture, u_reflectionAtlas_sampler,
                                         reflectionAtlasUv(dir), layer, roughness * MAX_REFLECTION_LOD).rgb;
    let brdf = textureSampleLevel(u_brdfLUT_texture, u_brdfLUT_sampler,
                                  vec2<f32>(NoV, roughness), 0.0).rg;
    // The split-sum term uses the REAL baked LUT, which this pass has bound and the forward paths
    // cannot. Only the multi-scatter multiplier is the analytic fit — deliberately, so that a surface
    // shaded forward and the same surface shaded deferred recover the same amount of energy.
    //
    // `F0 * A + B`, Karis's split sum: the LUT's two terms ARE the Fresnel integral (brdf.wgsl: A takes
    // (1 - Fc), B takes Fc over the lobe). Scaling A by a Schlick Fresnel of NoV on top, as this used to,
    // counted Fresnel twice, and most at grazing angles: rough ground and cliffs seen across the valley
    // reflected two to three times what they should and read glossy from a distance. See `envSplitSum`.
    return prefiltered * envSplitSum(F0, brdf) * energyCompensation(F0, NoV, roughness);
}

/** Lighting probe `i`'s irradiance at a surface facing `n`, as a probe's irradiance cube gave it (E/pi). */
fn lightProbeIrradiance(i: i32, n: vec3<f32>) -> vec3<f32> {
    let base = i * 9;
    var sh: array<vec4<f32>, 9>;
    for (var k = 0; k < 9; k++) { sh[k] = u_lighting.u_lightProbeSH[base + k]; }
    return shEval(sh, n) * (1.0 / PI);
}

/**
 * Fetch a buffer smaller than this pass — SSIL's or SSR's — upsampling it depth-aware.
 *
 * A plain bilinear fetch blends the four nearest texels regardless of what geometry they belong to. At
 * half resolution that blends a foreground silhouette's AO (or reflection) into the background behind it
 * and vice versa, which reads as a halo hugging every object edge. Weighting each tap by how close its
 * depth is to this pixel's confines the blend to texels that are actually on the same surface; where none
 * are (a hard depth discontinuity) it falls back to the single nearest tap, which is aliased but correct
 * rather than smeared.
 *
 * Skipped entirely when the buffer is already full resolution (`texelSize` x <= 0) — there is nothing to
 * reconstruct, and the hardware bilinear fetch is exact.
 */
// `textureSampleLevel`, not `textureSample`: this helper is reached from a loop and from behind
// an early return, which WGSL treats as NON-UNIFORM control flow - and implicit-LOD sampling is
// only legal in uniform control flow, so Dawn refuses the whole module with "'textureSample' must
// only be called from uniform control flow". An invalid module means an invalid pipeline, and an
// invalid pipeline draws nothing while its pass still clears. Explicit level 0 is exactly what the
// implicit form resolved to anyway: every texture sampled here is screen-sized and un-mipped.
fn depthAwareUpsample(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>, centerDepth: f32,
                      texelSize: vec2<f32>) -> vec4<f32> {
    if (texelSize.x <= 0.0) {
        return textureSampleLevel(tex, smp, uv, 0.0);   // full-res: nothing to do
    }

    // The four texels surrounding this pixel, and the depths they were computed from.
    var offsets = array<vec2<f32>, 4>(
        vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
        vec2<f32>(-0.5,  0.5), vec2<f32>(0.5,  0.5),
    );

    var total = vec4<f32>(0.0);
    var weightSum = 0.0;
    var nearest = vec4<f32>(0.0);
    var nearestDelta = 1e9;

    for (var i = 0; i < 4; i++) {
        let tapUV = uv + offsets[i] * texelSize;
        let tap = textureSampleLevel(tex, smp, tapUV, 0.0);
        // Compare in linear-ish terms: raw device depth is wildly non-linear, so a fixed epsilon on it
        // would be far too strict near the camera and far too loose in the distance. Dividing by the
        // centre depth makes the tolerance relative, which behaves at both ends.
        let d = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, tapUV, 0);
        let delta = abs(d - centerDepth) / max(centerDepth, 1e-5);

        if (delta < nearestDelta) { nearestDelta = delta; nearest = tap; }

        let w = 1.0 - smoothstep(0.0, AO_DEPTH_TOLERANCE, delta);
        total += tap * w;
        weightSum += w;
    }

    // Every neighbour rejected: this pixel sits on a depth discontinuity, so take the closest match
    // rather than averaging across the edge.
    if (weightSum < 1e-4) { return nearest; }
    return total / weightSum;
}

/** SSIL: bounce in `.rgb`, visibility in `.a`. Disabled reads as no bounce and full visibility. */
fn sampleSSIL(uv: vec2<f32>, centerDepth: f32) -> vec4<f32> {
    if (u_lighting.u_ssaoEnabled == 0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    return depthAwareUpsample(u_ssao_texture, u_ssao_sampler, uv, centerDepth, u_lighting.u_ssaoTexelSize);
}

/** SSR: reflected light in `.rgb`, its share in `.a`. Disabled reads as no share at all. */
fn sampleSSR(uv: vec2<f32>, centerDepth: f32) -> vec4<f32> {
    if (u_lighting.u_ssrEnabled == 0) { return vec4<f32>(0.0); }
    let s = depthAwareUpsample(u_ssr_texture, u_ssr_sampler, uv, centerDepth, u_lighting.u_ssrTexelSize);
    // One bad texel would otherwise be lit into the frame and then reflected again next frame.
    let ok = all(s >= vec4<f32>(0.0)) && all(s.rgb <= vec3<f32>(6.0e4)) && s.a <= 1.0;
    return select(vec4<f32>(0.0), s, ok);
}

/**
 * The GI Volumes' light, computed at reduced resolution (giResolve.wgsl), brought up to this pixel.
 *
 * Depth alone, as `depthAwareUpsample` weighs SSIL and SSR, is not enough here: a volume's light depends
 * on the surface's NORMAL, and at a crease — a wall meeting the floor — the depths on either side agree
 * while the light does not, so a depth-only blend paints a band of floor light up the foot of every wall.
 * Each of the four low-resolution texels round the pixel is weighed by its bilinear share, by how close the
 * depth it was computed at is to this pixel's, and by how closely the normal it was computed with
 * (`pow(n . N, 8)`) matches; read at the G-buffer texel the resolve took it from (`giSourceTexel`), so the
 * comparison is exact. Where none agrees (a silhouette, a thin edge), the best-matching one.
 */
fn giUpsample(centerDepth: f32, N: vec3<f32>) -> vec4<f32> {
    let full = vec2<f32>(textureDimensions(u_gNormalRoughness_texture));
    let low = vec2<f32>(textureDimensions(u_gi_texture));
    // This pixel's centre in the low-resolution grid, whose texel centres sit at +0.5.
    let here = (floor(cleoFragCoord) + vec2<f32>(0.5)) * low / full - vec2<f32>(0.5);
    let q0 = floor(here);
    let f = here - q0;
    var total = vec4<f32>(0.0);
    var weightSum = 0.0;
    var best = vec4<f32>(0.0);
    var bestScore = -1.0;
    for (var i = 0; i < 4; i++) {
        let o = vec2<f32>(f32(i & 1), f32((i >> 1u) & 1));
        let q = clamp(q0 + o, vec2<f32>(0.0), low - vec2<f32>(1.0));
        let tap = textureLoad(u_gi_texture, vec2<i32>(q), 0);
        let src = vec2<i32>(floor(q * full / low));
        // Depth SAMPLED at the texel's centre: naga's GLSL cannot textureLoad a depth texture.
        let d = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, (vec2<f32>(src) + vec2<f32>(0.5)) / full, 0);
        let n = octDecode(textureLoad(u_gNormalRoughness_texture, src, 0).rg);
        let depthW = 1.0 - smoothstep(0.0, AO_DEPTH_TOLERANCE, abs(d - centerDepth) / max(centerDepth, 1e-5));
        let score = depthW * pow(saturate(dot(N, n)), 8.0);
        let w = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y) * score;
        total += tap * w;
        weightSum += w;
        if (score > bestScore) { bestScore = score; best = tap; }
    }
    if (weightSum < 1e-4) { return best; }
    return total / weightSum;
}

/** GI Volumes: claimed irradiance in `.rgb`, the claim in `.a`. Disabled reads as nothing claimed. */
fn sampleGI(uv: vec2<f32>, centerDepth: f32, N: vec3<f32>) -> vec4<f32> {
    if (u_lighting.u_giEnabled == 0) { return vec4<f32>(0.0); }
    var s: vec4<f32>;
    if (u_lighting.u_giTexelSize.x <= 0.0) {
        s = textureSampleLevel(u_gi_texture, u_gi_sampler, uv, 0.0);   // full resolution: nothing to do
    } else {
        s = giUpsample(centerDepth, N);
    }
    let ok = all(s >= vec4<f32>(0.0)) && all(s.rgb <= vec3<f32>(6.0e4)) && s.a <= 1.0001;
    return select(vec4<f32>(0.0), vec4<f32>(s.rgb, min(s.a, 1.0)), ok);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The shadow library reads the fragment coordinate through a module-scope global, because only an
    // entry point receives @builtin(position). Publish it before calling in.
    cleoFragCoord = in.position.xy;

    let uv = in.uv;
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    // Background (no geometry) — leave for the skybox pass.
    if (depth >= 1.0) { discard; }

    let albedoMetallic = textureSampleLevel(u_gAlbedoMetallic_texture,
                                        u_gAlbedoMetallic_sampler, uv, 0.0);
    let normalRoughness = textureSampleLevel(u_gNormalRoughness_texture,
                                         u_gNormalRoughness_sampler, uv, 0.0);
    let emissiveAO = textureSampleLevel(u_gEmissiveAO_texture, u_gEmissiveAO_sampler, uv, 0.0);

    // The alpha is SIGNED: a translucent dielectric (leaf, grass) stores `-translucency` where metallic
    // would be — see chunks/pbrGBuffer.wgsl. Transmission is ADDITIVE: the lit face shades exactly as an
    // opaque one, and `thinTransmission` below adds the glow through the unlit side. Scaling the front by
    // `1 - translucency` (energy conserving) made sun-lit leaves read as shadowed.
    let translucency = max(-albedoMetallic.a, 0.0);
    let metallic = max(albedoMetallic.a, 0.0);
    let albedo = albedoMetallic.rgb;
    // A translucent texel stores its transmission tint where reflectance goes (chunks/translucencyTint.wgsl):
    // what comes through the back is the albedo blended toward it, and its specular is the default level.
    let tint = select(vec4<f32>(1.0, 1.0, 1.0, 0.0), unpackTranslucencyTint(normalRoughness.b), translucency > 0.0);
    let surfaceAlbedo = transmissionAlbedo(albedo, tint.rgb, tint.a);
    // Two channels, not three — see chunks/octNormal.wgsl. The third now carries the dielectric
    // specular level, which is why every non-metal in the scene no longer has identical reflectivity.
    let N = octDecode(vec2<f32>(normalRoughness.x, normalRoughness.y));
    let reflectance = select(normalRoughness.b, 0.5, translucency > 0.0);
    let roughness = normalRoughness.a;
    let emissive = emissiveAO.rgb * u_lighting.u_preExposure;
    let ao = emissiveAO.a;

    let worldPos = reconstructWorldPos(uv, depth);
    let V = normalize(u_lighting.u_viewPos - worldPos);

    // Indirect lighting. When a light probe / environment is available, use full split-sum IBL
    // (diffuse irradiance + prefiltered specular + BRDF LUT); otherwise fall back to flat ambient.
    // `dielectricF0(reflectance)`, not the 0.04 literal this used to hardcode. A conductor still takes
    // its base colour; what changes is that water, skin and a gemstone stop sharing one specular level.
    let F0 = mix(vec3<f32>(dielectricF0(reflectance)), albedo, metallic);
    let ssil = sampleSSIL(uv, depth);

    // Fallback indirect term used where no probe volume applies: the scene ambient as a simple fill
    // floor, plus a crude env reflection when a map is present. The sky light is scene-wide indirect: it
    // belongs in the FALLBACK term, so a light probe still wins wherever its volume covers the pixel and
    // the two blend by the same weights as before. That is why it is added here rather than after the
    // probe blend.
    var indirect: IndirectLight;
    indirect.diffuse = (u_lighting.u_sceneAmbient
                        + skyIrradiance(u_lighting.u_skyLight, N)) * albedo;
    // A translucent surface also takes the fill arriving at its BACK face, through itself.
    if (translucency > 0.0) {
        indirect.diffuse += (u_lighting.u_sceneAmbient + skyIrradiance(u_lighting.u_skyLight, -N))
                          * surfaceAlbedo * (translucency * TRANSMISSION_AMBIENT);
    }
    indirect.specular = vec3<f32>(0.0);
    if (u_lighting.u_envMapMode == 2) {
        // The sky, GGX-prefiltered exactly as a probe's capture is (SkyPasses.updateSkyReflection), so it
        // takes the probe's split-sum term and no roughness ramp: the blur is real here.
        let NoV = max(dot(N, V), 0.0);
        let R = reflect(-V, N);
        let sky = textureSampleLevel(u_envMap_texture, u_envMap_sampler, R, roughness * MAX_REFLECTION_LOD).rgb;
        let brdf = textureSampleLevel(u_brdfLUT_texture, u_brdfLUT_sampler, vec2<f32>(NoV, roughness), 0.0).rg;
        indirect.specular = sky * u_lighting.u_skyReflectionScale * envSplitSum(F0, brdf)
                          * energyCompensation(F0, NoV, roughness);
    } else if (u_lighting.u_envMapMode == 1) {
        let NoV = max(dot(N, V), 0.0);
        let R = reflect(-V, N);
        // DECODED: the environment map is six 8-bit images holding sRGB-encoded colour (scene.ts builds
        // it from them, and the engine has no sRGB texture format to decode on read). Read raw, every
        // reflection of it was the encoded value treated as light — roughly twice too bright in the
        // midtones, and brighter than the same cube reflected by a forward material, which decodes.
        // The engine's own decode (chunks/tonemap.wgsl toLinear), as forward and the sky light use.
        let env = pow(textureSampleLevel(u_envMap_texture, u_envMap_sampler, R,
                                         roughness * MAX_REFLECTION_LOD).rgb, vec3<f32>(2.2))
                  * u_lighting.u_preExposure;
        // TWO SEPARATE FACTORS that used to be one, and the distinction is the whole point.
        //
        // The DFG pair is ENERGY: how much of the incoming environment a surface of this roughness and
        // this f0 actually reflects. It replaces the `kS` Fresnel this used to use, which was the right
        // shape but not the right integral.
        //
        // The roughness ramp is NOT energy. The cube DOES have a mip chain — `Texture` defaults
        // `mipMap` to true and scene.ts does not opt out — so the level fetch below is a real blur.
        // But `generateMipmap` box-filters each face independently: it is not a GGX prefilter, and on
        // WebGL2 cube mips do not filter across face seams. So the chain under-blurs, and at high
        // roughness it would still show a recognisable sky where a prefiltered probe shows a wash.
        // The ramp covers that gap. A light probe is the real answer and does the prefilter properly;
        // this branch is the fallback for scenes that have no probe at all.
        let dfg = EnvBRDFApprox(NoV, roughness);
        let sharpnessFade = pow(1.0 - roughness, 4.0);
        indirect.specular = env * (F0 * dfg.x + dfg.y)
                          * energyCompensation(F0, NoV, roughness) * sharpnessFade;
    }

    // LIGHTING from the light probes: every one whose volume holds this pixel, the most specific (smallest)
    // first, each claiming its feathered weight of what the ones before it left; the ambient and the sky
    // light keep the rest. The probes and their order are the frame's, not the camera's
    // (render/probeLighting.ts), so a room is as dark seen through its door as from inside it.
    //
    // `(1 - metallic)` on the probe term, matching `accumulateLight`: a metal has no diffuse. The `(1 - F)`
    // factor this once carried is not in any modern reference BRDF and double-counted Fresnel.
    //
    // The GI Volumes claim FIRST: theirs is the most specific light there is, per point inside the box
    // rather than one value for it. What they leave the probes share as before.
    // An ADDITIVE volume's claim is not in `a`: its light goes on top of the fill rather than in its place.
    let gi = sampleGI(uv, depth, N);            // rgb = sum of claim x E/pi (pre-exposed, x intensity), a = share replaced
    var fallbackShare = 1.0 - gi.a;
    var probeDiffuse = gi.rgb;
    var probeBack = gi.rgb;                  // a translucent surface's back takes the front's GI (v1)
    for (var i = 0; i < min(u_lighting.u_lightProbeCount, MAX_LIGHT_PROBES); i++) {
        if (fallbackShare <= 1e-3) { break; }
        let blend = u_lighting.u_lightProbeBlend[i];
        let w = probeWeight(worldPos, u_lighting.u_lightProbeInvVolume[i], blend.xyz, i32(blend.w));
        if (w <= 0.0) { continue; }
        let claim = w * fallbackShare;
        probeDiffuse += lightProbeIrradiance(i, N) * claim;
        if (translucency > 0.0) { probeBack += lightProbeIrradiance(i, -N) * claim; }
        fallbackShare -= claim;
        if (fallbackShare <= 1e-3) { break; }
    }
    indirect.diffuse = indirect.diffuse * fallbackShare + probeDiffuse * (1.0 - metallic) * albedo;
    if (translucency > 0.0) {
        // The fill through the back face, as the fallback above takes it.
        indirect.diffuse += probeBack * surfaceAlbedo * (translucency * TRANSMISSION_AMBIENT);
    }

    // REFLECTIONS from the reflecting probes, as the lighting above: each claims its feathered weight of what
    // the ones before it left, the smallest box first, and the environment fallback keeps the rest. The same
    // answer wherever the camera is.
    //
    // Normalized by the GI Volumes where they light the pixel (Lagarde & de Rousiers 2014): a probe saw its
    // room's light once, from one point, so where the volumes put more or less light on this surface than
    // the probe received, its reflection scales by the same ratio. A corner reflects darker than the middle
    // of the room, and a room the volumes darken stops reflecting the brighter light its probe captured.
    // The sky reflection, below, scales the same way against the open sky's light: a room with no probe
    // of its own no longer mirrors the bright sky from its floor. Additive volumes replace nothing (`a` 0),
    // so under them the reflections stay the fill's, unscaled.
    let giLum = select(0.0, dot(gi.rgb, GI_LUMA) / max(gi.a, 1e-4), gi.a > 1e-3);
    var envShare = 1.0;
    var probeSpecular = vec3<f32>(0.0);
    let Rv = reflect(-V, N);
    for (var i = 0; i < min(u_lighting.u_reflProbeCount, MAX_REFLECTION_PROBES); i++) {
        let blend = u_lighting.u_reflProbeBlend[i];
        let w = probeWeight(worldPos, u_lighting.u_reflProbeInvVolume[i], blend.xyz, i32(blend.w));
        if (w <= 0.0) { continue; }
        let params = u_lighting.u_reflProbeParams[i];
        var dir = Rv;
        if (params.z > 0.5 && blend.w < 0.5) {
            dir = boxProjected(Rv, worldPos, u_lighting.u_reflProbeInvVolume[i], u_lighting.u_reflProbeCapture[i].xyz);
        }
        let claim = w * envShare;
        var norm = 1.0;
        let irr = u_lighting.u_reflProbeIrradiance[i];
        if (gi.a > 1e-3 && irr.x > 0.0) {
            let probeLum = max(irr.x + dot(irr.yzw, N), 0.05 * irr.x);
            norm = mix(1.0, clamp(giLum / probeLum, 0.0, 2.0), gi.a);
        }
        probeSpecular += probeReflection(i32(params.x), dir, N, V, roughness, F0) * (params.y * claim * norm);
        envShare -= claim;
        if (envShare <= 1e-3) { break; }
    }
    var envNorm = 1.0;
    if (gi.a > 1e-3 && u_lighting.u_envMapMode == 2) {
        let open = dot(u_lighting.u_sceneAmbient + skyIrradiance(u_lighting.u_skyLight, N), GI_LUMA);
        if (open > 0.0) { envNorm = mix(1.0, clamp(giLum / open, 0.0, 1.0), gi.a); }
    }
    indirect.specular = indirect.specular * (envShare * envNorm) + probeSpecular;

    // Distance in front of the camera, which is what selects a cascade.
    let viewDepth = -(u_lighting.u_view * vec4<f32>(worldPos, 1.0)).z;

    var Lo = vec3<f32>(0.0);

    // Once, and reused by the cascade tint below: every call inlines the whole cascade filter (two
    // cascades, both filter loops), and a second call doubled the program the driver has to compile.
    //
    // A translucent pixel lit from BEHIND looks the shadow up with its normal turned toward the light.
    // The lookup offsets along the normal; along the unflipped one it would step away from the sun,
    // into the leaf's own shadow, and the transmission would shadow itself out. The reflected lobe is
    // zero on that side anyway, so the one lookup serves both.
    let sunL = -u_lighting.u_dirLight.direction;
    let sunShadowN = select(N, -N, translucency > 0.0 && dot(N, sunL) < 0.0);
    let sunShadow = directionalShadow(worldPos, sunShadowN, viewDepth);
    Lo += evaluateDirectionalLight(u_lighting.u_dirLight, N, V, albedo, metallic, roughness, 1.0 - sunShadow);
    if (translucency > 0.0) {
        Lo += evaluateDirectionalTransmission(u_lighting.u_dirLight, N, V, surfaceAlbedo, translucency,
                                              1.0 - sunShadow);
    }

    // Every punctual light that reaches THIS fragment, out of however many the scene has. The two
    // fixed-length loops this replaced ran over 16 point and 8 spot slots for every pixel on screen.
    let cluster = cleoClusterOf(cleoFragCoord, viewDepth);
    let first = cleoClusterOffset(cluster);
    let count = cleoClusterCount(cluster);
    for (var i = 0; i < count; i++) {
        let cl = cleoLight(cleoClusterLight(first + i));
        if (cleoLightReaches(cl.light, worldPos)) {
            // Same normal turn as the sun's, for the same reason.
            let shadowN = select(N, -N, translucency > 0.0 && dot(N, cl.light.position - worldPos) < 0.0);
            let visibility = cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot,
                                                    worldPos, shadowN, cl.light.position);
            Lo += evaluateSpotLight(cl.light, worldPos, N, V, albedo, metallic, roughness, visibility);
            if (translucency > 0.0) {
                Lo += evaluateSpotTransmission(cl.light, worldPos, N, V, surfaceAlbedo, translucency, visibility);
            }
        }
    }

    // Output LINEAR HDR radiance. Exposure, tonemap and sRGB encode are applied once at the final
    // present. Unlit "basic" materials arrive as zero albedo + authored emissive, so they pass straight
    // through here and are tonemapped uniformly with everything else.
    //
    // The two indirect lobes take DIFFERENT occlusion. `ao` (the material's map) and SSIL's visibility both measure
    // how much of the hemisphere is blocked, which is the right question for diffuse and the wrong one
    // for a narrow specular cone — see `computeSpecularAO`. Multiplying both by the same number is what
    // used to strip the reflection off a polished floor standing in a corner.
    let diffuseAO = ao * ssil.a;
    var specularAO = diffuseAO;
    if (u_lighting.u_specularOcclusion != 0) {
        specularAO = computeSpecularAO(max(dot(N, V), 0.0), diffuseAO, roughness);
    }
    // Horizon occlusion rides on the same factor, because it is the same kind of statement: how much
    // of the specular lobe survives. One multiply here covers BOTH indirect specular sources — the
    // probe blend and the env fallback — which is why it is applied to the factor and not to either
    // term. The geometric normal is rebuilt from depth; see `geometricNormal`.
    var horizon = 1.0;
    if (u_lighting.u_horizonOcclusion != 0) {
        let Ng = geometricNormal(uv, depth, worldPos);
        horizon = horizonOcclusion(reflect(-V, N), Ng);
    }
    specularAO *= horizon;
    var specular = indirect.specular * specularAO;

    // Screen-space reflections, over whichever environment reflection the probe blend above settled on.
    // The SSR light is already normalised the way a prefiltered cube is (see ssrResolve.wgsl), so it
    // takes the very split-sum term `probeReflection` applies — the two cannot disagree about energy. Only the
    // environment's share takes the specular occlusion: a ray that FOUND something has its occlusion in
    // it already, and a corner's mirror reflection of the wall beside it is not darkened by that wall.
    // Horizon occlusion is a statement about the ray direction rather than about nearby geometry, so it
    // applies to both.
    let ssr = sampleSSR(uv, depth);
    if (ssr.a > 0.0) {
        let NoV = max(dot(N, V), 0.0);
        let brdf = textureSampleLevel(u_brdfLUT_texture, u_brdfLUT_sampler, vec2<f32>(NoV, roughness), 0.0).rg;
        let ssrSpecular = ssr.rgb * envSplitSum(F0, brdf) * energyCompensation(F0, NoV, roughness) * horizon;
        specular = mix(specular, ssrSpecular, ssr.a);
    }
    var color = indirect.diffuse * diffuseAO + specular + Lo + emissive;
    // SSIL's bounce: the light the occluders above send back, in the directions `ssil.a` just took the
    // ambient away from — so this replaces what AO removed rather than adding on top of it. Diffuse
    // only, hence (1 - metallic); the material AO still applies, as it does to every indirect term.
    color += albedo * (1.0 - metallic) * ssil.rgb * (u_lighting.u_ssilIntensity * ao);

    // Cascade debug channel: replace the shading with a flat per-cascade tint, modulated by the shadow
    // term so the shadow shapes stay readable inside each coloured band.
    // Compiled out of the shipped variants (CLEO_NO_CASCADE_DEBUG); only the editor's debug view asks for it.
#ifndef CLEO_NO_CASCADE_DEBUG
    if (u_shadow.u_debugCascades != 0) {
        color = cascadeDebugTint(viewDepth) * mix(0.25, 1.0, 1.0 - sunShadow);
    }
#endif

    // Alpha = bloom-eligibility mask: 1 for lit PBR-model surfaces (PBR / terrain / foliage), 0 for
    // unlit "basic" pixels (which write zero albedo). Sampled by the bloom bright-pass so only lit
    // material surfaces bloom.
    var bloomMask = 0.0;
    if (dot(albedo, albedo) > 0.0) { bloomMask = 1.0; }
    // Below the half-float ceiling (graphics/preExposure.ts HDR_STORE_MAX): a dark-adapted camera's
    // pre-exposure can push a sunlit glint past it, and an Inf is turned to black downstream.
    return vec4<f32>(min(color, vec3<f32>(32768.0)), bloomMask);
}
