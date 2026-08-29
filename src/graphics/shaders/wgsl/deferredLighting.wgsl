// Deferred lighting pass: a single fullscreen quad that reads the G-buffer, reconstructs world
// position from depth, and computes PBR (Cook-Torrance) lighting for every opaque pixel. All lights
// are uploaded once per frame here instead of per-object per-shader.

#include "./chunks/fullscreen.wgsl"
// Cascaded shadow maps. Every uniform and every sampling function lives in the shared chunk, so this
// pass, the forward materials, custom materials and the god rays cannot drift apart.
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/octNormal.wgsl"

// Mirrors shaders/constants.glsl. Spelled out here rather than included because the GLSL constants
// file has no WGSL twin and these are the only two values this shader needs from it.
const MAX_POINT_LIGHTS: i32 = 16;
const MAX_SPOTLIGHTS: i32 = 8;

const MAX_REFLECTION_LOD: f32 = 4.0;
/** Relative depth difference beyond which an AO neighbour is treated as a different surface. */
const AO_DEPTH_TOLERANCE: f32 = 0.02;

// --- G-buffer -----------------------------------------------------------------------------------
@group(0) @binding(0) var u_gAlbedoMetallic_texture: texture_2d<f32>;    // rgb = albedo, a = metallic
@group(0) @binding(1) var u_gAlbedoMetallic_sampler: sampler;
@group(0) @binding(2) var u_gNormalRoughness_texture: texture_2d<f32>;   // rg = oct normal, b = reflectance, a = roughness
@group(0) @binding(3) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(4) var u_gEmissiveAO_texture: texture_2d<f32>;        // rgb = emissive, a = ao
@group(0) @binding(5) var u_gEmissiveAO_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_depth_2d;             // non-linear depth
@group(0) @binding(7) var u_gDepth_sampler: sampler;
@group(0) @binding(8) var u_ssao_texture: texture_2d<f32>;
@group(0) @binding(9) var u_ssao_sampler: sampler;

// --- IBL ----------------------------------------------------------------------------------------
//
// Up to 2 light-probe slots with oriented-box influence volumes, selected PER PIXEL with a feathered
// (smoothstep) boundary. Slot samplers are separate scalars rather than an array — a sampler array
// cannot be indexed dynamically in GLSL ES 3.00, which the generated GLSL still has to obey. Holding
// the slot count at 2 keeps this shader inside the 16-sampler ES 3.00 guaranteed minimum.
@group(2) @binding(0) var u_irradiance0_texture: texture_cube<f32>;      // diffuse irradiance
@group(2) @binding(1) var u_irradiance0_sampler: sampler;
@group(2) @binding(2) var u_prefiltered0_texture: texture_cube<f32>;     // prefiltered specular (mip = roughness)
@group(2) @binding(3) var u_prefiltered0_sampler: sampler;
@group(2) @binding(4) var u_irradiance1_texture: texture_cube<f32>;
@group(2) @binding(5) var u_irradiance1_sampler: sampler;
@group(2) @binding(6) var u_prefiltered1_texture: texture_cube<f32>;
@group(2) @binding(7) var u_prefiltered1_sampler: sampler;
@group(2) @binding(8) var u_brdfLUT_texture: texture_2d<f32>;            // BRDF LUT, shared by both slots
@group(2) @binding(9) var u_brdfLUT_sampler: sampler;
// Fallback crude environment reflection (used where no probe volume applies)
@group(2) @binding(10) var u_envMap_texture: texture_cube<f32>;
@group(2) @binding(11) var u_envMap_sampler: sampler;

// --- Lights: structs and the BRDF come from chunks/pbrLighting.wgsl ------------------------------

struct Lighting {
    u_invViewProj: mat4x4<f32>,     // reconstruct world position from depth
    u_view: mat4x4<f32>,
    u_probeInvVolume0: mat4x4<f32>, // world -> unit-cube volume space (inside = |xyz| <= 0.5)
    u_probeInvVolume1: mat4x4<f32>,

    u_dirLight: DirectionalLight,
    u_skyLight: SkyLight,
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,

    u_viewPos: vec3<f32>,
    /** Scene-wide indirect fill, in internal radiance units. Replaces the per-light ambient. */
    u_sceneAmbient: vec3<f32>,
    u_probeBlend0: vec3<f32>,       // per-axis feather as a fraction of the unit cube (0 = hard edge)
    u_probeBlend1: vec3<f32>,
    /** One AO texel in this pass's UV space; (0,0) means the AO buffer is full resolution. */
    u_ssaoTexelSize: vec2<f32>,

    u_iblIntensity0: f32,
    u_iblIntensity1: f32,
    u_numPointLights: i32,
    u_numSpotlights: i32,
    u_probeCount: i32,              // 0 = no baked probes -> flat ambient / crude env fallback
    // i32 rather than bool: WGSL forbids bool in a uniform buffer.
    u_probeUnbounded0: i32,         // true = legacy whole-scene probe (weight 1 everywhere)
    u_probeUnbounded1: i32,
    u_useEnvMap: i32,
    u_ssaoEnabled: i32,
    /** 0 restores the pre-phase-4 behaviour of occluding both lobes by the same hemisphere term. */
    u_specularOcclusion: i32,
    /** 0 lets a normal-mapped surface keep reflecting the sky along rays that point into itself. */
    u_horizonOcclusion: i32,
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
 * Split-sum IBL from one probe slot's cubemaps.
 *
 * The slot's textures are passed by value rather than indexed, because a sampler array cannot be
 * indexed dynamically in the GLSL this compiles down to.
 */
fn probeIBL(irr: texture_cube<f32>, irrSampler: sampler,
            pref: texture_cube<f32>, prefSampler: sampler,
            N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>,
            metallic: f32, roughness: f32, F0: vec3<f32>) -> IndirectLight {
    let NoV = max(dot(N, V), 0.0);
    let F = fresnelSchlickRoughness(NoV, F0, roughness);
    // `(1 - metallic)` alone, matching `accumulateLight`. The `(1 - F)` factor this used to carry is
    // not in any modern reference BRDF and double-counted Fresnel; a metal's reflection and its
    // highlight have to split energy the same way or one of them is wrong.
    let kD = vec3<f32>(1.0 - metallic);
    let R = reflect(-V, N);
    let prefiltered = textureSampleLevel(pref, prefSampler, R, roughness * MAX_REFLECTION_LOD).rgb;
    let brdf = textureSampleLevel(u_brdfLUT_texture, u_brdfLUT_sampler,
                                  vec2<f32>(NoV, roughness), 0.0).rg;

    var result: IndirectLight;
    result.diffuse = kD * textureSampleLevel(irr, irrSampler, N, 0.0).rgb * albedo;
    // The split-sum term uses the REAL baked LUT, which this pass has bound and the forward paths
    // cannot. Only the multi-scatter multiplier is the analytic fit — deliberately, so that a surface
    // shaded forward and the same surface shaded deferred recover the same amount of energy.
    result.specular = prefiltered * (F * brdf.x + brdf.y) * energyCompensation(F0, NoV, roughness);
    return result;
}

/**
 * Fetch ambient occlusion, upsampling depth-aware when the AO buffer is smaller than this pass.
 *
 * A plain bilinear fetch blends the four nearest AO texels regardless of what geometry they belong to.
 * At half resolution that blends a foreground silhouette's AO into the background behind it and vice
 * versa, which reads as a halo hugging every object edge. Weighting each tap by how close its depth is
 * to this pixel's confines the blend to texels that are actually on the same surface; where none are (a
 * hard depth discontinuity) it falls back to the single nearest tap, which is aliased but correct
 * rather than smeared.
 *
 * Skipped entirely when the AO buffer is already full resolution — there is nothing to reconstruct, and
 * the hardware bilinear fetch is exact.
 */
// `textureSampleLevel`, not `textureSample`: this helper is reached from a loop and from behind
// an early return, which WGSL treats as NON-UNIFORM control flow - and implicit-LOD sampling is
// only legal in uniform control flow, so Dawn refuses the whole module with "'textureSample' must
// only be called from uniform control flow". An invalid module means an invalid pipeline, and an
// invalid pipeline draws nothing while its pass still clears. Explicit level 0 is exactly what the
// implicit form resolved to anyway: every texture sampled here is screen-sized and un-mipped.
fn sampleAO(uv: vec2<f32>, centerDepth: f32) -> f32 {
    if (u_lighting.u_ssaoEnabled == 0) { return 1.0; }
    if (u_lighting.u_ssaoTexelSize.x <= 0.0) {
        return textureSampleLevel(u_ssao_texture, u_ssao_sampler, uv, 0.0).r;   // full-res: nothing to do
    }

    // The four AO texels surrounding this pixel, and the depths they were computed from.
    var offsets = array<vec2<f32>, 4>(
        vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5),
        vec2<f32>(-0.5,  0.5), vec2<f32>(0.5,  0.5),
    );

    var total = 0.0;
    var weightSum = 0.0;
    var nearest = 1.0;
    var nearestDelta = 1e9;

    for (var i = 0; i < 4; i++) {
        let tapUV = uv + offsets[i] * u_lighting.u_ssaoTexelSize;
        let ao = textureSampleLevel(u_ssao_texture, u_ssao_sampler, tapUV, 0.0).r;
        // Compare in linear-ish terms: raw device depth is wildly non-linear, so a fixed epsilon on it
        // would be far too strict near the camera and far too loose in the distance. Dividing by the
        // centre depth makes the tolerance relative, which behaves at both ends.
        let d = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, tapUV, 0);
        let delta = abs(d - centerDepth) / max(centerDepth, 1e-5);

        if (delta < nearestDelta) { nearestDelta = delta; nearest = ao; }

        let w = 1.0 - smoothstep(0.0, AO_DEPTH_TOLERANCE, delta);
        total += ao * w;
        weightSum += w;
    }

    // Every neighbour rejected: this pixel sits on a depth discontinuity, so take the closest match
    // rather than averaging across the edge.
    if (weightSum < 1e-4) { return nearest; }
    return total / weightSum;
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

    let albedo = albedoMetallic.rgb;
    let metallic = albedoMetallic.a;
    // Two channels, not three — see chunks/octNormal.wgsl. The third now carries the dielectric
    // specular level, which is why every non-metal in the scene no longer has identical reflectivity.
    let N = octDecode(vec2<f32>(normalRoughness.x, normalRoughness.y));
    let reflectance = normalRoughness.b;
    let roughness = normalRoughness.a;
    let emissive = emissiveAO.rgb;
    let ao = emissiveAO.a;

    let worldPos = reconstructWorldPos(uv, depth);
    let V = normalize(u_lighting.u_viewPos - worldPos);

    // Indirect lighting. When a light probe / environment is available, use full split-sum IBL
    // (diffuse irradiance + prefiltered specular + BRDF LUT); otherwise fall back to flat ambient.
    // `dielectricF0(reflectance)`, not the 0.04 literal this used to hardcode. A conductor still takes
    // its base colour; what changes is that water, skin and a gemstone stop sharing one specular level.
    let F0 = mix(vec3<f32>(dielectricF0(reflectance)), albedo, metallic);
    let ssao = sampleAO(uv, depth);

    // Fallback indirect term used where no probe volume applies: the scene ambient as a simple fill
    // floor, plus a crude env reflection when a map is present. The sky light is scene-wide indirect: it
    // belongs in the FALLBACK term, so a light probe still wins wherever its volume covers the pixel and
    // the two blend by the same weights as before. That is why it is added here rather than after the
    // probe blend.
    var indirect: IndirectLight;
    indirect.diffuse = (u_lighting.u_sceneAmbient
                        + skyIrradiance(u_lighting.u_skyLight, N)) * albedo;
    indirect.specular = vec3<f32>(0.0);
    if (u_lighting.u_useEnvMap != 0) {
        let NoV = max(dot(N, V), 0.0);
        let R = reflect(-V, N);
        let env = textureSampleLevel(u_envMap_texture, u_envMap_sampler, R,
                                     roughness * MAX_REFLECTION_LOD).rgb;
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

    if (u_lighting.u_probeCount > 0) {
        // Priority blend: slot 0 (nearest/bounded first — see Scene.probesForFrame) claims its weight,
        // slot 1 fills what remains, and the fallback covers the rest. A single unbounded probe reduces
        // to w0 = 1 -> exactly the legacy full-IBL result. Both lobes blend by the SAME weights: the
        // split is about how they are occluded, not about where they come from.
        let w0 = probeWeight(worldPos, u_lighting.u_probeInvVolume0, u_lighting.u_probeBlend0,
                             u_lighting.u_probeUnbounded0);
        var w1 = 0.0;
        if (u_lighting.u_probeCount > 1) {
            w1 = probeWeight(worldPos, u_lighting.u_probeInvVolume1, u_lighting.u_probeBlend1,
                             u_lighting.u_probeUnbounded1);
        }
        let c0 = w0;
        let c1 = w1 * (1.0 - w0);
        let rest = (1.0 - w0) * (1.0 - w1);
        indirect.diffuse *= rest;
        indirect.specular *= rest;
        if (c0 > 0.0) {
            let probe = probeIBL(u_irradiance0_texture, u_irradiance0_sampler,
                                 u_prefiltered0_texture, u_prefiltered0_sampler,
                                 N, V, albedo, metallic, roughness, F0);
            let k = u_lighting.u_iblIntensity0 * c0;
            indirect.diffuse += probe.diffuse * k;
            indirect.specular += probe.specular * k;
        }
        if (c1 > 0.0) {
            let probe = probeIBL(u_irradiance1_texture, u_irradiance1_sampler,
                                 u_prefiltered1_texture, u_prefiltered1_sampler,
                                 N, V, albedo, metallic, roughness, F0);
            let k = u_lighting.u_iblIntensity1 * c1;
            indirect.diffuse += probe.diffuse * k;
            indirect.specular += probe.specular * k;
        }
    }

    // Distance in front of the camera, which is what selects a cascade.
    let viewDepth = -(u_lighting.u_view * vec4<f32>(worldPos, 1.0)).z;

    var Lo = vec3<f32>(0.0);

    Lo += evaluateDirectionalLight(u_lighting.u_dirLight, N, V, albedo, metallic, roughness,
                                   1.0 - directionalShadow(worldPos, N, viewDepth));

    for (var i = 0; i < u_lighting.u_numPointLights; i++) {
        Lo += evaluatePointLight(u_lighting.u_pointLights[i], worldPos, N, V, albedo, metallic, roughness);
    }

    for (var i = 0; i < u_lighting.u_numSpotlights; i++) {
        let sl = u_lighting.u_spotlights[i];
        Lo += evaluateSpotLight(sl, worldPos, N, V, albedo, metallic, roughness,
                                1.0 - spotShadowFor(i, worldPos, N, sl.position));
    }

    // Output LINEAR HDR radiance. Exposure, tonemap and sRGB encode are applied once at the final
    // present. Unlit "basic" materials arrive as zero albedo + authored emissive, so they pass straight
    // through here and are tonemapped uniformly with everything else.
    //
    // The two indirect lobes take DIFFERENT occlusion. `ao` (the material's map) and `ssao` both measure
    // how much of the hemisphere is blocked, which is the right question for diffuse and the wrong one
    // for a narrow specular cone — see `computeSpecularAO`. Multiplying both by the same number is what
    // used to strip the reflection off a polished floor standing in a corner.
    let diffuseAO = ao * ssao;
    var specularAO = diffuseAO;
    if (u_lighting.u_specularOcclusion != 0) {
        specularAO = computeSpecularAO(max(dot(N, V), 0.0), diffuseAO, roughness);
    }
    // Horizon occlusion rides on the same factor, because it is the same kind of statement: how much
    // of the specular lobe survives. One multiply here covers BOTH indirect specular sources — the
    // probe blend and the env fallback — which is why it is applied to the factor and not to either
    // term. The geometric normal is rebuilt from depth; see `geometricNormal`.
    if (u_lighting.u_horizonOcclusion != 0) {
        let Ng = geometricNormal(uv, depth, worldPos);
        specularAO *= horizonOcclusion(reflect(-V, N), Ng);
    }
    var color = indirect.diffuse * diffuseAO + indirect.specular * specularAO + Lo + emissive;

    // Cascade debug channel: replace the shading with a flat per-cascade tint, modulated by the shadow
    // term so the shadow shapes stay readable inside each coloured band.
    if (u_shadow.u_debugCascades != 0) {
        color = cascadeDebugTint(viewDepth)
              * mix(0.25, 1.0, 1.0 - directionalShadow(worldPos, N, viewDepth));
    }

    // Alpha = bloom-eligibility mask: 1 for lit PBR-model surfaces (PBR / terrain / foliage), 0 for
    // unlit "basic" pixels (which write zero albedo). Sampled by the bloom bright-pass so only lit
    // material surfaces bloom.
    var bloomMask = 0.0;
    if (dot(albedo, albedo) > 0.0) { bloomMask = 1.0; }
    return vec4<f32>(color, bloomMask);
}
