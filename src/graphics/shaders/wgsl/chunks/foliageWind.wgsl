// Foliage wind: the vertex displacement every wind variant of the instanced programs runs.
//
// The method is the one most engines ship (Crytek, GPU Gems 3 ch.16; Unreal's SimpleGrassWind), cut
// down to what needs no baked data, and driven by the scene's wind FIELD (chunks/windField.wgsl):
//
//   AIR. The wind field sampled once at the INSTANCE origin, so a whole plant leans as one: the base
//   wind's Perlin gusts rolling across a field along a direction that veers from meadow to meadow, plus
//   the local wind of any Force Field that moves the air. The lean is that air's XZ vector (in units of
//   WIND_REFERENCE_SPEED), so a plant in a whirlwind leans round it and one in a shelter stands still.
//   No texture fetch.
//   SWAY. A per-instance phase (from its position — no instance data) on a slow sine, along the local air,
//   so neighbours never move in lockstep and a calm still breathes.
//   BEND. The plant bends about its BASE: the displacement grows with the square of the height above
//   it, so the root stays planted, and the vector from the base is renormalised to its original length
//   so a blade arcs over rather than stretching.
//   FADE. All of it dies out with distance from the camera, so the renderer can switch distant buckets
//   to the static program without a pop.
//
// Everything the BEND depends on is per LAYER (shape) or global (wind, time), never per sub-model: a
// tree's bark and its needles are separate models, and they stay attached only because they bend by
// exactly the same function (`windPlantAt`, at the instance origin). A LEAVES material then adds its own
// motion on top (windLeafOffset): sprigs swinging more the further they are from the trunk, and a fast
// flutter along the leaf normal. Both vanish at the trunk axis and at the root, so the needles move on
// their branches without leaving them: the trunk sways like a tree while the canopy moves like grass.
//
// INTERACTION rides the same bend: what moves through the foliage (graphics/foliageInteraction.ts) arrives
// as a few stamps -- spheres with a direction, a strength and a birth time -- and `interactLean` leans each
// plant away from the stamps around it, folded a little along the way they were going. The bend dies out
// as exp(-age / recovery), the LAYER's material recovery, so the grass springs back after the walker has
// gone. It joins the wind lean before the arc renormalisation, so a parted blade arcs over like a gusted one.
//
// DROOP is the weather's weight (Material weightDroop x the WeatherNode's rain and snow): the plant bows
// outward from its own axis, through the same arc, so a wet meadow and a snowed-on bush hang lower.
//
// Included by chunks/instancedVertex.wgsl and chunks/instancedDepthVertex.wgsl, so a plant and its
// shadow sway together; each provides the wind sources (windSourceCount / windSourceTexel). Only the
// FOLIAGE variants (Material.Foliage) and the far-card billboards run it.

#include "./windField.wgsl"

struct WindParams {
    /** xy = unit wind direction in world XZ, z = global strength, w = gust wavelength (m). */
    dirStrength: vec4<f32>,
    /** x = time (s), y = previous frame's time, z = gust travel speed (m/s), w = fade end (m). */
    timing: vec4<f32>,
    /**
     * x = lean (tip displacement as a fraction of height at full gust), y = stiffness — both the LAYER's,
     * shared by every part of the plant; z = this material's flutter (0..1), w = its role: 0 the whole
     * plant (bark, a rigid prop), 1 leaves (adds sprig sway and flutter on top of the shared bend).
     */
    response: vec4<f32>,
    /**
     * x = base height, y = plant height, w = plant radius (all object space; radius 0 = a card with no
     * trunk, e.g. a grass billboard); z = fade start (m).
     */
    shape: vec4<f32>,
    /** xyz = camera position, for the distance fade. */
    camera: vec4<f32>,
    /** x = gustiness (0..1), y = veer (radians), z = wind sources in use (windSourceCount), w = 0. */
    field: vec4<f32>,
};

fn windHash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

/** Smooth value noise in [0, 1]. */
fn windNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = windHash(i);
    let b = windHash(i + vec2<f32>(1.0, 0.0));
    let c = windHash(i + vec2<f32>(0.0, 1.0));
    let d = windHash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** The distance fade: 1 near the camera, 0 past the fade end, where the static program takes over. */
fn windFade(origin: vec3<f32>, w: WindParams) -> f32 {
    return 1.0 - smoothstep(w.shape.z, max(w.timing.w, w.shape.z + 0.001), distance(origin, w.camera.xyz));
}

/** What the wind does to one plant, sampled once at its origin and shared by every part of it. */
struct WindPlant {
    /** Tip displacement in XZ, as a fraction of the plant's height (gust, sway, stiffness and fade in). */
    lean: vec2<f32>,
    /** Unit direction of the air at the plant, XZ. */
    dir: vec2<f32>,
    /** The base wind's gust here, 0..1. */
    gust: f32,
    /** The ungusted air speed here, in units of WIND_REFERENCE_SPEED (the old global strength). */
    strength: f32,
    /** The distance fade, 1 near the camera, 0 past the fade end. */
    fade: f32,
};

/**
 * How a plant at `origin` leans at time `t`: the wind field's air there, plus a sway along it, scaled by
 * the layer's lean and stiffness and faded with camera distance. Shared by the colour, depth and shadow
 * programs, which all evaluate it at the instance origin, so a plant and its shadow agree.
 */
fn windPlantAt(origin: vec3<f32>, t: f32, w: WindParams) -> WindPlant {
    let fade = windFade(origin, w);
    if (fade <= 0.0) { return WindPlant(vec2<f32>(0.0), w.dirStrength.xy, 0.0, 0.0, 0.0); }
    let s = windFieldAt(origin, WindFieldParams(w.dirStrength, vec4<f32>(t, w.timing.z, w.field.x, w.field.y)));
    let n = s.velocity.xz / WIND_REFERENCE_SPEED;
    let m = length(n);
    let dir = select(w.dirStrength.xy, n / max(m, 1e-4), m > 1e-4);
    let stiffness = max(w.response.y, 0.05);
    let sway = sin(t * (1.7 / stiffness) + windHash(floor(origin.xz * 4.0)) * 6.2831853);
    let strength = s.steady / WIND_REFERENCE_SPEED;
    let lean = (n + dir * (0.2 * strength * sway)) * (w.response.x / stiffness * fade);
    return WindPlant(lean, dir, s.gust, strength, fade);
}

/** How many stamps `u_interactStamps` carries (graphics/foliageInteraction.ts MAX_INTERACT_STAMPS). */
const INTERACT_STAMPS: i32 = 16;

/**
 * The lean (xz, in units of the plant's height) pushed into a plant at `origin` by the interaction stamps.
 * `params`: x = stamps in use, y = the layer's bend (Material interactBend, 0 rigid), z = its recovery
 * time (s), w = the plant's radius (a stamp reaches the plant's edge, not just its stem). `stamps` holds
 * two vec4s per stamp: [x, y, z, radius] and [dirX, dirZ, strength, birth time].
 */
fn interactLean(origin: vec3<f32>, t: f32, params: vec4<f32>, stamps: array<vec4<f32>, 32>) -> vec2<f32> {
    if (params.y <= 0.0 || params.x < 0.5) { return vec2<f32>(0.0); }
    var lean = vec2<f32>(0.0);
    let n = min(i32(params.x + 0.5), INTERACT_STAMPS);
    for (var i = 0; i < INTERACT_STAMPS; i++) {
        if (i >= n) { break; }
        let a = stamps[2 * i];
        let b = stamps[2 * i + 1];
        let reach = a.w + params.w;
        let d = origin.xz - a.xz;
        let dist = length(d);
        // Out of reach across the ground, or far above or below it (a body flying over the meadow).
        if (dist >= reach || abs(a.y - origin.y) > a.w + 2.5) { continue; }
        let fade = exp(-max(t - b.w, 0.0) / max(params.z, 0.05));
        let w = 1.0 - smoothstep(0.0, reach, dist);
        // Away from the centre, folded a little along the way it was moving.
        let away = select(vec2<f32>(b.x, b.y), d / max(dist, 1e-4), dist > 1e-3);
        let along = vec2<f32>(b.x, b.y);
        let dir = away * 0.75 + along * 0.35;
        let dl = length(dir);
        lean += select(vec2<f32>(0.0), dir / dl, dl > 1e-4) * (w * b.z * fade);
    }
    // Never bent past lying down, however many stamps overlap.
    let l = length(lean);
    return select(lean, lean * (1.3 / l), l > 1.3) * params.y;
}

/** A smoothed triangle wave in [-1, 1] with period 1: the cheap stand-in for sin (GPU Gems 3 ch.16). */
fn windWave(x: f32) -> f32 {
    let f = abs(fract(x + 0.5) * 2.0 - 1.0);
    return f * f * (3.0 - 2.0 * f) * 2.0 - 1.0;
}

/**
 * The LEAVES layers, in world units: a sprig sway and a fast flutter. `obj` is the object-space vertex,
 * `normalW` its unit world normal, `h` its 0..1 height in the plant, `heightW` the plant's world height,
 * `plant` the wind at it (windPlantAt): the sprigs swing along the local air.
 * Weighted by `b`, the distance from the trunk axis (radius 0: by height alone, for a trunkless card),
 * so the inner ends of the branches stay put and the needles never come away from them.
 */
fn windLeafOffset(obj: vec3<f32>, normalW: vec3<f32>, origin: vec3<f32>, h: f32, heightW: f32,
                  t: f32, w: WindParams, plant: WindPlant) -> vec3<f32> {
    let r = w.shape.w;
    let b = select(h, smoothstep(0.15 * r, r, length(obj.xz)) * h, r > 1e-4);
    let flutter = w.response.z * b * plant.fade * plant.strength;
    let gust = plant.gust;
    let stiffness = max(w.response.y, 0.05);

    // Sprigs: clusters about a quarter of the plant's radius across share one phase, so neighbouring
    // needles swing together the way a twig does, not each on its own.
    let cells = select(8.0, 4.0 / max(r, 1e-4), r > 1e-4);
    let cell = floor(obj * cells);
    let phase = windHash(cell.xz + vec2<f32>(cell.y * 7.13, cell.y * 1.71) + origin.xz);
    let swing = windWave(t * (1.6 / stiffness) + phase);
    let lift = windWave(t * (1.1 / stiffness) + phase * 1.7 + 0.25);
    let sprig = flutter * 0.05 * heightW * (0.4 + 0.6 * gust);
    let dir = vec3<f32>(plant.dir.x, 0.0, plant.dir.y);
    let sway = (dir * swing + vec3<f32>(0.0, 0.35 * lift, 0.0)) * sprig;

    // Flutter: fast and tiny, along the normal, with a phase per vertex so adjacent cards shimmer apart.
    let shimmerPhase = windHash(obj.xz * 37.0 + vec2<f32>(obj.y * 11.0, 0.0)) * 6.2831853;
    let shimmer = sin(t * 44.0 + shimmerPhase) * flutter * 0.004 * heightW * (0.5 + 0.5 * gust);
    return sway + normalW * shimmer;
}

/**
 * `world` (a vertex already through its instance matrix) displaced by the wind at time `t` — `plant`,
 * from windPlantAt at the instance origin —, by `push`, the interaction lean from `interactLean`, and by
 * `droop`, the weather's weight as a fraction of the plant's height. `obj` is the object-space vertex,
 * `normalW` its unit world normal and `model` its instance matrix.
 */
fn windDisplace(world: vec3<f32>, obj: vec3<f32>, normalW: vec3<f32>, model: mat4x4<f32>, t: f32,
                w: WindParams, push: vec2<f32>, droop: f32, plant: WindPlant) -> vec3<f32> {
    let origin = model[3].xyz;
    let base = (model * vec4<f32>(0.0, w.shape.x, 0.0, 1.0)).xyz;
    let heightW = max(w.shape.y, 1e-4) * length(model[1].xyz);
    let h = clamp((obj.y - w.shape.x) / max(w.shape.y, 1e-4), 0.0, 1.0);
    let bend = plant.lean * (h * h * heightW);

    let rel = world - base;
    let len = length(rel);
    var bent = rel;
    bent.x += bend.x + push.x * h * h * heightW;
    bent.z += bend.y + push.y * h * h * heightW;
    if (droop > 0.0) {
        // Outward from the plant's own axis (a card with no axis: a direction of its own), and through the
        // arc below, so the tips bow down rather than stretch out.
        let out2 = rel.xz;
        let ol = length(out2);
        let a = windHash(origin.xz) * 6.2831853;
        let away = select(vec2<f32>(cos(a), sin(a)), out2 / max(ol, 1e-4), ol > 0.02 * heightW);
        bent.x += away.x * droop * h * h * heightW;
        bent.z += away.y * droop * h * h * heightW;
    }
    // Back to the original length: the tip sweeps an arc instead of the plant growing as it leans.
    let bl = length(bent);
    let trunk = base + select(rel, bent * (len / bl), bl > 1e-5);
    if (w.response.w < 0.5) { return trunk; }
    return trunk + windLeafOffset(obj, normalW, origin, h, heightW, t, w, plant);
}
