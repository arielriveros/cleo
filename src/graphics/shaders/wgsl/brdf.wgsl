// Split-sum BRDF integration LUT (Karis).
//
// x = NdotV, y = roughness -> (scale, bias) for the environment specular term. Rendered ONCE at
// startup on a fullscreen quad into an RG/RGBA16F 2D texture, then sampled by every PBR pass — which
// is why 1024 samples per pixel is affordable here and nowhere else.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/importanceSample.wgsl"

const SAMPLE_COUNT: u32 = 1024u;

/**
 * Height-correlated Smith VISIBILITY — `G / (4 NoV NoL)` — matching `chunks/pbrLighting.wgsl`.
 *
 * A DELIBERATE COPY rather than an include, for two reasons: `pbrLighting.wgsl` declares `PI`, which
 * `chunks/importanceSample.wgsl` above already declares and the include resolver has no include-once
 * guard; and it brings the three light structs, which a bake with no lights has no use for.
 *
 * What it replaced was a local separable Smith with the IBL remap `k = a^2/2`. That was the right
 * companion to the separable `k = (r+1)^2/8` the direct path used to use — but the direct path is
 * height-correlated now, and a LUT integrated against a different visibility function than the shading
 * it feeds means a metal's REFLECTION and its HIGHLIGHT disagree about how much light survives.
 * Nothing links these two files at compile time, so the only thing keeping them honest is this comment.
 */
fn V_SmithGGXCorrelated(nDotV: f32, nDotL: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let ggxV = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
    let ggxL = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
    return 0.5 / max(ggxV + ggxL, 1e-5);
}

fn integrateBRDF(nDotV: f32, roughness: f32) -> vec2<f32> {
    // The integral is rotationally symmetric about the normal, so it can be evaluated with N fixed at
    // +Z and V placed in the XZ plane at the requested angle. That is what makes it a 2D lookup.
    let v = vec3<f32>(sqrt(1.0 - nDotV * nDotV), 0.0, nDotV);
    let n = vec3<f32>(0.0, 0.0, 1.0);

    var a = 0.0;
    var b = 0.0;

    for (var i = 0u; i < SAMPLE_COUNT; i++) {
        let xi = hammersley(i, SAMPLE_COUNT);
        let h = importanceSampleGGX(xi, n, roughness);
        let l = normalize(2.0 * dot(v, h) * h - v);

        let nDotL = max(l.z, 0.0);
        let nDotH = max(h.z, 0.0);
        let vDotH = max(dot(v, h), 0.0);

        if (nDotL > 0.0) {
            // The Monte Carlo weight for a GGX-importance-sampled half vector. With a VISIBILITY term
            // (which already carries the 1 / (4 NoV NoL)) the estimator is `4 * V * NoL * VoH / NoH`;
            // with a geometry term it was the algebraically identical `G * VoH / (NoH * NoV)`. The
            // alpha is `roughness^2` because that is the remap `importanceSampleGGX` applies to the
            // same argument — the two have to agree or the estimator and its distribution disagree.
            let vis = V_SmithGGXCorrelated(nDotV, nDotL, roughness * roughness);
            let gVis = 4.0 * vis * nDotL * vDotH / max(nDotH, 1e-5);
            let fc = pow(1.0 - vDotH, 5.0);
            a += (1.0 - fc) * gVis;
            b += fc * gVis;
        }
    }
    return vec2<f32>(a, b) / f32(SAMPLE_COUNT);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(integrateBRDF(in.uv.x, in.uv.y), 0.0, 1.0);
}
