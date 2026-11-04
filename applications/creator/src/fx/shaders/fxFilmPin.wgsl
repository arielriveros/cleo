// Film set-up: each cell's edge hold (liquidFilm.ts `updatePinning`: two octaves of value noise about 1.5 cm
// across, at the cell's low corner in metres, so the pattern is the floor's whatever the cell) and whether a
// body stands on it (`buildSolid`). Run at build, and again when the hold, its noise, the seed or the bodies
// change.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<uniform> bodies: array<vec4<f32>, 48>; // MAX_BODIES (liquidGpu.ts) x 3
@group(0) @binding(2) var<storage, read_write> pin: array<f32>;
@group(0) @binding(3) var<storage, read_write> solid: array<u32>;

#include "./fxLiquidBodiesCommon.wgsl"

fn scene_distance(x: vec3<f32>) -> f32 {
    var d = 1e9;
    let w = x + fu.misc.yzw;
    for (var b = 0u; b < u32(fu.floor.z + 0.5); b = b + 1u) { d = min(d, body_distance(b, w)); }
    return d;
}

@compute @workgroup_size(8, 8, 1)
fn cs_film_pin(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let c = fu.geom.z;
    let xl = fu.geom.x + f32(g.x) * c;
    let zl = fu.geom.y + f32(g.y) * c;
    let n = 0.65 * value_noise3(vec3<f32>(xl / 0.015, zl / 0.015, 0.5), fu.grid.z + 41u)
          + 0.35 * value_noise3(vec3<f32>(xl / 0.015 * 2.7, zl / 0.015 * 2.7, 1.5), fu.grid.z + 43u);
    let i = cell_index(i32(g.x), i32(g.y));
    pin[i] = max(0.0, fu.floor.w * (1.0 + clamp(fu.consts2.z, 0.0, 1.0) * 1.2 * n));
    var s = 0u;
    if (fu.floor.z > 0.5) {
        // The cell's centre in the region, half a cell above the floor.
        let p = vec3<f32>(xl + 0.5 * c + fu.floor.x, 0.5 * c, zl + 0.5 * c + fu.floor.y);
        if (scene_distance(p) <= 0.0) { s = 1u; }
    }
    solid[i] = s;
}
