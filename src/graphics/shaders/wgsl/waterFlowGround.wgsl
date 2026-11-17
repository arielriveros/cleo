// LOCAL FLOW, the ground (render/localFlow.ts; the model is water/localFlow.ts): what the window's water stands
// on and is drawn toward. One pass per Water node in reach, each writing the cells its grid covers (wet or not:
// the water may climb a bank): the bed and the bake's surface from its grid, relative to the datum; Manning's n
// of its bed; and the obstacles in it, from their footprints at the surface (water/bake/obstacles.ts), as the
// flow bake rasterises them (bake/groupSetup.ts): a cell blocked over half its area is solid, one blocked over
// less holds the water back by the obstacle's drag, one over a collider whose top is under the surface has its
// bed raised to that top. Still water deeper than FLOW_DEPTH_CAP is taken as no deeper, as the bake takes it.
//
// Out: r bed (m), g drag (1/m; -1 solid), b Manning's n, a the bake's surface (m). Cells no grid covers keep
// the clear: a bed far above any water.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_info0_texture: texture_3d<f32>;   // surface (coarse), flow x, flow z, shore distance
@group(0) @binding(1) var u_info0_sampler: sampler;
@group(0) @binding(2) var u_info1_texture: texture_3d<f32>;   // surface (fine), foam, bed, wet
@group(0) @binding(3) var u_info1_sampler: sampler;

struct GroundUniforms {
    u_window: vec4<f32>,          // origin x, origin z (m), side (m), cells a side
    u_infoOrigin: vec4<f32>,      // the node's grid: origin x, origin z, cell (m), -
    u_infoSize: vec4<f32>,        // cells x, cells z, the datum (m), Manning's n
    u_obstacleCount: vec4<f32>,   // obstacles in u_obstacles, -, -, -
    // Two per obstacle (render/waterWaves.ts packs them): centre x, z and long axis x, z; half length, half
    // width, rounding (m), and metres its top lies under the surface (0: it stands out of the water).
    u_obstacles: array<vec4<f32>, 64>,
};
@group(1) @binding(0) var<uniform> u_wg: GroundUniforms;

/** water/localFlow.ts LOCAL_FLOW_DEPTH_CAP; bake/obstacles.ts OBSTACLE_DRAG. */
const FLOW_DEPTH_CAP: f32 = 3.0;
const OBSTACLE_DRAG: f32 = 1.2;
const OBSTACLE_MAX: i32 = 32;

/** How far `xz` lies out of obstacle `k`'s rounded rectangle (negative inside). */
fn obstacleDistance(k: i32, xz: vec2<f32>) -> f32 {
    let o0 = u_wg.u_obstacles[2 * k];
    let o1 = u_wg.u_obstacles[2 * k + 1];
    let rel = xz - o0.xy;
    let p = vec2<f32>(dot(rel, o0.zw), dot(rel, vec2<f32>(-o0.w, o0.z)));
    let q = abs(p) - o1.xy;
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - o1.z;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = u_wg.u_window.w;
    let cell = u_wg.u_window.z / n;
    let xz = u_wg.u_window.xy + in.position.xy * cell;
    let c = (xz - u_wg.u_infoOrigin.xy) / u_wg.u_infoOrigin.z + vec2<f32>(0.5);
    let uvw = vec3<f32>(c.x / u_wg.u_infoSize.x, c.y / u_wg.u_infoSize.y, 0.5);
    if (any(uvw.xy < vec2<f32>(0.0)) || any(uvw.xy > vec2<f32>(1.0))) { discard; }
    let i0 = textureSampleLevel(u_info0_texture, u_info0_sampler, uvw, 0.0);
    let i1 = textureSampleLevel(u_info1_texture, u_info1_sampler, uvw, 0.0);
    let datum = u_wg.u_infoSize.z;
    let surface = i0.x + i1.x - datum;
    var bed = i1.z - datum;
    // The obstacles, at two by two samples.
    var blocked = 0.0;
    var raised = 0.0;
    let count = min(i32(u_wg.u_obstacleCount.x), OBSTACLE_MAX);
    for (var s = 0; s < 4; s++) {
        let at = xz + (vec2<f32>(f32(s & 1), f32((s >> 1) & 1)) - vec2<f32>(0.5)) * 0.5 * cell;
        var top = bed;
        var wall = false;
        for (var k = 0; k < count; k++) {
            if (obstacleDistance(k, at) >= 0.0) { continue; }
            let under = u_wg.u_obstacles[2 * k + 1].w;
            if (under <= 0.0) { wall = true; } else { top = max(top, surface - under); }
        }
        if (wall) { blocked += 1.0; }
        raised += top;
    }
    var drag = 0.0;
    if (blocked >= 2.0) {
        drag = -1.0;
    } else {
        bed = max(bed, raised * 0.25);
        if (blocked > 0.0) { drag = OBSTACLE_DRAG * sqrt(blocked * 0.25 / 3.14159265) / cell; }
    }
    // Deep still water, no deeper than the cap.
    if (surface > bed) { bed = max(bed, surface - FLOW_DEPTH_CAP); }
    return vec4<f32>(bed, drag, u_wg.u_infoSize.w, surface);
}
