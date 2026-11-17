// LOCAL FLOW, the window moved (render/localFlow.ts): the depths or the velocities carried over by the whole
// cells the window moved, and the strip it moved onto started as the bake has it. A start from nothing is a
// move by more than the window: every cell as the bake has it.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"

@group(0) @binding(0) var u_state_texture: texture_2d<f32>;    // the depths or the velocities as they were
@group(0) @binding(2) var u_ground_texture: texture_2d<f32>;
@group(0) @binding(4) var u_ref_texture: texture_2d<f32>;

fn refFace(c: vec2<i32>, axis: i32) -> f32 {
    let a = flowClamp(c - select(vec2<i32>(0, 1), vec2<i32>(1, 0), axis == 0));
    let gc = textureLoad(u_ground_texture, c, 0);
    let ga = textureLoad(u_ground_texture, a, 0);
    if (gc.g < 0.0 || ga.g < 0.0) { return 0.0; }
    let rc = textureLoad(u_ref_texture, c, 0);
    let ra = textureLoad(u_ref_texture, a, 0);
    return select(0.5 * (ra.y + rc.y), 0.5 * (ra.x + rc.x), axis == 0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    let n = flowCells();
    let src = c + vec2<i32>(u_fl.u_flowShift.xy);
    if (all(src >= vec2<i32>(0)) && all(src < vec2<i32>(n))) {
        return textureLoad(u_state_texture, src, 0);
    }
    if (u_fl.u_flowShift.z < 0.5) {
        return vec4<f32>(flowRefDepth(textureLoad(u_ground_texture, c, 0)), 1.0, 0.0, 0.0);
    }
    return vec4<f32>(refFace(c, 0), refFace(c, 1), 0.0, 0.0);
}
