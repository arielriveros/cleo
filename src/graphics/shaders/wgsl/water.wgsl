// The WATER SURFACE of a Water node (core/scene/nodes/waterVolumeNode.ts), drawn by render/water.ts.
//
// One tile of the node's surface per draw: a grid in 0..1 (x, z) placed over `u_tile`, its height read
// from the node's WATER INFO (water/waterInfo.ts: resting surface, flow, shore distance, foam, bed) and
// lifted by the node's waves, the same sum physics/water/waves.ts evaluates on the CPU, so a
// floating body rides exactly this surface. The waves are afl_ext's (Shadertoy MdXyzX, MIT licence, see
// THIRD_PARTY_NOTICES.md): sharp-crested exp(sin) waves in scattered directions, each dragging the shorter
// ones onto its crests, their lengths, heights and slopes those of the wind's sea (waves.ts). Vertices with y = -1 are the tile's SKIRT, hung
// below the edge so neighbouring tiles of different density never show a crack. An endless ocean's tiles
// are a CDLOD quadtree (water/oceanLod.ts): their odd vertices MORPH onto the next level's grid with
// distance, so levels meet without cracks and need no skirt, and they reach the horizon (pinned inside
// the far plane).
//
// LEVEL OF DETAIL, as GPU Gems' "Effective Water Simulation" (ch. 1) and Bruneton, Neyret & Holzschuch
// ("Real-time Realistic Ocean Lighting", 2010) do it: a wave moves the mesh only where the mesh has the
// vertices to draw it (two to four per wavelength); the normal is worked out per pixel from the same waves,
// down to the capillary ripples, each faded out where a pixel no longer resolves it; and the slope variance
// faded out is not lost but becomes roughness, so a distant sea turns from sharp glints into the broad
// glitter path a real one has. The set's slope variance is Cox and Munk's measured wind sea (0.003 +
// 0.00512 per m/s of wind).
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
// LIVE WAVES: round the camera, flowing water also carries a simulation of surface waves riding its current
// (render/waterWaves.ts, water/waveSim.ts): wave trains standing below drops, wakes off the banks, the boil
// of fast water. Its heights lift the vertices, its slopes join the waves', its foam is the foam there, and
// its turbulence says where the ripples lie (smooth on a boil, crowded at its edge).
//
// FOAM is drawn from an amount with the foam texture (water/waterTextures.ts waterFoamPixels): thick foam
// where it lasts, textured with its bubbles; lace and loose bubbles where it is thin (foamCover).
//
// No implicit derivatives (every fetch is explicit-level), so the module translates to GLSL as it is.

const PI: f32 = 3.14159265;
const MAX_WAVES: i32 = 40;
// physics/water/waves.ts: the mean of exp(sin - 1), and the mean square of its derivative.
const WAVE_MEAN: f32 = 0.46575961;
const WAVE_SLOPE_VARIANCE: f32 = 0.10763481;
// waves.ts WAVE_BEND: radians a crest is bent by across the noise's 0..1.
const WAVE_BEND: f32 = 1.6;
const MAX_REFLECTION_LOD: f32 = 4.0;

#include "./chunks/shadows.wgsl"

@group(0) @binding(0) var u_sceneDepth_texture: texture_depth_2d;   // opaque depth snapshot
@group(0) @binding(1) var u_sceneDepth_sampler: sampler;
@group(0) @binding(2) var u_sceneColor_texture: texture_2d<f32>;    // opaque colour copy (pre-exposed)
@group(0) @binding(3) var u_sceneColor_sampler: sampler;
@group(0) @binding(4) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(5) var u_envMap_sampler: sampler;
// The resting surface is the sum of its two parts (water/waterInfo.ts heightQuantum): half floats alone
// would terrace it.
@group(0) @binding(6) var u_info0_texture: texture_3d<f32>;         // surface (coarse), flow x, flow z, shore distance
@group(0) @binding(7) var u_info0_sampler: sampler;
@group(0) @binding(8) var u_info1_texture: texture_3d<f32>;         // surface (fine), foam, bed, wet
@group(0) @binding(9) var u_info1_sampler: sampler;
// The detail texture (water/waterTextures.ts): R, G the slopes of a field of ripples. Tiled, mipmapped.
@group(0) @binding(10) var u_detail_texture: texture_2d<f32>;
@group(0) @binding(11) var u_detail_sampler: sampler;
// The live waves round the camera (render/waterWaves.ts): height (m), rate (m/s), turbulence, foam.
@group(0) @binding(12) var u_live_texture: texture_2d<f32>;
@group(0) @binding(13) var u_live_sampler: sampler;
// The foam texture (waterTextures.ts waterFoamPixels): bubbles, lace, where foam lasts, grain. Tiled, mipmapped.
@group(0) @binding(14) var u_foam_texture: texture_2d<f32>;
@group(0) @binding(15) var u_foam_sampler: sampler;
// The local flow round the camera (render/localFlow.ts), over the live waves' window: the surface's lift over
// the baked one (m), the current x, z (m/s), and how much of it is the local flow's (0..1).
@group(0) @binding(16) var u_flow_texture: texture_2d<f32>;
@group(0) @binding(17) var u_flow_sampler: sampler;

// Vertex stage ONLY (a block read from both stages is a GLSL link error).
struct WaterVertexUniforms {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_tile: vec4<f32>,            // x0, z0, size (m), skirt depth (m)
    u_tileLod: vec4<f32>,         // quads across, morph start, morph end (m), 1 = a morphing ocean tile
    u_vInfoOrigin: vec4<f32>,     // origin x, origin z, cell (m), 1 = has an info grid
    u_vInfoSize: vec4<f32>,       // cells x, cells z, height base (m: the grid's heights are stored above it)
    u_vOcean: vec4<f32>,          // level, 1 = an endless ocean (its grid only says where the shore is)
    u_waves: array<vec4<f32>, 40>,     // heading x, z, amplitude (m, the look's ripples folded in), drag; longest first
    u_waveK: array<vec4<f32>, 40>,     // wavenumber (rad/m), length (m), frequency (rad/s), slope variance of it and all shorter
    u_waveParams: vec4<f32>,      // count, time (s, wave speed applied), height scale, shore fade
    u_swell: vec4<f32>,           // amplitude (m), frequency (Hz), a tall crest of the waves (m), the body's wave share
    u_vCamera: vec4<f32>,         // camera position
    u_vSurf: vec4<f32>,           // surf: frequency (rad/s), amplitude (m), 1 = on (an ocean with a shore grid)
    u_vFlow: vec4<f32>,           // how far the waves ride the current, the speed a river's waves are built for (0: wind waves)
    u_vLive: vec4<f32>,           // the live waves' window: origin x, origin z (m), 1 / side (1/m), strength (0: none)
    u_vLocal: vec4<f32>,          // 1 = the local flow is drawn over that window, -, -, -
};
@group(1) @binding(0) var<uniform> u_wv: WaterVertexUniforms;

// Fragment stage ONLY.
struct WaterFragmentUniforms {
    u_shallowColor: vec4<f32>,    // rgb, turbidity
    u_deepColor: vec4<f32>,       // rgb, clarity (m)
    u_absorption: vec4<f32>,      // rgb per metre, roughness
    u_foamColor: vec4<f32>,       // rgb, shore foam width (m)
    u_foamParams: vec4<f32>,      // crest foam, flow foam, caustics, caustics scale (m)
    u_surfaceParams: vec4<f32>,   // reflectivity, screen reflections, refraction (m), - (the ripples ride u_fWaves)
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
    u_misc: vec4<f32>,            // pre-exposure, how much fast water churns (lightens, clouds), 1 = camera under the surface, cells a baked surface is drawn past its wet ones
    u_sssColor: vec4<f32>,        // subsurface scatter colour (rgb), strength
    u_sssParams: vec4<f32>,       // sharpness (power), distortion
    u_fWaves: array<vec4<f32>, 40>,
    u_fWaveK: array<vec4<f32>, 40>,
    u_fWaveParams: vec4<f32>,     // count, -, height scale, the waves' height deviation (m, at full scale)
    u_fSurf: vec4<f32>,           // as u_vSurf
    u_fLive: vec4<f32>,           // as u_vLive
    u_fLiveGrid: vec4<f32>,       // the live waves' grid: 1 / texels a side, metres a texel, 1 = this water is a river, 1 = the local flow is drawn (its cells two texels)
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
    /** x, z, and the wave height scale there. */
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

/** The resting surface above the grid's base at `c`: its coarse and fine parts, each filtered, added. */
fn restHeight(c: vec3<f32>) -> f32 {
    return textureSampleLevel(u_info0_texture, u_info0_sampler, c, 0.0).x
         + textureSampleLevel(u_info1_texture, u_info1_sampler, c, 0.0).x;
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

/** valueNoise and its gradient: (value, d/dx, d/dy). */
// Smooth noise smeared along a direction (a short line integral over four taps, half a metre apart): streaks
// that follow the current wherever it turns, with no frame to rotate. About 0..1, spread back out to the
// contrast one tap has.
fn whiteStreaks(p: vec2<f32>, along: vec2<f32>) -> f32 {
    let q = p * 2.2;
    let stride = along;
    let sum = valueNoise(q - stride * 1.5) + valueNoise(q - stride * 0.5) + valueNoise(q + stride * 0.5) + valueNoise(q + stride * 1.5);
    return clamp((sum * 0.25 - 0.5) * 1.7 + 0.5, 0.0, 1.0);
}

fn valueNoiseGrad(p: vec2<f32>) -> vec3<f32> {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let du = 6.0 * f * (1.0 - f);
    let a = hash12(i);
    let b = hash12(i + vec2<f32>(1.0, 0.0));
    let c = hash12(i + vec2<f32>(0.0, 1.0));
    let d = hash12(i + vec2<f32>(1.0, 1.0));
    let k = a - b - c + d;
    let v = a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y;
    return vec3<f32>(v, du.x * ((b - a) + k * u.y), du.y * ((c - a) + k * u.x));
}

/** A turn of 0.6 rad: the foam texture's copies are read turned against each other, so they never line up. */
const FOAM_TURN: vec2<f32> = vec2<f32>(0.8253356, 0.5646425);

/**
 * How much of the water foam covers at `p` (m, carried with the water) where `amount` (0..1) of it lies, drawn
 * with the foam texture (water/waterTextures.ts) over `size` metres. Foam is a web: a little of it is a few
 * broken strands, more a net with round holes, more still white with holes in it. Three copies of the texture
 * make it, turned against each other: one the tile's size is the web; one several tiles wide says where the
 * foam is thick and where thin, and its own web, weighed in with the tile's, breaks that one up so no two
 * tiles are filled alike; one finer is the web inside the web, and the bubbles on top. Too far off to tell
 * the web, the amount itself.
 */
fn foamCover(p: vec2<f32>, amount: f32, size: f32, footprint: f32) -> f32 {
    if (amount <= 0.0) { return 0.0; }
    let lodWide = log2(max(footprint / (size / 512.0), 1e-6));
    let far = smoothstep(3.5, 5.5, lodWide);
    if (far >= 1.0) { return amount; }
    let wide = textureSampleLevel(u_foam_texture, u_foam_sampler, p / size, max(lodWide, 0.0));
    let lodNear = lodWide + 1.3219;
    let turned = vec2<f32>(p.x * FOAM_TURN.x - p.y * FOAM_TURN.y, p.x * FOAM_TURN.y + p.y * FOAM_TURN.x);
    let near = textureSampleLevel(u_foam_texture, u_foam_sampler, turned / (size * 0.4) + vec2<f32>(0.37, 0.61), max(lodNear, 0.0));
    let nearIn = 1.0 - smoothstep(3.0, 5.0, lodNear);
    let back = vec2<f32>(p.x * FOAM_TURN.x + p.y * FOAM_TURN.y, p.y * FOAM_TURN.x - p.x * FOAM_TURN.y);
    let broad = textureSampleLevel(u_foam_texture, u_foam_sampler, back / (size * 3.3) + vec2<f32>(0.13, 0.71), max(lodWide - 1.7225, 0.0));
    // How much of it is here: every place has some, the thick ones more.
    let local = amount * mix(0.35, 1.8, broad.b);
    // The web: the tile's, weighed with the broad copy's (and the sum of two evenly spread values, which
    // crowds toward the middle, spread evenly again), with the finer copy's inside it. The higher of two
    // evenly spread values is above a level more often than either is, so the level is raised to keep the
    // share covered.
    let sum = 0.62 * wide.g + 0.38 * broad.g;
    var even = (2.0 * sum - 0.38) / 1.24;
    if (sum < 0.38) { even = sum * sum / 0.4712; } else if (sum > 0.62) { even = 1.0 - (1.0 - sum) * (1.0 - sum) / 0.4712; }
    let lace = max(even, near.g * nearIn);
    let open = max(1.0 - local, 0.0);
    let level = mix(open, sqrt(open), nearIn) - max(local - 1.0, 0.0);
    let soft = 0.025 + 0.25 * clamp(lodWide / 5.0, 0.0, 1.0);
    let body = smoothstep(level - soft, level + soft, lace);
    // Thickest along a strand's middle; loose bubbles off its edge; its surface its own bubbles.
    let thick = smoothstep(level, level + 0.3, lace);
    let loose = smoothstep(level - 0.16, level - 0.02, lace) * smoothstep(0.55, 0.8, near.r) * nearIn * 0.55;
    let surface = mix(0.92, 0.76 + 0.24 * max(near.r, near.a * 0.7), nearIn);
    let cover = max(body * (0.72 + 0.28 * thick) * surface, loose) * smoothstep(0.0, 0.04, local);
    return mix(clamp(cover, 0.0, 1.0), amount, far);
}

/** Where wave `i`, `lambda` metres long, reads the crest-bending noise at rest point `p0` (waves.ts waveBend). */
fn bendAt(i: i32, lambda: f32, p0: vec2<f32>) -> vec2<f32> {
    return p0 / lambda + vec2<f32>(f32(i) * 17.3, f32(i) * 7.1);
}

// ---- water carried by a current (physics/water/waves.ts waveSurfaceInFlow, flowWaveScale) ----------------
//
// What rides the water (its waves, its foam, the caustics under it) moves with the current. Carried rigidly it
// would shear apart where the current varies, so two copies are read, each carried for FLOW_CYCLE seconds and
// then put back, half a cycle apart, and cross-faded so neither is seen at its jump (a flow map's two
// phases, Vlachos). Wave heights and slopes are blended to keep their height: the sum of two unlike fields
// weighted a and b stands sqrt(a^2 + b^2) as tall, and a plain cross-fade would flatten the water twice a
// cycle. Each place runs its cycle at its own offset (a slow noise), so a river does not pulse as a whole.

const FLOW_CYCLE: f32 = 3.0;
/** Where the second copy is read, so the two never look alike. */
const FLOW_APART: vec2<f32> = vec2<f32>(3.7, 1.9);

struct FlowPhases {
    /** Seconds each copy has been carried, about zero: read it at `p - flow * a` and `p - flow * b + FLOW_APART`. */
    a: f32, b: f32,
    /** Their weights for waves (height kept), and the second's weight for anything cross-faded plainly. */
    wa: f32, wb: f32, fade: f32,
};

fn flowPhases(p: vec2<f32>, t: f32) -> FlowPhases {
    var r: FlowPhases;
    let jitter = valueNoise(p * 0.15);
    let ph0 = fract(t / FLOW_CYCLE + jitter);
    let ph1 = fract(t / FLOW_CYCLE + jitter + 0.5);
    let w1 = abs(ph0 * 2.0 - 1.0);
    let w0 = 1.0 - w1;
    let norm = inverseSqrt(w0 * w0 + w1 * w1);
    r.a = (ph0 - 0.5) * FLOW_CYCLE;
    r.b = (ph1 - 0.5) * FLOW_CYCLE;
    r.wa = w0 * norm;
    r.wb = w1 * norm;
    r.fade = w1;
    return r;
}

/**
 * What a current's waves are scaled by where the water runs at `speed` and the set was built for `reference`:
 * with the square of the speed, as their length and height go; nearly still where the water is. 1 for wind waves.
 */
fn flowWaveScale(speed: f32, reference: f32) -> f32 {
    if (reference <= 0.0) { return 1.0; }
    let s = speed / reference;
    return clamp(s * s, 0.04, 1.6);
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

// ---- the waves (physics/water/waves.ts waveSurfaceAt, operation for operation) ---------------------------

/** Wave `i`'s phase (waves.ts wavePhase). */
fn wavePhase(i: i32) -> f32 {
    return fract(f32(i) * 0.61803398875 + 0.1) * 6.2831853;
}


/**
 * The waves' height above the resting level at `p`, each weighted by what a grid of `cell` metres can draw.
 * Each wave is exp(sin - 1) less its mean; the point the next wave is read at is dragged along this one by
 * its slope, so the short waves crowd onto the long ones' crests.
 */
fn waveHeight(p0: vec2<f32>, t: f32, scale: f32, cell: f32) -> f32 {
    var p = p0;
    var h = 0.0;
    let count = min(i32(u_wv.u_waveParams.x), MAX_WAVES);
    for (var i = 0; i < MAX_WAVES; i++) {
        if (i >= count) { break; }
        let w = u_wv.u_waves[i];
        let kw = u_wv.u_waveK[i];
        let band = bandLimit(kw.y, cell);
        if (band <= 0.0) { break; }   // longest first: every wave after this one is shorter still
        let a = w.z * scale * band;
        let bend = WAVE_BEND * (valueNoise(bendAt(i, kw.y, p0)) - 0.5);
        let theta = kw.x * dot(w.xy, p) - kw.z * t + wavePhase(i) + bend;
        let s = sin(theta);
        let c = cos(theta);
        let e = exp(s - 1.0);
        h += a * (e - WAVE_MEAN);
        p += w.xy * (-w.w * a * e * c);
    }
    return h;
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
    let share = u_wv.u_swell.w;
    var depth = 1e4;
    var grad = vec2<f32>(0.0);
    var current = vec2<f32>(0.0);
    let ocean = u_wv.u_vOcean.y > 0.5;
    let uvw = infoUvw(xz, u_wv.u_vInfoOrigin, u_wv.u_vInfoSize);
    if (u_wv.u_vInfoOrigin.w > 0.5 && (insideInfo(uvw) || !ocean)) {
        let c = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0));
        let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, c, 0.0);
        let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, c, 0.0);
        edge = i0.w;
        // The sea's depth over the beach (its shore grid's bed): the cap below. Physics reads the same grid.
        if (ocean) { depth = max(0.0, u_wv.u_vOcean.x - (i1.z + u_wv.u_vInfoSize.z)); }
        if (!ocean) {
            surface = i0.x + i1.x + u_wv.u_vInfoSize.z;
            current = i0.yz;
            // The resting surface's own slope, a cell either way: a river runs downhill, a waterfall drops.
            let du = vec3<f32>(1.0 / u_wv.u_vInfoSize.x, 0.0, 0.0);
            let dv = vec3<f32>(0.0, 1.0 / u_wv.u_vInfoSize.y, 0.0);
            let hx = restHeight(clamp(c + du, vec3<f32>(0.0), vec3<f32>(1.0))) - restHeight(clamp(c - du, vec3<f32>(0.0), vec3<f32>(1.0)));
            let hz = restHeight(clamp(c + dv, vec3<f32>(0.0), vec3<f32>(1.0))) - restHeight(clamp(c - dv, vec3<f32>(0.0), vec3<f32>(1.0)));
            grad = vec2<f32>(hx, hz) / (2.0 * u_wv.u_vInfoOrigin.z);
        }
    }
    // The local flow round the camera (render/localFlow.ts): the surface's lift where the water piles against
    // what stands in it, draws down past it and pours over a boulder; and the current its waves ride there.
    // Read over the mesh's own cell, as the live waves are.
    var bulk = 0.0;
    if (u_wv.u_vLocal.x > 0.5 && !ocean) {
        let luv = (xz - u_wv.u_vLive.xy) * u_wv.u_vLive.z;
        let inside = min(min(luv.x, luv.y), min(1.0 - luv.x, 1.0 - luv.y));
        if (inside > 0.0) {
            let o = 0.25 * cell * u_wv.u_vLive.z;
            let m = 0.25 * (textureSampleLevel(u_flow_texture, u_flow_sampler, luv + vec2<f32>(o, o), 0.0)
                          + textureSampleLevel(u_flow_texture, u_flow_sampler, luv + vec2<f32>(-o, o), 0.0)
                          + textureSampleLevel(u_flow_texture, u_flow_sampler, luv + vec2<f32>(o, -o), 0.0)
                          + textureSampleLevel(u_flow_texture, u_flow_sampler, luv + vec2<f32>(-o, -o), 0.0));
            let w = smoothstep(0.0, 0.08, inside);
            bulk = m.x * w;
            current = mix(current, m.yz, clamp(m.w, 0.0, 1.0) * w);
        }
    }
    // Shoaling: the waves die down toward the shore, as the CPU's waveHeight fades them, and never stand
    // taller than the water is deep allows (a wave breaks at about 0.8 of the depth; 0.4 of it is its crest).
    let fadeW = u_wv.u_waveParams.w;
    let fade = select(1.0, clamp(edge / max(fadeW, 1e-3), 0.0, 1.0), fadeW > 0.0);
    let cap = clamp(0.4 * depth / max(u_wv.u_swell.z, 1e-3), 0.0, 1.0);
    // A river's waves are its current's: scaled by how fast the water runs here, and carried along by it.
    let scale = u_wv.u_waveParams.z * share * fade * fade * (3.0 - 2.0 * fade) * cap * flowWaveScale(length(current), u_wv.u_vFlow.y);
    let t = u_wv.u_waveParams.y;
    let ride = current * u_wv.u_vFlow.x;
    var lift = 0.0;
    if (dot(ride, ride) > 1e-6) {
        let ph = flowPhases(xz, t);
        lift = waveHeight(xz - ride * ph.a, t, scale, cell) * ph.wa + waveHeight(xz - ride * ph.b + FLOW_APART, t, scale, cell) * ph.wb;
    } else {
        lift = waveHeight(xz, t, scale, cell);
    }
    // The live waves round the camera: read over the mesh's own cell, so a coarse mesh takes their mean.
    if (u_wv.u_vLive.w > 0.0 && !ocean) {
        let luv = (xz - u_wv.u_vLive.xy) * u_wv.u_vLive.z;
        let inside = min(min(luv.x, luv.y), min(1.0 - luv.x, 1.0 - luv.y));
        if (inside > 0.0) {
            let o = 0.25 * cell * u_wv.u_vLive.z;
            let h = textureSampleLevel(u_live_texture, u_live_sampler, luv + vec2<f32>(o, o), 0.0).x
                  + textureSampleLevel(u_live_texture, u_live_sampler, luv + vec2<f32>(-o, o), 0.0).x
                  + textureSampleLevel(u_live_texture, u_live_sampler, luv + vec2<f32>(o, -o), 0.0).x
                  + textureSampleLevel(u_live_texture, u_live_sampler, luv + vec2<f32>(-o, -o), 0.0).x;
            lift += 0.25 * h * u_wv.u_vLive.w * smoothstep(0.0, 0.08, inside) * fade;
        }
    }
    var p = vec3<f32>(xz.x, surface + lift + bulk, xz.y);
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

/** What the waves give a pixel. */
struct Waves {
    /** Metres above the resting level. */
    height: f32,
    /** d height / dx, d height / dz. */
    slope: vec2<f32>,
    /** How much the drag has squeezed the water here (1 - the warp's determinant): high on crowded crests. */
    squeeze: f32,
    /** The slope variance of the waves too small for this pixel: roughness. */
    unresolved: f32,
};

/**
 * The waves at `p0` for a pixel of `footprint` metres (waveHeight, with each wave faded where the pixel no
 * longer resolves it). The slope is exact: the drag's warp is carried along as its Jacobian, so the slopes
 * of the short waves crowded onto a crest steepen as they should.
 */
fn waveStack(p0: vec2<f32>, t: f32, scale: f32, footprint: f32) -> Waves {
    var r: Waves;
    var p = p0;
    var J = mat2x2<f32>(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0));
    var h = 0.0;
    var g = vec2<f32>(0.0);
    var removed = 0.0;
    let count = min(i32(u_wf.u_fWaveParams.x), MAX_WAVES);
    for (var i = 0; i < MAX_WAVES; i++) {
        if (i >= count) { break; }
        let w = u_wf.u_fWaves[i];
        let kw = u_wf.u_fWaveK[i];
        let k = kw.x;
        let lambda = kw.y;
        let band = smoothstep(2.0 * footprint, 6.0 * footprint, lambda);
        // Longest first: from the first wave the pixel cannot draw, none after it is drawn either. Their
        // slope variance, summed on the CPU, is the roughness they leave.
        if (band <= 0.0) { removed += kw.w * scale * scale; break; }
        let a = w.z * scale;
        removed += (1.0 - band * band) * k * k * a * a * WAVE_SLOPE_VARIANCE;
        let bend = valueNoiseGrad(bendAt(i, lambda, p0));
        let theta = k * dot(w.xy, p) - kw.z * t + wavePhase(i) + WAVE_BEND * (bend.x - 0.5);
        let s = sin(theta);
        let c = cos(theta);
        let e = exp(s - 1.0);
        // d theta / d p0, through the warp of the waves before, and the bend of the crest.
        let dTheta = vec2<f32>(dot(J[0], w.xy), dot(J[1], w.xy)) * k + bend.yz * (WAVE_BEND / lambda);
        let ab = a * band;
        h += ab * (e - WAVE_MEAN);
        g += dTheta * (ab * e * c);
        let d = w.xy;
        p += d * (-w.w * ab * e * c);
        let q = dTheta * (-w.w * ab * e * (c * c - s));
        J = J + mat2x2<f32>(d * q.x, d * q.y);
    }
    r.height = h;
    r.slope = g;
    r.squeeze = 1.0 - determinant(J);
    r.unresolved = removed;
    return r;
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
            surface = i0.x + i1.x + u_wf.u_fInfoSize.z;
            flow = i0.yz;
            foamBake = i1.y;
            wet = i1.w;
        }
    }
    // A lake or river ends where its grid says it is dry. The ocean is drawn on under the land's edge, a
    // couple of cells in: the landscape's own depth test draws its waterline, exactly, wherever it is. So is
    // baked water, a cell past its wet ones (the bake carries its surface on under the dry ground there):
    // its banks are then the ground's, not the outline of the bake's cells. Where the water beside it is
    // another node's (a river's mouth in its lake), it ends at its own cells as ever.
    if (ocean) {
        if (hasInfo && edge < -2.0 * u_wf.u_fInfoOrigin.z) { discard; }
    } else {
        let past = u_wf.u_misc.w * u_wf.u_fInfoOrigin.z;
        if (edge < -0.01 - past || (wet < 0.5 && (past <= 0.0 || edge > 0.0))) { discard; }
    }
    // A skirt only fills the cracks between tiles out on open water; at the shore it would hang into view.
    if (in.skirt > 0.0 && edge < u_wf.u_fInfoOrigin.z * 3.0) { discard; }
    // The local flow round the camera (render/localFlow.ts): its current is the water's own round what stands
    // in it, so the ripples and the foam part round a post and race down its sides; its lift (the pile, the
    // drawdown, the pillow and the hole) tilts the surface.
    var bulkSlope = vec2<f32>(0.0);
    if (u_wf.u_fLiveGrid.w > 0.5 && !ocean) {
        let luv = (in.rest.xy - u_wf.u_fLive.xy) * u_wf.u_fLive.z;
        let inside = min(min(luv.x, luv.y), min(1.0 - luv.x, 1.0 - luv.y));
        if (inside > 0.0) {
            let w = smoothstep(0.0, 0.08, inside);
            let st = 2.0 * u_wf.u_fLiveGrid.x;
            let here = textureSampleLevel(u_flow_texture, u_flow_sampler, luv, 0.0);
            flow = mix(flow, here.yz, clamp(here.w, 0.0, 1.0) * w);
            let bx = textureSampleLevel(u_flow_texture, u_flow_sampler, luv + vec2<f32>(st, 0.0), 0.0).x
                   - textureSampleLevel(u_flow_texture, u_flow_sampler, luv - vec2<f32>(st, 0.0), 0.0).x;
            let bz = textureSampleLevel(u_flow_texture, u_flow_sampler, luv + vec2<f32>(0.0, st), 0.0).x
                   - textureSampleLevel(u_flow_texture, u_flow_sampler, luv - vec2<f32>(0.0, st), 0.0).x;
            bulkSlope = vec2<f32>(bx, bz) / (4.0 * u_wf.u_fLiveGrid.y) * w;
        }
    }

    let toCam = cam - in.worldPos;
    let viewDist = length(toCam);
    let V = toCam / max(viewDist, 1e-4);
    // A pixel's footprint on the water, metres: its size at this distance, stretched by a grazing view
    // (the square root of the stretch: the long axis of the footprint runs one way, the waves every way).
    let pixel = viewDist * 2.0 / max(abs(u_wf.u_ssrProjection[1][1]) * u_wf.u_resolution.y, 1.0);
    let grazing = max(abs(V.y), 0.02);
    let footprint = pixel / sqrt(grazing);

    // The slopes: the resting surface's, the waves', the rain's. On a river the waves ride the current: two
    // phases of the flow map (Vlachos), half a cycle apart, so they move with the water and never stretch;
    // each pixel's cycle is offset by a slow noise, so a river does not pulse as a whole.
    let scale = in.rest.z;
    let f = flow * u_wf.u_detailParams.y;
    let moving = dot(f, f) > 1e-6;
    let ph = flowPhases(in.rest.xy, t);
    var waves: Waves;
    if (moving) {
        waves = waveStack(in.rest.xy - f * ph.a, t, scale, footprint);
        let w1 = waveStack(in.rest.xy - f * ph.b + FLOW_APART, t, scale, footprint);
        waves.height = waves.height * ph.wa + w1.height * ph.wb;
        waves.slope = waves.slope * ph.wa + w1.slope * ph.wb;
        waves.squeeze = mix(waves.squeeze, w1.squeeze, ph.fade);
        waves.unresolved = mix(waves.unresolved, w1.unresolved, ph.fade);
    } else {
        waves = waveStack(in.rest.xy, t, scale, footprint);
    }
    // Where on the waves this is: 0 deep in a trough, 0.5 at the resting level, 1 on a tall crest.
    let waveSd = max(u_wf.u_fWaveParams.w * scale, 1e-3);
    let crest = clamp(0.5 + waves.height / (4.0 * waveSd), 0.0, 1.0);
    var slope = in.grad + waves.slope + bulkSlope;
    // The live waves round the camera: their slopes, their foam, and the turbulence that stirs them.
    var live = vec4<f32>(0.0);
    var liveIn = 0.0;
    if (u_wf.u_fLive.w > 0.0 && !ocean) {
        let luv = (in.rest.xy - u_wf.u_fLive.xy) * u_wf.u_fLive.z;
        let inside = min(min(luv.x, luv.y), min(1.0 - luv.x, 1.0 - luv.y));
        if (inside > 0.0) {
            liveIn = smoothstep(0.0, 0.08, inside);
            let st = u_wf.u_fLiveGrid.x;
            live = textureSampleLevel(u_live_texture, u_live_sampler, luv, 0.0);
            let lx = textureSampleLevel(u_live_texture, u_live_sampler, luv + vec2<f32>(st, 0.0), 0.0).x
                   - textureSampleLevel(u_live_texture, u_live_sampler, luv - vec2<f32>(st, 0.0), 0.0).x;
            let lz = textureSampleLevel(u_live_texture, u_live_sampler, luv + vec2<f32>(0.0, st), 0.0).x
                   - textureSampleLevel(u_live_texture, u_live_sampler, luv - vec2<f32>(0.0, st), 0.0).x;
            // A pixel too coarse for the simulation's texels cannot draw their slopes.
            let seen = 1.0 - smoothstep(u_wf.u_fLiveGrid.y, 4.0 * u_wf.u_fLiveGrid.y, footprint);
            slope += vec2<f32>(lx, lz) / (2.0 * u_wf.u_fLiveGrid.y) * (u_wf.u_fLive.w * liveIn * seen);
        }
    }
    // Ripples on running water: the small waves its turbulence and the wind keep on it, a field of them made
    // from a spectrum (the detail texture's slopes) at two sizes, carried with the current. More of them the
    // faster the water runs; and a boil, where water wells up, is smooth, its ripples crowded at its edge.
    let running = length(flow);
    if (moving && u_wf.u_surfaceParams.w > 0.0) {
        let span = max(u_wf.u_detailParams.x, 0.05) * 3.0;
        let lod = clamp(log2(footprint / (span / 256.0)), 0.0, 8.0);
        let pa = in.rest.xy - f * ph.a;
        let pb = in.rest.xy - f * ph.b + FLOW_APART;
        let a0 = textureSampleLevel(u_detail_texture, u_detail_sampler, pa / span, lod).xy - vec2<f32>(0.5);
        let b0 = textureSampleLevel(u_detail_texture, u_detail_sampler, pb / span, lod).xy - vec2<f32>(0.5);
        // The finer copy is turned a quarter round, so the two never line up.
        let a1 = textureSampleLevel(u_detail_texture, u_detail_sampler, pa.yx / (span * 0.31) + vec2<f32>(0.37, 0.11), lod + 1.7).yx - vec2<f32>(0.5);
        let b1 = textureSampleLevel(u_detail_texture, u_detail_sampler, pb.yx / (span * 0.31) + vec2<f32>(0.37, 0.11), lod + 1.7).yx - vec2<f32>(0.5);
        let ripple = (a0 + a1 * 0.7) * ph.wa + (b0 + b1 * 0.7) * ph.wb;
        let stirred = mix(1.0, 0.35 + 1.5 * smoothstep(0.7, -0.5, live.z), liveIn);
        // A lake's slow drift raises none: its ripples are the wind's, in its waves.
        let much = u_wf.u_surfaceParams.w * (0.25 + 0.75 * smoothstep(0.1, 1.8, running)) * stirred * smoothstep(0.08, 0.4, running);
        slope += ripple * (1.1 * much);
    }
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
    var N = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
    if (below) { N = -N; }
    let NoV = clamp(dot(N, V), 1e-3, 1.0);

    // Roughness: the surface's own (a floor, so the sun never collapses to a single pixel), the rain's,
    // and every slope too small for this pixel to draw (Bruneton: their variance is the highlight's width).
    let unresolved = waves.unresolved + weather.x * 0.01 * u_wf.u_detailParams.z + surfVariance;
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
    // Fast water is churned: air and silt in it scatter the light, so it lightens toward its shallow colour and
    // hides what is under it (Unreal's river material does the same with its velocity scattering).
    // So is water with air in it: under its foam, and between the foam's streaks, whitewater is pale and
    // milky, not clear. How much air: the foam it carries (the live simulation's round the camera, the
    // bake's past it).
    let aired = clamp(mix(foamBake, live.w, liveIn) * u_wf.u_foamParams.y * 1.3, 0.0, 1.0) * smoothstep(0.15, 0.5, length(flow));
    let rush = clamp(max(smoothstep(0.6, 3.0, length(flow)), aired * 0.9) * u_wf.u_misc.y, 0.0, 1.0);
    let transmit = exp(-sigma * thickness) * (1.0 - 0.5 * rush);
    // The light going down into the water (the sky's and the sun's, by its height and its shadow), and the
    // share of it the water scatters back up: the shallow and deep colours are that share (reflectances,
    // as an ocean's is a few percent in the blue), and what leaves a surface lit by an irradiance E is
    // E / pi of radiance. So deep water stays as dark as a real sea's, and the sky it reflects, not paint,
    // gives it its colour away from the vertical.
    let lightIn = (u_wf.u_ambient.rgb + u_wf.u_sunColor.rgb * sunUp * mix(0.35, 1.0, sunVis)) * pre;
    // The waves' crests glow and their troughs go dark (as in every reference sea: afl_ext's scattering grows
    // with the height above the trough, TDM's Seascape and Enscape's add the water's colour with it): light
    // enters a crest from the sides and the back and leaves through its thin top, while a trough is lit only
    // from above through its walls. The mean over a wave stays the scatter the colours say.
    let crestGlow = mix(0.3, 1.7, crest);
    let body = mix(u_wf.u_shallowColor.rgb, u_wf.u_deepColor.rgb, clamp(1.0 - exp(-thickness / clarity), 0.0, 1.0));
    let scatter = mix(body, u_wf.u_shallowColor.rgb * 1.3, rush * 0.5) * lightIn / PI * crestGlow;
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
            // Carried by the current on the same two phases as the waves that make them.
            let cp = bed.xz / cScale * 2.0;
            let cv = f * (0.6 / cScale);
            var c = 0.0;
            if (moving) { c = mix(causticAt(cp - cv * ph.a, t * 0.8), causticAt(cp - cv * ph.b + FLOW_APART, t * 0.8), ph.fade); }
            else { c = causticAt(cp, t * 0.8); }
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
            let lines = 0.5 + 0.5 * sin(edge * 2.5 + t * 1.6 + waves.height / waveSd * 0.8);
            // Along a river the bank's foam is no even hem: it gathers in the slack places and is swept clean
            // in between (a slow noise along the bank, drifting), and it is the water's, not the wet ground's
            // past its edge (where a baked surface is carried on under the bank).
            var patchy = 1.0;
            if (u_wf.u_fLiveGrid.z > 0.5) {
                let n0 = valueNoise(in.rest.xy * 0.8 + vec2<f32>(t * 0.07, -t * 0.05));
                let n1 = valueNoise(in.rest.xy * 2.3 - vec2<f32>(t * 0.11, t * 0.04));
                patchy = smoothstep(0.45, 0.7, n0 * 0.7 + n1 * 0.3) * smoothstep(-0.5 * u_wf.u_fInfoOrigin.z, 0.0, edge);
            }
            amount = max(amount, band * mix(0.55, 1.0, lines) * patchy);
        }
    }
    // Whitecaps: where the long waves crowd the short ones hardest, on their crests.
    amount = max(amount, smoothstep(0.35, 0.7, waves.squeeze) * smoothstep(0.55, 0.8, crest) * u_wf.u_foamParams.x);
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
    // The current's own foam: what the water churned up upstream and carried here. Round the camera it is the
    // live simulation's, carried and drawn out into streaks by the current itself; past it, the bake's foam,
    // streaked by noise smeared along the flow. Gone where the water is nearly still: foam that sits does not
    // read as a river's.
    // However much there is, it never sheets the water over: the whitest rapid is rafts and streaks with
    // pale water between them (the share it covers grows with the amount and levels off under two thirds).
    let flowing = smoothstep(0.15, 0.5, running);
    // (The simulation's foam settles at about a third of the bake's figure on the whole, in streaks; past
    // it the bake's own is drawn to match.)
    let churnFar = 0.66 * (1.0 - exp(-2.4 * foamBake * 0.35 * u_wf.u_foamParams.y)) * flowing;
    let churnLive = 0.66 * (1.0 - exp(-2.4 * live.w * u_wf.u_foamParams.y)) * flowing;
    if (amount > 0.0 || churnFar > 0.0 || churnLive > 0.0) {
        // The foam's texture drifts with the water, on the same two phases as the waves: one phase alone
        // would jump back every cycle. Each is drawn from its amount, then the two are cross-faded, so the
        // bubbles stay crisp through the fade.
        let pa = in.rest.xy - f * ph.a;
        var pb = pa;
        if (moving) { pb = in.rest.xy - f * ph.b + FLOW_APART; }
        var farA = churnFar;
        var farB = churnFar;
        if (churnFar > 0.0 && liveIn < 1.0) {
            let along = normalize(flow + vec2<f32>(1e-5, 0.0));
            farA = churnFar * (0.45 + 1.1 * whiteStreaks(pa, along));
            farB = churnFar * (0.45 + 1.1 * whiteStreaks(pb, along));
        }
        // The foam texture's tile (the material's Foam size): at a metre and a half its web's widest holes
        // are a hand across and its bubbles a centimetre or two.
        let size = max(u_wf.u_detailParams.x, 0.05);
        let fa = foamCover(pa, max(amount, mix(farA, churnLive, liveIn)), size, footprint);
        let fb = foamCover(pb, max(amount, mix(farB, churnLive, liveIn)), size, footprint);
        let foam = mix(fa, fb, ph.fade);
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
