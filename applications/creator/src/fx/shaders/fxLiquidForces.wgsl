// Liquid step 1: the releases due this substep come alive (pos.w 2 + k becomes 1 once the substep
// counter, which fxLiquidScan.wgsl advances, reaches k); gravity and air drag (toward the stage's wind)
// -- liquidCpu.ts `forces`; and each live particle counted into its cell's bucket. One thread per slot.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> cell_count: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(64)
fn cs_liquid_forces(@builtin(global_invocation_id) g: vec3<u32>) {
    let i = g.x;
    if (i >= capacity()) { return; }
    var p = pos[i];
    if (p.w > 1.5) {
        if (p.w - 2.0 > f32(atomicLoad(&counters[1]))) { return; }
        p.w = 1.0;
        pos[i] = p;
    }
    if (!alive(p.w)) { return; }
    var v = vel[i];
    let drag = u.visc.z;
    v.y = v.y - u.phys.w * u.phys.x;
    v.x = v.x + (u.wind.x - v.x) * drag;
    v.y = v.y - v.y * drag;
    v.z = v.z + (u.wind.y - v.z) * drag;
    vel[i] = v;
    atomicAdd(&cell_count[cell_key(cell_of(p.xyz))], 1u);
}
