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
//   - two volumes (the previous and current simulation frame) blended, so playback is smooth between
//     simulation frames;
//   - an occupancy grid of 8^3 bricks: empty bricks are crossed in one jump.
//
// Two outputs, both PREMULTIPLIED for the renderer's ONE / ONE_MINUS_SRC_ALPHA "over": colour with
// coverage alpha, and the coverage-weighted distance along the ray (r) with the same alpha, which the
// temporal resolve reprojects through and the composite tests against the full-resolution depth.
//
// No discard and no implicit derivatives: a miss returns zero, and every fetch is explicit-level.

const MAX_STEPS: i32 = 384;
const INV_PI: f32 = 0.31830988618;
const BRICK: f32 = 8.0;

@group(0) @binding(0) var u_sceneDepth_texture: texture_depth_2d;   // opaque depth snapshot
@group(0) @binding(1) var u_sceneDepth_sampler: sampler;
@group(0) @binding(2) var u_volume_texture: texture_3d<f32>;        // R density, G temperature, B light, A fire glow
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
    u_scatterOctaves: i32,
    u_hasDetail: i32,
    u_jitterSlot: i32,
    u_hasLut: i32,
    u_hasOccupancy: i32,
};
@group(1) @binding(4) var<uniform> u_volume: FluidVolumeUniforms;

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
    let w = u_volume.u_invViewProj * vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
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
    for (var k = 0; k < max(1, u_volume.u_scatterOctaves); k = k + 1) {
        sum = sum + a * pow(t, b) * phase_scale(cos_theta, u_volume.u_anisotropy * c);
        a = a * 0.5; b = b * 0.5; c = c * 0.5;
    }
    return sum;
}

fn sample_volume(uvw: vec3<f32>) -> vec4<f32> {
    let cur = textureSampleLevel(u_volume_texture, u_volume_sampler, uvw, 0.0);
    if (u_volume.u_blend >= 1.0) { return cur; }
    let prev = textureSampleLevel(u_prevVolume_texture, u_prevVolume_sampler, uvw, 0.0);
    return mix(prev, cur, u_volume.u_blend);
}

/** True when the brick around `uvw` holds nothing. */
fn brick_empty(uvw: vec3<f32>) -> bool {
    if (u_volume.u_hasOccupancy == 0) { return false; }
    let b = clamp(vec3<i32>(floor(uvw * u_volume.u_bricks)), vec3<i32>(0), vec3<i32>(u_volume.u_bricks) - vec3<i32>(1));
    return textureLoad(u_occupancy_texture, b, 0).r <= 0.0;
}

@fragment
fn fs_main(in: VertexOutput) -> TraceOutput {
    var out: TraceOutput;
    out.color = vec4<f32>(0.0);
    out.depth = vec4<f32>(0.0);
    let uv = (in.position.xy + u_volume.u_traceJitter) / u_volume.u_targetSize;
    // The view ray as a segment from the near plane to the far plane, parameterised t in 0..1. Valid
    // for perspective and orthographic cameras alike.
    let o = unproject(uv, 0.0);
    let d = unproject(uv, 1.0) - o;
    let dlen = length(d);
    // Where opaque geometry stops the ray, on the same parameter.
    let sceneDepth = textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0);
    let tScene = select(dot(unproject(uv, sceneDepth) - o, d) / max(dot(d, d), 1e-20), 1.0, sceneDepth >= 1.0);

    // Into the unit box, and slab-clip there.
    let inv = u_volume.u_volumeInvModel;
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
    let voxelsPerT = length(ld * u_volume.u_voxels);
    let stepVox = max(u_volume.u_stepScale, 0.05);
    let dt = stepVox / max(voxelsPerT, 1e-6);
    let jitter = fract(ign(in.position.xy) + f32(u_volume.u_jitterSlot) * 0.61803398875);
    var t = t0 + dt * jitter;
    let sun = u_volume.u_sunColor * INV_PI;
    let smoke = u_volume.u_smokeColor;
    // Scattering angle: between the ray and the direction toward the light, in the box's frame.
    let cos_theta = dot(normalize(ld), u_volume.u_sunDir);
    let plain = u_volume.u_anisotropy == 0.0 && u_volume.u_scatterOctaves <= 1;
    var glow_rgb = vec3<f32>(1.0, 0.5, 0.15);
    if (u_volume.u_hasLut != 0) {
        glow_rgb = textureSampleLevel(u_fireLut_texture, u_fireLut_sampler, vec2<f32>(0.5, 0.5), 0.0).rgb;
    }
    let detail_s = u_volume.u_detailScale / 10.0;

    var T = 1.0;
    var col = vec3<f32>(0.0);
    var depthSum = 0.0;
    for (var i: i32 = 0; i < MAX_STEPS; i = i + 1) {
        if (t >= t1 || T <= 0.003) { break; }
        let uvw = lo + ld * t + vec3<f32>(0.5);
        // Empty-space skipping: jump to where the ray leaves this brick.
        if (brick_empty(uvw)) {
            let bmin = floor(uvw * u_volume.u_bricks) / u_volume.u_bricks;
            let bmax = bmin + vec3<f32>(1.0) / u_volume.u_bricks;
            let q0 = (bmin - vec3<f32>(0.5) - lo) / safe;
            let q1 = (bmax - vec3<f32>(0.5) - lo) / safe;
            let exitT = min(min(max(q0.x, q1.x), max(q0.y, q1.y)), max(q0.z, q1.z));
            // Re-enter on the step grid, so skipping never changes where samples land.
            t = t + max(ceil((exitT - t) / dt), 1.0) * dt;
            continue;
        }
        var s = sample_volume(uvw);
        if (u_volume.u_detailStrength > 0.0) {
            var n = 0.0;
            if (u_volume.u_hasDetail != 0) {
                // The noise rides the flow: sample it where this gas came from, two sets cross-faded.
                let ca = textureSampleLevel(u_detailA_texture, u_detailA_sampler, uvw, 0.0).xyz;
                let cb = textureSampleLevel(u_detailB_texture, u_detailB_sampler, uvw, 0.0).xyz;
                n = mix(value_noise(cb * detail_s), value_noise(ca * detail_s), u_volume.u_detailBlend);
            } else {
                let pv = uvw * u_volume.u_voxels;
                n = value_noise(vec3<f32>(pv.x * detail_s, pv.y * detail_s - u_volume.u_time * 1.5, pv.z * detail_s));
            }
            s.r = s.r * max(0.0, 1.0 - u_volume.u_detailStrength * n);
        }
        let e = clamp((s.g - u_volume.u_ignition) / max(u_volume.u_emissionRange, 1e-4), 0.0, 1.0);
        if (s.r > 1e-4 || e > 0.0) {
            let aSmoke = 1.0 - exp(-max(s.r, 0.0) * u_volume.u_absorption * stepVox);
            var aFire = 0.0;
            if (e > 0.0) { aFire = 1.0 - exp(-e * u_volume.u_emission * u_volume.u_fireOpacity * stepVox); }
            let tl = clamp(s.b, 0.0, 1.0);
            var sunShare = tl;
            if (!plain) { sunShare = sun_scatter(tl, cos_theta); }
            // Beer-Powder: thin sunlit edges of dense smoke read darker than Beer's law alone.
            if (u_volume.u_powder > 0.0) {
                sunShare = sunShare * (1.0 - u_volume.u_powder + u_volume.u_powder * (1.0 - exp(-2.0 * max(s.r, 0.0) * u_volume.u_absorption)));
            }
            // Sky occlusion: the gas above (three taps up the box) shades the sky light reaching here.
            var sky = 1.0;
            if (u_volume.u_skyOcclusion > 0.0) {
                let up = vec3<f32>(0.0, 1.0 / max(u_volume.u_voxels.y, 1.0), 0.0);
                let above = sample_volume(uvw + up * 2.0).r + sample_volume(uvw + up * 5.0).r + sample_volume(uvw + up * 10.0).r;
                sky = 1.0 - u_volume.u_skyOcclusion * (1.0 - exp(-u_volume.u_absorption * 2.5 * max(above, 0.0)));
            }
            var lit = u_volume.u_albedo * (sun * (u_volume.u_ambient * sky + (1.0 - u_volume.u_ambient) * sunShare) + u_volume.u_sunAmbient * sky);
            // The fire's light on the smoke around it, at the fire's own (exposure-compensated) scale.
            lit = lit + glow_rgb * (u_volume.u_albedo * u_volume.u_fireGlow * u_volume.u_emission * max(s.a, 0.0) * u_volume.u_fireScale);
            var fire = vec3<f32>(1.0);
            if (u_volume.u_hasLut != 0) {
                fire = textureSampleLevel(u_fireLut_texture, u_fireLut_sampler, vec2<f32>((e * 255.0 + 0.5) / 256.0, 0.5), 0.0).rgb;
            }
            let glow = fire * (u_volume.u_emission * e * u_volume.u_fireScale * u_volume.u_fireIntensity);
            let contribution = T * (1.0 - (1.0 - aSmoke) * (1.0 - aFire));
            col = col + T * (aSmoke * smoke * lit + aFire * glow);
            depthSum = depthSum + contribution * t * dlen;
            T = T * (1.0 - aSmoke) * (1.0 - aFire);
        }
        t = t + dt;
    }
    let alpha = 1.0 - T;
    out.color = vec4<f32>(col, alpha);
    // Coverage-weighted distance from the near plane, premultiplied like the colour.
    out.depth = vec4<f32>(depthSum, 0.0, 0.0, alpha);
    return out;
}
