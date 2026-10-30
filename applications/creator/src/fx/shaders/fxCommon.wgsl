// Shared by every FX Creator fluid kernel: the uniform block, grid indexing and the turbulence hash.
// The CPU reference (fluidCpu.ts) is the readable statement of each step; these mirror it.
//
// Fields are storage buffers, not 3D textures: every kernel reads its neighbours by index, nothing
// needs hardware filtering, and an array<vec4<f32>> holds a velocity or a scalar triple with no format
// questions (rgba32float storage textures are not filterable; r32float is not in the engine's formats).
// Bindings are declared in each kernel, not here: the engine builds compute pipelines with an `auto`
// layout, which keeps only what a kernel uses, so a binding declared and unused would be rejected.

struct FxUniforms {
    dims: vec4<u32>,       // nx, ny, nz, seed
    emitter: vec4<f32>,    // centre x, y, z, radius (voxels)
    emit: vec4<f32>,       // fuel, heat, smoke per second, upward speed
    turb: vec4<f32>,       // strength, scale per voxel, time offset, shape (0 sphere, 1 disc)
    burn: vec4<f32>,       // ignition, burn rate, heat release, smoke yield
    forces: vec4<f32>,     // buoyancy, smoke weight, vorticity, wind
    diss: vec4<f32>,       // cooling keep, smoke keep, velocity keep (per step), dt
    flags: vec4<f32>,      // emitting (0/1), absorption, emission, emission range
    look: vec4<f32>,       // smoke rgb, ambient
    light: vec4<f32>,      // toward-light xyz, fire opacity
    cam_dir: vec4<f32>,    // view dir xyz, half extent
    cam_right: vec4<f32>,  // right xyz, ray start distance
    cam_up: vec4<f32>,     // up xyz, tile size
    center: vec4<f32>,     // domain centre xyz, ray step
    light_dims: vec4<u32>, // half-res light grid lx, ly, lz
    extra: vec4<f32>,      // emitter noise, expansion, sim time, SOR omega
    wind: vec4<f32>,       // scene wind vx, vz (voxels/s), gustiness, gust scale (voxels)
    wind2: vec4<f32>,      // gust speed (voxels/s), has wind (0/1), has solids (0/1), MacCormack (0/1)
    look2: vec4<f32>,      // anisotropy, scattering octaves, fire glow, detail strength
    look3: vec4<f32>,      // detail scale, -, -, -
    real1: vec4<f32>,      // open boundaries (0/1), disturbance, disturbance block (voxels), disturbance phase
    real2: vec4<f32>,      // shredding, diffusion (per step), flame kept per step, radiative cooling
    real3: vec4<f32>,      // flicker (emitter multiplier), condensation, dew point, dust settling (voxels/s)
    real4: vec4<f32>,      // blast (this step), ground drag, albedo, powder
    real5: vec4<f32>,      // flame shape, fire intensity, sky occlusion, -
    detail: vec4<f32>,     // reset set A this step (0/1), reset set B (0/1), set A's cross-fade weight, -
    real6: vec4<f32>,      // turbulence on smoke, turbulence detail, max temperature, ambient temperature
    look4: vec4<f32>,      // absorption scale rgb (mean 1), fire soot mask
    look5: vec4<f32>,      // blue core, sharpen, smooth sampling (0/1), glow threshold
    look6: vec4<f32>,      // blue core rgb, render mode (0 colour, 1 lighting, 2 emission, 3 motion)
    look7: vec4<f32>,      // motion encoding (voxels/s -> encoded units), -, -, -
};

/** realism.ts `FIRE_EMIT`: the fire's brightness per unit emission per voxel, whatever its opacity. */
const FIRE_EMIT: f32 = 0.6;

/** realism.ts `blueCoreSource`. */
fn blue_core_source(e: f32, fuel: f32) -> f32 {
    if (e <= 0.0 || fuel <= 0.0) { return 0.0; }
    return min(1.0, fuel * 3.0) * (1.0 - 0.7 * e);
}

/** realism.ts `glowSource`. */
fn glow_source(e: f32) -> f32 {
    let th = u.look5.w;
    if (th <= 0.0) { return e; }
    return max(0.0, (e - th) / (1.0 - th));
}

fn open_sides() -> bool { return u.real1.x > 0.5; }

/** realism.ts `emissionTemperature`: the temperature the fire is drawn at, shaped by the flame field. */
fn emission_temperature(t: f32, flame: f32) -> f32 {
    let shape = u.real5.x;
    if (shape <= 0.0 || t <= u.burn.x) { return t; }
    let f = clamp(flame * 1.5, 0.0, 1.0);
    return u.burn.x + (t - u.burn.x) * (1.0 - shape + shape * f);
}

/** realism.ts `powderTerm`. */
fn powder_term(d: f32) -> f32 {
    let pw = u.real4.w;
    if (pw <= 0.0) { return 1.0; }
    return 1.0 - pw + pw * (1.0 - exp(-2.0 * d * u.flags.y));
}

fn has_solids() -> bool { return u.wind2.z > 0.5; }

/** The scene wind's gust factor -- fluidCpu.ts `gustAt`. */
fn gust_at(p: vec3<f32>) -> f32 {
    let gi = u.wind.z;
    if (gi <= 0.0) { return 1.0; }
    let len = max(length(u.wind.xy), 1e-6);
    let s = 1.0 / max(0.5, u.wind.w);
    let shift = u.wind2.x * u.extra.z;
    let q = vec3<f32>((p.x - u.wind.x / len * shift) * s, p.y * s * 0.5, (p.z - u.wind.y / len * shift) * s);
    return 1.0 - gi + gi * (0.5 + 0.5 * value_noise3(q, u.dims.w + 11u));
}

fn nx() -> u32 { return u.dims.x; }
fn ny() -> u32 { return u.dims.y; }
fn nz() -> u32 { return u.dims.z; }

fn idx(x: u32, y: u32, z: u32) -> u32 { return x + u.dims.x * (y + u.dims.y * z); }

/** Index of a neighbour, clamped into the grid (Neumann reads at the walls). */
fn idxc(x: i32, y: i32, z: i32) -> u32 {
    let cx = u32(clamp(x, 0, i32(u.dims.x) - 1));
    let cy = u32(clamp(y, 0, i32(u.dims.y) - 1));
    let cz = u32(clamp(z, 0, i32(u.dims.z) - 1));
    return idx(cx, cy, cz);
}

fn in_grid(g: vec3<u32>) -> bool { return g.x < u.dims.x && g.y < u.dims.y && g.z < u.dims.z; }

/** The same integer hash as fluidCpu.ts `hash3`. */
fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u) ^ (bitcast<u32>(z) * 0xcb1ab31fu) ^ (seed * 0x165667b1u);
    h = (h ^ (h >> 13u)) * 0x5bd1e995u;
    h = h ^ (h >> 15u);
    return f32(h) / 4294967296.0;
}

fn smooth3(t: vec3<f32>) -> vec3<f32> { return t * t * (3.0 - 2.0 * t); }

/** Trilinear value noise in -1..1, as fluidCpu.ts `valueNoise3`. */
fn value_noise3(p: vec3<f32>, seed: u32) -> f32 {
    let i = vec3<i32>(floor(p));
    let f = smooth3(p - floor(p));
    let c000 = hash3(i.x, i.y, i.z, seed);
    let c100 = hash3(i.x + 1, i.y, i.z, seed);
    let c010 = hash3(i.x, i.y + 1, i.z, seed);
    let c110 = hash3(i.x + 1, i.y + 1, i.z, seed);
    let c001 = hash3(i.x, i.y, i.z + 1, seed);
    let c101 = hash3(i.x + 1, i.y, i.z + 1, seed);
    let c011 = hash3(i.x, i.y + 1, i.z + 1, seed);
    let c111 = hash3(i.x + 1, i.y + 1, i.z + 1, seed);
    let x0 = mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y);
    let x1 = mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y);
    return mix(x0, x1, f.z) * 2.0 - 1.0;
}

/** Corner index and weights of a trilinear sample at a voxel-space point, clamped into the grid. */
struct Trilinear { base: vec3<i32>, f: vec3<f32> };

fn trilinear(p: vec3<f32>) -> Trilinear {
    let hi = vec3<f32>(f32(u.dims.x) - 1.0, f32(u.dims.y) - 1.0, f32(u.dims.z) - 1.0);
    let q = clamp(p, vec3<f32>(0.0), hi);
    let b = min(vec3<i32>(floor(q)), vec3<i32>(hi) - vec3<i32>(1));
    return Trilinear(b, q - vec3<f32>(b));
}
