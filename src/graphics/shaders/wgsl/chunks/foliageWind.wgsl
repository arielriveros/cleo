// Foliage wind: the vertex displacement every wind variant of the instanced programs runs.
//
// The method is the one most engines ship (Crytek, GPU Gems 3 ch.16; Unreal's SimpleGrassWind), cut
// down to what needs no baked data:
//
//   GUSTS. A 2D value noise scrolled along the wind direction and sampled at the INSTANCE origin, so a
//   whole plant leans as one and gusts visibly roll across a field as waves. No texture fetch.
//   SWAY. A per-instance phase (from its position — no instance data) on a slow sine, so neighbours
//   never move in lockstep and a calm still breathes.
//   BEND. The plant bends about its BASE: the displacement grows with the square of the height above
//   it, so the root stays planted, and the vector from the base is renormalised to its original length
//   so a blade arcs over rather than stretching.
//   FADE. All of it dies out with distance from the camera, so the renderer can switch distant buckets
//   to the static program without a pop.
//
// Everything the BEND depends on is per LAYER (shape) or global (wind, time), never per sub-model: a
// tree's bark and its needles are separate models, and they stay attached only because they bend by
// exactly the same function. A LEAVES material then adds its own motion on top (windLeafOffset):
// sprigs swinging more the further they are from the trunk, and a fast flutter along the leaf normal.
// Both vanish at the trunk axis and at the root, so the needles move on their branches without leaving
// them: the trunk sways like a tree while the canopy moves like grass.
//
// Included by chunks/instancedVertex.wgsl and chunks/instancedDepthVertex.wgsl, so a plant and its
// shadow sway together.

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

/** The gust at a plant's origin, 0..1: two octaves of noise scrolled along the wind. */
fn windGust(origin: vec3<f32>, t: f32, w: WindParams) -> f32 {
    let dir = w.dirStrength.xy;
    let wavelength = max(w.dirStrength.w, 0.5);
    let scroll = dir * (w.timing.z * t / wavelength);
    let p = origin.xz / wavelength - scroll;
    return windNoise(p) * 0.7 + windNoise(p * 2.13 + vec2<f32>(17.0, 3.0)) * 0.3;
}

/**
 * How far a plant at `origin` leans at time `t`, in units of its own height: gust plus sway, scaled by
 * the global and material strengths and faded with camera distance. Shared by the position and (later)
 * the motion-vector program, which evaluates it at two times.
 */
fn windLean(origin: vec3<f32>, t: f32, w: WindParams) -> f32 {
    let gust = windGust(origin, t, w);
    let stiffness = max(w.response.y, 0.05);
    let phase = windHash(floor(origin.xz * 4.0)) * 6.2831853;
    let sway = sin(t * (1.7 / stiffness) + phase);
    let lean = w.dirStrength.z * w.response.x * (0.2 + 0.8 * gust + 0.2 * sway) / stiffness;
    return lean * windFade(origin, w);
}

/** A smoothed triangle wave in [-1, 1] with period 1: the cheap stand-in for sin (GPU Gems 3 ch.16). */
fn windWave(x: f32) -> f32 {
    let f = abs(fract(x + 0.5) * 2.0 - 1.0);
    return f * f * (3.0 - 2.0 * f) * 2.0 - 1.0;
}

/**
 * The LEAVES layers, in world units: a sprig sway and a fast flutter. `obj` is the object-space vertex,
 * `normalW` its unit world normal, `h` its 0..1 height in the plant, `heightW` the plant's world height.
 * Weighted by `b`, the distance from the trunk axis (radius 0: by height alone, for a trunkless card),
 * so the inner ends of the branches stay put and the needles never come away from them.
 */
fn windLeafOffset(obj: vec3<f32>, normalW: vec3<f32>, origin: vec3<f32>, h: f32, heightW: f32,
                  t: f32, w: WindParams) -> vec3<f32> {
    let r = w.shape.w;
    let b = select(h, smoothstep(0.15 * r, r, length(obj.xz)) * h, r > 1e-4);
    let flutter = w.response.z * b * windFade(origin, w) * w.dirStrength.z;
    let gust = windGust(origin, t, w);
    let stiffness = max(w.response.y, 0.05);

    // Sprigs: clusters about a quarter of the plant's radius across share one phase, so neighbouring
    // needles swing together the way a twig does, not each on its own.
    let cells = select(8.0, 4.0 / max(r, 1e-4), r > 1e-4);
    let cell = floor(obj * cells);
    let phase = windHash(cell.xz + vec2<f32>(cell.y * 7.13, cell.y * 1.71) + origin.xz);
    let swing = windWave(t * (1.6 / stiffness) + phase);
    let lift = windWave(t * (1.1 / stiffness) + phase * 1.7 + 0.25);
    let sprig = flutter * 0.05 * heightW * (0.4 + 0.6 * gust);
    let dir = vec3<f32>(w.dirStrength.x, 0.0, w.dirStrength.y);
    let sway = (dir * swing + vec3<f32>(0.0, 0.35 * lift, 0.0)) * sprig;

    // Flutter: fast and tiny, along the normal, with a phase per vertex so adjacent cards shimmer apart.
    let shimmerPhase = windHash(obj.xz * 37.0 + vec2<f32>(obj.y * 11.0, 0.0)) * 6.2831853;
    let shimmer = sin(t * 44.0 + shimmerPhase) * flutter * 0.004 * heightW * (0.5 + 0.5 * gust);
    return sway + normalW * shimmer;
}

/**
 * `world` (a vertex already through its instance matrix) displaced by the wind at time `t`. `obj` is
 * the object-space vertex, `normalW` its unit world normal and `model` its instance matrix.
 */
fn windDisplace(world: vec3<f32>, obj: vec3<f32>, normalW: vec3<f32>, model: mat4x4<f32>, t: f32,
                w: WindParams) -> vec3<f32> {
    let origin = model[3].xyz;
    let base = (model * vec4<f32>(0.0, w.shape.x, 0.0, 1.0)).xyz;
    let heightW = max(w.shape.y, 1e-4) * length(model[1].xyz);
    let h = clamp((obj.y - w.shape.x) / max(w.shape.y, 1e-4), 0.0, 1.0);
    let bend = windLean(origin, t, w) * h * h * heightW;

    let rel = world - base;
    let len = length(rel);
    var bent = rel;
    bent.x += w.dirStrength.x * bend;
    bent.z += w.dirStrength.y * bend;
    // Back to the original length: the tip sweeps an arc instead of the plant growing as it leans.
    let bl = length(bent);
    let trunk = base + select(rel, bent * (len / bl), bl > 1e-5);
    if (w.response.w < 0.5) { return trunk; }
    return trunk + windLeafOffset(obj, normalW, origin, h, heightW, t, w);
}
