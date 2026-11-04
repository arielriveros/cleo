// Liquid step 7: the preview's bodies, the floor and the region -- liquidCpu.ts `collide` and `settle`:
// v = (x - x_old) / dt; a drop hitting a solid floor bounces or, sticking, becomes a DEPOSIT (x, z, vx,
// vz) appended for the film (stamped by liquidFilmGpu.ts); one crossing a water surface or leaving the
// domain dies, freeing its slot. The domain is everywhere the release can reach (liquidCpu.ts `liquidDomain`):
// the region only frames the drops, so one leaving it keeps flying and lands in the pool. Sorted order: one thread per live particle, its final position and
// velocity into the sorted arrays (fxLiquidScatter.wgsl takes them back to the slots, fxLiquidSplat.wgsl
// draws them). The survivors are counted (counters[2]) for the preview's readout.

#include "./fxLiquidCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos_in: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vel_in: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> sorted: array<u32>;
@group(0) @binding(4) var<storage, read> ids: array<u32>;
// In: the position before the substep's advance (x_old). Out: the final one.
@group(0) @binding(5) var<storage, read_write> pos_s: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> vel_s: array<vec4<f32>>;
// A uniform, not storage: a stage holds 8 storage buffers at most, and this kernel already binds 8.
@group(0) @binding(7) var<uniform> bodies: array<vec4<f32>, 48>; // MAX_BODIES (liquidGpu.ts) x 3
@group(0) @binding(8) var<storage, read_write> deposits: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> counters: array<atomic<u32>>;

#include "./fxLiquidBodiesCommon.wgsl"

fn scene_distance(x: vec3<f32>) -> f32 {
    var d = 1e9;
    let w = x + u.origin.xyz;
    for (var b = 0u; b < u.counts.z; b = b + 1u) { d = min(d, body_distance(b, w)); }
    return d;
}

fn deposit(x: vec3<f32>, hv: vec2<f32>) {
    let k = atomicAdd(&counters[0], 1u);
    if (k < u32(u.floor.w)) { deposits[k] = vec4<f32>(x.x, x.z, hv.x, hv.y); }
}

@compute @workgroup_size(64)
fn cs_liquid_collide(@builtin(global_invocation_id) g: vec3<u32>) {
    let t = g.x;
    if (t >= atomicLoad(&counters[3])) { return; }
    var x = pos_in[t].xyz;
    let o = pos_s[t].xyz;
    let dt = u.phys.x;
    let r = u.visc.w;
    if (u.counts.z > 0u) {
        let d = scene_distance(x);
        if (d < r) {
            let e = r * 0.5;
            let gr = vec3<f32>(scene_distance(x + vec3<f32>(e, 0.0, 0.0)) - scene_distance(x - vec3<f32>(e, 0.0, 0.0)),
                               scene_distance(x + vec3<f32>(0.0, e, 0.0)) - scene_distance(x - vec3<f32>(0.0, e, 0.0)),
                               scene_distance(x + vec3<f32>(0.0, 0.0, e)) - scene_distance(x - vec3<f32>(0.0, 0.0, e)));
            let gl = length(gr);
            if (gl > 1e-9) { x = x + gr * ((r - d) / gl); }
        }
    }
    let mode = u32(u.wind.z + 0.5);
    var contact = false;
    var hit = vec3<f32>(0.0);
    var dead = false;
    if (mode == 0u && x.y < r) {
        hit = (x - o) / dt;
        x.y = r;
        contact = true;
    } else if (mode == 1u && x.y < 0.0) {
        dead = true;
    }
    let below = select(-r, -0.5 * u.region.y, mode == 2u);
    let d = u.domain;
    if (x.x < d.x || x.x > d.z || x.z < d.y || x.z > d.w || x.y > u.window.w || x.y < below) { dead = true; }
    if (dead) { pos_s[t] = vec4<f32>(x, 0.0); return; }

    var nv = (x - o) / dt;
    var bounces = vel_in[t].w;
    let stick_speed = u.floor.y;
    if (!contact) {
        // Lying on the floor and nearly still: come to rest in the pool.
        if (mode == 0u && x.y < r * 1.6 && length(nv) < stick_speed * 0.5) {
            deposit(x, vec2<f32>(0.0));
            pos_s[t] = vec4<f32>(x, 0.0);
            return;
        }
    } else {
        let sticks = hash3(i32(ids[sorted[t]]), i32(bounces), 13, u.counts.w) < u.wind.w;
        if (sticks || length(hit) < stick_speed || bounces >= u.floor.z) {
            deposit(x, hit.xz);
            pos_s[t] = vec4<f32>(x, 0.0);
            return;
        }
        // A bounce: the speed into the floor comes back by the bounce, the speed along it loses the friction.
        nv = vec3<f32>(hit.x * u.floor.x, abs(hit.y) * u.region.w, hit.z * u.floor.x);
        bounces = bounces + 1.0;
    }
    pos_s[t] = vec4<f32>(x, 1.0);
    vel_s[t] = vec4<f32>(nv, bounces);
    atomicAdd(&counters[2], 1u);
}
