// LOCAL FLOW, substep 1 of 4 (render/localFlow.ts; water/localFlow.ts stepLocalFlow): the velocities carried
// along by themselves. Each face takes the velocity of the water that reaches it, from where that water was
// (semi-Lagrangian, bilinear), which is what lets a wake and its eddies form. Faces between two dry cells, or
// on a solid, carry none.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"

@group(0) @binding(0) var u_vel_texture: texture_2d<f32>;      // u (-x face), w (-z face)
@group(0) @binding(2) var u_depth_texture: texture_2d<f32>;    // depth, limit
@group(0) @binding(4) var u_ground_texture: texture_2d<f32>;

fn vel(c: vec2<i32>) -> vec2<f32> { return textureLoad(u_vel_texture, flowClamp(c), 0).xy; }
fn depth(c: vec2<i32>) -> f32 { return textureLoad(u_depth_texture, flowClamp(c), 0).x; }
fn solid(c: vec2<i32>) -> bool { return textureLoad(u_ground_texture, flowClamp(c), 0).y < 0.0; }

/** The face field of `axis` at (px, pz) in cell units (an x face (i, j) sits at (i - 0.5, j)), bilinear. */
fn faces(px: f32, pz: f32, axis: i32) -> f32 {
    let f = select(vec2<f32>(px, pz + 0.5), vec2<f32>(px + 0.5, pz), axis == 0);
    let b = floor(f);
    let t = f - b;
    let i = vec2<i32>(b);
    let s00 = vel(i)[axis];
    let s10 = vel(i + vec2<i32>(1, 0))[axis];
    let s01 = vel(i + vec2<i32>(0, 1))[axis];
    let s11 = vel(i + vec2<i32>(1, 1))[axis];
    return mix(mix(s00, s10, t.x), mix(s01, s11, t.x), t.y);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    let k = u_fl.u_flowGrid.z / u_fl.u_flowGrid.y;
    let here = vel(c);
    let hc = depth(c);
    let x = vec2<i32>(1, 0);
    let z = vec2<i32>(0, 1);
    var out = vec2<f32>(0.0);
    let ax = c - x;
    if (!(depth(ax) < FLOW_DRY && hc < FLOW_DRY) && !solid(c) && !solid(ax)) {
        let vw = 0.25 * (vel(c - x).y + here.y + vel(c - x + z).y + vel(c + z).y);
        out.x = faces(f32(c.x) - 0.5 - here.x * k, f32(c.y) - vw * k, 0);
    }
    let az = c - z;
    if (!(depth(az) < FLOW_DRY && hc < FLOW_DRY) && !solid(c) && !solid(az)) {
        let vu = 0.25 * (vel(c - z).x + vel(c - z + x).x + here.x + vel(c + x).x);
        out.y = faces(f32(c.x) - vu * k, f32(c.y) - 0.5 - here.y * k, 1);
    }
    return vec4<f32>(out, 0.0, 0.0);
}
