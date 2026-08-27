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

/**
 * Scene-wide sky light: the sky's own radiance, projected onto L2 spherical harmonics.
 *
 * NINE COEFFICIENTS IN A UNIFORM BLOCK, not a cubemap, and that is forced rather than chosen. The
 * deferred lighting pass already binds 13 texture+sampler pairs against a hard 16 (measured on
 * ANGLE/D3D11 as exactly the ES 3.00 minimum — see rhi/webgl2/capabilities.ts), and terrainForward
 * cannot take a cube at all: its layer samplers occupy units 0-8. A cube-based sky light would light
 * every surface in the scene EXCEPT the ground, which is most of a landscape.
 *
 * Irradiance is a low-frequency signal, so L2 is not a compromise here — nine coefficients reproduce
 * a diffuse sky to within a percent or so of a convolved 32x32 cube, for zero samplers and no bake.
 *
 * `sh` holds the projection of RADIANCE (rgb in xyz, w unused); the cosine-lobe convolution that turns
 * it into irradiance is folded into the constants in `skyIrradiance`.
 *
 * The array is vec4 rather than vec3 because WGSL forbids a uniform-address-space array whose element
 * stride is under 16 bytes, exactly as chunks/shadows.wgsl documents for its per-cascade scalars.
 */
struct SkyLight {
    sh: array<vec4<f32>, 9>,
    intensity: f32,
    /** i32, not bool: WGSL forbids bool in a uniform buffer. 0 = no sky light in the scene. */
    enabled: i32,
    _pad0: f32,
    _pad1: f32,
};

/**
 * Diffuse indirect light arriving at a surface facing `n`, in the SAME UNITS the probe irradiance cube
 * carries — multiply by albedo directly, exactly as `probeIBL` does with its cube fetch. Keeping the
 * two in one unit is what lets a sky light and a light probe be mixed in a scene without one of them
 * being silently several times the other.
 *
 * Ramamoorthi & Hanrahan 2001. The c constants ARE the cosine-lobe convolution — they are what makes
 * this an irradiance evaluation rather than a radiance reconstruction.
 *
 * THE 1/PI IS NOT A FUDGE, and it is the whole reason this comment is long. Ramamoorthi's form returns
 * irradiance E; Lambertian outgoing radiance is albedo/PI * E. `irradiance.wgsl` already folds that
 * division in — for a uniform sky of radiance L its loop yields `PI * L * mean(cos*sin) = PI * L * 1/PI
 * = L`, not PI*L — so the cube is E/PI and its consumers multiply by albedo alone. Returning E here
 * instead would make a sky light PI times brighter than the identical scene lit by a probe, which is
 * exactly what the first measurement of this function showed: a fully blown-out white scene.
 */
fn skyIrradiance(sky: SkyLight, n: vec3<f32>) -> vec3<f32> {
    if (sky.enabled == 0) { return vec3<f32>(0.0); }

    let c1 = 0.429043; let c2 = 0.511664; let c3 = 0.743125;
    let c4 = 0.886227; let c5 = 0.247708;
    let x = n.x; let y = n.y; let z = n.z;

    let L00  = sky.sh[0].rgb;
    let L1m1 = sky.sh[1].rgb; let L10 = sky.sh[2].rgb; let L11 = sky.sh[3].rgb;
    let L2m2 = sky.sh[4].rgb; let L2m1 = sky.sh[5].rgb; let L20 = sky.sh[6].rgb;
    let L21  = sky.sh[7].rgb; let L22 = sky.sh[8].rgb;

    var e = c4 * L00
          + 2.0 * c2 * (L11 * x + L1m1 * y + L10 * z)
          + c3 * L20 * (z * z) - c5 * L20
          + c1 * L22 * (x * x - y * y)
          + 2.0 * c1 * (L2m2 * (x * y) + L21 * (x * z) + L2m1 * (y * z));

    // A strongly directional sky drives the reconstruction negative in the unlit hemisphere. Clamping
    // is not cosmetic: a negative irradiance subtracts from the direct term and punches black holes in
    // whatever faces away from the sun.
    return max(e, vec3<f32>(0.0)) * (sky.intensity / PI);
}

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
