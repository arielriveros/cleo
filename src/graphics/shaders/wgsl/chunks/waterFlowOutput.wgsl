// LOCAL FLOW, what it hands on (render/localFlow.ts; water/localFlow.ts localFlowOutput): per cell, the current
// at its centre, its depth, the surface against the bake's, and the whitewater it makes. Shared by the two
// output passes (waterFlowWaves.wgsl for the live waves, waterFlowSurface.wgsl for the surface).

@group(0) @binding(0) var u_depth_texture: texture_2d<f32>;    // depth
@group(0) @binding(2) var u_vel_texture: texture_2d<f32>;      // u (-x face), w (-z face)
@group(0) @binding(4) var u_ground_texture: texture_2d<f32>;
@group(0) @binding(6) var u_ref_texture: texture_2d<f32>;

fn outDepth(c: vec2<i32>) -> f32 { return textureLoad(u_depth_texture, flowClamp(c), 0).x; }
fn outGround(c: vec2<i32>) -> vec4<f32> { return textureLoad(u_ground_texture, flowClamp(c), 0); }

/** The current at cell `c`'s centre: the mean of its faces. */
fn outCurrent(c: vec2<i32>) -> vec2<f32> {
    let here = textureLoad(u_vel_texture, flowClamp(c), 0).xy;
    let right = textureLoad(u_vel_texture, flowClamp(c + vec2<i32>(1, 0)), 0).x;
    let top = textureLoad(u_vel_texture, flowClamp(c + vec2<i32>(0, 1)), 0).y;
    return 0.5 * vec2<f32>(here.x + right, here.y + top);
}

/** Water of its own here, where the bake has water too. */
fn outWet(c: vec2<i32>) -> bool {
    let g = outGround(c);
    return g.g >= 0.0 && outDepth(c) > FLOW_THIN && g.a > g.r - 1e-3;
}

/** The surface against the bake's (m). */
fn outLift(c: vec2<i32>) -> f32 {
    let g = outGround(c);
    return g.r + outDepth(c) - g.a;
}

/** The whitewater made at cell `c` (water/localFlow.ts whiteAt). */
fn outWhite(c: vec2<i32>, current: vec2<f32>) -> f32 {
    let cell = u_fl.u_flowGrid.y;
    let speed = length(current);
    var froudeUp = 0.0;
    var froude = 0.0;
    if (speed > 0.05) {
        let back = vec2<i32>(round(vec2<f32>(c) - current / speed / cell));
        let b = flowClamp(back);
        if (outGround(b).g >= 0.0 && outDepth(b) > FLOW_THIN) {
            froudeUp = length(outCurrent(b)) / sqrt(FLOW_G * outDepth(b));
            froude = speed / sqrt(FLOW_G * max(outDepth(c), FLOW_THIN));
        }
    }
    let dx = vec2<i32>(1, 0);
    let dz = vec2<i32>(0, 1);
    let curl = ((outCurrent(c + dx).y - outCurrent(c - dx).y) - (outCurrent(c + dz).x - outCurrent(c - dz).x)) / (2.0 * cell);
    return flowWhite(froudeUp, froude, curl, speed, outGround(c).g);
}
