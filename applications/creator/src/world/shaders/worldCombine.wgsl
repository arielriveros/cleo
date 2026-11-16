// The World graph's Combine node (graph/nodes/combine.ts `combinePoint` is the CPU statement): a (base)
// joined with b (layer) by an operation at strength x mask. Fields are 3N floats (heights, d/du, d/dv);
// an unconnected input is bound to a zero field.

struct CombineUniforms {
    res: u32,
    op: u32,
    /** bit 0 mask connected. */
    flags: u32,
    _pad: u32,
    strength: f32,
    _p0: f32,
    _p1: f32,
    _p2: f32,
};

@group(0) @binding(0) var<uniform> u: CombineUniforms;
@group(0) @binding(1) var<storage, read> field_a: array<f32>;
@group(0) @binding(2) var<storage, read> field_b: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<f32>;
@group(0) @binding(4) var<storage, read_write> field_out: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn cs_combine(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let n = u.res * u.res;
    let i = g.y * u.res + g.x;
    let a = vec3<f32>(field_a[i], field_a[n + i], field_a[2u * n + i]);
    let b = vec3<f32>(field_b[i], field_b[n + i], field_b[2u * n + i]);
    var m = 1.0;
    if ((u.flags & 1u) != 0u) { m = clamp(mask[i], 0.0, 1.0); }
    let s = clamp(u.strength, 0.0, 1.0) * m;
    var v: vec3<f32>;
    switch (u.op) {
        case 0u: { v = a + b; }
        case 1u: { v = a - b; }
        case 2u: { v = select(b, a, a.x >= b.x); }
        case 3u: { v = select(b, a, a.x <= b.x); }
        case 4u: { v = vec3<f32>(a.x * b.x, a.yz * b.x + a.x * b.yz); }
        default: { v = b; }
    }
    let o = a + (v - a) * s;
    field_out[i] = o.x;
    field_out[n + i] = o.y;
    field_out[2u * n + i] = o.z;
}
