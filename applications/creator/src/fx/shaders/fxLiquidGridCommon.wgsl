// The neighbour search of the sorted-order liquid kernels (viscosity, density, relax), for those that
// declare `cell_start`: the bucket ranges of the 27 cells around a particle, fetched up front -- 27 loads
// in flight together rather than 27 round trips one after another, which is what these kernels wait on.

struct Neighbours { range: array<vec2<u32>, 27> };

/**
 * The 27 ranges of sorted indices around cell `c`. Two of the cells can hash to one bucket: it is visited
 * once (the second range is empty). A bucket can also hold particles of cells farther off; those are
 * beyond h and fail the distance test (one that has moved within h since it was binned is a neighbour all
 * the same), so no cell check is needed per pair.
 */
fn neighbour_ranges(c: vec3<i32>) -> Neighbours {
    var keys: array<u32, 27>;
    for (var m = 0; m < 27; m = m + 1) {
        keys[m] = cell_key(c + vec3<i32>(m % 3 - 1, (m / 3) % 3 - 1, m / 9 - 1));
    }
    var nb: Neighbours;
    for (var m = 0; m < 27; m = m + 1) {
        nb.range[m] = vec2<u32>(cell_start[keys[m]], cell_start[keys[m] + 1u]);
    }
    for (var m = 1; m < 27; m = m + 1) {
        for (var e = 0; e < m; e = e + 1) {
            if (keys[e] == keys[m]) { nb.range[m] = vec2<u32>(0u); }
        }
    }
    return nb;
}
