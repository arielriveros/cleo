// Volumetric clouds: a single fullscreen raymarch.
//
// For every pixel a world-space view ray is reconstructed from `u_invViewProj`, intersected with a
// horizontal cloud slab, and marched through a density field (baked value-noise FBM shaped by a height
// gradient and coverage, eroded by higher-frequency detail). The scene depth buffer bounds the ray so
// solid geometry occludes the clouds.
//
//   - participating media in real units: extinction sigma_t per metre, scattering = albedo * sigma_t;
//   - the energy-conserving analytical integration of in-scattering over each step;
//   - a dual-lobe Henyey-Greenstein phase (forward + back, plus a sharp silver-lining lobe), mixed so it
//     still integrates to one, never `max`ed;
//   - multiple scattering approximated with Wrenninge's octaves: per octave i the scattering, the
//     extinction and the phase eccentricity are scaled by a^i, b^i and c^i (a <= b keeps it energy
//     conserving), all from ONE toward-sun optical depth;
//   - an isotropic sky/ground ambient term, occluded by an analytic estimate of the cloud above/below;
//   - aerial perspective from the transmittance-weighted cloud depth.
//
// GLSL ES needed `precision highp sampler3D` here because it does not predeclare one — the shader
// simply failed to compile without it. WGSL has no precision qualifiers at all, so that whole class of
// problem disappears in the translation.

#include "./chunks/fullscreen.wgsl"

const PI: f32 = 3.14159265359;
const MAX_STEPS: i32 = 192;
const MAX_LIGHT_STEPS: i32 = 12;
const MAX_OCTAVES: i32 = 4;
// Fraction of the remaining slab height whose extinction occludes the ambient sky/ground at a sample.
// The local density stands in for the whole column, which overestimates it, hence well under 1.
const AMBIENT_DEPTH: f32 = 0.25;

@group(0) @binding(0) var u_gDepth_texture: texture_depth_2d;     // device depth (occlusion bound)
@group(0) @binding(1) var u_gDepth_sampler: sampler;
// Baked tileable volumes, replacing the multi-octave hash FBM this shader used to evaluate inline —
// ~32 hash+lerp taps for the base field and ~24 more for detail, PER SAMPLE, with the secondary
// sun-march re-evaluating the base field at every one of its steps too. Two trilinear fetches now
// return the same fields. See cloudNoiseBake.
@group(0) @binding(2) var u_baseNoise_texture: texture_3d<f32>;  // R = shape, G/B = finer, A = warp
@group(0) @binding(3) var u_baseNoise_sampler: sampler;
@group(0) @binding(4) var u_detailNoise_texture: texture_3d<f32>; // RGB = high-frequency erosion
@group(0) @binding(5) var u_detailNoise_sampler: sampler;

struct CloudUniforms {
    u_invViewProj: mat4x4<f32>,
    u_viewPos: vec3<f32>,
    u_sunDir: vec3<f32>,          // sun TRAVEL direction, like a directional light's forward
    u_sunColor: vec3<f32>,
    u_ambientColor: vec3<f32>,
    u_groundColor: vec3<f32>,
    u_wind: vec3<f32>,            // direction (x/z used)
    u_traceResolution: vec2<f32>, // size of the reduced trace target, in pixels
    u_bayerOffset: vec2<i32>,     // sub-position within the 4x4 block traced this frame
    u_time: f32,                  // seconds, for wind animation
    // Shape
    u_coverage: f32,
    u_density: f32,
    u_cloudType: f32,             // 0 = stratus (flat) .. 1 = cumulonimbus (towering)
    u_baseAltitude: f32,
    u_thickness: f32,
    u_baseScale: f32,
    u_detailScale: f32,
    u_detailStrength: f32,
    u_curlStrength: f32,
    u_anvilBias: f32,
    // Lighting
    u_sunIntensity: f32,
    u_ambientIntensity: f32,
    u_phaseG: f32,
    u_silverIntensity: f32,
    u_silverSpread: f32,
    u_powderStrength: f32,
    // Animation
    u_windSpeed: f32,
    u_detailWindFactor: f32,
    // Quality
    u_maxDistance: f32,
    u_opacity: f32,
    u_baseNoiseInvPeriod: f32,    // 1 / lattice cells across the base volume
    u_detailNoiseInvPeriod: f32,  // 1 / lattice cells across the detail volume
    u_steps: i32,
    u_lightSteps: i32,
    u_jitter: i32,
    u_temporal: i32,
    // Which slot of the 16-frame Bayer cycle this frame is, used to advance the ray-start dither.
    // Also set on the non-temporal paths (from the raw frame counter) so they still get a moving one.
    u_jitterSlot: i32,
    // Physically based lighting (see the header).
    u_extinction: f32,            // sigma_t per metre at unit density (the renderer folds `absorption` in)
    u_albedo: f32,                // scattering / extinction
    u_phaseBackG: f32,            // back-scatter lobe anisotropy (negative)
    u_phaseBackWeight: f32,       // share of the back-scatter lobe
    u_msOctaves: i32,             // multiple-scattering octaves, 1..MAX_OCTAVES
    u_msScatter: f32,             // a: per-octave scattering attenuation
    u_msExtinction: f32,          // b: per-octave extinction attenuation (>= a)
    u_msEccentricity: f32,        // c: per-octave phase eccentricity attenuation
    u_hazeDistance: f32,          // aerial-perspective fade distance, 0 = off
    // 1 while baking the clouds into the sky cubemap: nothing occludes a sky face, and the G-buffer
    // depth bound here belongs to the camera view, not to the face being drawn.
    u_ignoreDepth: i32,
};
@group(1) @binding(0) var<uniform> u_cloud: CloudUniforms;

/**
 * Interleaved gradient noise (Jimenez), the spatial dither for the ray start.
 *
 * It has to be SPATIAL rather than per-frame random. The temporal resolve accumulates over a 16-frame
 * Bayer cycle, so a pixel drawing an uncorrelated offset every frame never averages — the noise is
 * simply frozen into history and reads as grain. Keyed to the pixel and stepped once per Bayer slot,
 * each pixel instead sees the same 16 offsets every cycle and converges.
 */
fn ign(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

fn remap(v: f32, inMin: f32, inMax: f32, outMin: f32, outMax: f32) -> f32 {
    return outMin + (v - inMin) / max(inMax - inMin, 1e-5) * (outMax - outMin);
}

/**
 * Vertical density profile across the slab (h in 0..1).
 *
 * `cloudType` raises the top so stratus stays a flat low layer while cumulonimbus fills the slab;
 * `anvilBias` flares the very top.
 */
fn heightGradient(h: f32, cloudType: f32) -> f32 {
    let topEnd = mix(0.25, 1.0, cloudType);
    let bottom = smoothstep(0.0, 0.12, h);
    let top = 1.0 - smoothstep(topEnd * 0.6, topEnd, h);
    let anvil = 1.0 + u_cloud.u_anvilBias * smoothstep(0.5, 1.0, h) * 1.5;
    return clamp(bottom * top, 0.0, 1.0) * anvil;
}

/**
 * Cloud density at a world position. `cheap` skips the detail erosion, for the toward-sun march.
 *
 * `wind` is passed rather than read from a module global: the GLSL twin used a mutable global set once
 * in main, which WGSL would express as `var<private>` — a parameter says the same thing without the
 * hidden dependency.
 *
 * All three volume fetches are `textureSampleLevel` at level 0, never `textureSample`. This function is
 * called from the raymarch loop and has its own per-fragment early-out below, so it is squarely in
 * non-uniform control flow — where WGSL forbids the derivative-taking `textureSample` outright, and
 * rejects the whole module ("'textureSample' must only be called from uniform control flow"), which
 * invalidated the `volumetricClouds` pipeline and drew no clouds at all.
 *
 * Level 0 is not a compromise: both volumes are created with `mipMap: false` (see the `volume` helper
 * in `Renderer._bakeCloudNoise`), so there is no other level to pick, and screen-space derivatives are
 * meaningless along a ray anyway. It generates `textureLod` on WebGL2, which reads the same texels.
 */
fn sampleDensity(pos: vec3<f32>, h: f32, cheap: bool, wind: vec3<f32>) -> f32 {
    let p = pos + wind;

    // Low-frequency base shape, from the baked volume.
    let base = textureSampleLevel(u_baseNoise_texture, u_baseNoise_sampler,
                                  p * u_cloud.u_baseScale * u_cloud.u_baseNoiseInvPeriod, 0.0).r;

    // Coverage remaps the base so higher coverage lets more of the field through; anvilBias widens the
    // effective coverage near the top for spreading cumulonimbus caps.
    let cov = clamp(u_cloud.u_coverage * (1.0 + h * u_cloud.u_anvilBias * 0.6), 0.0, 1.0);
    let shape = smoothstep(1.0 - cov, 1.0, base);

    var density = shape * heightGradient(h, u_cloud.u_cloudType);
    if (density <= 0.0) { return 0.0; }

    if (!cheap && u_cloud.u_detailStrength > 0.0) {
        var dp = pos + wind * u_cloud.u_detailWindFactor;
        if (u_cloud.u_curlStrength > 0.0) {
            // Curl-ish domain warp. The warp vector comes from the base volume's spare channels rather
            // than a hash: it is smooth (so the warp is coherent rather than per-cell noise) and it is
            // a fetch we can afford next to the ones already happening here.
            let warpSample = textureSampleLevel(u_baseNoise_texture, u_baseNoise_sampler,
                pos * u_cloud.u_baseScale * 4.0 * u_cloud.u_baseNoiseInvPeriod, 0.0);
            let warp = warpSample.gba - 0.5;
            dp += warp * u_cloud.u_curlStrength * (1.0 / max(u_cloud.u_detailScale, 1e-5)) * 0.15
                  + vec3<f32>(warpSample.a) * u_cloud.u_curlStrength * 50.0;
        }
        let detail = textureSampleLevel(u_detailNoise_texture, u_detailNoise_sampler,
                                        dp * u_cloud.u_detailScale * u_cloud.u_detailNoiseInvPeriod, 0.0).r;
        density = remap(density, detail * u_cloud.u_detailStrength, 1.0, 0.0, 1.0);
    }

    return clamp(density, 0.0, 1.0) * heightGradient(h, u_cloud.u_cloudType)
           * clamp(u_cloud.u_density / 2.5, 0.0, 1.0);
}

fn henyeyGreenstein(cosAngle: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosAngle, 1e-4), 1.5));
}

/**
 * Cloud phase function with every lobe's eccentricity scaled by `ecc` (1 for single scattering, c^i for
 * multiple-scattering octave i, which flattens the phase toward isotropic as light bounces).
 *
 * Each lobe is a normalised HG and they are combined with `mix`, so the result still integrates to one
 * over the sphere. The old `max(forward, silver)` did not, and it put a visible kink where the two
 * lobes crossed. The silver-lining intensity becomes a weight `s / (1 + s)`, so 0 removes the lobe and
 * large values approach (but never exceed) a pure silver lobe.
 */
fn cloudPhase(cosAngle: f32, ecc: f32) -> f32 {
    let forward = henyeyGreenstein(cosAngle, u_cloud.u_phaseG * ecc);
    let silverG = clamp(0.99 - u_cloud.u_silverSpread, 0.0, 0.999);
    let silver = henyeyGreenstein(cosAngle, silverG * ecc);
    let silverWeight = u_cloud.u_silverIntensity / (1.0 + u_cloud.u_silverIntensity);
    let back = henyeyGreenstein(cosAngle, u_cloud.u_phaseBackG * ecc);
    return mix(mix(forward, silver, silverWeight), back, u_cloud.u_phaseBackWeight);
}

fn reconstructWorldPos(depth: f32, uv: vec2<f32>) -> vec3<f32> {
    let clip = vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let world = u_cloud.u_invViewProj * clip;
    return world.xyz / world.w;
}

/**
 * The UV this fragment should trace.
 *
 * In temporal mode this shader renders into a buffer 1/4 the size per axis, where each pixel owns one
 * 4x4 block of the full-resolution cloud image and traces ONE sub-position within it — the one
 * `u_bayerOffset` selects this frame. So 1/16 of the rays are cast, and cloudTemporalResolve
 * reconstructs the rest from reprojected history.
 *
 * Doing the selection here, by remapping the UV, rather than by rendering full-size and discarding,
 * means the saved rays are genuinely never rasterized.
 */
fn traceUV(fragUv: vec2<f32>) -> vec2<f32> {
    if (u_cloud.u_temporal == 0) { return fragUv; }
    // Block index this fragment stands for, from its position in the reduced-size target.
    let block = floor(fragUv * u_cloud.u_traceResolution);
    let sub = vec2<f32>(u_cloud.u_bayerOffset);
    // Centre of the chosen sub-pixel, in full cloud-resolution UV space.
    return (block * 4.0 + sub + 0.5) / (u_cloud.u_traceResolution * 4.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = traceUV(in.uv);

    // 1. World-space view ray (near -> far), origin at the camera.
    let ndc = uv * 2.0 - 1.0;
    let nW = u_cloud.u_invViewProj * vec4<f32>(ndc, -1.0, 1.0);
    let fW = u_cloud.u_invViewProj * vec4<f32>(ndc, 1.0, 1.0);
    let ro = nW.xyz / nW.w;
    let rd = normalize(fW.xyz / fW.w - ro);

    // 2. Occlusion bound: distance to solid geometry (background depth == 1.0 means infinite).
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    var sceneDist = u_cloud.u_maxDistance;
    if (depth < 1.0 && u_cloud.u_ignoreDepth == 0) {
        sceneDist = min(sceneDist, length(reconstructWorldPos(depth, uv) - u_cloud.u_viewPos));
    }

    // 3. Intersect the horizontal cloud slab.
    let slabBottom = u_cloud.u_baseAltitude;
    let slabTop = u_cloud.u_baseAltitude + u_cloud.u_thickness;
    var tEnter: f32;
    var tExit: f32;
    if (abs(rd.y) < 1e-5) {
        // Ray (near) parallel to the slab: only lit if the camera sits inside it.
        if (u_cloud.u_viewPos.y < slabBottom || u_cloud.u_viewPos.y > slabTop) {
            return vec4<f32>(0.0);
        }
        tEnter = 0.0;
        tExit = sceneDist;
    } else {
        let t0 = (slabBottom - u_cloud.u_viewPos.y) / rd.y;
        let t1 = (slabTop - u_cloud.u_viewPos.y) / rd.y;
        tEnter = min(t0, t1);
        tExit = max(t0, t1);
    }
    tEnter = max(tEnter, 0.0);
    tExit = min(tExit, sceneDist);
    if (tEnter >= tExit) { return vec4<f32>(0.0); }

    let wind = u_cloud.u_wind * (u_cloud.u_windSpeed * u_cloud.u_time);

    let steps = clamp(u_cloud.u_steps, 1, MAX_STEPS);
    let marchLen = tExit - tEnter;
    let stepLen = marchLen / f32(steps);

    // Dither the start to trade banding for noise, advanced by the golden ratio each Bayer slot so the
    // 16 offsets a pixel sees over a cycle are well spread.
    //
    // The dither MUST be keyed to the full-resolution pixel this ray reconstructs, not to the fragment
    // coordinate: in temporal mode that is the trace buffer's coordinate, so a given full-res pixel
    // drew an unrelated offset every time its block came up.
    var jitterPx = in.position.xy;
    if (u_cloud.u_temporal != 0) { jitterPx = floor(uv * u_cloud.u_traceResolution * 4.0); }
    var jitter = 0.0;
    if (u_cloud.u_jitter != 0) {
        jitter = fract(ign(jitterPx) + f32(u_cloud.u_jitterSlot) * 0.6180339887);
    }
    var t = tEnter + stepLen * jitter;

    // Sun setup (direction TOWARD the sun).
    let sunDir = normalize(-u_cloud.u_sunDir);
    let cosAngle = dot(rd, sunDir);
    let sunLight = u_cloud.u_sunColor * u_cloud.u_sunIntensity;

    // Multiple-scattering octaves. The phase of every octave depends only on the ray, so it is
    // evaluated once here and folded with that octave's scattering weight a^i; the extinction scale
    // b^i is kept alongside for the per-sample exp().
    let octaves = clamp(u_cloud.u_msOctaves, 1, MAX_OCTAVES);
    let msA = u_cloud.u_msScatter;
    let msB = max(u_cloud.u_msExtinction, msA);   // a <= b, or the octaves create energy
    var octaveWeight: array<f32, 4>;
    var octaveExt: array<f32, 4>;
    var a = 1.0;
    var b = 1.0;
    var c = 1.0;
    // The ambient term is isotropic, so its octaves need no phase: only the summed scattering weight.
    var ambientBoost = 0.0;
    for (var o = 0; o < MAX_OCTAVES; o++) {
        if (o < octaves) {
            octaveWeight[o] = a * cloudPhase(cosAngle, c);
            octaveExt[o] = b;
            ambientBoost += a;
        } else {
            octaveWeight[o] = 0.0;
            octaveExt[o] = 1.0;
        }
        a *= msA;
        b *= msB;
        c *= u_cloud.u_msEccentricity;
    }
    // Powder (Schneider) darkens sun-facing edges that have not yet built up in-scattered light. It is
    // not energy conserving, so it stays an artist control: applied to the sun term only, and faded out
    // looking toward the sun, where forward scattering makes those same edges the brightest part.
    let powderWeight = u_cloud.u_powderStrength * (0.5 - 0.5 * cosAngle);

    let lightSteps = clamp(u_cloud.u_lightSteps, 1, MAX_LIGHT_STEPS);
    let invLightSteps = 1.0 / f32(lightSteps);
    let invSlab = 1.0 / max(u_cloud.u_thickness, 1e-3);
    let sigmaScale = u_cloud.u_extinction;
    // Toward-sun march length cap: a low sun would otherwise march tens of kilometres through the slab.
    let lightCap = u_cloud.u_thickness * 3.0;

    var transmittance = 1.0;
    var scatteredLight = vec3<f32>(0.0);
    // Transmittance-weighted mean cloud depth, for the aerial perspective.
    var depthSum = 0.0;
    var depthWeight = 0.0;

    // -----------------------------------------------------------------------------------------
    // Two-speed march.
    //
    // Clouds are mostly empty sky: for a typical coverage the great majority of samples along a ray
    // return zero density, and the expensive work (detail-erosion fetch, plus a whole secondary march
    // toward the sun) only happens where density > 0. Marching at the fine step everywhere therefore
    // spends most of its samples proving that nothing is there.
    //
    // So: step at CHEAP_STEP_SCALE x the fine step using the cheap density (no detail erosion) until
    // something is hit, then back up one coarse step and switch to fine stepping with the full
    // density. After MISSES_BEFORE_COARSE consecutive empty fine samples, drop back to coarse.
    //
    // Coarse and fine samples count against the same `steps` allowance, so the worst case (a ray
    // entirely inside dense cloud) costs exactly what it did before while the common case gets much
    // cheaper. Backing up before the fine march is what keeps the cloud boundary in the same place —
    // without it, silhouettes visibly snap to the coarse stride.
    // -----------------------------------------------------------------------------------------
    const CHEAP_STEP_SCALE: f32 = 3.0;
    const MISSES_BEFORE_COARSE: i32 = 8;

    var coarse = true;
    var misses = 0;

    for (var i = 0; i < MAX_STEPS; i++) {
        if (i >= steps || transmittance < 0.01 || t > tExit) { break; }
        let pos = u_cloud.u_viewPos + rd * t;
        let h = clamp((pos.y - slabBottom) * invSlab, 0.0, 1.0);

        if (coarse) {
            // Cheap probe: base shape only. A hit rewinds one coarse step so the fine march starts
            // just OUTSIDE the cloud and the edge lands where a fine-only march would have put it.
            if (sampleDensity(pos, h, true, wind) > 0.0) {
                coarse = false;
                misses = 0;
                t = max(tEnter, t - stepLen * CHEAP_STEP_SCALE);
                continue;
            }
            t += stepLen * CHEAP_STEP_SCALE;
            continue;
        }

        let density = sampleDensity(pos, h, false, wind);

        if (density > 0.001) {
            misses = 0;
            // Secondary march toward the sun for self-shadowing (cheap density). It runs to the top of
            // the slab rather than a fixed `thickness`, so a low sun is shadowed by all the cloud in its
            // way. Steps grow quadratically: the near field, which decides how bright an edge is, gets
            // most of the samples while the far field still counts.
            let toTop = (slabTop - pos.y) / max(sunDir.y, 0.05);
            let lightLen = clamp(toTop, u_cloud.u_thickness * 0.05, lightCap);
            var lightDensity = 0.0;
            var prevT = 0.0;
            for (var j = 0; j < MAX_LIGHT_STEPS; j++) {
                if (j >= lightSteps) { break; }
                let f1 = (f32(j) + 1.0) * invLightSteps;
                let fm = (f32(j) + 0.5) * invLightSteps;
                let nextT = lightLen * f1 * f1;
                let lp = pos + sunDir * (lightLen * fm * fm);
                let lh = clamp((lp.y - slabBottom) * invSlab, 0.0, 1.0);
                lightDensity += sampleDensity(lp, lh, true, wind) * (nextT - prevT);
                prevT = nextT;
            }
            let tauSun = lightDensity * sigmaScale;

            // Sun: the sum of the octaves, each with its own extinction and phase.
            var sunScatter = 0.0;
            for (var o = 0; o < MAX_OCTAVES; o++) {
                if (o >= octaves) { break; }
                sunScatter += octaveWeight[o] * exp(-tauSun * octaveExt[o]);
            }
            let powder = 1.0 - exp(-2.0 * tauSun);
            sunScatter *= mix(1.0, powder, powderWeight);

            let sigmaT = density * sigmaScale;
            let sigmaS = sigmaT * u_cloud.u_albedo;

            // Isotropic ambient: half the sphere sees the sky, half the ground. Each half is occluded by
            // an analytic estimate of the cloud column above / below this sample, so bases and interiors
            // darken while tops stay sky-lit. The octaves add the light bounced in from neighbours.
            let skyVis = exp(-sigmaT * (1.0 - h) * u_cloud.u_thickness * AMBIENT_DEPTH);
            let groundVis = exp(-sigmaT * h * u_cloud.u_thickness * AMBIENT_DEPTH);
            let ambient = (u_cloud.u_ambientColor * skyVis + u_cloud.u_groundColor * groundVis)
                          * (0.5 * u_cloud.u_ambientIntensity * ambientBoost);

            // Energy-conserving analytical integration of in-scattering over the step (Hillaire 2016):
            // S is the radiance scattered toward the eye per metre, integrated against the step's own
            // extinction rather than assumed constant-transmittance across it.
            let S = (sunLight * sunScatter + ambient) * sigmaS;
            let tr = exp(-sigmaT * stepLen);
            let sInt = (S - S * tr) / max(sigmaT, 1e-7);
            scatteredLight += transmittance * sInt;

            let absorbed = transmittance * (1.0 - tr);
            depthSum += t * absorbed;
            depthWeight += absorbed;
            transmittance *= tr;
        } else {
            misses++;
            if (misses >= MISSES_BEFORE_COARSE) { coarse = true; misses = 0; }
        }

        t += stepLen;
    }

    // Aerial perspective. The clouds composite over the sky, so fading their premultiplied colour AND
    // coverage together blends them into whatever sky is behind them: the right haze colour at every
    // time of day, for free.
    var haze = 1.0;
    if (u_cloud.u_hazeDistance > 0.0 && depthWeight > 0.0) {
        haze = exp(-(depthSum / depthWeight) / u_cloud.u_hazeDistance);
    }

    let fade = u_cloud.u_opacity * haze;
    let alpha = (1.0 - transmittance) * fade;
    if (alpha <= 0.0) { return vec4<f32>(0.0); }

    // The scene buffer is LINEAR HDR, so output linear scattered radiance and let the single final
    // tonemapper handle exposure/tonemap/gamma like every other surface. Output is PREMULTIPLIED
    // (composited with ONE, ONE_MINUS_SRC_ALPHA) so bilinear upsampling from the reduced-resolution
    // path does not fringe cloud silhouettes toward black.
    //
    // `scatteredLight` is ALREADY premultiplied: it is radiance reaching the eye, accumulated under the
    // view transmittance. It used to be multiplied by alpha a second time, which squared the coverage
    // and darkened every thin edge and wisp toward black.
    return vec4<f32>(scatteredLight * fade, alpha);
}
