// LOCAL FLOW, out to the surface (render/localFlow.ts; water.wgsl reads it round the camera): the surface's lift
// over the bake's (m), the current x, z (m/s) its ripples and foam are carried by, and how much of it is the
// local flow's (1 where the window has water of its own, 0 where the bake's is to be drawn as it is). A solid
// cell takes its wet neighbours' lift, so the surface does not cliff inside a post; so does a dry one beside
// the water (water/localFlow.ts localFlowOutput), where the drawn surface runs on under the bank.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"
#include "./chunks/waterFlowOutput.wgsl"

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    if (outGround(c).g < 0.0 || !outWet(c)) {
        var sum = 0.0;
        var count = 0.0;
        for (var k = 0; k < 4; k++) {
            let q = c + select(select(vec2<i32>(0, 1), vec2<i32>(0, -1), k == 2), select(vec2<i32>(1, 0), vec2<i32>(-1, 0), k == 0), k < 2);
            if (outWet(q)) { sum += outLift(q); count += 1.0; }
        }
        return vec4<f32>(select(0.0, sum / count, count > 0.0), 0.0, 0.0, 0.0);
    }
    return vec4<f32>(outLift(c), outCurrent(c), 1.0);
}
