// The random forcing, step 2 of 3: the workgroups' partial sums (fxForcing) into one -- the net push and the
// total weight -- by one workgroup in a fixed order, so the result is the same every run (no float atomics).

@group(0) @binding(0) var<storage, read> partials: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> net: array<vec4<f32>>;

var<workgroup> acc: array<vec4<f32>, 256>;

@compute @workgroup_size(256)
fn cs_forcing_sum(@builtin(local_invocation_index) li: u32) {
    var s = vec4<f32>(0.0);
    let n = arrayLength(&partials);
    for (var j = li; j < n; j = j + 256u) { s = s + partials[j]; }
    acc[li] = s;
    workgroupBarrier();
    for (var m = 128u; m > 0u; m = m >> 1u) {
        if (li < m) { acc[li] = acc[li] + acc[li + m]; }
        workgroupBarrier();
    }
    if (li == 0u) { net[0] = acc[0]; }
}
