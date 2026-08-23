// Volumetric clouds: a single fullscreen raymarch.
//
// For every pixel a world-space view ray is reconstructed from `u_invViewProj`, intersected with a
// horizontal cloud slab, and marched through a density field (baked value-noise FBM shaped by a height
// gradient and coverage, eroded by higher-frequency detail). Lighting uses a secondary march toward the
// sun (Beer-Powder) with a Henyey-Greenstein phase plus silver lining, and a sky/ground ambient
// gradient. The scene depth buffer bounds the ray so solid geometry occludes the clouds.
//
// GLSL ES needed `precision highp sampler3D` here because it does not predeclare one — the shader
// simply failed to compile without it. WGSL has no precision qualifiers at all, so that whole class of
// problem disappears in the translation.

#include "./chunks/fullscreen.wgsl"

const PI: f32 = 3.14159265359;
const MAX_STEPS: i32 = 192;
const MAX_LIGHT_STEPS: i32 = 12;

@group(0) @binding(0) var u_gDepth_texture: texture_2d<f32>;     // device depth (occlusion bound)
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
    u_absorption: f32,
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
 */
fn sampleDensity(pos: vec3<f32>, h: f32, cheap: bool, wind: vec3<f32>) -> f32 {
    let p = pos + wind;

    // Low-frequency base shape, from the baked volume.
    let base = textureSample(u_baseNoise_texture, u_baseNoise_sampler,
                             p * u_cloud.u_baseScale * u_cloud.u_baseNoiseInvPeriod).r;

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
            let warpSample = textureSample(u_baseNoise_texture, u_baseNoise_sampler,
                pos * u_cloud.u_baseScale * 4.0 * u_cloud.u_baseNoiseInvPeriod);
            let warp = warpSample.gba - 0.5;
            dp += warp * u_cloud.u_curlStrength * (1.0 / max(u_cloud.u_detailScale, 1e-5)) * 0.15
                  + vec3<f32>(warpSample.a) * u_cloud.u_curlStrength * 50.0;
        }
        let detail = textureSample(u_detailNoise_texture, u_detailNoise_sampler,
                                   dp * u_cloud.u_detailScale * u_cloud.u_detailNoiseInvPeriod).r;
        density = remap(density, detail * u_cloud.u_detailStrength, 1.0, 0.0, 1.0);
    }

    return clamp(density, 0.0, 1.0) * heightGradient(h, u_cloud.u_cloudType)
           * clamp(u_cloud.u_density / 2.5, 0.0, 1.0);
}

fn henyeyGreenstein(cosAngle: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
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
    let depth = textureSample(u_gDepth_texture, u_gDepth_sampler, uv).r;
    var sceneDist = u_cloud.u_maxDistance;
    if (depth < 1.0) {
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

    // Sun setup (direction TOWARD the sun) plus phase.
    let sunDir = normalize(-u_cloud.u_sunDir);
    let cosAngle = dot(rd, sunDir);
    let phase = max(henyeyGreenstein(cosAngle, u_cloud.u_phaseG),
                    u_cloud.u_silverIntensity
                    * henyeyGreenstein(cosAngle, clamp(0.99 - u_cloud.u_silverSpread, 0.0, 0.999)));
    let sunLight = u_cloud.u_sunColor * u_cloud.u_sunIntensity;

    let lightSteps = clamp(u_cloud.u_lightSteps, 1, MAX_LIGHT_STEPS);
    let lightStepLen = u_cloud.u_thickness / f32(lightSteps);
    let invSlab = 1.0 / max(u_cloud.u_thickness, 1e-3);

    var transmittance = 1.0;
    var scatteredLight = vec3<f32>(0.0);

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
            // Secondary march toward the sun for self-shadowing (cheap density).
            var lightOpticalDepth = 0.0;
            for (var j = 0; j < MAX_LIGHT_STEPS; j++) {
                if (j >= lightSteps) { break; }
                let lp = pos + sunDir * (lightStepLen * (f32(j) + 0.5));
                let lh = clamp((lp.y - slabBottom) * invSlab, 0.0, 1.0);
                lightOpticalDepth += sampleDensity(lp, lh, true, wind) * lightStepLen;
            }

            let beers = exp(-lightOpticalDepth * u_cloud.u_absorption);
            let powder = 1.0 - exp(-lightOpticalDepth * 2.0 * u_cloud.u_absorption);
            let powderTerm = mix(1.0, 2.0 * powder, u_cloud.u_powderStrength);

            let sampleLight = sunLight * beers * powderTerm * phase;
            let ambient = mix(u_cloud.u_groundColor, u_cloud.u_ambientColor, h)
                          * u_cloud.u_ambientIntensity;

            // Energy-conserving analytical integration of in-scattering over the step.
            let sigmaT = density * u_cloud.u_absorption;
            let s = (sampleLight + ambient) * density;
            let tr = exp(-sigmaT * stepLen);
            let sInt = (s - s * tr) / max(sigmaT, 1e-5);
            scatteredLight += transmittance * sInt;
            transmittance *= tr;
        } else {
            misses++;
            if (misses >= MISSES_BEFORE_COARSE) { coarse = true; misses = 0; }
        }

        t += stepLen;
    }

    let alpha = (1.0 - transmittance) * u_cloud.u_opacity;
    if (alpha <= 0.0) { return vec4<f32>(0.0); }

    // The scene buffer is LINEAR HDR, so output linear scattered radiance and let the single final
    // tonemapper handle exposure/tonemap/gamma like every other surface. Output is PREMULTIPLIED
    // (composited with ONE, ONE_MINUS_SRC_ALPHA) so bilinear upsampling from the reduced-resolution
    // path does not fringe cloud silhouettes toward black.
    return vec4<f32>(scatteredLight * alpha, alpha);
}
