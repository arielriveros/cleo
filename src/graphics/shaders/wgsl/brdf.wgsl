// Split-sum BRDF integration LUT (Karis).
//
// x = NdotV, y = roughness -> (scale, bias) for the environment specular term. Rendered ONCE at
// startup on a fullscreen quad into an RG/RGBA16F 2D texture, then sampled by every PBR pass — which
// is why 1024 samples per pixel is affordable here and nowhere else.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/importanceSample.wgsl"

const SAMPLE_COUNT: u32 = 1024u;

/** Schlick-GGX geometry term with the IBL `k`, which is a^2/2 rather than the direct-lighting form. */
fn geometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
    let a = roughness;
    let k = (a * a) / 2.0;
    return nDotV / (nDotV * (1.0 - k) + k);
}

fn geometrySmith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
    let ggx2 = geometrySchlickGGX(max(dot(n, v), 0.0), roughness);
    let ggx1 = geometrySchlickGGX(max(dot(n, l), 0.0), roughness);
    return ggx1 * ggx2;
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
            let g = geometrySmith(n, v, l, roughness);
            let gVis = (g * vDotH) / (nDotH * nDotV);
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
