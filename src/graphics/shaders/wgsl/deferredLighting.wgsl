// Deferred lighting pass: a single fullscreen quad that reads the G-buffer, reconstructs world
// position from depth, and computes PBR (Cook-Torrance) lighting for every opaque pixel. All lights
// are uploaded once per frame here instead of per-object per-shader.

#include "./chunks/fullscreen.wgsl"
// Cascaded shadow maps. Every uniform and every sampling function lives in the shared chunk, so this
// pass, the forward materials, custom materials and the god rays cannot drift apart.
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"

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
@group(0) @binding(2) var u_gNormalRoughness_texture: texture_2d<f32>;   // rgb = world normal, a = roughness
@group(0) @binding(3) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(4) var u_gEmissiveAO_texture: texture_2d<f32>;        // rgb = emissive, a = ao
@group(0) @binding(5) var u_gEmissiveAO_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_2d<f32>;             // non-linear depth
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
    u_pointLights: array<PointLight, 16>,
    u_spotlights: array<SpotLight, 8>,

    u_viewPos: vec3<f32>,
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
};
@group(1) @binding(0) var<uniform> u_lighting: Lighting;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_lighting.u_invViewProj * clip;
    return world.xyz / world.w;
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
 * Split-sum IBL from one probe slot's cubemaps.
 *
 * The slot's textures are passed by value rather than indexed, because a sampler array cannot be
 * indexed dynamically in the GLSL this compiles down to.
 */
fn probeIBL(irr: texture_cube<f32>, irrSampler: sampler,
            pref: texture_cube<f32>, prefSampler: sampler,
            N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>,
            metallic: f32, roughness: f32, F0: vec3<f32>) -> vec3<f32> {
    let F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
    let diffuseIBL = textureSample(irr, irrSampler, N).rgb * albedo;
    let R = reflect(-V, N);
    let prefiltered = textureSampleLevel(pref, prefSampler, R, roughness * MAX_REFLECTION_LOD).rgb;
    let brdf = textureSample(u_brdfLUT_texture, u_brdfLUT_sampler,
                             vec2<f32>(max(dot(N, V), 0.0), roughness)).rg;
    let specularIBL = prefiltered * (F * brdf.x + brdf.y);
    return kD * diffuseIBL + specularIBL;
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
fn sampleAO(uv: vec2<f32>, centerDepth: f32) -> f32 {
    if (u_lighting.u_ssaoEnabled == 0) { return 1.0; }
    if (u_lighting.u_ssaoTexelSize.x <= 0.0) {
        return textureSample(u_ssao_texture, u_ssao_sampler, uv).r;   // full-res: nothing to do
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
        let ao = textureSample(u_ssao_texture, u_ssao_sampler, tapUV).r;
        // Compare in linear-ish terms: raw device depth is wildly non-linear, so a fixed epsilon on it
        // would be far too strict near the camera and far too loose in the distance. Dividing by the
        // centre depth makes the tolerance relative, which behaves at both ends.
        let d = textureSample(u_gDepth_texture, u_gDepth_sampler, tapUV).r;
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
    let depth = textureSample(u_gDepth_texture, u_gDepth_sampler, uv).r;
    // Background (no geometry) — leave for the skybox pass.
    if (depth >= 1.0) { discard; }

    let albedoMetallic = textureSample(u_gAlbedoMetallic_texture, u_gAlbedoMetallic_sampler, uv);
    let normalRoughness = textureSample(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, uv);
    let emissiveAO = textureSample(u_gEmissiveAO_texture, u_gEmissiveAO_sampler, uv);

    let albedo = albedoMetallic.rgb;
    let metallic = albedoMetallic.a;
    let N = normalize(normalRoughness.rgb);
    let roughness = normalRoughness.a;
    let emissive = emissiveAO.rgb;
    let ao = emissiveAO.a;

    let worldPos = reconstructWorldPos(uv, depth);
    let V = normalize(u_lighting.u_viewPos - worldPos);

    // Indirect lighting. When a light probe / environment is available, use full split-sum IBL
    // (diffuse irradiance + prefiltered specular + BRDF LUT); otherwise fall back to flat ambient.
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let ssao = sampleAO(uv, depth);

    // Fallback indirect term used where no probe volume applies: the directional light's ambient as a
    // simple fill floor (matches the forward Blinn-Phong path; zeroed when the light is removed so
    // deleting every light still goes to black), plus a crude env reflection when a map is present.
    var fallbackAmbient = u_lighting.u_dirLight.ambient * albedo;
    if (u_lighting.u_useEnvMap != 0) {
        let kS = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
        let R = reflect(-V, N);
        let env = textureSample(u_envMap_texture, u_envMap_sampler, R).rgb;
        let specAtten = pow(1.0 - roughness, 4.0);
        fallbackAmbient += env * kS * specAtten;
    }

    var ambient = fallbackAmbient;
    if (u_lighting.u_probeCount > 0) {
        // Priority blend: slot 0 (nearest/bounded first — see Scene.probesForFrame) claims its weight,
        // slot 1 fills what remains, and the fallback covers the rest. A single unbounded probe reduces
        // to w0 = 1 -> exactly the legacy full-IBL result.
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
        ambient = fallbackAmbient * rest;
        if (c0 > 0.0) {
            ambient += probeIBL(u_irradiance0_texture, u_irradiance0_sampler,
                                u_prefiltered0_texture, u_prefiltered0_sampler,
                                N, V, albedo, metallic, roughness, F0) * u_lighting.u_iblIntensity0 * c0;
        }
        if (c1 > 0.0) {
            ambient += probeIBL(u_irradiance1_texture, u_irradiance1_sampler,
                                u_prefiltered1_texture, u_prefiltered1_sampler,
                                N, V, albedo, metallic, roughness, F0) * u_lighting.u_iblIntensity1 * c1;
        }
    }

    // Distance in front of the camera, which is what selects a cascade.
    let viewDepth = -(u_lighting.u_view * vec4<f32>(worldPos, 1.0)).z;

    var Lo = vec3<f32>(0.0);

    // Directional light + shadow (guard against an unset/zero direction -> normalize(0) = NaN)
    let dirD = u_lighting.u_dirLight.direction;
    if (dot(dirD, dirD) > 1e-6) {
        let shadow = directionalShadow(worldPos, N, viewDepth);
        let Ld = normalize(-dirD);
        Lo += accumulateLight(N, V, albedo, metallic, roughness, Ld,
                              u_lighting.u_dirLight.diffuse * (1.0 - shadow));
    }

    for (var i = 0; i < u_lighting.u_numPointLights; i++) {
        let p = u_lighting.u_pointLights[i];
        let L = normalize(p.position - worldPos);
        let dist = length(p.position - worldPos);
        let att = 1.0 / (p.constant + p.linear * dist + p.quadratic * dist * dist);
        Lo += accumulateLight(N, V, albedo, metallic, roughness, L, p.diffuse * att);
    }

    for (var i = 0; i < u_lighting.u_numSpotlights; i++) {
        let sl = u_lighting.u_spotlights[i];
        let L = normalize(sl.position - worldPos);
        let dist = length(sl.position - worldPos);
        let att = 1.0 / (sl.constant + sl.linear * dist + sl.quadratic * dist * dist);
        let theta = dot(L, normalize(-sl.direction));
        // cutOff/outerCutOff are COSINES of the half-angles (see Renderer's spot upload), so the inner
        // one is the LARGER value and the falloff denominator is inner - outer.
        let epsilon = sl.cutOff - sl.outerCutOff;
        let intensity = clamp((theta - sl.outerCutOff) / epsilon, 0.0, 1.0);
        let spotSh = spotShadowFor(i, worldPos, N, sl.position);
        Lo += accumulateLight(N, V, albedo, metallic, roughness, L,
                              sl.diffuse * att * intensity * (1.0 - spotSh));
    }

    // Output LINEAR HDR radiance. Exposure, tonemap and sRGB encode are applied once at the final
    // present. Unlit "basic" materials arrive as zero albedo + authored emissive, so they pass straight
    // through here and are tonemapped uniformly with everything else.
    var color = ambient * ao * ssao + Lo + emissive;

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
