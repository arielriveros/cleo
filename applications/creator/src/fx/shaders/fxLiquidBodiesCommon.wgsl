// The preview's bodies as signed distances -- obstacles.ts `bodyDistance`. Shared by the collide kernel and the
// film's solid mask; the including kernel declares `bodies` (a uniform: MAX_BODIES x 3 vec4s, liquidGpu.ts).

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
