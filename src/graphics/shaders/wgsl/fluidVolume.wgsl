// Smoke-and-fire volumes (`FluidVolumeNode`, core/scene/nodes/fluidVolumeNode.ts): the TRACE.
//
// The renderer rasterises the box's BACK faces with no depth test into the volume trace target, so
// every pixel whose view ray crosses the volume is shaded exactly once, with the camera outside the box
// or inside it -- the decal trick (chunks/decal.wgsl). Each fragment rebuilds its view ray from the
// inverse view-projection, clips it to the unit box and to the opaque depth snapshot, and marches the
// voxel texture front to back:
//
//   - single scattering of the sun through the transmittance precomputed in the volume's B channel,
//     shaped by a Henyey-Greenstein phase, plus Wrenninge's multiple-scattering octaves;
//   - fire emission coloured by temperature (G) through the fire LUT, and the fire's own light on the
//     smoke around it (A);
//   - procedural detail noise eroding the density below the grid's resolution;
//   - optionally tricubic B-spline sampling (Sigg & Hadwiger: 8 trilinear taps) for unblocky gas,
//     chromatic smoke extinction (per-channel transmittance; alpha is its mean), soot-masked fire and
//     the blue reaction-zone core;
//   - two volumes (the previous and current simulation frame) blended, so playback is smooth between
//     simulation frames;
//   - an occupancy grid of 8^3 bricks: empty bricks are crossed in one jump.
//
// Two outputs, both PREMULTIPLIED for the renderer's ONE / ONE_MINUS_SRC_ALPHA "over": colour with
// coverage alpha, and the coverage-weighted distance along the ray (r) with the same alpha, which the
// temporal resolve reprojects through and the composite tests against the full-resolution depth.
//
// No discard and no implicit derivatives: a miss returns zero, and every fetch is explicit-level.
//
// LIQUID shading (`u_shading` 1) reads the same box as a particle liquid instead: R is a splatted
// density whose `u_liquidIso` crossing is the surface, G foam, B the sun's transmittance. The ray stops
// at the first crossing (bisected), takes the normal from the density gradient and the thickness from
// how long the ray stays inside, and shades it as `liquid_shade` -- the Creator's liquidRender.ts
// `shadeLiquid`, so the live preview and the bake agree.

const MAX_STEPS: i32 = 384;
const INV_PI: f32 = 0.31830988618;
const BRICK: f32 = 8.0;

@group(0) @binding(0) var u_sceneDepth_texture: texture_depth_2d;   // opaque depth snapshot
@group(0) @binding(1) var u_sceneDepth_sampler: sampler;
@group(0) @binding(2) var u_volume_texture: texture_3d<f32>;        // R density, G temperature, B light, A fire glow (< 0: blue core)
@group(0) @binding(3) var u_volume_sampler: sampler;
@group(0) @binding(4) var u_fireLut_texture: texture_2d<f32>;       // 256 x 1 fire colour
@group(0) @binding(5) var u_fireLut_sampler: sampler;
@group(0) @binding(6) var u_prevVolume_texture: texture_3d<f32>;    // the previous simulation frame
@group(0) @binding(7) var u_prevVolume_sampler: sampler;
@group(0) @binding(8) var u_occupancy_texture: texture_3d<f32>;     // R > 0: the brick holds something
@group(0) @binding(9) var u_occupancy_sampler: sampler;
// Advected detail coordinates (flow noise), half resolution: RGB = where in the noise this gas came from.
@group(0) @binding(10) var u_detailA_texture: texture_3d<f32>;
@group(0) @binding(11) var u_detailA_sampler: sampler;
@group(0) @binding(12) var u_detailB_texture: texture_3d<f32>;
@group(0) @binding(13) var u_detailB_sampler: sampler;

// Vertex stage ONLY. A block read from both stages is a GLSL link error ("Ambiguous field").
struct FluidVolumeTransform {
    u_model: mat4x4<f32>,        // unit cube -> world: worldTransform x scale(size)
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_transform: FluidVolumeTransform;

struct FluidVolumeUniforms {
    u_volumeInvModel: mat4x4<f32>,   // world -> unit box (inside = |xyz| <= 0.5)
    // Clip -> world for a clip vector built from screen uv (the renderer's `_uvConsuming` form).
    u_invViewProj: mat4x4<f32>,
    u_voxels: vec3<f32>,             // resolution along the box's x, y, z
    u_smokeColor: vec3<f32>,         // linear albedo
    u_sunColor: vec3<f32>,           // the key light's illuminance, linear RGB
    u_sunAmbient: vec3<f32>,         // the scene's ambient irradiance, linear RGB
    u_sunDir: vec3<f32>,             // unit vector toward the key light, in the BOX's frame
    u_absorptionScale: vec3<f32>,    // per-channel extinction scale (mean 1; white smoke is 1, 1, 1)
    u_blueCoreColor: vec3<f32>,      // linear
    u_viewPos: vec3<f32>,
    u_bricks: vec3<f32>,             // occupancy grid size, bricks
    u_targetSize: vec2<f32>,         // the trace target, pixels
    u_traceJitter: vec2<f32>,        // sub-pixel ray offset this frame, pixels (temporal only)
    u_absorption: f32,
    u_emission: f32,
    u_emissionRange: f32,
    u_ignition: f32,
    u_fireOpacity: f32,
    u_ambient: f32,                  // share of the sun reaching fully shadowed smoke
    u_fireScale: f32,                // exposure compensation for the fire (see fireExposureWeight)
    u_stepScale: f32,                // march step, voxels
    u_blend: f32,                    // 0 = previous volume, 1 = current
    u_anisotropy: f32,
    u_fireGlow: f32,
    u_detailStrength: f32,
    u_detailScale: f32,
    u_time: f32,
    u_albedo: f32,
    u_powder: f32,
    u_skyOcclusion: f32,
    u_fireIntensity: f32,
    u_detailBlend: f32,              // set A's share of the advected-detail cross-fade
    u_sootMask: f32,                 // fire inside dense smoke dimmed by it
    u_blueCore: f32,                 // blue reaction-zone emission strength
    u_sharpen: f32,                  // density contrast
    u_liquidIso: f32,                // liquid: the surface density
    u_liquidRoughness: f32,
    u_liquidSpecular: f32,
    u_liquidFoam: f32,
    u_liquidMetallic: f32,           // liquid: 0..1, a metal (opaque, all reflection, tinted by u_smokeColor)
    u_smoothSampling: i32,           // tricubic B-spline sampling
    u_scatterOctaves: i32,
    u_hasDetail: i32,
    u_jitterSlot: i32,
    u_hasLut: i32,
    u_hasOccupancy: i32,
    u_shading: i32,                  // 0 gas, 1 liquid
    /** The frame's pre-exposure (graphics/preExposure.ts): the trace's light is stored multiplied by it. */
    u_preExposure: f32,
};
@group(1) @binding(4) var<uniform> u_fluid: FluidVolumeUniforms;   // not `u_volume`: GLSL names the u_volume_texture sampler that, and the two would clash

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

struct TraceOutput {
    @location(0) color: vec4<f32>,
    @location(1) depth: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = u_transform.u_projection * u_transform.u_view * u_transform.u_model
                 * vec4<f32>(position, 1.0);
    return out;
}

/** Interleaved gradient noise (Jimenez): the ray-start dither, stepped per frame. */
fn ign(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

fn hash3(p: vec3<f32>) -> f32 {
    return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

/** Trilinear value noise in 0..1, for the detail erosion. */
fn value_noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = p - i;
    let s = f * f * (3.0 - 2.0 * f);
    let x0 = mix(mix(hash3(i), hash3(i + vec3<f32>(1.0, 0.0, 0.0)), s.x),
                 mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0)), hash3(i + vec3<f32>(1.0, 1.0, 0.0)), s.x), s.y);
    let x1 = mix(mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0)), hash3(i + vec3<f32>(1.0, 0.0, 1.0)), s.x),
                 mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0)), hash3(i + vec3<f32>(1.0, 1.0, 1.0)), s.x), s.y);
    return mix(x0, x1, s.z);
}

fn unproject(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let w = u_fluid.u_invViewProj * vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return w.xyz / w.w;
}

/** 4 pi x Henyey-Greenstein: 1 for isotropic scattering, so g = 0 changes nothing. */
fn phase_scale(cos_theta: f32, g: f32) -> f32 {
    if (g == 0.0) { return 1.0; }
    let d = 1.0 + g * g - 2.0 * g * cos_theta;
    return (1.0 - g * g) / pow(max(d, 1e-6), 1.5);
}

/** The sun's share of a smoke sample's light, with Wrenninge's multiple-scattering octaves. */
fn sun_scatter(t: f32, cos_theta: f32) -> f32 {
    var sum = 0.0; var a = 1.0; var b = 1.0; var c = 1.0;
    for (var k = 0; k < max(1, u_fluid.u_scatterOctaves); k = k + 1) {
        sum = sum + a * pow(t, b) * phase_scale(cos_theta, u_fluid.u_anisotropy * c);
        a = a * 0.5; b = b * 0.5; c = c * 0.5;
    }
    return sum;
}

fn sample_volume(uvw: vec3<f32>) -> vec4<f32> {
    let cur = textureSampleLevel(u_volume_texture, u_volume_sampler, uvw, 0.0);
    if (u_fluid.u_blend >= 1.0) { return cur; }
    let prev = textureSampleLevel(u_prevVolume_texture, u_prevVolume_sampler, uvw, 0.0);
    return mix(prev, cur, u_fluid.u_blend);
}

/** Two tap positions (voxel-index space) and their weights along one axis of a cubic B-spline. */
fn bspline_axis(x: f32) -> vec4<f32> {
    let i = floor(x); let f = x - i;
    let f2 = f * f; let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1; let g1 = w2 + w3;
    return vec4<f32>(i - 1.0 + w1 / g0, i + 1.0 + w3 / g1, g0, g1);
}

/** Tricubic B-spline sampling from 8 trilinear taps (Sigg & Hadwiger, GPU Gems 2 ch. 20). */
fn sample_smooth(uvw: vec3<f32>) -> vec4<f32> {
    let n = u_fluid.u_voxels;
    let x = uvw * n - vec3<f32>(0.5);
    let ax = bspline_axis(x.x); let ay = bspline_axis(x.y); let az = bspline_axis(x.z);
    var acc = vec4<f32>(0.0);
    for (var k = 0; k < 8; k = k + 1) {
        let sx = (k & 1) != 0; let sy = (k & 2) != 0; let sz = (k & 4) != 0;
        let q = vec3<f32>(select(ax.x, ax.y, sx), select(ay.x, ay.y, sy), select(az.x, az.y, sz));
        let w = select(ax.z, ax.w, sx) * select(ay.z, ay.w, sy) * select(az.z, az.w, sz);
        acc = acc + w * sample_volume((q + vec3<f32>(0.5)) / n);
    }
    return acc;
}

/** The fire's brightness per unit emission per voxel, whatever its opacity (Creator realism.ts `FIRE_EMIT`). */
const FIRE_EMIT: f32 = 0.6;

/** True when the brick around `uvw` holds nothing. */
fn brick_empty(uvw: vec3<f32>) -> bool {
    if (u_fluid.u_hasOccupancy == 0) { return false; }
    let b = clamp(vec3<i32>(floor(uvw * u_fluid.u_bricks)), vec3<i32>(0), vec3<i32>(u_fluid.u_bricks) - vec3<i32>(1));
    return textureLoad(u_occupancy_texture, b, 0).r <= 0.0;
}

/** What a liquid reflects besides the sun, by direction (liquidRender.ts `liquidSky`). */
fn liquid_sky(ry: f32) -> f32 {
    return select(0.1 + 0.15 * (1.0 + ry), 0.75 - 0.2 * ry, ry >= 0.0);
}

/** GGX x Smith x Schlick, times N.L: the sun's highlight per unit of its light (liquidRender.ts `ggxSpecular`), for reflectance f0. */
fn ggx_specular(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32, f0: f32) -> f32 {
    let nl = dot(n, l);
    let nv = max(dot(n, v), 1e-4);
    let h = normalize(v + l);
    let nh = max(dot(n, h), 0.0);
    let vh = max(dot(v, h), 0.0);
    let a = max(roughness * roughness, 0.002);
    let a2 = a * a;
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    let D = a2 / (3.14159265 * dd * dd);
    let k = a * 0.5;
    let G = (max(nl, 0.0) / (max(nl, 0.0) * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
    let F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
    return select(0.0, D * G * F / (4.0 * nv), nl > 0.0);
}

fn liquid_at(uvw: vec3<f32>) -> f32 {
    return sample_volume(uvw).r;
}

/**
 * The liquid surface along the ray: the first iso crossing between t0 and t1 (in steps of `dt`,
 * skipping empty bricks), bisected, shaded. Premultiplied colour and coverage, as the gas march's.
 */
fn liquid_trace(lo: vec3<f32>, ld: vec3<f32>, safe: vec3<f32>, t0: f32, t1: f32, dt: f32, dlen: f32, jitter: f32) -> TraceOutput {
    var out: TraceOutput;
    out.color = vec4<f32>(0.0);
    out.depth = vec4<f32>(0.0);
    let iso = u_fluid.u_liquidIso;
    var t = t0 + dt * jitter;
    var prev = t0;
    var hit = false;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= t1) { break; }
        let uvw = lo + ld * t + vec3<f32>(0.5);
        if (brick_empty(uvw)) {
            let bmin = floor(uvw * u_fluid.u_bricks) / u_fluid.u_bricks;
            let bmax = bmin + vec3<f32>(1.0) / u_fluid.u_bricks;
            let q0 = (bmin - vec3<f32>(0.5) - lo) / safe;
            let q1 = (bmax - vec3<f32>(0.5) - lo) / safe;
            let exitT = min(min(max(q0.x, q1.x), max(q0.y, q1.y)), max(q0.z, q1.z));
            prev = t;
            t = t + max(ceil((exitT - t) / dt), 1.0) * dt;
            continue;
        }
        if (liquid_at(uvw) >= iso) { hit = true; break; }
        prev = t;
        t = t + dt;
    }
    if (!hit) { return out; }
    var a = prev;
    var b = t;
    for (var k: i32 = 0; k < 6; k = k + 1) {
        let m = 0.5 * (a + b);
        if (liquid_at(lo + ld * m + vec3<f32>(0.5)) >= iso) { b = m; } else { a = m; }
    }
    let p = lo + ld * b + vec3<f32>(0.5);
    // Everything in VOXEL space, which for cubic voxels is world space scaled: directions keep their angles.
    let vox = u_fluid.u_voxels;
    let e = vec3<f32>(1.0) / vox;
    let g = vec3<f32>(liquid_at(p + vec3<f32>(e.x, 0.0, 0.0)) - liquid_at(p - vec3<f32>(e.x, 0.0, 0.0)),
                      liquid_at(p + vec3<f32>(0.0, e.y, 0.0)) - liquid_at(p - vec3<f32>(0.0, e.y, 0.0)),
                      liquid_at(p + vec3<f32>(0.0, 0.0, e.z)) - liquid_at(p - vec3<f32>(0.0, 0.0, e.z)));
    let dv = normalize(ld * vox);
    let n = select(-normalize(g), -dv, dot(g, g) < 1e-12);
    let V = -dv;
    let L = normalize(u_fluid.u_sunDir * vox);
    // Thickness behind the surface, voxels.
    let stepVox = dt * length(ld * vox);
    var inside = 0.0;
    var s = b + dt;
    for (var j: i32 = 0; j < 96; j = j + 1) {
        if (s >= t1) { break; }
        if (liquid_at(lo + ld * s + vec3<f32>(0.5)) < iso) { break; }
        inside = inside + stepVox;
        s = s + dt;
    }
    let T = exp(-u_fluid.u_absorption * u_fluid.u_absorptionScale * inside);
    let at = sample_volume(p);
    let shadow = clamp(at.b, 0.0, 1.0);
    let fo = clamp(at.g * u_fluid.u_liquidFoam, 0.0, 1.0);
    let sun = u_fluid.u_sunColor * INV_PI;
    let nl = dot(n, L);
    let wrap = max((nl + 0.3) / 1.3, 0.0);
    let diffuseLight = sun * wrap * shadow * (1.0 - u_fluid.u_ambient) + u_fluid.u_sunAmbient + sun * u_fluid.u_ambient;
    // A metal's reflectance is its colour; a liquid's, water's 0.02. The highlight is linear in it.
    let m = clamp(u_fluid.u_liquidMetallic, 0.0, 1.0);
    let f0 = mix(vec3<f32>(0.02), u_fluid.u_smokeColor, m);
    let nvRaw = dot(n, V);
    let F = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - max(nvRaw, 0.0), 5.0);
    let k = u_fluid.u_liquidSpecular * shadow;
    let s0 = k * ggx_specular(n, V, L, u_fluid.u_liquidRoughness, 0.0);
    let s1 = k * ggx_specular(n, V, L, u_fluid.u_liquidRoughness, 1.0);
    let spec = u_fluid.u_sunColor * (vec3<f32>(s0) + f0 * (s1 - s0));
    // The sky in the surface: brighter facing up; a metal mirrors it along the reflected ray.
    let ry = -V.y + 2.0 * nvRaw * n.y;
    let sky = mix(0.25 + 0.55 * max(n.y, 0.0), liquid_sky(ry), m);
    let env = (u_fluid.u_sunAmbient + sun * u_fluid.u_ambient) * (u_fluid.u_liquidSpecular * sky) * F;
    let body = u_fluid.u_smokeColor * diffuseLight * (vec3<f32>(1.0) - T);
    let diffuse = body * (1.0 - fo) + diffuseLight * (0.9 * fo);
    let Tm = (T.x + T.y + T.z) / 3.0;
    let Fm = (F.x + F.y + F.z) / 3.0;
    let glass = min(1.0, 1.0 - Tm * (1.0 - Fm) * (1.0 - fo));
    let alpha = glass + (1.0 - glass) * m;
    out.color = vec4<f32>(min((diffuse * (vec3<f32>(1.0) - F) * (1.0 - m) + spec + env) * u_fluid.u_preExposure,
                              vec3<f32>(32768.0)), alpha);
    out.depth = vec4<f32>(b * dlen * alpha, 0.0, 0.0, alpha);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> TraceOutput {
    var out: TraceOutput;
    out.color = vec4<f32>(0.0);
    out.depth = vec4<f32>(0.0);
    let uv = (in.position.xy + u_fluid.u_traceJitter) / u_fluid.u_targetSize;
    // The view ray as a segment from the near plane to the far plane, parameterised t in 0..1. Valid
    // for perspective and orthographic cameras alike.
    let o = unproject(uv, 0.0);
    let d = unproject(uv, 1.0) - o;
    let dlen = length(d);
    // Where opaque geometry stops the ray, on the same parameter.
    let sceneDepth = textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0);
    let tScene = select(dot(unproject(uv, sceneDepth) - o, d) / max(dot(d, d), 1e-20), 1.0, sceneDepth >= 1.0);

    // Into the unit box, and slab-clip there.
    let inv = u_fluid.u_volumeInvModel;
    let lo = (inv * vec4<f32>(o, 1.0)).xyz;
    let ld = (inv * vec4<f32>(d, 0.0)).xyz;
    let safe = select(ld, vec3<f32>(1e-9), abs(ld) < vec3<f32>(1e-9));
    let a = (vec3<f32>(-0.5) - lo) / safe;
    let b = (vec3<f32>(0.5) - lo) / safe;
    let tmin = min(a, b);
    let tmax = max(a, b);
    let t0 = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    let t1 = min(min(min(tmax.x, tmax.y), tmax.z), tScene);
    if (t1 <= t0) { return out; }

    // One step is `stepScale` voxels long, whatever the box's aspect and the ray's direction.
    let voxelsPerT = length(ld * u_fluid.u_voxels);
    let stepVox = max(u_fluid.u_stepScale, 0.05);
    let dt = stepVox / max(voxelsPerT, 1e-6);
    let jitter = fract(ign(in.position.xy) + f32(u_fluid.u_jitterSlot) * 0.61803398875);
    if (u_fluid.u_shading == 1) {
        // A surface wants finer steps than a gas: half a voxel at most.
        return liquid_trace(lo, ld, safe, t0, t1, min(dt, 0.5 / max(voxelsPerT, 1e-6)), dlen, jitter);
    }
    var t = t0 + dt * jitter;
    let sun = u_fluid.u_sunColor * INV_PI;
    let smoke = u_fluid.u_smokeColor;
    // Scattering angle: between the ray and the direction toward the light, in the box's frame.
    let cos_theta = dot(normalize(ld), u_fluid.u_sunDir);
    let plain = u_fluid.u_anisotropy == 0.0 && u_fluid.u_scatterOctaves <= 1;
    var glow_rgb = vec3<f32>(1.0, 0.5, 0.15);
    if (u_fluid.u_hasLut != 0) {
        glow_rgb = textureSampleLevel(u_fireLut_texture, u_fireLut_sampler, vec2<f32>(0.5, 0.5), 0.0).rgb;
    }
    let detail_s = u_fluid.u_detailScale / 10.0;

    let kx = u_fluid.u_absorptionScale;
    var T = vec3<f32>(1.0);
    var col = vec3<f32>(0.0);
    var depthSum = 0.0;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= t1 || max(max(T.x, T.y), T.z) <= 0.003) { break; }
        let uvw = lo + ld * t + vec3<f32>(0.5);
        // Empty-space skipping: jump to where the ray leaves this brick.
        if (brick_empty(uvw)) {
            let bmin = floor(uvw * u_fluid.u_bricks) / u_fluid.u_bricks;
            let bmax = bmin + vec3<f32>(1.0) / u_fluid.u_bricks;
            let q0 = (bmin - vec3<f32>(0.5) - lo) / safe;
            let q1 = (bmax - vec3<f32>(0.5) - lo) / safe;
            let exitT = min(min(max(q0.x, q1.x), max(q0.y, q1.y)), max(q0.z, q1.z));
            // Re-enter on the step grid, so skipping never changes where samples land.
            t = t + max(ceil((exitT - t) / dt), 1.0) * dt;
            continue;
        }
        var s: vec4<f32>;
        if (u_fluid.u_smoothSampling != 0) { s = sample_smooth(uvw); } else { s = sample_volume(uvw); }
        if (u_fluid.u_detailStrength > 0.0) {
            var n = 0.0;
            if (u_fluid.u_hasDetail != 0) {
                // The noise rides the flow: sample it where this gas came from, two sets cross-faded.
                let ca = textureSampleLevel(u_detailA_texture, u_detailA_sampler, uvw, 0.0).xyz;
                let cb = textureSampleLevel(u_detailB_texture, u_detailB_sampler, uvw, 0.0).xyz;
                n = mix(value_noise(cb * detail_s), value_noise(ca * detail_s), u_fluid.u_detailBlend);
            } else {
                let pv = uvw * u_fluid.u_voxels;
                n = value_noise(vec3<f32>(pv.x * detail_s, pv.y * detail_s - u_fluid.u_time * 1.5, pv.z * detail_s));
            }
            s.r = s.r * max(0.0, 1.0 - u_fluid.u_detailStrength * n);
        }
        // Density contrast: thinner below half a unit, denser above.
        if (u_fluid.u_sharpen > 0.0 && s.r > 0.0) { s.r = s.r * min(4.0, pow(s.r / 0.5, u_fluid.u_sharpen)); }
        let e = clamp((s.g - u_fluid.u_ignition) / max(u_fluid.u_emissionRange, 1e-4), 0.0, 1.0);
        if (s.r > 1e-4 || e > 0.0) {
            let aSmoke = vec3<f32>(1.0) - exp(-max(s.r, 0.0) * u_fluid.u_absorption * stepVox * kx);
            // The fire hides what is behind it by its opacity, and gives light by FIRE_EMIT, independently.
            var aFire = 0.0;
            var aEmit = 0.0;
            if (e > 0.0) {
                aFire = 1.0 - exp(-e * u_fluid.u_emission * u_fluid.u_fireOpacity * stepVox);
                aEmit = 1.0 - exp(-e * u_fluid.u_emission * FIRE_EMIT * stepVox);
            }
            // The sunlight reaching here crossed the smoke toward the sun: tinted by it too.
            let tl = max(clamp(s.b, 0.0, 1.0), 1e-6);
            var sunShare = vec3<f32>(pow(tl, kx.x), pow(tl, kx.y), pow(tl, kx.z));
            if (!plain) { sunShare = vec3<f32>(sun_scatter(sunShare.x, cos_theta), sun_scatter(sunShare.y, cos_theta), sun_scatter(sunShare.z, cos_theta)); }
            // Beer-Powder: thin sunlit edges of dense smoke read darker than Beer's law alone.
            if (u_fluid.u_powder > 0.0) {
                sunShare = sunShare * (1.0 - u_fluid.u_powder + u_fluid.u_powder * (1.0 - exp(-2.0 * max(s.r, 0.0) * u_fluid.u_absorption)));
            }
            // Sky occlusion: the gas above (three taps up the box) shades the sky light reaching here.
            var sky = 1.0;
            if (u_fluid.u_skyOcclusion > 0.0) {
                let up = vec3<f32>(0.0, 1.0 / max(u_fluid.u_voxels.y, 1.0), 0.0);
                let above = sample_volume(uvw + up * 2.0).r + sample_volume(uvw + up * 5.0).r + sample_volume(uvw + up * 10.0).r;
                sky = 1.0 - u_fluid.u_skyOcclusion * (1.0 - exp(-u_fluid.u_absorption * 2.5 * max(above, 0.0)));
            }
            var lit = u_fluid.u_albedo * (sun * (u_fluid.u_ambient * sky + (1.0 - u_fluid.u_ambient) * sunShare) + u_fluid.u_sunAmbient * sky);
            // The fire's light on the smoke around it, at the fire's own (exposure-compensated) scale.
            lit = lit + glow_rgb * (u_fluid.u_albedo * u_fluid.u_fireGlow * u_fluid.u_emission * max(s.a, 0.0) * u_fluid.u_fireScale);
            var fire = vec3<f32>(1.0);
            if (u_fluid.u_hasLut != 0) {
                fire = textureSampleLevel(u_fireLut_texture, u_fireLut_sampler, vec2<f32>((e * 255.0 + 0.5) / 256.0, 0.5), 0.0).rgb;
            }
            // Soot masking: fire inside dense smoke is dimmed by it, so glow shows through the gaps.
            var soot = 1.0;
            if (u_fluid.u_sootMask > 0.0) { soot = exp(-u_fluid.u_sootMask * max(s.r, 0.0) * u_fluid.u_absorption); }
            let fireK = u_fluid.u_emission * u_fluid.u_fireScale * u_fluid.u_fireIntensity;
            var glow = fire * (e * fireK * soot);
            // The blue core: the reaction zone (packed as negative A), hidden behind soot.
            if (u_fluid.u_blueCore > 0.0 && s.a < 0.0) {
                let bc = -s.a * exp(-2.0 * max(s.r, 0.0) * u_fluid.u_absorption);
                glow = glow + u_fluid.u_blueCoreColor * (u_fluid.u_blueCore * bc * fireK);
            }
            let Tm = (T.x + T.y + T.z) / 3.0;
            let contribution = Tm * (1.0 - (1.0 - (aSmoke.x + aSmoke.y + aSmoke.z) / 3.0) * (1.0 - aFire));
            // What the smoke scatters is grey (its mean extinction); the tint is in what it absorbs.
            let aScat = (aSmoke.x + aSmoke.y + aSmoke.z) / 3.0;
            col = col + T * (aScat * smoke * lit + aEmit * glow);
            depthSum = depthSum + contribution * t * dlen;
            T = T * (vec3<f32>(1.0) - aSmoke) * (1.0 - aFire);
        }
        t = t + dt;
    }
    let alpha = 1.0 - (T.x + T.y + T.z) / 3.0;
    out.color = vec4<f32>(min(col * u_fluid.u_preExposure, vec3<f32>(32768.0)), alpha);
    // Coverage-weighted distance from the near plane, premultiplied like the colour.
    out.depth = vec4<f32>(depthSum, 0.0, 0.0, alpha);
    return out;
}
