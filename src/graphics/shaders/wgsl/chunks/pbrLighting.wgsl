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

/**
 * A light's COLOUR and its INTENSITY are separate, and the intensity is photometric.
 *
 * What these replaced was a `diffuse` / `specular` / `ambient` triple plus a
 * `constant / linear / quadratic` attenuation denominator. `specular` was never read by any PBR path;
 * `ambient` was a flat fill added to every pixel regardless of the light; and the denominator is not
 * inverse-square, never reaches zero, and gives a light no radius to be culled by. See
 * `graphics/lighting.ts` for the units, the reference illuminance, and the legacy migration.
 *
 * The derived members are computed CPU-side, per light, once per frame, because they were otherwise a
 * divide per light PER PIXEL — and the cone's `1 / (cosInner - cosOuter)` was unguarded in four
 * separate copies of the loop, where inner == outer divided by zero in all of them. The precedent is
 * the cone angles themselves, which have always been uploaded as cosines rather than as the authored
 * degrees.
 */
struct DirectionalLight {
    direction: vec3<f32>,
    /** Illuminance perpendicular to the light, on the engine's internal radiance scale. */
    intensity: f32,
    color: vec3<f32>,
    /** Apparent radius of the source in radians; the sun is 0.00465. Widens its specular highlight. */
    angularRadius: f32,
};

struct PointLight {
    position: vec3<f32>,
    /** DERIVED: 1 / range^2. Where the windowed falloff reaches exactly zero. */
    invRangeSquared: f32,
    color: vec3<f32>,
    /** Luminous intensity (candela), on the engine's internal radiance scale. */
    intensity: f32,
    /** Radius of the emitting sphere, in metres. Widens and softens its specular highlight. */
    sourceRadius: f32,
};

struct SpotLight {
    position: vec3<f32>,
    invRangeSquared: f32,
    direction: vec3<f32>,
    sourceRadius: f32,
    color: vec3<f32>,
    intensity: f32,
    /** DERIVED cone falloff: `saturate(cosAngle * coneScale + coneOffset)`, from the two half-angles. */
    coneScale: f32,
    coneOffset: f32,
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

// -----------------------------------------------------------------------------------------------
// The specular BRDF: Cook-Torrance with a height-correlated visibility term, an energy-conserving
// diffuse, and multi-scatter compensation. See DIRECT_LIGHTING_ROADMAP.md phase 2.
//
// What this replaced, and why each piece went:
//   - SEPARABLE Smith `G`, which assumes shadowing and masking are independent. They are not, and the
//     error grows with roughness. The height-correlated VISIBILITY form below also folds in the
//     `1 / (4 NoV NoL)` denominator, which is what let the `+ 0.001` epsilon go: that epsilon was a
//     divide-by-zero guard sitting in the numerator's way, biasing every grazing highlight dark.
//   - `kD = (1 - F)` on the diffuse lobe. No modern reference BRDF has it — Filament, Frostbite and
//     Disney all use `(1 - metallic) * albedo` alone — and it over-darkened grazing angles.
//   - Lambert, replaced by Burley, which is what makes a rough dielectric read as one: it lifts the
//     diffuse response at grazing angles instead of leaving it flat.
// -----------------------------------------------------------------------------------------------

/**
 * Perceptual-roughness floor.
 *
 * Below this `D_GGX`'s denominator collapses: `alpha = 0` makes `a2 = 0`, and at `NoH = 1` the
 * expression is `0 / (PI * 0 * 0)` — a NaN specular that nothing downstream clamps. Filament uses 0.089
 * where shading itself runs in fp16; every lighting path here computes in fp32 (the G-buffer stores
 * roughness in rgba16float, but that only quantises the INPUT), so 0.045 is the right floor and a
 * sharper highlight is still reachable.
 */
const MIN_PERCEPTUAL_ROUGHNESS: f32 = 0.045;

/** GGX / Trowbridge-Reitz normal distribution. `alpha` is roughness^2 — the caller owns the remap. */
fn D_GGX(NoH: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let f = (NoH * a2 - NoH) * NoH + 1.0;
    return a2 / (PI * f * f);
}

/**
 * Height-correlated Smith visibility (Heitz 2014).
 *
 * VISIBILITY, not the geometry term: `V = G / (4 NoV NoL)`, so the specular lobe is `D * V * F` with no
 * separate denominator and no epsilon. That is reason enough to prefer this form even setting its
 * better correlation aside.
 *
 * The guard is not decoration. At `NoV = NoL = 0` the denominator is zero, and although the caller
 * multiplies the result by `NoL = 0`, `inf * 0` is NaN rather than 0.
 */
fn V_SmithGGXCorrelated(NoV: f32, NoL: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let GGXV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
    let GGXL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
    return 0.5 / max(GGXV + GGXL, 1e-5);
}

/**
 * Burley (Disney) diffuse, normalised. Returns the scalar lobe; the caller multiplies by the diffuse
 * colour. Costs a handful of ALU over Lambert and is what gives a rough dielectric its grazing-angle
 * lift — the most visible difference on cloth, plaster, bark and soil.
 */
fn Fd_Burley(NoV: f32, NoL: f32, LoH: f32, roughness: f32) -> f32 {
    let f90 = 0.5 + 2.0 * roughness * LoH * LoH;
    let lightScatter = 1.0 + (f90 - 1.0) * pow(1.0 - NoL, 5.0);
    let viewScatter = 1.0 + (f90 - 1.0) * pow(1.0 - NoV, 5.0);
    return lightScatter * viewScatter * (1.0 / PI);
}

/**
 * The split-sum DFG pair (A, B) such that the single-scatter specular is `f0 * A + B`. Karis' analytic
 * fit from "Physically Based Shading on Mobile" (UE4).
 *
 * ANALYTIC RATHER THAN THE LUT, and that is forced rather than chosen. `brdf.wgsl` bakes a real 512x512
 * DFG table, but it is bound only in the deferred pass: `terrainForward.wgsl` documents that its layer
 * samplers occupy units 0-8 and it can never bind another, and a custom forward material gets exactly
 * one engine sampler. A term that exists on one path and not another is worse than a fit that is a
 * percent off everywhere, because the two paths are supposed to shade identically.
 */
fn EnvBRDFApprox(NoV: f32, roughness: f32) -> vec2<f32> {
    let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
    let r = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
    return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}

/**
 * Multi-scatter energy compensation (Kulla & Conty; Fdez-Aguera's single-scattering form).
 *
 * A GGX lobe only accounts for light that leaves the microsurface after ONE bounce. Everything that
 * bounces twice or more is simply lost, and the loss grows fast with roughness: a fully rough metal
 * keeps 45% of its energy and throws the rest away. That is most of why rough metals looked dull and
 * dead here, and no amount of exposure fixes it, because the loss is roughness-dependent.
 *
 * THE DENOMINATOR IS `A + B`, NOT `B`, and this is the one place in this file where copying a reference
 * implementation verbatim would have been a disaster. Filament writes `1.0 + f0 * (1.0 / dfg.y - 1.0)`,
 * but their `dfg.y` is a dedicated channel holding the white-furnace directional albedo
 * `integral(D * V * NoL)`. Ours is the Schlick SPLIT-SUM pair, where the same quantity is `A + B`
 * (substitute f0 = 1 into `f0 * A + B`). Measured across the whole domain: `A + B` is exactly 1.0 at
 * roughness 0, so smooth surfaces are untouched; it bottoms out at 0.45, giving a maximum compensation
 * of 2.22x for a pure metal. `B` alone falls to ~1e-8 at low roughness, which would multiply a mirror's
 * highlight by forty million. `tests/brdf.test.ts` pins all of that.
 */
fn energyCompensation(f0: vec3<f32>, NoV: f32, roughness: f32) -> vec3<f32> {
    let dfg = EnvBRDFApprox(NoV, roughness);
    // Never non-positive in practice (the domain minimum is 0.45); the max is insurance, not
    // arithmetic, and costs nothing.
    let singleScatter = max(dfg.x + dfg.y, 1e-4);
    return vec3<f32>(1.0) + f0 * (1.0 / singleScatter - 1.0);
}

/**
 * Specular ambient occlusion (Lagarde, "Moving Frostbite to Physically Based Rendering").
 *
 * An AO map and SSAO both answer one question: how much of the HEMISPHERE is blocked. That is the right
 * question for a diffuse lobe, which samples the whole hemisphere, and the wrong one for a specular
 * lobe, which samples a narrow cone around the reflection. Multiplying both by the same number — which
 * is what every path here used to do — darkens reflections that are not occluded at all: a polished
 * floor in a corner loses its reflection of the room even though the reflected direction points into
 * open space.
 *
 * The fix keys on the two things that decide how much of the occluded hemisphere the specular cone can
 * actually see: how narrow the cone is (roughness) and how obliquely it leaves the surface (NoV). At
 * roughness 1 the lobe IS the hemisphere and this returns the diffuse AO unchanged; as roughness falls
 * it relaxes toward 1, and a mirror is left alone entirely.
 *
 * INDIRECT ONLY. Direct light is not occluded by this — it has a shadow map, and applying AO to it
 * would double-count what the shadow already says.
 */
fn computeSpecularAO(NoV: f32, ao: f32, roughness: f32) -> f32 {
    return saturate(pow(NoV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
}

/**
 * Horizon occlusion (Lagarde, same paper), the OTHER thing an occlusion term has to answer.
 *
 * `computeSpecularAO` above asks how much of the hemisphere is blocked by nearby geometry. This asks a
 * question that has nothing to do with nearby geometry at all: whether the reflection ray points into
 * the surface the fragment is standing on.
 *
 * It can, and routinely does. A normal map tilts the shading normal away from the real surface, and
 * `reflect(-V, N)` is computed against that tilted normal — so at a glancing view angle the reflected
 * ray dips BELOW the geometric surface and the shader happily samples the environment along it. The
 * result is a bright rim of sky reflected by a surface that is facing away from the sky, and it is one
 * of the more recognisable ways normal-mapped PBR looks wrong: a wet-looking edge on every strong
 * normal-map feature seen at an angle.
 *
 * `dot(R, Ng)` is negative exactly when the ray has gone under. The `1.0 +` puts the fade's KNEE at the
 * horizon, so a ray running exactly along the surface is not occluded at all and only rays past it
 * lose anything.
 *
 * The square is where the smoothness is, and it is at the far end rather than the near one — worth
 * being exact about, because the intuition points the other way. `h * h` has zero slope at h = 0, so
 * the fade joins the fully-occluded region without a crease; at h = 1 it is twice as steep as a linear
 * ramp would be. Measured at HORIZON_FADE 1.3: the step across the last 0.05 of dot before full
 * occlusion is 0.007, the same step in the middle of the range is 0.067, and the first step below the
 * horizon is 0.126. Deeper and softer-bottomed than linear, not gentler at the start.
 *
 * SPECULAR ONLY, and INDIRECT only: it is a statement about a reflection ray, and neither the diffuse
 * lobe nor a direct light has one.
 */
const HORIZON_FADE: f32 = 1.3;

fn horizonOcclusion(R: vec3<f32>, Ng: vec3<f32>) -> f32 {
    let horizon = saturate(1.0 + HORIZON_FADE * dot(R, Ng));
    return horizon * horizon;
}

/**
 * @deprecated Superseded by `D_GGX(NoH, alpha)`. Kept because user-authored custom-material GLSL can
 * call it and the generated chunk still exports it; nothing in the engine's own programs reaches it, so
 * naga eliminates it from every real shader. Note the different convention: this one takes PERCEPTUAL
 * roughness and squares it itself.
 */
fn DistributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return a2 / denom;
}

/** @deprecated The separable Smith's per-direction half. See `DistributionGGX` for why it stays. */
fn GeometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

/**
 * @deprecated Superseded by `V_SmithGGXCorrelated`, which is height-correlated AND folds in the
 * `1 / (4 NoV NoL)` denominator. This returns the GEOMETRY term, so a caller still has to divide.
 */
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
 * The general form: diffuse and specular may come from DIFFERENT directions.
 *
 * That is what an area light needs. Diffuse integrates over the whole source, so it stays on the
 * direction to the source's CENTRE; specular is a near-mirror and takes the representative point — the
 * spot on the source that actually reflects toward the eye. `specularScale` is the energy correction
 * for spreading one light's power over a wider solid angle.
 *
 * With `specularDir == diffuseDir` and `specularScale == 1.0` this is exactly the punctual BRDF, which
 * is both what `accumulateLight` wants and the cheapest possible proof the split is sound.
 */
fn shadeSurface(N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32,
                diffuseDir: vec3<f32>, specularDir: vec3<f32>, specularScale: f32,
                radiance: vec3<f32>) -> vec3<f32> {
    // Not `saturate`: NoV must be strictly positive or the visibility term divides by zero on a
    // silhouette, where an interpolated normal routinely faces slightly away from the camera.
    let NoV = max(dot(N, V), 1e-4);

    let perceptual = max(roughness, MIN_PERCEPTUAL_ROUGHNESS);
    let alpha = perceptual * perceptual;
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);

    // Specular, on the representative direction and its own cosine.
    let Hs = normalize(V + specularDir);
    let NoLs = saturate(dot(N, specularDir));
    let NoH = saturate(dot(N, Hs));
    let LoHs = saturate(dot(specularDir, Hs));
    let F = fresnelSchlick(LoHs, f0);
    let Fr = D_GGX(NoH, alpha) * V_SmithGGXCorrelated(NoV, NoLs, alpha) * F
           * energyCompensation(f0, NoV, perceptual) * specularScale;

    // Diffuse, on the direction to the source centre.
    //
    // No `(1 - F)` factor: `(1 - metallic)` is the whole energy split, which is what every modern
    // reference BRDF does. The old form double-counted Fresnel and read too dark at grazing angles.
    let Hd = normalize(V + diffuseDir);
    let NoLd = saturate(dot(N, diffuseDir));
    let LoHd = saturate(dot(diffuseDir, Hd));
    let Fd = albedo * (1.0 - metallic) * Fd_Burley(NoV, NoLd, LoHd, perceptual);

    // Each lobe carries its OWN cosine. Sharing one would either kill the specular where the
    // representative point has swung past the terminator, or leak diffuse in from behind the surface.
    return (Fd * NoLd + Fr * NoLs) * radiance;
}

/**
 * One light's contribution: diffuse + specular, for one direction and one radiance.
 *
 * Takes and returns the accumulator rather than using an `inout` parameter, because WGSL has no `inout`
 * — a pointer parameter would work but reads worse at four call sites than a plain sum.
 *
 * THE SIGNATURE IS FROZEN. It is the BRDF entry point the editor advertises to custom-material authors,
 * the one every seed template calls, and `systems/customShaders.ts` hand-writes an `inout` overload of
 * it whose parameter list has to match. Change the body freely; changing the parameters breaks
 * user-authored GLSL in saved projects.
 */
fn accumulateLight(N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32,
                   lightDir: vec3<f32>, radiance: vec3<f32>) -> vec3<f32> {
    // A punctual light is the degenerate area light: one direction for both lobes, no energy
    // correction. Written as a delegation rather than a second copy so the two cannot drift.
    return shadeSurface(N, V, albedo, metallic, roughness, lightDir, lightDir, 1.0, radiance);
}

// -----------------------------------------------------------------------------------------------
// Area lights: the representative point (Karis, "Real Shading in Unreal Engine 4").
//
// A light with no size reflects off a polished surface as an infinitely small, infinitely bright dot.
// Real highlights are PICTURES OF THE SOURCE, and that is most of what separates a rendered chrome
// sphere from a photographed one.
//
// The trick is not to integrate over the source. It is to shade with a single direction chosen so the
// result looks like the integral: the point ON the source that reflects toward the eye. The specular
// lobe then sweeps out the source's shape across the surface for free, at the cost of one extra
// direction and one scalar.
//
// The energy correction is the other half. Concentrating a whole source's power at one point would
// over-brighten it, so the lobe is scaled by `(alpha / alphaPrime)^2` where `alphaPrime` widens by the
// source's half-angle. That factor is <= 1: it is what makes a bigger light a SOFTER one rather than a
// brighter one. Measured at the shipped defaults, a 5 cm bulb at 2 m on a polished surface widens the
// lobe 7x and drops the peak to 0.019 of its old value; on a rough surface it does nothing. That
// asymmetry is correct, and it is why this phase changes smooth materials and almost nothing else.
//
// THE NDF STAYS AT THE ORIGINAL ALPHA. The direction does the spatial widening; the normalization does
// the energy. Widening the distribution as well would blur the highlight twice over.
// -----------------------------------------------------------------------------------------------

struct AreaLightSample {
    /** The representative direction. SPECULAR ONLY — diffuse keeps the direction to the centre. */
    direction: vec3<f32>,
    /** `(alpha / alphaPrime)^2`: one source's power spread across a wider solid angle. */
    normalization: f32,
};

/** `(alpha / saturate(alpha + halfAngle))^2`, shared by both source shapes. */
fn areaNormalization(alpha: f32, halfAngle: f32) -> f32 {
    let alphaPrime = saturate(alpha + halfAngle);
    let ratio = alpha / max(alphaPrime, 1e-6);
    return ratio * ratio;
}

/**
 * A spherical source: the closest point on the sphere to the reflection ray.
 *
 * `toLight` is the unnormalised vector to the CENTRE, `dist` its length. When the reflection ray
 * already passes through the sphere the closest point is on the ray itself, which is what makes the
 * highlight an image of the bulb rather than a smeared dot.
 */
fn sphereLightSample(toLight: vec3<f32>, dist: f32, sourceRadius: f32,
                     reflected: vec3<f32>, alpha: f32) -> AreaLightSample {
    var result: AreaLightSample;
    // A zero-radius source is a punctual light, and it has to stay EXACTLY punctual: this is the path
    // every light took before this phase, and `normalize(centerToRay)` is undefined when the ray runs
    // straight through the centre.
    if (sourceRadius <= 0.0) {
        result.direction = toLight / max(dist, 1e-6);
        result.normalization = 1.0;
        return result;
    }

    let centerToRay = dot(toLight, reflected) * reflected - toLight;
    let closest = toLight + centerToRay * saturate(sourceRadius / max(length(centerToRay), 1e-6));
    result.direction = normalize(closest);
    // The half-angle the source subtends. `dist` to the centre, not to the representative point: the
    // solid angle belongs to the source, not to whichever bit of it happens to face us.
    result.normalization = areaNormalization(alpha, sourceRadius / max(2.0 * dist, 1e-6));
    return result;
}

/**
 * A disc source at infinity — the sun. The reflection ray clamped into the source's cone.
 *
 * Geometrically the same statement as the sphere case: the point on the source closest to the ray. For
 * a cone that is either the ray itself (it already hits the disc, so a mirror shows the sun's disc
 * exactly) or the nearest point on the cone's rim.
 */
fn discLightSample(lightDir: vec3<f32>, angularRadius: f32,
                   reflected: vec3<f32>, alpha: f32) -> AreaLightSample {
    var result: AreaLightSample;
    result.direction = lightDir;
    result.normalization = 1.0;
    // Zero is what the renderer writes when there is no directional light at all, so it must be inert.
    if (angularRadius <= 0.0) { return result; }

    let cosAngle = cos(angularRadius);
    let LoR = dot(lightDir, reflected);
    if (LoR >= cosAngle) {
        result.direction = reflected;
    } else {
        // The component of the reflection ray perpendicular to the light, renormalised onto the rim.
        let perpendicular = reflected - LoR * lightDir;
        let len = length(perpendicular);
        if (len > 1e-6) {
            result.direction = lightDir * cosAngle + (perpendicular / len) * sin(angularRadius);
        }
    }
    result.normalization = areaNormalization(alpha, angularRadius * 0.5);
    return result;
}

/**
 * Windowed inverse-square distance falloff (Filament's `getSquareFalloffAttenuation`).
 *
 * Physically it is `1 / d^2`; the window is what makes that usable. `w` reaches zero exactly at
 * `range` with a zero derivative, so a light ENDS instead of asymptoting, which is what lets it be
 * culled and what stops a distant lamp adding a permanent haze to a whole level. The `max(d2, 1e-4)`
 * is the only guard the near field needs — a real light has a radius, and once sphere lights land it
 * is that radius rather than an epsilon that keeps the centre finite.
 *
 * The JS twin in `graphics/lighting.ts` (`distanceAttenuation`) exists so the legacy migration can fit
 * against THIS curve rather than an idealised one. Change one, change both.
 */
fn distanceAttenuation(d2: f32, invRangeSquared: f32) -> f32 {
    let f = d2 * invRangeSquared;
    let w = saturate(1.0 - f * f);
    return (w * w) / max(d2, 1e-4);
}

/**
 * Spot cone falloff from the pre-solved scale/offset. SQUARED, which is the whole difference from
 * what came before: the old form was linear in cosine and left a visible crease at the cone's edge,
 * because a linear ramp has a discontinuous derivative at both ends.
 */
fn spotAttenuation(cosAngle: f32, coneScale: f32, coneOffset: f32) -> f32 {
    let a = saturate(cosAngle * coneScale + coneOffset);
    return a * a;
}

/**
 * One light's contribution, from the light struct itself.
 *
 * These exist so the per-light loop is written ONCE. It used to be copy-pasted into four programs
 * (deferred, forward PBR, forward Blinn-Phong, terrain forward) plus two GLSL seed templates, which
 * meant six places to keep a falloff change consistent and no gate that noticed when one drifted.
 *
 * The occlusion argument is VISIBILITY (1 = fully lit), not a shadow fraction, so a caller with two
 * occlusion terms — a cascade map AND a height-field self-shadow, which forward PBR has — multiplies
 * them together rather than having to pick one.
 */
fn evaluateDirectionalLight(light: DirectionalLight, N: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>,
                            metallic: f32, roughness: f32, visibility: f32) -> vec3<f32> {
    // A light with no direction is an unset slot, not a light pointing nowhere: normalize(0) is NaN.
    if (dot(light.direction, light.direction) <= 1e-6) { return vec3<f32>(0.0); }
    let L = normalize(-light.direction);
    let radiance = light.color * (light.intensity * visibility);

    let perceptual = max(roughness, MIN_PERCEPTUAL_ROUGHNESS);
    let sun = discLightSample(L, light.angularRadius, reflect(-V, N), perceptual * perceptual);
    return shadeSurface(N, V, albedo, metallic, roughness, L, sun.direction, sun.normalization, radiance);
}

fn evaluatePointLight(light: PointLight, fragPos: vec3<f32>, N: vec3<f32>, V: vec3<f32>,
                      albedo: vec3<f32>, metallic: f32, roughness: f32) -> vec3<f32> {
    let toLight = light.position - fragPos;
    // A sphere light does not go to infinity at its own centre: inside the bulb the whole surface is
    // at one radius, not at zero. Clamped HERE and not inside `distanceAttenuation`, which has a JS
    // twin in `graphics/lighting.ts` that the legacy migration fits against.
    let d2 = max(dot(toLight, toLight), light.sourceRadius * light.sourceRadius);
    let attenuation = distanceAttenuation(d2, light.invRangeSquared);
    if (attenuation <= 0.0) { return vec3<f32>(0.0); }
    let dist = sqrt(d2);
    let L = toLight / max(dist, 1e-6);
    let radiance = light.color * (light.intensity * attenuation);

    let perceptual = max(roughness, MIN_PERCEPTUAL_ROUGHNESS);
    let sphere = sphereLightSample(toLight, dist, light.sourceRadius, reflect(-V, N),
                                   perceptual * perceptual);
    return shadeSurface(N, V, albedo, metallic, roughness, L, sphere.direction, sphere.normalization,
                        radiance);
}

fn evaluateSpotLight(light: SpotLight, fragPos: vec3<f32>, N: vec3<f32>, V: vec3<f32>,
                     albedo: vec3<f32>, metallic: f32, roughness: f32, visibility: f32) -> vec3<f32> {
    let toLight = light.position - fragPos;
    let d2 = max(dot(toLight, toLight), light.sourceRadius * light.sourceRadius);
    let attenuation = distanceAttenuation(d2, light.invRangeSquared);
    if (attenuation <= 0.0) { return vec3<f32>(0.0); }
    let dist = sqrt(d2);
    let L = toLight / max(dist, 1e-6);
    // The cone is tested against the direction to the CENTRE. A spot's cone is a property of the
    // fixture, not of which part of the bulb happens to reflect toward this pixel.
    let cone = spotAttenuation(dot(L, normalize(-light.direction)), light.coneScale, light.coneOffset);
    let radiance = light.color * (light.intensity * attenuation * cone * visibility);

    let perceptual = max(roughness, MIN_PERCEPTUAL_ROUGHNESS);
    let sphere = sphereLightSample(toLight, dist, light.sourceRadius, reflect(-V, N),
                                   perceptual * perceptual);
    return shadeSurface(N, V, albedo, metallic, roughness, L, sphere.direction, sphere.normalization,
                        radiance);
}
