// Shared by the floor-film kernels (liquidFilmGpu.ts): the uniform block and the grid helpers. The film is
// liquidFilm.ts on the GPU -- the same fixed frame the CPU preview draws (the region's floor, `cols` x
// `rows` cells of `cell` metres, its low corner `x0`, `z0` from the floor's centre), `h` the wet thickness
// and `stain` the soaked-in thickness, in metres. Every kernel declares `fu` at binding 0.
//
// Constants the TS side owns (FILM_DRY, the optics' shades, ...) come in the uniform block so they cannot drift.

struct FilmUniforms {
    grid: vec4<u32>,     // cols, rows, seed, the first deposit's id this frame
    geom: vec4<f32>,     // x0, z0 (metres from the floor's centre), cell (m), one drop's volume (m^3)
    floor: vec4<f32>,    // the floor's centre in the region (x, z), body count, edge hold (m)
    flow: vec4<f32>,     // k = dt / cell^2, reference mobility, mobility cap, soak share this step
    consts: vec4<f32>,   // FILM_DRY, FILM_REF, stain shade, stain roughness
    consts2: vec4<f32>,  // wet darkening, ground reference, edge noise, relief
    sigma: vec4<f32>,    // absorption per metre rgb, metallic
    colour: vec4<f32>,   // liquid colour (linear) rgb, roughness
    misc: vec4<f32>,     // albedo opacity, the region's low corner in the stage (xyz)
    win: vec4<u32>,      // the active window: its low cell (x, z) and its size in cells -- only these are stepped
};

fn cols() -> i32 { return i32(fu.grid.x); }
fn rows() -> i32 { return i32(fu.grid.y); }
fn cell_index(ix: i32, iz: i32) -> u32 { return u32(ix + cols() * iz); }
fn in_grid(g: vec3<u32>) -> bool { return g.x < fu.grid.x && g.y < fu.grid.y; }
/** A thread of a windowed dispatch is in the window (always inside the grid: the host clamps it). */
fn in_win(g: vec3<u32>) -> bool { return g.x < fu.win.z && g.y < fu.win.w; }
/** Its cell in the grid. */
fn win_cell(g: vec3<u32>) -> vec2<i32> { return vec2<i32>(i32(g.x + fu.win.x), i32(g.y + fu.win.y)); }

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
