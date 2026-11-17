// LOCAL FLOW, substep 4 of 4 (render/localFlow.ts; water/localFlow.ts stepLocalFlow): the velocities pushed down
// the surface's slope, against Manning's friction (on a natural bed never smoother than Jarrett's mountain
// streams) and the drag of anything standing in either cell, implicitly as one; closed at a solid and where no
// water is upwind; then drawn toward the bake's current. The window's own edge carries the bake's current.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"

@group(0) @binding(0) var u_vel_texture: texture_2d<f32>;      // u (-x face), w (-z face), carried
@group(0) @binding(2) var u_depth_texture: texture_2d<f32>;    // depth (this substep's)
@group(0) @binding(4) var u_ground_texture: texture_2d<f32>;
@group(0) @binding(6) var u_ref_texture: texture_2d<f32>;

fn face(c: vec2<i32>, axis: i32, v: f32, ground: vec4<f32>, h: f32) -> f32 {
    let step = select(vec2<i32>(0, 1), vec2<i32>(1, 0), axis == 0);
    let raw = c - step;
    let a = flowClamp(raw);
    let ga = textureLoad(u_ground_texture, a, 0);
    let rc = textureLoad(u_ref_texture, c, 0);
    let ra = textureLoad(u_ref_texture, a, 0);
    let refFace = select(0.5 * (ra.y + rc.y), 0.5 * (ra.x + rc.x), axis == 0);
    if (ground.g < 0.0 || ga.g < 0.0) { return 0.0; }
    if (any(raw != a)) { return select(0.0, refFace, u_fl.u_flowGrid.w > 0.5); }
    let ha = textureLoad(u_depth_texture, a, 0).x;
    let dt = u_fl.u_flowGrid.z;
    let cell = u_fl.u_flowGrid.y;
    let drop = (ground.r + h) - (ga.r + ha);
    var u = v - FLOW_G * dt / cell * drop;
    let up = select(h, ha, u > 0.0);
    if (up < FLOW_DRY) { return 0.0; }
    let hf = max(up, 0.02);
    let root = pow(hf, 1.0 / 3.0);
    var n = 0.5 * (ga.b + ground.b);
    if (n >= FLOW_NATURAL_BED) {
        let slope = clamp(abs(drop) / cell, 1e-8, 1.0);
        let torrent = 0.32 * pow(slope, 0.375) / sqrt(root);
        n = max(n, torrent);
    }
    var resist = FLOW_G * dt * n * n * abs(u) / (hf * root);
    resist += 0.5 * (ga.g + ground.g) * dt * abs(u);
    u /= 1.0 + resist;
    u += (refFace - u) * flowNudge(c);
    let most = 0.5 * cell / dt;
    return clamp(u, -most, most);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    let ground = textureLoad(u_ground_texture, c, 0);
    let h = textureLoad(u_depth_texture, c, 0).x;
    let v = textureLoad(u_vel_texture, c, 0).xy;
    return vec4<f32>(face(c, 0, v.x, ground, h), face(c, 1, v.y, ground, h), 0.0, 0.0);
}
