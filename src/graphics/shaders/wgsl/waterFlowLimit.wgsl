// LOCAL FLOW, substep 2 of 4 (render/localFlow.ts; water/localFlow.ts stepLocalFlow): each cell's outflow
// limit, so that no cell gives more water than it has this substep (the next pass reads its neighbours').

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"

@group(0) @binding(0) var u_depth_texture: texture_2d<f32>;    // depth, -
@group(0) @binding(2) var u_vel_texture: texture_2d<f32>;      // u (-x face), w (-z face), carried

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    let h = textureLoad(u_depth_texture, c, 0).x;
    if (h <= 0.0) { return vec4<f32>(h, 1.0, 0.0, 0.0); }
    let k = u_fl.u_flowGrid.z / u_fl.u_flowGrid.y;
    let here = textureLoad(u_vel_texture, c, 0).xy;
    let right = textureLoad(u_vel_texture, flowClamp(c + vec2<i32>(1, 0)), 0).x;
    let top = textureLoad(u_vel_texture, flowClamp(c + vec2<i32>(0, 1)), 0).y;
    let out = (max(0.0, right) + max(0.0, -here.x) + max(0.0, top) + max(0.0, -here.y)) * h * k;
    let limit = select(1.0, h / out, out > h && out > 0.0);
    return vec4<f32>(h, limit, 0.0, 0.0);
}
