// Pipe step 2: outflow through each cell's four virtual pipes (L, R, T, B), scaled so a cell never sends
// more water than it holds. Each cell owns its own flux, so updating in place is safe.

#include "./pipeCommon.wgsl"

@group(0) @binding(0) var<uniform> u: PipeUniforms;
@group(0) @binding(1) var<storage, read> bed: array<f32>;
@group(0) @binding(2) var<storage, read> water: array<f32>;
@group(0) @binding(3) var<storage, read_write> flux: array<vec4<f32>>;

fn outflow(prev: f32, h: f32, j: u32) -> f32 {
    return max(0.0, prev + u.dt * u.pipe_k * (h - bed[j] - water[j]));
}

@compute @workgroup_size(8, 8, 1)
fn cs_flux(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let c = i32(g.x); let r = i32(g.y);
    let i = cell(g.x, g.y);
    let h = bed[i] + water[i];
    let prev = flux[i];
    var f = vec4<f32>(0.0);
    if (g.x > 0u) { f.x = outflow(prev.x, h, cellc(c - 1, r)); }
    if (g.x < u.res - 1u) { f.y = outflow(prev.y, h, cellc(c + 1, r)); }
    if (g.y > 0u) { f.z = outflow(prev.z, h, cellc(c, r - 1)); }
    if (g.y < u.res - 1u) { f.w = outflow(prev.w, h, cellc(c, r + 1)); }
    let total = (f.x + f.y + f.z + f.w) * u.dt;
    if (total > water[i] && total > 0.0) { f = f * (water[i] / total); }
    flux[i] = f;
}
