// The live preview's voxels: each voxel gathers the particles within the splat radius, as
// liquidRender.ts `splatLiquid` scatters them -- density (an isolated drop's peak is 1) and the foam of
// the fast ones. One thread per voxel of the window over the drops (u.window); the neighbour grid is the
// last substep's (sorted order, the collide's final positions), searched a cell wider.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos_s: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vel_s: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> cell_s: array<vec4<i32>>;
@group(0) @binding(4) var<storage, read> cell_start: array<u32>;
@group(0) @binding(5) var<storage, read_write> dens: array<vec2<f32>>;

@compute @workgroup_size(4, 4, 4)
fn cs_liquid_splat(@builtin(global_invocation_id) g: vec3<u32>) {
    if (any(g >= u.grid.xyz)) { return; }
    let centre = u.window.xyz + (vec3<f32>(g) + vec3<f32>(0.5)) * u.gridf.x;
    let rad = u.gridf.y;
    let inv2 = 1.0 / (rad * rad);
    let reach = i32(u.grid.w);
    let c = cell_of(centre);
    var d = 0.0;
    var foam = 0.0;
    for (var dz = -reach; dz <= reach; dz = dz + 1) {
        for (var dy = -reach; dy <= reach; dy = dy + 1) {
            for (var dx = -reach; dx <= reach; dx = dx + 1) {
                let q = c + vec3<i32>(dx, dy, dz);
                let k = cell_key(q);
                for (var s = cell_start[k]; s < cell_start[k + 1u]; s = s + 1u) {
                    // A bucket can hold other cells' particles (the hash collides): this cell's only.
                    if (any(cell_s[s].xyz != q)) { continue; }
                    let p = pos_s[s];
                    if (!alive(p.w)) { continue; }
                    let r = p.xyz - centre;
                    let t = dot(r, r) * inv2;
                    if (t >= 1.0) { continue; }
                    let w = (1.0 - t) * (1.0 - t) * (1.0 - t);
                    d = d + w;
                    foam = foam + w * clamp((length(vel_s[s].xyz) - u.gridf.w) / u.origin.w, 0.0, 1.0);
                }
            }
        }
    }
    dens[g.x + u.grid.x * (g.y + u.grid.y * g.z)] = vec2<f32>(d, select(0.0, foam / d, d > 1e-6));
}
