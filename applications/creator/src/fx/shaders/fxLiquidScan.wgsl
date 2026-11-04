// Liquid step 2: the hash table's counts into bucket starts (an exclusive prefix sum), in one workgroup:
// each thread sums a run of buckets, the 256 sums are scanned in shared memory, then each run is written.
// It also advances the substep counter the births read, clears the live count, and stores the count of
// binned (live) particles, which the sorted-order kernels that have no table run up to.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read_write> cell_count: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> cell_start: array<u32>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;

var<workgroup> partial: array<u32, 256>;

@compute @workgroup_size(256)
fn cs_liquid_scan(@builtin(local_invocation_id) l: vec3<u32>) {
    let n = u.counts.y + 1u;
    let per = (n + 255u) / 256u;
    let lo = min(l.x * per, n);
    let hi = min(lo + per, n);
    var sum = 0u;
    for (var k = lo; k < hi; k = k + 1u) { sum = sum + atomicLoad(&cell_count[k]); }
    partial[l.x] = sum;
    workgroupBarrier();
    // Hillis-Steele: inclusive sums of the 256 runs.
    for (var off = 1u; off < 256u; off = off * 2u) {
        var add = 0u;
        if (l.x >= off) { add = partial[l.x - off]; }
        workgroupBarrier();
        partial[l.x] = partial[l.x] + add;
        workgroupBarrier();
    }
    var run = 0u;
    if (l.x > 0u) { run = partial[l.x - 1u]; }
    for (var k = lo; k < hi; k = k + 1u) {
        cell_start[k] = run;
        run = run + atomicLoad(&cell_count[k]);
    }
    if (l.x == 255u) {
        cell_start[n] = partial[255];
        // The substep is done with its births: the next one's are due (fxLiquidForces.wgsl). And the live
        // count starts over, for fxLiquidCollide.wgsl to count this substep's survivors.
        atomicAdd(&counters[1], 1u);
        atomicStore(&counters[2], 0u);
        atomicStore(&counters[3], partial[255]);
    }
}
