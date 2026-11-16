// The WATER SURFACE of a Water node (core/scene/nodes/waterVolumeNode.ts), drawn by render/water.ts.
//
// One tile of the node's surface per draw: a grid in 0..1 (x, z) placed over `u_tile`, its height read
// from the node's WATER INFO (water/waterInfo.ts: resting surface, flow, shore distance, wave share, foam,
// bed) and lifted by the node's Gerstner waves, the same sum physics/water/gerstner.ts evaluates on the
// CPU, so a floating body rides exactly this surface. Vertices with y = -1 are the tile's SKIRT, hung
// below the edge so neighbouring tiles of different density never show a crack.
//
// Shading is single-layer water: what is under the surface comes from the opaque scene's colour copy
// (refracted), dimmed and tinted by Beer-Lambert absorption over the true thickness of water the view ray
// crosses (from the opaque depth snapshot) and lit by in-scattering; caustics play on the bed; the
// surface reflects the sky or environment cube with the screen-space march over it; foam gathers along
// the shore, on breaking crests and where the current tumbles; rain rings it, snow settles as slush and
// ice on still water, and the wind roughens it. Everything is drawn over the resolved image, after TAA,
// like the transparents, so nothing here jitters.
//
// No implicit derivatives (every fetch is explicit-level), so the module translates to GLSL as it is.

const PI: f32 = 3.14159265;
const MAX_WAVES: i32 = 8;
const MAX_REFLECTION_LOD: f32 = 4.0;

@group(0) @binding(0) var u_sceneDepth_texture: texture_depth_2d;   // opaque depth snapshot
@group(0) @binding(1) var u_sceneDepth_sampler: sampler;
@group(0) @binding(2) var u_sceneColor_texture: texture_2d<f32>;    // opaque colour copy (pre-exposed)
@group(0) @binding(3) var u_sceneColor_sampler: sampler;
@group(0) @binding(4) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(5) var u_envMap_sampler: sampler;
@group(0) @binding(6) var u_info0_texture: texture_3d<f32>;         // surface, flow x, flow z, shore distance
@group(0) @binding(7) var u_info0_sampler: sampler;
@group(0) @binding(8) var u_info1_texture: texture_3d<f32>;         // wave share, foam, bed, wet
@group(0) @binding(9) var u_info1_sampler: sampler;

// Vertex stage ONLY (a block read from both stages is a GLSL link error).
struct WaterVertexUniforms {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_tile: vec4<f32>,            // x0, z0, size (m), skirt depth (m)
    u_vInfoOrigin: vec4<f32>,     // origin x, origin z, cell (m), 1 = has an info grid
    u_vInfoSize: vec4<f32>,       // cells x, cells z, height base (m: the grid's heights are stored above it)
    u_vOcean: vec4<f32>,          // level, 1 = an endless ocean covers what the grid does not
    u_waveDir: array<vec4<f32>, 8>,    // dir x, dir z, amplitude (m), wavelength (m)
    u_wavePhase: array<vec4<f32>, 8>,  // steepness, phase
    u_waveParams: vec4<f32>,      // count, time (s), height scale, shore fade (m)
    u_swell: vec4<f32>,           // amplitude (m), frequency (Hz)
    u_vCamera: vec4<f32>,         // camera position, distance (m) over which the waves fade out
};
@group(1) @binding(0) var<uniform> u_wv: WaterVertexUniforms;

// Fragment stage ONLY.
struct WaterFragmentUniforms {
    u_shallowColor: vec4<f32>,    // rgb, turbidity
    u_deepColor: vec4<f32>,       // rgb, clarity (m)
    u_absorption: vec4<f32>,      // rgb per metre, roughness
    u_foamColor: vec4<f32>,       // rgb, shore foam width (m)
    u_foamParams: vec4<f32>,      // crest foam, flow foam, caustics, caustics scale (m)
    u_surfaceParams: vec4<f32>,   // reflectivity, screen reflections, refraction (m), detail strength
    u_detailParams: vec4<f32>,    // detail scale (m), flow strength, rain ripples, snow cover
    u_windParams: vec4<f32>,      // wind dir x, dir z, speed (m/s), wind response
    u_underwater: vec4<f32>,      // rgb, fog per metre
    u_sunDir: vec4<f32>,          // toward the key light
    u_sunColor: vec4<f32>,        // its illuminance
    u_ambient: vec4<f32>,         // ambient irradiance
    u_viewPos: vec4<f32>,         // camera, time (s)
    u_depthParams: vec4<f32>,     // near, far, 1 = orthographic
    u_resolution: vec4<f32>,      // w, h, 1/w, 1/h
    u_fView: mat4x4<f32>,
    u_ssrProjection: mat4x4<f32>, // view -> clip, flipped onto screen uvs
    u_ssrParams: vec4<f32>,       // steps, thickness, max distance, 1 = on
    u_envScale: vec4<f32>,        // rgb scale, mode (0 none, 1 sRGB cube, 2 linear sky cube)
    u_fInfoOrigin: vec4<f32>,
    u_fInfoSize: vec4<f32>,
    u_fOcean: vec4<f32>,
    u_misc: vec4<f32>,            // pre-exposure, weather clock, 1 = camera under the surface
};
@group(1) @binding(1) var<uniform> u_wf: WaterFragmentUniforms;

// The weather volumes, as render/weather.ts uploads them to every program declaring `u_weatherInfo`.
struct WaterWeatherUniforms {
    u_weatherInv: array<mat4x4<f32>, 4>,
    u_weatherBlend: array<vec4<f32>, 4>,
    u_weatherAmount: array<vec4<f32>, 4>,
    u_weatherShape: array<vec4<f32>, 4>,
    u_weatherInfo: vec4<f32>,
    u_snowColor: vec4<f32>,
};
@group(1) @binding(2) var<uniform> u_ww: WaterWeatherUniforms;

fn weatherCount() -> i32 { return i32(u_ww.u_weatherInfo.x); }
fn weatherInv(i: i32) -> mat4x4<f32> { return u_ww.u_weatherInv[i]; }
fn weatherBlend(i: i32) -> vec4<f32> { return u_ww.u_weatherBlend[i]; }
fn weatherAmount(i: i32) -> vec4<f32> { return u_ww.u_weatherAmount[i]; }
fn weatherShape(i: i32) -> vec4<f32> { return u_ww.u_weatherShape[i]; }

#include "./chunks/weatherVolumes.wgsl"

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    /** Undisplaced x, z (where the surface point rests), and how compressed the waves are there (foam). */
    @location(2) rest: vec3<f32>,
    /** 1 on the tile's skirt, 0 on its surface. */
    @location(3) skirt: f32,
};

// ---- the water info --------------------------------------------------------------------------------

fn infoUvw(xz: vec2<f32>, origin: vec4<f32>, size: vec4<f32>) -> vec3<f32> {
    let c = (xz - origin.xy) / origin.z + vec2<f32>(0.5);
    return vec3<f32>(c.x / size.x, c.y / size.y, 0.5);
}

fn insideInfo(uvw: vec3<f32>) -> bool {
    return all(uvw.xy >= vec2<f32>(0.0)) && all(uvw.xy <= vec2<f32>(1.0));
}

// ---- Gerstner waves (physics/water/gerstner.ts gerstnerDisplacement, operation for operation) -----------

struct Wave { offset: vec3<f32>, normal: vec3<f32>, compress: f32 };

fn gerstner(x: f32, z: f32, t: f32, scale: f32) -> Wave {
    var w: Wave;
    w.offset = vec3<f32>(0.0);
    var nx = 0.0;
    var nz = 0.0;
    var ny = 0.0;
    let count = min(i32(u_wv.u_waveParams.x), MAX_WAVES);
    let n = f32(max(count, 1));
    for (var i = 0; i < MAX_WAVES; i++) {
        if (i >= count) { break; }
        let d = u_wv.u_waveDir[i];
        let ph = u_wv.u_wavePhase[i];
        let k = 6.283185307179586 / max(0.01, d.w);
        let omega = sqrt(9.81 * k);
        let a = d.z * scale;
        let theta = k * (d.x * x + d.y * z) - omega * t + ph.y;
        var q = 0.0;
        if (a > 0.0) { q = ph.x / (k * a * n); }
        let c = cos(theta);
        let s = sin(theta);
        w.offset += vec3<f32>(q * a * d.x * c, a * s, q * a * d.y * c);
        let wa = k * a;
        nx += d.x * wa * c;
        nz += d.y * wa * c;
        ny += q * wa * s;
    }
    w.normal = normalize(vec3<f32>(-nx, 1.0 - ny, -nz));
    w.compress = ny;
    return w;
}

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    let tile = u_wv.u_tile;
    let xz = tile.xy + position.xz * tile.z;
    var surface = u_wv.u_vOcean.x;
    var edge = 1e4;
    var share = 1.0;
    let uvw = infoUvw(xz, u_wv.u_vInfoOrigin, u_wv.u_vInfoSize);
    if (u_wv.u_vInfoOrigin.w > 0.5 && (insideInfo(uvw) || u_wv.u_vOcean.y < 0.5)) {
        let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);
        let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);
        surface = i0.x + u_wv.u_vInfoSize.z;
        edge = i0.w;
        share = i1.x;
    }
    // Shoaling: the waves die down toward the shore, as the CPU's waveHeight fades them.
    let fade = select(1.0, clamp(edge / max(u_wv.u_waveParams.w, 1e-3), 0.0, 1.0), u_wv.u_waveParams.w > 0.0);
    // Far tiles drop their waves (LOD): beyond the fade distance nothing moves there worth the cost.
    let dist = distance(u_wv.u_vCamera.xz, xz);
    let far = 1.0 - smoothstep(u_wv.u_vCamera.w * 0.6, u_wv.u_vCamera.w, dist);
    let scale = u_wv.u_waveParams.z * share * fade * fade * (3.0 - 2.0 * fade) * far;
    let t = u_wv.u_waveParams.y;
    let wave = gerstner(xz.x, xz.y, t, scale);
    var p = vec3<f32>(xz.x, surface, xz.y) + wave.offset;
    if (u_wv.u_swell.x > 0.0) {
        p.y += u_wv.u_swell.x * sin(t * u_wv.u_swell.y * PI * 2.0 + xz.x * 0.37 + xz.y * 0.29);
    }
    // The skirt hangs straight down from the edge.
    p.y -= max(0.0, -position.y) * tile.w;
    out.worldPos = p;
    out.normal = wave.normal;
    out.rest = vec3<f32>(xz, wave.compress);
    out.skirt = max(0.0, -position.y);
    out.position = u_wv.u_projection * u_wv.u_view * vec4<f32>(p, 1.0);
    return out;
}

// ---- fragment helpers -----------------------------------------------------------------------------

fn linearDepth(d: f32) -> f32 {
    let n = u_wf.u_depthParams.x;
    let f = u_wf.u_depthParams.y;
    if (u_wf.u_depthParams.z > 0.5) { return n + d * (f - n); }
    let z = d * 2.0 - 1.0;
    return 2.0 * n * f / (f + n - z * (f - n));
}

fn sceneDepthAt(uv: vec2<f32>) -> f32 {
    return linearDepth(textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0));
}

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash12(i);
    let b = hash12(i + vec2<f32>(1.0, 0.0));
    let c = hash12(i + vec2<f32>(0.0, 1.0));
    let d = hash12(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * The gradient of the small ripples at `p` (metres): eight directional wavelets of falling size, spread
 * round the compass and leaning downwind. Their slope, not their height, is all the shading needs.
 */
fn detailGradient(p: vec2<f32>, t: f32, scale: f32, windDir: vec2<f32>) -> vec2<f32> {
    var g = vec2<f32>(0.0);
    let base = atan2(windDir.y, windDir.x);
    for (var i = 0; i < 8; i++) {
        let fi = f32(i);
        let ang = base + (hash12(vec2<f32>(fi, 3.7)) - 0.5) * 2.4;
        let dir = vec2<f32>(cos(ang), sin(ang));
        let len = scale * pow(0.72, fi);
        let k = 6.283185 / len;
        let omega = sqrt(9.81 * k);
        let amp = 0.035 * len;
        let th = k * dot(dir, p) - omega * t + hash12(vec2<f32>(fi, 9.1)) * 6.283;
        g += dir * (k * amp * cos(th));
    }
    return g;
}

/** Rings from raindrops on standing water (chunks/terrainWeather.wgsl rippleLayer's wavelets, scaled up). */
fn rainRings(xz: vec2<f32>, t: f32, density: f32) -> vec2<f32> {
    let cell = 0.35;
    let base = floor(xz / cell - 0.5);
    var grad = vec2<f32>(0.0);
    for (var j = 0; j < 4; j++) {
        let c = base + vec2<f32>(f32(j % 2), f32(j / 2));
        let key = c - floor(c / 251.0) * 251.0;
        let u = t / 0.9 + hash12(key);
        let cycle = floor(u);
        let life = u - cycle;
        let k = key + vec2<f32>(cycle * 3.17, cycle * 5.71);
        let falls = step(hash12(k), density);
        let centre = (c + 0.25 + 0.5 * vec2<f32>(hash12(k + 11.3), hash12(k + 27.9))) * cell;
        let d = xz - centre;
        let dist = length(d);
        let x = dist - life * 0.5 * cell;
        let sigma = 0.025;
        let packet = exp(-x * x / (sigma * sigma));
        let fade = (1.0 - life) * (1.0 - life) * falls;
        let dh = 0.004 * fade * packet * (180.0 * cos(180.0 * x));
        grad += dh * d / max(dist, 1e-4);
    }
    return grad;
}

/** Bright, sharp, wandering lines: the sun focused by the waves above, on whatever is under the water. */
fn causticAt(p: vec2<f32>, t: f32) -> f32 {
    var c = 0.0;
    var q = p;
    for (var i = 0; i < 3; i++) {
        let fi = f32(i);
        let a = q + vec2<f32>(sin(q.y * 1.3 + t * (0.7 + fi * 0.2)), cos(q.x * 1.1 - t * (0.6 + fi * 0.25)));
        let v = abs(sin(a.x) * sin(a.y));
        c += pow(1.0 - v, 8.0);
        q = q * 1.7 + vec2<f32>(1.3, -0.7);
    }
    return c / 3.0;
}

/** Screen-space reflection over the opaque scene (customShaders.ts `cleoScreenReflection`, ported). */
fn screenReflection(worldPos: vec3<f32>, R: vec3<f32>) -> vec4<f32> {
    if (u_wf.u_ssrParams.w < 0.5 || u_wf.u_depthParams.z > 0.5) { return vec4<f32>(0.0); }
    let origin = (u_wf.u_fView * vec4<f32>(worldPos, 1.0)).xyz;
    let dir = normalize((u_wf.u_fView * vec4<f32>(R, 0.0)).xyz);
    let farPlane = u_wf.u_depthParams.y;
    var rayLen = u_wf.u_ssrParams.z;
    if (dir.z > 1e-5) { rayLen = min(rayLen, (-u_wf.u_depthParams.x - origin.z) / dir.z * 0.99); }
    if (rayLen <= 0.0) { return vec4<f32>(0.0); }
    let endP = origin + dir * rayLen;
    let h0 = u_wf.u_ssrProjection * vec4<f32>(origin, 1.0);
    let h1 = u_wf.u_ssrProjection * vec4<f32>(endP, 1.0);
    let k0 = 1.0 / h0.w;
    let k1 = 1.0 / h1.w;
    let res = max(u_wf.u_resolution.xy, vec2<f32>(1.0));
    let s0 = (h0.xy * k0 * 0.5 + 0.5) * res;
    let s1 = (h1.xy * k1 * 0.5 + 0.5) * res;
    let q0 = origin.z * k0;
    let q1 = endP.z * k1;
    let d = s1 - s0;
    let fullLen = max(abs(d.x), abs(d.y));
    if (fullLen < 1.0) { return vec4<f32>(0.0); }
    var tEnd = 1.0;
    if (d.x > 1e-6) { tEnd = min(tEnd, (res.x - 0.5 - s0.x) / d.x); }
    if (d.x < -1e-6) { tEnd = min(tEnd, (0.5 - s0.x) / d.x); }
    if (d.y > 1e-6) { tEnd = min(tEnd, (res.y - 0.5 - s0.y) / d.y); }
    if (d.y < -1e-6) { tEnd = min(tEnd, (0.5 - s0.y) / d.y); }
    tEnd = max(tEnd, 0.0);
    let onScreen = fullLen * tEnd;
    if (onScreen < 1.0) { return vec4<f32>(0.0); }
    let steps = i32(clamp(u_wf.u_ssrParams.x * 2.0, 1.0, 96.0));
    let dt = max(1.0, onScreen / f32(steps)) / fullLen;
    var prevT = 0.0;
    var prevDepth = -1.0;
    var tLo = 0.0;
    var tHi = 0.0;
    var found = false;
    for (var i = 0; i < 96; i++) {
        if (i >= steps) { break; }
        let t = (f32(i) + 1.5) * dt;
        if (t > tEnd) { break; }
        let rayDepth = -(mix(q0, q1, t) / mix(k0, k1, t));
        let sd = sceneDepthAt((floor(s0 + d * t) + 0.5) / res);
        var lo = rayDepth;
        if (prevDepth >= 0.0) { lo = min(prevDepth, rayDepth); }
        let hi = max(prevDepth, rayDepth);
        if (sd < farPlane * 0.999 && hi >= sd && lo <= sd + u_wf.u_ssrParams.y) {
            found = true;
            tLo = prevT;
            tHi = t;
            break;
        }
        prevT = t;
        prevDepth = rayDepth;
    }
    if (!found) { return vec4<f32>(0.0); }
    for (var j = 0; j < 5; j++) {
        let mid = 0.5 * (tLo + tHi);
        let rayDepth = -(mix(q0, q1, mid) / mix(k0, k1, mid));
        let sd = sceneDepthAt((floor(s0 + d * mid) + 0.5) / res);
        if (sd < farPlane * 0.999 && rayDepth >= sd) { tHi = mid; } else { tLo = mid; }
    }
    let hitUV = (floor(s0 + d * tHi) + 0.5) / res;
    let edge = clamp(min(hitUV, vec2<f32>(1.0) - hitUV) / 0.08, vec2<f32>(0.0), vec2<f32>(1.0));
    let hitPos = mix(origin * k0, endP * k1, tHi) / mix(k0, k1, tHi);
    let fade = edge.x * edge.y
             * (1.0 - smoothstep(0.75, 1.0, length(hitPos - origin) / u_wf.u_ssrParams.z))
             * (1.0 - smoothstep(0.4, 0.9, dir.z));
    return vec4<f32>(textureSampleLevel(u_sceneColor_texture, u_sceneColor_sampler, hitUV, 0.0).rgb, fade);
}

/** The sky or environment in direction `R`, blurred by `roughness`, at the frame's pre-exposure. */
fn environment(R: vec3<f32>, roughness: f32) -> vec3<f32> {
    let mode = u_wf.u_envScale.w;
    let lod = roughness * MAX_REFLECTION_LOD;
    if (mode > 1.5) {
        return textureSampleLevel(u_envMap_texture, u_envMap_sampler, R, lod).rgb * u_wf.u_envScale.rgb;
    }
    if (mode > 0.5) {
        return pow(textureSampleLevel(u_envMap_texture, u_envMap_sampler, R, lod).rgb, vec3<f32>(2.2)) * u_wf.u_envScale.rgb;
    }
    // No cube: a sky gradient from the ambient light, so the water still reflects something sky-like.
    let up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    return u_wf.u_ambient.rgb * mix(0.4, 1.2, up) * u_wf.u_misc.x;
}

fn ggx(NoH: f32, a: f32) -> f32 {
    let a2 = a * a;
    let d = NoH * NoH * (a2 - 1.0) + 1.0;
    return a2 / max(PI * d * d, 1e-6);
}

@fragment
fn fs_main(in: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    let pre = u_wf.u_misc.x;
    let t = u_wf.u_viewPos.w;
    let cam = u_wf.u_viewPos.xyz;
    let uv = in.position.xy * u_wf.u_resolution.zw;

    // The water here.
    var surface = u_wf.u_fOcean.x;
    var flow = vec2<f32>(0.0);
    var edge = 1e4;
    var foamBake = 0.0;
    var wet = u_wf.u_fOcean.y;
    let uvw = infoUvw(in.rest.xy, u_wf.u_fInfoOrigin, u_wf.u_fInfoSize);
    let hasInfo = u_wf.u_fInfoOrigin.w > 0.5;
    // Where the grid and an endless ocean's rings overlap, the grid's tiles draw it and the ocean's step
    // aside; past the grid, the other way round. Never both, so the two never fight over the depth.
    if (hasInfo && u_wf.u_fOcean.z > 0.5 && insideInfo(uvw)) { discard; }
    if (hasInfo && u_wf.u_fOcean.z < 0.5 && u_wf.u_fOcean.y > 0.5 && !insideInfo(uvw)) { discard; }
    if (hasInfo && (insideInfo(uvw) || u_wf.u_fOcean.y < 0.5)) {
        let c = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0));
        let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, c, 0.0);
        let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, c, 0.0);
        surface = i0.x + u_wf.u_fInfoSize.z;
        flow = i0.yz;
        edge = i0.w;
        foamBake = i1.y;
        wet = i1.w;
    }
    if (wet < 0.5 || edge < -0.01) { discard; }
    // A skirt only fills the cracks between tiles out on open water; at the shore it would hang into view.
    if (in.skirt > 0.0 && edge < u_wf.u_fInfoOrigin.z * 3.0) { discard; }

    // Normal: the waves', then the ripples riding the current, the wind's roughening and the rain's rings.
    let windDir = select(vec2<f32>(0.0, 1.0), normalize(u_wf.u_windParams.xy), length(u_wf.u_windParams.xy) > 1e-4);
    let windAmount = u_wf.u_windParams.z * u_wf.u_windParams.w;
    let strength = u_wf.u_surfaceParams.w * (0.35 + min(windAmount, 15.0) * 0.08);
    let scale = u_wf.u_detailParams.x;
    // Two phases of the flow map (Vlachos), half a cycle apart, so the ripples move with the river and
    // never stretch out: each phase restarts while the other carries the look.
    let f = flow * u_wf.u_detailParams.y;
    let cycle = 2.0;
    let ph0 = fract(t / cycle);
    let ph1 = fract(t / cycle + 0.5);
    let wgt = abs(ph0 * 2.0 - 1.0);
    let g0 = detailGradient(in.rest.xy - f * ph0 * cycle, t, scale, windDir);
    let g1 = detailGradient(in.rest.xy - f * ph1 * cycle + vec2<f32>(3.7, 1.9), t, scale, windDir);
    var g = mix(g0, g1, wgt) * strength;
    let weather = precipitationAt(in.worldPos);
    let still = 1.0 - smoothstep(0.1, 0.8, length(flow));
    if (weather.x > 0.0 && u_wf.u_detailParams.z > 0.0) {
        g += rainRings(in.worldPos.xz, u_ww.u_weatherInfo.y, weather.x * 0.8) * u_wf.u_detailParams.z;
    }
    var N = normalize(in.normal + vec3<f32>(-g.x, 0.0, -g.y));
    if (!front) { N = -N; }
    let toCam = cam - in.worldPos;
    let viewDist = length(toCam);
    let V = toCam / max(viewDist, 1e-4);
    let NoV = clamp(dot(N, V), 1e-3, 1.0);
    var roughness = clamp(u_wf.u_absorption.w + min(windAmount, 20.0) * 0.004, 0.02, 1.0);

    // Snow on still water: slush, then ice where it lies long enough (the weather's snow amount).
    let snowAt = weatherAt(in.worldPos).snow;
    let ice = clamp(snowAt * u_wf.u_detailParams.w * still * 1.4 - 0.2, 0.0, 1.0);
    roughness = mix(roughness, 0.35, ice);

    // How much water the view ray crosses before the bed: the opaque depth behind, less this surface.
    let fragDepth = -(u_wf.u_fView * vec4<f32>(in.worldPos, 1.0)).z;
    let toPath = viewDist / max(fragDepth, 1e-3);
    let refractStrength = u_wf.u_surfaceParams.z;
    let behind0 = sceneDepthAt(uv);
    let thick0 = max(0.0, behind0 - fragDepth) * toPath;
    // Refraction: bend the lookup by the surface slope, less in thin water, never onto something IN FRONT.
    var ruv = uv + N.xz * refractStrength * clamp(thick0, 0.0, 2.0) / max(fragDepth, 1.0) * 0.5;
    ruv = clamp(ruv, vec2<f32>(0.0), vec2<f32>(1.0));
    var behind = sceneDepthAt(ruv);
    if (behind < fragDepth) { ruv = uv; behind = behind0; }
    let farScene = behind >= u_wf.u_depthParams.y * 0.999;
    var thickness = max(0.0, behind - fragDepth) * toPath;
    if (farScene) { thickness = 1e3; }
    if (!front) { thickness = 0.0; }
    let refracted = textureSampleLevel(u_sceneColor_texture, u_sceneColor_sampler, ruv, 0.0).rgb;

    // Absorption and scattering (Beer-Lambert): murky water scatters back long before it reaches the bed.
    let turbidity = u_wf.u_shallowColor.w;
    let clarity = max(u_wf.u_deepColor.w, 0.05);
    let sigma = u_wf.u_absorption.rgb * (1.0 + turbidity * 3.0) + vec3<f32>(turbidity / clarity + 0.15 / clarity);
    let transmit = exp(-sigma * thickness);
    let sunUp = max(u_wf.u_sunDir.y, 0.0);
    let lightIn = (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * sunUp * 0.6) * pre;
    let scatter = mix(u_wf.u_shallowColor.rgb, u_wf.u_deepColor.rgb, clamp(1.0 - exp(-thickness / clarity), 0.0, 1.0)) * lightIn;
    // Caustics on the bed, as deep as the sun reaches: the bed's own colour brightened where the waves
    // above focus the sun on it.
    var caustic = vec3<f32>(0.0);
    if (u_wf.u_foamParams.z > 0.0 && !farScene && front) {
        let bed = cam - V * (behind * toPath);
        let below = max(0.0, surface - bed.y);
        let cScale = max(u_wf.u_foamParams.w, 0.05);
        let c = causticAt(bed.xz / cScale * 2.0 + flow * t * 0.3, t * 0.8);
        caustic = vec3<f32>(c * u_wf.u_foamParams.z * 1.5 * sunUp) * exp(-sigma * below) * smoothstep(0.0, 0.3, below);
    }
    let under = refracted * (vec3<f32>(1.0) + caustic) * transmit + scatter * (vec3<f32>(1.0) - transmit);

    // Reflection: the screen-space march where it finds something, the sky or environment cube under it.
    let R = reflect(-V, N);
    var reflected = environment(R, roughness);
    let ssr = screenReflection(in.worldPos, R);
    reflected = mix(reflected, ssr.rgb, ssr.a * u_wf.u_surfaceParams.y);
    let F0 = u_wf.u_surfaceParams.x;
    var F = F0 + (1.0 - F0) * pow(1.0 - NoV, 5.0);
    // Thin water at the shore barely reflects, so the shoreline fades instead of drawing a hard line.
    F *= smoothstep(0.0, 0.08, thickness + select(0.0, 1.0, !front));
    // The sun's glint.
    let L = u_wf.u_sunDir.xyz;
    let H = normalize(L + V);
    let NoL = max(dot(N, L), 0.0);
    let a = max(roughness * roughness, 0.002);
    let spec = u_wf.u_sunColor.rgb * pre * ggx(max(dot(N, H), 0.0), a) * F * NoL * 0.25 / max(NoV, 0.05);

    var color = mix(under, reflected, F) + spec;

    // Foam: along the shore (and in thin water), on breaking crests, and where the current tumbles.
    let shoreW = u_wf.u_foamColor.w;
    let fn0 = valueNoise(in.rest.xy * 1.7 - flow * t * 0.6 + vec2<f32>(t * 0.05, 0.0));
    let fn1 = valueNoise(in.rest.xy * 4.3 + flow * t * 0.3);
    let foamTex = smoothstep(0.35, 0.75, fn0 * 0.6 + fn1 * 0.4);
    var foam = 0.0;
    if (shoreW > 0.0) {
        let near = min(edge, thickness * 2.0);
        let band = 1.0 - smoothstep(0.0, shoreW, near);
        // Surf lines that run in toward the shore.
        let surf = 0.5 + 0.5 * sin(edge * 2.2 - t * 1.6 + fn0 * 3.0);
        foam = max(foam, band * mix(0.6, 1.0, surf));
    }
    foam = max(foam, smoothstep(0.35, 0.9, in.rest.z) * u_wf.u_foamParams.x);
    foam = max(foam, foamBake * u_wf.u_foamParams.y);
    foam = clamp(foam * foamTex * 1.2, 0.0, 1.0);
    let foamLit = u_wf.u_foamColor.rgb * (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * NoL) * pre * 0.32;
    color = mix(color, foamLit, foam * select(0.0, 1.0, front));

    // Ice and slush: snow-coloured, lit, the water's own look gone under it.
    let snowColor = select(vec3<f32>(0.9, 0.92, 0.95), u_ww.u_snowColor.rgb, u_ww.u_snowColor.a > 0.0);
    let iceLit = snowColor * (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * NoL) * pre * 0.32 + spec * 0.3;
    color = mix(color, iceLit, ice);

    // Seen from below: the underside reflects the water back (total internal reflection outside Snell's
    // window), and what lies above shows through the window, fogged by the water in between.
    if (!front) {
        let cosT = clamp(dot(-N, V), 0.0, 1.0);
        let window = smoothstep(0.62, 0.70, cosT);
        let fogged = u_wf.u_underwater.rgb * lightIn;
        color = mix(fogged, refracted, window);
    }
    return vec4<f32>(min(color, vec3<f32>(32768.0)), 1.0);
}
