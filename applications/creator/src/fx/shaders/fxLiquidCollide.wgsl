// Liquid step 7: the preview's bodies, the floor and the region -- liquidCpu.ts `collide` and `settle`:
// v = (x - x_old) / dt; a drop hitting a solid floor bounces or, sticking, becomes a DEPOSIT (x, z, vx,
// vz) appended for the film (read back by the preview); one crossing a water surface or leaving the
// region dies, freeing its slot. Sorted order: one thread per live particle, its final position and
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

/** Signed distance from body `b` (three vec4s: kind and position, yaw, pitch and size xy, size z) -- obstacles.ts `bodyDistance`. */
fn body_distance(b: u32, w: vec3<f32>) -> f32 {
    let r0 = bodies[b * 3u];
    let r1 = bodies[b * 3u + 1u];
    let r2 = bodies[b * 3u + 2u];
    let dp = w - r0.yzw;
    let cy = cos(r1.x); let sy = sin(r1.x);
    let x1 = dp.x * cy - dp.z * sy;
    let z1 = dp.x * sy + dp.z * cy;
    let cp = cos(r1.y); let sp = sin(r1.y);
    let l = vec3<f32>(x1, dp.y * cp + z1 * sp, -dp.y * sp + z1 * cp);
    let size = vec3<f32>(r1.z, r1.w, r2.x);
    let kind = u32(r0.x + 0.5);
    if (kind == 0u) { return length(l) - size.x * 0.5; }
    if (kind == 1u) {
        let rad = size.x * 0.5;
        let half = max(0.0, size.y * 0.5 - rad);
        return length(vec3<f32>(l.x, l.y - clamp(l.y, -half, half), l.z)) - rad;
    }
    let q = abs(l) - size * 0.5;
    return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

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
    let s = u.region.xyz;
    let below = select(-r, -0.5 * s.y, mode == 2u);
    if (x.x < 0.0 || x.x > s.x || x.z < 0.0 || x.z > s.z || x.y > s.y || x.y < below) { dead = true; }
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
