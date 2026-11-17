// The WATER SURFACE of a Water node (core/scene/nodes/waterVolumeNode.ts), drawn by render/water.ts.
//
// One tile of the node's surface per draw: a grid in 0..1 (x, z) placed over `u_tile`, its height read
// from the node's WATER INFO (water/waterInfo.ts: resting surface, flow, shore distance, wave share, foam,
// bed) and lifted by the node's Gerstner waves, the same sum physics/water/gerstner.ts evaluates on the
// CPU, so a floating body rides exactly this surface. Vertices with y = -1 are the tile's SKIRT, hung
// below the edge so neighbouring tiles of different density never show a crack. An endless ocean's tiles
// are a CDLOD quadtree (water/oceanLod.ts): their odd vertices MORPH onto the next level's grid with
// distance, so levels meet without cracks and need no skirt, and they reach the horizon (pinned inside
// the far plane).
//
// LEVEL OF DETAIL, as GPU Gems' "Effective Water Simulation" (ch. 1) and Bruneton, Neyret & Holzschuch
// ("Real-time Realistic Ocean Lighting", 2010) do it: a wave moves the mesh only where the mesh has the
// vertices to draw it (two to four per wavelength); the normal is worked out per pixel from the same waves
// plus a train of small ripples continuing the spectrum, each faded out where a pixel no longer resolves
// it; and the slope variance faded out is not lost but becomes roughness, so a distant sea turns from
// sharp glints into the broad glitter path a real one has. The ripples' slope variance follows Cox and
// Munk's measured wind sea (0.003 + 0.00512 per m/s of wind).
//
// Shading is single-layer water: what is under the surface comes from the opaque scene's colour copy
// (refracted), dimmed and tinted by Beer-Lambert absorption over the true thickness of water the view ray
// crosses (from the opaque depth snapshot) and lit by in-scattering; caustics play on the bed; the
// surface reflects the sky or environment cube (Bruneton's mean Fresnel over the unresolved slopes) with
// the screen-space march over it, and the sun's glint is GGX with Smith visibility, shadowed by the
// cascades and the clouds; foam gathers along the shore, on breaking crests and where the current
// tumbles; rain rings it, snow settles as slush and ice on still water. The surface is drawn into the
// scene before the fog and the temporal resolve, so it is fogged and filtered like everything else.
//
// No implicit derivatives (every fetch is explicit-level), so the module translates to GLSL as it is.

const PI: f32 = 3.14159265;
const MAX_WAVES: i32 = 8;
const MAX_RIPPLES: i32 = 16;
const MAX_REFLECTION_LOD: f32 = 4.0;

#include "./chunks/shadows.wgsl"

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
// The detail texture (water/waterTextures.ts): B is the foam web. Tiled, mipmapped.
@group(0) @binding(10) var u_detail_texture: texture_2d<f32>;
@group(0) @binding(11) var u_detail_sampler: sampler;

// Vertex stage ONLY (a block read from both stages is a GLSL link error).
struct WaterVertexUniforms {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_tile: vec4<f32>,            // x0, z0, size (m), skirt depth (m)
    u_tileLod: vec4<f32>,         // quads across, morph start, morph end (m), 1 = a morphing ocean tile
    u_vInfoOrigin: vec4<f32>,     // origin x, origin z, cell (m), 1 = has an info grid
    u_vInfoSize: vec4<f32>,       // cells x, cells z, height base (m: the grid's heights are stored above it)
    u_vOcean: vec4<f32>,          // level, 1 = an endless ocean (its grid only says where the shore is)
    u_waveDir: array<vec4<f32>, 8>,    // dir x, dir z, amplitude (m), wavelength (m)
    u_wavePhase: array<vec4<f32>, 8>,  // steepness, phase
    u_waveParams: vec4<f32>,      // count, time (s, wave speed applied), height scale, shore fade (m)
    u_swell: vec4<f32>,           // amplitude (m), frequency (Hz), summed wave amplitude (m)
    u_vCamera: vec4<f32>,         // camera position
    u_vSurf: vec4<f32>,           // surf: frequency (rad/s), amplitude (m), 1 = on (an ocean with a shore grid)
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
    u_sunColor: vec4<f32>,        // its illuminance (cloud-graded)
    u_ambient: vec4<f32>,         // ambient irradiance
    u_viewPos: vec4<f32>,         // camera, time (s, wave speed applied)
    u_depthParams: vec4<f32>,     // near, far, 1 = orthographic
    u_resolution: vec4<f32>,      // w, h, 1/w, 1/h
    u_fView: mat4x4<f32>,
    u_ssrProjection: mat4x4<f32>, // view -> clip, flipped onto screen uvs
    u_ssrParams: vec4<f32>,       // steps, thickness, max distance, 1 = on
    u_envScale: vec4<f32>,        // rgb scale, mode (0 none, 1 sRGB cube, 2 linear sky cube)
    u_fInfoOrigin: vec4<f32>,
    u_fInfoSize: vec4<f32>,
    u_fOcean: vec4<f32>,          // level, 1 = an endless ocean
    u_misc: vec4<f32>,            // pre-exposure, -, 1 = camera under the surface, -
    u_sssColor: vec4<f32>,        // subsurface scatter colour (rgb), strength
    u_sssParams: vec4<f32>,       // sharpness (power), distortion
    u_fWaveDir: array<vec4<f32>, 8>,
    u_fWavePhase: array<vec4<f32>, 8>,
    u_fWaveParams: vec4<f32>,     // count, -, height scale, -
    u_ripple: vec4<f32>,          // longest ripple (m), slope of each, wavelength ratio, count
    u_rippleDir: vec4<f32>,       // dir x, dir z (the waves' heading)
    u_fSurf: vec4<f32>,           // as u_vSurf
};
@group(1) @binding(1) var<uniform> u_wf: WaterFragmentUniforms;

// The weather volumes, as render/weather.ts uploads them to every program declaring `u_weatherInfo`.
// (Binding 2 of the group is the shadow block, chunks/shadows.wgsl.)
struct WaterWeatherUniforms {
    u_weatherInv: array<mat4x4<f32>, 4>,
    u_weatherBlend: array<vec4<f32>, 4>,
    u_weatherAmount: array<vec4<f32>, 4>,
    u_weatherShape: array<vec4<f32>, 4>,
    u_weatherInfo: vec4<f32>,
    u_snowColor: vec4<f32>,
};
@group(1) @binding(3) var<uniform> u_ww: WaterWeatherUniforms;

fn weatherCount() -> i32 { return i32(u_ww.u_weatherInfo.x); }
fn weatherInv(i: i32) -> mat4x4<f32> { return u_ww.u_weatherInv[i]; }
fn weatherBlend(i: i32) -> vec4<f32> { return u_ww.u_weatherBlend[i]; }
fn weatherAmount(i: i32) -> vec4<f32> { return u_ww.u_weatherAmount[i]; }
fn weatherShape(i: i32) -> vec4<f32> { return u_ww.u_weatherShape[i]; }

#include "./chunks/weatherVolumes.wgsl"

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    /** The resting surface's own slope (d/dx, d/dz): a river runs downhill. */
    @location(1) grad: vec2<f32>,
    /** Undisplaced x, z (where the surface point rests), and the wave height scale there. */
    @location(2) rest: vec3<f32>,
    /** 1 on the tile's skirt, 0 on its surface. */
    @location(3) skirt: f32,
    /** The resting surface's slope (rise over run): steep is a waterfall. */
    @location(4) slope: f32,
    /** The mesh's cell (m) there: waves shorter than it were not displaced. */
    @location(5) cell: f32,
};

// ---- the water info --------------------------------------------------------------------------------

fn infoUvw(xz: vec2<f32>, origin: vec4<f32>, size: vec4<f32>) -> vec3<f32> {
    let c = (xz - origin.xy) / origin.z + vec2<f32>(0.5);
    return vec3<f32>(c.x / size.x, c.y / size.y, 0.5);
}

fn insideInfo(uvw: vec3<f32>) -> bool {
    return all(uvw.xy >= vec2<f32>(0.0)) && all(uvw.xy <= vec2<f32>(1.0));
}

/** How much of a wave of length `lambda` a grid of `cell` metres (or a pixel of that footprint) draws. */
fn bandLimit(lambda: f32, cell: f32) -> f32 {
    return smoothstep(2.0 * cell, 4.0 * cell, lambda);
}

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash11(x: f32) -> f32 {
    return hash12(vec2<f32>(x, x * 1.618 + 0.37));
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

// ---- surf (physics/water/surf.ts surfAt, operation for operation) ---------------------------------------
//
// The sea's waves as they run in over a beach: one train of breakers at the sea's period whose phase is the
// time left to reach the shore (2 * distance / sqrt(g * depth) over a planar beach), so the crests slow,
// bunch up and follow the depth contours; growing as the water shoals, breaking at 0.78 of the depth, running
// up the beach and draining back, the crest sharpening and leaning shoreward as it breaks.

struct Surf {
    height: f32,
    /** d height / dt on the waves' clock (the slope is this times the travel time's gradient). */
    rate: f32,
    /** 0 offshore of the surf, 1 where it breaks. */
    breaking: f32,
    /** 0 on a crest, growing behind it. */
    phase: f32,
    /** Metres: the breakers' length here. */
    wavelength: f32,
};

fn surfTravelTime(edge: f32, depth: f32) -> f32 {
    return 2.0 * max(edge, 0.0) / sqrt(9.81 * max(depth, 0.1));
}

/** The surf at rest point `p`, `edge` metres from the shore and `depth` deep; `s` = (frequency, amplitude, on). */
fn surfAt(s: vec4<f32>, p: vec2<f32>, t: f32, edge: f32, depth: f32) -> Surf {
    var r: Surf;
    r.height = 0.0;
    r.rate = 0.0;
    r.breaking = 0.0;
    r.phase = 0.0;
    r.wavelength = 1e4;
    if (s.z < 0.5 || s.y <= 0.0 || s.x <= 0.0) { return r; }
    // Sets: the breakers come in groups of about seven, the groups differing along the shore.
    let group = 0.6 + 0.4 * sin(s.x * t / 7.3 + 6.2831853 * valueNoise(p / 90.0));
    let a0 = s.y * group;
    let hb = max(2.0 * a0 / 0.78, 0.05);
    let h = max(depth, 0.0);
    if (h >= 8.0 * hb) { return r; }
    let inW = clamp((8.0 * hb - h) / (4.0 * hb), 0.0, 1.0);
    let fadeIn = inW * inW * (3.0 - 2.0 * inW);
    let b = clamp((4.0 * hb - h) / (3.0 * hb), 0.0, 1.0);
    let shoal = a0 * pow(4.0 * hb / max(h, hb), 0.25);
    let a = fadeIn * min(shoal, 0.78 * 0.5 * h + 0.5 * a0);
    let theta = s.x * (t + surfTravelTime(edge, depth)) + 2.5 * valueNoise(vec2<f32>(p.x / 37.0 + 17.3, p.y / 37.0));
    let q = 0.5 * b;
    let k = 0.45 * b;
    let st = sin(theta);
    let ct = cos(theta);
    let phase = theta + q * st + k * ct;
    let dPhase = 1.0 + q * ct - k * st;
    r.height = a * cos(phase);
    r.rate = -a * sin(phase) * dPhase * s.x;
    r.breaking = b * fadeIn;
    r.phase = phase - 6.2831853 * floor(phase / 6.2831853);
    r.wavelength = 6.2831853 * sqrt(9.81 * max(h, 0.1)) / s.x;
    return r;
}

// ---- Gerstner waves (physics/water/gerstner.ts gerstnerDisplacement, operation for operation) -----------

/**
 * The displacement of the resting point (x, z), each wave weighted by what a grid of `cell` metres can
 * draw. With every weight 1 it is the CPU's sum exactly.
 */
fn gerstnerOffset(x: f32, z: f32, t: f32, scale: f32, cell: f32) -> vec3<f32> {
    var offset = vec3<f32>(0.0);
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
        let w = bandLimit(d.w, cell);
        offset += vec3<f32>(q * a * d.x * cos(theta), a * sin(theta), q * a * d.y * cos(theta)) * w;
    }
    return offset;
}

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    let tile = u_wv.u_tile;
    let lodp = u_wv.u_tileLod;
    var grid = position.xz;
    var xz = tile.xy + grid * tile.z;
    var morph = 0.0;
    if (lodp.w > 0.5) {
        // CDLOD (water/oceanLod.ts oceanMorph): odd vertices slide onto the next level's grid with distance.
        let d0 = distance(u_wv.u_vCamera.xyz, vec3<f32>(xz.x, u_wv.u_vOcean.x, xz.y));
        morph = clamp((d0 - lodp.y) / max(lodp.z - lodp.y, 1e-3), 0.0, 1.0);
        let f = fract(grid * lodp.x * 0.5) * 2.0 / lodp.x;
        grid = grid - f * morph;
        xz = tile.xy + grid * tile.z;
    }
    let cell = tile.z / lodp.x * (1.0 + morph);
    var surface = u_wv.u_vOcean.x;
    var edge = 1e4;
    var share = 1.0;
    var depth = 1e4;
    var grad = vec2<f32>(0.0);
    let ocean = u_wv.u_vOcean.y > 0.5;
    let uvw = infoUvw(xz, u_wv.u_vInfoOrigin, u_wv.u_vInfoSize);
    if (u_wv.u_vInfoOrigin.w > 0.5 && (insideInfo(uvw) || !ocean)) {
        let c = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0));
        let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, c, 0.0);
        let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, c, 0.0);
        edge = i0.w;
        share = i1.x;
        // The sea's depth over the beach (its shore grid's bed): the cap below. Physics reads the same grid.
        if (ocean) { depth = max(0.0, u_wv.u_vOcean.x - (i1.z + u_wv.u_vInfoSize.z)); }
        if (!ocean) {
            surface = i0.x + u_wv.u_vInfoSize.z;
            // The resting surface's own slope, a cell either way: a river runs downhill, a waterfall drops.
            let du = vec3<f32>(1.0 / u_wv.u_vInfoSize.x, 0.0, 0.0);
            let dv = vec3<f32>(0.0, 1.0 / u_wv.u_vInfoSize.y, 0.0);
            let hx = textureSampleLevel(u_info0_texture, u_info0_sampler, clamp(c + du, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).x
                   - textureSampleLevel(u_info0_texture, u_info0_sampler, clamp(c - du, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).x;
            let hz = textureSampleLevel(u_info0_texture, u_info0_sampler, clamp(c + dv, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).x
                   - textureSampleLevel(u_info0_texture, u_info0_sampler, clamp(c - dv, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).x;
            grad = vec2<f32>(hx, hz) / (2.0 * u_wv.u_vInfoOrigin.z);
        }
    }
    // Shoaling: the waves die down toward the shore, as the CPU's waveHeight fades them, and never stand
    // taller than the water is deep allows (a wave breaks at about 0.8 of the depth; 0.4 of it is its crest).
    let fadeW = u_wv.u_waveParams.w;
    let fade = select(1.0, clamp(edge / max(fadeW, 1e-3), 0.0, 1.0), fadeW > 0.0);
    let cap = clamp(0.4 * depth / max(u_wv.u_swell.z, 1e-3), 0.0, 1.0);
    let scale = u_wv.u_waveParams.z * share * fade * fade * (3.0 - 2.0 * fade) * cap;
    let t = u_wv.u_waveParams.y;
    var p = vec3<f32>(xz.x, surface, xz.y) + gerstnerOffset(xz.x, xz.y, t, scale, cell);
    // Over the beach the surf takes over from the waves, as physics/water/surf.ts adds it to what floats.
    if (ocean) {
        let sf = surfAt(u_wv.u_vSurf, xz, t, edge, depth);
        p.y += sf.height * bandLimit(sf.wavelength, cell);
    }
    if (u_wv.u_swell.x > 0.0) {
        p.y += u_wv.u_swell.x * sin(t * u_wv.u_swell.y * PI * 2.0 + xz.x * 0.37 + xz.y * 0.29);
    }
    // The skirt hangs straight down from the edge.
    p.y -= max(0.0, -position.y) * tile.w;
    out.worldPos = p;
    out.grad = grad;
    out.slope = length(grad);
    out.rest = vec3<f32>(xz, scale);
    out.skirt = max(0.0, -position.y);
    out.cell = cell;
    var clip = u_wv.u_projection * u_wv.u_view * vec4<f32>(p, 1.0);
    // An ocean reaches the horizon, far past the far plane: pinned just inside it rather than clipped.
    if (lodp.w > 0.5) { clip.z = min(clip.z, clip.w * 0.999999); }
    out.position = clip;
    return out;
}

// ---- fragment helpers -----------------------------------------------------------------------------

/** The surf's travel time to the shore at rest point `xz`, from the ocean's shore grid (physics: waterSurface.ts). */
fn oceanTravelTime(xz: vec2<f32>) -> f32 {
    let c = clamp(infoUvw(xz, u_wf.u_fInfoOrigin, u_wf.u_fInfoSize), vec3<f32>(0.0), vec3<f32>(1.0));
    let e = textureSampleLevel(u_info0_texture, u_info0_sampler, c, 0.0).w;
    let bed = textureSampleLevel(u_info1_texture, u_info1_sampler, c, 0.0).z + u_wf.u_fInfoSize.z;
    return surfTravelTime(e, u_wf.u_fOcean.x - bed);
}

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

/** What the waves give the pixel at rest point `p`: xy slope (d/dx, d/dz), z crest compression, w unresolved slope variance. */
fn waveSlopes(p: vec2<f32>, t: f32, scale: f32, footprint: f32) -> vec4<f32> {
    var sx = 0.0;
    var sz = 0.0;
    var compress = 0.0;
    var removed = 0.0;
    let count = min(i32(u_wf.u_fWaveParams.x), MAX_WAVES);
    let n = f32(max(count, 1));
    for (var i = 0; i < MAX_WAVES; i++) {
        if (i >= count) { break; }
        let d = u_wf.u_fWaveDir[i];
        let ph = u_wf.u_fWavePhase[i];
        let k = 6.283185307179586 / max(0.01, d.w);
        let omega = sqrt(9.81 * k);
        let a = d.z * scale;
        let theta = k * (d.x * p.x + d.y * p.y) - omega * t + ph.y;
        var q = 0.0;
        if (a > 0.0) { q = ph.x / (k * a * n); }
        let wa = k * a;
        let w = smoothstep(2.0 * footprint, 6.0 * footprint, d.w);
        sx += d.x * wa * cos(theta) * w;
        sz += d.y * wa * cos(theta) * w;
        compress += q * wa * sin(theta) * w;
        removed += (1.0 - w * w) * 0.5 * wa * wa;
    }
    return vec4<f32>(sx, sz, compress, removed);
}

/**
 * The ripples below the Gerstner waves: `u_ripple.w` trains of sines, from `u_ripple.x` metres down by
 * `u_ripple.z` each, every one with the same slope `u_ripple.y` (so their variance adds up to the wind
 * sea's), heading round the waves' direction with a spread that widens as they shorten, each at its own
 * speed (capillary-gravity dispersion). xy their slope, z the slope variance a pixel of `footprint`
 * metres no longer resolves, w their height.
 */
fn ripples(p: vec2<f32>, t: f32, footprint: f32) -> vec4<f32> {
    var g = vec2<f32>(0.0);
    var removed = 0.0;
    var h = 0.0;
    let count = min(i32(u_wf.u_ripple.w), MAX_RIPPLES);
    let s = u_wf.u_ripple.y;
    let base = u_wf.u_rippleDir.xy;
    var lambda = u_wf.u_ripple.x;
    for (var i = 0; i < MAX_RIPPLES; i++) {
        if (i >= count) { break; }
        let fi = f32(i);
        let spread = mix(0.6, 1.5, fi / f32(MAX_RIPPLES - 1));
        let ang = (hash11(fi * 7.31 + 0.5) * 2.0 - 1.0) * spread;
        let ca = cos(ang);
        let sa = sin(ang);
        let d = vec2<f32>(base.x * ca - base.y * sa, base.x * sa + base.y * ca);
        let k = 6.2831853 / lambda;
        // Gravity plus surface tension (0.074 N/m over 1000 kg/m^3): the shortest ripples run faster.
        let omega = sqrt(9.81 * k + 7.4e-5 * k * k * k);
        let theta = k * dot(d, p) - omega * t + hash11(fi * 3.17 + 1.3) * 6.2831853;
        let w = smoothstep(2.0 * footprint, 6.0 * footprint, lambda);
        g += d * (s * cos(theta) * w);
        h += s / k * sin(theta) * w;
        removed += (1.0 - w * w) * 0.5 * s * s;
        lambda *= u_wf.u_ripple.z;
    }
    return vec4<f32>(g, removed, h);
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
        let fadeR = (1.0 - life) * (1.0 - life) * falls;
        let dh = 0.004 * fadeR * packet * (180.0 * cos(180.0 * x));
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

/**
 * Screen-space reflection over the opaque scene (customShaders.ts `cleoScreenReflection`, ported). A hit
 * below `level` is something under the water, which a reflection off its top cannot see: rejected.
 */
fn screenReflection(worldPos: vec3<f32>, R: vec3<f32>, level: f32) -> vec4<f32> {
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
    let border = clamp(min(hitUV, vec2<f32>(1.0) - hitUV) / 0.08, vec2<f32>(0.0), vec2<f32>(1.0));
    let hitPos = mix(origin * k0, endP * k1, tHi) / mix(k0, k1, tHi);
    // View-space distance is world distance: the hit's height is the ray's.
    let travelled = length(hitPos - origin);
    if (worldPos.y + R.y * travelled < level - 0.25) { return vec4<f32>(0.0); }
    let fadeS = border.x * border.y
             * (1.0 - smoothstep(0.75, 1.0, travelled / u_wf.u_ssrParams.z))
             * (1.0 - smoothstep(0.4, 0.9, dir.z));
    return vec4<f32>(textureSampleLevel(u_sceneColor_texture, u_sceneColor_sampler, hitUV, 0.0).rgb, fadeS);
}

fn luminance(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

/**
 * The sky or environment in direction `R`, blurred by `roughness` (perceptual), at the frame's
 * pre-exposure. The sun's own disk is clamped out of it: the analytic glint below is the sun's reflection,
 * shaped by the waves, and the cube's copy of the disk would draw it twice.
 */
fn environment(R: vec3<f32>, roughness: f32) -> vec3<f32> {
    let mode = u_wf.u_envScale.w;
    let lod = roughness * MAX_REFLECTION_LOD;
    var c = vec3<f32>(0.0);
    if (mode > 1.5) {
        c = textureSampleLevel(u_envMap_texture, u_envMap_sampler, R, lod).rgb * u_wf.u_envScale.rgb;
    } else if (mode > 0.5) {
        c = pow(textureSampleLevel(u_envMap_texture, u_envMap_sampler, R, lod).rgb, vec3<f32>(2.2)) * u_wf.u_envScale.rgb;
    } else {
        // No cube: a sky gradient from the ambient light, so the water still reflects something sky-like.
        let up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
        return u_wf.u_ambient.rgb * mix(0.4, 1.2, up) / PI * u_wf.u_misc.x;
    }
    // The brightest the sky itself is (a hazy sun's surroundings run some times its mean radiance).
    let cap = max(luminance(u_wf.u_ambient.rgb) / PI * 10.0 * u_wf.u_misc.x, 1e-4);
    let l = luminance(c);
    if (l > cap) { c *= cap / l; }
    return c;
}

fn ggx(NoH: f32, a: f32) -> f32 {
    let a2 = a * a;
    let d = NoH * NoH * (a2 - 1.0) + 1.0;
    return a2 / max(PI * d * d, 1e-6);
}

/** Height-correlated Smith visibility for GGX (G / (4 N.L N.V)). */
fn smithVisibility(NoV: f32, NoL: f32, a: f32) -> f32 {
    let a2 = a * a;
    let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
    let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
    return 0.5 / max(gv + gl, 1e-5);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    cleoFragCoord = in.position.xy;
    let pre = u_wf.u_misc.x;
    let t = u_wf.u_viewPos.w;
    let cam = u_wf.u_viewPos.xyz;
    let uv = in.position.xy * u_wf.u_resolution.zw;
    // Seen from below (the camera is in this water): the underside, whichever way the triangle faces.
    let below = u_wf.u_misc.z > 0.5;

    // The water here.
    let ocean = u_wf.u_fOcean.y > 0.5;
    var surface = u_wf.u_fOcean.x;
    var flow = vec2<f32>(0.0);
    var edge = 1e4;
    var foamBake = 0.0;
    var wet = 1.0;
    var seaDepth = 1e4;
    let uvw = infoUvw(in.rest.xy, u_wf.u_fInfoOrigin, u_wf.u_fInfoSize);
    let hasInfo = u_wf.u_fInfoOrigin.w > 0.5;
    if (hasInfo && (insideInfo(uvw) || !ocean)) {
        let c = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0));
        let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, c, 0.0);
        let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, c, 0.0);
        edge = i0.w;
        if (ocean) { seaDepth = max(0.0, u_wf.u_fOcean.x - (i1.z + u_wf.u_fInfoSize.z)); }
        if (!ocean) {
            surface = i0.x + u_wf.u_fInfoSize.z;
            flow = i0.yz;
            foamBake = i1.y;
            wet = i1.w;
        }
    }
    // A lake or river ends where its grid says it is dry. The ocean is drawn on under the land's edge, a
    // couple of cells in: the landscape's own depth test draws its waterline, exactly, wherever it is.
    if (ocean) {
        if (hasInfo && edge < -2.0 * u_wf.u_fInfoOrigin.z) { discard; }
    } else if (wet < 0.5 || edge < -0.01) {
        discard;
    }
    // A skirt only fills the cracks between tiles out on open water; at the shore it would hang into view.
    if (in.skirt > 0.0 && edge < u_wf.u_fInfoOrigin.z * 3.0) { discard; }

    let toCam = cam - in.worldPos;
    let viewDist = length(toCam);
    let V = toCam / max(viewDist, 1e-4);
    // A pixel's footprint on the water, metres: its size at this distance, stretched by a grazing view
    // (the square root of the stretch: the long axis of the footprint runs one way, the waves every way).
    let pixel = viewDist * 2.0 / max(abs(u_wf.u_ssrProjection[1][1]) * u_wf.u_resolution.y, 1.0);
    let grazing = max(abs(V.y), 0.02);
    let footprint = pixel / sqrt(grazing);

    // The slopes: the resting surface's, the Gerstner waves', the ripples' riding the current, the rain's.
    let scale = in.rest.z;
    let waves = waveSlopes(in.rest.xy, t, scale, footprint);
    let strength = u_wf.u_surfaceParams.w;
    // Two phases of the flow map (Vlachos), half a cycle apart, so the ripples move with the river and
    // never stretch; each pixel's cycle is offset by a slow noise, so a river does not pulse as a whole.
    let f = flow * u_wf.u_detailParams.y;
    let cycle = 3.0;
    let jitter = valueNoise(in.rest.xy * 0.15);
    let ph0 = fract(t / cycle + jitter);
    let ph1 = fract(t / cycle + jitter + 0.5);
    let wgt = abs(ph0 * 2.0 - 1.0);
    var rip = ripples(in.rest.xy - f * ph0 * cycle, t, footprint);
    if (length(f) > 1e-3) {
        rip = mix(rip, ripples(in.rest.xy - f * ph1 * cycle + vec2<f32>(3.7, 1.9), t, footprint), wgt);
    }
    var slope = in.grad + waves.xy + rip.xy * strength;
    let weather = precipitationAt(in.worldPos);
    let still = 1.0 - smoothstep(0.1, 0.8, length(flow));
    // Rain rings are centimetres across: past a couple of centimetres a pixel they would only sparkle, so
    // they fade out with distance (the drops' roughening stays, as roughness).
    let ringFade = 1.0 - smoothstep(0.012, 0.045, footprint);
    if (weather.x > 0.0 && u_wf.u_detailParams.z > 0.0 && ringFade > 0.0) {
        slope += rainRings(in.worldPos.xz, u_ww.u_weatherInfo.y, weather.x * 0.8) * u_wf.u_detailParams.z * ringFade;
    }
    // The surf's slope: its rate of rise times the travel time's gradient, from the shore grid a cell either way.
    var surf: Surf;
    surf.breaking = 0.0;
    surf.phase = 0.0;
    var surfVariance = 0.0;
    var toShore = vec2<f32>(0.0);
    if (ocean && u_wf.u_fSurf.z > 0.5 && seaDepth < 1e3) {
        surf = surfAt(u_wf.u_fSurf, in.rest.xy, t, edge, seaDepth);
        if (surf.breaking > 0.0 || surf.height != 0.0) {
            let d = u_wf.u_fInfoOrigin.z;
            let tx = (oceanTravelTime(in.rest.xy + vec2<f32>(d, 0.0)) - oceanTravelTime(in.rest.xy - vec2<f32>(d, 0.0))) / (2.0 * d);
            let tz = (oceanTravelTime(in.rest.xy + vec2<f32>(0.0, d)) - oceanTravelTime(in.rest.xy - vec2<f32>(0.0, d))) / (2.0 * d);
            let w = smoothstep(2.0 * footprint, 6.0 * footprint, surf.wavelength);
            slope += surf.rate * vec2<f32>(tx, tz) * w;
            let ss = surf.rate * length(vec2<f32>(tx, tz));
            surfVariance = (1.0 - w * w) * 0.5 * ss * ss;
            if (length(vec2<f32>(tx, tz)) > 1e-6) { toShore = -normalize(vec2<f32>(tx, tz)); }
        }
    }
    var N = normalize(vec3<f32>(-slope.x, 1.0 - waves.z, -slope.y));
    if (below) { N = -N; }
    let NoV = clamp(dot(N, V), 1e-3, 1.0);

    // Roughness: the surface's own (a floor, so the sun never collapses to a single pixel), the rain's,
    // and every slope too small for this pixel to draw (Bruneton: their variance is the highlight's width).
    let unresolved = waves.w + rip.z * strength * strength + weather.x * 0.01 * u_wf.u_detailParams.z + surfVariance;
    let base = max(u_wf.u_absorption.w * u_wf.u_absorption.w, 0.02);
    var alpha = sqrt(base * base + unresolved);

    // Snow on still water: slush, then ice where it lies long enough (the weather's snow amount).
    let snowAt = weatherAt(in.worldPos).snow;
    let ice = clamp(snowAt * u_wf.u_detailParams.w * still * 1.4 - 0.2, 0.0, 1.0);
    alpha = mix(alpha, 0.35, ice);
    let roughness = sqrt(clamp(alpha, 0.0, 1.0));

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
    if (below) { thickness = 0.0; }
    let refracted = textureSampleLevel(u_sceneColor_texture, u_sceneColor_sampler, ruv, 0.0).rgb;

    // The sun, and how much of it reaches this point past the cascades and the clouds.
    let L = u_wf.u_sunDir.xyz;
    let sunVis = select(1.0 - directionalShadow(in.worldPos, vec3<f32>(0.0, 1.0, 0.0), fragDepth), 0.0, L.y <= 0.0);
    let sunUp = max(L.y, 0.0);

    // Absorption and scattering (Beer-Lambert): murky water scatters back long before it reaches the bed.
    let turbidity = u_wf.u_shallowColor.w;
    let clarity = max(u_wf.u_deepColor.w, 0.05);
    let absorb = u_wf.u_absorption.rgb * (1.0 + turbidity * 3.0);
    let sigma = absorb + vec3<f32>(turbidity / clarity + 0.15 / clarity);
    let transmit = exp(-sigma * thickness);
    // The light going down into the water (the sky's and the sun's, by its height and its shadow), and the
    // share of it the water scatters back up: the shallow and deep colours are that share (reflectances,
    // as an ocean's is a few percent in the blue), and what leaves a surface lit by an irradiance E is
    // E / pi of radiance. So deep water stays as dark as a real sea's, and the sky it reflects, not paint,
    // gives it its colour away from the vertical.
    let lightIn = (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * sunUp * mix(0.35, 1.0, sunVis)) * pre;
    let scatter = mix(u_wf.u_shallowColor.rgb, u_wf.u_deepColor.rgb, clamp(1.0 - exp(-thickness / clarity), 0.0, 1.0)) * lightIn / PI;
    // The bed is lit THROUGH the water above it, as well as seen through it: the sun's light comes down a
    // path bent by refraction (Snell, 1.33), the sky's from every way (on average some 1.2 of the depth),
    // so a deep bed darkens and turns blue-green twice over, down and back up. Forward scattering keeps
    // most of the scattered light going down: half of the scattering counts against it.
    var down = vec3<f32>(1.0);
    var caustic = vec3<f32>(0.0);
    if (!farScene && !below) {
        let bed = cam - V * (behind * toPath);
        let underBy = max(0.0, surface - bed.y);
        let cosT = sqrt(max(1.0 - (1.0 - sunUp * sunUp) / 1.7689, 0.05));
        let sunLight = luminance(u_wf.u_sunColor.rgb) * sunUp * sunVis;
        let sunShare = sunLight / max(sunLight + luminance(u_wf.u_ambient.rgb), 1e-4);
        let path = underBy * (sunShare / cosT + (1.0 - sunShare) * 1.2);
        down = exp(-(absorb + vec3<f32>(0.5 * (turbidity / clarity + 0.15 / clarity))) * path);
        // Caustics on the bed, as deep as the sun reaches: the bed's own colour brightened where the
        // waves above focus the sun on it.
        if (u_wf.u_foamParams.z > 0.0) {
            let cScale = max(u_wf.u_foamParams.w, 0.05);
            let c = causticAt(bed.xz / cScale * 2.0 + flow * t * 0.3, t * 0.8);
            caustic = vec3<f32>(c * u_wf.u_foamParams.z * 1.5 * sunUp * sunVis) * exp(-sigma * underBy) * smoothstep(0.0, 0.3, underBy);
        }
    }
    let under = refracted * down * (vec3<f32>(1.0) + caustic) * transmit + scatter * (vec3<f32>(1.0) - transmit);

    // Reflection: the screen-space march where it finds something, the sky or environment cube under it.
    // A reflected ray that points down would only meet the next wave; the sky that wave reflects is the
    // mirror of it. A blurred lookup near the horizon is lifted clear of the cube's ground below it.
    let R0 = reflect(-V, N);
    var R = vec3<f32>(R0.x, max(abs(R0.y), 0.3 * roughness * roughness), R0.z);
    R = normalize(R);
    var reflected = environment(R, roughness);
    if (R0.y > 0.0 && !below) {
        let ssr = screenReflection(in.worldPos, R0, surface);
        reflected = mix(reflected, ssr.rgb, ssr.a * u_wf.u_surfaceParams.y);
    }
    // Fresnel over a rough surface (Bruneton 2010): the mean over the slopes this pixel cannot see, with
    // their spread along the view (half the total variance: the slopes are about as rough every way).
    let F0 = u_wf.u_surfaceParams.x;
    let sd = sqrt(unresolved * 0.5);
    var F = F0 + (1.0 - F0) * pow(1.0 - NoV, 5.0 * exp(-2.69 * sd)) / (1.0 + 22.7 * pow(sd, 1.5));
    // Thin water at the shore barely reflects, so the shoreline fades instead of drawing a hard line.
    F *= smoothstep(0.0, 0.08, thickness + select(0.0, 1.0, below));

    // The sun's glint: GGX, Smith visibility, Fresnel at the half vector.
    let H = normalize(L + V);
    let NoL = max(dot(N, L), 0.0);
    let VoH = clamp(dot(V, H), 0.0, 1.0);
    let Fs = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
    var spec = u_wf.u_sunColor.rgb * pre * ggx(max(dot(N, H), 0.0), alpha) * smithVisibility(NoV, max(NoL, 1e-3), alpha) * Fs * NoL * sunVis;
    spec *= select(1.0, 0.0, below);
    // Never brighter than a mirror of the sun spread over a few pixels: no single-pixel fireflies.
    spec = min(spec, u_wf.u_sunColor.rgb * pre * 40.0);

    // Subsurface scattering: light that entered the water through one face of a wave and leaves through
    // the face we see, tinted by the water on the way (the Frostbite / Barre-Brisebois translucency
    // approximation). The light's path is bent by the surface normal (`distortion`), so the glow spreads
    // over the faces of the waves rather than only where the sun is exactly behind them, and gathered
    // round the backlit direction by `sharpness`. Thin water passes most: the crests standing above the
    // rest level and the ripples' tops, attenuated by the water's own absorption through them. Under it
    // all, a faint scattering of the sky's light, strongest looking shallowly into clear water.
    let sssStrength = u_wf.u_sssColor.w;
    var sss = vec3<f32>(0.0);
    if (sssStrength > 0.0 && !below) {
        let Ls = normalize(L + N * u_wf.u_sssParams.y);
        let back = pow(clamp(dot(V, -Ls), 0.0, 1.0), max(u_wf.u_sssParams.x, 1.0));
        let crest = clamp((in.worldPos.y - surface) * 0.9 + rip.w * 4.0 + waves.z * 0.25, 0.0, 1.0);
        let path = mix(2.0, 0.25, crest);   // metres of water the light crosses: less through a thin crest
        let through = exp(-u_wf.u_absorption.rgb * (1.0 + turbidity * 3.0) * path);
        let forward = 1.0 - turbidity * 0.7;   // silt scatters it every way instead of on through
        let sunLit = u_wf.u_sunColor.rgb * back * (0.25 + 0.75 * crest) * through * forward * sunVis;
        let skyLit = u_wf.u_ambient.rgb * 0.15 * (1.0 - turbidity * 0.5) * (1.0 - NoV);
        sss = u_wf.u_sssColor.rgb * (sunLit + skyLit) * sssStrength * pre;
    }

    var color = mix(under + sss, reflected, F) + spec;

    // Foam: along the shore (and in thin water), on breaking crests, and where the current tumbles. Each
    // source says how much foam there is; the bubble web of the detail texture says where it holds, so a
    // little foam is a lace of lines and a lot is solid white, never a soft blur.
    let shoreW = u_wf.u_foamColor.w;
    var amount = 0.0;
    var surfAmount = 0.0;
    if (shoreW > 0.0) {
        let near = min(edge, thickness * 2.0);
        let band = 1.0 - smoothstep(0.0, shoreW, near);
        if (surf.breaking > 0.0) {
            // A sea's surf: the swash white as each breaker runs up the beach and spent as it drains back,
            // and each breaking crest whitening, its foam trailing it seaward as the bore runs on.
            let swash = 0.5 + 0.5 * cos(surf.phase - 0.6);
            let trail = pow(0.5 + 0.5 * cos(surf.phase - 0.9), 4.0);
            surfAmount = max(band * mix(0.15, 0.8, swash), surf.breaking * surf.breaking * trail * 0.85 * min(shoreW, 1.0));
        } else {
            // Lines running in toward the shore (the phase falls as the distance does), broken by the ripples.
            let lines = 0.5 + 0.5 * sin(edge * 2.5 + t * 1.6 + rip.w * 30.0);
            amount = max(amount, band * mix(0.55, 1.0, lines));
        }
    }
    amount = max(amount, smoothstep(0.3, 0.85, waves.z) * u_wf.u_foamParams.x);
    amount = max(amount, foamBake * u_wf.u_foamParams.y);
    // A waterfall: where the surface drops steeply the water tumbles white, in streaks racing down the fall.
    let fall = smoothstep(0.6, 1.6, in.slope) * u_wf.u_foamParams.y;
    if (fall > 0.0) {
        let along = select(vec2<f32>(0.0, 1.0), normalize(flow), length(flow) > 1e-3);
        let across = vec2<f32>(-along.y, along.x);
        let sx = dot(in.rest.xy, across);
        let sy = dot(in.rest.xy, along);
        let streak = valueNoise(vec2<f32>(sx * 3.0, sy * 0.6 - t * 3.5)) * 0.65 + valueNoise(vec2<f32>(sx * 9.0, sy * 1.5 - t * 6.0)) * 0.35;
        amount = max(amount, fall * (0.5 + 0.5 * streak));
    }
    if (amount > 0.0) {
        // The web drifts with the water, sampled at the mip the footprint calls for, on the same two phases
        // as the ripples: one phase alone would jump back every cycle.
        let webScale = max(u_wf.u_detailParams.x, 0.05) * 4.0;
        let webLod = clamp(log2(footprint / (webScale / 256.0)), 0.0, 8.0);
        var web = textureSampleLevel(u_detail_texture, u_detail_sampler, (in.rest.xy - f * ph0 * cycle) / webScale, webLod).z;
        if (length(f) > 1e-3) {
            let web1 = textureSampleLevel(u_detail_texture, u_detail_sampler, (in.rest.xy - f * ph1 * cycle + vec2<f32>(3.7, 1.9)) / webScale, webLod).z;
            web = mix(web, web1, wgt);
        }
        var foam = smoothstep(1.0 - amount, 1.0 - amount + 0.35, web * 0.75 + amount * 0.45);
        foam *= smoothstep(0.0, 0.08, amount);
        // Foam is a rough white scatterer: lit by the sun as it falls (not by the rippled normal) and the sky.
        let foamLit = u_wf.u_foamColor.rgb * (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * sunUp * sunVis) * pre * 0.3;
        color = mix(color, foamLit, foam * select(1.0, 0.0, below));
    }
    if (surfAmount > 0.0 && !below) {
        // Surf foam is sheets and patches with holes in them, not a web of bubbles: smooth noise at three
        // scales, thresholded by how much there is, carried in and out with the swash (its pattern moves
        // shoreward as the water rises), so the beach's foam flows rather than sits.
        let q = in.rest.xy + toShore * (surf.height * 3.0);
        let n = valueNoise(q * 0.45) * 0.5 + valueNoise(q * 1.3 + vec2<f32>(7.1, 2.9)) * 0.3 + valueNoise(q * 3.7 + vec2<f32>(3.3, 8.6)) * 0.2;
        let th = 1.0 - 0.7 * surfAmount;
        var sfoam = smoothstep(th - 0.04, th + 0.04, n);
        sfoam *= smoothstep(0.0, 0.1, surfAmount);
        let foamLit = u_wf.u_foamColor.rgb * (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * sunUp * sunVis) * pre * 0.3;
        color = mix(color, foamLit, sfoam);
    }

    // Ice and slush: snow-coloured, lit, the water's own look gone under it.
    let snowColor = select(vec3<f32>(0.9, 0.92, 0.95), u_ww.u_snowColor.rgb, u_ww.u_snowColor.a > 0.0);
    let iceLit = snowColor * (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * NoL * sunVis) * pre * 0.32 + spec * 0.3;
    color = mix(color, iceLit, ice);

    // Seen from below: the underside reflects the water back (total internal reflection outside Snell's
    // window), and what lies above shows through the window, fogged by the water in between.
    if (below) {
        let cosT = clamp(dot(-N, V), 0.0, 1.0);
        let window = smoothstep(0.62, 0.70, cosT);
        let fogged = u_wf.u_underwater.rgb * lightIn;
        color = mix(fogged, refracted, window);
    }
    return vec4<f32>(min(color, vec3<f32>(32768.0)), 1.0);
}
