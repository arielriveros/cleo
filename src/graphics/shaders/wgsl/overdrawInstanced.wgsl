// Overdraw counter for INSTANCED foliage: overdraw.wgsl's fragment stage over the instanced depth vertex
// stage, so the 'overdraw' debug view counts the fragments terrain foliage rasterizes too. Without it the
// one view that answers "is this fill-bound?" was blind to the pass that most often is.
//
// `u_lightSpace` here carries the CAMERA's view-projection: the depth chunk is "transform these instances
// by one matrix", and which matrix is the caller's. Every fragment counts, discarded cutouts included —
// they paid their shading up to the discard, which is the cost being shown.

#include "./chunks/instancedDepthVertex.wgsl"

struct OverdrawUniforms {
    u_increment: f32,
};
@group(0) @binding(0) var<uniform> u_overdraw: OverdrawUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(u_overdraw.u_increment, 0.0, 0.0, 1.0);
}
