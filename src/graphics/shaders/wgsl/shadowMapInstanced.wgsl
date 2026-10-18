// Depth-only pass for instanced foliage. Solid geometry — no alpha test, so nothing is discarded.

// Build-time variant: the foliage wind (chunks/foliageWind.wgsl) compiled in.
// @variant wind CLEO_WIND=1

#include "./chunks/instancedDepthVertex.wgsl"

@fragment
fn fs_main(in: VertexOutput) {
    // Depth-only: the depth buffer is the entire output, so there is no colour to write.
}
