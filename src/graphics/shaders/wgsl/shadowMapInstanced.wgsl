// Depth-only pass for instanced foliage. Solid geometry — no alpha test, so nothing is discarded.

#include "./chunks/instancedDepthVertex.wgsl"

@fragment
fn fs_main(in: VertexOutput) {
    // Depth-only: the depth buffer is the entire output, so there is no colour to write.
}
