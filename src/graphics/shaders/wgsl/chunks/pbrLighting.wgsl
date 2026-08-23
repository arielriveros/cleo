// Light types and the Cook-Torrance BRDF, shared by every PBR lighting path.
//
// The deferred lighting pass and the forward PBR material compute identical shading from identical
// light structures — they differ only in where the surface comes from (a G-buffer fetch versus
// interpolated varyings). Keeping one copy is what stops the two from drifting into subtly different
// specular, which is the kind of difference nobody notices until a scene is half forward and half
// deferred.
//
// The uniform BLOCK is deliberately NOT here: the deferred pass carries probe volumes and SSAO fields
// the forward path has no use for, so each program declares its own block using these structs.

const PI: f32 = 3.14159265359;

struct DirectionalLight {
    direction: vec3<f32>,
    ambient: vec3<f32>,
    diffuse: vec3<f32>,
    specular: vec3<f32>,
};

struct PointLight {
    position: vec3<f32>,
    ambient: vec3<f32>,
    diffuse: vec3<f32>,
    specular: vec3<f32>,
    constant: f32,
    linear: f32,
    quadratic: f32,
};

struct SpotLight {
    position: vec3<f32>,
    direction: vec3<f32>,
    ambient: vec3<f32>,
    diffuse: vec3<f32>,
    specular: vec3<f32>,
    constant: f32,
    linear: f32,
    quadratic: f32,
    cutOff: f32,        // cosine of the inner half-angle
    outerCutOff: f32,   // cosine of the outer half-angle (smaller than cutOff)
};

fn DistributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return a2 / denom;
}

fn GeometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

fn GeometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let ggx2 = GeometrySchlickGGX(max(dot(N, V), 0.0), roughness);
    let ggx1 = GeometrySchlickGGX(max(dot(N, L), 0.0), roughness);
    return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

/**
 * One light's contribution, added to `Lo`.
 *
 * Takes and returns the accumulator rather than using an `inout` parameter, because WGSL has no `inout`
 * — a pointer parameter would work but reads worse at four call sites than a plain sum.
 */
fn accumulateLight(N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32,
                   lightDir: vec3<f32>, radiance: vec3<f32>) -> vec3<f32> {
    let H = normalize(V + lightDir);
    let NDF = DistributionGGX(N, H, roughness);
    let G = GeometrySmith(N, V, lightDir, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), mix(vec3<f32>(0.04), albedo, metallic));

    let specular = (NDF * G * F) / (4.0 * max(dot(N, V), 0.0) * max(dot(N, lightDir), 0.0) + 0.001);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
    return (kD * albedo / PI + specular) * radiance * max(dot(N, lightDir), 0.0);
}
