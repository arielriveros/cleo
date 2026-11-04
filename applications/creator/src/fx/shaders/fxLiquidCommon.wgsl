// Shared by every FX Creator LIQUID kernel (liquidGpu.ts): the uniform block, the particle neighbour grid
// and the preview's bodies. liquidCpu.ts is the readable statement of each step; these mirror it, with
// one difference: the CPU relaxes and damps pairs in place (Gauss-Seidel), the GPU gathers every
// particle's correction from the same state and applies them together (Jacobi). The motion is the same
// kind; the drops are not bit for bit the CPU's.
//
// Particles live in fixed slots (a release takes slot `id % capacity`): pos.w is 1 for a live particle, 0
// for a free slot and 2 + k for a release due at substep k; vel.w is its bounces. Each substep the live
// ones are also copied into bucket order (fxLiquidFill.wgsl), where the neighbour steps work, and back
// (fxLiquidScatter.wgsl). `counters` holds the deposits since the last read, the substep, the live count
// and the binned count, then the drops' box in cells (fxLiquidBounds.wgsl: low xyz at 4..6, high at 8..10).
// Bindings are declared in each kernel (auto layouts keep only what a kernel uses).

struct LiquidUniforms {
    counts: vec4<u32>,   // capacity, hash table size - 1, body count, seed
    phys: vec4<f32>,     // dt, interaction radius h (m), rest density, gravity (m/s^2)
    relax: vec4<f32>,    // stiffness, near stiffness (both x (dt / reference step)^2), cohesion, near q
    visc: vec4<f32>,     // sigma (1/s), beta (s/m), air drag (share per step), particle radius (m)
    wind: vec4<f32>,     // wind vx, vz (m/s), floor mode (0 solid, 1 absorb, 2 none), stickiness
    region: vec4<f32>,   // region size x, y, z (m), floor bounce
    floor: vec4<f32>,    // speed kept along the floor on a bounce, stick speed (m/s), max bounces, deposit capacity
    grid: vec4<u32>,     // voxels nx, ny, nz, cells a splat reaches each way
    gridf: vec4<f32>,    // voxel size (m), splat radius (m), surface density, foam from (m/s)
    light: vec4<f32>,    // toward-sun xyz, absorption per voxel inside the liquid
    light_dims: vec4<u32>, // half-resolution light grid lx, ly, lz, -
    origin: vec4<f32>,   // the region's low corner in the stage (bodies are in stage metres), foam span (m/s)
    window: vec4<f32>,   // the preview volume's low corner in the region (m): a window over the drops; the domain's top (m)
    domain: vec4<f32>,   // the drops live inside x0, z0, x1, z1 (region m): where the release can reach, not the region
};

/** The drops' box comes back in cells offset by this, so they stay unsigned (liquidGpu.ts `BOUNDS_BIAS`). */
const BOUNDS_BIAS: i32 = 32768;

const BRICK: i32 = 8;

fn capacity() -> u32 { return u.counts.x; }

/** A slot holding a live particle: 1 (0 is free, 2 + k a release due at substep k). */
fn alive(w: f32) -> bool { return w > 0.5 && w < 1.5; }

/** The neighbour cell of a region point: cells are h across. */
fn cell_of(p: vec3<f32>) -> vec3<i32> { return vec3<i32>(floor(p / u.phys.y)); }

/** Teschner et al. 2003's cell hash, as liquidCpu.ts `cellHash`, into the table. */
fn cell_key(c: vec3<i32>) -> u32 {
    let h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
    return h & u.counts.y;
}

/** The same integer hash as fluidCpu.ts `hash3`. */
fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u) ^ (bitcast<u32>(z) * 0xcb1ab31fu) ^ (seed * 0x165667b1u);
    h = (h ^ (h >> 13u)) * 0x5bd1e995u;
    h = h ^ (h >> 15u);
    return f32(h) / 4294967296.0;
}

fn vidx(x: i32, y: i32, z: i32) -> u32 {
    let n = vec3<i32>(u.grid.xyz);
    let c = clamp(vec3<i32>(x, y, z), vec3<i32>(0), n - vec3<i32>(1));
    return u32(c.x + n.x * (c.y + n.y * c.z));
}
