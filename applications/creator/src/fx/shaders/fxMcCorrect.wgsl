// MacCormack, step 3 of 3 (fluidCpu.ts `advect`, Selle et al. 2008): add half the round-trip error to
// the forward result and clamp it to the eight values the backtrace interpolated, so it cannot overshoot.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel_in: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> orig: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> back: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> fwd: array<vec4<f32>>;

@compute @workgroup_size(4, 4, 4)
fn cs_mc_correct(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    let p = vec3<f32>(g) - vel_in[i].xyz * u.diss.w;
    if (p.y > f32(ny()) - 1.0) { return; }   // open top: stays empty
    let t = trilinear(p);
    let b = t.base;
    var lo = orig[idxc(b.x, b.y, b.z)];
    var hi = lo;
    for (var k = 1; k < 8; k = k + 1) {
        let c = orig[idxc(b.x + (k & 1), b.y + ((k >> 1) & 1), b.z + ((k >> 2) & 1))];
        lo = min(lo, c);
        hi = max(hi, c);
    }
    let f = fwd[i];
    let corrected = clamp(f + 0.5 * (orig[i] - back[i]), lo, hi);
    // All four scalars (density, temperature, fuel, flame); velocity stays semi-Lagrangian.
    fwd[i] = corrected;
}
