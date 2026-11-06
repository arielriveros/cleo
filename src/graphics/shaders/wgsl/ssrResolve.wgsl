// Screen-space reflections, stage 2 of 3: every pixel borrows its neighbours' rays.
//
// One ray per pixel estimates the reflected light badly. But the pixels around this one traced rays
// too, through nearly the same lobe from nearly the same place, and their hits are just as good a sample
// of what THIS pixel reflects — provided each is weighted by how likely this pixel's own BRDF was to send
// a ray that way, over how likely the neighbour's was. That is the ratio estimator of Stachowiak's
// "Stochastic Screen-Space Reflections" (SIGGRAPH 2015): sum(L * f/pdf) / sum(f/pdf), with f this pixel's
// specular lobe and pdf the neighbour's sampling density.
//
// Normalised that way, the result is the reflected light ALREADY divided by the lobe's integral — the
// same quantity a prefiltered environment cube holds — so the lighting pass multiplies it by the very
// split-sum term the probes use, and the two blend without an energy seam.
//
// The rays are reused as if fired from this pixel: the neighbour's direction, not the line to its hit.
// Within a few pixels the difference is a fraction of a texel of the reflection, and skipping the re-aim
// saves a depth fetch and a reconstruction per neighbour.
//
// Output: rgb = normalised reflected radiance, a = the share of the lobe that found something on screen.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"

@group(0) @binding(0) var u_ray_texture: texture_2d<f32>;              // ssr.wgsl's ray target
@group(0) @binding(1) var u_ray_sampler: sampler;
@group(0) @binding(2) var u_hit_texture: texture_2d<f32>;              // ssr.wgsl's radiance target
@group(0) @binding(3) var u_hit_sampler: sampler;
@group(0) @binding(4) var u_gNormalRoughness_texture: texture_2d<f32>;
@group(0) @binding(5) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(7) var u_gDepth_sampler: sampler;

const PI: f32 = 3.14159265;
const MIN_ALPHA: f32 = 0.002;
const TAPS: i32 = 5;

struct SsrResolveUniforms {
    u_view: mat4x4<f32>,            // world -> view
    u_invProjection: mat4x4<f32>,   // clip -> view (jittered, uv-consuming)
    /** Roughness where the screen-space share starts to fade out, and where it is gone. */
    u_roughnessFade: vec2<f32>,
    u_texelSize: vec2<f32>,         // one texel of THIS pass's target
    u_frame: f32,
};
@group(1) @binding(0) var<uniform> u_resolve: SsrResolveUniforms;

fn ggxD(NoH: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let f = (NoH * a2 - NoH) * NoH + 1.0;
    return a2 / (PI * f * f);
}

/** Height-correlated Smith visibility, as chunks/pbrLighting.wgsl's `V_SmithGGXCorrelated`. */
fn smithVisibility(NoV: f32, NoL: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let GGXV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
    let GGXL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
    return 0.5 / max(GGXV + GGXL, 1e-5);
}

fn viewPosAt(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let view = u_resolve.u_invProjection * clip;
    return view.xyz / view.w;
}

fn luminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depthDims = vec2<f32>(textureDimensions(u_gDepth_texture, 0));
    let uv = (floor(in.uv * depthDims) + 0.5) / depthDims;
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    if (depth >= 1.0) { return vec4<f32>(0.0); }

    let normalRoughness = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, uv, 0.0);
    let roughness = normalRoughness.a;
    let fade = 1.0 - smoothstep(u_resolve.u_roughnessFade.x, u_resolve.u_roughnessFade.y, roughness);
    if (fade <= 0.0) { return vec4<f32>(0.0); }

    let P = viewPosAt(uv, depth);
    let viewRot = mat3x3<f32>(u_resolve.u_view[0].xyz, u_resolve.u_view[1].xyz, u_resolve.u_view[2].xyz);
    let N = normalize(viewRot * octDecode(normalRoughness.rg));
    let V = -normalize(P);
    let NoV = max(dot(N, V), 1e-4);
    let alpha = max(roughness * roughness, MIN_ALPHA);
    let centreDepth = -P.z;

    // The centre and four neighbours on a diagonal cross, turned a little every frame so the temporal
    // pass sees a different set each time. Wider for a wider lobe: a near-mirror shares little with its
    // neighbours anyway (their rays fall outside its lobe and weigh nothing), a rough one a lot.
    let t = u_resolve.u_texelSize;
    let radius = mix(1.0, 2.5, smoothstep(0.0, u_resolve.u_roughnessFade.y, roughness));
    let angle = u_resolve.u_frame * 2.39996323;   // the golden angle
    let c = cos(angle);
    let s = sin(angle);
    var offsets = array<vec2<f32>, 5>(
        vec2<f32>(0.0, 0.0), vec2<f32>(c, s), vec2<f32>(-s, c), vec2<f32>(-c, -s), vec2<f32>(s, -c),
    );

    var weightAll = 0.0;
    var weightHit = 0.0;
    var light = vec3<f32>(0.0);
    var lightWeight = 0.0;
    for (var i = 0; i < TAPS; i++) {
        let tapUV = in.uv + offsets[i] * radius * t;
        if (any(tapUV < vec2<f32>(0.0)) || any(tapUV > vec2<f32>(1.0))) { continue; }
        // Texel centres: these targets filter linearly, and a blend of two octahedral directions is not
        // a direction.
        let rayUV = (floor(tapUV / t) + 0.5) * t;
        let ray = textureSampleLevel(u_ray_texture, u_ray_sampler, rayUV, 0.0);
        if (ray.w < 0.0) { continue; }          // that pixel fired nothing

        // Only a neighbour on this surface: one across a silhouette reflects something else entirely.
        // The trace stored each pixel's view depth beside its ray, so this costs no depth fetch.
        let sameSurface = 1.0 - smoothstep(0.01, 0.05, abs(ray.w - centreDepth) / max(centreDepth, 1e-4));
        if (sameSurface <= 0.0) { continue; }

        let L = octDecode(ray.xy);
        let NoL = dot(N, L);
        if (NoL <= 0.0) { continue; }
        let H = normalize(V + L);
        let NoH = max(dot(N, H), 0.0);
        // This pixel's lobe over the neighbour's pdf. log2 storage keeps a mirror's pdf in half-float range.
        let w = ggxD(NoH, alpha) * smithVisibility(NoV, NoL, alpha) * NoL * exp2(-ray.z) * sameSurface;
        if (!(w > 0.0) || w > 1e30) { continue; }

        let hit = textureSampleLevel(u_hit_texture, u_hit_sampler, rayUV, 0.0);
        weightAll += w;
        if (hit.a > 0.0) {
            weightHit += w * hit.a;
            // Weighted toward the dim (Karis): one ray that found the sun would otherwise light up the
            // whole neighbourhood for a frame.
            let k = w * hit.a / (1.0 + luminance(hit.rgb));
            light += hit.rgb * k;
            lightWeight += k;
        }
    }

    if (weightAll <= 0.0 || lightWeight <= 0.0) { return vec4<f32>(0.0); }
    return vec4<f32>(light / lightWeight, clamp(weightHit / weightAll, 0.0, 1.0) * fade);
}
