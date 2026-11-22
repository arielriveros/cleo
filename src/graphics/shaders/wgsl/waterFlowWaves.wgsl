// LOCAL FLOW, out to the live waves (render/localFlow.ts): what the waves ride, in the layout of their field
// (waterWaveField.wgsl): the current x, z (m/s), the depth (m), and the foam: the bake's, or the whitewater the
// local flow makes where it breaks, whichever is more. A solid cell or a dry one is no water: the waves end there.
// Where no Water node's grid covers the window (the clear: a bed far above any water), the waves ride what their
// own field holds there: an endless sea's open water (render/waterWaves.ts), or nothing.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/waterFlowCommon.wgsl"
#include "./chunks/waterFlowOutput.wgsl"

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = vec2<i32>(floor(in.position.xy));
    if (outGround(c).r > 999.0) { return textureLoad(u_ref_texture, c, 0); }
    if (!outWet(c)) { return vec4<f32>(0.0); }
    let current = outCurrent(c);
    let foam = max(textureLoad(u_ref_texture, c, 0).w, outWhite(c, current));
    return vec4<f32>(current, outDepth(c), clamp(foam, 0.0, 1.0));
}
