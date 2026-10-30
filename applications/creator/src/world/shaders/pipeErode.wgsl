// Pipe step 4: erosion and deposition against the local sediment capacity. The tilt comes from bed_in
// (a snapshot), the result goes to bed_out, so no cell sees a neighbour's write. Also accumulates the
// discharge (speed x depth) the flow mask is built from.

#include "./pipeCommon.wgsl"

@group(0) @binding(0) var<uniform> u: PipeUniforms;
@group(0) @binding(1) var<storage, read> bed_in: array<f32>;
@group(0) @binding(2) var<storage, read_write> bed_out: array<f32>;
@group(0) @binding(3) var<storage, read_write> sediment: array<f32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read> velocity: array<vec2<f32>>;
@group(0) @binding(6) var<storage, read_write> flow: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn cs_erode(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let c = i32(g.x); let r = i32(g.y);
    let i = cell(g.x, g.y);
    let gx = (bed_in[cellc(c + 1, r)] - bed_in[cellc(c - 1, r)]) * 0.5;
    let gy = (bed_in[cellc(c, r + 1)] - bed_in[cellc(c, r - 1)]) * 0.5;
    let sin_tilt = max(u.min_tilt, sqrt(gx * gx + gy * gy) / sqrt(1.0 + gx * gx + gy * gy));
    let speed = length(velocity[i]);
    let cap = u.capacity * sin_tilt * speed * min(1.0, water[i]);
    var b = bed_in[i];
    var s = sediment[i];
    if (cap > s) {
        // Never more than the water there can hold (erosion.ts MAX_ERODE_PER_DEPTH).
        let take = min(u.dissolve * (cap - s), water[i] * 0.5);
        b = b - take; s = s + take;
    } else {
        let drop = u.deposit * (s - cap);
        b = b + drop; s = s - drop;
    }
    bed_out[i] = b;
    sediment[i] = s;
    flow[i] = flow[i] + speed * water[i];
}
