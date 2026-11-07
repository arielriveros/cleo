// Specular IBL into the reflection atlas: one light probe's environment, GGX-prefiltered for one roughness,
// written into one layer and one mip of the octahedral atlas (render/reflectionAtlas.ts). The same filter
// as prefilter.wgsl, which writes a cube; only the texel -> direction mapping differs.
//
// The texel's direction comes from its uv through the atlas's octahedral layout, BORDER INCLUDED: a border
// texel holds the direction just across the fold, so the trilinear fetch in deferredLighting.wgsl blends
// across the folds and between mips without a seam.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/importanceSample.wgsl"
#include "./chunks/octNormal.wgsl"

/** The loop bound. A probe bake asks for up to this many samples per texel (`u_sampleCount`). */
const MAX_SAMPLE_COUNT: u32 = 1024u;
/** Must match REFLECTION_BORDER in render/reflectionAtlas.ts. */
const ATLAS_BORDER: f32 = 0.0625;

@group(0) @binding(0) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(1) var u_envMap_sampler: sampler;

struct PrefilterOctUniforms {
    u_roughness: f32,
    /** Source cube face resolution, for the firefly-reducing mip selection below. */
    u_resolution: f32,
    /** Samples per texel, up to MAX_SAMPLE_COUNT. */
    u_sampleCount: f32,
    _pad0: f32,
};
@group(1) @binding(0) var<uniform> u_prefilterOct: PrefilterOctUniforms;

/** Fold a point of the square's neighbourhood back inside it: the edges are mirrors (reflectionAtlas.ts). */
fn octWrapOutside(p: vec2<f32>) -> vec2<f32> {
    var q = p;
    if (q.x > 1.0) { q = vec2<f32>(2.0 - q.x, -q.y); } else if (q.x < -1.0) { q = vec2<f32>(-2.0 - q.x, -q.y); }
    if (q.y > 1.0) { q = vec2<f32>(-q.x, 2.0 - q.y); } else if (q.y < -1.0) { q = vec2<f32>(-q.x, -2.0 - q.y); }
    return q;
}

/** The direction an atlas texel at `uv` holds: reflectionAtlas.ts `octAtlasDir`. */
fn atlasDirection(uv: vec2<f32>) -> vec3<f32> {
    let s = 1.0 - 2.0 * ATLAS_BORDER;
    let p = ((uv - vec2<f32>(ATLAS_BORDER)) / s) * 2.0 - 1.0;
    return octDecode(octWrapOutside(p));
}

fn distributionGGX(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let nDotH = max(dot(n, h), 0.0);
    let nDotH2 = nDotH * nDotH;
    var denom = (nDotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return a2 / denom;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = atlasDirection(in.uv);
    // The split-sum approximation: the view direction equals the reflection direction.
    let r = n;
    let v = r;

    // A mirror is the source itself: one fetch, at the source's own resolution.
    if (u_prefilterOct.u_roughness <= 0.0) {
        return vec4<f32>(textureSampleLevel(u_envMap_texture, u_envMap_sampler, n, 0.0).rgb, 1.0);
    }

    var prefiltered = vec3<f32>(0.0);
    var totalWeight = 0.0;
    let sampleCount = u32(clamp(u_prefilterOct.u_sampleCount, 1.0, f32(MAX_SAMPLE_COUNT)));
    let saTexel = 4.0 * PI / (6.0 * u_prefilterOct.u_resolution * u_prefilterOct.u_resolution);
    for (var i = 0u; i < MAX_SAMPLE_COUNT; i++) {
        if (i >= sampleCount) { break; }
        let xi = hammersley(i, sampleCount);
        let h = importanceSampleGGX(xi, n, u_prefilterOct.u_roughness);
        let l = normalize(2.0 * dot(v, h) * h - v);
        let nDotL = max(dot(n, l), 0.0);
        if (nDotL > 0.0) {
            // A source MIP proportional to this sample's solid angle, as prefilter.wgsl takes it: no ring of
            // fireflies round a bright source texel at high roughness.
            let d = distributionGGX(n, h, u_prefilterOct.u_roughness);
            let nDotH = max(dot(n, h), 0.0);
            let hDotV = max(dot(h, v), 0.0);
            let pdf = d * nDotH / (4.0 * hDotV) + 0.0001;
            let saSample = 1.0 / (f32(sampleCount) * pdf + 0.0001);
            let mipLevel = max(0.5 * log2(saSample / saTexel), 0.0);
            prefiltered += textureSampleLevel(u_envMap_texture, u_envMap_sampler, l, mipLevel).rgb * nDotL;
            totalWeight += nDotL;
        }
    }
    return vec4<f32>(prefiltered / max(totalWeight, 0.0001), 1.0);
}
