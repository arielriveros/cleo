// Liquid step 8: the substep's particles back to their slots, the dead ones freeing theirs; and the hash
// table emptied (counts and fill cursors -- liquidCpu.ts `buildNeighbours`, its fill(0)) for the next
// substep. One thread per slot or table entry, whichever are more.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> sorted: array<u32>;
@group(0) @binding(4) var<storage, read> pos_s: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> vel_s: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> cell_count: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> cell_fill: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(64)
fn cs_liquid_scatter(@builtin(global_invocation_id) g: vec3<u32>) {
    let x = g.x;
    if (x <= u.counts.y) {
        atomicStore(&cell_count[x], 0u);
        atomicStore(&cell_fill[x], 0u);
    }
    if (x < atomicLoad(&counters[3])) {
        let i = sorted[x];
        pos[i] = pos_s[x];
        vel[i] = vel_s[x];
    }
}
