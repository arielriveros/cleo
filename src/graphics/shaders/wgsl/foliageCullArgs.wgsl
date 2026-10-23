// GPU-driven foliage culling (WebGPU): turn this frame's per-bucket survivor counts into indirect draw
// arguments, then zero the counts for the next frame. The second half of foliageCull.wgsl.
//
// A bucket's survivors are drawn in SEGMENTS of fixed capacity, one indirect draw per segment per
// sub-model, because one draw must stay bounded (FOLIAGE_DRAW_TRIANGLE_BUDGET: a single unbounded
// submission of a heavy tree is a TDR and a removed device). Each argument record already holds its
// index count, first index and base vertex, written by the CPU when the layout changed; this fills in
// the instance count only. A segment past the survivors gets zero instances and draws nothing.
//
// ONE workgroup, deliberately: the counters may only be cleared once every record has read them, and a
// barrier orders that only inside a workgroup. The record count is small (segments x sub-models), so
// 256 threads striding over it is plenty.
//
// Compute only, so no GLSL half.

struct ArgsInfo {
    // x = argument records.
    counts: vec4<u32>,
};
@group(0) @binding(0) var<uniform> u_args: ArgsInfo;
// Per record: x = bucket (counter index), y = segment's first survivor, z = segment capacity.
@group(0) @binding(1) var<storage, read> records: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> counters: array<u32>;
// drawIndexedIndirect layout, 5 u32 per record: indexCount, instanceCount, firstIndex, baseVertex, firstInstance.
@group(0) @binding(3) var<storage, read_write> args: array<u32>;

@compute @workgroup_size(256)
fn cs_main(@builtin(local_invocation_index) lid: u32) {
    let n = u_args.counts.x;
    for (var k = lid; k < n; k += 256u) {
        let rec = records[k];
        let count = counters[rec.x];
        args[k * 5u + 1u] = select(0u, min(count - rec.y, rec.z), count > rec.y);
    }
    // Every record has read its counter before any is cleared.
    storageBarrier();
    let buckets = arrayLength(&counters);
    for (var b = lid; b < buckets; b += 256u) {
        counters[b] = 0u;
    }
}
