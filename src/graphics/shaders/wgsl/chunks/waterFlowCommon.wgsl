// The LOCAL FLOW's shared arithmetic (render/localFlow.ts; the model and its CPU reference are water/localFlow.ts,
// whose constants these mirror). The water round the camera on cells of 0.3 m, drawn toward the flow bake.
//
// Textures, all read by `textureLoad` (no sampler: the state is 32-bit floats, which need not filter):
//  - the GROUND: r bed (m, relative to the datum), g drag (1/m; -1 a solid cell), b Manning's n, a the bake's
//    surface (m, relative to the datum; under the bed where the bake is dry);
//  - the REFERENCE (the live waves' field): r, g the bake's current at the cell's centre (m/s), b its depth, a
//    its foam;
//  - the DEPTHS: r depth (m), g the cell's outflow limit;
//  - the VELOCITIES: r u on the cell's -x face, g w on its -z face (m/s).
// A load past the window's edge reads the edge cell (clamped), as the reference stepper does.

const FLOW_DRY: f32 = 0.005;
const FLOW_THIN: f32 = 0.01;
const FLOW_G: f32 = 9.81;
const FLOW_NUDGE: f32 = 8.0;
const FLOW_EDGE_NUDGE: f32 = 0.1;
const FLOW_SPONGE: f32 = 10.0;
const FLOW_NATURAL_BED: f32 = 0.025;

struct FlowUniforms {
    u_flowGrid: vec4<f32>,    // cells a side, cell (m), substep (s), 1 = drawn toward the bake
    u_flowShift: vec4<f32>,   // the shift pass: cells the window moved (x, z), 0 depths / 1 velocities, -
};
@group(1) @binding(0) var<uniform> u_fl: FlowUniforms;

fn flowCells() -> i32 { return i32(u_fl.u_flowGrid.x); }

fn flowClamp(c: vec2<i32>) -> vec2<i32> {
    let n = flowCells();
    return clamp(c, vec2<i32>(0), vec2<i32>(n - 1));
}

/** The share of the difference to the bake a cell is drawn by this substep: all but all of it at the window's edge. */
fn flowNudge(c: vec2<i32>) -> f32 {
    if (u_fl.u_flowGrid.w < 0.5) { return 0.0; }
    let n = flowCells();
    let edge = f32(min(min(c.x, c.y), min(n - 1 - c.x, n - 1 - c.y)));
    let sponge = 1.0 - smoothstep(0.0, FLOW_SPONGE, edge);
    let rate = 1.0 / FLOW_NUDGE + sponge / FLOW_EDGE_NUDGE;
    return 1.0 - exp(-rate * u_fl.u_flowGrid.z);
}

/** The drawn bake's depth over the local bed (none in a solid), from a ground texel. */
fn flowRefDepth(ground: vec4<f32>) -> f32 {
    if (ground.g < 0.0) { return 0.0; }
    return max(0.0, ground.a - ground.r);
}

/** The whitewater rule (water/localFlow.ts whiteAt): a jump, shear, a drag cell. */
fn flowWhite(froudeUp: f32, froude: f32, curl: f32, speed: f32, drag: f32) -> f32 {
    var white = smoothstep(0.9, 1.3, froudeUp) * smoothstep(0.15, 0.6, froudeUp - froude);
    white = max(white, smoothstep(2.0, 6.0, abs(curl)) * smoothstep(0.8, 1.6, speed));
    if (drag > 0.0) { white = max(white, smoothstep(0.3, 1.2, speed) * min(1.0, drag * u_fl.u_flowGrid.y * 4.0)); }
    return white;
}
