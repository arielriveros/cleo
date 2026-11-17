// LOCAL FLOW, substep 3 of 4 (render/localFlow.ts; water/localFlow.ts stepLocalFlow): the depths from the
// flux through each face (its velocity times the depth upwind of it, at that cell's limit), then drawn toward
// the bake: gently everywhere, hard in the sponge along the window's edge. A solid cell holds none.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"

@group(0) @binding(0) var u_depth_texture: texture_2d<f32>;    // depth, limit
@group(0) @binding(2) var u_vel_texture: texture_2d<f32>;      // u (-x face), w (-z face), carried
@group(0) @binding(4) var u_ground_texture: texture_2d<f32>;

fn cellAt(c: vec2<i32>) -> vec2<f32> { return textureLoad(u_depth_texture, flowClamp(c), 0).xy; }

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    let ground = textureLoad(u_ground_texture, c, 0);
    if (ground.g < 0.0) { return vec4<f32>(0.0, 1.0, 0.0, 0.0); }
    let k = u_fl.u_flowGrid.z / u_fl.u_flowGrid.y;
    let here = cellAt(c);
    let l = cellAt(c - vec2<i32>(1, 0));
    let r = cellAt(c + vec2<i32>(1, 0));
    let b = cellAt(c - vec2<i32>(0, 1));
    let t = cellAt(c + vec2<i32>(0, 1));
    let v = textureLoad(u_vel_texture, c, 0).xy;
    let fr = textureLoad(u_vel_texture, flowClamp(c + vec2<i32>(1, 0)), 0).x;
    let ft = textureLoad(u_vel_texture, flowClamp(c + vec2<i32>(0, 1)), 0).y;
    let fl = v.x;
    let fb = v.y;
    let own = here.x * here.y;
    let qL = select(fl * own, fl * l.x * l.y, fl > 0.0);
    let qR = select(fr * r.x * r.y, fr * own, fr > 0.0);
    let qB = select(fb * own, fb * b.x * b.y, fb > 0.0);
    let qT = select(ft * t.x * t.y, ft * own, ft > 0.0);
    var d = here.x + k * (qL - qR + qB - qT);
    d += (flowRefDepth(ground) - d) * flowNudge(c);
    return vec4<f32>(max(d, 0.0), 1.0, 0.0, 0.0);
}
