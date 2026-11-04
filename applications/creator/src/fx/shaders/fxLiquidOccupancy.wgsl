// The live preview's occupancy grid for the liquid -- fxOccupancy.wgsl's, from the splatted density: a
// brick is marked when any voxel within it or a 2-voxel margin holds liquid. Its densest voxel is kept
// for the light march to stride over empty bricks.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> dens: array<vec2<f32>>;
@group(0) @binding(2) var occupancy: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read_write> brick_max: array<f32>;

const MARGIN: i32 = 2;

@compute @workgroup_size(4, 4, 4)
fn cs_liquid_occupancy(@builtin(global_invocation_id) g: vec3<u32>) {
    let bricks = (u.grid.xyz + vec3<u32>(7u)) / 8u;
    if (any(g >= bricks)) { return; }
    let n = vec3<i32>(u.grid.xyz);
    let lo = max(vec3<i32>(g) * BRICK - vec3<i32>(MARGIN), vec3<i32>(0));
    let hi = min(vec3<i32>(g) * BRICK + vec3<i32>(BRICK - 1 + MARGIN), n - vec3<i32>(1));
    var m = 0.0;
    for (var z = lo.z; z <= hi.z; z = z + 1) {
        for (var y = lo.y; y <= hi.y; y = y + 1) {
            for (var x = lo.x; x <= hi.x; x = x + 1) { m = max(m, dens[vidx(x, y, z)].x); }
        }
    }
    textureStore(occupancy, vec3<i32>(g), vec4<f32>(select(0.0, 1.0, m > 1e-4), 0.0, 0.0, 1.0));
    brick_max[g.x + bricks.x * (g.y + bricks.y * g.z)] = m;
}
