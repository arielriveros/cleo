// The sun's light through the liquid, on the half-resolution grid -- liquidRender.ts `liquidLight`: a march
// toward the sun, liquid inside the surface absorbing, empty bricks crossed in strides. Only cells in a
// brick with liquid march: the light is only read at the surface.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> dens: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> brick_max: array<f32>;
@group(0) @binding(3) var<storage, read_write> light: array<f32>;

fn density_at(p: vec3<f32>) -> f32 {
    let n = vec3<f32>(u.grid.xyz);
    let q = clamp(p, vec3<f32>(0.0), n - vec3<f32>(1.0));
    let b = vec3<i32>(floor(q));
    let f = q - vec3<f32>(b);
    let c00 = mix(dens[vidx(b.x, b.y, b.z)].x, dens[vidx(b.x + 1, b.y, b.z)].x, f.x);
    let c10 = mix(dens[vidx(b.x, b.y + 1, b.z)].x, dens[vidx(b.x + 1, b.y + 1, b.z)].x, f.x);
    let c01 = mix(dens[vidx(b.x, b.y, b.z + 1)].x, dens[vidx(b.x + 1, b.y, b.z + 1)].x, f.x);
    let c11 = mix(dens[vidx(b.x, b.y + 1, b.z + 1)].x, dens[vidx(b.x + 1, b.y + 1, b.z + 1)].x, f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn brick_at(p: vec3<f32>) -> f32 {
    let bricks = vec3<i32>((u.grid.xyz + vec3<u32>(7u)) / 8u);
    let b = clamp(vec3<i32>(floor(p / 8.0)), vec3<i32>(0), bricks - vec3<i32>(1));
    return brick_max[u32(b.x + bricks.x * (b.y + bricks.y * b.z))];
}

@compute @workgroup_size(4, 4, 4)
fn cs_liquid_light(@builtin(global_invocation_id) g: vec3<u32>) {
    let ld = u.light_dims.xyz;
    if (any(g >= ld)) { return; }
    let out = g.x + ld.x * (g.y + ld.y * g.z);
    let iso = u.gridf.z;
    var p = vec3<f32>(g) * 2.0;
    if (brick_at(p) < iso * 0.5) { light[out] = 1.0; return; }
    let n = vec3<f32>(u.grid.xyz) - vec3<f32>(1.0);
    let steps = i32(length(n)) + 1;
    var tau = 0.0;
    for (var s = 0; s < steps; s = s + 1) {
        if (tau >= 12.0) { break; }
        let empty = brick_at(p) < iso;
        let stride = select(1.0, 3.0, empty);
        p = p + u.light.xyz * stride;
        if (any(p < vec3<f32>(0.0)) || any(p > n)) { break; }
        if (empty) { continue; }
        let d = density_at(p);
        if (d > iso) { tau = tau + u.light.w * min(2.0, d / iso); }
    }
    light[out] = exp(-tau);
}
