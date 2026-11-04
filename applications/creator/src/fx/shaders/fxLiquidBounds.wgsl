// The live preview's window: where the drops ended a frame, in whole neighbour cells -- the box
// liveLiquid.ts keeps the splat's window over. One thread per slot, after the frame's substeps; each
// workgroup takes its box in shared memory, then one atomic per side into counters[4..6] (low) and
// [8..10] (high), biased by BOUNDS_BIAS so they stay unsigned. The read-back resets them
// (liquidGpu.ts `readDeposits`), so a read holds every frame since the last.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;

var<workgroup> box_lo: array<atomic<u32>, 3>;
var<workgroup> box_hi: array<atomic<u32>, 3>;

@compute @workgroup_size(64)
fn cs_liquid_bounds(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32) {
    if (li < 3u) {
        atomicStore(&box_lo[li], 0xffffffffu);
        atomicStore(&box_hi[li], 0u);
    }
    workgroupBarrier();
    if (g.x < capacity()) {
        let p = pos[g.x];
        if (alive(p.w)) {
            let c = vec3<u32>(clamp(cell_of(p.xyz) + vec3<i32>(BOUNDS_BIAS), vec3<i32>(0), vec3<i32>(2 * BOUNDS_BIAS - 1)));
            atomicMin(&box_lo[0], c.x); atomicMin(&box_lo[1], c.y); atomicMin(&box_lo[2], c.z);
            atomicMax(&box_hi[0], c.x); atomicMax(&box_hi[1], c.y); atomicMax(&box_hi[2], c.z);
        }
    }
    workgroupBarrier();
    if (li < 3u) {
        let lo = atomicLoad(&box_lo[li]);
        if (lo != 0xffffffffu) {
            atomicMin(&counters[4u + li], lo);
            atomicMax(&counters[8u + li], atomicLoad(&box_hi[li]));
        }
    }
}
