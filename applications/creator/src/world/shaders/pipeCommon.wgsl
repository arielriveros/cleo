// Shared by World Creator's virtual-pipe erosion kernels (erosion.ts `pipeStep` is the CPU statement
// of each one). Heights, water and sediment are in CELL units, exactly as on the CPU. Bindings live in
// each kernel: the engine builds compute pipelines with an `auto` layout.

struct PipeUniforms {
    res: u32,
    strip_row: u32,   // first row of the readback strip (pipeReadback only)
    strip_rows: u32,
    _pad: u32,
    dt: f32,
    rain: f32,
    evaporation_keep: f32,
    capacity: f32,
    dissolve: f32,
    deposit: f32,
    pipe_k: f32,
    min_tilt: f32,
};

fn cell(c: u32, r: u32) -> u32 { return r * u.res + c; }

/** Index of (c, r) clamped into the grid. */
fn cellc(c: i32, r: i32) -> u32 {
    let n = i32(u.res) - 1;
    return u32(clamp(r, 0, n)) * u.res + u32(clamp(c, 0, n));
}
