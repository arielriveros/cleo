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
// Everything the bend depends on is per LAYER (shape) or global (wind, time), never per sub-model: a
// tree's bark and its needles are separate models, and they stay attached only because they bend by
// exactly the same function.
//
// Included by chunks/instancedVertex.wgsl and chunks/instancedDepthVertex.wgsl, so a plant and its
// shadow sway together.

struct WindParams {
    /** xy = unit wind direction in world XZ, z = global strength, w = gust wavelength (m). */
    dirStrength: vec4<f32>,
    /** x = time (s), y = previous frame's time, z = gust travel speed (m/s), w = fade end (m). */
    timing: vec4<f32>,
    /** x = lean (tip displacement as a fraction of height at full gust), y = stiffness, zw = unused. */
    response: vec4<f32>,
    /** x = base height (object space), y = plant height (object space), z = fade start (m), w = unused. */
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

/**
 * How far a plant at `origin` leans at time `t`, in units of its own height: gust plus sway, scaled by
 * the global and material strengths and faded with camera distance. Shared by the position and (later)
 * the motion-vector program, which evaluates it at two times.
 */
fn windLean(origin: vec3<f32>, t: f32, w: WindParams) -> f32 {
    let dir = w.dirStrength.xy;
    let wavelength = max(w.dirStrength.w, 0.5);
    let scroll = dir * (w.timing.z * t / wavelength);
    let p = origin.xz / wavelength - scroll;
    let gust = windNoise(p) * 0.7 + windNoise(p * 2.13 + vec2<f32>(17.0, 3.0)) * 0.3;
    let stiffness = max(w.response.y, 0.05);
    let phase = windHash(floor(origin.xz * 4.0)) * 6.2831853;
    let sway = sin(t * (1.7 / stiffness) + phase);
    let lean = w.dirStrength.z * w.response.x * (0.2 + 0.8 * gust + 0.2 * sway) / stiffness;
    let fade = 1.0 - smoothstep(w.shape.z, max(w.timing.w, w.shape.z + 0.001), distance(origin, w.camera.xyz));
    return lean * fade;
}

/**
 * `world` (a vertex already through its instance matrix) displaced by the wind at time `t`. `objY` is
 * the vertex's object-space height and `model` its instance matrix.
 */
fn windDisplace(world: vec3<f32>, objY: f32, model: mat4x4<f32>, t: f32, w: WindParams) -> vec3<f32> {
    let origin = model[3].xyz;
    let base = (model * vec4<f32>(0.0, w.shape.x, 0.0, 1.0)).xyz;
    let heightW = max(w.shape.y, 1e-4) * length(model[1].xyz);
    let h = clamp((objY - w.shape.x) / max(w.shape.y, 1e-4), 0.0, 1.0);
    let bend = windLean(origin, t, w) * h * h * heightW;

    let rel = world - base;
    let len = length(rel);
    var bent = rel;
    bent.x += w.dirStrength.x * bend;
    bent.z += w.dirStrength.y * bend;
    // Back to the original length: the tip sweeps an arc instead of the plant growing as it leans.
    let bl = length(bent);
    return base + select(rel, bent * (len / bl), bl > 1e-5);
}
