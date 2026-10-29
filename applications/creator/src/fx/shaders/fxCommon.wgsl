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
};

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
