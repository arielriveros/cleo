// Depth-only pass for instanced foliage. Solid geometry — no alpha test, so nothing is discarded.

// Build-time variants: the FOLIAGE material's bend (chunks/foliageWind.wgsl: wind, interaction, weather
// droop), so a plant's shadow moves with it; and the far-card wind alone, for billboard layers.
// @variant foliage CLEO_WIND=1 CLEO_FOLIAGE=1
// @variant wind CLEO_WIND=1

#include "./chunks/instancedDepthVertex.wgsl"

@fragment
fn fs_main(in: VertexOutput) {
    // Depth-only: the depth buffer is the entire output, so there is no colour to write.
}
