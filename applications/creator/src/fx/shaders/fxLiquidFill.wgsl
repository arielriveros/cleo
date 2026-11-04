// Liquid step 3: every live particle into its bucket, in bucket order: its slot into `sorted`, and its
// position, velocity and cell into the SORTED arrays the rest of the substep works on. A bucket's
// particles then sit together in memory, and neighbouring threads search the same cells -- the neighbour
// steps are bound by the latency of their loads, not by arithmetic. One thread per slot.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> cell_start: array<u32>;
@group(0) @binding(4) var<storage, read_write> cell_fill: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> sorted: array<u32>;
@group(0) @binding(6) var<storage, read_write> pos_s: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> vel_s: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> cell_s: array<vec4<i32>>;

@compute @workgroup_size(64)
fn cs_liquid_fill(@builtin(global_invocation_id) g: vec3<u32>) {
    let i = g.x;
    if (i >= capacity()) { return; }
    let p = pos[i];
    if (!alive(p.w)) { return; }
    let c = cell_of(p.xyz);
    let k = cell_key(c);
    let s = cell_start[k] + atomicAdd(&cell_fill[k], 1u);
    sorted[s] = i;
    pos_s[s] = p;
    vel_s[s] = vel[i];
    cell_s[s] = vec4<i32>(c, 0);
}
