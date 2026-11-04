// Film step 1: the frame's floor deposits (x, z, vx, vz in the region, from the collide kernel) stamped into
// the film -- liquidFilm.ts `deposit` and `stamp`: a paraboloid cap of one drop's volume, stretched along the way
// it was going and shifted forward (a fast drop smears) with a satellite or two thrown ahead of a fast one,
// each landing whole. Thickness is added to `acc` in nanometres (an atomic integer), so drops landing on one
// cell in the same frame add up in any order; fxFilmResolve folds it into `h`. One thread per record.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read> deposits: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> acc: array<atomic<u32>>;

const NM: f32 = 1e9;

fn weight(ix: i32, iz: i32, x: f32, z: f32, a: f32, b: f32, ux: f32, uz: f32) -> f32 {
    let c = fu.geom.z;
    let dx = fu.geom.x + (f32(ix) + 0.5) * c - x;
    let dz = fu.geom.y + (f32(iz) + 0.5) * c - z;
    let u = dx * ux + dz * uz;
    let v = -dx * uz + dz * ux;
    return max(0.0, 1.0 - (u * u) / (a * a) - (v * v) / (b * b));
}

fn stamp(x: f32, z: f32, volume: f32, a: f32, b: f32, ux: f32, uz: f32) {
    let c = fu.geom.z;
    let reach = max(a, b) * 1.05;
    let ix0 = max(0, i32(floor((x - reach - fu.geom.x) / c)));
    let ix1 = min(cols() - 1, i32(floor((x + reach - fu.geom.x) / c)));
    let iz0 = max(0, i32(floor((z - reach - fu.geom.y) / c)));
    let iz1 = min(rows() - 1, i32(floor((z + reach - fu.geom.y) / c)));
    if (ix1 < ix0 || iz1 < iz0) { return; }
    var sum = 0.0;
    if (min(a, b) >= 2.5 * c && ix0 > 0 && iz0 > 0 && ix1 < cols() - 1 && iz1 < rows() - 1) {
        // Wide and clear of the grid's edge: the cap's cell sum is its area under the paraboloid, pi a b / (2 c^2)
        // (within a percent), which saves the whole first pass over the cells -- the cost that grows with the drops.
        sum = 1.5707963 * a * b / (c * c);
    } else {
        for (var iz = iz0; iz <= iz1; iz = iz + 1) {
            for (var ix = ix0; ix <= ix1; ix = ix + 1) { sum = sum + weight(ix, iz, x, z, a, b, ux, uz); }
        }
    }
    if (sum <= 1e-12) {
        // Smaller than a cell: all of it into the nearest one.
        let nx = clamp(i32(floor((x - fu.geom.x) / c)), 0, cols() - 1);
        let nz = clamp(i32(floor((z - fu.geom.y) / c)), 0, rows() - 1);
        atomicAdd(&acc[cell_index(nx, nz)], u32(volume / (c * c) * NM + 0.5));
        return;
    }
    let k = volume / (sum * c * c);
    for (var iz = iz0; iz <= iz1; iz = iz + 1) {
        for (var ix = ix0; ix <= ix1; ix = ix + 1) {
            let w = weight(ix, iz, x, z, a, b, ux, uz);
            if (w > 0.0) { atomicAdd(&acc[cell_index(ix, iz)], u32(w * k * NM + 0.5)); }
        }
    }
}

@compute @workgroup_size(64)
fn cs_film_stamp(@builtin(global_invocation_id) g: vec3<u32>) {
    let t = g.x;
    if (t >= min(atomicLoad(&counters[0]), arrayLength(&deposits))) { return; }
    let rec = deposits[t];
    // From the region to the floor's centre, where the grid is measured.
    let x = rec.x - fu.floor.x;
    let z = rec.y - fu.floor.y;
    let vx = rec.z;
    let vz = rec.w;
    let c = fu.geom.z;
    let vol = fu.geom.w;
    let id = i32(fu.grid.w + t);
    let seed = fu.grid.z;
    let speed = length(vec2<f32>(vx, vz));
    let r0 = max(c * 1.2, pow(vol, 1.0 / 3.0) * 0.9);
    let stretch = 1.0 + min(3.0, speed * 0.35);
    let ux = select(1.0, vx / max(speed, 1e-6), speed > 1e-6);
    let uz = select(0.0, vz / max(speed, 1e-6), speed > 1e-6);
    var satellites = 0;
    if (speed > 2.0) { satellites = 1 + i32(floor(hash3(id, 1, 21, seed) * 2.5)); }
    let share = select(0.0, 0.18, satellites > 0);
    stamp(x + ux * r0 * (stretch - 1.0) * 0.5, z + uz * r0 * (stretch - 1.0) * 0.5, vol * (1.0 - share), r0 * stretch, r0, ux, uz);
    for (var s = 0; s < satellites; s = s + 1) {
        let along = r0 * stretch * (1.4 + hash3(id, s, 23, seed) * 2.2);
        let side = (hash3(id, s, 29, seed) - 0.5) * r0 * 2.0;
        let rs = max(c * 0.8, r0 * 0.35);
        stamp(x + ux * along - uz * side, z + uz * along + ux * side, vol * share / f32(satellites), rs, rs, ux, uz);
    }
}
