// The live preview's occupancy grid -- the engine's `occupancyFromVolume`: one thread per 8^3 brick,
// marking it when any voxel within it or within a 2-voxel margin holds smoke or fire. The engine's
// volume march jumps over unmarked bricks. Each brick also sums its own voxels' fire emission and
// emission-weighted position, which fxReduce.wgsl turns into the fire light's position and strength.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var occupancy: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read_write> bricksum: array<vec4<f32>>;

const BRICK: i32 = 8;
const MARGIN: i32 = 2;

@compute @workgroup_size(4, 4, 4)
fn cs_occupancy(@builtin(global_invocation_id) g: vec3<u32>) {
    let bricks = vec3<u32>((u.dims.xyz + vec3<u32>(7u)) / 8u);
    if (any(g >= bricks)) { return; }
    let lo = max(vec3<i32>(g) * BRICK - vec3<i32>(MARGIN), vec3<i32>(0));
    let hi = min(vec3<i32>(g) * BRICK + vec3<i32>(BRICK - 1 + MARGIN), vec3<i32>(u.dims.xyz) - vec3<i32>(1));
    let own_lo = vec3<i32>(g) * BRICK;
    let own_hi = own_lo + vec3<i32>(BRICK - 1);
    var occupied = 0.0;
    var sum = vec4<f32>(0.0);
    for (var z = lo.z; z <= hi.z; z = z + 1) {
        for (var y = lo.y; y <= hi.y; y = y + 1) {
            for (var x = lo.x; x <= hi.x; x = x + 1) {
                let s = sca[idx(u32(x), u32(y), u32(z))];
                if (s.x > 1e-4 || s.y > u.burn.x) { occupied = 1.0; }
                let c = vec3<i32>(x, y, z);
                if (all(c >= own_lo) && all(c <= own_hi)) {
                    let e = clamp((s.y - u.burn.x) / u.flags.w, 0.0, 1.0);
                    sum = sum + vec4<f32>(vec3<f32>(c) * e, e);
                }
            }
        }
    }
    textureStore(occupancy, vec3<i32>(g), vec4<f32>(occupied, 0.0, 0.0, 1.0));
    bricksum[g.x + bricks.x * (g.y + bricks.y * g.z)] = sum;
}
